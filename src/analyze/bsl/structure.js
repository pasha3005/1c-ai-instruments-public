/**
 * Структурный анализ модуля: процедуры, циклы, вложенность, сложность.
 *
 * Работает на потоке токенов из lexer.js. Результат используется правилами
 * анализа качества кода: например, «обращение к базе внутри цикла» — это
 * пересечение диапазона токенов вызова с диапазоном тела цикла.
 */

import { TOKEN } from './lexer.js';

/**
 * @typedef {object} Routine
 * @property {string} name
 * @property {'procedure'|'function'} kind
 * @property {boolean} isExport
 * @property {string[]} directives директивы компиляции (&НаКлиенте, ...)
 * @property {string[]} params
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} lines
 * @property {number} startIdx индекс первого токена
 * @property {number} endIdx индекс последнего токена
 * @property {number} complexity цикломатическая сложность
 * @property {number} maxNesting максимальная глубина вложенности блоков
 * @property {number} bodyStartIdx индекс первого токена тела
 */

/**
 * @typedef {object} LoopBlock
 * @property {number} startIdx индекс токена «Цикл»
 * @property {number} endIdx индекс токена «КонецЦикла»
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} depth глубина вложенности (1 — внешний цикл)
 * @property {string} kind 'for' | 'foreach' | 'while'
 */

const BLOCK_OPENERS = new Set(['if', 'for', 'while', 'try', 'do']);

/**
 * @param {import('./lexer.js').Token[]} tokens
 * @returns {{routines: Routine[], loops: LoopBlock[], preprocessor: object[]}}
 */
export function analyzeStructure(tokens) {
  /** @type {Routine[]} */
  const routines = [];
  /** @type {LoopBlock[]} */
  const loops = [];
  const preprocessor = [];

  /** Стек открытых циклов: элементы — индексы в `loops`. */
  const loopStack = [];
  /** Накопленные директивы компиляции перед объявлением процедуры. */
  let pendingDirectives = [];

  let current = null;
  let nesting = 0;
  let maxNesting = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.type === TOKEN.DIRECTIVE) {
      pendingDirectives.push(token.value);
      continue;
    }

    if (token.type === TOKEN.PREPROC) {
      preprocessor.push({ text: token.value, line: token.line });
      continue;
    }

    if (token.type !== TOKEN.KEYWORD) continue;

    switch (token.keyword) {
      case 'procedure':
      case 'function': {
        const nameToken = tokens[i + 1];
        const { params, closeIdx } = readParams(tokens, i + 2);
        const isExport = tokens[closeIdx + 1]?.keyword === 'export';
        current = {
          name: nameToken?.value || '<без имени>',
          kind: token.keyword === 'function' ? 'function' : 'procedure',
          isExport,
          directives: pendingDirectives,
          params,
          startLine: token.line,
          endLine: token.line,
          lines: 1,
          startIdx: i,
          endIdx: i,
          bodyStartIdx: (isExport ? closeIdx + 2 : closeIdx + 1),
          complexity: 1,
          maxNesting: 0,
          // Из чего складывается сложность — для содержательного текста
          // замечания: «высокая сложность» без разбивки ничего не объясняет.
          complexityParts: { conditions: 0, loops: 0, logical: 0, exceptions: 0 },
        };
        pendingDirectives = [];
        nesting = 0;
        maxNesting = 0;
        break;
      }

      case 'endprocedure':
      case 'endfunction': {
        if (current) {
          current.endLine = token.line;
          current.endIdx = i;
          current.lines = Math.max(1, token.line - current.startLine + 1);
          current.maxNesting = maxNesting;
          routines.push(current);
          current = null;
        }
        nesting = 0;
        maxNesting = 0;
        break;
      }

      case 'do': {
        // «Цикл» открывает тело цикла (и в «Для … Цикл», и в «Пока … Цикл»).
        const kind = detectLoopKind(tokens, i);
        loopStack.push(loops.length);
        loops.push({
          startIdx: i,
          endIdx: -1,
          startLine: token.line,
          endLine: token.line,
          depth: loopStack.length,
          kind,
          routineName: current?.name || null,
        });
        nesting += 1;
        maxNesting = Math.max(maxNesting, nesting);
        if (current) {
          current.complexity += 1;
          current.complexityParts.loops += 1;
        }
        break;
      }

      case 'enddo': {
        const idx = loopStack.pop();
        if (idx !== undefined) {
          loops[idx].endIdx = i;
          loops[idx].endLine = token.line;
        }
        nesting = Math.max(0, nesting - 1);
        break;
      }

      case 'if': {
        nesting += 1;
        maxNesting = Math.max(maxNesting, nesting);
        if (current) {
          current.complexity += 1;
          current.complexityParts.conditions += 1;
        }
        break;
      }

      case 'try': {
        nesting += 1;
        maxNesting = Math.max(maxNesting, nesting);
        if (current) {
          current.complexity += 1;
          current.complexityParts.exceptions += 1;
        }
        break;
      }

      case 'endif':
      case 'endtry': {
        nesting = Math.max(0, nesting - 1);
        break;
      }

      case 'elsif': {
        if (current) {
          current.complexity += 1;
          current.complexityParts.conditions += 1;
        }
        break;
      }

      case 'and':
      case 'or': {
        if (current) {
          current.complexity += 1;
          current.complexityParts.logical += 1;
        }
        break;
      }

      default:
        break;
    }
  }

  // Незакрытые циклы (синтаксически некорректный модуль) — закрываем в конце.
  for (const loop of loops) {
    if (loop.endIdx === -1) {
      loop.endIdx = tokens.length - 1;
      loop.endLine = tokens[tokens.length - 1]?.line || loop.startLine;
    }
  }

  return { routines, loops, preprocessor };
}

