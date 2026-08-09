/**
 * Извлечение и анализ текстов запросов, встроенных в код 1С.
 *
 * Запрос попадает в модуль двумя основными способами:
 *   Запрос.Текст = "ВЫБРАТЬ ...";
 *   Запрос = Новый Запрос("ВЫБРАТЬ ...");
 * плюс СхемаЗапроса и построители — их мы не разбираем, но отмечаем.
 *
 * Анализ намеренно лексический: строить полноценный парсер языка запросов ради
 * набора эвристик нерационально, а типовые проблемы (соединения, подзапросы,
 * отсутствие индексируемых отборов) надёжно видны и так.
 *
 * ВАЖНО: границы слов задаются через word() из wordBoundary.js, а не через \b —
 * стандартная граница \b не работает с кириллицей (см. пояснение в том модуле).
 */

import { TOKEN } from './lexer.js';
import { word, testWord, countMatches, WORD_CHAR } from './wordBoundary.js';

/** Шаблоны ключевых конструкций языка запросов (русский и английский варианты). */
const Q = {
  select: word('ВЫБРАТЬ|SELECT'),
  from: word('ИЗ|FROM'),
  join: word('(?:ЛЕВОЕ|ПРАВОЕ|ПОЛНОЕ|ВНУТРЕННЕЕ)\\s+СОЕДИНЕНИЕ|(?:LEFT|RIGHT|FULL|INNER)\\s+(?:OUTER\\s+)?JOIN|СОЕДИНЕНИЕ|JOIN'),
  where: word('ГДЕ|WHERE'),
  groupBy: word('СГРУППИРОВАТЬ\\s+ПО|GROUP\\s+BY'),
  orderBy: word('УПОРЯДОЧИТЬ\\s+ПО|ORDER\\s+BY'),
  union: word('ОБЪЕДИНИТЬ(?:\\s+ВСЕ)?|UNION(?:\\s+ALL)?'),
  having: word('ИМЕЮЩИЕ|HAVING'),
  inHierarchy: word('В\\s+ИЕРАРХИИ|IN\\s+HIERARCHY'),
  distinct: word('РАЗЛИЧНЫЕ|DISTINCT'),
  top: word('(?:ПЕРВЫЕ|TOP)\\s+\\d+'),
  intoTemp: word('ПОМЕСТИТЬ|INTO'),
  allowed: word('РАЗРЕШЕННЫЕ|ALLOWED'),
  forChange: word('ДЛЯ\\s+ИЗМЕНЕНИЯ|FOR\\s+UPDATE'),
  autoOrder: word('АВТОУПОРЯДОЧИВАНИЕ|AUTOORDER'),
  virtualTable: new RegExp(
    `\\.(?:ОстаткиИОбороты|Остатки|Обороты|СрезПоследних|СрезПервых|` +
    `BalanceAndTurnovers|Balance|Turnovers|SliceLast|SliceFirst)(?![${WORD_CHAR}])`,
    'gi',
  ),
  subQuery: new RegExp(`\\(\\s*(?:ВЫБРАТЬ|SELECT)(?![${WORD_CHAR}])`, 'gi'),
};

/**
 * @typedef {object} EmbeddedQuery
 * @property {string} text текст запроса
 * @property {number} line строка начала
 * @property {number} tokenIdx индекс токена-литерала
 * @property {string} assignedTo к чему присвоен (для диагностики)
 */

/**
 * Находит в потоке токенов строковые литералы, похожие на текст запроса.
 * @param {import('./lexer.js').Token[]} tokens
 * @returns {EmbeddedQuery[]}
 */
export function extractQueries(tokens) {
  /** @type {EmbeddedQuery[]} */
  const queries = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.STRING) continue;
    if (!looksLikeQuery(token.value)) continue;

    // Склеиваем конкатенацию литералов: "ВЫБРАТЬ ..." + "ГДЕ ..."
    let text = token.value;
    let last = i;
    let j = i + 1;
    while (
      tokens[j]?.type === TOKEN.OPERATOR && tokens[j].value === '+' &&
      tokens[j + 1]?.type === TOKEN.STRING
    ) {
      text += '\n' + tokens[j + 1].value;
      last = j + 1;
      j += 2;
    }

    queries.push({
      text,
      line: token.line,
      tokenIdx: i,
      endTokenIdx: last,
      assignedTo: guessAssignmentTarget(tokens, i),
    });
    i = last;
  }
  return queries;
}

/** Отсекает обычные строки: текст запроса обязан содержать ВЫБРАТЬ и источник. */
export function looksLikeQuery(text) {
  if (!text || text.length < 20) return false;
  if (!testWord(Q.select, text)) return false;
  return testWord(Q.from, text) || testWord(Q.intoTemp, text);
}

