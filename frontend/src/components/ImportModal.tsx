import { useEffect, useRef, useState } from 'react';
import { request } from '../lib/api';
import { Modal } from './Modal';
type Job = {
  import_id: string;
  status: string;
  progress: number;
  dataset_id?: string;
  error?: string;
};
export function ImportModal({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: (id: string) => Promise<void>;
}) {
  const [token, setToken] = useState(''),
    [supplier, setSupplier] = useState('systeme_electric'),
    [date, setDate] = useState('2026-09-22'),
    [warehouse, setWarehouse] = useState('synthetic-almaty');
  const [files, setFiles] = useState<File[]>([]),
    [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function start() {
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('supplier', supplier);
      form.set('mapping_version', 'qor-explicit-xlsx-v1');
      form.set('as_of', date);
      form.set('warehouse_id', warehouse);
      files.forEach((f) => form.append('files', f));
      let result = await request<Job>('/imports', {
        method: 'POST',
        headers: { 'X-Admin-Token': token },
        body: form,
      });
      setToken('');
      setJob(result);
      for (
        let attempt = 0;
        active.current && ['queued', 'running'].includes(result.status) && attempt < 120;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await request<Job>(`/imports/${encodeURIComponent(result.import_id)}`);
        if (active.current) setJob(result);
      }
      if (result.status === 'completed' && result.dataset_id) await onComplete(result.dataset_id);
      else if (active.current)
        setError(
          result.error ||
            `Статус ${result.status}. ID импорта: ${result.import_id}. Повторно проверьте статус через API.`,
        );
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="Импорт XLSX"
      subtitle="Шесть книг одного поставщика с листом _QOR_IMPORT. Набор доступен только текущей сессии."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <label className="field-label">
        Ключ администратора
        <input
          aria-label="Ключ администратора"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="field-label">
        Поставщик
        <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="systeme_electric">Systeme Electric</option>
          <option value="iek">IEK</option>
        </select>
      </label>
      <label className="field-label">
        Дата снимка
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field-label">
        Код склада
        <input value={warehouse} onChange={(e) => setWarehouse(e.target.value)} />
      </label>
      <input
        aria-label="Шесть файлов XLSX"
        type="file"
        multiple
        accept=".xlsx"
        disabled={busy}
        onChange={(e) => setFiles(Array.from(e.target.files || []))}
      />
      <p className="small">
        Профиль qor-explicit-xlsx-v1. Произвольные выгрузки 1С требуют предварительного
        сопоставления колонок. Ключ не сохраняется.
      </p>
      {job && (
        <p role="status">
          {job.status} · {job.progress}%
        </p>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <footer className="modal-footer">
        <button
          className="primary"
          disabled={busy || files.length !== 6 || !token || !warehouse || !date}
          onClick={start}
        >
          Загрузить и проверить
        </button>
      </footer>
    </Modal>
  );
}
