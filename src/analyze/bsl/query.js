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
import { KINDS } from '../../parse/metadataKinds.js';

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

/**
 * Комментарии внутри текста запроса не выбрасываются, а забиваются пробелами
 * той же длины: позиции символов должны совпадать с исходным текстом, иначе
 * найденное место («вот эта строка запроса») указывает не туда. На счётчики
 * и проверки наличия конструкций это не влияет — там важны только слова.
 */
function stripQueryComments(text) {
  return String(text || '').replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * Место конструкции внутри текста запроса — в строках от его начала, вместе
 * с фрагментом кода вокруг.
 *
 * Замечание обязано указывать на ту строку, о которой говорит. Раньше все
 * замечания к запросу показывали его первые шесть строк и номер строки его
 * начала: в тексте замечания стояло «отбор через цепочку точек
 * (ТаблицаИзменений.Договор.ВалютаВзаиморасчетов)», а в приведённом фрагменте
 * этой строки не было вовсе — условие ГДЕ находится строк на пятьдесят ниже.
 * Пользователь поймал это сразу.
 *
 * @param {string} text текст запроса
 * @param {number} offset позиция символа внутри текста
 * @param {number} [context] сколько строк показать до и после
 */
export function queryPlace(text, offset, context = 2) {
  const rows = String(text || '').split('\n');
  const at = Math.max(0, Math.min(Number(offset) || 0, String(text || '').length));

  let consumed = 0;
  let index = 0;
  for (; index < rows.length; index += 1) {
    const next = consumed + rows[index].length + 1;
    if (next > at) break;
    consumed = next;
  }
  index = Math.min(index, Math.max(0, rows.length - 1));

  const from = Math.max(0, index - context);
  const to = Math.min(rows.length, index + context + 1);
  return {
    lineOffset: index,
    snippet: rows.slice(from, to).map((row) => row.trimEnd()).join('\n').slice(0, 600),
  };
}

/** Место первого вхождения конструкции — для правил, привязанных к слову. */
export function queryPlaceOf(text, pattern) {
  const stripped = stripQueryComments(text);
  const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  const found = re.exec(stripped);
  return queryPlace(text, found ? found.index : 0);
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
 * Имена видов объектов метаданных так, как они пишутся в языке запросов:
 * «Справочник», «РегистрНакопления», «ПланВидовХарактеристик». Берутся
 * из общего справочника видов, чтобы список не расходился с ним: пробелы
 * и дефисы выбрасываются, «ё» приводится к «е».
 */
const METADATA_PREFIXES = new Set(
  KINDS.flatMap((kind) => [kind.tag, kind.ru]).map(normalizeName),
);

function normalizeName(name) {
  return String(name || '').replace(/[\s-]+/g, '').replace(/ё/g, 'е').toLowerCase();
}

/**
 * Цепочка точек, начинающаяся с вида объекта метаданных, — это обращение
 * к самим метаданным, а не отбор по реквизиту через ссылку.
 *
 * Так пишутся значение перечисления и предопределённый элемент
 * (`ЗНАЧЕНИЕ(Перечисление.Периодичность.Месяц)`,
 * `ЗНАЧЕНИЕ(Справочник.Контрагенты.РозничныйПокупатель)`), табличная часть
 * и виртуальная таблица в источнике (`Документ.ОтчетОРозничныхПродажах.Товары`,
 * `РегистрНакопления.ТоварыНаСкладах.Остатки`). Неявного соединения по ссылке
 * здесь нет, и замечанием это не является — прямое указание пользователя.
 *
 * Платой за такую проверку остаётся пропуск: если таблице дан псевдоним,
 * совпадающий с названием вида («… КАК Документ»), отбор
 * `Документ.Контрагент.Наименование` тоже будет пропущен. Отличить одно
 * от другого без метаданных конфигурации нечем, а ложное замечание в отчёте
 * заказчика дороже пропущенного.
 */
function isMetadataChain(chain) {
  return METADATA_PREFIXES.has(normalizeName(String(chain).split('.')[0]));
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

  // Смещение начала ГДЕ в тексте запроса: `offset` каждого замечания считается
  // от начала запроса, а не от начала условия, — иначе фрагмент кода в отчёте
  // указывает не на ту строку.
  const whereAt = whereMatch.index;
  const wherePart = stripped.slice(whereAt);

  // Отбор по полю через две и более точки: Товар.Владелец.Наименование
  const dottedRe = new RegExp(`[${WORD_CHAR}]+(?:\\.[${WORD_CHAR}]+){2,}`, 'g');
  const dotted = [...wherePart.matchAll(dottedRe)].filter((m) => !isMetadataChain(m[0]));
  if (dotted.length) {
    issues.push({
      kind: 'dottedFilter',
      offset: whereAt + dotted[0].index,
      detail:
        `Отбор через цепочку точек (${[...new Set(dotted.map((m) => m[0]))].slice(0, 3).join(', ')}) — ` +
        'платформа выполнит неявное соединение с таблицей по ссылке, и индекс использован не будет',
    });
  }

  const wildcard = new RegExp(`(?<![${WORD_CHAR}])(?:ПОДОБНО|LIKE)\\s*"?%`, 'i').exec(wherePart);
  if (wildcard) {
    issues.push({
      kind: 'leadingWildcard',
      offset: whereAt + wildcard.index,
      detail: 'Условие ПОДОБНО с ведущим символом «%» не может использовать индекс — приведёт к полному сканированию таблицы',
    });
  }

  const cast = new RegExp(`(?<![${WORD_CHAR}])(?:ВЫРАЗИТЬ|CAST)\\s*\\(`, 'i').exec(wherePart);
  if (cast) {
    issues.push({
      kind: 'castInWhere',
      offset: whereAt + cast.index,
      detail: 'Приведение типа (ВЫРАЗИТЬ) в условии отбора блокирует использование индекса',
    });
  }

  const substring = new RegExp(`(?<![${WORD_CHAR}])(?:ПОДСТРОКА|SUBSTRING)\\s*\\(`, 'i').exec(wherePart);
  if (substring) {
    issues.push({
      kind: 'functionInWhere',
      offset: whereAt + substring.index,
      detail: 'Вызов функции над полем в условии отбора блокирует использование индекса',
    });
  }

  return issues;
}

export { Q as QUERY_PATTERNS };
