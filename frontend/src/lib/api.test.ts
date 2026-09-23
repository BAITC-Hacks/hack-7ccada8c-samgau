import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, request, resetSession } from './api';
afterEach(() => {
  resetSession();
  vi.unstubAllGlobals();
});
describe('API transport', () => {
  it('reports backend errors without falling back to demo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Набор не найден' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(request('/datasets')).rejects.toThrow('Набор не найден');
  });
  it('rejects HTML from a missing reverse proxy', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>App</html>', { headers: { 'Content-Type': 'text/html' } }),
        ),
    );
    await expect(request('/datasets')).rejects.toThrow('неожиданный формат');
  });
  it('uses a bearer session, reads all pages and preserves unknown values and stock units', async () => {
    const mock = vi.fn(async (url: string) => {
      let body: unknown;
      if (url.endsWith('/sessions')) body = { token: 'test-session' };
      else if (url.endsWith('/datasets'))
        body = { items: [{ id: 'ds', supplier_ids: ['iek'], warehouse_id: 'Склад' }] };
      else if (url.endsWith('/runs'))
        body = {
          run_id: 'backend-run',
          summary: { products: 2, to_order: 1, critical: 0, needs_review: 1 },
        };
      else
        body = {
          items: [
            {
              sku: url.includes('page=1&') ? '0001_' : '0002_',
              supplier_id: 'iek',
              stock_unit: 'м',
              unit: 'бухта',
              recommended_qty: null,
              available_stock: null,
              risk_status: 'unknown',
              data_status: 'blocked',
              factors: [],
              warnings: [],
              approval_blockers: ['unit_conversion_missing'],
            },
          ],
          total: 2,
        };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', mock);
    const run = await api.createRun('ds', 'all', '2026-09-22');
    const result = await api.recommendations(run.run_id);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      sku_1c: '0001_',
      stock_unit: 'м',
      unit: 'бухта',
      recommended_qty: null,
      data_status: 'missing',
    });
    expect(mock).toHaveBeenCalledTimes(5);
  });
  it('keeps multipart boundaries under browser control and authenticates uploads', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'test' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ import_id: 'job' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', mock);
    await request('/imports', {
      method: 'POST',
      headers: { 'X-Admin-Token': 'test-admin' },
      body: new FormData(),
    });
    const init = mock.mock.calls[1][1];
    expect(init.headers.get('Authorization')).toBe('Bearer test');
    expect(init.headers.get('Content-Type')).toBeNull();
    expect(init.headers.get('X-Admin-Token')).toBe('test-admin');
  });
});
