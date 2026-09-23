import asyncio
import hashlib
import json
import logging
import secrets
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from . import demo, integration
from .ai.adapter import AIAdapter, AIUnavailable
from .api.models import ApproveOrder, CreateOrder, ExplainRequest, ParseRequest, PatchOrder, RunRequest
from .api.models import DatasetList, ExplainResponse, HealthResponse, OrderList, OrderResponse, ParseResponse, RecommendationPage, RunResponse, ScenarioResponse, SessionResponse
from .config import Settings
from .contracts import CalculationParameters, DatasetPayload, EngineResult, ImportFile, ImportRequest, Recommendation, Scenario
from .orders import export_csv, validate_line
from .storage import Conflict, Store

VERSION = "0.1.0"
log = logging.getLogger("qor")
bearer = HTTPBearer(auto_error=False)


def fail(status, code, message, fields=None):
    raise HTTPException(status_code=status, detail={"code": code, "message": message, "fields": fields or []})


def now():
    return datetime.now(timezone.utc).isoformat()


def create_app(settings=None, ai=None):
    settings = settings or Settings()
    settings.validate()
    store = Store(settings.data_dir, settings.database_path)
    ai = ai or AIAdapter(settings)
    upload_lock = threading.Lock()
    tasks = set()
    rate_buckets = defaultdict(deque)
    ai_cache = {}

    @asynccontextmanager
    async def lifespan(app):
        store.init()
        store.interrupt_imports()
        if not store.get("dataset", "demo-platform-v1", "public"):
            store.put("dataset", "demo-platform-v1", "public", {"backend": "fixture", "dataset": demo.dataset().model_dump(mode="json")})
        yield
        if tasks:
            await asyncio.gather(*list(tasks), return_exceptions=True)

    app = FastAPI(title="QOR AI — Captain API", version=VERSION, lifespan=lifespan, docs_url="/api/docs", redoc_url="/api/redoc", openapi_url="/api/openapi.json")
    app.state.store = store
    app.state.settings = settings
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False, allow_methods=["GET", "POST", "PATCH"], allow_headers=["Authorization", "Content-Type", "X-Admin-Token"], expose_headers=["Content-Disposition", "X-Request-ID"])

    @app.middleware("http")
    async def headers(request, call_next):
        rid = uuid4().hex
        length = request.headers.get("content-length")
        try:
            over_limit = length is not None and int(length) > settings.max_upload_bytes + 1024 * 1024
        except ValueError:
            over_limit = True
        if over_limit:
            return JSONResponse(status_code=413, content={"error": {"code": "body_too_large", "message": "Запрос слишком большой", "fields": []}})
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail), "fields": []}
        return JSONResponse(status_code=exc.status_code, content={"error": detail})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "Проверьте поля запроса", "fields": [{"path": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in exc.errors()]}})

    @app.exception_handler(Conflict)
    async def conflict_error(request, exc):
        return JSONResponse(status_code=409, content={"error": {"code": "version_conflict", "message": "Черновик изменён. Обновите его и повторите действие.", "fields": []}})

    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        # Avoid raw exception strings: importer/AI errors can include confidential data.
        log.error("Request failed: %s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"error": {"code": "internal_error", "message": "Внутренняя ошибка. Проверьте сервер и контракт модуля.", "fields": []}})

    def session(auth: HTTPAuthorizationCredentials | None = Depends(bearer)):
        owner = store.session(auth.credentials) if auth else None
        if not owner:
            fail(401, "session_required", "Создайте сессию через POST /api/sessions")
        return owner

    def admin(x_admin_token: str | None = Header(default=None)):
        if not settings.admin_token or not x_admin_token or not secrets.compare_digest(settings.admin_token, x_admin_token):
            fail(403, "admin_required", "Импорт доступен администратору")

    def limited(key, maximum):
        current = time.monotonic()
        # Bound memory even when new IPs/sessions appear continuously.
        if len(rate_buckets) > 10000:
            stale = [k for k, values in rate_buckets.items() if not values or values[-1] < current - 60]
            for k in stale:
                del rate_buckets[k]
            if len(rate_buckets) > 10000:
                fail(429, "busy", "Повторите запрос позже")
        bucket = rate_buckets[key]
        while bucket and bucket[0] <= current - 60:
            bucket.popleft()
        if len(bucket) >= maximum:
            fail(429, "rate_limit", "Слишком много запросов. Повторите через минуту.")
        bucket.append(current)

    def get(kind, key, owner):
        obj = store.get(kind, key, owner)
        if not obj:
            fail(404, "not_found", "Объект не найден")
        return obj

    def dataset_for(key, owner):
        obj = get("dataset", key, owner)
        return obj, DatasetPayload.model_validate(obj["payload"]["dataset"])

    def check_scenario(ds, params):
        target = params.scenario.shipment_id
        if target and not any(s.id == target and s.supplier_id == params.supplier_id for s in ds.shipments):
            fail(422, "unknown_shipment", "Партия не принадлежит выбранному поставщику")

    def make_run(dataset_id, params, owner, parent=None):
        obj, ds = dataset_for(dataset_id, owner)
        if params.supplier_id not in ds.supplier_ids:
            fail(422, "unknown_supplier", "Поставщик отсутствует в наборе")
        if params.as_of != ds.as_of:
            fail(422, "snapshot_date_mismatch", "Дата расчёта должна совпадать с датой набора")
        check_scenario(ds, params)
        try:
            result = integration.calculate(settings, ds, params, obj["payload"]["backend"])
        except integration.EngineUnavailable:
            fail(503, "engine_unavailable", "Подключите ENGINE_MODULE второго разработчика")
        except Exception as exc:
            log.error("Engine failed: %s", type(exc).__name__)
            fail(502, "engine_failed", "Расчётный модуль вернул ошибку или нарушил контракт")
        run_id = uuid4().hex
        summary = {
            "products": len(result.recommendations),
            "to_order": sum((r.recommended_qty or 0) > 0 for r in result.recommendations),
            "critical": sum(r.risk_status == "critical" for r in result.recommendations),
            "needs_review": sum(r.data_status != "ready" for r in result.recommendations),
        }
        payload = {"dataset_id": dataset_id, "dataset_version": ds.version, "data_mode": ds.mode, "parameters": params.model_dump(mode="json"), "parent_run_id": parent, "created_at": now(), "summary": summary, "result": result.model_dump(mode="json")}
        store.put("run", run_id, owner, payload)
        return {"run_id": run_id, "summary": summary, "data_mode": ds.mode, "algorithm_version": result.algorithm_version, "warnings": result.warnings}

    def product(run, sku):
        rows = [r for r in run["result"]["recommendations"] if r["sku"] == sku]
        if not rows:
            fail(404, "product_not_found", "Товар отсутствует в расчёте")
        return rows[0]

    def order_response(obj):
        return {"draft_id": obj["id"], "version": obj["version"], **obj["payload"]}

    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/api/docs")

    @app.get("/api/health", tags=["system"], response_model=HealthResponse)
    def health():
        return {"status": "ok", "version": VERSION, "contract_version": "1.0", "engine_configured": bool(settings.engine_module), "importer_configured": bool(settings.importer_module), "ai_configured": bool(settings.ai_provider != "disabled" and settings.ai_key and settings.ai_model)}

    @app.post("/api/sessions", status_code=201, tags=["session"], response_model=SessionResponse)
    async def new_session(request: Request):
        limited(("sessions", request.client.host if request.client else "unknown"), 30)
        token, owner, expires = store.create_session(settings.session_hours)
        return {"token": token, "token_type": "bearer", "session_id": owner, "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat()}

    @app.get("/api/datasets", tags=["data"], response_model=DatasetList)
    def datasets(owner=Depends(session)):
        return {"items": [{"id": o["id"], **{k: o["payload"]["dataset"][k] for k in ("name", "mode", "as_of", "warehouse_id", "supplier_ids", "version")}, "engine_backend": o["payload"]["backend"]} for o in store.list("dataset", owner)]}

    @app.get("/api/datasets/{dataset_id}/quality", tags=["data"])
    def quality(dataset_id: str, owner=Depends(session)):
        _, ds = dataset_for(dataset_id, owner)
        return ds.quality

    @app.get("/api/datasets/{dataset_id}/shipments", tags=["data"])
    def shipments(dataset_id: str, owner=Depends(session)):
        _, ds = dataset_for(dataset_id, owner)
        return {"items": ds.shipments}

    async def do_import(import_id, owner, req):
        obj = get("import", import_id, owner)
        p = obj["payload"]
        p["status"] = "running"
        v = store.put("import", import_id, owner, p, obj["version"])
        try:
            ds = await run_in_threadpool(integration.import_dataset, settings, req)
            dataset_id = uuid4().hex
            store.put("dataset", dataset_id, owner, {"backend": "plugin", "dataset": ds.model_dump(mode="json")})
            p.update(status="completed", dataset_id=dataset_id, progress=100)
        except Exception as exc:
            log.error("Import failed: %s", type(exc).__name__)
            p.update(status="failed", error="Импорт не завершён. Проверьте формат, настройки и контракт импортера.")
        finally:
            try:
                store.put("import", import_id, owner, p, v)
            finally:
                upload_lock.release()

    @app.post("/api/imports", status_code=202, tags=["data"], dependencies=[Depends(admin)])
    async def start_import(files: list[UploadFile] = File(...), supplier: str = Form(...), mapping_version: str = Form(...), as_of: date = Form(...), warehouse_id: str = Form(...), owner=Depends(session)):
        if not settings.importer_module or not settings.engine_module:
            fail(503, "integration_missing", "Задайте IMPORTER_MODULE и ENGINE_MODULE")
        if not 1 <= len(files) <= 12:
            fail(422, "file_count", "Разрешено от 1 до 12 файлов")
        if not upload_lock.acquire(blocking=False):
            fail(409, "import_busy", "Другой импорт ещё выполняется")
        stored, size, retained = [], 0, False
        import_id = uuid4().hex
        directory = settings.data_dir / "uploads" / import_id
        directory.mkdir(parents=True, exist_ok=True)
        try:
            seen = set()
            for file in files:
                name = (file.filename or "").replace("\\", "/").split("/")[-1]
                if Path(name).suffix.lower() not in (".xlsx", ".csv"):
                    fail(422, "file_type", "Загрузите распакованные XLSX или CSV")
                path = directory / (uuid4().hex + Path(name).suffix.lower())
                h = hashlib.sha256()
                with path.open("wb") as target:
                    while chunk := await file.read(1024 * 1024):
                        size += len(chunk)
                        if size > settings.max_upload_bytes:
                            fail(413, "upload_too_large", "Общий размер превышает 64 MiB")
                        h.update(chunk)
                        target.write(chunk)
                digest = h.hexdigest()
                if digest in seen:
                    fail(422, "duplicate_file", "Один файл передан несколько раз")
                seen.add(digest)
                stored.append(ImportFile(path=path, original_name=name, sha256=digest))
            req = ImportRequest(files=stored, supplier_id=supplier, mapping_version=mapping_version, as_of=as_of, warehouse_id=warehouse_id)
            fingerprint = hashlib.sha256(json.dumps({"files": sorted((f.original_name, f.sha256) for f in stored), "supplier": supplier, "mapping": mapping_version, "as_of": as_of.isoformat(), "warehouse": warehouse_id}, sort_keys=True).encode()).hexdigest()
            previous = next((o for o in store.list("import", owner) if o["payload"].get("fingerprint") == fingerprint and o["payload"]["status"] == "completed"), None)
            if previous:
                return {"import_id": previous["id"], **previous["payload"], "deduplicated": True}
            p = {"status": "queued", "progress": 0, "fingerprint": fingerprint, "created_at": now(), "dataset_id": None, "error": None, "files": [{"name": f.original_name, "sha256": f.sha256} for f in stored]}
            store.put("import", import_id, owner, p)
            task = asyncio.create_task(do_import(import_id, owner, req))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
            retained = True
            return {"import_id": import_id, **p}
        finally:
            for file in files:
                await file.close()
            if not retained:
                import shutil
                shutil.rmtree(directory, ignore_errors=True)
                upload_lock.release()

    @app.get("/api/imports/{import_id}", tags=["data"])
    def import_status(import_id: str, owner=Depends(session)):
        return {"import_id": import_id, **get("import", import_id, owner)["payload"]}

    @app.post("/api/runs", status_code=201, tags=["calculation"], response_model=RunResponse)
    def runs(body: RunRequest, owner=Depends(session)):
        return make_run(body.dataset_id, CalculationParameters.model_validate(body.model_dump(exclude={"dataset_id"})), owner)

    @app.get("/api/runs/{run_id}", tags=["calculation"])
    def run_detail(run_id: str, owner=Depends(session)):
        p = get("run", run_id, owner)["payload"]
        return {"run_id": run_id, **{k: v for k, v in p.items() if k != "result"}, "algorithm_version": p["result"]["algorithm_version"], "warnings": p["result"]["warnings"]}

    @app.get("/api/runs/{run_id}/recommendations", tags=["calculation"], response_model=RecommendationPage)
    def recommendations(run_id: str, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100), q: str = "", needs_review: bool = False, owner=Depends(session)):
        p = get("run", run_id, owner)["payload"]
        rows = p["result"]["recommendations"]
        rows = [r for r in rows if (not q or q.casefold() in (r["sku"] + " " + r["name"]).casefold()) and (not needs_review or r["data_status"] != "ready")]
        rank = {"critical": 0, "unknown": 1, "warning": 2, "ok": 3}
        rows.sort(key=lambda r: (rank[r["risk_status"]], r["sku"]))
        return {"items": [{k: v for k, v in r.items() if k not in ("history", "trajectory")} for r in rows[(page - 1) * page_size:page * page_size]], "total": len(rows), "page": page, "page_size": page_size, "summary": p["summary"]}

    @app.get("/api/runs/{run_id}/products/{sku}", tags=["calculation"], response_model=Recommendation)
    def product_detail(run_id: str, sku: str, owner=Depends(session)):
        return product(get("run", run_id, owner)["payload"], sku)

    @app.post("/api/runs/{run_id}/scenario", status_code=201, tags=["calculation"], response_model=ScenarioResponse)
    def scenario(run_id: str, body: Scenario, owner=Depends(session)):
        p = get("run", run_id, owner)["payload"]
        params = CalculationParameters.model_validate(p["parameters"])
        params.scenario = body
        output = make_run(p["dataset_id"], params, owner, parent=run_id)
        new = get("run", output["run_id"], owner)["payload"]
        before = {r["sku"]: r for r in p["result"]["recommendations"]}
        output["comparison"] = [{"sku": r["sku"], "before_qty": before.get(r["sku"], {}).get("recommended_qty"), "after_qty": r["recommended_qty"], "before_stockout_date": before.get(r["sku"], {}).get("stockout_date"), "after_stockout_date": r["stockout_date"]} for r in new["result"]["recommendations"]]
        return output

    @app.post("/api/scenarios/parse", tags=["AI"], response_model=ParseResponse)
    async def parse_scenario(body: ParseRequest, owner=Depends(session)):
        limited(("ai", owner), 10)
        p = get("run", body.run_id, owner)["payload"]
        _, ds = dataset_for(p["dataset_id"], owner)
        ids = [s.id for s in ds.shipments if s.supplier_id == p["parameters"]["supplier_id"]]
        if body.selected_shipment_id and body.selected_shipment_id not in ids:
            fail(422, "unknown_shipment", "Неизвестная партия")
        fallback = {"status": "fallback", "provider": None, "scenario": None, "needs_clarification": True, "question": "ИИ недоступен. Задайте задержку и изменение спроса через поля сценария."}
        if ds.mode == "real" and not settings.allow_real_ai:
            return {**fallback, "question": "Внешний ИИ для реальных данных отключён. Используйте поля сценария."}
        try:
            parsed = await asyncio.wait_for(ai.parse_scenario(body.text, ids, body.selected_shipment_id), timeout=15)
            if parsed.needs_clarification:
                return {"status": "generated", "provider": settings.ai_provider, "scenario": None, "needs_clarification": True, "question": parsed.question or "Уточните действие и партию."}
            changes = Scenario.model_validate(parsed.model_dump(exclude={"needs_clarification", "question"}))
            if changes.shipment_id and changes.shipment_id not in ids:
                raise ValueError("Unknown shipment")
            if body.selected_shipment_id and changes.shipment_id and changes.shipment_id != body.selected_shipment_id:
                raise ValueError("AI changed selected shipment")
            return {"status": "generated", "provider": settings.ai_provider, "scenario": changes, "needs_clarification": False, "question": None, "requires_confirmation": True}
        except (AIUnavailable, ValueError, asyncio.TimeoutError):
            return fallback

    @app.post("/api/runs/{run_id}/explain", tags=["AI"], response_model=ExplainResponse)
    async def explain(run_id: str, body: ExplainRequest, owner=Depends(session)):
        p = get("run", run_id, owner)["payload"]
        r = product(p, body.sku)
        _, ds = dataset_for(p["dataset_id"], owner)
        base = {"text": r["explanation"], "factor_ids": [f["id"] for f in r["factors"]], "provider": None, "status": "fallback", "language": "ru", "message": "ИИ недоступен, показано расчётное объяснение"}
        if ds.mode == "real" and not settings.allow_real_ai:
            return {**base, "message": "Внешний ИИ для реальных данных отключён"}
        key = (owner, run_id, body.sku, body.language)
        if key in ai_cache:
            return {**ai_cache[key], "cached": True}
        limited(("ai", owner), 10)
        try:
            # Do not transmit file names, source rows, product names or raw sales.
            facts = [{k: f[k] for k in ("id", "label", "value", "unit", "status")} for f in r["factors"]]
            selected = await asyncio.wait_for(ai.explain_decision(facts, body.language), timeout=15)
            known = {f["id"]: f for f in r["factors"]}
            if len(set(selected.factor_ids)) != len(selected.factor_ids) or any(i not in known for i in selected.factor_ids):
                raise ValueError("Unknown or duplicate factor")
            details = "; ".join(f"{known[i]['label']}: {known[i]['value']} {known[i]['unit'] or ''}".strip() for i in selected.factor_ids)
            output = {"text": r["explanation"] + " Основные факторы: " + details, "factor_ids": selected.factor_ids, "provider": settings.ai_provider, "status": "generated", "language": "ru", "requested_language": body.language, "rendering": "verified_template", "message": "ИИ выбрал факторы; текст и числа сформированы сервером на русском"}
            if len(ai_cache) >= 500:
                ai_cache.pop(next(iter(ai_cache)))
            ai_cache[key] = output
            return output
        except (AIUnavailable, ValueError, asyncio.TimeoutError):
            return base

    @app.post("/api/orders", status_code=201, tags=["orders"], response_model=OrderResponse)
    def create_order(body: CreateOrder, owner=Depends(session)):
        p = get("run", body.run_id, owner)["payload"]
        if body.supplier_id != p["parameters"]["supplier_id"] or len(set(body.skus)) != len(body.skus):
            fail(422, "invalid_selection", "Проверьте поставщика и повторы товаров")
        lines = [{"recommendation": product(p, sku), "approved_qty": product(p, sku)["recommended_qty"], "reason": "", "edited_by": None} for sku in body.skus]
        payload = {"run_id": body.run_id, "supplier_id": body.supplier_id, "status": "draft", "as_of": p["parameters"]["as_of"], "created_at": now(), "approved_at": None, "lines": lines, "audit": []}
        key = uuid4().hex
        store.put("order", key, owner, payload)
        return order_response(get("order", key, owner))

    @app.get("/api/orders", tags=["orders"], response_model=OrderList)
    def orders(owner=Depends(session)):
        return {"items": [order_response(o) for o in store.list("order", owner)]}

    @app.get("/api/orders/{draft_id}", tags=["orders"], response_model=OrderResponse)
    def get_order(draft_id: str, owner=Depends(session)):
        return order_response(get("order", draft_id, owner))

    @app.patch("/api/orders/{draft_id}", tags=["orders"], response_model=OrderResponse)
    def edit_order(draft_id: str, body: PatchOrder, owner=Depends(session)):
        obj = get("order", draft_id, owner)
        if obj["version"] != body.version:
            raise Conflict()
        p = obj["payload"]
        if p["status"] != "draft":
            fail(409, "already_approved", "Создайте новый черновик для изменения утверждённого заказа")
        if len({x.sku for x in body.changes}) != len(body.changes):
            fail(422, "duplicate_change", "Товар указан дважды")
        for change in body.changes:
            line = next((x for x in p["lines"] if x["recommendation"]["sku"] == change.sku), None)
            if line is None or not change.reason.strip():
                fail(422, "invalid_change", "Неизвестный товар или пустая причина")
            old = line["approved_qty"]
            line.update(approved_qty=change.approved_qty, reason=change.reason.strip(), edited_by=owner)
            issue = validate_line(line)
            if issue:
                fail(422, "invalid_quantity", issue, [change.sku])
            p["audit"].append({"at": now(), "by": owner, "sku": change.sku, "old_qty": old, "new_qty": change.approved_qty, "reason": change.reason.strip()})
        v = store.put("order", draft_id, owner, p, body.version)
        return {"draft_id": draft_id, "version": v, **p}

    @app.post("/api/orders/{draft_id}/approve", tags=["orders"], response_model=OrderResponse)
    def approve_order(draft_id: str, body: ApproveOrder, owner=Depends(session)):
        obj = get("order", draft_id, owner)
        if obj["version"] != body.version:
            raise Conflict()
        p = obj["payload"]
        if p["status"] != "draft":
            fail(409, "already_approved", "Заказ уже утверждён")
        issues = [{"sku": l["recommendation"]["sku"], "message": issue} for l in p["lines"] if (issue := validate_line(l))]
        if issues:
            fail(422, "approval_blocked", "Исправьте данные и выполните новый расчёт", issues)
        if not body.acknowledge_warnings and any(l["recommendation"]["warnings"] or l["recommendation"]["data_status"] == "review" for l in p["lines"]):
            fail(422, "warnings_not_acknowledged", "Подтвердите просмотр предупреждений")
        p.update(status="approved", approved_at=now(), approved_by=owner)
        p["audit"].append({"at": now(), "by": owner, "action": "approve", "warnings_acknowledged": body.acknowledge_warnings})
        v = store.put("order", draft_id, owner, p, body.version)
        return {"draft_id": draft_id, "version": v, **p}

    @app.get("/api/orders/{draft_id}/export.csv", tags=["orders"])
    def export(draft_id: str, owner=Depends(session)):
        obj = get("order", draft_id, owner)
        if obj["payload"]["status"] != "approved":
            fail(409, "approval_required", "Сначала утвердите заказ")
        return Response(export_csv(obj["payload"], obj["version"]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="qor-order-{draft_id}-v{obj["version"]}.csv"'})

    return app


app = create_app()
