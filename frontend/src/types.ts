export type DataMode = 'demo' | 'api';
export type Supplier = string;
export type Risk = 'critical' | 'warning' | 'healthy' | 'unknown';
export type DataStatus = 'observed' | 'estimated' | 'missing' | 'ready' | 'review' | 'blocked';
export interface Recommendation {
  key?: string;
  run_id?: string;
  stock_unit?: string;
  stock_units_per_order_unit?: number | null;
  approval_blockers?: string[];
  moq?: number;
  order_step?: number;
  sku: string;
  supplier_id: Exclude<Supplier, 'all'>;
  supplier_article: string;
  name: string;
  category: string;
  unit: string;
  available_stock: number | null;
  eligible_incoming: number | null;
  forecast_qty: number | null;
  safety_stock: number | null;
  raw_need: number | null;
  recommended_qty: number | null;
  risk_status: Risk;
  stockout_date: string | null;
  data_status: DataStatus;
  factors: {
    id?: string;
    label: string;
    value: string;
    raw_value?: number | string | null;
    unit?: string | null;
    status?: string;
    source?: { file: string; sheet?: string; row?: number; field?: string } | null;
  }[];
  warnings: string[];
  anomaly_count: number | null;
  coverage_days: number | null;
}
export interface Dataset {
  id: string;
  name: string;
  mode: 'real' | 'synthetic';
  as_of: string;
  warehouse: string;
  supplier_ids?: string[];
  engine_backend?: string;
}
export interface Summary {
  order_skus: number;
  risk_skus: number;
  anomaly_count: number | null;
  review_skus: number;
  total_skus: number;
}
export interface Run {
  run_id: string;
  summary: Summary;
  supplier_runs?: Record<string, string>;
}
export interface Recommendations {
  items: Recommendation[];
  total: number;
  summary: Summary;
}
export interface HistoryPoint {
  month: string;
  complete?: boolean;
  stockout_days?: number | null;
  source?: unknown;
  actual: number | null;
  regular: number | null;
  restored: number | null;
}
export interface StockPoint {
  date: string;
  baseline: number | null;
  scenario: number | null;
  with_order: number | null;
  incoming: number | null;
}
export interface ProductDetail {
  sku: string;
  history: HistoryPoint[];
  projection: StockPoint[];
  method: string;
}
export interface Scenario {
  delay_days: number;
  demand_change_pct: number;
  supplier_id: Supplier;
  shipment_id?: string;
}
export interface ParsedScenario {
  parameters: Scenario;
  status?: string;
  requires_confirmation?: boolean;
  needs_clarification: boolean;
  message?: string;
}
export interface Explanation {
  text: string;
  factor_ids: string[];
  provider: string | null;
  mode: 'generated' | 'fallback';
}
export interface QualityIssue {
  id: string;
  title: string;
  detail: string;
  severity: 'warning' | 'info';
  count: number;
}
export interface Quality {
  source_count: number | null;
  mapped_skus: number | null;
  issues: QualityIssue[];
}
export interface Draft {
  draft_id: string;
  version: number;
  status: 'draft' | 'approved';
  data_mode?: 'real' | 'synthetic' | null;
  run_id?: string;
  supplier_id?: string;
  lines?: { recommendation: Recommendation; approved_qty: number | null; reason: string }[];
}
export interface DraftLine {
  sku: string;
  quantity: number;
  reason: string;
}
export interface Gateway {
  datasets: () => Promise<Dataset[]>;
  createRun: (dataset: string, supplier: Supplier, date: string) => Promise<Run>;
  recommendations: (run: string) => Promise<Recommendations>;
  detail: (run: string, sku: string) => Promise<ProductDetail>;
  quality: (dataset: string) => Promise<Quality>;
  scenario: (run: string, values: Scenario) => Promise<Run>;
  parseScenario: (
    text: string,
    supplier: Supplier,
    run: string,
    shipment?: string,
  ) => Promise<ParsedScenario>;
  explain: (run: string, sku: string) => Promise<Explanation>;
  createDraft: (run: string, supplier: string, lines: DraftLine[]) => Promise<Draft>;
  approve: (id: string, version: number, acknowledge?: boolean) => Promise<Draft>;
  getDraft?: (id: string) => Promise<Draft>;
  listDrafts?: () => Promise<Draft[]>;
  patchDraft?: (id: string, version: number, lines: DraftLine[]) => Promise<Draft>;
  shipments?: (run: string) => Promise<Shipment[]>;
  exportDraft: (id: string) => Promise<Blob>;
}

export interface Shipment {
  id: string;
  sku: string;
  supplier_id: string;
  quantity: number;
  eta: string;
}
export const rowKey = (r: Recommendation | undefined) => r?.key || r?.sku || '';
export const validForOrder = (r: Recommendation) =>
  !['missing', 'blocked'].includes(r.data_status) &&
  !r.approval_blockers?.length &&
  [
    r.available_stock,
    r.eligible_incoming,
    r.forecast_qty,
    r.safety_stock,
    r.raw_need,
    r.recommended_qty,
  ].every((v) => v !== null && Number.isFinite(v)) &&
  (r.recommended_qty ?? 0) > 0 &&
  (!r.run_id || (r.stock_units_per_order_unit != null && r.stock_units_per_order_unit > 0));
