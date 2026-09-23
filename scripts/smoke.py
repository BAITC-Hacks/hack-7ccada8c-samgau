"""Real HTTP verification of the bundled engine; --fixture checks the legacy API fixture."""
import argparse
import csv
import io
import json
import urllib.error
import urllib.request
from urllib.parse import quote


class Client:
    def __init__(self, url):
        self.url = url.rstrip('/')
        self.token = None

    def call(self, method, path, payload=None, *, headers=None):
        headers = dict(headers or {})
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if payload is not None and not isinstance(payload, bytes):
            headers['Content-Type'] = 'application/json'
            payload = json.dumps(payload).encode()
        req = urllib.request.Request(self.url + path, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read()
            return data if path.endswith('.csv') else json.loads(data)

    def session(self):
        self.token = self.call('POST', '/api/sessions')['token']

    def expect_error(self, status, method, path, payload=None):
        try:
            self.call(method, path, payload)
        except urllib.error.HTTPError as exc:
            assert exc.code == status, (path, exc.code)
            return json.load(exc)['error']['code']
        raise AssertionError(f'Expected HTTP {status} for {path}')


def verify_order(client, dataset_id, supplier, as_of, sku, *, fixture=False):
    run = client.call('POST', '/api/runs', {
        'dataset_id': dataset_id, 'supplier_id': supplier, 'as_of': as_of,
    })
    assert run['algorithm_version'] == ('platform-fixture-1' if fixture else 'qor-mvp-1.0'), run
    rid = run['run_id']
    row_path = f'/api/runs/{rid}/products/{quote(sku, safe="")}'
    assert client.call('GET', row_path)['recommended_qty'] == 156
    shipments = client.call('GET', f'/api/datasets/{dataset_id}/shipments')['items']
    sid = next(s['id'] for s in shipments if s['sku'] == sku and s['supplier_id'] == supplier)
    scenario = client.call('POST', f'/api/runs/{rid}/scenario', {
        'shipment_id': sid, 'delay_days': 20 if fixture else 30,
    })
    assert client.call('GET', row_path.replace(rid, scenario['run_id']))['recommended_qty'] == 204
    assert client.call('GET', row_path)['recommended_qty'] == 156
    explanation = client.call('POST', f'/api/runs/{rid}/explain', {'sku': sku})
    assert '156' in explanation['text']
    order = client.call('POST', '/api/orders', {'run_id': rid, 'supplier_id': supplier, 'skus': [sku]})
    path = f'/api/orders/{order["draft_id"]}'
    assert client.expect_error(409, 'GET', path + '/export.csv') == 'approval_required'
    order = client.call('PATCH', path, {'version': order['version'], 'changes': [
        {'sku': sku, 'approved_qty': 168, 'reason': 'Smoke test correction'},
    ]})
    assert client.expect_error(409, 'POST', path + '/approve', {'version': 1}) == 'version_conflict'
    order = client.call('POST', path + '/approve', {'version': order['version'], 'acknowledge_warnings': True})
    data = client.call('GET', path + '/export.csv')
    assert data.startswith(b'\xef\xbb\xbf')
    rows = list(csv.DictReader(io.StringIO(data.decode('utf-8-sig')), delimiter=';'))
    assert rows[0]['sku_1c'] == sku and float(rows[0]['quantity']) == 168
    assert client.expect_error(409, 'PATCH', path, {'version': order['version'], 'changes': [
        {'sku': sku, 'approved_qty': 180, 'reason': 'Must not change approved order'},
    ]}) == 'already_approved'
    other = Client(client.url)
    other.session()
    assert other.expect_error(404, 'GET', path) == 'not_found'
    return rid, order['draft_id']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8000')
    parser.add_argument('--fixture', action='store_true')
    args = parser.parse_args()
    client = Client(args.url)
    health = client.call('GET', '/api/health')
    assert health['status'] == 'ok'
    client.expect_error(401, 'GET', '/api/datasets')
    client.session()
    did = 'demo-platform-v1' if args.fixture else 'demo-engine-v1'
    datasets = client.call('GET', '/api/datasets')['items']
    ds = next(d for d in datasets if d['id'] == did)
    if not args.fixture:
        assert health['engine_configured'] and health['importer_configured']
        assert ds['engine_backend'] == 'plugin'
    verify_order(client, did, 'IEK' if args.fixture else 'systeme_electric', ds['as_of'],
                 '0001_' if args.fixture else '00001', fixture=args.fixture)
    if not args.fixture:
        run = client.call('POST', '/api/runs', {'dataset_id': did, 'supplier_id': 'iek', 'as_of': ds['as_of']})
        cable = client.call('GET', f'/api/runs/{run["run_id"]}/products/00007')
        assert cable['recommended_qty'] == 2 and cable['stock_units_per_order_unit'] == 305
        assert cable['unit'] == 'бухта' and cable['stock_unit'] == 'м'
    print(f'PASS ({did}): session -> engine 156 -> scenario 204 -> edit 168 -> approve -> CSV; isolation OK')


if __name__ == '__main__':
    main()
