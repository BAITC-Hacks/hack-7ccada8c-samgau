import type {
  Dataset,
  Draft,
  Explanation,
  Gateway,
  ParsedScenario,
  ProductDetail,
  Quality,
  Recommendations,
  Run,
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
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      credentials: 'include',
      signal: controller.signal,
    });
    if (!res.ok) {
      let message = `Сервер вернул ошибку ${res.status}. Повторите попытку.`;
      try {
        const body = await res.json();
        if (typeof body.message === 'string') message = body.message;
        else if (typeof body.detail === 'string') message = body.detail;
      } catch {
        /* keep safe HTTP message */
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
      throw new ApiError('Сервер не ответил за 20 секунд. Попробуйте ещё раз.');
    throw new ApiError('Не удалось связаться с API. Проверьте, запущен ли сервер.');
  } finally {
    clearTimeout(timer);
  }
}
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const api: Gateway = {
  datasets: async () => {
    const data = await request<Dataset[]>('/datasets');
    if (!Array.isArray(data))
      throw new ApiError('Ожидался список наборов данных. Проверьте контракт API.');
    return data;
  },
  createRun: (dataset_id, supplier_id, as_of) =>
    post<Run>('/runs', {
      dataset_id,
      supplier_id: supplier_id === 'all' ? null : supplier_id,
      as_of,
    }),
  recommendations: async (run) => {
    let page = 1;
    const all: Recommendations['items'] = [];
    let response: Recommendations;
    do {
      response = await request<Recommendations>(
        `/runs/${encodeURIComponent(run)}/recommendations?page=${page}&page_size=100`,
      );
      if (!Array.isArray(response.items) || !response.summary || !Number.isFinite(response.total))
        throw new ApiError('Некорректный формат рекомендаций. Проверьте контракт интерфейса.');
      all.push(...response.items);
      if (!response.items.length && all.length < response.total)
        throw new ApiError('Сервер вернул неполный список рекомендаций.');
      page++;
      if (page > 200 && all.length < response.total)
        throw new ApiError(
          'Набор превышает лимит интерфейса в 20 000 позиций. Выберите поставщика.',
        );
    } while (all.length < response.total);
    return { ...response, items: all };
  },
  detail: (run, sku) =>
    request<ProductDetail>(`/runs/${encodeURIComponent(run)}/products/${encodeURIComponent(sku)}`),
  quality: (dataset) => request<Quality>(`/datasets/${encodeURIComponent(dataset)}/quality`),
  scenario: (run, parameters) => post<Run>(`/runs/${encodeURIComponent(run)}/scenario`, parameters),
  parseScenario: (text, supplier_id) =>
    post<ParsedScenario>('/scenarios/parse', { text, supplier_id }),
  explain: (run, sku) =>
    post<Explanation>(`/runs/${encodeURIComponent(run)}/explain`, { sku, language: 'ru' }),
  createDraft: (run_id, supplier_id, lines) =>
    post<Draft>('/orders', { run_id, supplier_id, lines }),
  approve: (id, version) => post<Draft>(`/orders/${encodeURIComponent(id)}/approve`, { version }),
  exportDraft: (id) => request<Blob>(`/orders/${encodeURIComponent(id)}/export.csv`),
};
