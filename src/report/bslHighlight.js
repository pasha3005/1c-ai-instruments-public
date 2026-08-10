/**
 * Подсветка синтаксиса встроенного языка 1С для фрагментов кода в отчёте.
 *
 * Работает на том же лексере, что и анализ кода (`analyze/bsl/lexer.js`):
 * отдельный парсер только для подсветки был бы лишней сущностью, а токены
 * лексера уже несут всё нужное — вид (ключевое слово/строка/комментарий)
 * и точную позицию в исходном тексте.
 *
 * Цвета — по просьбе пользователя, «как в 1С»: комментарии зелёным, ключевые
 * слова — по синтаксису языка, а строки (включая тексты запросов с переносом
 * через вертикальную черту) — НЕЙТРАЛЬНЫМ цветом темы, а не акцентным: это
 * данные, а не структура кода, и раскрашивать их как что-то важное неверно.
 */

import { tokenize, TOKEN } from '../analyze/bsl/lexer.js';
import { esc } from './ui.js';

const CLASS_BY_TYPE = {
  [TOKEN.COMMENT]: 'comment',
  [TOKEN.STRING]: 'string',
  [TOKEN.KEYWORD]: 'keyword',
  [TOKEN.DATE]: 'string',
  [TOKEN.PREPROC]: 'directive',
  [TOKEN.DIRECTIVE]: 'directive',
};

/**
 * Раскрашивает текст модуля (или его фрагмент) в HTML — уже экранированный,
 * готовый для вставки внутрь `<pre>`. Второй раз через `esc()` пропускать
 * результат нельзя.
 */
export function highlightBsl(source) {
  const text = String(source ?? '');
  if (!text) return '';

  let tokens;
  try {
    tokens = tokenize(text, { keepComments: true }).tokens;
  } catch {
    // Лексер не рассчитан на обрубленный посередине токена текст (фрагменты
    // в отчёте обрезаны по длине строки), но обязан не бросать исключение
    // на реальном коде. Если всё же случилось — отчёт получает неподсвеченный
    // текст, а не падает целиком.
    return esc(text);
  }

  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    if (token.pos > cursor) out += esc(text.slice(cursor, token.pos));
    // У строкового литерала `value` — это уже разобранное значение (снятые
    // кавычки, склеенные переносы через «|»), а `raw` — точный текст
    // исходника, включая кавычки и вертикальные черты. Для подсветки нужен
    // именно он, иначе многострочный текст запроса потеряет часть символов.
    const raw = token.type === TOKEN.STRING ? (token.raw ?? token.value) : token.value;
    const cls = CLASS_BY_TYPE[token.type];
    out += cls ? `<span class="tok-${cls}">${esc(raw)}</span>` : esc(raw);
    cursor = token.pos + raw.length;
  }
  out += esc(text.slice(cursor));
  return out;
}
