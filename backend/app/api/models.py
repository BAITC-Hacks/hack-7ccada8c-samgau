from datetime import date
from typing import Literal
from pydantic import Field
from typing import Any
from ..contracts import CalculationParameters, Model, Recommendation, Scenario, Shipment


class RunRequest(CalculationParameters):
    dataset_id: str


class ParseRequest(Model):
    run_id: str
    text: str = Field(min_length=1, max_length=1500)
    selected_shipment_id: str | None = None


class ExplainRequest(Model):
    sku: str
    language: Literal["ru", "kk"] = "ru"


class CreateOrder(Model):
    run_id: str
    supplier_id: str
    skus: list[str] = Field(min_length=1, max_length=1000)


class LineEdit(Model):
    sku: str
    approved_qty: float = Field(ge=0)
    reason: str = Field(min_length=3, max_length=500)


class PatchOrder(Model):
    version: int = Field(ge=1)
    changes: list[LineEdit] = Field(min_length=1, max_length=1000)


class ApproveOrder(Model):
    version: int = Field(ge=1)
    acknowledge_warnings: bool = False


class HealthResponse(Model):
    status: str
    version: str
    contract_version: str
    engine_configured: bool
    importer_configured: bool
    ai_configured: bool


class SessionResponse(Model):
    token: str
    token_type: str
    session_id: str
    expires_at: str


class DatasetMeta(Model):
    id: str
    name: str
    mode: Literal["real", "synthetic"]
    as_of: date
    warehouse_id: str
    supplier_ids: list[str]
    version: str
    engine_backend: Literal["fixture", "plugin"]


class DatasetList(Model):
    items: list[DatasetMeta]


class ShipmentList(Model):
    items: list[Shipment]


class ImportSource(Model):
    name: str
    sha256: str


class ImportResponse(Model):
    import_id: str
    status: Literal["queued", "running", "completed", "failed", "interrupted"]
    progress: int = Field(default=0, ge=0, le=100)
    fingerprint: str | None = None
    created_at: str | None = None
    dataset_id: str | None = None
    error: str | None = None
    files: list[ImportSource] = Field(default_factory=list)
    deduplicated: bool = False


class RunSummary(Model):
    products: int
    to_order: int
    critical: int
    needs_review: int


class RunResponse(Model):
    run_id: str
    summary: RunSummary
    data_mode: Literal["real", "synthetic"]
    algorithm_version: str
    warnings: list[str]


class RunDetail(RunResponse):
    dataset_id: str
    dataset_version: str
    parameters: CalculationParameters
    parent_run_id: str | None
    created_at: str


class ScenarioComparison(Model):
    sku: str
    before_qty: float | None
    after_qty: float | None
    before_stockout_date: date | None
    after_stockout_date: date | None


class ScenarioResponse(RunResponse):
    comparison: list[ScenarioComparison]


class RecommendationPage(Model):
    items: list[Recommendation]
    total: int
    page: int
    page_size: int
    summary: RunSummary


class ApiProblem(Model):
    code: str
    message: str
    fields: list[Any] = Field(default_factory=list)


class ErrorResponse(Model):
    error: ApiProblem


class OrderLine(Model):
    recommendation: Recommendation
    approved_qty: float | None
    reason: str
    edited_by: str | None


class OrderResponse(Model):
    draft_id: str
    version: int
    run_id: str
    supplier_id: str
    data_mode: Literal['real', 'synthetic'] | None = None
    status: Literal["draft", "approved"]
    as_of: date
    created_at: str
    approved_at: str | None
    approved_by: str | None = None
    lines: list[OrderLine]
    audit: list[dict[str, Any]]


class OrderList(Model):
    items: list[OrderResponse]


class ParseResponse(Model):
    status: Literal["generated", "fallback"]
    provider: str | None
    scenario: Scenario | None
    needs_clarification: bool
    question: str | None
    requires_confirmation: bool = False


class ExplainResponse(Model):
    text: str
    factor_ids: list[str]
    provider: str | None
    status: Literal["generated", "fallback"]
    language: str
    requested_language: str | None = None
    rendering: str = "verified_template"
    message: str
    cached: bool = False
