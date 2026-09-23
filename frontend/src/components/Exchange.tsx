import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  Upload,
  TriangleAlert,
} from 'lucide-react';
import { api, request } from '../lib/api';
import { downloadBlob } from '../lib/format';
import type { Dataset } from '../types';
import './Exchange.css';

interface ImportJob {
  import_id: string;
  status: string;
  dataset_id: string | null;
  error: string | null;
}
const JOB_KEY = 'qor-last-import';
export function Exchange({ onOpen }: { onOpen: (dataset: Dataset) => void }) {
  const [supplier, setSupplier] = useState('systeme_electric');
  const [files, setFiles] = useState<File[]>([]);
  const [token, setToken] = useState('');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const mounted = useRef(true);
  async function refresh() {
    try {
      const list = await api.datasets();
      if (mounted.current) setDatasets(list.filter((d) => d.mode === 'real'));
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const saved = sessionStorage.getItem(JOB_KEY);
    if (saved)
      void request<ImportJob>(`/imports/${encodeURIComponent(saved)}`)
        .then((j) => {
          if (mounted.current) setJob(j);
        })
        .catch(() => sessionStorage.removeItem(JOB_KEY));
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = job && ['queued', 'running'].includes(job.status);
  useEffect(() => {
    if (!active || !job) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await request<ImportJob>(`/imports/${job.import_id}`);
        if (stop) return;
        setJob(current);
        if (current.status === 'completed') {
          setError('');
          void refresh();
        } else if (current.status === 'failed' || current.status === 'interrupted')
          setError(current.error || 'Импорт прерван. Повторите загрузку.');
        else timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!stop) {
          setError((e as Error).message);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [job?.import_id, active]);
  async function upload() {
    setError('');
    if (files.length < 6 || files.length > 7) {
      setError('Выберите шесть XLSX одного поставщика и, при необходимости, inventory.csv.');
      return;
    }
    if (files.reduce((s, f) => s + f.size, 0) > 64 * 1024 * 1024) {
      setError('Общий размер файлов должен быть не больше 64 МБ.');
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f));
      form.set('supplier', supplier);
      form.set('mapping_version', 'hackalem-2026-v1');
      form.set('as_of', '2026-09-22');
      form.set('warehouse_id', 'Все склады');
      const current = await request<ImportJob>('/imports', {
        method: 'POST',
        headers: { 'X-Admin-Token': token },
        body: form,
      });
      sessionStorage.setItem(JOB_KEY, current.import_id);
      setJob(current);
      setToken('');
      if (current.status === 'completed') void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || !!active;
  return (
    <section className="exchange-view">
      <div className="exchange-path panel">
        <div>
          <span>01</span>
          <strong>Выгрузки из 1С</strong>
          <small>Исходные Excel компании</small>
        </div>
        <ArrowRight size={22} />
        <div>
          <span>02</span>
          <strong>Проверка и расчёт</strong>
          <small>По кодам товаров и единицам</small>
        </div>
        <ArrowRight size={22} />
        <div>
          <span>03</span>
          <strong>Утверждённый заказ</strong>
          <small>CSV для загрузки в учётную систему</small>
        </div>
      </div>
      <div className="exchange-grid">
        <section className="panel exchange-upload">
          <div className="section-title">
            <h2>
              <Upload size={20} /> Загрузить данные компании
            </h2>
            <span className="micro-label">XLSX · до 64 МБ</span>
          </div>
          <p>
            Профиль исходных файлов HackAlem от 22 сентября 2026 года. По одному комплекту на
            поставщика.
          </p>
          <label className="field-label" htmlFor="import-supplier">
            Поставщик
          </label>
          <select
            id="import-supplier"
            value={supplier}
            disabled={locked}
            onChange={(e) => setSupplier(e.target.value)}
          >
            <option value="systeme_electric">Systeme Electric</option>
            <option value="iek">IEK</option>
          </select>
          <ul className="exchange-checklist">
            {[
              'Динамика продаж',
              'Продажи по месяцам',
              'Остатки по месяцам',
              'Товар в пути',
              'Сезонность',
              'MOQ / кратность',
            ].map((s) => (
              <li key={s}>
                <FileSpreadsheet size={15} />
                {s}
              </li>
            ))}
          </ul>
          <label className="exchange-drop">
            <Upload size={26} />
            <strong>Выберите комплект выгрузок</strong>
            <span>Шесть XLSX и необязательный inventory.csv</span>
            <input
              aria-label="Файлы выгрузок 1С"
              type="file"
              accept=".xlsx,.csv"
              multiple
              disabled={locked}
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
          </label>
          {!!files.length && (
            <ul className="exchange-files">
              {files.map((f, i) => (
                <li key={i}>
                  <FileSpreadsheet size={15} />
                  <span>{f.name}</span>
                  <small>{Math.ceil(f.size / 1024)} КБ</small>
                </li>
              ))}
            </ul>
          )}
          <label className="field-label" htmlFor="import-token">
            Ключ загрузки администратора
          </label>
          <input
            id="import-token"
            type="password"
            autoComplete="off"
            value={token}
            disabled={locked}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN у капитана команды"
          />
          <p className="small muted">
            Ключ нужен для загрузки файлов на сервер. Он не сохраняется в браузере.
          </p>
          {error && (
            <div role="alert" className="error-box">
              {error}
            </div>
          )}
          {job && (
            <div className={job.status === 'completed' ? 'success-box' : 'notice'} role="status">
              {active ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
              <span>
                {active
                  ? 'Файлы обрабатываются. Можно перейти в другой раздел.'
                  : job.status === 'completed'
                    ? 'Импорт завершён. Откройте набор ниже, чтобы рассчитать закупку.'
                    : `Состояние импорта: ${job.status}`}
              </span>
            </div>
          )}
          <button
            className="primary"
            disabled={locked || !token.trim() || !files.length}
            onClick={upload}
          >
            {locked ? <LoaderCircle size={17} className="spin" /> : <Upload size={17} />} Проверить
            и загрузить
          </button>
        </section>
        <aside className="exchange-aside">
          <section className="panel">
            <h2>Актуальный остаток</h2>
            <p>
              Месячный начальный остаток — не свободный запас на сегодня. Для IEK добавьте файл{' '}
              <strong>inventory.csv</strong> с подтверждёнными остатками в охвате «Все склады».
            </p>
            <button
              className="secondary"
              onClick={() =>
                downloadBlob(
                  new Blob(['\uFEFFsku_1c;stock_unit;available_stock;as_of;warehouse_id\r\n'], {
                    type: 'text/csv;charset=utf-8',
                  }),
                  'inventory.csv',
                )
              }
            >
              <Download size={16} /> Скачать шаблон остатков
            </button>
            <p className="small muted">
              Столбцы: код 1С, складская единица, свободный остаток, дата 2026-09-22, Все склады.
              Коды сохраняйте текстом.
            </p>
          </section>
          <section className="panel">
            <h2>Обратно в 1С</h2>
            <p>Откройте план закупок → проверьте позиции → утвердите заказ → скачайте CSV.</p>
            <p className="small muted">
              UTF-8 с BOM, разделитель «;». Есть код 1С, артикул, количество, единицы и причина
              изменения.
            </p>
            <div className="notice">
              <TriangleAlert size={18} />
              <span>
                Это файловый обмен. Загрузку CSV в конкретную конфигурацию 1С нужно проверить с её
                обработкой импорта. Прямое подключение к базе не настроено.
              </span>
            </div>
          </section>
        </aside>
      </div>
      <section className="panel exchange-datasets">
        <div className="section-title">
          <h2>Загруженные наборы</h2>
          <button className="text-button" onClick={refresh}>
            Обновить список
          </button>
        </div>
        {!datasets.length ? (
          <p className="muted">В этой сессии ещё нет загруженных данных компании.</p>
        ) : (
          datasets.map((d) => (
            <article key={d.id}>
              <FileSpreadsheet size={22} />
              <div>
                <strong>{d.name}</strong>
                <span>
                  {d.warehouse} · {d.as_of}
                </span>
              </div>
              <button className="secondary" onClick={() => onOpen(d)}>
                Открыть расчёт <ArrowRight size={16} />
              </button>
            </article>
          ))
        )}
      </section>
    </section>
  );
}
