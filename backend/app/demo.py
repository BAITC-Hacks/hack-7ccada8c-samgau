"""Platform fixture only. NOT the participant-2 demand forecasting engine."""
from datetime import date, timedelta
from math import ceil
from .contracts import CalculationParameters, DatasetPayload, EngineResult, Factor, Recommendation, Shipment


def dataset():
    return DatasetPayload(
        name="Проверка API: синтетические фиксированные прогнозы", mode="synthetic",
        as_of=date(2026, 9, 22), warehouse_id="demo-almaty", supplier_ids=["IEK", "SYSTEME"],
        version="platform-fixture-1", quality={"warnings": ["Это проверка интеграции. Прогнозы заданы заранее; очистка продаж и stockout здесь не реализованы."], "sources": ["synthetic-platform-fixture"]},
        shipments=[Shipment(id="demo-shipment-1", sku="0001_", supplier_id="IEK", quantity=50, eta=date(2026, 9, 30))],
        data={"products": [
            {"sku": "0001_", "supplier_id": "IEK", "name": "Демо: выключатель", "daily": 10, "stock": 80, "step": 12},
            {"sku": "0002_", "supplier_id": "IEK", "name": "Демо: неизвестный остаток", "daily": 5, "stock": None, "step": 1},
            {"sku": "0003_", "supplier_id": "SYSTEME", "name": "Демо: розетка", "daily": 2, "stock": 200, "step": 1},
        ]})


def calculate(ds: DatasetPayload, p: CalculationParameters) -> EngineResult:
    rows = []
    for x in ds.data["products"]:
        if x["supplier_id"] != p.supplier_id:
            continue
        daily = x["daily"] * (1 + p.scenario.demand_change_pct / 100)
        horizon = p.lead_time_days + p.review_days
        horizon_date = p.as_of + timedelta(days=horizon)
        arrivals = {}
        for s in ds.shipments:
            if s.sku != x["sku"] or s.supplier_id != p.supplier_id:
                continue
            eta = s.eta + timedelta(days=p.scenario.delay_days if s.id == p.scenario.shipment_id else 0)
            if p.as_of < eta <= horizon_date:
                arrivals[eta] = arrivals.get(eta, 0) + s.quantity
        incoming = sum(arrivals.values())
        forecast, safety = daily * horizon, daily * p.safety_days
        raw = max(0, forecast + safety - x["stock"] - incoming) if x["stock"] is not None else None
        qty = ceil(raw / x["step"]) * x["step"] if raw is not None else None
        trajectory, first = [], None
        if x["stock"] is not None:
            balance = with_order = x["stock"]
            for day in range(1, horizon + 1):
                dt = p.as_of + timedelta(days=day)
                balance += arrivals.get(dt, 0) - daily
                with_order += arrivals.get(dt, 0) - daily + (qty if day == p.lead_time_days else 0)
                if balance < 0 and first is None:
                    first = dt
                trajectory.append({"date": dt.isoformat(), "without_order": round(balance, 6), "with_order": round(with_order, 6)})
        blocked = x["stock"] is None
        text = "Неизвестен актуальный остаток: заказ заблокирован." if blocked else f"Спрос {forecast:g} + запас {safety:g} − остаток {x['stock']:g} − поставки {incoming:g} = {raw:g}. С кратностью {x['step']}: {qty:g} шт."
        rows.append(Recommendation(
            sku=x["sku"], supplier_id=p.supplier_id, supplier_article="DEMO-" + x["sku"], name=x["name"], warehouse_id=ds.warehouse_id,
            unit="шт", stock_unit="шт", stock_units_per_order_unit=1,
            available_stock=x["stock"], eligible_incoming=incoming, forecast_qty=forecast,
            safety_stock=safety, raw_need=raw, recommended_qty=qty, order_step=x["step"],
            risk_status="unknown" if blocked else ("critical" if first and first < p.as_of + timedelta(days=p.lead_time_days) else "warning" if first else "ok"),
            stockout_date=first, data_status="blocked" if blocked else "ready",
            approval_blockers=["Неизвестен остаток"] if blocked else [],
            explanation=text, trajectory=trajectory,
            factors=[Factor(id="forecast", label="Прогноз на горизонт", value=forecast, unit="шт", status="assumed"), Factor(id="incoming", label="Поставки до конца горизонта", value=incoming, unit="шт", status="assumed")],
            warnings=["Синтетический пример с заданной скоростью продаж"]
        ))
    return EngineResult(algorithm_version="platform-fixture-1", recommendations=rows, warnings=["Не является алгоритмом прогнозирования участника 2"])
