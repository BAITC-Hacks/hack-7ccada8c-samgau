"""Auditable order cleaning, stockout reconstruction and monthly demand."""
from __future__ import annotations

from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta
from statistics import median

from .models import HistoryPoint, OrderAdjustment, ProductInput, Scenario


def month_start(day: date) -> date:
    return day.replace(day=1)


def previous_month(day: date) -> date:
    return (month_start(day) - timedelta(days=1)).replace(day=1)


def clean_orders(product: ProductInput, as_of: date, scenario: Scenario):
    warnings = []
    grouped = {}
    for sale in product.sales:
        if sale.date > as_of:
            warnings.append('future_sales_ignored')
            continue
        if sale.quantity < 0:
            warnings.append('negative_movements_excluded_pending_policy')
            continue
        key = (sale.date, sale.document_id)
        if key not in grouped:
            grouped[key] = dict(date=sale.date, document_id=sale.document_id,
                                customer=sale.customer_id_hash, raw=0.0, regular=0.0, reasons=[], sources=set())
        row = grouped[key]
        if row['customer'] != sale.customer_id_hash:
            row['customer'] = None
            warnings.append('conflicting_customer_ids')
        row['raw'] += sale.quantity
        row['regular'] += sale.quantity
        row['sources'].add(sale.source)
    rows = sorted(grouped.values(), key=lambda r: (r['date'], r['document_id']))
    if not any(r['customer'] for r in rows):
        warnings.append('customer_detail_missing')
    unknown = set(scenario.order_classification) - {r['document_id'] for r in rows}
    if unknown:
        raise ValueError(f'unknown documents in scenario: {sorted(unknown)}')

    def cap_groups(groups, reason, lookback=180, minimum=8):
        groups = sorted(groups, key=lambda g: (g['date'], g['key']))
        candidates = []
        for i, group in enumerate(groups):
            reference = [g['quantity'] for g in groups[:i]
                         if 0 < (group['date'] - g['date']).days <= lookback and g['quantity'] > 0]
            manual = {scenario.order_classification.get(rows[j]['document_id']) for j in group['indices']}
            if 'regular' in manual:
                continue
            if len(reference) < minimum:
                if 'one_off' in manual:
                    warnings.append('manual_outlier_without_baseline')
                continue
            typical = median(reference)
            mad = median(abs(v - typical) for v in reference)
            if group['quantity'] > max(5 * typical, typical + 6 * mad) or 'one_off' in manual:
                candidates.append((group, typical, 'one_off' in manual))
        for group, typical, manual in candidates:
            repeated = {g['date'].isocalendar()[:2] for g, _, _ in candidates
                        if abs((g['date'] - group['date']).days) <= 180}
            if len(repeated) >= 3 and not manual:
                warnings.append('repeated_large_orders_require_review')
                continue
            total = sum(rows[j]['regular'] for j in group['indices'])
            if total > typical:
                for j in group['indices']:
                    rows[j]['regular'] *= typical / total
                    rows[j]['reasons'].append(reason)

    cap_groups([dict(date=r['date'], key=r['document_id'], quantity=r['raw'], indices=[i])
                for i, r in enumerate(rows)], 'document_outlier')
    # Re-evaluate split purchases using the cleaned quantities to avoid double removal.
    for monthly in (False, True):
        by_customer = defaultdict(lambda: defaultdict(list))
        for i, row in enumerate(rows):
            if row['customer']:
                period = month_start(row['date']) if monthly else row['date']
                by_customer[row['customer']][period].append(i)
        for customer, periods in sorted(by_customer.items()):
            groups = [dict(date=period, key=customer, indices=indices,
                           quantity=sum(rows[i]['regular'] for i in indices))
                      for period, indices in periods.items()
                      if not monthly or period < month_start(as_of)]
            cap_groups(groups, 'customer_month_outlier' if monthly else 'customer_day_outlier',
                       lookback=730 if monthly else 180, minimum=3 if monthly else 8)
    if len(rows) < 8:
        warnings.append('short_order_history_no_confident_outlier_detection')
    adjustments = tuple(OrderAdjustment(
        date=r['date'], document_id=r['document_id'], customer_id_hash=r['customer'],
        raw_quantity=r['raw'], regular_quantity=r['regular'],
        excluded_quantity=r['raw'] - r['regular'], reasons=tuple(r['reasons']),
        source_refs=tuple(sorted(r['sources']))) for r in rows)
    return adjustments, warnings


def reconstruct_demand(sales: float, total_days: int, absent_days: int,
                       fallback_daily: float | None = None) -> float | None:
    if not 0 <= absent_days <= total_days or sales < 0 or total_days <= 0:
        raise ValueError('invalid stockout reconstruction inputs')
    if absent_days == 0:
        return sales
    present = total_days - absent_days
    if present >= 7:
        return sales + sales / present * absent_days
    if fallback_daily is not None:
        return sales + fallback_daily * absent_days
    return None


