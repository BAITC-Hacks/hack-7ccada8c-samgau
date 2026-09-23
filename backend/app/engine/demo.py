"""Deterministic synthetic fixtures. Run: python -m app.engine.demo --output-dir data/demo."""
from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

from .calculator import ALGORITHM_VERSION, calculate_many
from .models import (CategoryPolicy, Inventory, ProductInput, Sale, Seasonality,
                     Shipment, Source, Stockout, SupplierPolicy)

AS_OF = date(2026, 9, 22)
DATASET_ID = 'qor-synthetic-v1'
SYNTHETIC = Source(origin=DATASET_ID)
DEMO_POLICY = Source(origin='synthetic_policy_not_supplier_contract', status='assumed')


def make_demo_products() -> tuple[ProductInput, ...]:
    """Eight cases from SPEC section 13; dates and identifiers never depend on the clock."""
    products = []
    cases = [('stable', 'Стабильный спрос'), ('seasonal', 'Сезонный товар'),
             ('growing', 'Устойчивый рост'), ('one_off', 'Разовый крупный заказ'),
             ('stockout', 'Точное отсутствие товара'), ('delay', 'Задержка поставки'),
             ('cable', 'Кабель: метры и бухты'), ('missing', 'Недостаточные данные')]
    for index, (case, name) in enumerate(cases, 1):
        supplier = 'iek' if case in ('seasonal', 'stockout', 'cable') else 'systeme_electric'
        sku = f'{index:05}'
        seasonal = (0.8, 0.8, 0.9, 0.9, 1, 1, 1, 1, 1.2, 1.2, 1.1, 1.1) if supplier == 'iek' else (1,) * 12
        sales, covered = [], set()
        day = date(2025, 1, 1)
        while day <= AS_OF and case != 'missing':
            quantity = (400 / 28 if case == 'cable' else 10) * seasonal[day.month - 1]
            if case == 'growing' and day.year == 2026:
                quantity *= 1.2
            covered.add(day.replace(day=1))
            if not (case == 'stockout' and date(2026, 6, 1) <= day <= date(2026, 6, 10)):
                if case == 'one_off' and day == date(2026, 8, 15):
                    quantity = 1000
                sales.append(Sale(date=day, document_id=f'DEMO-{sku}-{day.isoformat()}',
                                  quantity=quantity, customer_id_hash=f'synthetic-customer-{sku}',
                                  source=DATASET_ID))
            day += timedelta(days=1)
        cable = case == 'cable'
        incoming = () if case in ('cable', 'missing') else (
            Shipment(shipment_id=f'DEMO-SHIP-{sku}', quantity=50, unit='шт',
                     eta=AS_OF + timedelta(days=5 if case != 'delay' else 7), source=SYNTHETIC),)
        products.append(ProductInput(
            supplier_id=supplier, sku=sku, warehouse_id='synthetic-almaty',
            name=f'[ДЕМО] {name}', supplier_article=f'DEMO-{case}',
            stock_unit='м' if cable else 'шт', order_unit='бухта' if cable else 'шт',
            stock_units_per_order_unit=305 if cable else 1, units_source=SYNTHETIC,
            moq=None if case == 'missing' else 0,
            order_multiple=None if case == 'missing' else (1 if cable else 12),
            order_rules_source=SYNTHETIC,
            category_code='synthetic-normal',
            category_policy=CategoryPolicy(safety_days=7, source=DEMO_POLICY),
            policy=SupplierPolicy(lead_time_days=14, review_days=7, source=DEMO_POLICY),
            sales=tuple(sales), detail_months=tuple(sorted(covered)),
            stockouts=(Stockout(start=date(2026, 6, 1), end=date(2026, 6, 10), source=SYNTHETIC),)
                      if case == 'stockout' else (),
            inventory=None if case == 'missing' else Inventory(as_of=AS_OF, available=0 if cable else 80, source=SYNTHETIC),
            incoming=incoming, incoming_complete=True,
            seasonality=Seasonality(coefficients=seasonal, source=SYNTHETIC),
            warnings=('synthetic_demo_data',)))
    return tuple(products)


def export_demo(output_dir: Path):
    products = make_demo_products()
    recommendations = calculate_many(products, as_of=AS_OF)
    metadata = dict(dataset_id=DATASET_ID, data_mode='synthetic', as_of=AS_OF.isoformat(),
                    algorithm_version=ALGORITHM_VERSION,
                    label='Демонстрационные данные; не являются данными поставщиков')
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'dataset.json').write_text(json.dumps(
        {**metadata, 'products': [p.model_dump(mode='json') for p in products]}, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'recommendations.json').write_text(json.dumps(
        {**metadata, 'items': [r.model_dump(mode='json') for r in recommendations]}, ensure_ascii=False), encoding='utf-8')
    (output_dir / 'table.json').write_text(json.dumps(
        {**metadata, 'items': [r.model_dump(mode='json', exclude={'history', 'adjustments', 'trajectory'})
                              for r in recommendations]}, ensure_ascii=False, indent=2), encoding='utf-8')
    return recommendations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path('data/demo'))
    args = parser.parse_args()
    for result in export_demo(args.output_dir):
        print(f'{result.supplier_id:18} {result.sku} {str(result.recommended_qty):>6} '
              f'{result.unit:5} {result.risk_status:9} {result.data_status}')
    print(f'SYNTHETIC dataset and results: {args.output_dir.resolve()}')


if __name__ == '__main__':
    main()
