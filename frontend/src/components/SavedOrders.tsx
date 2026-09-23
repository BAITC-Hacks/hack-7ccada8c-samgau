import { useEffect, useState } from 'react';
import type { Draft, Gateway } from '../types';
import { Modal } from './Modal';
import { OrderModal } from './OrderModal';
import { supplierName } from '../lib/format';
export function SavedOrders({ gateway, onClose }: { gateway: Gateway; onClose: () => void }) {
  const [items, setItems] = useState<Draft[]>([]),
    [chosen, setChosen] = useState<Draft | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    gateway
      .listDrafts?.()
      .then(setItems)
      .catch((e) => setError(e.message));
  }, [gateway]);
  if (chosen)
    return (
      <OrderModal
        rows={chosen.lines!.map((l) => ({
          ...l.recommendation,
          key: JSON.stringify([chosen.supplier_id, l.recommendation.sku]),
        }))}
        gateway={gateway}
        run={chosen.run_id!}
        mode="api"
        initialDraft={chosen}
        onClose={onClose}
      />
    );
  return (
    <Modal
      title="Сохранённые заказы"
      subtitle="Черновики и утверждённые снимки текущей сессии"
      onClose={onClose}
    >
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
      {!items.length && !error && <p>Сохранённых заказов пока нет.</p>}
      {items.map((d) => (
        <p key={d.draft_id}>
          <button className="secondary" onClick={() => setChosen(d)}>
            {supplierName(d.supplier_id || '')} · {d.draft_id.slice(0, 8)} · {d.status} · версия{' '}
            {d.version}
          </button>
        </p>
      ))}
    </Modal>
  );
}