function guessAssignmentTarget(tokens, strIdx) {
  // Ищем слева: <Идент>.<Идент> = "..."  либо  Новый Запрос("...")
  for (let i = strIdx - 1; i >= 0 && i > strIdx - 8; i -= 1) {
    const t = tokens[i];
    if (t.type === TOKEN.KEYWORD && t.keyword === 'new') return 'Новый Запрос';
    if (t.type === TOKEN.OPERATOR && t.value === '=') {
      const parts = [];
      let k = i - 1;
      while (k >= 0 && parts.length < 4) {
        const p = tokens[k];
        if (p.type === TOKEN.IDENT) parts.unshift(p.value);
        else if (p.type === TOKEN.OPERATOR && p.value === '.') { k -= 1; continue; }
        else break;
        k -= 1;
      }
      return parts.join('.');
    }
  }
  return '';
}

/**
 * Метрики текста запроса.
 * @param {string} text
 */
export function analyzeQueryText(text) {
  const stripped = stripQueryComments(text);
  const tables = extractTables(stripped);

  return {
    length: text.length,
    lines: text.split('\n').length,
    selects: countMatches(Q.select, stripped),
    joins: countMatches(Q.join, stripped),
    subQueries: countMatches(Q.subQuery, stripped),
    unions: countMatches(Q.union, stripped),
    virtualTables: countMatches(Q.virtualTable, stripped),
    hasWhere: testWord(Q.where, stripped),
    hasGroupBy: testWord(Q.groupBy, stripped),
    hasOrderBy: testWord(Q.orderBy, stripped),
    hasHaving: testWord(Q.having, stripped),
    hasDistinct: testWord(Q.distinct, stripped),
    hasTop: testWord(Q.top, stripped),
    hasInHierarchy: testWord(Q.inHierarchy, stripped),
    hasAllowed: testWord(Q.allowed, stripped),
    hasForUpdate: testWord(Q.forChange, stripped),
    hasAutoOrder: testWord(Q.autoOrder, stripped),
    hasTempTable: testWord(Q.intoTemp, stripped),
    tables,
    tableCount: tables.length,
  };
}

function stripQueryComments(text) {
  return String(text || '').replace(/\/\/[^\n]*/g, '');
}

/** Извлекает имена таблиц после ИЗ / СОЕДИНЕНИЕ. */
export function extractTables(text) {
  const tables = new Set();
  const re = new RegExp(
    `(?<![${WORD_CHAR}])(?:ИЗ|FROM|СОЕДИНЕНИЕ|JOIN)\\s+([${WORD_CHAR}][${WORD_CHAR}.]*)`,
    'gi',
  );
  let m;
  while ((m = re.exec(text)) !== null) {
    tables.add(m[1]);
  }
  return [...tables];
}

/**
 * Оценивает, содержит ли запрос отбор по неиндексируемому условию.
 *
 * Надёжно определить наличие индекса без метаданных нельзя, поэтому правило
 * ищет заведомо проблемные конструкции: отбор по реквизиту через цепочку точек
 * (неявное соединение по ссылке), ПОДОБНО с ведущим «%», функции над полем.
 */
export function findNonIndexableFilters(text) {
  const issues = [];
  const stripped = stripQueryComments(text);

  Q.where.lastIndex = 0;
  const whereMatch = Q.where.exec(stripped);
  Q.where.lastIndex = 0;
  if (!whereMatch) return issues;

  const wherePart = stripped.slice(whereMatch.index);

  // Отбор по полю через две и более точки: Товар.Владелец.Наименование
  const dottedRe = new RegExp(`[${WORD_CHAR}]+(?:\\.[${WORD_CHAR}]+){2,}`, 'g');
  const dotted = wherePart.match(dottedRe);
  if (dotted?.length) {
    issues.push({
      kind: 'dottedFilter',
      detail:
        `Отбор через цепочку точек (${[...new Set(dotted)].slice(0, 3).join(', ')}) — ` +
        'платформа выполнит неявное соединение с таблицей по ссылке, и индекс использован не будет',
    });
  }

  if (new RegExp(`(?<![${WORD_CHAR}])(?:ПОДОБНО|LIKE)\\s*"?%`, 'i').test(wherePart)) {
    issues.push({
      kind: 'leadingWildcard',
      detail: 'Условие ПОДОБНО с ведущим символом «%» не может использовать индекс — приведёт к полному сканированию таблицы',
    });
  }

  if (new RegExp(`(?<![${WORD_CHAR}])(?:ВЫРАЗИТЬ|CAST)\\s*\\(`, 'i').test(wherePart)) {
    issues.push({
      kind: 'castInWhere',
      detail: 'Приведение типа (ВЫРАЗИТЬ) в условии отбора блокирует использование индекса',
    });
  }

  if (new RegExp(`(?<![${WORD_CHAR}])(?:ПОДСТРОКА|SUBSTRING)\\s*\\(`, 'i').test(wherePart)) {
    issues.push({
      kind: 'functionInWhere',
      detail: 'Вызов функции над полем в условии отбора блокирует использование индекса',
    });
  }

  return issues;
}

export { Q as QUERY_PATTERNS };
