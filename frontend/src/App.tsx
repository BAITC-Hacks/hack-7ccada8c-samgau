import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Box,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  MapPin,
  Package,
  PanelLeftClose,
  Play,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Truck,
  X,
} from 'lucide-react';
import type {
  DataMode,
  Dataset,
  Gateway,
  ProductDetail,
  Quality,
  Recommendation,
  Run,
  Scenario,
  Supplier,
} from './types';
import { api } from './lib/api';
import { demo } from './lib/demo';
import { date, number, riskLabel, supplierName } from './lib/format';
import { StockChart } from './components/Charts';
import { Detail } from './components/Detail';
import { Modal } from './components/Modal';
import { ScenarioModal } from './components/ScenarioModal';
import { OrderModal } from './components/OrderModal';

type View = 'overview' | 'recommendations' | 'quality';
const initialMode: DataMode = import.meta.env.VITE_DATA_MODE === 'api' ? 'api' : 'demo';
const PAGE_SIZE = 6;
export default function App() {
  const [mode, setMode] = useState<DataMode>(initialMode);
  const gateway: Gateway = mode === 'api' ? api : demo;
  const [view, setView] = useState<View>('overview');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [baseRun, setBaseRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<Recommendation[]>([]);
  const [baseRows, setBaseRows] = useState<Recommendation[]>([]);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [qualityError, setQualityError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [supplier, setSupplier] = useState<Supplier>('all');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'critical' | 'review' | 'order'>('all');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'risk' | 'name' | 'qty'>('risk');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Recommendation | null>(null);
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [chartSku, setChartSku] = useState('');
  const [chart, setChart] = useState<ProductDetail | null>(null);
  const [chartError, setChartError] = useState('');
  const [chartRetry, setChartRetry] = useState(0);
  const epoch = useRef(0);
  const tableRef = useRef<HTMLElement>(null);
  const validForOrder = (r: Recommendation) =>
    r.available_stock !== null && r.data_status !== 'missing' && r.recommended_qty > 0;

  const load = useCallback(
    async (chosen?: Dataset) => {
      const id = ++epoch.current;
      if (!chosen) {
        setDataset(null);
        setDatasets([]);
      }
      setLoading(true);
      setError('');
      setQuality(null);
      setQualityError('');
      setRun(null);
      setRows([]);
      setSelected(new Set());
      setDetail(null);
      setScenario(null);
      setChart(null);
      setOrderOpen(false);
      try {
        const available = chosen ? [chosen] : await gateway.datasets();
        if (epoch.current !== id) return;
        if (!chosen) setDatasets(available);
        const active = chosen || available[0];
        if (!active)
          throw new Error(
            'На сервере нет наборов данных. Добавьте набор через backend или откройте деморежим.',
          );
        setDataset(active);
        const result = await gateway.createRun(active.id, 'all', active.as_of);
        const resultRows = await gateway.recommendations(result.run_id);
        if (epoch.current !== id) return;
        setRun(result);
        setBaseRun(result);
        setRows(resultRows.items);
        setBaseRows(resultRows.items);
        setChartSku(resultRows.items.find((r) => r.available_stock !== null)?.sku || '');
        setSelected(new Set(resultRows.items.filter(validForOrder).map((r) => r.sku)));
        setPage(1);
        gateway
          .quality(active.id)
          .then((q) => {
            if (epoch.current === id) setQuality(q);
          })
          .catch((e) => {
            if (epoch.current === id) setQualityError(e.message);
          });
      } catch (e) {
        if (epoch.current === id) setError((e as Error).message);
      } finally {
        if (epoch.current === id) setLoading(false);
      }
    },
    [gateway],
  );
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
    };
  }, [load]);
  useEffect(() => {
    setPage(1);
  }, [supplier, query, filter, sort, view]);
  useEffect(() => {
    if (!run || !chartSku) return;
    let active = true;
    setChart(null);
    setChartError('');
    gateway
      .detail(run.run_id, chartSku)
      .then((d) => {
        if (active) setChart(d);
      })
      .catch((e) => {
        if (active) setChartError(e.message);
      });
    return () => {
      active = false;
    };
  }, [gateway, run, chartSku, chartRetry]);
  const filtered = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            (supplier === 'all' || r.supplier_id === supplier) &&
            `${r.name} ${r.sku} ${r.supplier_article}`
              .toLowerCase()
              .includes(query.toLowerCase().trim()) &&
            (filter === 'all' ||
              (filter === 'critical' && r.risk_status === 'critical') ||
              (filter === 'review' && r.data_status === 'missing') ||
              (filter === 'order' && r.recommended_qty > 0)),
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.name.localeCompare(b.name, 'ru')
            : sort === 'qty'
              ? b.recommended_qty - a.recommended_qty
              : { critical: 0, warning: 1, healthy: 2 }[a.risk_status] -
                { critical: 0, warning: 1, healthy: 2 }[b.risk_status],
        ),
    [rows, supplier, query, filter, sort],
  );
  const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(
    (Math.min(page, maxPage) - 1) * PAGE_SIZE,
    Math.min(page, maxPage) * PAGE_SIZE,
  );
  const chosenRows = rows.filter((r) => selected.has(r.sku) && validForOrder(r));
  const chartRow = rows.find((r) => r.sku === chartSku);
  const activeScenario =
    !!scenario && (scenario.delay_days !== 0 || scenario.demand_change_pct !== 0);
  const selectAll =
    visible.filter(validForOrder).length > 0 &&
    visible.filter(validForOrder).every((r) => selected.has(r.sku));
  function toggle(sku: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }
  function togglePage() {
    setSelected((previous) => {
      const next = new Set(previous);
      visible.filter(validForOrder).forEach((r) => {
        if (selectAll) next.delete(r.sku);
        else next.add(r.sku);
      });
      return next;
    });
  }
  function navigate(next: View) {
    setView(next);
    setNavOpen(false);
  }
  async function applyScenario(values: Scenario) {
    if (!baseRun) throw new Error('Сначала выполните расчёт.');
    setBusy(true);
    setBusyLabel('Сравниваем сценарии…');
    try {
      const result = await gateway.scenario(baseRun.run_id, values);
      const response = await gateway.recommendations(result.run_id);
      setRun(result);
      setRows(response.items);
      setScenario(values);
      setSelected(new Set(response.items.filter(validForOrder).map((r) => r.sku)));
      setPage(1);
    } finally {
      setBusy(false);
    }
  }
  function resetScenario() {
    setRun(baseRun);
    setRows(baseRows);
    setScenario(null);
    setSelected(new Set(baseRows.filter(validForOrder).map((r) => r.sku)));
  }
  async function calculate() {
    if (!dataset) return;
    setBusyLabel('Пересчитываем рекомендации…');
    setBusy(true);
    await load(dataset);
    setBusy(false);
  }
  const summary = run?.summary;

  return (
    <div className="app-shell">
      {navOpen && (
        <button className="nav-scrim" aria-label="Закрыть меню" onClick={() => setNavOpen(false)} />
      )}
      <aside className={`sidebar ${navOpen ? 'is-open' : ''}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
          aria-label="QOR AI — обзор"
        >
          <span className="brand-symbol">
            <span />
          </span>
          <span>
            qor<span className="brand-ai">AI</span>
          </span>
        </a>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <div className="company">
          <span className="company-icon">
            <Boxes size={18} />
          </span>
          <div>
            <strong>Электрокомплект</strong>
            <small>Управление закупками</small>
          </div>
          <ChevronDown size={13} />
        </div>
        <nav aria-label="Основная навигация">
          <span className="nav-label">ПЛАНИРОВАНИЕ</span>
          <button
            className={view === 'overview' ? 'active' : ''}
            onClick={() => navigate('overview')}
          >
            <LayoutDashboard size={18} /> Обзор <span className="nav-active-dot" />
          </button>
          <button
            className={view === 'recommendations' ? 'active' : ''}
            onClick={() => navigate('recommendations')}
          >
            <Package size={18} /> Рекомендации{' '}
            {summary && <span className="nav-count">{summary.order_skus}</span>}
          </button>
          <button
            onClick={() => {
              setScenarioOpen(true);
              setNavOpen(false);
            }}
            disabled={!run || loading || busy}
          >
            <SlidersHorizontal size={18} /> Сценарии <span className="nav-new">NEW</span>
          </button>
          <span className="nav-label second">ДАННЫЕ И КОНТРОЛЬ</span>
          <button
            className={view === 'quality' ? 'active' : ''}
            onClick={() => navigate('quality')}
          >
            <Database size={18} /> Качество данных{' '}
            {summary && summary.review_skus > 0 && <span className="nav-warning" />}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="assistant-note">
            <div>
              <span className="assistant-mark">
                <Sparkles size={17} />
              </span>
              <span>Решения с объяснением</span>
            </div>
            <p>
              У каждого числа есть причина.
              <br />У каждого заказа — ваш контроль.
            </p>
            <button onClick={() => setHelpOpen(true)}>
              Как работает QOR <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="help-button" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={17} /> Сценарий для жюри <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <span>С</span>
            <div>
              <strong>Команда Samgau</strong>
              <small>HackAlem AI · 2026</small>
            </div>
            <ShieldCheck size={18} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Открыть меню"
              onClick={() => setNavOpen(true)}
            >
              <PanelLeftClose size={20} />
            </button>
            <span>Рабочее пространство</span>
            <ChevronRight size={13} />
            <strong>
              {view === 'overview'
                ? 'Обзор закупок'
                : view === 'quality'
                  ? 'Качество данных'
                  : 'Рекомендации'}
            </strong>
          </div>
          <div className="top-actions">
            <span className="status-dot" />
            <span className="top-status">
              {mode === 'demo' ? 'Демонстрационный режим' : 'Подключение к API'}
            </span>
            <span className="top-divider" />
            <button
              className="avatar"
              aria-label="Открыть информацию о проекте"
              onClick={() => setHelpOpen(true)}
            >
              С
            </button>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">SUPPLY INTELLIGENCE</span>
              <h1>
                {view === 'quality'
                  ? 'Доверяйте данным.'
                  : view === 'recommendations'
                    ? 'От прогноза к заказу.'
                    : 'Закупайте с уверенностью.'}
              </h1>
              <p>
                {view === 'quality'
                  ? 'Источники, ограничения и всё, что требует вашего внимания.'
                  : 'Нужный товар. В нужном количестве. В нужный момент.'}
              </p>
            </div>
            <div className="heading-actions">
              <button className="secondary" onClick={() => setHelpOpen(true)}>
                <Play size={15} /> Демо за 90 секунд
              </button>
              <button
                className="primary"
                disabled={loading || busy || !dataset}
                onClick={calculate}
              >
                {busy ? <LoaderCircle className="spin" size={17} /> : <RotateCcw size={17} />}{' '}
                Рассчитать закупку
              </button>
            </div>
          </div>
          <div className="context-bar">
            <div className="context-fields">
              <label>
                <Database size={15} />
                <select
                  aria-label="Режим данных"
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    setMode(e.target.value as DataMode);
                    setSupplier('all');
                  }}
                >
                  <option value="demo">Демоданные</option>
                  <option value="api">Данные API</option>
                </select>
              </label>
              {datasets.length > 1 && (
                <label>
                  <select
                    aria-label="Набор данных"
                    value={dataset?.id || ''}
                    disabled={loading || busy}
                    onChange={(e) => {
                      const next = datasets.find((d) => d.id === e.target.value);
                      if (next) void load(next);
                    }}
                  >
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <span className="context-separator" />
              <label>
                <MapPin size={15} />
                <span>{dataset?.warehouse || 'Склад не выбран'}</span>
              </label>
              <span className="context-separator" />
              <label>
                <Clock3 size={15} />
                <span>{dataset ? date(dataset.as_of) : 'Дата не задана'}</span>
              </label>
            </div>
            <span className="data-label">
              {mode === 'demo' || dataset?.mode === 'synthetic'
                ? 'СИНТЕТИЧЕСКИЕ ДАННЫЕ'
                : dataset
                  ? 'ДАННЫЕ КОМПАНИИ'
                  : 'НАБОР НЕ ВЫБРАН'}
            </span>
          </div>
          {error && (
            <div className="error-box main-error" role="alert">
              <TriangleAlert size={23} />
              <div>
                <strong>Не удалось получить расчёт</strong>
                <p>{error}</p>
                <button className="secondary" onClick={() => void load()}>
                  Повторить подключение
                </button>
                {mode === 'api' && (
                  <button className="text-button" onClick={() => setMode('demo')}>
                    Открыть деморежим явно <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
          {loading ? (
            <div className="loading-view" role="status" aria-live="polite">
              <div className="skeleton-stats">
                {[1, 2, 3, 4].map((i) => (
                  <div className="skeleton" key={i} />
                ))}
              </div>
              <div className="skeleton skeleton-panel" />
              <p>
                <LoaderCircle className="spin" size={18} />{' '}
                {mode === 'demo'
                  ? 'Подготавливаем демонстрационное рабочее пространство…'
                  : 'Получаем данные и рассчитываем рекомендации…'}
              </p>
            </div>
          ) : (
            !error &&
            run && (
              <>
                {view === 'quality' ? (
                  <section className="quality-view panel">
                    <div className="section-title">
                      <div>
                        <span className="eyebrow">DATA HEALTH</span>
                        <h2>Паспорт набора данных</h2>
                      </div>
                      <Database size={24} />
                    </div>
                    <p className="muted">
                      {dataset?.name} · ограничения не скрываются и не заменяются нулевыми
                      значениями.
                    </p>
                    {qualityError ? (
                      <div className="error-box" role="alert">
                        {qualityError}
                        <button
                          onClick={() => {
                            setQualityError('');
                            if (dataset)
                              gateway
                                .quality(dataset.id)
                                .then(setQuality)
                                .catch((e) => setQualityError(e.message));
                          }}
                        >
                          Повторить
                        </button>
                      </div>
                    ) : !quality ? (
                      <p role="status">
                        <LoaderCircle className="spin" size={17} /> Загружаем отчёт…
                      </p>
                    ) : (
                      <>
                        <div className="quality-metrics">
                          <div>
                            <strong>{quality.source_count}</strong>
                            <span>типов источников</span>
                          </div>
                          <div>
                            <strong>{quality.mapped_skus}</strong>
                            <span>сопоставленных SKU</span>
                          </div>
                          <div>
                            <strong>{quality.issues.length}</strong>
                            <span>пунктов проверки</span>
                          </div>
                        </div>
                        {quality.issues.map((issue) => (
                          <div className="quality-issue" key={issue.id}>
                            <span className={`quality-icon ${issue.severity}`}>
                              {issue.severity === 'warning' ? (
                                <TriangleAlert size={20} />
                              ) : (
                                <ShieldCheck size={20} />
                              )}
                            </span>
                            <div>
                              <h3>{issue.title}</h3>
                              <p>{issue.detail}</p>
                            </div>
                            <span className="count-pill">{issue.count}</span>
                          </div>
                        ))}
                      </>
                    )}
                    <div className="quality-footnote">
                      <ShieldCheck size={18} /> Исходные Excel-файлы не загружаются в ИИ из
                      браузера. Ключи API остаются на сервере.
                    </div>
                  </section>
                ) : (
                  <>
                    {view === 'overview' && (
                      <>
                        <section className="stats-grid" aria-label="Основные показатели">
                          <Stat
                            icon={<Package size={18} />}
                            label="К заказу"
                            value={summary?.order_skus || 0}
                            unit="позиций"
                            note="Рекомендовано к пополнению"
                            trend="Сформирован план"
                            tone="green"
                          />
                          <Stat
                            icon={<TriangleAlert size={18} />}
                            label="Риск дефицита"
                            value={summary?.risk_skus || 0}
                            unit="SKU"
                            note="Запас закончится до поставки"
                            trend="Требуют внимания"
                            tone="orange"
                          />
                          <Stat
                            icon={<Activity size={18} />}
                            label="Разовые покупки"
                            value={summary?.anomaly_count || 0}
                            unit="заказа"
                            note="Выделены из регулярного спроса"
                            trend="Прогноз без искажений"
                            tone="blue"
                          />
                          <Stat
                            icon={<ShieldCheck size={18} />}
                            label="Проверить данные"
                            value={summary?.review_skus || 0}
                            unit="SKU"
                            note="Недостаточно данных для заказа"
                            trend="Нужна проверка"
                            tone="neutral"
                          />
                        </section>
                        <div className="analysis-grid">
                          <section className="panel forecast-panel">
                            <div className="section-title">
                              <div>
                                <h2>Запас под контролем</h2>
                                <p>Как изменится наличие в ближайшие 28 дней</p>
                              </div>
                              <span className="pill">
                                <span className="small-dot" /> ПРОГНОЗ
                              </span>
                            </div>
                            <div className="chart-product">
                              <Box size={17} />
                              <select
                                aria-label="Товар для графика"
                                value={chartSku}
                                onChange={(e) => setChartSku(e.target.value)}
                              >
                                {rows
                                  .filter((r) => r.available_stock !== null)
                                  .map((r) => (
                                    <option value={r.sku} key={r.sku}>
                                      {r.name}
                                    </option>
                                  ))}
                              </select>
                              <span>{chartRow?.unit || 'шт'}</span>
                            </div>
                            {!chartRow ? (
                              <div className="chart-skeleton">
                                <Box size={22} />
                                <p>Нет позиции с подтверждённым остатком для графика.</p>
                              </div>
                            ) : chartError ? (
                              <div className="chart-skeleton">
                                <p role="alert">{chartError}</p>
                                <button
                                  className="secondary"
                                  onClick={() => setChartRetry((v) => v + 1)}
                                >
                                  Повторить
                                </button>
                              </div>
                            ) : chart ? (
                              <StockChart data={chart.projection} scenario={activeScenario} />
                            ) : (
                              <div className="chart-skeleton">
                                <LoaderCircle className="spin" size={20} /> Загружаем прогноз…
                              </div>
                            )}
                            <div className="chart-legend">
                              <span>
                                <i className="legend-line green" />С рекомендованным заказом
                              </span>
                              <span>
                                <i className="legend-line dashed" />
                                Без заказа
                              </span>
                              {activeScenario && (
                                <span>
                                  <i className="legend-line orange" />
                                  Сценарий
                                </span>
                              )}
                            </div>
                            <div className="chart-bottom">
                              <span>
                                <CircleHelp size={14} />{' '}
                                {mode === 'demo'
                                  ? 'Модельный пример. Не прогноз реальных продаж.'
                                  : 'Прогноз зависит от качества исходных данных.'}
                              </span>
                              <button
                                className="text-button"
                                onClick={() => {
                                  if (chartRow) setDetail(chartRow);
                                }}
                              >
                                Почему так? <ArrowUpRight size={14} />
                              </button>
                            </div>
                          </section>
                          <section className="scenario-card">
                            <div className="scenario-card-head">
                              <span>
                                <Sparkles size={17} /> ЛАБОРАТОРИЯ СЦЕНАРИЕВ
                              </span>
                              <ArrowUpRight size={20} />
                            </div>
                            <h2>
                              А что, если
                              <br />
                              поставка опоздает?
                            </h2>
                            <p>
                              Проверьте решение до закупки.
                              <br />
                              Один сценарий — понятные последствия.
                            </p>
                            <div className="supply-illustration" aria-hidden="true">
                              <div className="route-line" />
                              <div className="route-node route-start">
                                <Package size={24} />
                              </div>
                              <div className="route-tag">+7 дней</div>
                              <div className="truck-node">
                                <Truck size={31} />
                              </div>
                              <div className="route-node route-end">
                                <Boxes size={24} />
                              </div>
                              <span className="route-label left">Поставщик</span>
                              <span className="route-label right">Ваш склад</span>
                            </div>
                            <button onClick={() => setScenarioOpen(true)} disabled={busy}>
                              <span>Проверить сценарий</span>
                              <ArrowRight size={18} />
                            </button>
                            <span className="scenario-caption">
                              Задержка поставки · изменение спроса
                            </span>
                          </section>
                        </div>
                      </>
                    )}
                    {activeScenario && (
                      <div className="scenario-result" role="status">
                        <span className="scenario-result-icon">
                          <Sparkles size={19} />
                        </span>
                        <div>
                          <strong>
                            Сценарий: {supplierName(scenario!.supplier_id)} · задержка +
                            {scenario!.delay_days} дн. · спрос{' '}
                            {scenario!.demand_change_pct > 0 ? '+' : ''}
                            {scenario!.demand_change_pct}%
                          </strong>
                          <span>
                            Риск дефицита: {baseRun?.summary.risk_skus} → {run.summary.risk_skus}{' '}
                            SKU. Таблица и графики показывают результат сценария.
                          </span>
                        </div>
                        <button className="text-button" onClick={resetScenario} disabled={busy}>
                          <RotateCcw size={14} /> Вернуть исходный
                        </button>
                      </div>
                    )}
                    <section className="panel recommendations-panel" ref={tableRef}>
                      <div className="table-heading">
                        <div>
                          <h2>
                            Рекомендации к закупке <span className="count-pill">{rows.length}</span>
                          </h2>
                          <p>От прогноза к действию — с обоснованием каждой позиции</p>
                        </div>
                        <button
                          className="secondary export-button"
                          disabled={!chosenRows.length || busy}
                          onClick={() => setOrderOpen(true)}
                        >
                          <ArrowDownToLine size={16} /> Проверить и выгрузить{' '}
                          <span>{chosenRows.length}</span>
                        </button>
                      </div>
                      <div className="table-controls">
                        <div className="search-box">
                          <Search size={17} />
                          <input
                            aria-label="Поиск товаров"
                            placeholder="Найти товар, артикул или код…"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                          />
                          {query && (
                            <button aria-label="Очистить поиск" onClick={() => setQuery('')}>
                              <X size={14} />
                            </button>
                          )}
                        </div>
                        <label className="filter-select">
                          <ListFilter size={16} />
                          <select
                            aria-label="Фильтр поставщика"
                            value={supplier}
                            onChange={(e) => setSupplier(e.target.value as Supplier)}
                          >
                            <option value="all">Все поставщики</option>
                            <option value="iek">IEK</option>
                            <option value="systeme">Systeme Electric</option>
                          </select>
                        </label>
                        <label className="filter-select">
                          <Settings2 size={16} />
                          <select
                            aria-label="Сортировка"
                            value={sort}
                            onChange={(e) => setSort(e.target.value as typeof sort)}
                          >
                            <option value="risk">Сначала важное</option>
                            <option value="name">По названию</option>
                            <option value="qty">По количеству</option>
                          </select>
                        </label>
                      </div>
                      <div className="filter-chips" aria-label="Фильтры риска">
                        {(
                          [
                            { key: 'all', label: 'Все позиции' },
                            { key: 'critical', label: 'Риск дефицита' },
                            { key: 'order', label: 'К заказу' },
                            { key: 'review', label: 'Проверить данные' },
                          ] as const
                        ).map((f) => (
                          <button
                            className={filter === f.key ? 'active' : ''}
                            key={f.key}
                            onClick={() => setFilter(f.key)}
                          >
                            {f.key === 'critical' && <span className="risk-dot" />}
                            {f.label}
                          </button>
                        ))}
                        <span className="table-unit-note">Количества в единицах товара</span>
                      </div>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th className="check-column">
                                <input
                                  type="checkbox"
                                  aria-label="Выбрать все доступные позиции на странице"
                                  checked={selectAll}
                                  onChange={togglePage}
                                  disabled={!visible.some(validForOrder)}
                                />
                              </th>
                              <th>Товар / артикул</th>
                              <th>Поставщик</th>
                              <th className="numeric">Свободно</th>
                              <th className="numeric">В пути</th>
                              <th className="numeric">
                                К заказу <ArrowDown size={11} />
                              </th>
                              <th>Статус</th>
                              <th className="why-column" />
                            </tr>
                          </thead>
                          <tbody>
                            {visible.map((row) => (
                              <tr
                                key={row.sku}
                                className={selected.has(row.sku) ? 'selected-row' : ''}
                              >
                                <td>
                                  <input
                                    type="checkbox"
                                    aria-label={`Выбрать ${row.supplier_article}`}
                                    checked={selected.has(row.sku)}
                                    disabled={!validForOrder(row)}
                                    onChange={() => toggle(row.sku)}
                                  />
                                </td>
                                <td>
                                  <button className="product-name" onClick={() => setDetail(row)}>
                                    {row.name}
                                  </button>
                                  <span className="product-meta">
                                    {row.supplier_article} <span>·</span> {row.category}
                                  </span>
                                </td>
                                <td>
                                  <span className={`supplier-badge ${row.supplier_id}`}>
                                    {row.supplier_id === 'iek' ? 'IEK' : 'Systeme'}
                                  </span>
                                </td>
                                <td className="numeric">
                                  {row.available_stock === null ? (
                                    <span className="missing" title="Нет актуального остатка">
                                      Нет данных
                                    </span>
                                  ) : (
                                    number(row.available_stock)
                                  )}
                                  <small>{row.available_stock !== null && row.unit}</small>
                                </td>
                                <td className="numeric muted">
                                  {number(row.eligible_incoming)}
                                  <small>{row.unit}</small>
                                </td>
                                <td className="numeric">
                                  <span
                                    className={`order-qty ${row.recommended_qty > 0 ? 'positive' : ''}`}
                                  >
                                    {row.data_status === 'missing'
                                      ? '—'
                                      : number(row.recommended_qty)}
                                  </span>
                                  <small>{row.unit}</small>
                                </td>
                                <td>
                                  <span
                                    className={`badge ${row.data_status === 'missing' ? 'warning' : row.risk_status}`}
                                  >
                                    <span />
                                    {row.data_status === 'missing'
                                      ? 'Проверить'
                                      : riskLabel[row.risk_status]}
                                  </span>
                                </td>
                                <td>
                                  <button
                                    className="why-button"
                                    aria-label={`Почему такой заказ: ${row.supplier_article}`}
                                    onClick={() => setDetail(row)}
                                  >
                                    <ArrowUpRight size={17} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!filtered.length && (
                        <div className="empty-state">
                          <Search size={28} />
                          <h3>Ничего не найдено</h3>
                          <p>Попробуйте другой запрос или сбросьте фильтры.</p>
                          <button
                            className="secondary"
                            onClick={() => {
                              setQuery('');
                              setFilter('all');
                              setSupplier('all');
                            }}
                          >
                            Сбросить фильтры
                          </button>
                        </div>
                      )}
                      <div className="table-footer">
                        <span>
                          {filtered.length
                            ? `${(Math.min(page, maxPage) - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)}`
                            : '0'}{' '}
                          из {filtered.length} позиций <span className="footer-dot">·</span> Выбрано{' '}
                          {chosenRows.length}
                        </span>
                        <div className="pagination">
                          <button
                            className="icon-button"
                            aria-label="Предыдущая страница"
                            disabled={page <= 1}
                            onClick={() => setPage((p) => p - 1)}
                          >
                            <ChevronLeft size={17} />
                          </button>
                          <span>
                            {Math.min(page, maxPage)} / {maxPage}
                          </span>
                          <button
                            className="icon-button"
                            aria-label="Следующая страница"
                            disabled={page >= maxPage}
                            onClick={() => setPage((p) => p + 1)}
                          >
                            <ChevronRight size={17} />
                          </button>
                        </div>
                      </div>
                    </section>
                  </>
                )}
                <footer className="page-footer">
                  <span>
                    <ShieldCheck size={14} /> Заказ отправляется только по решению человека
                  </span>
                  <span>
                    QOR AI <span className="footer-dot">/</span> Samgau · HackAlem 2026
                  </span>
                </footer>
              </>
            )
          )}
        </main>
      </div>
      {busy && !scenarioOpen && !loading && (
        <div className="busy-toast" role="status">
          <LoaderCircle className="spin" size={17} />
          {busyLabel}
        </div>
      )}
      {detail && run && (
        <Detail
          key={`${run.run_id}-${detail.sku}`}
          row={detail}
          run={run.run_id}
          gateway={gateway}
          mode={mode}
          scenario={activeScenario}
          onClose={() => setDetail(null)}
        />
      )}
      {scenarioOpen && (
        <ScenarioModal
          gateway={gateway}
          mode={mode}
          supplier={supplier}
          onApply={applyScenario}
          onClose={() => setScenarioOpen(false)}
        />
      )}
      {orderOpen && run && (
        <OrderModal
          rows={chosenRows}
          run={run.run_id}
          gateway={gateway}
          mode={mode}
          onClose={() => setOrderOpen(false)}
        />
      )}
      {helpOpen && (
        <Modal
          title="Покажите результат за 90 секунд"
          subtitle="Простой маршрут по рабочему сценарию QOR AI"
          onClose={() => setHelpOpen(false)}
        >
          <div className="demo-steps">
            {[
              [
                '01',
                'Посмотрите рекомендации',
                'Начните с позиций с риском дефицита. Проверьте поставщика и количество.',
              ],
              [
                '02',
                'Откройте паспорт решения',
                'Нажмите на товар. Посмотрите формулу, историю и разовые покупки.',
              ],
              [
                '03',
                'Испытайте закупку',
                'Задайте задержку +7 дней. Сравните риск и будущий запас.',
              ],
              [
                '04',
                'Проверьте и выгрузите',
                'Отредактируйте количество, укажите причину, утвердите черновик и скачайте CSV.',
              ],
            ].map(([n, title, body]) => (
              <div key={n}>
                <span>{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="notice">
            <Database size={17} />
            <span>
              Деморежим содержит синтетические данные и шаблонные объяснения. Настоящие расчёты и ИИ
              подключаются через API.
            </span>
          </div>
          <footer className="modal-footer">
            <span className="muted small">Сделано командой Samgau</span>
            <button
              className="primary"
              onClick={() => {
                setHelpOpen(false);
                navigate('recommendations');
              }}
            >
              Начать демонстрацию <ArrowRight size={16} />
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function Stat({
  icon,
  label,
  value,
  unit,
  note,
  trend,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  unit: string;
  note: string;
  trend: string;
  tone: string;
}) {
  return (
    <article className={`stat-card ${tone}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <div className="stat-value">
        {number(value)} <span>{unit}</span>
      </div>
      <p>{note}</p>
      <div className="stat-footer">
        {tone === 'green' || tone === 'blue' ? <Check size={12} /> : <span className="tiny-dot" />}
        {trend}
      </div>
    </article>
  );
}
