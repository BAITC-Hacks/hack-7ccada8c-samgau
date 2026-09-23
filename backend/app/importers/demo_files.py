"""Twelve synthetic workbooks with explicit mappings, never claimed as real supplier layouts."""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from openpyxl import Workbook

from ..engine.calculator import calculate_many
from ..engine.demo import AS_OF, DATASET_ID, make_demo_products
from .assemble import assemble_products
from .xlsx import IEKAdapter, ImportBatch, SystemeElectricAdapter, WideColumn, WorkbookMapping


def create_demo_workbooks(output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)
    products = make_demo_products()
    mappings = []
    for supplier in ('iek', 'systeme_electric'):
        selected = [p for p in products if p.supplier_id == supplier]
        months = sorted({m for p in selected for m in p.detail_months})
        for kind in ('sales', 'monthly_sales', 'monthly_stock', 'incoming', 'seasonality', 'moq'):
            rows, wide = [], ()
            if kind == 'sales':
                fields = ['sku', 'date', 'document_id', 'quantity', 'unit', 'warehouse_id', 'customer_id_hash']
                for p in selected:
                    rows.extend([p.sku, s.date, s.document_id, s.quantity, p.stock_unit, p.warehouse_id, s.customer_id_hash]
                                for s in p.sales)
            elif kind in ('monthly_sales', 'monthly_stock'):
                fields = ['sku', 'warehouse_id', 'unit']
                wide = tuple(WideColumn(column=m.isoformat(), date=m) for m in months)
                for p in selected:
                    totals = defaultdict(float)
                    for sale in p.sales:
                        totals[sale.date.replace(day=1)] += sale.quantity
                    values = []
                    for month in months:
                        if month not in p.detail_months:
                            values.append(None)
                        elif kind == 'monthly_sales':
                            values.append(totals[month])
                        else:
                            values.append(0 if any(s.start == month for s in p.stockouts) else 1000)
                    rows.append([p.sku, p.warehouse_id, p.stock_unit, *values])
            elif kind == 'incoming':
                fields = ['sku', 'warehouse_id', 'unit', 'quantity', 'eta', 'shipment_id', 'as_of', 'available']
                for p in selected:
                    shipment = p.incoming[0] if p.incoming else None
                    rows.append([p.sku, p.warehouse_id, p.stock_unit, shipment.quantity if shipment else 0,
                                 shipment.eta if shipment else AS_OF.replace(day=23),
                                 shipment.shipment_id if shipment else f'DEMO-NONE-{p.sku}', AS_OF,
                                 p.inventory.available if p.inventory else None])
            elif kind == 'seasonality':
                fields = ['month', 'coefficient']
                rows = [[i, coefficient] for i, coefficient in enumerate(selected[0].seasonality.coefficients, 1)]
            else:
                fields = ['sku', 'warehouse_id', 'name', 'supplier_article', 'stock_unit', 'order_unit',
                          'stock_units_per_order_unit', 'moq', 'order_multiple', 'category_code']
                rows = [[getattr(p, field) for field in fields] for p in selected]
            book = Workbook()
            sheet = book.active
            sheet.title = 'SYNTHETIC'
            sheet.append(fields + [entry.column for entry in wide])
            for row in rows:
                sheet.append(row)
            path = output_dir / f'{supplier}_{kind}.xlsx'
            book.save(path)
            book.close()
            mapping = WorkbookMapping(kind=kind, version='synthetic-v1-not-real-supplier-format',
                                      sheet='SYNTHETIC', columns={f: f for f in fields}, wide=wide,
                                      snapshot_semantics='month_start' if kind == 'monthly_stock' else 'unknown')
            mappings.append((supplier, path, mapping))
    manifest = dict(dataset_id=DATASET_ID, data_mode='synthetic', as_of=AS_OF.isoformat(),
        label='Синтетические форматы для проверки импорта; реальные выгрузки не проверены',
        files=[dict(supplier_id=s, file=p.name, mapping=m.model_dump(mode='json')) for s, p, m in mappings],
        coverage=[dict(supplier_id=p.supplier_id, sku=p.sku, warehouse_id=p.warehouse_id,
                       detail_months=[d.isoformat() for d in p.detail_months], incoming_complete=True,
                       stockouts=[s.model_dump(mode='json') for s in p.stockouts]) for p in products])
    (output_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return tuple(mappings)


def import_demo_workbooks(mappings):
    batch = ImportBatch()
    for supplier, path, mapping in mappings:
        adapter = IEKAdapter() if supplier == 'iek' else SystemeElectricAdapter()
        batch.add(adapter.read(path, mapping))
    original = make_demo_products()
    identity = lambda p: (p.supplier_id, p.sku, p.warehouse_id)
    normalized = assemble_products(batch, as_of=AS_OF,
        policies={p.supplier_id: p.policy for p in original},
        detail_coverage={identity(p): p.detail_months for p in original},
        incoming_coverage={identity(p): p.incoming_complete for p in original},
        category_policies={(p.supplier_id, p.category_code): p.category_policy for p in original},
        stockout_intervals={identity(p): p.stockouts for p in original})
    return batch, normalized


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path('data/demo/xlsx'))
    args = parser.parse_args()
    mappings = create_demo_workbooks(args.output_dir)
    batch, normalized = import_demo_workbooks(mappings)
    report = {'data_mode': 'synthetic', 'files': [r.model_dump(mode='json', exclude={'records'}) for r in batch.results]}
    (args.output_dir / 'quality.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    results = calculate_many(normalized, as_of=AS_OF)
    (args.output_dir / 'recommendations.json').write_text(json.dumps(
        {'data_mode': 'synthetic', 'items': [r.model_dump(mode='json') for r in results]}, ensure_ascii=False), encoding='utf-8')
    print(f'SYNTHETIC: {len(mappings)} XLSX files, {len(normalized)} products, '
          f'{sum(r.rows_skipped for r in batch.results)} rejected rows; {args.output_dir.resolve()}')


if __name__ == '__main__':
    main()
