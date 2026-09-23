import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  CircleHelp,
  FileCheck2,
  LoaderCircle,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import type { DataMode, Explanation, Gateway, ProductDetail, Recommendation } from '../types';
import { number, riskLabel, supplierName } from '../lib/format';
import { Modal } from './Modal';
import { HistoryChart, StockChart } from './Charts';
export function Detail({
  row,
  run,
  gateway,
  mode,
  onClose,
  scenario,
}: {
  row: Recommendation;
  run: string;
  gateway: Gateway;
  mode: DataMode;
  onClose: () => void;
  scenario: boolean;
}) {
  const [data, setData] = useState<ProductDetail | null>(null);
  const [error, setError] = useState('');
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [aiError, setAiError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    gateway
      .detail(run, row.sku)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [gateway, run, row.sku, retry]);
  async function explain() {
    setExplaining(true);
    setAiError('');
    try {
      setExplanation(await gateway.explain(run, row.sku));
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setExplaining(false);
    }
  }
  return (
    <Modal
      title="Паспорт решения"
      subtitle={`${supplierName(row.supplier_id)} · ${row.supplier_article}`}
      onClose={onClose}
      wide
    >
      <div className="detail-product">
        <div className="product-glyph">
          <FileCheck2 size={28} />
        </div>
        <div>
          <h3>{row.name}</h3>
          <span className="muted">
            Код 1С {row.sku_1c || row.sku} · {row.category}
          </span>
        </div>
        <span className={`badge ${row.risk_status}`}>{riskLabel[row.risk_status]}</span>
      </div>
      {row.warnings.map((w) => (
        <div className="notice" key={w}>
          <TriangleAlert size={16} />
          <span>{w}</span>
        </div>
      ))}
      <div className="formula">
        <div>
          <span>Прогноз</span>
          <strong>{number(row.forecast_qty)}</strong>
        </div>
        <b>+</b>
        <div>
          <span>Страховой</span>
          <strong>{number(row.safety_stock)}</strong>
        </div>
        <b>−</b>
        <div>
          <span>Свободно</span>
          <strong>{number(row.available_stock)}</strong>
        </div>
        <b>−</b>
        <div>
          <span>В пути</span>
          <strong>{number(row.eligible_incoming)}</strong>
        </div>
        <b>=</b>
        <div className="formula-result">
          <span>К заказу</span>
          <strong>
            {row.available_stock === null ? '—' : number(row.recommended_qty)}{' '}
            <small>{row.unit}</small>
          </strong>
        </div>
      </div>
      <p className="small muted">
        Прогноз, запас и поступления — в {row.stock_unit || row.unit}. Потребность{' '}
        {number(row.raw_need)} делится на{' '}
        {number(row.stock_units_per_order_unit ?? (mode === 'demo' ? 1 : null))} и округляется по
        минимуму {row.moq ?? 0} и шагу {row.order_step ?? 1} в {row.unit}.
      </p>
      <div className="factor-grid">
        {row.factors.map((f) => (
          <div key={f.label}>
            <span>{f.label}</span>
            <strong>{f.value}</strong>
          </div>
        ))}
      </div>
      {error ? (
        <div role="alert" className="error-box">
          {error}
          <button onClick={() => setRetry((v) => v + 1)}>Повторить</button>
        </div>
      ) : !data ? (
        <div className="chart-skeleton" aria-label="Загрузка графиков">
          <LoaderCircle className="spin" /> Загружаем историю…
        </div>
      ) : (
        <div className="detail-charts">
          <section>
            <h4>
              Что происходило со спросом <ArrowUpRight size={16} />
            </h4>
            <HistoryChart data={data.history} />
            <p className="chart-note">
              Столбцы — продажи · линия — регулярный спрос. * Неполный месяц.
            </p>
          </section>
          <section>
            <h4>
              Что произойдёт с запасом <ArrowDown size={16} />
            </h4>
            <>
              {row.available_stock === null ? (
                <div className="chart-skeleton">Нужен актуальный остаток для прогноза запаса.</div>
              ) : (
                <StockChart data={data.projection} scenario={scenario} />
              )}
            </>
            <p className="chart-note">{data.method}</p>
          </section>
        </div>
      )}
      <section className="explanation">
        <div className="section-title">
          <h3>
            <Sparkles size={18} /> Объяснение решения
          </h3>
          <span className="micro-label">{mode === 'demo' ? 'ШАБЛОН · ДЕМО' : 'ИИ ПО ЗАПРОСУ'}</span>
        </div>
        <p>
          Потребность рассчитывается из прогноза и страхового запаса. Текущий запас и своевременные
          поставки уменьшают заказ. Округление учитывает единицы и кратность.
        </p>
        {explanation && (
          <div className="explanation-result">
            <span className="tiny muted">
              {explanation.mode === 'generated'
                ? `ИИ · ${explanation.provider}`
                : 'Расчётное объяснение · без генерации ИИ'}
            </span>
            <p>{explanation.text}</p>
          </div>
        )}
        {aiError && (
          <p role="alert" className="text-error">
            {aiError}
          </p>
        )}
        <button className="secondary" disabled={explaining} onClick={explain}>
          {explaining ? <LoaderCircle className="spin" size={16} /> : <CircleHelp size={16} />}{' '}
          {mode === 'demo' ? 'Показать расчётное объяснение' : 'Объяснить с помощью ИИ'}
        </button>
      </section>
    </Modal>
  );
}
