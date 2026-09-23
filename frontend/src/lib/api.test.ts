import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, request } from './api';
afterEach(() => vi.unstubAllGlobals());
describe('API transport', () => {
  it('reports backend errors without falling back to demo', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
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
  it('loads every recommendation page', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ sku: 'one' }], total: 2, summary: {} }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ sku: 'two' }], total: 2, summary: {} }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', mock);
    const result = await api.recommendations('run');
    expect(result.items).toHaveLength(2);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
