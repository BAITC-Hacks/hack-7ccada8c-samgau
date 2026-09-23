"""Participant 2 adapter for the captain's unchanged app.contracts v1.0."""
from __future__ import annotations

from datetime import date
from typing import Literal
from urllib.parse import quote

from ..contracts import (CalculationParameters, DatasetPayload, EngineResult,
                         Factor as ApiFactor, Recommendation as ApiRecommendation,
                         Shipment as ApiShipment, SourceRef)
from .calculator import ALGORITHM_VERSION, calculate as calculate_product
from .models import CategoryPolicy, ProductInput, Scenario, Source, SupplierPolicy

DATA_SCHEMA_VERSION = 'qor-products-v1'
DEMO_DATASET_ID = 'demo-engine-v1'

LABELS = {
    'lead_time_days': 'Срок поставки', 'review_days': 'Период пересмотра',
    'horizon_days': 'Горизонт расчёта', 'safety_days': 'Страховой запас в днях',
    'base_daily_demand': 'Базовый дневной спрос', 'growth_multiplier': 'Множитель роста',
    'scenario_demand_pct': 'Сценарное изменение спроса', 'excluded_one_off_qty': 'Разовый объём',
    'reconstructed_lost_demand': 'Восстановленный упущенный спрос',
    'available_stock': 'Свободный остаток', 'inventory_as_of': 'Дата снимка остатка',
    'stock_units_per_order_unit': 'Складских единиц в единице заказа',
    'moq': 'Минимальный заказ', 'order_multiple': 'Кратность',
    'eligible_incoming': 'Своевременные поступления', 'forecast_qty': 'Прогноз спроса',
    'safety_stock': 'Страховой запас', 'raw_need': 'Потребность до округления',
    'recommended_qty': 'Рекомендуемый заказ', 'recommended_stock_qty': 'Заказ в складских единицах',
}


def _source_ref(origin: str) -> SourceRef:
    parts = origin.rsplit(':', 2)
    if len(parts) == 3 and parts[-1].isdigit() and int(parts[-1]) > 0:
        return SourceRef(file=parts[0], sheet=parts[1], row=int(parts[2]))
    return SourceRef(file=origin)


def _label(key: str) -> str:
    if key.startswith('seasonality_'):
        return f'Сезонность: месяц {key[-2:]}'
    if key.startswith('shipment_eta:'):
        return f'Дата поступления: {key.split(":", 1)[1]}'
    if key.startswith('eligible_shipment:'):
        return f'Учтённая партия: {key.split(":", 1)[1]}'
    return LABELS.get(key, key)


def _shipment_index(products) -> list[ApiShipment]:
    index = []
    for product in products:
        for shipment in product.incoming:
            if not shipment.confirmed:
                continue
            if shipment.unit == product.stock_unit:
                quantity = shipment.quantity
            elif (shipment.unit == product.order_unit and product.stock_units_per_order_unit is not None
                  and product.units_source is not None):
                quantity = shipment.quantity * product.stock_units_per_order_unit
            else:
                # Unknown units stay in internal data and block calculation/approval.
                # They must not masquerade as a known quantity in the shared index.
                continue
            index.append(ApiShipment(id=shipment.shipment_id, sku=product.sku,
                                     supplier_id=product.supplier_id, quantity=quantity, eta=shipment.eta))
    return sorted(index, key=lambda s: s.id)


def make_dataset(products, *, name: str, mode: Literal['real', 'synthetic'],
                 as_of: date, version: str, quality: dict | None = None) -> DatasetPayload:
    """Create a self-contained payload. Namespace shipment line IDs across SKUs."""
    products = tuple(products)
    if not products:
        raise ValueError('dataset requires at least one product')
    warehouses = {p.warehouse_id for p in products}
    if len(warehouses) != 1:
        raise ValueError('one dataset must contain exactly one warehouse')
    keys = [(p.supplier_id, p.sku) for p in products]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate product identity')
    normalized = []
    for product in sorted(products, key=lambda p: (p.supplier_id, p.sku)):
        shipments = []
        for shipment in product.incoming:
            identity = (product.supplier_id, product.sku, product.warehouse_id, shipment.shipment_id)
            global_id = 'line/' + '/'.join(quote(part, safe='') for part in identity)
            shipments.append(shipment.model_copy(update={'shipment_id': global_id}))
        normalized.append(product.model_copy(update={'incoming': tuple(shipments)}))
    return DatasetPayload(name=name, mode=mode, as_of=as_of, warehouse_id=next(iter(warehouses)),
        supplier_ids=sorted({p.supplier_id for p in normalized}), version=version,
        quality=quality or {}, shipments=_shipment_index(normalized),
        data={'schema_version': DATA_SCHEMA_VERSION, 'products': [p.model_dump(mode='json') for p in normalized]})


def demo_dataset() -> DatasetPayload:
    """Trusted synthetic bootstrap for the captain (never inferred from uploaded files)."""
    from .demo import AS_OF, DATASET_ID, make_demo_products
    return make_dataset(make_demo_products(), name='QOR — 8 синтетических товаров участника 2',
        mode='synthetic', as_of=AS_OF, version=DATASET_ID,
        quality={'mapped_skus': 8, 'source_count': 0, 'sources': [],
                 'warnings': ['Синтетический набор: данные созданы генератором, реальные файлы не загружены.'],
                 'issues': [{'id': 'synthetic', 'title': 'Демонстрационные данные',
                             'detail': 'Восемь контрольных случаев из ТЗ.', 'severity': 'info', 'count': 8}]})


