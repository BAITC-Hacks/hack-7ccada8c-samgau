import type {
  Dataset,
  Draft,
  DraftLine,
  Explanation,
  Gateway,
  HistoryPoint,
  ProductDetail,
  Quality,
  Recommendation,
  Run,
  Shipment,
  Summary,
} from '../types';
import { sessionToken } from './session';
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public fields: unknown[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (path !== '/sessions' && path !== '/health' && path !== '/assistant/status')
    headers.set(
      'Authorization',
      `Bearer ${await sessionToken(() => request('/sessions', { method: 'POST' }))}`,
    );
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.body instanceof FormData ? 120000 : 20000,
  );
  try {
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `Сервер вернул ошибку ${res.status}. Повторите попытку.`;
      let fields: unknown[] = [];
      try {
        const body = await res.json();
        message =
          body.error?.message ||
          body.message ||
          (typeof body.detail === 'string' ? body.detail : message);
        fields = body.error?.fields || [];
      } catch {
        /* safe message */
      }
      if (res.status === 401)
        message =
          'Сессия истекла. Сохранённые черновики оставлены без изменений. Начните новую сессию через кнопку в панели данных; доступ к прежним черновикам будет потерян.';
      if (fields.length)
        message += ` ${fields.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('; ')}`;
      throw new ApiError(message, res.status, fields);
    }
    if (path.endsWith('/export.csv')) return (await res.blob()) as T;
    if (!res.headers.get('content-type')?.includes('application/json'))
      throw new ApiError('API вернул неожиданный формат. Проверьте подключение /api.');
    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError')
      throw new ApiError(
        'Сервер не ответил вовремя. Проверьте сохранённое состояние перед повтором.',
      );
    throw new ApiError('Не удалось связаться с API. Проверьте, запущен ли сервер.');
  } finally {
    clearTimeout(timer);
  }
}
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const enc = encodeURIComponent;
type ServerSummary = { products: number; to_order: number; critical: number; needs_review: number };
type ServerRun = {
  run_id: string;
  summary: ServerSummary;
  algorithm_version: string;
  warnings: string[];
};
type Group = {
  dataset: string;
  suppliers: Record<string, ServerRun>;
  base: Record<string, ServerRun>;
};
type ServerRow = Omit<Recommendation, 'risk_status' | 'factors'> & {
  risk_status: 'ok' | 'warning' | 'critical' | 'unknown';
  factors: {
    id: string;
    label: string;
    value: number | string | null;
    unit: string | null;
    status: string;
    source: Recommendation['factors'][number]['source'];
  }[];
  history: HistoryPoint[];
  trajectory: {
    date: string;
    without_order: number | null;
    with_order: number | null;
    incoming: number | null;
  }[];
};
const groups = new Map<string, Group>();
const datasets = new Map<string, Dataset>();
function group(id: string): Group {
  const g = groups.get(id);
  if (!g) throw new ApiError('Расчёт не найден. Пересчитайте набор.');
  return g;
}
function summary(s: ServerSummary): Summary {
  return {
    total_skus: s.products,
    order_skus: s.to_order,
    risk_skus: s.critical,
    review_skus: s.needs_review,
    anomaly_count: null,
  };
}
function saveGroup(g: Group): Run {
  const id = `group:${crypto.randomUUID()}`;
  groups.set(id, g);
  const sum = { products: 0, to_order: 0, critical: 0, needs_review: 0 };
  for (const r of Object.values(g.suppliers))
    for (const k of Object.keys(sum) as (keyof ServerSummary)[]) sum[k] += r.summary[k];
  return {
    run_id: id,
    summary: summary(sum),
    supplier_runs: Object.fromEntries(Object.entries(g.suppliers).map(([s, r]) => [s, r.run_id])),
  };
}
function adapt(r: ServerRow, run: string): Recommendation {
  return {
    ...r,
    key: JSON.stringify([r.supplier_id, r.sku]),
    run_id: run,
    category: 'Категория не указана',
    anomaly_count: null,
    coverage_days: null,
    risk_status: r.risk_status === 'ok' ? 'healthy' : r.risk_status,
    factors: r.factors.map((f) => ({
      ...f,
      raw_value: f.value,
      value: f.value === null ? 'Нет данных' : `${f.value}${f.unit ? ` ${f.unit}` : ''}`,
    })),
  };
}
function target(id: string, key: string) {
  const g = group(id);
  const [supplier, sku] = JSON.parse(key) as [string, string];
  const r = g.suppliers[supplier];
  if (!r) throw new ApiError('Поставщик не найден в расчёте.');
  return { g, supplier, sku, run: r };
}
export const api: Gateway = {
  datasets: async () => {
    const response = await request<{ items: (Dataset & { warehouse_id: string })[] }>('/datasets');
    if (!Array.isArray(response.items)) throw new ApiError('Некорректный список наборов.');
    const items = response.items
      .map((d) => ({ ...d, warehouse: d.warehouse_id }))
      .sort((a, b) => Number(b.id === 'demo-engine-v1') - Number(a.id === 'demo-engine-v1'));
    items.forEach((d) => datasets.set(d.id, d));
    return items;
  },
  createRun: async (dataset, supplier, as_of) => {
    if (!datasets.has(dataset)) await api.datasets();
    const d = datasets.get(dataset);
    if (!d?.supplier_ids?.length) throw new ApiError('В наборе не указаны поставщики.');
    const ids = supplier === 'all' ? d.supplier_ids : [supplier];
    const entries = await Promise.all(
      ids.map(
        async (s) =>
          [
            s,
            await post<ServerRun>('/runs', {
              dataset_id: dataset,
              supplier_id: s,
              as_of,
              lead_time_days: 14,
              review_days: 7,
              safety_days: 7,
            }),
          ] as const,
      ),
    );
    const suppliers = Object.fromEntries(entries);
    return saveGroup({ dataset, suppliers, base: suppliers });
  },
  recommendations: async (id) => {
    const g = group(id);
    const items: Recommendation[] = [];
    for (const r of Object.values(g.suppliers)) {
      let page = 1,
        total = Infinity,
        count = 0;
      while (count < total) {
        const response = await request<{ items: ServerRow[]; total: number }>(
          `/runs/${enc(r.run_id)}/recommendations?page=${page}&page_size=100`,
        );
        if (
          !Array.isArray(response.items) ||
          !Number.isFinite(response.total) ||
          (!response.items.length && count < response.total)
        )
          throw new ApiError('Неполный список рекомендаций.');
        total = response.total;
        count += response.items.length;
        items.push(...response.items.map((row) => adapt(row, r.run_id)));
        page++;
        if (page > 200 && count < total)
          throw new ApiError('Набор превышает 20 000 позиций на поставщика.');
      }
    }
    const sum = { products: 0, to_order: 0, critical: 0, needs_review: 0 };
    for (const r of Object.values(g.suppliers))
      for (const k of Object.keys(sum) as (keyof ServerSummary)[]) sum[k] += r.summary[k];
    return { items, total: items.length, summary: summary(sum) };
  },
  detail: async (id, key) => {
    const { g, supplier, sku, run } = target(id, key);
    const path = (r: string) => `/runs/${enc(r)}/products/${enc(sku)}`;
    const row = await request<ServerRow>(path(run.run_id));
    const baseline =
      g.base[supplier].run_id === run.run_id
        ? row
        : await request<ServerRow>(path(g.base[supplier].run_id));
    const byDate = new Map(baseline.trajectory.map((p) => [p.date, p.without_order]));
    return {
      sku,
      history: row.history,
      projection: row.trajectory.map((p) => ({
        date: p.date,
        baseline: byDate.get(p.date) ?? null,
        scenario: p.without_order,
        with_order: p.with_order,
        incoming: p.incoming,
      })),
      method: `Алгоритм ${run.algorithm_version}. Запасы и спрос: ${row.stock_unit}. Заказ: ${row.unit}; коэффициент ${row.stock_units_per_order_unit ?? 'неизвестен'} ${row.stock_unit}/${row.unit}. Горизонт: ${row.trajectory.length} дней.`,
    } satisfies ProductDetail;
  },
  quality: async (dataset) => {
    const q = await request<Quality & { warnings?: string[] }>(`/datasets/${enc(dataset)}/quality`);
    return {
      ...q,
      source_count: q.source_count ?? null,
      mapped_skus: q.mapped_skus ?? null,
      issues: [
        ...(q.issues || []),
        ...(q.warnings || []).map((w, i) => ({
          id: `warning-${i}`,
          title: w,
          detail: 'Предупреждение источника',
          severity: 'warning' as const,
          count: 1,
        })),
      ],
    };
  },
  shipments: async (id) =>
    (await request<{ items: Shipment[] }>(`/datasets/${enc(group(id).dataset)}/shipments`)).items,
  scenario: async (id, values) => {
    const g = group(id);
    const suppliers = { ...g.base };
    if (values.delay_days && (!values.shipment_id || values.supplier_id === 'all'))
      throw new ApiError('Выберите поставщика и конкретную поставку для задержки.');
    const ids = values.supplier_id === 'all' ? Object.keys(g.base) : [values.supplier_id];
    for (const s of ids) {
      if (!g.base[s]) throw new ApiError('Поставщик отсутствует в наборе.');
      suppliers[s] = await post<ServerRun>(`/runs/${enc(g.base[s].run_id)}/scenario`, {
        delay_days: values.delay_days,
        demand_change_pct: values.demand_change_pct,
        shipment_id: values.shipment_id || null,
      });
    }
    return saveGroup({ ...g, suppliers });
  },
  parseScenario: async (text, supplier, id, shipment) => {
    const g = group(id);
    if (!g.base[supplier]) throw new ApiError('Выберите одного поставщика для разбора сценария.');
    const r = await post<{
      scenario: null | { shipment_id?: string; delay_days: number; demand_change_pct: number };
      needs_clarification: boolean;
      question: string;
      status: string;
      requires_confirmation: boolean;
    }>('/scenarios/parse', {
      text,
      run_id: g.base[supplier].run_id,
      selected_shipment_id: shipment || null,
    });
    return {
      parameters: {
        ...(r.scenario || { delay_days: 0, demand_change_pct: 0 }),
        supplier_id: supplier,
      },
      needs_clarification: r.needs_clarification || !r.scenario,
      message: r.question,
      status: r.status,
      requires_confirmation: r.requires_confirmation,
    };
  },
  explain: async (id, key) => {
    const { run, sku } = target(id, key);
    const r = await post<Explanation & { status: Explanation['mode'] }>(
      `/runs/${enc(run.run_id)}/explain`,
      { sku, language: 'ru' },
    );
    return { ...r, mode: r.status };
  },
  createDraft: async (id, supplier, lines) => {
    const r = group(id).suppliers[supplier];
    if (!r) throw new ApiError('Поставщик отсутствует в расчёте.');
    return post<Draft>('/orders', {
      run_id: r.run_id,
      supplier_id: supplier,
      skus: lines.map((l) => l.sku),
    });
  },
  patchDraft: (id, version, lines: DraftLine[]) =>
    request<Draft>(`/orders/${enc(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        version,
        changes: lines.map((l) => ({ sku: l.sku, approved_qty: l.quantity, reason: l.reason })),
      }),
    }),
  getDraft: (id) => request<Draft>(`/orders/${enc(id)}`),
  listDrafts: async () => (await request<{ items: Draft[] }>('/orders')).items,
  approve: (id, version, acknowledge = false) =>
    post<Draft>(`/orders/${enc(id)}/approve`, { version, acknowledge_warnings: acknowledge }),
  exportDraft: (id) => request<Blob>(`/orders/${enc(id)}/export.csv`),
};
