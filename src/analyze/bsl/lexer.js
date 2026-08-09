/**
 * Лексический разбор встроенного языка 1С (BSL).
 *
 * Полноценный парсер здесь избыточен: правила анализа работают на уровне
 * «строка/токен/блок», а не AST. Но наивный поиск по регулярным выражениям даёт
 * ложные срабатывания внутри строк и комментариев, поэтому лексер обязателен.
 *
 * Учитываются особенности языка 1С:
 *   • строковые литералы с удвоением кавычки: "он сказал ""да""";
 *   • многострочные строки с вертикальной чертой в начале продолжения;
 *   • комментарии // до конца строки;
 *   • инструкции препроцессора (#Если Сервер Тогда) и директивы компиляции
 *     (&НаКлиенте, &НаСервере) — они влияют на контекст исполнения;
 *   • русские и английские ключевые слова.
 */

export const TOKEN = {
  IDENT: 'ident',
  KEYWORD: 'keyword',
  STRING: 'string',
  NUMBER: 'number',
  DATE: 'date',
  OPERATOR: 'operator',
  PREPROC: 'preproc',
  DIRECTIVE: 'directive',
  COMMENT: 'comment',
};

/** Ключевые слова: русский вариант → канонический идентификатор. */
const KEYWORDS = new Map(Object.entries({
  процедура: 'procedure', procedure: 'procedure',
  функция: 'function', function: 'function',
  конецпроцедуры: 'endprocedure', endprocedure: 'endprocedure',
  конецфункции: 'endfunction', endfunction: 'endfunction',
  если: 'if', if: 'if',
  тогда: 'then', then: 'then',
  иначе: 'else', else: 'else',
  иначеесли: 'elsif', elsif: 'elsif',
  конецесли: 'endif', endif: 'endif',
  для: 'for', for: 'for',
  каждого: 'each', each: 'each',
  из: 'in', in: 'in',
  по: 'to', to: 'to',
  пока: 'while', while: 'while',
  цикл: 'do', do: 'do',
  конеццикла: 'enddo', enddo: 'enddo',
  прервать: 'break', break: 'break',
  продолжить: 'continue', continue: 'continue',
  попытка: 'try', try: 'try',
  исключение: 'except', except: 'except',
  конецпопытки: 'endtry', endtry: 'endtry',
  возврат: 'return', return: 'return',
  перем: 'var', var: 'var',
  экспорт: 'export', export: 'export',
  знач: 'val', val: 'val',
  новый: 'new', new: 'new',
  выполнить: 'execute', execute: 'execute',
  вычислить: 'eval', eval: 'eval',
  вызватьисключение: 'raise', raise: 'raise',
  и: 'and', and: 'and',
  или: 'or', or: 'or',
  не: 'not', not: 'not',
  истина: 'true', true: 'true',
  ложь: 'false', false: 'false',
  неопределено: 'undefined', undefined: 'undefined',
  null: 'null',
  addhandler: 'addhandler', добавитьобработчик: 'addhandler',
  removehandler: 'removehandler', удалитьобработчик: 'removehandler',
  перейти: 'goto', goto: 'goto',
}));

const IDENT_START = /[A-Za-zА-Яа-яЁё_]/;
const IDENT_PART = /[A-Za-zА-Яа-яЁё0-9_]/;

/**
 * @typedef {object} Token
 * @property {string} type
 * @property {string} value исходный текст
 * @property {string} [keyword] канонический идентификатор ключевого слова
 * @property {number} line 1-based
 * @property {number} col 1-based
 * @property {number} pos смещение в исходном тексте
 */

/**
 * Разбирает исходный текст модуля на токены.
 * Комментарии по умолчанию не попадают в результат (но считаются в статистике).
 *
 * @param {string} source
 * @param {{keepComments?: boolean}} [options]
 * @returns {{tokens: Token[], stats: {lines: number, codeLines: number, commentLines: number, blankLines: number}}}
 */
