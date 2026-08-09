/**
 * Клиент Claude API без внешних зависимостей (fetch входит в Node 18+).
 *
 * AI-модуль опционален: продукт полностью работоспособен без ключа —
 * рекомендации формирует детерминированный движок (advisor.js). LLM добавляет
 * связный текст «от лица архитектора», но не является источником фактов.
 */

import { AI, TIMEOUTS, DATA_DIR } from '../config.js';
import path from 'node:path';
import { readJson } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { currentSignal, CancelledError } from '../util/cancel.js';

const log = createLogger('ai');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/** Ключ берётся из окружения либо из data/settings.json. */
export async function getApiKey() {
  if (process.env[AI.apiKeyEnv]) return process.env[AI.apiKeyEnv];
  const settings = await readJson(SETTINGS_FILE, {});
  return settings?.anthropicApiKey || null;
}

export async function isAvailable() {
  return Boolean(await getApiKey());
}

/**
 * Обращение к Messages API.
 *
 * @param {object} params
 * @param {string} params.system системный промпт
 * @param {string} params.prompt пользовательское сообщение
 * @param {number} [params.maxTokens]
 * @returns {Promise<string>} текст ответа
 */
export async function complete({ system, prompt, maxTokens = AI.maxTokens }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Не задан ключ Claude API');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.ai);

  // Прерывание аудита должно обрывать и запрос к API, а не ждать таймаута.
  const cancelSignal = currentSignal();
  const onCancel = () => controller.abort();
  cancelSignal?.addEventListener('abort', onCancel, { once: true });

  try {
    const response = await fetch(`${AI.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AI.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Claude API вернул ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    const parts = Array.isArray(data.content) ? data.content : [];
    return parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (cancelSignal?.aborted) throw new CancelledError();
      throw new Error(`Превышен таймаут обращения к Claude API (${Math.round(TIMEOUTS.ai / 1000)} с)`);
    }
    log.warn(`Ошибка обращения к Claude API: ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
    cancelSignal?.removeEventListener('abort', onCancel);
  }
}