def build_history(product: ProductInput, as_of: date, adjustments, coefficients):
    warnings = []
    monthly = {m.month: m for m in product.monthly_sales}
    detailed = defaultdict(list)
    for row in adjustments:
        detailed[month_start(row.date)].append(row)
    detail_months = set(product.detail_months)
    months = sorted(set(monthly) | set(detailed) | detail_months)
    preliminary = {}
    first_current = month_start(as_of)
    for month in months:
        if month > first_current:
            continue
        complete = month < first_current
        days = monthrange(month.year, month.month)[1] if complete else as_of.day
        raw = regular = None
        source = 'missing'
        if month in detail_months or (not complete and month in detailed):
            raw = sum(r.raw_quantity for r in detailed[month])
            regular = sum(r.regular_quantity for r in detailed[month])
            source = ';'.join(sorted({ref for r in detailed[month] for ref in r.source_refs})) or 'confirmed_zero_detail_month'
            if month in monthly and monthly[month].quantity is not None:
                if abs(raw - monthly[month].quantity) > 1e-6:
                    warnings.append(f'monthly_detail_mismatch:{month.isoformat()}')
        elif month in monthly:
            raw = regular = monthly[month].quantity
            source = monthly[month].source
            warnings.append('monthly_only_outliers_not_observable')
        else:
            warnings.append(f'incomplete_detail_coverage:{month.isoformat()}')
        absent = set()
        for interval in product.stockouts:
            start, end = max(month, interval.start), min(month + timedelta(days=days - 1), interval.end)
            if start <= end:
                absent.update(start + timedelta(days=i) for i in range((end - start).days + 1))
                if interval.source.status == 'assumed':
                    warnings.append('assumed_stockout_duration')
        preliminary[month] = dict(raw=raw, regular=regular, days=days, absent=len(absent),
                                  complete=complete, source=source)
    history = []
    for month, item in preliminary.items():
        regular = item['regular']
        restored = None
        if regular is not None:
            # Use preceding complete periods only; normalize seasonality for comparison.
            comparable = [v['regular'] / (v['days'] - v['absent']) / coefficients[m.month - 1]
                          for m, v in preliminary.items() if m < month and v['complete']
                          and v['regular'] is not None and v['days'] - v['absent'] >= 7]
            fallback = median(comparable[-3:]) * coefficients[month.month - 1] if comparable else None
            restored = reconstruct_demand(regular, item['days'], item['absent'], fallback)
            if restored is None:
                warnings.append(f'stockout_without_reference:{month.isoformat()}')
        history.append(HistoryPoint(month=month, raw_sales=item['raw'], regular_sales=regular,
                                    restored_demand=restored, stockout_days=item['absent'],
                                    complete=item['complete'], source=item['source']))
    return tuple(history), warnings


def forecast_level(product: ProductInput, as_of: date, history, coefficients):
    warnings = []
    usable = {h.month: h for h in history if h.complete and h.restored_demand is not None}
    baseline = [h.restored_demand / monthrange(m.year, m.month)[1] / coefficients[m.month - 1]
                for m, h in usable.items() if m.year == as_of.year - 1]
    if len(baseline) >= 3:
        base = median(baseline)
        ratios = []
        month = previous_month(as_of)
        for _ in range(3):
            prior = month.replace(year=month.year - 1)
            if month in usable and prior in usable and usable[prior].restored_demand > 0:
                current_daily = usable[month].restored_demand / monthrange(month.year, month.month)[1]
                previous_daily = usable[prior].restored_demand / monthrange(prior.year, prior.month)[1]
                ratios.append(current_daily / previous_daily)
            month = previous_month(month)
        if product.confirmed_growth_pct is not None:
            growth = 1 + product.confirmed_growth_pct / 100
            growth_source = product.growth_source
        elif len(ratios) >= 2:
            growth = median(ratios)
            growth_source = ('estimated', 'median_of_comparable_months')
        else:
            growth = 1.0
            growth_source = ('assumed', 'no_comparable_growth_history')
            warnings.append('growth_assumed_flat')
        return base, growth, growth_source, warnings
    recent = sorted(usable)[-3:]
    if not recent:
        return None, None, ('missing', 'no_complete_history'), ['insufficient_demand_history']
    base = median(usable[m].restored_demand / monthrange(m.year, m.month)[1] / coefficients[m.month - 1]
                  for m in recent)
    warnings.append('recent_level_already_includes_growth')
    if product.confirmed_growth_pct is not None:
        warnings.append('confirmed_growth_not_reapplied_to_recent_level')
    return base, 1.0, ('assumed', 'recent_level_no_additional_growth'), warnings
