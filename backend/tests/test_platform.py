import csv
import io
import json
import sys
import time
import types
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient

from app import demo
from app.ai.adapter import AIAdapter
from app.config import Settings
from app.contracts import EngineResult, Scenario
from app.main import create_app
from app.orders import safe_cell
from app.storage import Conflict, Store


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path, ai_provider="disabled", engine_module="", importer_module="", admin_token="test-admin", import_access="admin")


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


def auth(client):
    response = client.post("/api/sessions")
    assert response.status_code == 201
    return {"Authorization": "Bearer " + response.json()["token"]}


def run(client, headers, **extra):
    response = client.post("/api/runs", headers=headers, json={"dataset_id": "demo-platform-v1", "supplier_id": "IEK", "as_of": "2026-09-22", **extra})
    assert response.status_code == 201, response.text
    return response.json()["run_id"]


def order(client, headers, run_id, sku="0001_"):
    response = client.post("/api/orders", headers=headers, json={"run_id": run_id, "supplier_id": "IEK", "skus": [sku]})
    assert response.status_code == 201
    return response.json()


def test_full_flow_preserves_approved_quantity(client):
    h = auth(client)
    rid = run(client, h)
    r = client.get(f"/api/runs/{rid}/products/0001_", headers=h).json()
    assert r["recommended_qty"] == 156
    assert r["stockout_date"] == "2026-10-06"
    assert r["risk_status"] == "warning"  # equal to arrival day; not earlier
    o = order(client, h, rid)
    assert client.get(f"/api/orders/{o['draft_id']}/export.csv", headers=h).status_code == 409
    edited = client.patch(f"/api/orders/{o['draft_id']}", headers=h, json={"version": 1, "changes": [{"sku": "0001_", "approved_qty": 168, "reason": "Дополнительный запас"}]})
    assert edited.status_code == 200, edited.text
    assert edited.json()["lines"][0]["recommendation"]["recommended_qty"] == 156
    approved = client.post(f"/api/orders/{o['draft_id']}/approve", headers=h, json={"version": 2, "acknowledge_warnings": True})
    assert approved.status_code == 200, approved.text
    exported = client.get(f"/api/orders/{o['draft_id']}/export.csv", headers=h)
    assert exported.content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig")), delimiter=";"))
    assert rows[0]["quantity"] == "168.0"
    assert rows[0]["sku_1c"] == "0001_"
    assert rows[0]["version"] == "3"
    assert rows[0]["reason"] == "Дополнительный запас"
    assert client.patch(f"/api/orders/{o['draft_id']}", headers=h, json={"version": 3, "changes": [{"sku": "0001_", "approved_qty": 180, "reason": "После утверждения"}]}).status_code == 409


def test_scenarios_are_immutable_replacements(client):
    h = auth(client)
    rid = run(client, h)
    result = client.post(f"/api/runs/{rid}/scenario", headers=h, json={"shipment_id": "demo-shipment-1", "delay_days": 20})
    assert result.status_code == 201
    new_id = result.json()["run_id"]
    assert client.get(f"/api/runs/{new_id}/products/0001_", headers=h).json()["recommended_qty"] == 204
    assert client.get(f"/api/runs/{rid}/products/0001_", headers=h).json()["recommended_qty"] == 156
    reset = client.post(f"/api/runs/{new_id}/scenario", headers=h, json={}).json()["run_id"]
    assert client.get(f"/api/runs/{reset}/products/0001_", headers=h).json()["recommended_qty"] == 156
    bad = client.post(f"/api/runs/{rid}/scenario", headers=h, json={"shipment_id": "unknown", "delay_days": 7})
    assert bad.status_code == 422


def test_sessions_hide_runs_orders_and_private_datasets(client):
    a, b = auth(client), auth(client)
    rid = run(client, a)
    o = order(client, a, rid)
    assert client.get(f"/api/runs/{rid}", headers=b).status_code == 404
    assert client.get(f"/api/orders/{o['draft_id']}", headers=b).status_code == 404
    assert client.get(f"/api/orders/{o['draft_id']}/export.csv", headers=b).status_code == 404
    assert client.get("/api/datasets").status_code == 401
    assert client.get("/api/orders", headers=b).json()["items"] == []


