"""Pure, deterministic replenishment calculation; quantities are never assigned by an LLM."""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal, ROUND_CEILING

from .demand import build_history, clean_orders, forecast_level
from .models import (CategoryPolicy, Factor, ProductInput, Recommendation, Scenario,
                     Source, TrajectoryPoint)

ALGORITHM_VERSION = 'qor-mvp-1.0'


def round_order(raw_need: float, moq: float, multiple: float,
                stock_units_per_order_unit: float = 1) -> float:
    if raw_need < 0 or moq < 0 or multiple <= 0 or stock_units_per_order_unit <= 0:
        raise ValueError('invalid order rules')
    if raw_need == 0:
        return 0.0
    # Decimal prevents binary float errors at exact pack boundaries.
    need = Decimal(str(raw_need)) / Decimal(str(stock_units_per_order_unit))
    step = Decimal(str(multiple))
    return float((max(need, Decimal(str(moq))) / step).to_integral_value(rounding=ROUND_CEILING) * step)


def calculate(product: ProductInput, *, as_of: date, scenario: Scenario | None = None) -> Recommendation:
    scenario = scenario or Scenario()
    unknown = set(scenario.shipment_delays) - {s.shipment_id for s in product.incoming}
    if unknown:
        raise ValueError(f'unknown shipments in scenario: {sorted(unknown)}')
    warnings = list(product.warnings)
    blockers = []
    if 'order_unit_assumed_equal_stock_unit' in warnings:
        blockers.append('order_unit_requires_confirmation')
    factors = []

    def factor(key, value, unit, status='estimated', origin='engine'):
        factors.append(Factor(id=key, value=value, unit=unit, source=Source(origin=origin, status=status)))

    def sourced(key, value, unit, source):
        factor(key, value, unit, source.status if source else 'missing', source.origin if source else 'missing')

    category = product.category_policy
    if category is None:
        category = CategoryPolicy(safety_days=7, source=Source(origin='demo_default_category', status='assumed'))
        warnings.append('unmapped_category_default_policy')
    if category.manual_review:
        blockers.append('category_requires_manual_confirmation')
    if product.policy.source.status == 'assumed' or category.source.status == 'assumed':
        warnings.append('assumed_replenishment_policy')
    review = category.review_days if category.review_days is not None else product.policy.review_days
    horizon = product.policy.lead_time_days + review
    sourced('lead_time_days', product.policy.lead_time_days, 'day', product.policy.source)
    sourced('review_days', review, 'day', category.source if category.review_days is not None else product.policy.source)
    factor('horizon_days', horizon, 'day')
    sourced('safety_days', category.safety_days, 'day', category.source)

    if product.seasonality:
        average = sum(product.seasonality.coefficients) / 12
        coefficients = tuple(v / average for v in product.seasonality.coefficients)
        season_source = product.seasonality.source
        warnings.append('supplier_seasonality_is_sku_approximation')
    else:
        coefficients = (1.0,) * 12
        season_source = Source(origin='flat_seasonality_fallback', status='assumed')
        warnings.append('seasonality_missing_assumed_flat')
    for month, value in enumerate(coefficients, 1):
        sourced(f'seasonality_{month:02}', value, 'multiplier', season_source)
    adjustments, issues = clean_orders(product, as_of, scenario)
    warnings.extend(issues)
    history, issues = build_history(product, as_of, adjustments, coefficients)
    warnings.extend(issues)
    base, growth, growth_source, issues = forecast_level(product, as_of, history, coefficients)
    warnings.extend(issues)
    factor('base_daily_demand', base, f'{product.stock_unit}/day', 'estimated' if base is not None else 'missing')
    if isinstance(growth_source, tuple):
        growth_source = Source(status=growth_source[0], origin=growth_source[1])
    sourced('growth_multiplier', growth, 'multiplier', growth_source)
    factor('scenario_demand_pct', scenario.demand_change_pct, 'percent', 'assumed', 'user_scenario')
    factor('excluded_one_off_qty', sum(a.excluded_quantity for a in adjustments), product.stock_unit)
    factor('reconstructed_lost_demand', sum(h.restored_demand - h.regular_sales for h in history
           if h.restored_demand is not None and h.regular_sales is not None), product.stock_unit)
    if base is None:
        blockers.append('insufficient_demand_history')

    stock = None
    inventory = product.inventory
    if inventory:
        if inventory.as_of > as_of:
            warnings.append('future_inventory_ignored')
        elif inventory.as_of != as_of and not inventory.manually_confirmed:
            warnings.append('stale_inventory_requires_confirmation')
        else:
            stock = inventory.available
            if stock is None and inventory.on_hand is not None and inventory.reserved is not None:
                stock = inventory.on_hand - inventory.reserved
            if inventory.manually_confirmed:
                warnings.append('inventory_manually_confirmed')
            if (inventory.available is not None and inventory.on_hand is not None
                    and inventory.reserved is not None
                    and abs(inventory.available - (inventory.on_hand - inventory.reserved)) > 1e-6):
                warnings.append('inventory_available_conflicts_with_on_hand_minus_reserved')
                blockers.append('inventory_conflict_requires_confirmation')
    if stock is None:
        blockers.append('current_available_stock_missing')
    source = inventory.source if stock is not None else None
    sourced('available_stock', stock, product.stock_unit, source)
    factor('inventory_as_of', inventory.as_of.isoformat() if inventory else None, 'date',
           'observed' if inventory else 'missing', inventory.source.origin if inventory else 'missing')

    conversion = 1.0 if product.stock_unit == product.order_unit else product.stock_units_per_order_unit
    if conversion is None or (product.stock_unit != product.order_unit and product.units_source is None):
        conversion = None
        blockers.append('unit_conversion_missing')
    sourced('stock_units_per_order_unit', conversion, f'{product.stock_unit}/{product.order_unit}',
            product.units_source or (Source(origin='identical_units') if conversion == 1 else None))
    if product.moq is None or product.order_multiple is None or product.order_rules_source is None:
        blockers.append('order_rules_missing')
    sourced('moq', product.moq, product.order_unit, product.order_rules_source)
    sourced('order_multiple', product.order_multiple, product.order_unit, product.order_rules_source)

    arrivals = {}
    incoming_known = product.incoming_complete
    if not incoming_known:
        blockers.append('incoming_coverage_not_confirmed')
    end = as_of + timedelta(days=horizon)
    for shipment in product.incoming:
        eta = shipment.eta + timedelta(days=scenario.shipment_delays.get(shipment.shipment_id, 0))
        sourced(f'shipment_eta:{shipment.shipment_id}', eta.isoformat(), 'date', shipment.source)
        if not shipment.confirmed:
            warnings.append(f'unconfirmed_shipment_excluded:{shipment.shipment_id}')
            continue
        if eta <= as_of:
            warnings.append(f'overdue_shipment_requires_reconciliation:{shipment.shipment_id}')
            blockers.append('overdue_shipment_requires_reconciliation')
            continue
        if eta > end:
            warnings.append(f'shipment_after_horizon:{shipment.shipment_id}')
            continue
        if shipment.unit == product.stock_unit:
            quantity = shipment.quantity
        elif shipment.unit == product.order_unit and conversion is not None:
            quantity = shipment.quantity * conversion
        else:
            incoming_known = False
            blockers.append('incoming_unit_conversion_missing')
            continue
        arrivals[eta] = arrivals.get(eta, 0) + quantity
        sourced(f'eligible_shipment:{shipment.shipment_id}', quantity, product.stock_unit, shipment.source)
    eligible = sum(arrivals.values()) if incoming_known else None
    factor('eligible_incoming', eligible, product.stock_unit,
           'estimated' if eligible is not None else 'missing', 'confirmed_dated_shipments')

    daily = []
    forecast = safety = raw_need = recommended = recommended_stock = None
    if base is not None:
        for offset in range(1, horizon + category.safety_days + 1):
            day = as_of + timedelta(days=offset)
            daily.append(base * coefficients[day.month - 1] * growth * (1 + scenario.demand_change_pct / 100))
        forecast = sum(daily[:horizon])
        # Safety buffer uses demand on the days immediately after the coverage horizon.
        safety = sum(daily[horizon:])
        if stock is not None and eligible is not None:
            raw_need = max(0.0, forecast + safety - stock - eligible)
            if conversion is not None and product.moq is not None and product.order_multiple is not None:
                recommended = round_order(raw_need, product.moq, product.order_multiple, conversion)
                recommended_stock = recommended * conversion
    for name, value in (('forecast_qty', forecast), ('safety_stock', safety), ('raw_need', raw_need),
                        ('recommended_stock_qty', recommended_stock)):
        factor(name, value, product.stock_unit, 'estimated' if value is not None else 'missing')
    factor('recommended_qty', recommended, product.order_unit, 'estimated' if recommended is not None else 'missing')

    trajectory = []
    stockout_date = as_of if stock is not None and stock < 0 else None
    if stock is not None and base is not None and incoming_known:
        without = with_order = stock
        for offset, demand in enumerate(daily[:horizon], 1):
            day = as_of + timedelta(days=offset)
            incoming = arrivals.get(day, 0)
            without += incoming - demand
            with_order += incoming - demand
            if offset == product.policy.lead_time_days and recommended_stock is not None:
                with_order += recommended_stock
            if without < -1e-9 and stockout_date is None:
                stockout_date = day
            trajectory.append(TrajectoryPoint(date=day, demand=demand, incoming=incoming,
                              stock_without_order=without,
                              stock_with_order=with_order if recommended_stock is not None else None))
    risk = 'unknown'
    if stock is not None and base is not None and incoming_known:
        risk = 'reorder' if recommended and recommended > 0 else 'ok'
        if stockout_date:
            risk = 'stockout'
            if stockout_date < as_of + timedelta(days=product.policy.lead_time_days):
                risk = 'expedite'
                warnings.append('ordinary_delivery_too_late_requires_expedite')
    blockers = sorted(set(blockers))
    warnings = sorted(set(warnings))
    status = 'insufficient' if recommended is None else ('preliminary' if warnings or blockers else 'complete')
    if recommended is not None:
        explanation = (f'Прогноз {forecast:g} {product.stock_unit}, страховой запас {safety:g}, '
                       f'свободно {stock:g}, своевременные поступления {eligible:g}. '
                       f'Потребность {raw_need:g} {product.stock_unit}; после перевода единиц, '
                       f'MOQ и кратности — {recommended:g} {product.order_unit}.')
    else:
        explanation = 'Расчёт требует данных: ' + ', '.join(blockers) + '.'
    if risk == 'expedite':
        explanation += ' Обычная поставка не успеет до дефицита; требуется ускорение или решение менеджера.'
    return Recommendation(algorithm_version=ALGORITHM_VERSION, as_of=as_of,
        supplier_id=product.supplier_id, sku=product.sku, warehouse_id=product.warehouse_id,
        unit=product.order_unit, stock_unit=product.stock_unit, available_stock=stock,
        eligible_incoming=eligible, forecast_qty=forecast, safety_stock=safety, raw_need=raw_need,
        recommended_qty=recommended, recommended_stock_qty=recommended_stock, risk_status=risk,
        stockout_date=stockout_date, data_status=status, factors=tuple(factors), warnings=tuple(warnings),
        approval_blockers=tuple(blockers), history=history, adjustments=adjustments,
        trajectory=tuple(trajectory), explanation=explanation)


def calculate_many(products, *, as_of: date):
    keys = [(p.supplier_id, p.sku, p.warehouse_id) for p in products]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate product identity in calculation batch')
    ranks = {'expedite': 0, 'unknown': 1, 'stockout': 2, 'reorder': 3, 'ok': 4}
    return tuple(sorted((calculate(p, as_of=as_of) for p in products),
                        key=lambda r: (ranks[r.risk_status], r.supplier_id, r.sku, r.warehouse_id)))
