from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from app.engine import calculate, calculate_many, round_order
from app.engine.demo import AS_OF, make_demo_products
from app.engine.demand import reconstruct_demand
from app.engine.models import (CategoryPolicy, Inventory, MonthlySale, ProductInput, Sale,
                               Scenario, Seasonality, Shipment, Source, Stockout)


@pytest.fixture(scope='module')
def products():
    return {p.supplier_article: p for p in make_demo_products()}


@pytest.fixture
def stable(products):
    return products['DEMO-stable']


def replace(product, **changes):
    values = product.model_dump()
    values.update(changes)
    return ProductInput.model_validate(values)


def test_control_example_and_delayed_shipment(stable):
    base = calculate(stable, as_of=AS_OF)
    assert (base.forecast_qty, base.safety_stock, base.raw_need, base.recommended_qty) == (210, 70, 150, 156)
    delayed = calculate(stable, as_of=AS_OF, scenario=Scenario(shipment_delays={stable.incoming[0].shipment_id: 30}))
    assert delayed.eligible_incoming == 0
    assert delayed.recommended_qty == 204
    assert base.recommended_qty == 156  # scenario did not mutate baseline


def test_delay_inside_horizon_changes_risk_without_order_size(stable):
    base = calculate(stable, as_of=AS_OF)
    later = calculate(stable, as_of=AS_OF, scenario=Scenario(shipment_delays={stable.incoming[0].shipment_id: 5}))
    assert later.recommended_qty == base.recommended_qty
    assert later.stockout_date < base.stockout_date
    assert later.risk_status == 'expedite'
    assert any(p.stock_with_order < 0 for p in later.trajectory)


def test_timely_additional_shipment_reduces_order(stable):
    extra = Shipment(shipment_id='extra', quantity=50, unit='шт', eta=AS_OF + timedelta(days=2), source=Source(origin='test'))
    assert calculate(replace(stable, incoming=(*stable.incoming, extra)), as_of=AS_OF).recommended_qty == 108


def test_inventory_available_not_double_reserved(stable):
    inventory = Inventory(as_of=AS_OF, available=80, on_hand=100, reserved=20, source=Source(origin='test'))
    assert calculate(replace(stable, inventory=inventory), as_of=AS_OF).recommended_qty == 156
    inventory = Inventory(as_of=AS_OF, on_hand=100, reserved=20, source=Source(origin='test'))
    assert calculate(replace(stable, inventory=inventory), as_of=AS_OF).available_stock == 80


@pytest.mark.parametrize('inventory', [None,
    Inventory(as_of=date(2026, 9, 1), available=80, source=Source(origin='month_start')),
    Inventory(as_of=date(2026, 9, 23), available=80, source=Source(origin='future')),
    Inventory(as_of=AS_OF, on_hand=80, source=Source(origin='reserve_unknown'))])
def test_unknown_current_stock_is_not_zero(stable, inventory):
    result = calculate(replace(stable, inventory=inventory), as_of=AS_OF)
    assert result.available_stock is None
    assert result.recommended_qty is None
    assert 'current_available_stock_missing' in result.approval_blockers


def test_seasonality_changes_daily_forecast(stable):
    coefficients = (1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1)
    result = calculate(replace(stable, seasonality=Seasonality(coefficients=coefficients, source=Source(origin='test'))), as_of=AS_OF)
    assert result.forecast_qty > calculate(stable, as_of=AS_OF).forecast_qty


def test_growth_override_replaces_estimated_growth(products):
    growing = products['DEMO-growing']
    original = calculate(growing, as_of=AS_OF)
    result = calculate(replace(growing, confirmed_growth_pct=20, growth_source=Source(origin='confirmed')), as_of=AS_OF)
    assert result.forecast_qty == pytest.approx(252)
    assert result.forecast_qty == original.forecast_qty
    scenario = calculate(growing, as_of=AS_OF, scenario=Scenario(demand_change_pct=20))
    assert scenario.forecast_qty == pytest.approx(252 * 1.2)


def test_category_policy_changes_safety(stable):
    critical = replace(stable, category_policy=CategoryPolicy(safety_days=14, source=Source(origin='critical')))
    result = calculate(critical, as_of=AS_OF)
    assert result.safety_stock == 140
    assert result.recommended_qty == 228
    project = replace(stable, category_policy=CategoryPolicy(safety_days=7, manual_review=True, source=Source(origin='project')))
    assert 'category_requires_manual_confirmation' in calculate(project, as_of=AS_OF).approval_blockers