def test_invalid_quantities_versions_and_blockers(client):
    h = auth(client)
    rid = run(client, h)
    o = order(client, h, rid)
    path = f"/api/orders/{o['draft_id']}"
    for qty in [-1, 157]:
        assert client.patch(path, headers=h, json={"version": 1, "changes": [{"sku": "0001_", "approved_qty": qty, "reason": "manual change"}]}).status_code == 422
    assert client.patch(path, headers=h, json={"version": 2, "changes": [{"sku": "0001_", "approved_qty": 168, "reason": "manual change"}]}).status_code == 409
    assert client.post(path + "/approve", headers=h, json={"version": 1}).status_code == 422
    bad = order(client, h, rid, "0002_")
    assert client.post(f"/api/orders/{bad['draft_id']}/approve", headers=h, json={"version": 1, "acknowledge_warnings": True}).status_code == 422


def test_validation_errors_do_not_echo_secret_input(client):
    h = auth(client)
    response = client.post("/api/runs", headers=h, json={"unexpected": "secret marker"})
    assert response.status_code == 422
    assert "secret marker" not in response.text
    assert response.json()["error"]["code"] == "validation_error"


def test_persistence_and_interrupted_jobs(settings):
    with TestClient(create_app(settings)) as c:
        h = auth(c)
        rid = run(c, h)
        o = order(c, h, rid)
        store = c.app.state.store
        owner = store.session(h["Authorization"].split()[1])
        store.put("import", "incomplete", owner, {"status": "running"})
    with TestClient(create_app(settings)) as c:
        assert c.get(f"/api/orders/{o['draft_id']}", headers=h).status_code == 200
        assert c.get("/api/imports/incomplete", headers=h).json()["status"] == "interrupted"


def test_sqlite_compare_and_swap_is_atomic(tmp_path):
    s = Store(tmp_path)
    s.init()
    s.put("order", "x", "user", {"qty": 1})
    def update(value):
        try:
            s.put("order", "x", "user", {"qty": value}, expected=1)
            return True
        except Conflict:
            return False
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(update, [2, 3])) == [False, True]


def test_ai_disabled_fallback_does_not_break_calculation(client):
    h = auth(client)
    rid = run(client, h)
    explained = client.post(f"/api/runs/{rid}/explain", headers=h, json={"sku": "0001_"})
    assert explained.json()["status"] == "fallback"
    assert "156" in explained.json()["text"]
    parsed = client.post("/api/scenarios/parse", headers=h, json={"run_id": rid, "text": "Задержи на неделю"})
    assert parsed.json()["scenario"] is None
    assert parsed.json()["needs_clarification"] is True


@pytest.mark.parametrize("bad_response", [False, True])
def test_real_adapter_http_shape_and_validation(settings, bad_response):
    captured = []
    def handler(request):
        body = json.loads(request.content)
        captured.append(body)
        assert request.headers["Authorization"] == "Bearer dummy-key"
        assert body["text"]["format"]["type"] == "json_schema"
        obj = {"shipment_id": "malicious-id" if bad_response else "demo-shipment-1", "delay_days": 7, "demand_change_pct": 20, "needs_clarification": False, "question": None}
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(obj)}]}]})
    settings.ai_provider, settings.ai_key, settings.ai_model = "openai", "dummy-key", "test-model"
    with TestClient(create_app(settings, AIAdapter(settings, httpx.MockTransport(handler)))) as c:
        h = auth(c)
        rid = run(c, h)
        output = c.post("/api/scenarios/parse", headers=h, json={"run_id": rid, "selected_shipment_id": "demo-shipment-1", "text": "На неделю позже, спрос +20%"}).json()
        assert output["status"] == ("fallback" if bad_response else "generated")
        assert len(captured) == 1
        assert c.get(f"/api/runs/{rid}/products/0001_", headers=h).json()["recommended_qty"] == 156


