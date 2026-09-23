import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, LoaderCircle, Sparkles, TrendingUp } from 'lucide-react';
import type { DataMode, Gateway, Scenario, Supplier, Shipment } from '../types';
import { supplierName } from '../lib/format';
import { Modal } from './Modal';
export function ScenarioModal({
  gateway,
  mode,
  supplier,
  run,
  suppliers,
  onApply,
  onClose,
}: {
  gateway: Gateway;
  mode: DataMode;
  supplier: Supplier;
  run: string;
  suppliers: string[];
  onApply: (values: Scenario) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Scenario>({
    delay_days: 0,
    demand_change_pct: 0,
    supplier_id: supplier,
  });
  const [shipments, setShipments] = useState<Shipment[]>([]);
  useEffect(() => {
    let active = true;
    gateway
      .shipments?.(run)
      .then((s) => {
        if (active) setShipments(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [gateway, run]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function parse() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await gateway.parseScenario(text, values.supplier_id, run, values.shipment_id);
      if (result.needs_clarification) setMessage(result.message || 'Уточните параметры сценария.');
      else {
        const p = result.parameters;
        if (
          !Number.isFinite(p.delay_days) ||
          !Number.isFinite(p.demand_change_pct) ||
          p.delay_days < 0 ||
          p.delay_days > 30 ||
          p.demand_change_pct < -50 ||
          p.demand_change_pct > 100 ||
          !['all', ...suppliers].includes(p.supplier_id)
        )
          throw new Error('ИИ вернул параметры вне разрешённых границ. Задайте их вручную.');
        setValues(p);
        setMessage('Параметры распознаны. Проверьте их перед сравнением.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError('');
    try {
      await onApply(values);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Репетиция закупки"
      subtitle="Измените условия. Посмотрите последствия до заказа."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="scenario-intro">
        <Sparkles size={22} />
        <p>
          Что, если поставка задержится?
          <br />
          <span>Исходные данные останутся без изменений.</span>
        </p>
      </div>
      <label className="field-label" htmlFor="scenario-supplier">
        Поставщик
      </label>
      <select
        id="scenario-supplier"
        value={values.supplier_id}
        onChange={(e) =>
          setValues({ ...values, supplier_id: e.target.value as Supplier, shipment_id: undefined })
        }
        disabled={busy}
      >
        <option value="all">Все поставщики</option>
        {suppliers.map((s) => (
          <option key={s} value={s}>
            {supplierName(s)}
          </option>
        ))}
      </select>
      {mode === 'api' && (
        <label className="field-label">
          Выбранная поставка
          <select
            aria-label="Выбранная поставка"
            value={values.shipment_id || ''}
            disabled={busy || values.supplier_id === 'all'}
            onChange={(e) => setValues({ ...values, shipment_id: e.target.value || undefined })}
          >
            <option value="">Выберите поставку для задержки</option>
            {shipments
              .filter((s) => s.supplier_id === values.supplier_id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sku} · {s.quantity} складских единиц · {s.eta} · {s.id}
                </option>
              ))}
          </select>
        </label>
      )}
      <div className="range-heading">
        <label htmlFor="delay">
          <Clock3 size={16} /> Задержка выбранной поставки
        </label>
        <strong>+{values.delay_days} дней</strong>
      </div>
      <input
        id="delay"
        type="range"
        min="0"
        max="30"
        value={values.delay_days}
        disabled={busy}
        onChange={(e) => setValues({ ...values, delay_days: Number(e.target.value) })}
      />
      <div className="range-ends">
        <span>Без задержки</span>
        <span>30 дней</span>
      </div>
      <div className="range-heading">
        <label htmlFor="demand">
          <TrendingUp size={16} /> Изменение спроса
        </label>
        <strong>
          {values.demand_change_pct > 0 ? '+' : ''}
          {values.demand_change_pct}%
        </strong>
      </div>
      <input
        id="demand"
        type="range"
        min="-50"
        max="100"
        step="5"
        value={values.demand_change_pct}
        disabled={busy}
        onChange={(e) => setValues({ ...values, demand_change_pct: Number(e.target.value) })}
      />
      <div className="range-ends">
        <span>−50%</span>
        <span>+100%</span>
      </div>
      <div className="presets">
        <button
          disabled={busy}
          onClick={() => setValues({ ...values, delay_days: 7, demand_change_pct: 0 })}
        >
          Задержка на неделю
        </button>
        <button
          disabled={busy}
          onClick={() => setValues({ ...values, delay_days: 0, demand_change_pct: 20 })}
        >
          Спрос +20%
        </button>
      </div>
      <div className="ai-input">
        <label htmlFor="scenario-text">
          <Sparkles size={15} /> Или опишите словами{' '}
          {mode === 'demo' && <span>· доступно с API</span>}
        </label>
        <textarea
          id="scenario-text"
          placeholder="Поставки IEK задержатся на неделю, спрос вырастет на 20%"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={600}
          disabled={mode === 'demo' || busy}
        />
        <button
          className="text-button"
          onClick={parse}
          disabled={mode === 'demo' || busy || !text.trim() || values.supplier_id === 'all'}
        >
          Распознать параметры <ArrowRight size={14} />
        </button>
      </div>
      {mode === 'demo' && (
        <p className="small muted">
          Сценарий использует синтетический пример. ИИ в деморежиме не вызывается.
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <footer className="modal-footer">
        <button className="secondary" onClick={onClose} disabled={busy}>
          Отмена
        </button>
        <button
          className="primary"
          onClick={apply}
          disabled={
            busy ||
            (mode === 'api' &&
              values.delay_days > 0 &&
              (!values.shipment_id || values.supplier_id === 'all'))
          }
        >
          {busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />} Сравнить
          сценарии
        </button>
      </footer>
    </Modal>
  );
}
