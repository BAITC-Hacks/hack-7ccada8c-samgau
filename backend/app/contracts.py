"""Shared contract v1.0. Engine/importers must not import FastAPI or storage.

Quantities are in stock units except recommended_qty, MOQ and order_step.
Those three fields use order units. factor = stock units per order unit.
"""
from datetime import date
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = "1.0"


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class SourceRef(Model):
    file: str
    sheet: str | None = None
    row: int | None = Field(default=None, ge=1)
    field: str | None = None


class Factor(Model):
    id: str
    label: str
    value: float | str | None
    unit: str | None = None
    status: Literal["observed", "estimated", "assumed", "missing"]
    source: SourceRef | None = None


class Shipment(Model):
    id: str
    sku: str
    supplier_id: str
    quantity: float = Field(ge=0)
    eta: date


class DatasetPayload(Model):
    name: str
    mode: Literal["real", "synthetic"]
    as_of: date
    warehouse_id: str
    supplier_ids: list[str] = Field(min_length=1)
    version: str
    quality: dict[str, Any] = Field(default_factory=dict)
    shipments: list[Shipment] = Field(default_factory=list)
    # JSON only. Participant 2 owns its internal schema and persistence compatibility.
    data: dict[str, Any]

    @model_validator(mode="after")
    def unique_shipments(self):
        ids = [s.id for s in self.shipments]
        if len(ids) != len(set(ids)):
            raise ValueError("Shipment IDs must be unique across the dataset")
        if any(s.supplier_id not in self.supplier_ids for s in self.shipments):
            raise ValueError("Unknown supplier in shipments")
        return self


class Scenario(Model):
    shipment_id: str | None = None
    delay_days: int = Field(default=0, ge=0, le=365)
    demand_change_pct: float = Field(default=0, ge=-90, le=300)

    @model_validator(mode="after")
    def delay_has_target(self):
        if self.delay_days and not self.shipment_id:
            raise ValueError("shipment_id is required for a delay")
        return self


class CalculationParameters(Model):
    supplier_id: str
    as_of: date
    lead_time_days: int = Field(default=14, ge=1, le=365)
    review_days: int = Field(default=7, ge=1, le=90)
    safety_days: int = Field(default=7, ge=0, le=90)
    scenario: Scenario = Field(default_factory=Scenario)


class Recommendation(Model):
    sku: str
    supplier_id: str
    supplier_article: str
    name: str
    warehouse_id: str
    unit: str
    stock_unit: str
    stock_units_per_order_unit: float | None = Field(default=None, gt=0)
    available_stock: float | None = None
    eligible_incoming: float | None = Field(default=None, ge=0)
    forecast_qty: float | None = Field(default=None, ge=0)
    safety_stock: float | None = Field(default=None, ge=0)
    raw_need: float | None = Field(default=None, ge=0)
    recommended_qty: float | None = Field(default=None, ge=0)
    moq: float = Field(default=0, ge=0)
    order_step: float = Field(default=1, gt=0)
    risk_status: Literal["ok", "warning", "critical", "unknown"]
    stockout_date: date | None = None
    data_status: Literal["ready", "review", "blocked"]
    approval_blockers: list[str] = Field(default_factory=list)
    factors: list[Factor] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    explanation: str
    history: list[dict[str, Any]] = Field(default_factory=list)
    trajectory: list[dict[str, Any]] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_factors(self):
        ids = [f.id for f in self.factors]
        if len(ids) != len(set(ids)):
            raise ValueError("Factor IDs must be unique within a recommendation")
        return self


class EngineResult(Model):
    algorithm_version: str
    recommendations: list[Recommendation]
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_products(self):
        keys = [(r.supplier_id, r.sku, r.warehouse_id) for r in self.recommendations]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate product keys in engine result")
        return self


class ImportFile(Model):
    path: Path
    original_name: str
    sha256: str


class ImportRequest(Model):
    files: list[ImportFile]
    supplier_id: str
    mapping_version: str
    as_of: date
    warehouse_id: str


class CalculationEngine(Protocol):
    def calculate(self, dataset: DatasetPayload, params: CalculationParameters) -> EngineResult: ...


class DatasetImporter(Protocol):
    def import_dataset(self, request: ImportRequest) -> DatasetPayload: ...
