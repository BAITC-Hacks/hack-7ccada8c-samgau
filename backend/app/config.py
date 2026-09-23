import os
from dataclasses import dataclass, field
from pathlib import Path


def provider_setting(name: str, default: str = "") -> str:
    """Accept both captain AI_* and existing team provider-specific settings."""
    provider = os.getenv("AI_PROVIDER", "disabled").upper()
    return os.getenv(f"AI_{name}") or os.getenv(f"{provider}_{name}") or default


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("QOR_DATA_DIR", "./data")).resolve())
    database_path: Path | None = field(default_factory=lambda: Path(os.environ["DATABASE_PATH"]).resolve() if os.getenv("DATABASE_PATH") else None)
    app_env: str = field(default_factory=lambda: os.getenv("APP_ENV", "development"))
    admin_token: str = field(default_factory=lambda: os.getenv("ADMIN_TOKEN", ""))
    import_access: str = field(default_factory=lambda: os.getenv("IMPORT_ACCESS", "admin"))
    engine_module: str = field(default_factory=lambda: os.getenv("ENGINE_MODULE") or "app.engine.service")
    importer_module: str = field(default_factory=lambda: os.getenv("IMPORTER_MODULE") or "app.importers.service")
    cors_origins: list[str] = field(default_factory=lambda: [x.strip() for x in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if x.strip()])
    ai_provider: str = field(default_factory=lambda: os.getenv("AI_PROVIDER", "disabled"))
    ai_base_url: str = field(default_factory=lambda: provider_setting("BASE_URL", "https://api.openai.com/v1" if os.getenv("AI_PROVIDER", "disabled") != "nvidia" else ""))
    ai_key: str = field(default_factory=lambda: provider_setting("API_KEY"))
    ai_model: str = field(default_factory=lambda: provider_setting("MODEL"))
    ai_format: str = field(default_factory=lambda: os.getenv("AI_RESPONSE_FORMAT", "json_schema"))
    ai_timeout_seconds: float = field(default_factory=lambda: float(os.getenv("AI_TIMEOUT_SECONDS", "35")))
    allow_real_ai: bool = field(default_factory=lambda: os.getenv("ALLOW_REAL_AI", "false").lower() == "true")
    session_hours: int = 24 * 7
    max_upload_bytes: int = 64 * 1024 * 1024

    def validate(self):
        if self.import_access not in ("session", "admin"):
            raise ValueError("IMPORT_ACCESS must be session or admin")
        if self.ai_provider not in ("disabled", "openai", "nvidia"):
            raise ValueError("AI_PROVIDER must be disabled, openai or nvidia")
        if self.ai_format not in ("json_schema", "json_object"):
            raise ValueError("Unsupported AI_RESPONSE_FORMAT")
        if not 5 <= self.ai_timeout_seconds <= 90:
            raise ValueError("AI_TIMEOUT_SECONDS must be between 5 and 90")
        if self.ai_provider != "disabled" and not self.ai_base_url.startswith("https://"):
            raise ValueError("AI_BASE_URL must use HTTPS")
