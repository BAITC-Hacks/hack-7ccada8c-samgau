import { useState, type CSSProperties } from 'react';
import {
  ArrowUpRight,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Expand,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type { Recommendation } from '../types';
import { number } from '../lib/format';
import './WarehouseScene.css';

function condition(row: Recommendation) {
  if (row.available_stock === null || row.data_status === 'missing') return 'missing';
  return row.risk_status;
}
const labels = {
  critical: 'Риск дефицита',
  warning: 'Нужно внимание',
  healthy: 'Запас в норме',
  missing: 'Проверить данные',
};

export function WarehouseScene({
  rows,
  scenario,
  busy,
  onProduct,
  onScenario,
}: {
  rows: Recommendation[];
  scenario: boolean;
  busy: boolean;
  onProduct: (row: Recommendation) => void;
  onScenario: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [selectedSku, setSelectedSku] = useState('');
  const [rotation, setRotation] = useState(-26);
  const [filter, setFilter] = useState<'all' | 'critical' | 'missing'>('all');
  const [page, setPage] = useState(0);
  const filtered = rows.filter((row) => filter === 'all' || condition(row) === filter);
  const maxPage = Math.max(0, Math.ceil(filtered.length / 12) - 1);
  const currentPage = Math.min(page, maxPage);
  const visible = filtered.slice(currentPage * 12, currentPage * 12 + 12);
  const selected = visible.find((row) => row.sku === selectedSku) || visible[0];
  return (
    <section
      className={`panel warehouse ${expanded ? '' : 'warehouse-collapsed'}`}
      aria-label="Интерактивный 3D-склад"
    >
      <header className="warehouse-heading">
        <div className="warehouse-title">
          <span>
            <Box size={21} />
          </span>
          <div>
            <h2>
              Склад в объёме <small>3D</small>
            </h2>
            <p>Найдите риск. Выберите товар. Посмотрите решение.</p>
          </div>
        </div>
        <button
          className="secondary"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls="warehouse-body"
        >
          {expanded ? <ChevronDown size={16} /> : <Expand size={16} />}{' '}
          {expanded ? 'Свернуть' : 'Открыть 3D'}
        </button>
      </header>
      {expanded && (
        <div id="warehouse-body">
          <div className="warehouse-toolbar">
            <div className="warehouse-filters" aria-label="Фильтр 3D-склада">
              {(
                [
                  { id: 'all', label: 'Весь склад' },
                  { id: 'critical', label: 'Риск дефицита' },
                  { id: 'missing', label: 'Проверить данные' },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  aria-pressed={filter === item.id}
                  className={filter === item.id ? 'active' : ''}
                  onClick={() => {
                    setFilter(item.id);
                    setPage(0);
                  }}
                >
                  {item.id === 'critical' && <i />}
                  {item.label}
                </button>
              ))}
            </div>
            <span className={`warehouse-live ${scenario ? 'is-scenario' : ''}`}>
              <i />
              {scenario ? 'Сценарий применён' : 'Текущий расчёт'}
            </span>
          </div>
          <div className="warehouse-grid">
            <div className="warehouse-stage">
              <span className="warehouse-hint">Нажмите на секцию, чтобы выбрать товар</span>
              <div
                className="warehouse-world"
                style={{ '--warehouse-angle': `${rotation}deg` } as CSSProperties}
              >
                <div className="warehouse-floor">
                  <div className="warehouse-floor-label" aria-hidden="true">
                    QOR / SMART STOCK
                  </div>
                  {visible.map((row, index) => (
                    <button
                      key={row.sku}
                      className={`warehouse-bin ${condition(row)} ${selected?.sku === row.sku ? 'is-selected' : ''}`}
                      style={{ '--bin-height': `${46 + (index % 3) * 12}px` } as CSSProperties}
                      aria-label={`Секция ${row.supplier_article}: ${labels[condition(row)]}`}
                      aria-pressed={selected?.sku === row.sku}
                      onClick={() => setSelectedSku(row.sku)}
                    >
                      <span className="warehouse-bin-top">
                        <Box size={23} />
                        <strong>{row.supplier_article}</strong>
                      </span>
                      <span className="warehouse-bin-front">
                        <b>{String(index + currentPage * 12 + 1).padStart(2, '0')}</b>
                        <i />
                        <i />
                      </span>
                      <span className="warehouse-bin-side" />
                    </button>
                  ))}
                </div>
              </div>
              {!visible.length && (
                <div className="warehouse-empty">
                  <Box size={26} />
                  <strong>Таких позиций нет</strong>
                  <p>Выберите «Весь склад», чтобы увидеть товары.</p>
                </div>
              )}
              <div className="warehouse-camera">
                <span>Ракурс</span>
                <button
                  aria-label="Повернуть склад влево"
                  onClick={() => setRotation((value) => Math.max(-60, value - 12))}
                  disabled={rotation <= -60}
                >
                  <ChevronLeft size={17} />
                </button>
                <button aria-label="Сбросить ракурс склада" onClick={() => setRotation(-26)}>
                  <RotateCcw size={15} />
                </button>
                <button
                  aria-label="Повернуть склад вправо"
                  onClick={() => setRotation((value) => Math.min(15, value + 12))}
                  disabled={rotation >= 15}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              <div className="warehouse-legend">
                {(['healthy', 'warning', 'critical', 'missing'] as const).map((key) => (
                  <span key={key}>
                    <i className={key} />
                    {labels[key]}
                  </span>
                ))}
              </div>
            </div>
            <aside className="warehouse-inspector" aria-live="polite">
              {selected ? (
                <>
                  <div className="warehouse-inspector-top">
                    <span>ВЫБРАННАЯ ПОЗИЦИЯ</span>
                    <Box size={18} />
                  </div>
                  <span className={`warehouse-status ${condition(selected)}`}>
                    {labels[condition(selected)]}
                  </span>
                  <h3>{selected.name}</h3>
                  <p className="warehouse-article">
                    {selected.supplier_article} ·{' '}
                    {selected.supplier_id === 'iek' ? 'IEK' : 'Systeme Electric'}
                  </p>
                  <dl>
                    <div>
                      <dt>Свободный остаток</dt>
                      <dd>
                        {number(selected.available_stock)}{' '}
                        <small>{selected.available_stock !== null && selected.unit}</small>
                      </dd>
                    </div>
                    <div>
                      <dt>Ожидается в пути</dt>
                      <dd>
                        {number(selected.eligible_incoming)} <small>{selected.unit}</small>
                      </dd>
                    </div>
                    <div className="warehouse-order">
                      <dt>К заказу по расчёту</dt>
                      <dd>
                        {selected.data_status === 'missing'
                          ? '—'
                          : number(selected.recommended_qty)}{' '}
                        <small>{selected.data_status !== 'missing' && selected.unit}</small>
                      </dd>
                    </div>
                  </dl>
                  <button className="primary" onClick={() => onProduct(selected)}>
                    Почему такой заказ? <ArrowUpRight size={17} />
                  </button>
                  <button
                    className="warehouse-scenario-button"
                    disabled={busy}
                    onClick={onScenario}
                  >
                    <SlidersHorizontal size={16} /> А если поставка опоздает?
                  </button>
                </>
              ) : (
                <p>Нет позиций для выбранного фильтра.</p>
              )}
            </aside>
          </div>
          <footer className="warehouse-footer">
            <span>
              Визуальная схема · расположение и размеры секций условные, цвета и числа — из расчёта.
            </span>
            <div>
              <span>
                {visible.length ? currentPage * 12 + 1 : 0}–{currentPage * 12 + visible.length} из{' '}
                {filtered.length}
              </span>
              <button
                aria-label="Предыдущие секции склада"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                aria-label="Следующие секции склада"
                disabled={currentPage >= maxPage}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </footer>
        </div>
      )}
    </section>
  );
}
