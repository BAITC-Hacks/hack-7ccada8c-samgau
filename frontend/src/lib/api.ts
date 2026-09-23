import { dataMessage } from './dataMessages';
import type {
  Dataset,
  Draft,
  Explanation,
  Gateway,
  ProductDetail,
  Quality,
  Recommendation,
  Run,
  Supplier,
  Summary,
} from '../types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
const TOKEN_KEY = 'qor-api-session-v1';
let sessionPromise: Promise<string> | null = null;
export function resetSession() {
  sessionPromise = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage may be unavailable */
  }
}
export function session(): Promise<string> {
  if (!sessionPromise) {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      /* memory-only session */
    }
    sessionPromise = saved
      ? Promise.resolve(saved)
      : request<{ token: string }>('/sessions', { method: 'POST' })
          .then((r) => {
            if (!r.token) throw new ApiError('Сервер не создал сессию.');
            try {
              sessionStorage.setItem(TOKEN_KEY, r.token);
            } catch {
              /* memory-only session */
            }
            return r.token;
          })
          .catch((e) => {
            sessionPromise = null;
            throw e;
          });
  }
  return sessionPromise;
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const headers = new Headers(options.headers);
    if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (path !== '/sessions' && !headers.has('Authorization'))
      headers.set('Authorization', `Bearer ${await session()}`);
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api${path}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `Сервер вернул ошибку ${res.status}. Повторите попытку.`;
      try {
        const body = await res.json();
        message =
          body.message ||
          body.error?.message ||
          (typeof body.detail === 'string' ? body.detail : message);
      } catch {
        /* safe HTTP fallback */
      }
      if (res.status === 401) {
        resetSession();
        message =
          'Сессия истекла. Обновите страницу. Для доступа к прежним данным нужна исходная действующая сессия.';
      }
      throw new ApiError(message, res.status);
    }
    if (path.endsWith('/export.csv')) return (await res.blob()) as T;
    if (!res.headers.get('content-type')?.includes('application/json'))
      throw new ApiError('API вернул неожиданный формат. Проверьте подключение /api.');
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError')
      throw new ApiError(
        'Операция заняла больше двух минут. Проверьте состояние на сервере перед повтором.',
      );
    throw new ApiError('Не удалось связаться с API. Проверьте, запущен ли сервер.');
  } finally {
    clearTimeout(timer);
  }
}
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const uiSupplier = (id: string): Exclude<Supplier, 'all'> =>
  id.toLowerCase() === 'iek' ? 'iek' : 'systeme';
