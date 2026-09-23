"""Check a configured live provider on synthetic engine data; fallback is a failure."""
import argparse
from smoke import Client


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


if __name__ == '__main__':
    main()
