import type { Recommendation } from '../types';
export const number = (value: number | null, digits = 0) =>
  value === null
    ? 'Нет данных'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
export const date = (value: string) =>
  new Date(value.slice(0, 10) + 'T12:00:00').toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
export const supplierName = (id: string) =>
  id === 'iek' ? 'IEK' : id === 'systeme' ? 'Systeme Electric' : 'Все поставщики';
export const riskLabel = { critical: 'Дефицит', warning: 'Внимание', healthy: 'В норме' };
export function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  const safe = /^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportCsv(
  rows: Recommendation[],
  amounts: Record<string, number>,
  reasons: Record<string, string>,
): string {
  const header = [
    'Режим данных',
    'Поставщик',
    'Код 1С',
    'Артикул',
    'Наименование',
    'Единица',
    'Утверждено',
    'Рекомендовано',
    'Причина изменения',
  ];
  return (
    '\uFEFF' +
    [
      header,
      ...rows.map((r) => [
        'Синтетическое демо',
        supplierName(r.supplier_id),
        r.sku,
        r.supplier_article,
        r.name,
        r.unit,
        amounts[r.sku] ?? r.recommended_qty,
        r.recommended_qty,
        reasons[r.sku] || 'Без изменений',
      ]),
    ]
      .map((row) => row.map(csvCell).join(';'))
      .join('\r\n')
  );
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
