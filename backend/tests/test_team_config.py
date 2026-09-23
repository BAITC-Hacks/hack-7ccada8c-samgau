"""Regression checks for configuration shared by the team and captain API."""
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    for name in (
        "AI_PROVIDER", "AI_BASE_URL", "AI_API_KEY", "AI_MODEL",
        "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
        "NVIDIA_API_KEY", "NVIDIA_MODEL", "NVIDIA_BASE_URL", "DATABASE_PATH",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("provider", ["openai", "nvidia"])
def test_existing_team_ai_settings_work(monkeypatch, provider):
    monkeypatch.setenv("AI_PROVIDER", provider)
    monkeypatch.setenv(f"{provider.upper()}_API_KEY", "test-provider-key")
    monkeypatch.setenv(f"{provider.upper()}_MODEL", "team-model")
    if provider == "nvidia":
        monkeypatch.setenv("NVIDIA_BASE_URL", "https://provider.example/v1")
    # Blank common settings from .env.example must not mask team settings.
    for name in ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL"):
        monkeypatch.setenv(name, "")
    settings = Settings()
    settings.validate()
    assert settings.ai_key == "test-provider-key"
    assert settings.ai_model == "team-model"
    assert settings.ai_base_url == (
        "https://provider.example/v1" if provider == "nvidia"
        else "https://api.openai.com/v1"
    )


def test_common_ai_settings_take_precedence(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "nvidia")
    monkeypatch.setenv("NVIDIA_API_KEY", "provider-key")
    monkeypatch.setenv("NVIDIA_MODEL", "provider-model")
    monkeypatch.setenv("NVIDIA_BASE_URL", "https://provider.example/v1")
    monkeypatch.setenv("AI_API_KEY", "common-key")
    monkeypatch.setenv("AI_MODEL", "common-model")
    monkeypatch.setenv("AI_BASE_URL", "https://common.example/v1")
    settings = Settings()
    settings.validate()
    assert (settings.ai_key, settings.ai_model, settings.ai_base_url) == (
        "common-key", "common-model", "https://common.example/v1"
    )


def test_nvidia_requires_its_own_endpoint(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "nvidia")
    with pytest.raises(ValueError, match="HTTPS"):
        Settings().validate()


def test_team_database_path_persists_sessions(monkeypatch, tmp_path):
    database = tmp_path / "database" / "team.sqlite3"
    monkeypatch.setenv("DATABASE_PATH", str(database))
    settings = Settings(data_dir=tmp_path / "uploads", ai_provider="disabled")
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/sessions")
        assert response.status_code == 201
        token = response.json()["token"]
    assert database.exists()
    assert not (settings.data_dir / "qor.sqlite3").exists()
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/datasets", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