def test_stockout_control_example_and_overlapping_intervals(products):
    assert reconstruct_demand(200, 30, 10) == 300
    p = products['DEMO-stockout']
    overlapping = replace(p, stockouts=(*p.stockouts, Stockout(start=date(2026, 6, 5), end=date(2026, 6, 10), source=Source(origin='overlap'))))
    result = calculate(overlapping, as_of=AS_OF)
    june = next(h for h in result.history if h.month == date(2026, 6, 1))
    assert (june.stockout_days, june.regular_sales, june.restored_demand) == (10, 200, 300)


def test_stockout_no_reference_is_unknown():
    assert reconstruct_demand(0, 30, 30) is None
    assert reconstruct_demand(20, 30, 28, fallback_daily=10) == 300


def test_outlier_effect_below_five_percent_and_manual_override(products, stable):
    outlier = products['DEMO-one_off']
    result = calculate(outlier, as_of=AS_OF)
    base = calculate(stable, as_of=AS_OF)
    assert abs(result.forecast_qty / base.forecast_qty - 1) <= 0.05
    row = next(a for a in result.adjustments if a.raw_quantity == 1000)
    assert (row.regular_quantity, row.excluded_quantity) == (10, 990)
    manual = calculate(outlier, as_of=AS_OF, scenario=Scenario(order_classification={row.document_id: 'regular'}))
    assert next(a for a in manual.adjustments if a.document_id == row.document_id).excluded_quantity == 0


def test_document_lines_aggregated_before_outlier_detection(stable):
    day = date(2026, 8, 15)
    sales = [s for s in stable.sales if s.date != day]
    sales.extend(Sale(date=day, document_id='split-document', quantity=100, customer_id_hash='split-client') for _ in range(10))
    result = calculate(replace(stable, sales=sales), as_of=AS_OF)
    row = next(a for a in result.adjustments if a.document_id == 'split-document')
    assert (row.raw_quantity, row.regular_quantity) == (1000, 10)


def test_customer_split_across_documents(stable):
    day = date(2026, 8, 15)
    sales = [s for s in stable.sales if s.date != day]
    sales.extend(Sale(date=day, document_id=f'client-split-{i}', quantity=10,
                      customer_id_hash=stable.sales[0].customer_id_hash) for i in range(100))
    result = calculate(replace(stable, sales=sales), as_of=AS_OF)
    rows = [r for r in result.adjustments if r.date == day]
    assert sum(r.raw_quantity for r in rows) == 1000
    assert sum(r.regular_quantity for r in rows) == pytest.approx(10)
    assert all('customer_day_outlier' in r.reasons for r in rows)


def test_customer_month_concentration_without_daily_baseline(stable):
    sales = []
    for month in range(1, 9):
        for i in range(200 if month == 8 else 10):
            sales.append(Sale(date=date(2026, month, 1 + (i % 2 if month == 8 else 0)), document_id=f'{month}-{i}',
                              quantity=1, customer_id_hash='synthetic-client'))
    result = calculate(replace(stable, sales=sales), as_of=AS_OF)
    august = [a for a in result.adjustments if a.date.month == 8]
    assert sum(a.regular_quantity for a in august) == pytest.approx(10)
    assert any('customer_month_outlier' in a.reasons for a in august)


def test_repeated_high_demand_is_not_erased(stable):
    sales = [s.model_copy(update={'quantity': 100}) if date(2026, 6, 1) <= s.date < date(2026, 9, 1) else s for s in stable.sales]
    result = calculate(replace(stable, sales=sales), as_of=AS_OF)
    assert result.forecast_qty >= 2000
    assert 'repeated_large_orders_require_review' in result.warnings


@pytest.mark.parametrize('need,moq,step,factor,expected', [(0, 100, 12, 1, 0),
    (1, 25, 12, 1, 36), (150, 0, 12, 1, 156), (400, 0, 1, 305, 2), (0.3, 0, 0.1, 1, 0.3)])
def test_rounding_and_units(need, moq, step, factor, expected):
    assert round_order(need, moq, step, factor) == expected


def test_unknown_conversion_blocks_order(products):
    result = calculate(replace(products['DEMO-cable'], stock_units_per_order_unit=None), as_of=AS_OF)
    assert result.recommended_qty is None
    assert 'unit_conversion_missing' in result.approval_blockers


