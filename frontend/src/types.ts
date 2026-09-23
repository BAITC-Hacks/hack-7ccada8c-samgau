export type DataMode = 'demo' | 'api';
export type Supplier = 'all' | 'iek' | 'systeme';
export type Risk = 'critical' | 'warning' | 'healthy';
export type DataStatus = 'observed' | 'estimated' | 'missing';
export interface Recommendation {
  sku: string;
  supplier_id: Exclude<Supplier, 'all'>;
  supplier_article: string;
  name: string;
  category: string;
  unit: string;
  available_stock: number | null;
  eligible_incoming: number;
  forecast_qty: number;
  safety_stock: number;
  raw_need: number;
  recommended_qty: number;
  risk_status: Risk;
  stockout_date: string | null;
  data_status: DataStatus;
  factors: { label: string; value: string }[];
  warnings: string[];
  anomaly_count: number;
  coverage_days: number | null;
}
export interface Dataset {
  id: string;
  name: string;
  mode: 'real' | 'synthetic';
  as_of: string;
  warehouse: string;
}
export interface Summary {
  order_skus: number;
  risk_skus: number;
  anomaly_count: number;
  review_skus: number;
  total_skus: number;
}
export interface Run {
  run_id: string;
  summary: Summary;
}
export interface Recommendations {
  items: Recommendation[];
  total: number;
  summary: Summary;
}
export interface HistoryPoint {
  month: string;
  actual: number;
  regular: number;
  restored: number;
}
export interface StockPoint {
  date: string;
  baseline: number;
  scenario: number;
  with_order: number;
  incoming: number;
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
  needs_clarification: boolean;
  message?: string;
}
export interface Explanation {
  text: string;
  factor_ids: string[];
  provider: string;
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
  source_count: number;
  mapped_skus: number;
  issues: QualityIssue[];
}
export interface Draft {
  draft_id: string;
  version: number;
  status: 'draft' | 'approved';
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
  parseScenario: (text: string, supplier: Supplier) => Promise<ParsedScenario>;
  explain: (run: string, sku: string) => Promise<Explanation>;
  createDraft: (run: string, supplier: string, lines: DraftLine[]) => Promise<Draft>;
  approve: (id: string, version: number) => Promise<Draft>;
  exportDraft: (id: string) => Promise<Blob>;
}
