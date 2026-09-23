"""Actual participant-2 plugins exercised through captain contracts and HTTP endpoints."""
import csv
import io
import json
import time
from datetime import timedelta
from hashlib import sha256
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.config import Settings
from app.contracts import CalculationParameters, DatasetPayload, EngineResult, ImportFile, ImportRequest, Scenario
from app.engine.demo import AS_OF, make_demo_products
from app.engine.models import CategoryPolicy, ProductInput, Source
from app.engine.service import DEMO_DATASET_ID, calculate, demo_dataset, make_dataset
from app.importers.demo_files import create_demo_workbooks
from app.importers.service import MAPPING_VERSION, METADATA_SHEET, import_dataset
from app.main import create_app
from app.orders import validate_line


@pytest.fixture(scope='module')
def dataset():
    return demo_dataset()


@pytest.fixture(scope='module')
def workbooks(tmp_path_factory):
    return create_demo_workbooks(tmp_path_factory.mktemp('service-xlsx'))


def params(**updates):
    return CalculationParameters(supplier_id='systeme_electric', as_of=AS_OF, **updates)


def by_sku(result):
    return {r.sku: r for r in result.recommendations}


def request_for(workbooks, supplier='systeme_electric', external=None):
    return ImportRequest(supplier_id=external or supplier, mapping_version=MAPPING_VERSION,
        as_of=AS_OF, warehouse_id='synthetic-almaty', files=[
            ImportFile(path=path, original_name=path.name, sha256=sha256(path.read_bytes()).hexdigest())
            for vendor, path, _ in workbooks if vendor == supplier])


def test_service_shared_contract_baseline_scenario_and_immutability(dataset):
    before = dataset.model_dump_json()
    baseline = calculate(dataset, params())
    assert isinstance(baseline, EngineResult)
    assert by_sku(baseline)['00001'].recommended_qty == 156
    shipment = next(s for s in dataset.shipments if s.sku == '00001')
    delayed = calculate(dataset, params(scenario=Scenario(shipment_id=shipment.id, delay_days=30)))
    assert by_sku(delayed)['00001'].recommended_qty == 204
    assert by_sku(delayed)['00006'].recommended_qty == by_sku(baseline)['00006'].recommended_qty
    assert dataset.model_dump_json() == before
    assert calculate(dataset, params()).model_dump_json() == baseline.model_dump_json()
    assert EngineResult.model_validate_json(baseline.model_dump_json()) == baseline


@pytest.mark.parametrize('changes,forecast,safety', [({'lead_time_days': 7}, 140, 70),
    ({'review_days': 14}, 280, 70), ({'safety_days': 0}, 210, 0),
    ({'scenario': Scenario(demand_change_pct=20)}, 252, 84)])
def test_run_parameters_are_not_ignored(dataset, changes, forecast, safety):
    row = by_sku(calculate(dataset, params(**changes)))['00001']
    assert row.forecast_qty == pytest.approx(forecast)
    assert row.safety_stock == pytest.approx(safety)


def test_confirmed_category_can_refine_explicit_parameters():
    product = make_demo_products()[0].model_copy(update={
        'category_policy': CategoryPolicy(safety_days=14, review_days=14, source=Source(origin='confirmed-critical'))})
    ds = make_dataset((product,), name='category', mode='synthetic', as_of=AS_OF, version='test')
    row = calculate(ds, params()).recommendations[0]
    assert row.forecast_qty == 280 and row.safety_stock == 140
    assert next(f for f in row.factors if f.id == 'safety_days').source.file == 'confirmed-critical'


def test_unknowns_and_blockers_survive_shared_contract(dataset):
    row = by_sku(calculate(dataset, params()))['00008']
    assert row.data_status == 'blocked'
    assert row.available_stock is None and row.recommended_qty is None
    assert next(f for f in row.factors if f.id == 'moq').value is None
    assert 'order_rules_missing' in row.approval_blockers
    assert validate_line({'recommendation': row.model_dump(mode='json'), 'approved_qty': 100}) is not None


def test_cable_units_and_history_shape(dataset):
    row = by_sku(calculate(dataset, CalculationParameters(supplier_id='iek', as_of=AS_OF)))['00007']
    assert row.recommended_qty == 2 and row.stock_units_per_order_unit == 305
    assert row.unit == 'бухта' and row.stock_unit == 'м'
    assert {'actual', 'regular', 'restored', 'complete'} <= row.history[0].keys()
    assert {'date', 'without_order', 'with_order', 'incoming'} <= row.trajectory[0].keys()


