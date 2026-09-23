import { ArrowUpRight, SlidersHorizontal } from 'lucide-react';
import type { Recommendation } from '../types';

export function InventorySummary({
  rows,
  busy,
  onScenario,
}: {
  rows: Recommendation[];
  busy: boolean;
  onScenario: () => void;
}) {
  const groups = [
    { label: 'Запаса достаточно', color: '#aaa0d5', count: 0 },
    { label: 'Нужно пополнить', color: '#7668af', count: 0 },
    { label: 'Риск дефицита', color: '#dfa09c', count: 0 },
    { label: 'Проверить данные', color: '#d9dce4', count: 0 },
  ];
  rows.forEach((row) => {
    const index =
      ['missing', 'blocked'].includes(row.data_status) ||
      row.risk_status === 'unknown' ||
      row.available_stock === null
        ? 3
        : row.risk_status === 'critical'
          ? 2
          : row.risk_status === 'warning'
            ? 1
            : 0;
    groups[index].count += 1;
  });
  let offset = 0;
  const segments = groups.map((group) => {
    const start = offset;
    offset += rows.length ? (group.count / rows.length) * 100 : 0;
    return `${group.color} ${start}% ${offset}%`;
  });
  return (
    <section className="panel inventory-summary">
      <div className="section-title">
        <div>
          <h2>Состояние склада</h2>
          <p>Все позиции по уровню риска</p>
        </div>
      </div>
      <div className="inventory-overview">
        <div
          className="inventory-donut"
          aria-hidden="true"
          style={{ background: rows.length ? `conic-gradient(${segments.join(',')})` : '#eceef2' }}
        >
          <div>
            <strong>{rows.length}</strong>
            <span>позиций</span>
          </div>
        </div>
        <ul className="inventory-legend" aria-label="Распределение позиций по состоянию запаса">
          {groups.map((group) => (
            <li key={group.label}>
              <i style={{ background: group.color }} />
              <div>
                <span>{group.label}</span>
                <strong>
                  {group.count} <small>поз.</small>
                </strong>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <button className="scenario-shortcut" disabled={busy} onClick={onScenario}>
        <SlidersHorizontal size={20} />
        <span>
          <strong>А если поставка опоздает?</strong>
          <small>Проверьте сценарий до закупки</small>
        </span>
        <ArrowUpRight size={19} />
      </button>
    </section>
  );
}