type ServerRow = Omit<Recommendation, 'risk_status' | 'data_status' | 'factors' | 'supplier_id'> & {
  supplier_id: string;
  risk_status: 'ok' | 'critical' | 'warning' | 'unknown';
  data_status: 'ready' | 'review' | 'blocked';
  factors: { id: string; label: string; value: string | number | null; unit?: string }[];
  explanation: string;
  history: ProductDetail['history'];
  trajectory: {
    date: string;
    without_order: number | null;
    with_order: number | null;
    incoming: number;
  }[];
};
type ServerRun = {
  run_id: string;
  summary: { products: number; to_order: number; critical: number; needs_review: number };
};
type RunPart = { id: string; supplier: string; dataset: string; base?: string };
const groups = new Map<string, RunPart[]>();
const identities = new Map<string, { sku: string; supplier: string }>();
const datasetCache = new Map<string, Dataset>();
const zero = (): Summary => ({
  order_skus: 0,
  risk_skus: 0,
  review_skus: 0,
  total_skus: 0,
  anomaly_count: 0,
});
function combine(parts: RunPart[], runs: ServerRun[]): Run {
  const id = `view-${crypto.randomUUID()}`;
  groups.set(id, parts);
  return {
    run_id: id,
    summary: runs.reduce(
      (s, r) => ({
        ...s,
        order_skus: s.order_skus + r.summary.to_order,
        risk_skus: s.risk_skus + r.summary.critical,
        review_skus: s.review_skus + r.summary.needs_review,
        total_skus: s.total_skus + r.summary.products,
      }),
      zero(),
    ),
  };
}
function parts(run: string): RunPart[] {
  const value = groups.get(run);
  if (!value) throw new ApiError('Расчёт устарел. Выполните расчёт заново.');
  return value;
}
function product(run: string, key: string) {
  const identity = identities.get(key);
  const part = parts(run).find((p) => p.supplier === identity?.supplier);
  if (!part || !identity) throw new ApiError('Товар отсутствует в расчёте.');
  return { ...part, sku: identity.sku };
}
export function mapRow(r: ServerRow): Recommendation {
  const key = `${r.supplier_id}/${r.sku}`;
  identities.set(key, { sku: r.sku, supplier: r.supplier_id });
  return {
    ...r,
    sku: key,
    sku_1c: r.sku,
    supplier_id: uiSupplier(r.supplier_id),
    category: r.category || 'Товар',
    risk_status:
      r.risk_status === 'ok' ? 'healthy' : r.risk_status === 'unknown' ? 'warning' : r.risk_status,
    data_status:
      r.data_status === 'blocked'
        ? 'missing'
        : r.data_status === 'review'
          ? 'estimated'
          : 'observed',
    factors: r.factors.map((f) => ({
      label: f.label,
      value: f.value === null ? 'Нет данных' : `${f.value} ${f.unit || ''}`.trim(),
    })),
    warnings: [
      ...r.warnings.map(dataMessage),
      ...(r.approval_blockers || []).map((b) => `Заказ заблокирован: ${dataMessage(b)}`),
    ],
    anomaly_count: r.factors.some(
      (f) => f.id === 'excluded_one_off_qty' && typeof f.value === 'number' && f.value > 0,
    )
      ? 1
      : 0,
    coverage_days: null,
  };
}
async function allRows(id: string) {
  const rows: ServerRow[] = [];
  for (let page = 1; page <= 200; page++) {
    const result = await request<{ items: ServerRow[]; total: number }>(
      `/runs/${encodeURIComponent(id)}/recommendations?page=${page}&page_size=100`,
    );
    if (!Array.isArray(result.items) || !Number.isFinite(result.total))
      throw new ApiError('Некорректный ответ рекомендаций.');
    rows.push(...result.items);
    if (rows.length >= result.total) return rows;
    if (!result.items.length) throw new ApiError('Сервер вернул неполный список рекомендаций.');
  }
  throw new ApiError('Набор превышает лимит 20 000 товаров.');
}
export const api: Gateway = {
  datasets: async () => {
    const data = await request<{ items: (Dataset & { warehouse_id: string })[] }>('/datasets');
    if (!Array.isArray(data.items)) throw new ApiError('Некорректный список наборов.');
    return data.items.map((d) => {
      const result = { ...d, warehouse: d.warehouse_id };
      datasetCache.set(d.id, result);
      return result;
    });
  },
  createRun: async (dataset, supplier, as_of) => {
    if (!datasetCache.has(dataset)) await api.datasets();
    const suppliers =
      datasetCache
        .get(dataset)
        ?.supplier_ids?.filter((s) => supplier === 'all' || uiSupplier(s) === supplier) || [];
    if (!suppliers.length) throw new ApiError('Поставщик отсутствует в наборе.');
    const runs = [];
    for (const s of suppliers)
      runs.push(await post<ServerRun>('/runs', { dataset_id: dataset, supplier_id: s, as_of }));
    return combine(
      runs.map((r, i) => ({ id: r.run_id, supplier: suppliers[i], dataset })),
      runs,
    );
  },
  recommendations: async (run) => {
    const rows = (await Promise.all(parts(run).map((p) => allRows(p.id)))).flat().map(mapRow);
    const summary = rows.reduce(
      (s, r) => ({
        ...s,
        total_skus: s.total_skus + 1,
        anomaly_count: s.anomaly_count + r.anomaly_count,
        order_skus: s.order_skus + ((r.recommended_qty || 0) > 0 ? 1 : 0),
        risk_skus: s.risk_skus + (r.risk_status === 'critical' ? 1 : 0),
        review_skus: s.review_skus + (r.data_status !== 'observed' ? 1 : 0),
      }),
      zero(),
    );
    return { items: rows, total: rows.length, summary };
  },
  detail: async (run, key) => {
    const p = product(run, key);
    const r = await request<ServerRow>(`/runs/${p.id}/products/${encodeURIComponent(p.sku)}`);
    const base = p.base
      ? await request<ServerRow>(`/runs/${p.base}/products/${encodeURIComponent(p.sku)}`)
      : r;
    return {
      sku: key,
      history: r.history,
      method: r.explanation,
      projection: r.trajectory.map((t) => ({
        date: t.date,
        baseline: base.trajectory.find((b) => b.date === t.date)?.without_order ?? null,
        scenario: t.without_order,
        with_order: t.with_order,
        incoming: t.incoming,
      })),
    };
  },
  quality: (dataset) => request<Quality>(`/datasets/${encodeURIComponent(dataset)}/quality`),
  shipments: async (run) => {
    const result = await request<{
      items: { id: string; sku: string; supplier_id: string; eta: string; quantity: number }[];
    }>(`/datasets/${parts(run)[0].dataset}/shipments`);
    return result.items.map((s) => ({ ...s, supplier_id: uiSupplier(s.supplier_id) }));
  },
  scenario: async (run, values) => {
    const list = parts(run);
    const runs: ServerRun[] = [];
    const next: RunPart[] = [];
    for (const p of list) {
      const applies = values.supplier_id === 'all' || uiSupplier(p.supplier) === values.supplier_id;
      if (applies) {
        if (values.delay_days && values.supplier_id === 'all')
          throw new ApiError('Для задержки выберите поставщика и конкретную партию.');
        const r = await post<ServerRun>(`/runs/${p.id}/scenario`, {
          delay_days: values.delay_days,
          demand_change_pct: values.demand_change_pct,
          shipment_id: values.shipment_id || null,
        });
        runs.push(r);
        next.push({ ...p, id: r.run_id, base: p.base || p.id });
      } else {
        runs.push(await request<ServerRun>(`/runs/${p.id}`));
        next.push(p);
      }
    }
    return combine(next, runs);
  },
  parseScenario: async (text, supplier, run, shipment) => {
    if (!run) throw new ApiError('Сначала выполните расчёт.');
    const p = parts(run).find((p) => uiSupplier(p.supplier) === supplier);
    if (!p) throw new ApiError('Выберите одного поставщика для разбора сценария.');
    const r = await post<{
      scenario: { delay_days: number; demand_change_pct: number; shipment_id?: string };
      question?: string;
      needs_clarification: boolean;
    }>('/scenarios/parse', { run_id: p.id, text, selected_shipment_id: shipment || null });
    return {
      parameters: { ...r.scenario, supplier_id: supplier },
      message: r.question,
      needs_clarification: r.needs_clarification,
    };
  },
  explain: async (run, key) => {
    const p = product(run, key);
    const r = await post<Explanation & { status: Explanation['mode'] }>(`/runs/${p.id}/explain`, {
      sku: p.sku,
      language: 'ru',
    });
    return { ...r, mode: r.status };
  },
  createDraft: async (run, supplier, lines) => {
    const p = parts(run).find((p) => uiSupplier(p.supplier) === supplier);
    if (!p) throw new ApiError('Поставщик отсутствует в расчёте.');
    const skus = lines.map((l) => product(run, l.sku).sku);
    let draft = await post<Draft>('/orders', { run_id: p.id, supplier_id: p.supplier, skus });
    const changes = lines
      .filter((l) => l.reason.trim())
      .map((l) => ({ sku: product(run, l.sku).sku, approved_qty: l.quantity, reason: l.reason }));
    if (changes.length)
      draft = await request<Draft>(`/orders/${draft.draft_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: draft.version, changes }),
      });
    return draft;
  },
  approve: (id, version, acknowledge = false) =>
    post<Draft>(`/orders/${encodeURIComponent(id)}/approve`, {
      version,
      acknowledge_warnings: acknowledge,
    }),
  exportDraft: (id) => request<Blob>(`/orders/${encodeURIComponent(id)}/export.csv`),
};
