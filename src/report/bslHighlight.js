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

/**
 * Снимает общий отступ фрагмента.
 *
 * Код в модуле 1С лежит на третьем-четвёртом уровне вложенности, и в узкой
 * колонке отчёта половину ширины занимали пустые табуляции. Требование
 * пользователя: фрагмент начинается с первого символа строки. Внутренние
 * отступы при этом сохраняются — снимается ровно та часть, которая есть
 * у всех непустых строк сразу.
 */
export function dedent(text) {
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let common = Infinity;
  for (const row of rows) {
    if (!row.trim()) continue;
    common = Math.min(common, row.length - row.trimStart().length);
    if (!common) break;
  }
  if (!Number.isFinite(common) || !common) return rows.join('\n');
  return rows.map((row) => (row.trim() ? row.slice(common) : row.trimStart())).join('\n');
}

/**
 * Готовый блок кода для отчёта: отступ снят, синтаксис подсвечен.
 *
 * Один и тот же вид кода нужен и в дереве отличий от поставщика, и в перечне
 * замечаний — по прямой просьбе пользователя. Держать это одной функцией
 * обязательно: два места с почти одинаковой разметкой уже расходились.
 *
 * Строки НЕ переносятся: перенос ломает выравнивание запроса и мешает
 * сравнивать две колонки построчно. Длинная строка уезжает за правый край,
 * и блок прокручивается — по ширине и по высоте (см. `pre.snippet`).
 */
export function codeBlock(text, extraClass = '') {
  const cls = extraClass ? `snippet ${extraClass}` : 'snippet';
  return `<pre class="${cls}">${highlightBsl(dedent(text))}</pre>`;
}
