"""Join normalized records using supplier + SKU + explicit warehouse scope."""
from collections import defaultdict
from datetime import date

from ..engine.models import (Inventory, MonthlySale, ProductInput, Sale, Seasonality,
                             Shipment, Source)
from .xlsx import ImportBatch, parse_date


def origin(record):
    trace = record.source_ref[0]
    return f'{trace.file}:{trace.sheet}:{trace.row}'


def source(record, field=None):
    traces = [t for t in record.source_ref if field is None or t.field == field]
    status = 'assumed' if any(t.status == 'assumed' for t in traces) else 'observed'
    return Source(origin=origin(record), status=status)


def assemble_products(batch: ImportBatch, *, as_of: date, policies: dict,
                      detail_coverage: dict | None = None, incoming_coverage: dict | None = None,
                      category_policies: dict | None = None, stockout_intervals: dict | None = None):
    """Coverage keys are (supplier_id, sku, warehouse_id); no coverage is inferred from file names."""
    detail_coverage = detail_coverage or {}
    incoming_coverage = incoming_coverage or {}
    category_policies = category_policies or {}
    stockout_intervals = stockout_intervals or {}
    groups, seasons = defaultdict(list), defaultdict(list)
    for record in batch.records:
        if record.kind == 'seasonality':
            seasons[record.supplier_id].append(record)
            continue
        v = record.values
        if not v.get('warehouse_id'):
            raise ValueError(f'{origin(record)}: explicit warehouse scope is required')
        groups[(record.supplier_id, v['sku'], v['warehouse_id'])].append(record)
    profiles = {}
    for supplier, records in seasons.items():
        by_month = defaultdict(set)
        for r in records:
            by_month[r.values['month']].add(r.values['coefficient'])
        if set(by_month) != set(range(1, 13)) or any(len(v) != 1 for v in by_month.values()):
            raise ValueError(f'{supplier}: incomplete or conflicting canonical seasonality')
        profiles[supplier] = Seasonality(coefficients=tuple(next(iter(by_month[m])) for m in range(1, 13)),
                                         source=source(records[0]))
    products = []
    for key, records in sorted(groups.items()):
        supplier, sku, warehouse = key
        if supplier not in policies:
            raise ValueError(f'{supplier}: explicit lead time and review policy required')
        warnings = [f'missing_source:{kind}' for kind in batch.missing_sources(supplier)]
        for result in batch.results:
            if result.supplier_id == supplier and result.issues:
                warnings.extend(f'import:{i.code}' for i in result.issues)
        by_kind = defaultdict(list)
        for record in records:
            by_kind[record.kind].append(record)
        catalogs = by_kind['moq']
        catalog_fields = ('stock_unit', 'order_unit', 'stock_units_per_order_unit', 'moq', 'order_multiple', 'category_code')
        if len({tuple(r.values.get(f) for f in catalog_fields) for r in catalogs}) > 1:
            raise ValueError(f'{key}: conflicting dedicated MOQ records')
        catalog = catalogs[0] if catalogs else None
        cv = catalog.values if catalog else {}
        stock_unit = cv.get('stock_unit')
        if not stock_unit:
            units = {r.values.get('unit') for r in records if r.values.get('unit')}
            if len(units) != 1:
                raise ValueError(f'{key}: stock unit requires explicit reconciliation')
            stock_unit = units.pop()
        order_unit = cv.get('order_unit') or stock_unit
        conversion = cv.get('stock_units_per_order_unit')
        if not cv.get('order_unit'):
            warnings.append('order_unit_assumed_equal_stock_unit')
        for record in records:
            if record.kind == 'moq':
                continue
            for field in ('moq', 'order_multiple'):
                if record.values.get(field) is not None and cv.get(field) is not None and record.values[field] != cv[field]:
                    warnings.append(f'dedicated_moq_overrides_conflicting:{field}')

        def stock_quantity(record):
            quantity, unit = record.values.get('quantity'), record.values.get('unit')
            if quantity is None:
                return None
            if unit == stock_unit:
                return quantity
            if unit == order_unit and conversion is not None:
                return quantity * conversion
            raise ValueError(f'{origin(record)}: quantity unit {unit!r} is unresolved')

        sales = tuple(Sale(date=parse_date(r.values['date']), document_id=r.values['document_id'],
                           quantity=stock_quantity(r), customer_id_hash=r.values.get('customer_id_hash'),
                           source=origin(r)) for r in by_kind['sales'])
        monthly = {}
        for record in by_kind['monthly_sales']:
            month = parse_date(record.values['month'])
            quantity = stock_quantity(record)
            if month in monthly:
                if monthly[month].quantity != quantity:
                    raise ValueError(f'{key}: conflicting monthly total for {month}')
                warnings.append('duplicate_monthly_total_not_added')
                continue
            monthly[month] = MonthlySale(month=month, quantity=quantity, source=origin(record))
        for record in by_kind['monthly_stock']:
            if record.values.get('quantity') == 0:
                warnings.append(f'monthly_zero_stock_not_exact_stockout:{record.values["month"]}')
            if record.values.get('snapshot_semantics') == 'unknown':
                warnings.append('monthly_stock_semantics_unknown')
        inventory = None
        snapshots = [r for r in by_kind['inventory'] if parse_date(r.values['as_of']) <= as_of]
        if snapshots:
            latest = max(parse_date(r.values['as_of']) for r in snapshots)
            selected = [r for r in snapshots if parse_date(r.values['as_of']) == latest]
            values = {tuple(r.values.get(f) for f in ('available', 'on_hand', 'reserved', 'unit')) for r in selected}
            if len(values) > 1:
                warnings.append('conflicting_inventory_snapshots')
            else:
                record = selected[0]
                if record.values.get('unit') != stock_unit:
                    raise ValueError(f'{origin(record)}: inventory must be normalized to stock unit')
                inventory = Inventory(as_of=latest, available=record.values.get('available'),
                                      on_hand=record.values.get('on_hand'), reserved=record.values.get('reserved'), source=source(record))
        shipments = {}
        complete_incoming = bool(incoming_coverage.get(key, False))
        if any(r.rows_skipped for r in batch.results if r.supplier_id == supplier and r.kind == 'incoming'):
            complete_incoming = False
        for record in by_kind['incoming']:
            v = record.values
            if v.get('quantity') is None:
                complete_incoming = False
                warnings.append('incoming_quantity_unknown')
                continue
            if v['quantity'] == 0:
                continue
            shipment = Shipment(shipment_id=v['shipment_id'], quantity=v['quantity'],
                                unit=v['unit'], eta=parse_date(v['eta']), source=source(record))
            previous = shipments.get(shipment.shipment_id)
            if previous is not None:
                if (previous.quantity, previous.unit, previous.eta) != (shipment.quantity, shipment.unit, shipment.eta):
                    raise ValueError(f'{key}: conflicting shipment {shipment.shipment_id}')
                warnings.append('duplicate_shipment_not_added')
            shipments[shipment.shipment_id] = shipment
        growth = growth_source = None
        for record in records:
            if record.values.get('growth_value') is None:
                continue
            if record.values.get('growth_semantics') != 'percent_change':
                warnings.append('growth_semantics_unconfirmed')
                continue
            if growth is not None and growth != record.values['growth_value']:
                raise ValueError(f'{key}: conflicting confirmed growth')
            growth, growth_source = record.values['growth_value'], source(record, 'growth_value')
        coverage = tuple(sorted(detail_coverage.get(key, ())))
        if any(r.rows_skipped for r in batch.results if r.supplier_id == supplier and r.kind == 'sales'):
            # A rejected row may belong to any SKU/month, so do not manufacture zero sales.
            coverage = ()
            warnings.append('detail_coverage_revoked_due_to_rejected_rows')
        products.append(ProductInput(supplier_id=supplier, sku=sku, warehouse_id=warehouse,
            name=cv.get('name') or '', supplier_article=cv.get('supplier_article'),
            stock_unit=stock_unit, order_unit=order_unit, stock_units_per_order_unit=conversion,
            units_source=source(catalog, 'stock_units_per_order_unit') if catalog and conversion else None,
            moq=cv.get('moq'), order_multiple=cv.get('order_multiple'),
            order_rules_source=source(catalog) if catalog else None, category_code=cv.get('category_code'),
            category_policy=category_policies.get((supplier, cv.get('category_code'))), policy=policies[supplier],
            sales=sales, monthly_sales=tuple(monthly[m] for m in sorted(monthly)),
            detail_months=coverage, inventory=inventory,
            incoming=tuple(shipments.values()), incoming_complete=complete_incoming,
            seasonality=profiles.get(supplier), stockouts=tuple(stockout_intervals.get(key, ())),
            confirmed_growth_pct=growth, growth_source=growth_source, warnings=tuple(sorted(set(warnings)))))
    return tuple(products)