def test_global_shipment_line_ids_and_stock_unit_index():
    first = make_demo_products()[0]
    second = first.model_copy(update={'sku': 'other'})
    ds = make_dataset((first, second), name='same PO', mode='synthetic', as_of=AS_OF, version='test')
    assert len({s.id for s in ds.shipments}) == 2
    first = first.model_copy(update={'order_unit': 'коробка', 'stock_units_per_order_unit': 12.0,
        'incoming': (first.incoming[0].model_copy(update={'quantity': 2.0, 'unit': 'коробка'}),)})
    ds = make_dataset((first,), name='units', mode='synthetic', as_of=AS_OF, version='test')
    assert ds.shipments[0].quantity == 24


def test_scope_and_index_mismatches_are_rejected(dataset):
    with pytest.raises(ValueError, match='supplier'):
        calculate(dataset, CalculationParameters(supplier_id='unknown', as_of=AS_OF))
    with pytest.raises(ValueError, match='date'):
        calculate(dataset, CalculationParameters(supplier_id='iek', as_of=AS_OF + timedelta(days=1)))
    with pytest.raises(ValueError, match='shipment metadata'):
        calculate(dataset.model_copy(update={'shipments': []}), params())
    other = next(s for s in dataset.shipments if s.supplier_id == 'iek')
    with pytest.raises(ValueError, match='scope'):
        calculate(dataset, params(scenario=Scenario(shipment_id=other.id, delay_days=7)))


@pytest.mark.parametrize('supplier,external', [('iek', 'IEK'), ('systeme_electric', 'systeme')])
def test_import_entry_point_roundtrip_and_aliases(workbooks, tmp_path, supplier, external):
    request = request_for(workbooks, supplier, external)
    # API stores files under random names; original source names must survive.
    moved = []
    for i, entry in enumerate(request.files):
        path = tmp_path / f'upload-{i}.xlsx'
        path.write_bytes(entry.path.read_bytes())
        moved.append(entry.model_copy(update={'path': path}))
    ds = import_dataset(request.model_copy(update={'files': moved}))
    assert isinstance(ds, DatasetPayload)
    assert ds.mode == 'real' and ds.supplier_ids == [external]
    assert ds.quality['source_count'] == 6
    assert ds.quality['files'][0]['rows_skipped'] == 0
    serialized = ds.model_dump_json()
    assert str(tmp_path) not in serialized and 'upload-0.xlsx' not in serialized
    assert '.xlsx' in ds.data['products'][0]['sales'][0]['source']
    for entry in moved:
        entry.path.unlink()
    # No dependency on temporary upload files after persistence.
    restored = DatasetPayload.model_validate_json(serialized)
    result = calculate(restored, CalculationParameters(supplier_id=external, as_of=AS_OF))
    assert all(r.supplier_id == external for r in result.recommendations)
    if supplier == 'systeme_electric':
        assert by_sku(result)['00001'].recommended_qty == 156
    else:
        stockout = by_sku(result)['00005']
        june = next(h for h in stockout.history if h['month'] == '2026-06-01')
        assert june['restored'] == 300 and june['actual'] == 200


def test_import_required_sources_scope_hash_and_version(workbooks):
    req = request_for(workbooks)
    with pytest.raises(ValueError, match='missing required'):
        import_dataset(req.model_copy(update={'files': req.files[:-1]}))
    with pytest.raises(ValueError, match='hash'):
        import_dataset(req.model_copy(update={'files': [req.files[0].model_copy(update={'sha256': 'wrong'}), *req.files[1:]]}))
    with pytest.raises(ValueError, match='warehouse'):
        import_dataset(req.model_copy(update={'warehouse_id': 'different'}))
    with pytest.raises(ValueError, match='mapping_version'):
        import_dataset(req.model_copy(update={'mapping_version': 'unverified-real-format'}))
    with pytest.raises(ValueError, match='supplier'):
        import_dataset(req.model_copy(update={'supplier_id': 'iek'}))
    duplicate = import_dataset(req.model_copy(update={'files': [*req.files, req.files[0]]}))
    assert duplicate.quality['source_count'] == 6
    assert len(duplicate.quality['duplicate_files_ignored']) == 1


def test_import_manifest_required(workbooks, tmp_path):
    req = request_for(workbooks)
    first = req.files[0]
    path = tmp_path / 'no-manifest.xlsx'
    book = load_workbook(first.path)
    del book[METADATA_SHEET]
    book.save(path)
    book.close()
    broken = first.model_copy(update={'path': path, 'sha256': sha256(path.read_bytes()).hexdigest()})
    with pytest.raises(ValueError, match='manifest missing'):
        import_dataset(req.model_copy(update={'files': [broken, *req.files[1:]]}))


