import { useEffect, useState } from 'react';
import { Check, Download, FileCheck2, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { DataMode, Draft, Gateway, Recommendation } from '../types';
import { downloadBlob, number, supplierName } from '../lib/format';
import { ApiError } from '../lib/api';
import { rowKey, validForOrder } from '../types';
import { Modal } from './Modal';
export function OrderModal({
  rows,
  gateway,
  run,
  mode,
  onClose,
  initialDraft,
}: {
  rows: Recommendation[];
  gateway: Gateway;
  run: string;
  mode: DataMode;
  onClose: () => void;
  initialDraft?: Draft;
}) {
  const suppliers = [...new Set(rows.map((r) => r.supplier_id))];
  const storageKey = `qor-order:${mode}:${run}:${rows.map(rowKey).sort().join('|')}`;
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) || '{}');
    } catch {
      return {};
    }
  })();
  const [supplier, setSupplier] = useState(suppliers[0] || 'systeme_electric');
  const [amounts, setAmounts] = useState<Record<string, string>>(
    saved.amounts ||
      Object.fromEntries(
        rows.map((r) => [
          rowKey(r),
          String(
            initialDraft?.lines?.find((l) => l.recommendation.sku === r.sku)?.approved_qty ??
              r.recommended_qty ??
              '',
          ),
        ]),
      ),
  );
  const [reasons, setReasons] = useState<Record<string, string>>(
    saved.reasons ||
      Object.fromEntries(
        rows.map((r) => [
          rowKey(r),
          initialDraft?.lines?.find((l) => l.recommendation.sku === r.sku)?.reason || '',
        ]),
      ),
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>(
    initialDraft ? { [initialDraft.supplier_id!]: initialDraft } : saved.drafts || {},
  );
  const [restoring, setRestoring] = useState(!!gateway.getDraft && Object.keys(drafts).length > 0);
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const current = rows.filter((r) => r.supplier_id === supplier);
  const currentDraft = drafts[supplier];
  const draft = currentDraft?.status === 'approved' ? currentDraft : undefined;
  const warnings = [
    ...new Set(current.flatMap((r) => [...r.warnings, ...(r.approval_blockers || [])])),
  ];
  const needsAcknowledgement =
    warnings.length > 0 || current.some((r) => r.data_status === 'review');
  const invalid = current.some(
    (r) =>
      !validForOrder(r) ||
      !amounts[rowKey(r)]?.trim() ||
      !Number.isFinite(Number(amounts[rowKey(r)])) ||
      Number(amounts[rowKey(r)]) < 0 ||
      (Number(amounts[rowKey(r)]) !== r.recommended_qty &&
        (reasons[rowKey(r)]?.trim().length || 0) < 3),
  );
  useEffect(() => {
    if (mode === 'api')
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          amounts,
          reasons,
          drafts: Object.fromEntries(
            Object.entries(drafts).map(([supplier, d]) => [
              supplier,
              {
                draft_id: d.draft_id,
                version: d.version,
                status: d.status,
                supplier_id: d.supplier_id,
                run_id: d.run_id,
              },
            ]),
          ),
        }),
      );
  }, [amounts, reasons, drafts, mode, storageKey]);
  useEffect(() => {
    let active = true;
    if (gateway.getDraft)
      Promise.all(
        Object.entries(drafts).map(
          async ([s, d]) => [s, await gateway.getDraft!(d.draft_id)] as const,
        ),
      )
        .then((entries) => {
          if (active && entries.length) {
            setDrafts(Object.fromEntries(entries));
            entries.forEach(([, d]) => applyApproved(d));
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setRestoring(false);
        });
    return () => {
      active = false;
    };
  }, [gateway]);
  function applyApproved(d: Draft) {
    if (d.status !== 'approved' || !d.lines) return;
    const amounts: Record<string, string> = {},
      reasons: Record<string, string> = {};
    for (const line of d.lines) {
      const row = rows.find(
        (r) => r.sku === line.recommendation.sku && r.supplier_id === (d.supplier_id || supplier),
      );
      if (row) {
        amounts[rowKey(row)] = String(line.approved_qty ?? '');
        reasons[rowKey(row)] = line.reason;
      }
    }
    setAmounts((previous) => ({ ...previous, ...amounts }));
    setReasons((previous) => ({ ...previous, ...reasons }));
  }
  function remember(d: Draft) {
    applyApproved(d);
    setDrafts((previous) => ({ ...previous, [supplier]: d }));
    return d;
  }
  async function save() {
    const lines = current.map((r) => ({
      sku: r.sku,
      quantity: Number(amounts[rowKey(r)]),
      reason: reasons[rowKey(r)] || '',
    }));
    let d = currentDraft;
    if (!d) d = remember(await gateway.createDraft(run, supplier, lines));
    if (d.status === 'approved') return d;
    if (gateway.patchDraft) {
      const changes = lines.filter(
        (l) =>
          l.quantity !==
          d!.lines?.find((saved) => saved.recommendation.sku === l.sku)?.approved_qty,
      );
      if (changes.length) d = remember(await gateway.patchDraft(d.draft_id, d.version, changes));
    }
    return d;
  }
  async function perform(approve: boolean) {
    if (invalid || !current.length) return;
    setBusy(true);
    setError('');
    try {
      const d = await save();
      if (approve && d.status !== 'approved')
        remember(await gateway.approve(d.draft_id, d.version, acknowledge));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && gateway.getDraft) {
        const latest = drafts[supplier];
        if (latest) {
          try {
            remember(await gateway.getDraft(latest.draft_id));
          } catch {
            /* retain conflict */
          }
        }
        setAcknowledge(false);
      }
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
  const locked = busy || restoring;
  return (
    <Modal
      title="Проверка заказа"
      subtitle="Проверьте количества перед утверждением черновика."
      onClose={() => {
        if (!locked) onClose();
      }}
      wide
    >
      <div className="order-tabs">
        {suppliers.map((s) => (
          <button
            disabled={locked}
            key={s}
            className={s === supplier ? 'active' : ''}
            onClick={() => {
              setSupplier(s);
              setAcknowledge(false);
              setError('');
              setDownloaded(false);
            }}
          >
            {supplierName(s)} {drafts[s]?.status === 'approved' && <Check size={14} />}
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
          <div className="order-line" key={rowKey(r)}>
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
                step={r.order_step || 'any'}
                value={amounts[rowKey(r)]}
                disabled={!!draft || locked}
                onChange={(e) => {
                  setAmounts({ ...amounts, [rowKey(r)]: e.target.value });
                  setAcknowledge(false);
                }}
              />
              <span>{r.unit}</span>
            </label>
            {Number(amounts[rowKey(r)]) !== r.recommended_qty && (
              <input
                className="reason-input"
                aria-label={`Причина изменения ${r.supplier_article}`}
                placeholder="Причина изменения (обязательно)"
                maxLength={300}
                value={reasons[rowKey(r)] || ''}
                disabled={!!draft || locked}
                onChange={(e) => setReasons({ ...reasons, [rowKey(r)]: e.target.value })}
              />
            )}
          </div>
        ))}
      </div>
      {!current.length && <p>Выберите позиции в таблице рекомендаций.</p>}
      {invalid && (
        <p className="text-error" role="status">
          Проверьте количества, ограничения данных и причины изменений (не менее 3 символов).
        </p>
      )}
      <p className="small muted">
        Файл содержит код 1С, артикул, единицу и утверждённое количество. Импорт в конкретную
        конфигурацию 1С требует согласования формата.
      </p>
      {warnings.map((w) => (
        <div className="notice" key={w}>
          {w}
        </div>
      ))}
      {!draft && needsAcknowledgement && (
        <label className="notice">
          <input
            type="checkbox"
            checked={acknowledge}
            onChange={(e) => setAcknowledge(e.target.checked)}
            disabled={locked}
          />{' '}
          Я просмотрел предупреждения и подтверждаю заказ с этими ограничениями
        </label>
      )}
      {currentDraft && (
        <p className="small">
          Черновик {currentDraft.draft_id} · версия {currentDraft.version} · {currentDraft.status}
        </p>
      )}
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
          <button className="primary" onClick={exportOrder} disabled={locked}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Скачать
            CSV
          </button>
        ) : (
          <>
            {' '}
            <button
              className="secondary"
              disabled={locked || invalid}
              onClick={() => perform(false)}
            >
              Сохранить черновик
            </button>
            <button
              className="primary"
              disabled={
                locked || invalid || !current.length || (needsAcknowledgement && !acknowledge)
              }
              onClick={() => perform(true)}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}{' '}
              Утвердить черновик
            </button>
          </>
        )}
      </footer>
    </Modal>
  );
}
