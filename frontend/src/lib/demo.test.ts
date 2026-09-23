import { describe, expect, it } from 'vitest';
import { demo, fixtureRows, summarize } from './demo';
import { csvCell, exportCsv } from './format';

describe('synthetic demo workflow', () => {
  it('has the documented control example and discloses missing stock', () => {
    expect(fixtureRows[0].recommended_qty).toBe(156);
    const missing = fixtureRows.find((r) => r.available_stock === null)!;
    expect(missing.data_status).toBe('missing');
    expect(missing.recommended_qty).toBe(0);
    expect(summarize(fixtureRows).review_skus).toBe(1);
  });
  it('changes the trajectory when a shipment is delayed, without fabricating a quantity change', async () => {
    const base = await demo.createRun('demo', 'all', '2026-09-22');
    const changed = await demo.scenario(base.run_id, {
      delay_days: 7,
      demand_change_pct: 0,
      supplier_id: 'systeme',
    });
    const before = await demo.detail(base.run_id, fixtureRows[0].sku);
    const after = await demo.detail(changed.run_id, fixtureRows[0].sku);
    expect(after.projection[8].scenario).toBeLessThan(before.projection[8].scenario!);
    expect((await demo.recommendations(changed.run_id)).items[0].recommended_qty).toBe(156);
    expect((await demo.recommendations(base.run_id)).items[0].recommended_qty).toBe(156);
  });
  it('does not subtract shipments arriving outside the horizon', async () => {
    const base = await demo.createRun('demo', 'all', '2026-09-22');
    const changed = await demo.scenario(base.run_id, {
      delay_days: 21,
      demand_change_pct: 0,
      supplier_id: 'systeme',
    });
    const row = (await demo.recommendations(changed.run_id)).items[0];
    expect(row.eligible_incoming).toBe(0);
    expect(row.recommended_qty).toBe(204);
  });
  it('a zero-change scenario preserves every quantity and risk', async () => {
    const base = await demo.createRun('demo', 'all', '2026-09-22');
    const unchanged = await demo.scenario(base.run_id, {
      delay_days: 0,
      demand_change_pct: 0,
      supplier_id: 'all',
    });
    const project = (rows: typeof fixtureRows) =>
      rows.map((r) => [r.sku, r.recommended_qty, r.risk_status]);
    expect(project((await demo.recommendations(unchanged.run_id)).items)).toEqual(
      project((await demo.recommendations(base.run_id)).items),
    );
  });
  it('requires approval, preserves manual quantities, and blocks missing-stock items', async () => {
    const run = await demo.createRun('demo', 'systeme', '2026-09-22');
    const draft = await demo.createDraft(run.run_id, 'systeme', [
      { sku: fixtureRows[0].sku, quantity: 168, reason: 'Страховой запас для проекта' },
    ]);
    await expect(demo.exportDraft(draft.draft_id)).rejects.toThrow('утвердите');
    await demo.approve(draft.draft_id, draft.version);
    const csv = await (await demo.exportDraft(draft.draft_id)).text();
    expect(csv).toContain('"168"');
    expect(csv).toContain('Страховой запас для проекта');
    const missing = fixtureRows.find((r) => r.available_stock === null)!;
    await expect(
      demo.createDraft(run.run_id, 'systeme', [{ sku: missing.sku, quantity: 20, reason: '' }]),
    ).rejects.toThrow('остатка');
  });
});
describe('export safety', () => {
  it('escapes spreadsheet formulas, quotes and line breaks', () => {
    expect(csvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
    expect(csvCell(' hello "world"')).toBe('" hello ""world"""');
    expect(csvCell('  @SUM(A1)')).toContain("'");
    expect(exportCsv([fixtureRows[0]], {}, {})).toContain('Синтетическое демо');
  });
});