def test_archive_resource_limit_before_xml_parsing(workbooks, tmp_path):
    path = tmp_path / 'oversized-ratio.xlsx'
    with ZipFile(path, 'w', compression=ZIP_DEFLATED) as archive:
        archive.writestr('xl/sharedStrings.xml', b'0' * (5 * 1024 * 1024))
    entry = ImportFile(path=path, original_name='oversized-ratio.xlsx', sha256=sha256(path.read_bytes()).hexdigest())
    req = request_for(workbooks).model_copy(update={'files': [entry]})
    with pytest.raises(ValueError, match='compression ratio'):
        import_dataset(req)


def test_real_plugins_through_captain_import_calculate_approve_export(workbooks, tmp_path):
    settings = Settings(data_dir=tmp_path, database_path=tmp_path / 'qor.sqlite3', ai_provider='disabled',
        engine_module='app.engine.service', importer_module='app.importers.service', admin_token='test-admin')
    app = create_app(settings)
    req = request_for(workbooks)
    with TestClient(app) as client:
        token = client.post('/api/sessions').json()['token']
        headers = {'Authorization': f'Bearer {token}'}
        response = client.post('/api/imports', headers={**headers, 'X-Admin-Token': 'test-admin'},
            data={'supplier': req.supplier_id, 'mapping_version': MAPPING_VERSION,
                  'as_of': AS_OF.isoformat(), 'warehouse_id': req.warehouse_id},
            files=[('files', (f.original_name, f.path.read_bytes(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) for f in req.files])
        assert response.status_code == 202, response.text
        iid = response.json()['import_id']
        for _ in range(200):
            status = client.get(f'/api/imports/{iid}', headers=headers).json()
            if status['status'] in ('completed', 'failed'):
                break
            time.sleep(0.02)
        assert status['status'] == 'completed', status
        did = status['dataset_id']
        response = client.post('/api/runs', headers=headers,
            json={'dataset_id': did, 'supplier_id': req.supplier_id, 'as_of': AS_OF.isoformat()})
        assert response.status_code == 201, response.text
        assert response.json()['algorithm_version'] == 'qor-mvp-1.0'
        rid = response.json()['run_id']
        baseline = client.get(f'/api/runs/{rid}/products/00001', headers=headers).json()
        assert baseline['recommended_qty'] == 156
        sid = next(s['id'] for s in client.get(f'/api/datasets/{did}/shipments', headers=headers).json()['items'] if s['sku'] == '00001')
        changed = client.post(f'/api/runs/{rid}/scenario', headers=headers, json={'shipment_id': sid, 'delay_days': 30})
        assert changed.status_code == 201, changed.text
        changed_id = changed.json()['run_id']
        assert client.get(f'/api/runs/{changed_id}/products/00001', headers=headers).json()['recommended_qty'] == 204
        explained = client.post(f'/api/runs/{rid}/explain', headers=headers, json={'sku': '00001'}).json()
        assert explained['status'] == 'fallback' and '156' in explained['text']
        order = client.post('/api/orders', headers=headers,
            json={'run_id': rid, 'supplier_id': req.supplier_id, 'skus': ['00001']}).json()
        edited = client.patch(f'/api/orders/{order["draft_id"]}', headers=headers,
            json={'version': order['version'], 'changes': [{'sku': '00001', 'approved_qty': 168, 'reason': 'Проверка API'}]}).json()
        approved = client.post(f'/api/orders/{order["draft_id"]}/approve', headers=headers,
            json={'version': edited['version'], 'acknowledge_warnings': True})
        assert approved.status_code == 200, approved.text
        exported = client.get(f'/api/orders/{order["draft_id"]}/export.csv', headers=headers)
        rows = list(csv.DictReader(io.StringIO(exported.content.decode('utf-8-sig')), delimiter=';'))
        assert rows[0]['quantity'] == '168.0' and rows[0]['sku_1c'] == '00001'
    with TestClient(create_app(settings)) as client:
        assert client.get(f'/api/runs/{rid}/products/00001', headers=headers).json()['recommended_qty'] == 156


def test_public_synthetic_bootstrap_runs_plugin_not_platform_fixture(tmp_path, dataset):
    settings = Settings(data_dir=tmp_path, database_path=tmp_path / 'qor.sqlite3', ai_provider='disabled',
                        engine_module='app.engine.service')
    with TestClient(create_app(settings)) as client:
        headers = {'Authorization': 'Bearer ' + client.post('/api/sessions').json()['token']}
        response = client.post('/api/runs', headers=headers,
            json={'dataset_id': DEMO_DATASET_ID, 'supplier_id': 'systeme_electric', 'as_of': AS_OF.isoformat()})
        assert response.status_code == 201, response.text
        assert response.json()['data_mode'] == 'synthetic'
        assert response.json()['algorithm_version'] == 'qor-mvp-1.0'
