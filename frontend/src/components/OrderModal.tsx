import { useState } from 'react';
import { Check, Download, FileCheck2, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { DataMode, Draft, Gateway, Recommendation } from '../types';
import { downloadBlob, number, supplierName } from '../lib/format';
import { Modal } from './Modal';
export function OrderModal({
  rows,
  gateway,
  run,
  mode,
  onClose,
}: {
  rows: Recommendation[];
  gateway: Gateway;
  run: string;
  mode: DataMode;
  onClose: () => void;
}) {
  const suppliers = [...new Set(rows.map((r) => r.supplier_id))];
  const [supplier, setSupplier] = useState(suppliers[0] || 'systeme');
  const [amounts, setAmounts] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((r) => [r.sku, String(r.recommended_qty)])),
  );
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const current = rows.filter((r) => r.supplier_id === supplier);
  const draft = approved[supplier];
  const invalid = current.some(
    (r) =>
      amounts[r.sku].trim() === '' ||
      !Number.isFinite(Number(amounts[r.sku])) ||
      Number(amounts[r.sku]) < 0 ||
      (r.unit === 'шт' && !Number.isInteger(Number(amounts[r.sku]))) ||
      (Number(amounts[r.sku]) !== r.recommended_qty && !reasons[r.sku]?.trim()) ||
      r.available_stock === null,
  );
  async function approve() {
    if (invalid || !current.length) return;
    setBusy(true);
    setError('');
    try {
      const draft = await gateway.createDraft(
        run,
        supplier,
        current.map((r) => ({
          sku: r.sku,
          quantity: Number(amounts[r.sku]),
          reason: reasons[r.sku] || '',
        })),
      );
      const result = await gateway.approve(draft.draft_id, draft.version);
      if (result.status !== 'approved') throw new Error('Сервер не подтвердил утверждение заказа.');
      setApproved({ ...approved, [supplier]: result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportOrder() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const blob = await gateway.exportDraft(draft.draft_id);
      downloadBlob(
        blob,
        `QOR-${mode === 'demo' ? 'DEMO-' : ''}${supplier}-${draft.draft_id.slice(0, 8)}.csv`,
      );
      setDownloaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Проверка заказа"
      subtitle="Проверьте количества перед утверждением черновика."
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="order-tabs">
        {suppliers.map((s) => (
          <button
            disabled={busy}
            key={s}
            className={s === supplier ? 'active' : ''}
            onClick={() => {
              setSupplier(s);
              setError('');
              setDownloaded(false);
            }}
          >
            {supplierName(s)} {approved[s] && <Check size={14} />}
          </button>
        ))}
      </div>
      {mode === 'demo' && (
        <div className="notice">
          <ShieldCheck size={16} /> Демонстрационный заказ. Сохраняется до обновления страницы и не
          отправляется поставщику.
        </div>
      )}
      <div className="order-lines">
        {current.map((r) => (
          <div className="order-line" key={r.sku}>
            <div>
              <strong>{r.name}</strong>
              <span>
                {r.supplier_article} · рекомендовано {number(r.recommended_qty)} {r.unit}
              </span>
            </div>
            <label className="amount-input">
              <input
                aria-label={`Количество ${r.supplier_article}`}
                type="number"
                min="0"
                step={r.unit === 'шт' ? '1' : '0.01'}
                value={amounts[r.sku]}
                disabled={!!draft || busy}
                onChange={(e) => setAmounts({ ...amounts, [r.sku]: e.target.value })}
              />
              <span>{r.unit}</span>
            </label>
            {Number(amounts[r.sku]) !== r.recommended_qty && (
              <input
                className="reason-input"
                aria-label={`Причина изменения ${r.supplier_article}`}
                placeholder="Причина изменения (обязательно)"
                maxLength={300}
                value={reasons[r.sku] || ''}
                disabled={!!draft || busy}
                onChange={(e) => setReasons({ ...reasons, [r.sku]: e.target.value })}
              />
            )}
          </div>
        ))}
      </div>
      {!current.length && <p>Выберите позиции в таблице рекомендаций.</p>}
      {invalid && (
        <p className="text-error" role="status">
          Проверьте количества и заполните причины изменений. Для штучных товаров нужны целые
          значения.
        </p>
      )}
      <p className="small muted">
        Файл содержит код 1С, артикул, единицу и утверждённое количество. Импорт в конкретную
        конфигурацию 1С требует согласования формата.
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {draft && (
        <div className="success-box" role="status">
          <Check size={18} /> Черновик утверждён.{' '}
          {downloaded ? 'CSV скачан.' : 'Теперь можно скачать CSV.'}
        </div>
      )}
      <footer className="modal-footer">
        <span className="small muted">
          {current.length} позиций · {supplierName(supplier)}
        </span>
        {draft ? (
          <button className="primary" onClick={exportOrder} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Скачать
            CSV
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || invalid || !current.length}
            onClick={approve}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}{' '}
            Утвердить черновик
          </button>
        )}
      </footer>
    </Modal>
  );
}
