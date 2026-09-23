from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.integration import EngineUnavailable
from app.main import create_app


@pytest.mark.parametrize("value", [None, ""])
def test_default_startup_enables_bundled_modules(monkeypatch, tmp_path, value):
    for name in ("ENGINE_MODULE", "IMPORTER_MODULE"):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    settings = Settings(data_dir=tmp_path, database_path=None, ai_provider="disabled")
    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health").json()
        assert health["engine_configured"] and health["importer_configured"]
        headers = {"Authorization": "Bearer " + client.post("/api/sessions").json()["token"]}
        datasets = client.get("/api/datasets", headers=headers).json()["items"]
        assert datasets[0]["id"] == "demo-engine-v1"
        assert datasets[0]["engine_backend"] == "plugin"
        assert set(datasets[0]["supplier_ids"]) == {"iek", "systeme_electric"}
        run = client.post("/api/runs", headers=headers, json={
            "dataset_id": datasets[0]["id"], "supplier_id": "systeme_electric",
            "as_of": datasets[0]["as_of"],
        })
        assert run.status_code == 201
        assert run.json()["algorithm_version"] == "qor-mvp-1.0"
        detail = client.get(f'/api/runs/{run.json()["run_id"]}', headers=headers)
        assert detail.status_code == 200
        assert detail.json()["parameters"]["supplier_id"] == "systeme_electric"
    with TestClient(create_app(settings)) as client:
        # Startup is idempotent and preserves the existing session/run.
        datasets = client.get("/api/datasets", headers=headers).json()["items"]
        assert len([d for d in datasets if d["id"] == "demo-engine-v1"]) == 1
        assert client.get(f'/api/runs/{run.json()["run_id"]}', headers=headers).json() == detail.json()


@pytest.mark.parametrize("module", ["app.missing_engine", "app.config"])
def test_misconfigured_engine_fails_at_startup(tmp_path, module):
    settings = Settings(data_dir=tmp_path, database_path=None, engine_module=module)
    with pytest.raises(EngineUnavailable, match="Cannot load"):
        with TestClient(create_app(settings)):
            pytest.fail("Invalid plugin must not serve a healthy API")


def test_upload_directory_failure_does_not_lock_all_future_imports(monkeypatch, tmp_path):
    settings = Settings(data_dir=tmp_path, database_path=None)
    app = create_app(settings)
    with TestClient(app, raise_server_exceptions=False) as client:
        headers = {"Authorization": "Bearer " + client.post("/api/sessions").json()["token"]}
        original = Path.mkdir
        failed = False

        def fail_once(path, *args, **kwargs):
            nonlocal failed
            if path.parent == tmp_path / "uploads" and not failed:
                failed = True
                raise OSError("Temporary disk error")
            return original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "mkdir", fail_once)
        payload = {"supplier": "iek", "mapping_version": "qor-explicit-xlsx-v1",
                   "as_of": "2026-09-22", "warehouse_id": "synthetic-almaty"}
        # Invalid file type finishes synchronously: only the first failure is disk-related.
        for expected in (500, 422, 422):
            response = client.post("/api/imports", headers=headers, data=payload,
                                   files=[("files", ("unsupported.txt", b"test"))])
            assert response.status_code == expected, response.text


def test_browser_cors_and_documented_error_contract(tmp_path):
    settings = Settings(data_dir=tmp_path, database_path=None, ai_provider="disabled")
    with TestClient(create_app(settings)) as client:
        response = client.options("/api/orders/example", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
        schema = client.get("/api/openapi.json").json()
        paths = schema["paths"]
        assert paths["/api/runs"]["post"]["responses"]["422"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")
        assert paths["/api/imports/{import_id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/ImportResponse")
        assert "text/csv" in paths["/api/orders/{draft_id}/export.csv"]["get"]["responses"]["200"]["content"]