def test_assumed_order_unit_cannot_be_approved(stable):
    result = calculate(replace(stable, warnings=('order_unit_assumed_equal_stock_unit',)), as_of=AS_OF)
    assert 'order_unit_requires_confirmation' in result.approval_blockers


def test_negative_movement_does_not_become_sale(stable):
    sales = (*stable.sales, Sale(date=date(2026, 8, 15), document_id='return', quantity=-10000))
    result = calculate(replace(stable, sales=sales), as_of=AS_OF)
    assert result.recommended_qty == 156
    assert 'negative_movements_excluded_pending_policy' in result.warnings


def test_monthly_and_detail_not_summed(stable):
    monthly = (MonthlySale(month=date(2026, 8, 1), quantity=99999),)
    result = calculate(replace(stable, monthly_sales=monthly), as_of=AS_OF)
    august = next(h for h in result.history if h.month == date(2026, 8, 1))
    assert august.regular_sales == 310
    assert result.recommended_qty == 156
    assert 'monthly_detail_mismatch:2026-08-01' in result.warnings


def test_incomplete_current_month_and_future_sales_do_not_drive_forecast(stable):
    current = Sale(date=AS_OF, document_id='current-spike', quantity=1e8)
    future = Sale(date=AS_OF + timedelta(days=10), document_id='future', quantity=1e9)
    result = calculate(replace(stable, sales=(*stable.sales, current, future)), as_of=AS_OF)
    assert result.recommended_qty == 156
    assert not next(h for h in result.history if h.month == date(2026, 9, 1)).complete


def test_zero_months_are_kept_and_no_history_is_manual(stable, products):
    monthly = tuple(MonthlySale(month=date(2026, month, 1), quantity=0 if month < 8 else 31) for month in (6, 7, 8))
    sparse = replace(stable, sales=(), detail_months=(), monthly_sales=monthly)
    assert calculate(sparse, as_of=AS_OF).forecast_qty == 0
    missing = calculate(products['DEMO-missing'], as_of=AS_OF)
    assert missing.recommended_qty is None
    assert missing.data_status == 'insufficient'


def test_recent_level_does_not_double_growth(stable):
    monthly = tuple(MonthlySale(month=date(2026, month, 1), quantity=360 if month == 6 else 372) for month in (6, 7, 8))
    recent = replace(stable, sales=(), detail_months=(), monthly_sales=monthly,
                     confirmed_growth_pct=20, growth_source=Source(origin='test'))
    result = calculate(recent, as_of=AS_OF)
    assert result.forecast_qty == 252
    assert 'confirmed_growth_not_reapplied_to_recent_level' in result.warnings


def test_unknown_incoming_and_overdue_are_explicit(stable):
    assert calculate(replace(stable, incoming_complete=False), as_of=AS_OF).recommended_qty is None
    overdue = stable.incoming[0].model_copy(update={'eta': AS_OF})
    result = calculate(replace(stable, incoming=(overdue,)), as_of=AS_OF)
    assert 'overdue_shipment_requires_reconciliation' in result.approval_blockers


def test_factors_match_result_and_are_deterministic(stable):
    result = calculate(stable, as_of=AS_OF)
    factors = {f.id: f for f in result.factors}
    for name in ('forecast_qty', 'safety_stock', 'available_stock', 'eligible_incoming', 'raw_need', 'recommended_qty'):
        assert factors[name].value == getattr(result, name)
    assert '156' in result.explanation
    assert result.model_dump_json() == calculate(stable, as_of=AS_OF).model_dump_json()


def test_scenario_scope_and_input_validation(stable):
    with pytest.raises(ValueError, match='unknown shipments'):
        calculate(stable, as_of=AS_OF, scenario=Scenario(shipment_delays={'does-not-exist': 7}))
    with pytest.raises(ValidationError):
        Scenario(demand_change_pct=-101)
    with pytest.raises(ValidationError):
        replace(stable, sku=123)
    with pytest.raises(ValueError, match='duplicate product'):
        calculate_many((stable, stable), as_of=AS_OF)


def test_eight_deterministic_demo_cases(products):
    assert len(products) == 8
    assert all(p.sku.startswith('0') for p in products.values())
    assert all(s.customer_id_hash for p in products.values() for s in p.sales)
    assert len(calculate_many(tuple(products.values()), as_of=AS_OF)) == 8
