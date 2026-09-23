import { rowKey } from '../types';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Database,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import type { Dataset, Recommendation, Run, Scenario } from '../types';
import { request } from '../lib/api';
import {
  makeChatContext,
  sendChat,
  type AssistantStatus,
  type ChatDestination,
  type ChatMessage,
} from '../lib/assistant';
import { number } from '../lib/format';
import './Assistant.css';

const destinations: Record<ChatDestination, string> = {
  overview: 'Обзор склада',
  recommendations: 'План закупок',
  quality: 'Проверка данных',
  scenario: 'Что, если…',
  exchange: 'Обмен с 1С',
};
const prompts = [
  { icon: <Database size={19} />, text: 'Что сейчас требует внимания на складе?' },
  { icon: <Sparkles size={19} />, text: 'Объясни расчёт для выбранного товара простыми словами' },
  { icon: <BookOpen size={19} />, text: 'Где проверить заказ и скачать CSV?' },
  { icon: <MessageCircle size={19} />, text: 'Как проверить задержку поставки?' },
];
export function Assistant({
  dataset,
  run,
  rows,
  scenario,
  loading,
  onNavigate,
  onProduct,
  active,
}: {
  dataset: Dataset | null;
  run: Run | null;
  rows: Recommendation[];
  scenario: Scenario | null;
  loading: boolean;
  active: boolean;
  onNavigate: (destination: ChatDestination) => void;
  onProduct: (row: Recommendation) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [selectedSku, setSelectedSku] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState('');
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    request<AssistantStatus>('/assistant/status')
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active]);
  useEffect(() => {
    if (active && messages.length) end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, pending, active]);
  const selected = rows.find((row) => rowKey(row) === selectedSku);
  const blocked = pending || loading || messages.length >= 80;
  async function submit(question = input, isRetry = false) {
    const text = question.trim();
    if (!text || text.length > 2000 || sending.current || loading || messages.length >= 80) return;
    sending.current = true;
    setPending(true);
    setError('');
    setRetry('');
    setInput('');
    const history = isRetry ? messages.slice(0, -1) : messages;
    if (!isRetry)
      setMessages([...messages, { id: crypto.randomUUID(), role: 'user', content: text }]);
    try {
      const answer = await sendChat(
        text,
        history,
        makeChatContext(dataset, run, rows, scenario, selectedSku, text),
      );
      if (alive.current)
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: 'assistant', content: answer.text, answer },
        ]);
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : 'Не удалось получить ответ.');
        setRetry(text);
      }
    } finally {
      sending.current = false;
      if (alive.current) {
        setPending(false);
        textArea.current?.focus();
      }
    }
  }
  function newChat() {
    setMessages([]);
    setInput('');
    setError('');
    setRetry('');
    textArea.current?.focus();
  }
  return (
    <section className="assistant-layout" aria-label="ИИ-помощник">
      <div className="chat-panel panel">
        <header className="chat-header">
          <span className="chat-logo">
            <Sparkles size={23} />
          </span>
          <div>
            <h2>QOR помощник</h2>
            <p>
              {status?.configured
                ? `ИИ · ${status.provider === 'nvidia' ? 'NVIDIA' : 'OpenAI'}`
                : status
                  ? 'Справка доступна · ИИ не подключён'
                  : 'Подключение проверяется при отправке'}
            </p>
          </div>
          <button
            className="secondary new-chat"
            onClick={newChat}
            disabled={pending || !messages.length}
          >
            <Plus size={16} />
            Новый диалог
          </button>
        </header>
        <div
          className="chat-messages"
          role="log"
          aria-label="История диалога"
          aria-live="polite"
          aria-relevant="additions"
        >
          {!messages.length && (
            <div className="chat-welcome">
              <span className="welcome-spark">
                <Sparkles size={32} />
              </span>
              <span className="chat-eyebrow">ВАШ ПОМОЩНИК В ЗАКУПКАХ</span>
              <h3>Давайте разберёмся вместе</h3>
              <p>
                Спросите о прогнозе, остатках или работе с сайтом.
                <br />
                Объясню простыми словами и помогу найти нужный раздел.
              </p>
              <div className="chat-prompts">
                {prompts.map((prompt) => (
                  <button
                    key={prompt.text}
                    disabled={blocked}
                    onClick={() => {
                      if (prompt.text.includes('выбранного') && !selectedSku) {
                        setInput('Объясни расчёт для товара ');
                        textArea.current?.focus();
                        return;
                      }
                      void submit(prompt.text);
                    }}
                  >
                    {prompt.icon}
                    <span>{prompt.text}</span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => (
            <article className={`chat-message ${message.role}`} key={message.id}>
              <span className="message-avatar">
                {message.role === 'user' ? 'Вы' : <Bot size={19} />}
              </span>
              <div className="message-content">
                <span className="message-author">
                  {message.role === 'user'
                    ? 'Вы'
                    : message.answer?.status === 'generated'
                      ? 'QOR · ИИ-помощник'
                      : 'QOR · справка без ИИ'}
                </span>
                <p className="message-text">{message.content}</p>
                {message.answer && (
                  <>
                    <div className="message-links">
                      {[...new Set(message.answer.destinations)]
                        .filter((d) => d in destinations)
                        .map((destination) => (
                          <button
                            key={destination}
                            onClick={() => onNavigate(destination)}
                            disabled={destination === 'scenario' && !run}
                          >
                            {destinations[destination]}
                            <ArrowRight size={14} />
                          </button>
                        ))}
                    </div>
                    {message.answer.source_skus.length > 0 && (
                      <div className="chat-sources">
                        <span>Данные из текущего расчёта</span>
                        {[...new Set(message.answer.source_skus)].map((sku) => {
                          const product = rows.find((row) => row.sku === sku);
                          return product ? (
                            <button key={sku} onClick={() => onProduct(product)}>
                              <span>
                                <strong>{product.supplier_article}</strong>
                                <small>{product.name}</small>
                              </span>
                              <span>
                                {['missing', 'blocked'].includes(product.data_status)
                                  ? 'Проверить данные'
                                  : `К заказу: ${number(product.recommended_qty)} ${product.unit}`}
                              </span>
                              <ChevronRight size={16} />
                            </button>
                          ) : null;
                        })}
                      </div>
                    )}
                    <small className={`message-notice ${message.answer.status}`}>
                      {message.answer.status === 'generated' ? (
                        <Check size={12} />
                      ) : (
                        <BookOpen size={12} />
                      )}{' '}
                      {message.answer.notice}
                    </small>
                  </>
                )}
              </div>
            </article>
          ))}
          {pending && (
            <div className="chat-thinking" role="status">
              <LoaderCircle size={17} className="spin" />
              Помощник изучает вопрос и текущий расчёт…
            </div>
          )}
          {error && (
            <div className="chat-error" role="alert">
              <TriangleAlert size={19} />
              <div>
                <strong>Не удалось получить ответ</strong>
                <p>{error}</p>
                <button
                  className="text-button"
                  onClick={() => void submit(retry, true)}
                  disabled={pending}
                >
                  Повторить вопрос <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="sr-only" htmlFor="assistant-question">
            Ваш вопрос помощнику
          </label>
          <div>
            <textarea
              id="assistant-question"
              ref={textArea}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={blocked}
              maxLength={2000}
              rows={2}
              placeholder="Например: почему нужно заказать 156 розеток?"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              className="primary"
              type="submit"
              disabled={blocked || !input.trim()}
              aria-label="Отправить вопрос"
            >
              {pending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
          <p>
            <span>
              {messages.length >= 80
                ? 'Начните новый диалог, чтобы продолжить.'
                : 'Enter — отправить · Shift + Enter — новая строка'}
            </span>
            <span>{input.length}/2000</span>
          </p>
        </form>
      </div>
      <aside className="chat-context">
        <section className="panel">
          <span className="chat-eyebrow">
            <Database size={14} />
            КОНТЕКСТ ПОМОЩНИКА
          </span>
          <h3>{dataset?.warehouse || 'Навигация по сайту'}</h3>
          <p>{dataset ? `Снимок на ${dataset.as_of}` : 'Расчёт пока не загружен'}</p>
          <span className="chat-data-chip">
            {dataset?.mode === 'real'
              ? 'Данные компании'
              : dataset
                ? 'Демонстрационные данные'
                : 'Справка по разделам'}
          </span>
          {run && (
            <dl>
              <div>
                <dt>Позиций в расчёте</dt>
                <dd>{rows.length}</dd>
              </div>
              <div>
                <dt>Риск дефицита</dt>
                <dd>{run.summary.risk_skus}</dd>
              </div>
              <div>
                <dt>Рекомендовано к заказу</dt>
                <dd>{run.summary.order_skus}</dd>
              </div>
            </dl>
          )}
          <label htmlFor="chat-product">Обсудить конкретный товар</label>
          <select
            id="chat-product"
            value={selectedSku}
            onChange={(event) => setSelectedSku(event.target.value)}
            disabled={pending}
          >
            <option value="">Весь склад</option>
            {rows.map((row) => (
              <option key={rowKey(row)} value={rowKey(row)}>
                {row.supplier_article} · {row.name}
              </option>
            ))}
          </select>
          {selected && <small className="chat-selected">{selected.name}</small>}
          {scenario && (
            <p className="chat-scenario">
              Активен сценарий: задержка +{scenario.delay_days} дн., спрос{' '}
              {scenario.demand_change_pct > 0 ? '+' : ''}
              {scenario.demand_change_pct}%
            </p>
          )}
          <p className="chat-context-note">
            При новом расчёте диалог начинается заново, чтобы ответы не опирались на старые цифры.
          </p>
        </section>
        <section className="panel chat-guide">
          <span className="chat-eyebrow">
            <BookOpen size={14} />
            БЫСТРЫЕ ПЕРЕХОДЫ
          </span>
          {(Object.entries(destinations) as [ChatDestination, string][]).map(([key, label]) => (
            <button key={key} onClick={() => onNavigate(key)} disabled={key === 'scenario' && !run}>
              {label}
              <ArrowRight size={15} />
            </button>
          ))}
        </section>
        <div className="chat-trust">
          <ShieldCheck size={19} />
          <p>Помощник объясняет и подсказывает. Решение о закупке всегда за вами.</p>
        </div>
      </aside>
    </section>
  );
}