/** Определяет вид цикла по токенам слева от «Цикл». */
function detectLoopKind(tokens, doIdx) {
  for (let i = doIdx - 1; i >= 0 && i > doIdx - 40; i -= 1) {
    const t = tokens[i];
    if (t.type !== TOKEN.KEYWORD) continue;
    if (t.keyword === 'while') return 'while';
    if (t.keyword === 'each') return 'foreach';
    if (t.keyword === 'for') return 'for';
    if (t.keyword === 'enddo' || t.keyword === 'endprocedure' || t.keyword === 'endfunction') break;
  }
  return 'for';
}

/** Читает список параметров процедуры, начиная с открывающей скобки. */
function readParams(tokens, openIdx) {
  const params = [];
  if (tokens[openIdx]?.value !== '(') {
    return { params, closeIdx: openIdx };
  }
  let depth = 0;
  let i = openIdx;
  let expectName = true;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === TOKEN.OPERATOR && t.value === '(') { depth += 1; continue; }
    if (t.type === TOKEN.OPERATOR && t.value === ')') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (t.type === TOKEN.OPERATOR && t.value === ',') { expectName = true; continue; }
    if (t.type === TOKEN.KEYWORD && t.keyword === 'val') continue;
    if (expectName && t.type === TOKEN.IDENT) {
      params.push(t.value);
      expectName = false;
    }
  }
  return { params, closeIdx: i };
}

/** Находит цикл, внутри которого лежит токен с указанным индексом. */
export function findEnclosingLoop(loops, tokenIdx) {
  let best = null;
  for (const loop of loops) {
    if (tokenIdx > loop.startIdx && tokenIdx < loop.endIdx) {
      if (!best || loop.depth > best.depth) best = loop;
    }
  }
  return best;
}

/** Находит процедуру, внутри которой лежит токен. */
export function findEnclosingRoutine(routines, tokenIdx) {
  for (const routine of routines) {
    if (tokenIdx >= routine.startIdx && tokenIdx <= routine.endIdx) return routine;
  }
  return null;
}

/**
 * Находит процедуру, которой принадлежит строка исходного текста.
 *
 * В отличие от `findEnclosingRoutine` работает по номеру строки, а не индексу
 * токена: находки правил и участки отличий от поставщика несут номер строки,
 * а не позицию в потоке токенов.
 */
export function findRoutineAtLine(routines, line) {
  if (!line) return null;
  for (const routine of routines) {
    if (line >= routine.startLine && line <= routine.endLine) return routine;
  }
  return null;
}

/**
 * Извлекает цепочку обращения вида `Объект.Метод` начиная с индекса токена-идентификатора.
 * Возвращает строку в нижнем регистре, например «запрос.выполнить».
 */
export function readMemberChain(tokens, idx, maxParts = 4) {
  const parts = [];
  let i = idx;
  while (i < tokens.length && parts.length < maxParts) {
    const t = tokens[i];
    if (t.type !== TOKEN.IDENT && t.type !== TOKEN.KEYWORD) break;
    parts.push(t.value.toLowerCase());
    if (tokens[i + 1]?.type === TOKEN.OPERATOR && tokens[i + 1].value === '.') {
      i += 2;
      continue;
    }
    break;
  }
  return parts.join('.');
}
