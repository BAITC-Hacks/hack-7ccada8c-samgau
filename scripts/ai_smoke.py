"""Check a configured live provider on synthetic engine data; fallback is a failure."""
import argparse
from urllib.parse import quote
from smoke import Client


def check_chat(client, dataset, run):
    rows = client.call('GET', f'/api/runs/{run["run_id"]}/recommendations?page=1&page_size=100')['items']
    row = next(r for r in rows if r['sku'] == '00001')
    product_fields = ('sku', 'supplier_article', 'name', 'unit', 'stock_unit', 'available_stock',
                      'eligible_incoming', 'forecast_qty', 'safety_stock', 'recommended_qty',
                      'raw_need', 'stock_units_per_order_unit', 'moq', 'order_step',
                      'risk_status', 'data_status', 'approval_blockers')
    product = {key: row[key] for key in product_fields}
    product.update(supplier_id=row['supplier_id'], run_id=run['run_id'])
    product['warnings'] = row['warnings'][:6]
    product['factors'] = [{'label': f['label'][:120], 'value': str(f['value'])[:200]} for f in row['factors'][:6]]
    context = {
        'data_mode': 'synthetic', 'run_id': run['run_id'], 'warehouse': dataset['warehouse_id'],
        'as_of': dataset['as_of'], 'total_products': len(rows),
        'order_skus': run['summary']['to_order'], 'risk_skus': run['summary']['critical'],
        'review_skus': run['summary']['needs_review'], 'scenario': 'Исходный расчёт',
        'selected_sku': row['sku'], 'products': [product],
    }
    history = []
    for question, expected_destination in [
        ('Сколько рекомендовано заказать выбранного товара? Укажи готовое количество из расчёта и единицу, объясни причину.', None),
        ('Где проверить этот заказ и скачать CSV?', 'recommendations'),
        ('Қауіпсіздік қоры деген не? Қысқаша түсіндір.', None),
    ]:
        answer = client.call('POST', '/api/assistant/messages', {'message': question, 'history': history, 'context': context})
        if answer['status'] != 'generated':
            raise SystemExit('FAIL: live chat returned fallback: ' + str(answer.get('error_code')))
        if expected_destination:
            assert expected_destination in answer['destinations'], answer
        if not history:
            assert str(int(row['recommended_qty'])) in answer['text'], answer
            assert row['sku'] in answer['source_skus'], answer
        history.extend([{'role': 'user', 'content': question}, {'role': 'assistant', 'content': answer['text']}])
    unchanged = client.call('GET', f'/api/runs/{run["run_id"]}/products/{quote(row["sku"], safe="")}')
    assert unchanged['recommended_qty'] == row['recommended_qty']
    print('PASS: live chat answered calculation, navigation and Kazakh follow-up; calculation unchanged')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8000')
    args = parser.parse_args()
    client = Client(args.url)
    if not client.call('GET', '/api/health')['ai_configured']:
        raise SystemExit('FAIL: configure AI_PROVIDER, key and model on the server first')
    client.session()
    ds = next(d for d in client.call('GET', '/api/datasets')['items'] if d['id'] == 'demo-engine-v1')
    run = client.call('POST', '/api/runs', {
        'dataset_id': ds['id'], 'supplier_id': 'systeme_electric', 'as_of': ds['as_of'],
    })
    assert run['algorithm_version'] == 'qor-mvp-1.0'
    rid = run['run_id']
    shipments = client.call('GET', f'/api/datasets/{ds["id"]}/shipments')['items']
    sid = next(s['id'] for s in shipments if s['sku'] == '00001' and s['supplier_id'] == 'systeme_electric')
    parsed = client.call('POST', '/api/scenarios/parse', {
        'run_id': rid, 'selected_shipment_id': sid,
        'text': 'Задержи выбранную поставку на 7 дней, спрос увеличится на 20 процентов',
    })
    if parsed['status'] != 'generated' or parsed['needs_clarification']:
        raise SystemExit('FAIL: provider did not return a valid scenario; check key/model/provider')
    assert parsed['requires_confirmation']
    assert parsed['scenario'] == {'shipment_id': sid, 'delay_days': 7, 'demand_change_pct': 20.0}
    explanation = client.call('POST', f'/api/runs/{rid}/explain', {'sku': '00001', 'language': 'ru'})
    assert explanation['status'] == 'generated'
    print('PASS: live provider parsed the scenario and selected verified engine factors')
    check_chat(client, ds, run)


if __name__ == '__main__':
    main()
