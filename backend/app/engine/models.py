"""Local engine contract; the API owner may map these objects to shared schemas."""
from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Nonnegative = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]
Positive = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]
Identifier = Annotated[str, Field(strict=True, min_length=1)]
ValueStatus = Literal['observed', 'estimated', 'assumed', 'missing']


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True, allow_inf_nan=False)


class Source(Model):
    origin: str
    status: ValueStatus = 'observed'


class Sale(Model):
    date: date
    document_id: Identifier
    quantity: Number
    customer_id_hash: Identifier | None = None
    source: str = 'normalized_sales'


class MonthlySale(Model):
    month: date
    quantity: Nonnegative | None
    source: str = 'monthly_sales'

    @model_validator(mode='after')
    def first_day(self):
        if self.month.day != 1:
            raise ValueError('month must be the first day of a calendar month')
        return self


class Stockout(Model):
    start: date
    end: date
    source: Source

    @model_validator(mode='after')
    def ordered(self):
        if self.end < self.start:
            raise ValueError('stockout end precedes start')
        if self.source.status not in ('observed', 'assumed'):
            raise ValueError('stockout intervals must be confirmed or explicitly assumed')
        return self


class Inventory(Model):
    as_of: date
    available: Number | None = None
    on_hand: Number | None = None
    reserved: Nonnegative | None = None
    source: Source
    manually_confirmed: bool = False


class Shipment(Model):
    shipment_id: Identifier
    quantity: Nonnegative
    unit: Identifier
    eta: date
    confirmed: bool = True
    source: Source


class SupplierPolicy(Model):
    lead_time_days: int = Field(ge=1, le=365)
    review_days: int = Field(ge=0, le=365)
    source: Source


class CategoryPolicy(Model):
    safety_days: int = Field(ge=0, le=365)
    review_days: int | None = Field(default=None, ge=0, le=365)
    manual_review: bool = False
    source: Source


class Seasonality(Model):
    coefficients: tuple[Positive, ...] = Field(min_length=12, max_length=12)
    source: Source


class ProductInput(Model):
    supplier_id: Identifier
    sku: Identifier
    warehouse_id: Identifier
    name: str = ''
    supplier_article: str | None = None
    stock_unit: Identifier
    order_unit: Identifier
    stock_units_per_order_unit: Positive | None = None
    units_source: Source | None = None
    moq: Nonnegative | None = None
    order_multiple: Positive | None = None
    order_rules_source: Source | None = None
    category_code: str | None = None
    category_policy: CategoryPolicy | None = None
    policy: SupplierPolicy
    sales: tuple[Sale, ...] = ()
    # Only explicitly complete detail months may replace monthly totals.
    detail_months: tuple[date, ...] = ()
    monthly_sales: tuple[MonthlySale, ...] = ()
    stockouts: tuple[Stockout, ...] = ()
    inventory: Inventory | None = None
    incoming: tuple[Shipment, ...] = ()
    incoming_complete: bool = False
    seasonality: Seasonality | None = None
    confirmed_growth_pct: Number | None = Field(default=None, ge=-100)
    growth_source: Source | None = None
    warnings: tuple[str, ...] = ()

    @model_validator(mode='after')
    def consistent(self):
        if any(d.day != 1 for d in self.detail_months):
            raise ValueError('detail_months must use first days')
        months = [m.month for m in self.monthly_sales]
        if len(months) != len(set(months)):
            raise ValueError('duplicate monthly total; reconcile sources before calculation')
        ids = [s.shipment_id for s in self.incoming]
        if len(ids) != len(set(ids)):
            raise ValueError('duplicate shipment_id')
        if self.confirmed_growth_pct is not None and self.growth_source is None:
            raise ValueError('confirmed growth requires its source and semantics')
        return self


class Scenario(Model):
    demand_change_pct: Number = Field(default=0, ge=-100, le=1000)
    shipment_delays: dict[str, int] = Field(default_factory=dict)
    # Keys are document IDs for this SKU and warehouse.
    order_classification: dict[str, Literal['regular', 'one_off']] = Field(default_factory=dict)

    @model_validator(mode='after')
    def valid_delays(self):
        if any(type(v) is not int or not 0 <= v <= 365 for v in self.shipment_delays.values()):
            raise ValueError('shipment delay must be an integer in 0..365')
        return self


class Factor(Model):
    id: str
    value: Number | str | None
    unit: str
    source: Source


class HistoryPoint(Model):
    month: date
    raw_sales: Number | None
    regular_sales: Number | None
    restored_demand: Number | None
    stockout_days: int = 0
    complete: bool
    source: str


class OrderAdjustment(Model):
    date: date
    document_id: str
    customer_id_hash: str | None
    raw_quantity: Number
    regular_quantity: Number
    excluded_quantity: Number
    reasons: tuple[str, ...]
    source_refs: tuple[str, ...] = ()


class TrajectoryPoint(Model):
    date: date
    demand: Nonnegative
    incoming: Nonnegative
    stock_without_order: Number
    stock_with_order: Number | None


class Recommendation(Model):
    algorithm_version: str
    as_of: date
    supplier_id: str
    sku: str
    warehouse_id: str
    unit: str
    stock_unit: str
    available_stock: Number | None
    eligible_incoming: Nonnegative | None
    forecast_qty: Nonnegative | None
    safety_stock: Nonnegative | None
    raw_need: Nonnegative | None
    recommended_qty: Nonnegative | None
    recommended_stock_qty: Nonnegative | None
    risk_status: Literal['ok', 'reorder', 'stockout', 'expedite', 'unknown']
    stockout_date: date | None
    data_status: Literal['complete', 'preliminary', 'insufficient']
    factors: tuple[Factor, ...]
    warnings: tuple[str, ...]
    approval_blockers: tuple[str, ...]
    history: tuple[HistoryPoint, ...]
    adjustments: tuple[OrderAdjustment, ...]
    trajectory: tuple[TrajectoryPoint, ...]
    explanation: str
