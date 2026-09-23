import { describe, expect, it } from 'vitest';
import { fixtureRows, summarize } from './demo';
import { makeChatContext } from './assistant';

describe('assistant context', () => {
  it('prioritizes the requested and selected products without sending an unlimited dataset', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ...fixtureRows[0],
      sku: `sku-${i}`,
      supplier_article: `article-${i}`,
    }));
    const context = makeChatContext(
      null,
      { run_id: 'run', summary: summarize(rows) },
      rows,
      null,
      'sku-99',
      'Explain article-98',
    );
    expect(context.products).toHaveLength(40);
    expect(context.products.some((row) => row.sku === 'sku-99')).toBe(true);
    expect(context.products[0].sku).toBe('sku-98');
    expect(context.total_products).toBe(100);
  });
  it('keeps missing quantities unknown and passes the current scenario', () => {
    const context = makeChatContext(
      null,
      null,
      fixtureRows,
      { supplier_id: 'iek', delay_days: 7, demand_change_pct: 20 },
      '',
      '',
    );
    expect(
      context.products.find((row) => row.data_status === 'missing')?.recommended_qty,
    ).toBeNull();
    expect(context.scenario).toContain('7');
    expect(context.scenario).toContain('20');
    expect(context.products[0]).not.toHaveProperty('history');
  });
});
