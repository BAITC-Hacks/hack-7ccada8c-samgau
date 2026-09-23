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
  it('finds a raw 1C code and preserves order units, rounding and approval blockers', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ...fixtureRows[0], sku: `iek/00${i}`, sku_1c: `00${i}`,
      unit: 'бухта', stock_unit: 'м', stock_units_per_order_unit: 305,
      moq: 2, order_step: 2, approval_blockers: ['unknown_incoming'],
    }));
    const context = makeChatContext(null, null, rows, null, '', 'Почему такой заказ по коду 0099?');
    expect(context.products[0]).toMatchObject({
      sku: 'iek/0099', sku_1c: '0099', unit: 'бухта', stock_unit: 'м',
      stock_units_per_order_unit: 305, moq: 2, order_step: 2,
      approval_blockers: ['unknown_incoming'],
    });
    expect(context.products[0].factors.length).toBeGreaterThan(0);
  });
});