export function tokenize(source, options = {}) {
  const { keepComments = false } = options;
  const tokens = [];
  const text = source || '';
  const len = text.length;

  let i = 0;
  let line = 1;
  let lineStart = 0;

  /** Строки, содержащие исполняемый код / комментарий. */
  const codeLineSet = new Set();
  const commentLineSet = new Set();

  const col = () => i - lineStart + 1;

  const push = (type, value, startLine, startCol, pos) => {
    const token = { type, value, line: startLine, col: startCol, pos };
    if (type === TOKEN.KEYWORD) token.keyword = KEYWORDS.get(value.toLowerCase());
    tokens.push(token);
  };

  while (i < len) {
    const ch = text[i];

    // --- Перевод строки ---
    if (ch === '\n') {
      line += 1;
      i += 1;
      lineStart = i;
      continue;
    }
    if (ch === '\r') { i += 1; continue; }

    // --- Пробелы ---
    if (ch === ' ' || ch === '\t') { i += 1; continue; }

    // --- Комментарий ---
    if (ch === '/' && text[i + 1] === '/') {
      const startLine = line;
      const startCol = col();
      const start = i;
      while (i < len && text[i] !== '\n') i += 1;
      commentLineSet.add(startLine);
      if (keepComments) push(TOKEN.COMMENT, text.slice(start, i), startLine, startCol, start);
      continue;
    }

    // --- Инструкция препроцессора: #Если, #Область, #КонецЕсли ---
    if (ch === '#') {
      const startLine = line;
      const startCol = col();
      const start = i;
      while (i < len && text[i] !== '\n') i += 1;
      codeLineSet.add(startLine);
      push(TOKEN.PREPROC, text.slice(start, i).trim(), startLine, startCol, start);
      continue;
    }

    // --- Директива компиляции: &НаКлиенте, &НаСервереБезКонтекста ---
    if (ch === '&') {
      const startLine = line;
      const startCol = col();
      const start = i;
      i += 1;
      while (i < len && IDENT_PART.test(text[i])) i += 1;
      codeLineSet.add(startLine);
      push(TOKEN.DIRECTIVE, text.slice(start, i), startLine, startCol, start);
      continue;
    }

    // --- Строковый литерал ---
    if (ch === '"') {
      const startLine = line;
      const startCol = col();
      const start = i;
      i += 1;
      let value = '';
      while (i < len) {
        const c = text[i];
        if (c === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        if (c === '\n') {
          // Многострочная строка: продолжение начинается с '|'.
          line += 1;
          i += 1;
          lineStart = i;
          while (i < len && (text[i] === ' ' || text[i] === '\t')) i += 1;
          if (text[i] === '|') { i += 1; value += '\n'; continue; }
          // Незакрытая строка — прекращаем, чтобы не «съесть» весь модуль.
          break;
        }
        value += c;
        i += 1;
      }
      codeLineSet.add(startLine);
      tokens.push({ type: TOKEN.STRING, value, raw: text.slice(start, i), line: startLine, col: startCol, pos: start });
      continue;
    }

    // --- Литерал даты: '20240115' ---
    if (ch === "'") {
      const startLine = line;
      const startCol = col();
      const start = i;
      i += 1;
      while (i < len && text[i] !== "'" && text[i] !== '\n') i += 1;
      if (text[i] === "'") i += 1;
      codeLineSet.add(startLine);
      push(TOKEN.DATE, text.slice(start, i), startLine, startCol, start);
      continue;
    }

    // --- Число ---
    if (ch >= '0' && ch <= '9') {
      const startLine = line;
      const startCol = col();
      const start = i;
      while (i < len && /[0-9.]/.test(text[i])) i += 1;
      codeLineSet.add(startLine);
      push(TOKEN.NUMBER, text.slice(start, i), startLine, startCol, start);
      continue;
    }

    // --- Идентификатор или ключевое слово ---
    if (IDENT_START.test(ch)) {
      const startLine = line;
      const startCol = col();
      const start = i;
      while (i < len && IDENT_PART.test(text[i])) i += 1;
      const word = text.slice(start, i);
      codeLineSet.add(startLine);
      push(KEYWORDS.has(word.toLowerCase()) ? TOKEN.KEYWORD : TOKEN.IDENT, word, startLine, startCol, start);
      continue;
    }

    // --- Оператор / пунктуация ---
    {
      const startLine = line;
      const startCol = col();
      const start = i;
      const two = text.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>') i += 2;
      else i += 1;
      codeLineSet.add(startLine);
      push(TOKEN.OPERATOR, text.slice(start, i), startLine, startCol, start);
    }
  }

  const totalLines = text.length === 0 ? 0 : text.split('\n').length;
  const commentOnly = [...commentLineSet].filter((l) => !codeLineSet.has(l)).length;

  return {
    tokens,
    stats: {
      lines: totalLines,
      codeLines: codeLineSet.size,
      commentLines: commentOnly,
      blankLines: Math.max(0, totalLines - codeLineSet.size - commentOnly),
    },
  };
}

/** Является ли токен ключевым словом с заданным каноническим именем. */
export function isKeyword(token, canonical) {
  return token?.type === TOKEN.KEYWORD && token.keyword === canonical;
}

/** Идентификатор без учёта регистра (1С регистронезависим). */
export function identEquals(token, name) {
  return token?.type === TOKEN.IDENT && token.value.toLowerCase() === name.toLowerCase();
}

export { KEYWORDS };
