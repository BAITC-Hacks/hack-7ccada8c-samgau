// Synthetic UI fixtures ONLY. Production quantities must always come from the backend.
import type {
  Draft,
  DraftLine,
  Gateway,
  ProductDetail,
  Recommendation,
  Scenario,
  Summary,
} from '../types';
import { exportCsv } from './format';
type Seed = [
  string,
  string,
  string,
  'iek' | 'systeme',
  string,
  string,
  number | null,
  number,
  number,
  number,
  number,
  'critical' | 'warning' | 'healthy',
  number,
];
const seeds: Seed[] = [
  [
    '030200428_',
    'ATN000343',
    'Розетка AtlasDesign, 16А, алюминий',
    'systeme',
    'Розетки и выключатели',
    'шт',
    80,
    50,
    210,
    70,
    156,
    'critical',
    1,
  ],
  [
    '020100162_',
    'ATN000151',
    'Выключатель AtlasDesign, 1 клавиша',
    'systeme',
    'Розетки и выключатели',
    'шт',
    124,
    120,
    240,
    80,
    76,
    'warning',
    0,
  ],
  [
    '200400085_',
    'LC1-C5E04-311',
    'Кабель F/UTP, кат. 5Е, бухта 305 м',
    'iek',
    'Кабельная продукция',
    'м',
    610,
    305,
    1220,
    305,
    610,
    'critical',
    1,
  ],
  [
    '081100768_',
    'LDPA0-5030-1H',
    'Светильник аварийный ДПА 5030',
    'iek',
    'Освещение',
    'шт',
    18,
    0,
    42,
    14,
    38,
    'critical',
    0,
  ],
  [
    '300200588_',
    'ATN000311',
    'Выключатель AtlasDesign, механизм',
    'systeme',
    'Розетки и выключатели',
    'шт',
    240,
    0,
    168,
    56,
    0,
    'healthy',
    0,
  ],
  [
    '120100031_',
    'KKM10D-MB',
    'Механизм блокировки для контактора',
    'iek',
    'Автоматика',
    'шт',
    8,
    12,
    21,
    7,
    8,
    'warning',
    0,
  ],
  [
    '300200635_',
    'ATN000340',
    'Розетка AtlasDesign, без заземления',
    'systeme',
    'Розетки и выключатели',
    'шт',
    null,
    0,
    84,
    28,
    0,
    'warning',
    0,
  ],
  [
    '081100762_',
    'LDBA0-3927',
    'Светильник аккумуляторный ДБА 3927',
    'iek',
    'Освещение',
    'шт',
    42,
    30,
    63,
    21,
    12,
    'healthy',
    1,
  ],
  [
    '030200382_',
    'VS510-252-18',
    'Выключатель Wessen 59, 2 клавиши',
    'systeme',
    'Розетки и выключатели',
    'шт',
    34,
    0,
    84,
    28,
    78,
    'critical',
    0,
  ],
  [
    '200400050_',
    'KMI-10610',
    'Миниконтактор МКИ-10610, 6А',
    'iek',
    'Автоматика',
    'шт',
    16,
    20,
    42,
    14,
    20,
    'warning',
    0,
  ],
  [
    '300200442_',
    'ATN000333',
    'Розетка USB AtlasDesign, 2 порта',
    'systeme',
    'Розетки и выключатели',
    'шт',
    45,
    0,
    21,
    7,
    0,
    'healthy',
    0,
  ],
  [
    '130200378_',
    'LDBA0-3928',
    'Светильник светодиодный ДБА 3928',
    'iek',
    'Освещение',
    'шт',
    72,
    0,
    42,
    14,
    0,
    'healthy',
    0,
  ],
];
export const fixtureRows: Recommendation[] = seeds.map(
  ([
    sku,
    supplier_article,
    name,
    supplier_id,
    category,
    unit,
    available_stock,
    eligible_incoming,
    forecast_qty,
    safety_stock,
    recommended_qty,
    risk_status,
    anomaly_count,
  ]) => ({
    sku,
    supplier_article,
    name,
    supplier_id,
    category,
    unit,
    available_stock,
    eligible_incoming,
    forecast_qty,
    safety_stock,
    raw_need:
      available_stock === null
        ? 0
        : Math.max(0, forecast_qty + safety_stock - available_stock - eligible_incoming),
    recommended_qty,
    risk_status,
    stockout_date: risk_status === 'critical' ? '2026-09-30' : null,
    data_status: available_stock === null ? 'missing' : anomaly_count ? 'estimated' : 'observed',
    anomaly_count,
    coverage_days:
      available_stock === null ? null : Math.round(available_stock / (forecast_qty / 21)),
    factors: [
      { label: 'Горизонт расчёта', value: '21 день' },
      { label: 'Страховой запас', value: '7 дней' },
      { label: 'Сезонность', value: 'Учтена в прогнозе' },
      { label: 'Источник', value: 'Синтетический пример' },
    ],
    warnings:
      available_stock === null
        ? ['Актуальный остаток неизвестен. Утверждение заблокировано.']
        : sku === '200400085_'
          ? ['Заказ 610 м = 2 бухты по 305 м. Демонстрационный коэффициент.']
          : anomaly_count
            ? ['Разовая крупная покупка отделена от регулярного спроса.']
            : [],
  }),
);
export function summarize(rows: Recommendation[]): Summary {
  return {
    order_skus: rows.filter((r) => r.recommended_qty > 0).length,
    risk_skus: rows.filter((r) => r.risk_status === 'critical').length,
    anomaly_count: rows.reduce((sum, r) => sum + r.anomaly_count, 0),
    review_skus: rows.filter((r) => r.data_status === 'missing').length,
    total_skus: rows.length,
  };
}
const runs = new Map<string, { rows: Recommendation[]; scenario: Scenario }>();
const drafts = new Map<string, { draft: Draft; rows: Recommendation[]; lines: DraftLine[] }>();
const emptyScenario: Scenario = { delay_days: 0, demand_change_pct: 0, supplier_id: 'all' };
const pause = () => new Promise((resolve) => setTimeout(resolve, 380));
const readRun = (id: string) => {
  const run = runs.get(id);
  if (!run) throw new Error('Расчёт не найден. Запустите новый расчёт.');
  return run;
};
export function demoProjection(row: Recommendation, scenario: Scenario): ProductDetail {
  const base = fixtureRows.find((r) => r.sku === row.sku)!;
  const daily = base.forecast_qty / 21;
  const applies = scenario.supplier_id === 'all' || scenario.supplier_id === row.supplier_id;
  const change = applies ? scenario.demand_change_pct : 0;
  const delay = applies ? scenario.delay_days : 0;
  const projection = Array.from({ length: 29 }, (_, d) => {
    const dt = new Date(Date.UTC(2026, 8, 22 + d));
    const originalArrival = d >= 7 ? base.eligible_incoming : 0;
    const delayedArrival = d >= 7 + delay ? base.eligible_incoming : 0;
    const baseline = (base.available_stock ?? 0) + originalArrival - daily * d;
    const altered = (base.available_stock ?? 0) + delayedArrival - daily * (1 + change / 100) * d;
    return {
      date: `${dt.getUTCDate()}.${String(dt.getUTCMonth() + 1).padStart(2, '0')}`,
      baseline: Math.round(baseline),
      scenario: Math.round(altered),
      with_order: Math.round(altered + (d >= 14 ? row.recommended_qty : 0)),
      incoming: d === 7 + delay ? base.eligible_incoming : 0,
    };
  });
  return {
    sku: row.sku,
    projection,
    method:
      'Демонстрационная траектория: поставка на 7-й день, новый заказ на 14-й. Это синтетический пример, не прогноз компании.',
    history: ['Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен*'].map((month, i) => {
      const regular = Math.round(daily * [27, 29, 32, 31, 30, 22][i]);
      return {
        month,
        regular,
        actual:
          i === 2 && row.anomaly_count
            ? regular + Math.round(daily * 90)
            : i === 4
              ? Math.round(regular * 0.67)
              : regular,
        restored: regular,
      };
    }),
  };
}
function applyFixtureRisk(row: Recommendation, scenario: Scenario) {
  const firstGap = demoProjection(row, scenario).projection.findIndex((p) => p.scenario < 0);
  row.risk_status =
    row.available_stock === null
      ? 'warning'
      : firstGap >= 0 && firstGap < 14
        ? 'critical'
        : firstGap >= 0
          ? 'warning'
          : 'healthy';
  row.stockout_date =
    row.available_stock !== null && firstGap >= 0
      ? new Date(Date.UTC(2026, 8, 22 + firstGap)).toISOString().slice(0, 10)
      : null;
}
fixtureRows.forEach((row) => applyFixtureRisk(row, emptyScenario));
export const demo: Gateway = {
  datasets: async () => {
    await pause();
    return [
      {
        id: 'demo-september',
        name: 'Демонстрационный набор',
        mode: 'synthetic',
        as_of: '2026-09-22',
        warehouse: 'Алматы',
      },
    ];
  },
  createRun: async (_, supplier) => {
    await pause();
    const rows = structuredClone(
      fixtureRows.filter((r) => supplier === 'all' || r.supplier_id === supplier),
    );
    const run_id = crypto.randomUUID();
    runs.set(run_id, { rows, scenario: emptyScenario });
    return { run_id, summary: summarize(rows) };
  },
  recommendations: async (id) => {
    const { rows } = readRun(id);
    return { items: structuredClone(rows), total: rows.length, summary: summarize(rows) };
  },
  detail: async (id, sku) => {
    await pause();
    const run = readRun(id);
    const row = run.rows.find((r) => r.sku === sku);
    if (!row) throw new Error('Товар не найден');
    return demoProjection(row, run.scenario);
  },
  quality: async () => {
    await pause();
    return {
      source_count: 6,
      mapped_skus: 12,
      issues: [
        {
          id: 'synthetic',
          title: 'Вы работаете с синтетическими данными',
          detail:
            'Данные созданы для проверки интерфейса. Это не остатки и продажи Электрокомплекта.',
          severity: 'info',
          count: 12,
        },
        {
          id: 'stock',
          title: 'Не указан актуальный остаток',
          detail: 'Одна позиция доступна для анализа, но её нельзя включить в утверждённый заказ.',
          severity: 'warning',
          count: 1,
        },
        {
          id: 'anomaly',
          title: 'Выделены разовые крупные покупки',
          detail: 'В демопримерах аномальная часть показана отдельно от регулярного спроса.',
          severity: 'info',
          count: 3,
        },
        {
          id: 'units',
          title: 'Кабель заказывается бухтами',
          detail:
            'Демонстрационный коэффициент: 305 метров в бухте. Проверьте единицы перед заказом.',
          severity: 'warning',
          count: 1,
        },
      ],
    };
  },
  scenario: async (id, values) => {
    await pause();
    const source = readRun(id);
    const rows = source.rows.map((previous) => {
      const base = fixtureRows.find((r) => r.sku === previous.sku)!;
      const row = structuredClone(base);
      if (values.supplier_id !== 'all' && row.supplier_id !== values.supplier_id) return row;
      row.forecast_qty = Math.ceil(base.forecast_qty * (1 + values.demand_change_pct / 100));
      row.safety_stock = Math.ceil(base.safety_stock * (1 + values.demand_change_pct / 100));
      row.eligible_incoming = 7 + values.delay_days > 21 ? 0 : base.eligible_incoming;
      row.raw_need =
        row.available_stock === null
          ? 0
          : Math.max(
              0,
              row.forecast_qty + row.safety_stock - row.available_stock - row.eligible_incoming,
            );
      const multiple = row.unit === 'м' ? 305 : row.sku === '030200428_' ? 12 : 1;
      row.recommended_qty =
        row.available_stock === null ? 0 : Math.ceil(row.raw_need / multiple) * multiple;
      applyFixtureRisk(row, values);
      return row;
    });
    const run_id = crypto.randomUUID();
    runs.set(run_id, { rows, scenario: values });
    return { run_id, summary: summarize(rows) };
  },
  parseScenario: async (_, supplier_id) => ({
    parameters: { delay_days: 7, demand_change_pct: 0, supplier_id },
    needs_clarification: true,
    message: 'В деморежиме ИИ не подключён. Выберите параметры вручную или переключитесь на API.',
  }),
  explain: async (id, sku) => {
    await pause();
    const row = readRun(id).rows.find((r) => r.sku === sku)!;
    return {
      text: `На горизонте 21 дня ожидается спрос ${row.forecast_qty} ${row.unit}. Страховой запас — ${row.safety_stock}. Из потребности вычитаются ${row.available_stock ?? 'неизвестный остаток'} на складе и ${row.eligible_incoming} в пути. После округления рекомендация — ${row.recommended_qty} ${row.unit}. ${row.warnings.join(' ')} Это шаблонное объяснение синтетического примера.`,
      factor_ids: [],
      provider: 'demo',
      mode: 'fallback',
    };
  },
  createDraft: async (run, supplier, lines) => {
    await pause();
    const rows = readRun(run).rows.filter(
      (r) => r.supplier_id === supplier && lines.some((l) => l.sku === r.sku),
    );
    if (!rows.length || rows.some((r) => r.available_stock === null))
      throw new Error('В заказе есть позиции без подтверждённого остатка.');
    if (rows.length !== lines.length || new Set(lines.map((l) => l.sku)).size !== lines.length)
      throw new Error('В заказе есть неизвестные или повторяющиеся позиции.');
    if (
      lines.some((line) => {
        const row = rows.find((r) => r.sku === line.sku)!;
        return (
          !Number.isFinite(line.quantity) ||
          line.quantity < 0 ||
          (row.unit === 'шт' && !Number.isInteger(line.quantity)) ||
          (line.quantity !== row.recommended_qty && !line.reason.trim())
        );
      })
    )
      throw new Error('Проверьте количество и причину изменения.');
    const draft: Draft = { draft_id: crypto.randomUUID(), version: 1, status: 'draft' };
    drafts.set(draft.draft_id, { draft, rows, lines: structuredClone(lines) });
    return draft;
  },
  approve: async (id, version) => {
    await pause();
    const saved = drafts.get(id);
    if (!saved || saved.draft.version !== version) throw new Error('Версия черновика изменилась');
    saved.draft = { ...saved.draft, status: 'approved', version: version + 1 };
    return saved.draft;
  },
  exportDraft: async (id) => {
    const saved = drafts.get(id);
    if (!saved || saved.draft.status !== 'approved') throw new Error('Сначала утвердите черновик.');
    return new Blob(
      [
        exportCsv(
          saved.rows,
          Object.fromEntries(saved.lines.map((l) => [l.sku, l.quantity])),
          Object.fromEntries(saved.lines.map((l) => [l.sku, l.reason])),
        ),
      ],
      { type: 'text/csv;charset=utf-8' },
    );
  },
};
