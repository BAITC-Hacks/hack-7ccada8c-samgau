import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, request } from './api';
import { validForOrder } from '../types';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const sum = { products: 2, to_order: 1, critical: 1, needs_review: 1 };
const row = (supplier = 'systeme_electric', sku = '00001') => ({
  sku,
  supplier_id: supplier,
  supplier_article: sku,
  name: 'Товар',
  unit: 'бухта',
  stock_unit: 'м',
  stock_units_per_order_unit: 305,
  available_stock: 100,
  eligible_incoming: 0,
  forecast_qty: 400,
  safety_stock: 50,
  raw_need: 350,
  recommended_qty: 2,
  moq: 1,
  order_step: 1,
  risk_status: 'ok',
  data_status: 'ready',
  approval_blockers: [],
  factors: [
    {
      id: 'stock',
      label: 'Остаток',
      value: null,
      status: 'missing',
      source: { file: 'source.xlsx' },
    },
  ],
  warnings: [],
  history: [{ month: '2026-08', actual: null, regular: 2, restored: null, complete: false }],
  trajectory: [{ date: '2026-09-23', without_order: 10, with_order: 620, incoming: 0 }],
});
beforeEach(() => {
  vi.stubGlobal('sessionStorage', { getItem: () => 'token', setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
describe('canonical API adapter', () => {
  it.each([401, 409, 422, 500])(
    'preserves HTTP %s without demo substitution or session renewal',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          json({ error: { message: 'Ошибка проверки', fields: ['00008'] } }, status),
        );
      vi.stubGlobal('fetch', fetch);
      await expect(request('/datasets')).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token');
    },
  );
  it('rejects an HTML proxy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('<html>', { headers: { 'Content-Type': 'text/html' } })),
    );
    await expect(request('/datasets')).rejects.toThrow('неожиданный формат');
  });
  it('combines independent supplier runs, every page, null/status/units, and original trajectories', async () => {
    const calls: { path: string; body: any }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: RequestInit) => {
        const body = options.body ? JSON.parse(options.body as string) : null;
        calls.push({ path, body });
        if (path.endsWith('/datasets'))
          return json({
            items: [
              {
                id: 'demo-engine-v1',
                as_of: '2026-09-22',
                supplier_ids: ['systeme_electric', 'iek'],
                warehouse_id: 'test',
                engine_backend: 'plugin',
              },
            ],
          });
        if (path.endsWith('/runs'))
          return json({
            run_id: body.supplier_id,
            summary: sum,
            algorithm_version: 'qor-mvp-1.0',
            warnings: [],
          });
        if (path.includes('/recommendations')) {
          const supplier = path.includes('/iek/') ? 'iek' : 'systeme_electric';
          return json({
            items: [row(supplier, path.includes('page=1&') ? '00001' : '00008')],
            total: 2,
          });
        }
        if (path.endsWith('/scenario'))
          return json({
            run_id: 'scenario',
            summary: sum,
            algorithm_version: 'qor-mvp-1.0',
            warnings: [],
          });
        if (path.includes('/products/'))
          return json({
            ...row(),
            trajectory: [
              {
                date: '2026-09-23',
                without_order: path.includes('/scenario/') ? -20 : 10,
                with_order: 600,
                incoming: 0,
              },
            ],
          });
        if (path.endsWith('/scenarios/parse'))
          return json({
            status: 'fallback',
            scenario: null,
            needs_clarification: true,
            question: 'Задайте вручную',
          });
        throw new Error(path);
      }),
    );
    const base = await api.createRun('demo-engine-v1', 'all', '2026-09-22');
    expect(calls.filter((c) => c.path.endsWith('/runs')).map((c) => c.body.supplier_id)).toEqual([
      'systeme_electric',
      'iek',
    ]);
    const result = await api.recommendations(base.run_id);
    expect(result.items).toHaveLength(4);
    expect(result.summary.total_skus).toBe(4);
    const first = result.items[0];
    expect(first.stock_unit).toBe('м');
    expect(first.unit).toBe('бухта');
    expect(first.risk_status).toBe('healthy');
    expect(first.factors[0].raw_value).toBeNull();
    expect(first.factors[0].source?.file).toBe('source.xlsx');
    expect(new Set(result.items.map((r) => r.key)).size).toBe(4);
    expect(
      validForOrder({
        ...first,
        data_status: 'blocked',
        approval_blockers: ['unknown'],
        recommended_qty: 5,
      }),
    ).toBe(false);
    const changed = await api.scenario(base.run_id, {
      supplier_id: 'systeme_electric',
      shipment_id: 'real/id',
      delay_days: 30,
      demand_change_pct: 0,
    });
    expect(changed.supplier_runs?.iek).toBe('iek');
    const detail = await api.detail(changed.run_id, first.key!);
    expect(detail.projection[0]).toMatchObject({ baseline: 10, scenario: -20 });
    expect(detail.history[0].actual).toBeNull();
    const scenario = calls.find((c) => c.path.endsWith('/scenario'))!;
    expect(scenario.body).not.toHaveProperty('supplier_id');
    expect(scenario.body.shipment_id).toBe('real/id');
    await api.parseScenario('задержка', 'systeme_electric', changed.run_id, 'real/id');
    expect(calls.at(-1)?.body).toMatchObject({
      run_id: 'systeme_electric',
      selected_shipment_id: 'real/id',
    });
    expect(calls.every((c) => !c.path.includes('group%3A') && !c.path.includes('group:'))).toBe(
      true,
    );
  });
  it('does not send multipart as JSON and authenticates CSV', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ import_id: 'job' }))
      .mockResolvedValueOnce(
        new Response('sku;quantity\n00001;168', { headers: { 'Content-Type': 'text/csv' } }),
      );
    vi.stubGlobal('fetch', fetch);
    await request('/imports', {
      method: 'POST',
      body: new FormData(),
    });
    expect(new Headers(fetch.mock.calls[0][1].headers).has('Content-Type')).toBe(false);
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token');
    expect(await (await api.exportDraft('draft')).text()).toContain('168');
    expect(new Headers(fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer token');
  });
});
