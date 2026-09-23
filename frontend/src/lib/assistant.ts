import { ApiError, request } from './api';
import type { Dataset, Recommendation, Run, Scenario } from '../types';

export type ChatDestination = 'overview' | 'recommendations' | 'quality' | 'scenario';
export interface ChatAnswer {
  text: string;
  destinations: ChatDestination[];
  source_skus: string[];
  status: 'generated' | 'fallback';
  provider: string | null;
  notice: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer?: ChatAnswer;
}
export interface AssistantStatus {
  configured: boolean;
  provider: string | null;
  allow_real_data: boolean;
}

export function makeChatContext(
  dataset: Dataset | null,
  run: Run | null,
  rows: Recommendation[],
  scenario: Scenario | null,
  selectedSku: string,
  question: string,
) {
  // Include exact article/name matches first, then the chosen product and highest risks.
  // Large datasets remain bounded; totals always describe the complete current run.
  const query = question.toLocaleLowerCase();
  const identifiers = new Set(query.match(/[\p{L}\p{N}_./-]+/gu) || []);
  const score = (row: Recommendation) =>
    (identifiers.has(row.supplier_article.toLocaleLowerCase()) ||
    identifiers.has(row.sku.toLocaleLowerCase()) ||
    query.includes(row.name.toLocaleLowerCase())
      ? 100
      : 0) +
    (row.sku === selectedSku ? 50 : 0) +
    (row.risk_status === 'critical' ? 20 : 0);
  const products = [...rows]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 40)
    .map((row) => ({
      sku: row.sku,
      supplier_article: row.supplier_article,
      name: row.name,
      unit: row.unit,
      available_stock: row.available_stock,
      eligible_incoming: row.eligible_incoming,
      forecast_qty: row.forecast_qty,
      safety_stock: row.safety_stock,
      recommended_qty: row.data_status === 'missing' ? null : row.recommended_qty,
      risk_status: row.risk_status,
      data_status: row.data_status,
      warnings: row.warnings.slice(0, 6).map((warning) => warning.slice(0, 500)),
    }));
  return {
    data_mode: dataset?.mode || 'none',
    run_id: run?.run_id || null,
    warehouse: dataset?.warehouse || 'Склад не выбран',
    as_of: dataset?.as_of || 'Не задана',
    total_products: rows.length,
    order_skus: run?.summary.order_skus || 0,
    risk_skus: run?.summary.risk_skus || 0,
    review_skus: run?.summary.review_skus || 0,
    scenario: scenario
      ? `Поставщик: ${scenario.supplier_id}; задержка: ${scenario.delay_days} дн.; изменение спроса: ${scenario.demand_change_pct}%.`
      : 'Исходный расчёт, без сценария.',
    selected_sku: selectedSku || null,
    products,
  };
}

let sessionPromise: Promise<string> | null = null;
function session() {
  if (!sessionPromise)
    sessionPromise = request<{ token: string }>('/sessions', { method: 'POST' })
      .then((result) => {
        if (!result.token) throw new ApiError('Сервер не создал сессию помощника.');
        return result.token;
      })
      .catch((error) => {
        sessionPromise = null;
        throw error;
      });
  return sessionPromise;
}

export async function sendChat(
  message: string,
  history: ChatMessage[],
  context: ReturnType<typeof makeChatContext>,
): Promise<ChatAnswer> {
  const send = async () =>
    request<ChatAnswer>('/assistant/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await session()}` },
      body: JSON.stringify({
        message,
        context,
        history: history.slice(-12).map(({ role, content }) => ({ role, content })),
      }),
    });
  let answer: ChatAnswer;
  try {
    answer = await send();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    sessionPromise = null;
    answer = await send();
  }
  if (
    !answer ||
    typeof answer.text !== 'string' ||
    !answer.text.trim() ||
    !Array.isArray(answer.destinations) ||
    !Array.isArray(answer.source_skus) ||
    !['generated', 'fallback'].includes(answer.status)
  ) {
    throw new ApiError('Помощник вернул непонятный ответ. Попробуйте ещё раз.');
  }
  return answer;
}