def test_ai_unknown_factors_fallback_and_valid_cache(settings):
    calls = []
    def handler(request):
        calls.append(1)
        ids = ["invented"] if len(calls) == 1 else ["forecast"]
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps({"factor_ids": ids})}]}]})
    settings.ai_provider, settings.ai_key, settings.ai_model = "openai", "dummy", "test"
    with TestClient(create_app(settings, AIAdapter(settings, httpx.MockTransport(handler)))) as c:
        h = auth(c)
        rid = run(c, h)
        url = f"/api/runs/{rid}/explain"
        assert c.post(url, headers=h, json={"sku": "0001_"}).json()["status"] == "fallback"
        assert c.post(url, headers=h, json={"sku": "0001_"}).json()["status"] == "generated"
        assert c.post(url, headers=h, json={"sku": "0001_"}).json()["cached"]
        assert len(calls) == 2


def test_import_plugin_dedup_scope_and_run(settings, monkeypatch):
    module = types.ModuleType("qor_test_plugin")
    imported = []
    def importer(req):
        imported.append(req)
        assert req.files[0].path.read_bytes() == b"sku,quantity\n0001_,10"
        ds = demo.dataset()
        ds.mode = "real"
        ds.supplier_ids = [req.supplier_id]
        ds.warehouse_id = req.warehouse_id
        ds.as_of = req.as_of
        return ds
    module.import_dataset = importer
    module.calculate = demo.calculate
    monkeypatch.setitem(sys.modules, "qor_test_plugin", module)
    settings.engine_module = settings.importer_module = "qor_test_plugin"
    with TestClient(create_app(settings)) as c:
        h = auth(c)
        fields = {"supplier": "IEK", "mapping_version": "test-v1", "as_of": "2026-09-22", "warehouse_id": "almaty"}
        files = {"files": ("sample.csv", b"sku,quantity\n0001_,10", "text/csv")}
        assert c.post("/api/imports", headers=h, data=fields, files=files).status_code == 403
        admin = {**h, "X-Admin-Token": "test-admin"}
        response = c.post("/api/imports", headers=admin, data=fields, files=files)
        assert response.status_code == 202, response.text
        iid = response.json()["import_id"]
        for _ in range(100):
            result = c.get(f"/api/imports/{iid}", headers=h).json()
            if result["status"] == "completed":
                break
            time.sleep(0.01)
        assert result["status"] == "completed", result
        dsid = result["dataset_id"]
        rid = run(c, h, dataset_id=dsid)
        assert c.get(f"/api/runs/{rid}/products/0001_", headers=h).json()["recommended_qty"] == 156
        # No commercial facts leave the server, even with API enabled later.
        explained = c.post(f"/api/runs/{rid}/explain", headers=h, json={"sku": "0001_"}).json()
        assert explained["status"] == "fallback" and "реальных" in explained["message"]
        second = c.post("/api/imports", headers=admin, data=fields, files=files)
        assert second.json()["deduplicated"] and second.json()["dataset_id"] == dsid
        assert len(imported) == 1
        b = auth(c)
        assert dsid not in str(c.get("/api/datasets", headers=b).json())
        assert c.get(f"/api/datasets/{dsid}/quality", headers=b).status_code == 404
        assert c.get(f"/api/imports/{iid}", headers=b).status_code == 404


@pytest.mark.parametrize("value", ["=HYPERLINK(\"https://example.com\")", "  +CMD", "@SUM(1)", "\tformula", "-1+2"])
def test_csv_formula_injection(value):
    assert safe_cell(value).startswith("'")


def test_contract_rejects_nan_extra_fields_and_unscoped_delay():
    from pydantic import ValidationError
    for value in [{"demand_change_pct": float("nan")}, {"delay_days": 7}, {"sql": "DELETE"}]:
        with pytest.raises(ValidationError):
            Scenario.model_validate(value)