def calculate(dataset: DatasetPayload, params: CalculationParameters) -> EngineResult:
    """Pure shared-contract entry point; no FastAPI, storage, environment or network calls."""
    dataset = DatasetPayload.model_validate(dataset)
    params = CalculationParameters.model_validate(params)
    if dataset.data.get('schema_version') != DATA_SCHEMA_VERSION:
        raise ValueError('unsupported dataset.data schema; use this module make_dataset or importer service')
    if params.as_of != dataset.as_of:
        raise ValueError('calculation date must match dataset snapshot')
    if params.supplier_id not in dataset.supplier_ids:
        raise ValueError('supplier is outside dataset scope')
    products = tuple(ProductInput.model_validate(p) for p in dataset.data.get('products', []))
    if not products or {p.supplier_id for p in products} != set(dataset.supplier_ids):
        raise ValueError('product suppliers do not match dataset metadata')
    if any(p.warehouse_id != dataset.warehouse_id for p in products):
        raise ValueError('product warehouse does not match dataset metadata')
    keys = [(p.supplier_id, p.sku) for p in products]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate product identity')
    internal_ids = [s.shipment_id for p in products for s in p.incoming]
    if len(internal_ids) != len(set(internal_ids)):
        raise ValueError('shipment IDs must be unique across products')
    if _shipment_index(products) != sorted(dataset.shipments, key=lambda s: s.id):
        raise ValueError('shipment metadata differs from normalized product data')
    target = params.scenario.shipment_id
    if target and not any(s.id == target and s.supplier_id == params.supplier_id for s in dataset.shipments):
        raise ValueError('scenario shipment is outside selected supplier scope')

    rows = []
    parameter_source = Source(origin='CalculationParameters', status='assumed')
    for product in sorted(products, key=lambda p: (p.supplier_id, p.sku)):
        if product.supplier_id != params.supplier_id:
            continue
        category = product.category_policy
        # Confirmed category policies may refine run parameters; demo/default assumptions may not.
        if category is None or category.source.status != 'observed':
            category = CategoryPolicy(safety_days=params.safety_days,
                                      manual_review=bool(category and category.manual_review), source=parameter_source)
        effective = product.model_copy(update={
            'policy': SupplierPolicy(lead_time_days=params.lead_time_days,
                                     review_days=params.review_days, source=parameter_source),
            'category_policy': category,
        })
        delays = {target: params.scenario.delay_days} if target and any(s.shipment_id == target for s in product.incoming) else {}
        result = calculate_product(effective, as_of=params.as_of, scenario=Scenario(
            demand_change_pct=params.scenario.demand_change_pct, shipment_delays=delays))
        warnings = list(result.warnings)
        if product.category_policy is None:
            warnings.append('unmapped_category_run_parameters_used')
        if product.moq is None or product.order_multiple is None:
            # Shared contract v1 disallows null here. Preserve unknowns in factors and enforce blockers.
            warnings.append('unknown_order_rules_blocked_transport_defaults_only')
        blocked = bool(result.approval_blockers) or result.recommended_qty is None
        conversion = 1.0 if product.stock_unit == product.order_unit else product.stock_units_per_order_unit
        if 'unit_conversion_missing' in result.approval_blockers:
            conversion = None
        factors = [ApiFactor(id=f.id, label=_label(f.id), value=f.value, unit=f.unit,
                             status=f.source.status, source=_source_ref(f.source.origin)) for f in result.factors]
        rows.append(ApiRecommendation(
            sku=product.sku, supplier_id=product.supplier_id, supplier_article=product.supplier_article or '',
            name=product.name, warehouse_id=product.warehouse_id, unit=result.unit, stock_unit=result.stock_unit,
            stock_units_per_order_unit=conversion, available_stock=result.available_stock,
            eligible_incoming=result.eligible_incoming, forecast_qty=result.forecast_qty,
            safety_stock=result.safety_stock, raw_need=result.raw_need, recommended_qty=result.recommended_qty,
            moq=product.moq if product.moq is not None else 0,
            order_step=product.order_multiple if product.order_multiple is not None else 1,
            risk_status={'expedite': 'critical', 'stockout': 'warning', 'reorder': 'warning',
                         'ok': 'ok', 'unknown': 'unknown'}[result.risk_status],
            stockout_date=result.stockout_date,
            data_status='blocked' if blocked else ('review' if warnings else 'ready'),
            approval_blockers=list(result.approval_blockers), factors=factors,
            warnings=sorted(set(warnings)), explanation=result.explanation,
            history=[{'month': h.month.isoformat(), 'actual': h.raw_sales, 'regular': h.regular_sales,
                      'restored': h.restored_demand, 'stockout_days': h.stockout_days,
                      'complete': h.complete, 'source': h.source} for h in result.history],
            trajectory=[{'date': p.date.isoformat(), 'without_order': p.stock_without_order,
                         'with_order': p.stock_with_order, 'incoming': p.incoming, 'demand': p.demand}
                        for p in result.trajectory],
        ))
    return EngineResult(algorithm_version=ALGORITHM_VERSION, recommendations=rows,
                        warnings=['synthetic_demo_data'] if dataset.mode == 'synthetic' else [])
