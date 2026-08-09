/**
 * Поиск авторских вставок в типовом модуле.
 *
 * Зачем. Сравнение с конфигурацией поставщика отбирает изменённые модули, но
 * изменённый типовой модуль на 5 000 строк — это по-прежнему почти целиком код
 * вендора, в который интегратор вставил десяток строк. Проверять его целиком
 * бессмысленно: замечания будут к чужому коду, который никто не станет править.
 *
 * Поэтому внутри изменённого типового модуля анализируются только участки,
 * помеченные комментариями разработчика. Это устоявшаяся практика 1С: правки
 * в типовом коде обрамляют парными комментариями, чтобы их было видно при
 * обновлении.
 *
 * Распознаются принятые в отрасли варианты:
 *
 *   //++ ДРБ_1234            …код…   //-- ДРБ_1234
 *   // {{ Иванов             …код…   // }} Иванов
 *   // <<< Начало правки >>>  …код…   // <<< Конец правки >>>
 *   // Начало изменений ДРБ   …код…   // Конец изменений ДРБ
 *   Значение = 1; // Иванов 12.05.2021 — одиночная пометка на строке
 *
 * ГЛАВНАЯ ЛОВУШКА: теми же значками пользуются вендор и платформа. В 1С:ERP
 * типовой код обрамлён комментариями «//++ НЕ УТ», «//++ НЕ УТКА»,
 * «// Локализация» — это условная сборка (ERP, КА и УТ собираются из общих
 * исходников), а не правка интегратора. Пока их не отсеивали, аудит записывал
 * «НЕ УТКА» в разработчики и выдавал сотни замечаний к коду вендора.
 * Перечень таких пометок вынесен в `markerDictionary.js` и пополняется там же.
 *
 * Модуль намеренно не пытается быть исчерпывающим: лучше пропустить
 * нераспознанную разметку (модуль просто не попадёт в анализ), чем принять
 * типовой код за доработку и завалить отчёт замечаниями к вендору.
 */

import { testWord } from './wordBoundary.js';
import {
  PAIRED_MARKERS,
  EDIT_WORDS,
  NOISE_WORDS,
  NOISE_EDGES,
  DATE_RE,
  SURNAME_RE,
  SURNAME_INITIALS_RE,
  INITIALS_ONLY_RE,
  looksLikeName,
  UNKNOWN_AUTHOR,
  isVendorMarker,
  hasAuthorSignal,
  buildPrefixRegex,
} from './markerDictionary.js';

export { UNKNOWN_AUTHOR };

/**
 * @typedef {object} AuthoredRegion
 * @property {number} startLine первая строка вставки (1-based)
 * @property {number} endLine последняя строка вставки
 * @property {string} author имя разработчика или префикс правки
 * @property {string} marker текст распознанного маркера
 * @property {boolean} paired найден ли закрывающий маркер
 */

/**
 * Находит участки, помеченные комментариями разработчика.
 *
 * @param {string} source текст модуля
 * @param {object} [options]
 * @param {string[]} [options.prefixes] известные префиксы доработок («ДРБ_», «инт_»)
 * @param {number} [options.unpairedTail] сколько строк относить к незакрытому маркеру
 * @returns {AuthoredRegion[]}
 */
export function findAuthoredRegions(source, options = {}) {
  const { prefixes = [], unpairedTail = 40 } = options;
  const lines = String(source).split(/\r?\n/);
  const prefixRe = buildPrefixRegex(prefixes);

  /** @type {AuthoredRegion[]} */
  const regions = [];
  /** @type {{startLine: number, author: string, marker: string, close: RegExp}|null} */
  let open = null;
  /** Открытая пометка вендора: её содержимое не наше, но закрыть её надо. */
  /** @type {RegExp|null} */
  let vendorClose = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    const commentAt = findCommentStart(line);
    if (commentAt < 0) continue;

    const comment = line.slice(commentAt);
    const isOwnLine = line.slice(0, commentAt).trim() === '';

    // Закрытие участка вендора — просто снимаем признак, ничего не сохраняем.
    if (vendorClose) {
      if (vendorClose.test(comment)) vendorClose = null;
      continue;
    }

    // Закрытие текущей вставки.
    if (open && open.close.test(comment)) {
      regions.push({
        startLine: open.startLine,
        endLine: lineNo,
        author: open.author,
        marker: open.marker,
        paired: true,
      });
      open = null;
      continue;
    }

    const pair = matchOpening(comment);
    // Словесный маркер в шапке документации процедуры правкой не является.
    if (pair && pair.wordy && looksLikeDocBlock(lines, i)) continue;
    if (pair) {
      // Пометка вендора или платформы: код внутри неё — типовой.
      if (isVendorMarker(markerBody(comment), comment)) {
        // Незакрытая авторская вставка обрывается: дальше идёт код вендора.
        if (open) {
          regions.push(closeUnpaired(open, lineNo - 1));
          open = null;
        }
        vendorClose = pair.close;
        continue;
      }

      // Незакрытая предыдущая вставка обрывается на новом маркере.
      if (open) regions.push(closeUnpaired(open, lineNo - 1));
      open = {
        startLine: lineNo,
        author: extractAuthor(comment, prefixRe),
        marker: comment.trim().slice(0, 120),
        close: pair.close,
      };
      continue;
    }

    // Одиночная пометка на строке кода: «Значение = 1; // Иванов 12.05.2021».
    if (!open && !isOwnLine && looksLikeAuthorMark(comment, prefixRe)) {
      regions.push({
        startLine: lineNo,
        endLine: lineNo,
        author: extractAuthor(comment, prefixRe),
        marker: comment.trim().slice(0, 120),
        paired: false,
      });
    }
  }

  if (open) regions.push(closeUnpaired(open, Math.min(lines.length, open.startLine + unpairedTail)));

  return mergeOverlapping(regions);
}

/** Попадает ли строка внутрь любой из вставок. */
export function regionAtLine(regions, line) {
  if (!line) return null;
  return regions.find((r) => line >= r.startLine && line <= r.endLine) || null;
}

/** Сколько строк кода покрыто вставками. */
export function authoredLineCount(regions) {
  return regions.reduce((sum, r) => sum + (r.endLine - r.startLine + 1), 0);
}

// --- Внутреннее --------------------------------------------------------------

function closeUnpaired(open, endLine) {
  return {
    startLine: open.startLine,
    endLine: Math.max(open.startLine, endLine),
    author: open.author,
    marker: open.marker,
    paired: false,
  };
}

function matchOpening(comment) {
  for (const pair of PAIRED_MARKERS) {
    if (!testWord(pair.open, comment)) continue;
    // Для словесных маркеров требуем слово о правке, иначе «// Начало цикла»
    // станет вставкой разработчика.
    if (pair.wordy && !EDIT_WORDS.test(comment)) continue;
    return pair;
  }
  return null;
}

/**
 * Шапка документации процедуры, а не пометка о правке.
 *
 * В типовом модуле БСП встречается «// Начало записи изменений файла.» — слово
 * «изменений» делает строку похожей на маркер, и незакрытый маркер прихватывал
 * следом сорок строк чужого кода. Отличие простое: за настоящей пометкой сразу
 * идёт код, а за шапкой — ещё несколько строк комментария («// Параметры:»).
 * Одну строку пояснения после маркера допускаем: так пишут.
 */
function looksLikeDocBlock(lines, index) {
  let commentLines = 0;
  for (let i = index + 1; i < lines.length && commentLines < 2; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('//')) return false;
    commentLines += 1;
  }
  return commentLines >= 2;
}

/** Тело комментария: без «//» и без знаков самого маркера. */
function markerBody(comment) {
  return String(comment)
    .replace(/^\s*\/\/+/, '')
    .replace(/^[\s+\-{}<>*=!]+/, '')
    .trim();
}

function looksLikeAuthorMark(comment, prefixRe) {
  const body = markerBody(comment);
  if (isVendorMarker(body, comment)) return false;
  if (prefixRe) {
    prefixRe.lastIndex = 0;
    const hit = prefixRe.test(body);
    prefixRe.lastIndex = 0;
    if (hit) return true;
  }
  // «// Иванов 12.05.2021» — фамилия рядом с датой. Одной даты мало:
  // «// действует с 01.01.2020» встречается в типовом коде сплошь и рядом.
  //
  // И подпись всегда коротка. Без ограничения длины подписью становилась любая
  // фраза с датой — на реальной ERP это была строка «Переданные для
  // администрирования в ФНС взносы после 01.01.2017 не регистрируем…»,
  // и её первое слово попадало в отчёт как фамилия разработчика.
  if (body.length > 60 || body.split(/\s+/).length > 7) return false;
  return DATE_RE.test(body) && SURNAME_RE.test(body);
}

/**
 * Имя автора из текста пометки.
 *
 * Раньше сюда возвращался «остаток комментария после вычистки служебных слов»,
 * и на реальной базе в разработчики попадали строки «комментарии в запросе»,
 * «180920 указать цены в строках», «дополнительно может иметь свойство…».
 * Имя нужно ИЗВЛЕКАТЬ, а не брать всё, что не удалось распознать: пометка
 * разработчика обычно начинается с подписи, а дальше идёт описание правки.
 *
 * Порядок разбора:
 *   1. известный префикс доработок конфигурации — «ДРБ_», «инт_и_Иванов»;
 *   2. фамилия с инициалами — «Ким А.П.»;
 *   3. первый токен, похожий на имя или тег, плюс идущие следом инициалы.
 *
 * Ничего не нашлось — «автор не определён». Участок при этом остаётся
 * авторским: пометку поставил человек, просто не подписался.
 */
function extractAuthor(comment, prefixRe) {
  const body = comment.replace(/^\s*\/\/+/, ' ');

  // 1. Фамилия с инициалами — самое точное, что может быть в пометке, поэтому
  //    проверяется первой. Реальная подпись выглядит так:
  //      // ++ ПРО_инт_и_Иванов И.И. 18.03.2021 #4878
  //    Префикс «ПРО_инт_и_» здесь — метка проекта, а человека зовут Иванов И.И.
  //    Пока префикс проверялся раньше, в отчёт попадало «ПРО_инт_и_Иванов»,
  //    и инициалы терялись.
  //    Точку в конце дописываем: «Ким А.П» и «Ким А.П.» — один человек, а в
  //    сводке по разработчикам они расходились на две строки.
  const initials = SURNAME_INITIALS_RE.exec(body);
  if (initials) return initials[0].replace(/\s+/g, ' ').trim().replace(/([А-ЯЁA-Z])$/, '$1.');

  // 2. Известный префикс доработок этой конфигурации.
  if (prefixRe) {
    prefixRe.lastIndex = 0;
    const hit = prefixRe.exec(body);
    prefixRe.lastIndex = 0;
    if (hit) return shortenIdentifier(hit[0].trim());
  }

  // Метки-заполнители нарочно в нижнем регистре и без подчёркиваний: так они
  // не пройдут `looksLikeName` и не станут «автором». Со знаком «#» не годятся —
  // его срезает очистка краёв токена.
  const tokens = body
    .replace(/[#№]\s*\d+/g, ` ${TASK_MARK} `)
    .replace(DATE_RE, ` ${DATE_MARK} `)
    .replace(NOISE_WORDS, ' ')
    .split(/[\s,;:()[\]{}]+/)
    .map((t) => t.replace(NOISE_EDGES, ''))
    .filter(Boolean);

  // 3. Составное имя через подчёркивание: «инт_и_Иванов», «ДРБ_1234».
  const compound = tokens.find((t) => t.includes('_') && looksLikeName(t));
  if (compound) return shortenIdentifier(compound);

  // 4. Слово с заглавной буквы — но только если оно и есть подпись: стоит
  //    перед датой или номером задачи либо составляет весь маркер целиком.
  //    Без этого условия «автором» становилось первое попавшееся слово прозы:
  //    на реальной базе так появились «Приказ», «Число», «Новый», «Вместо».
  const at = tokens.findIndex((t) => looksLikeName(t));
  if (at === -1) return UNKNOWN_AUTHOR;

  const name = tokens[at];
  const next = tokens[at + 1];
  if (INITIALS_ONLY_RE.test(next || '')) return `${name} ${next}`;
  const signature = tokens.length === 1 || next === DATE_MARK || next === TASK_MARK;
  return signature ? name.slice(0, 40) : UNKNOWN_AUTHOR;
}

const DATE_MARK = 'датаправки';
const TASK_MARK = 'номерзадачи';

/**
 * Длинный «хвост» после префикса — это имя объекта или метода, упомянутого
 * в комментарии («ДРБ_ЭлектронныйАрхивВызовСервера», «инт_УстановитьДействияФормы»),
 * а не человек. Такое схлопываем до самого префикса: «ДРБ_», «инт_».
 * Фамилию оставляем целиком — «инт_и_Иванов» и есть искомое имя.
 */
function shortenIdentifier(token) {
  const tail = token.slice(token.lastIndexOf('_') + 1);
  const capitals = (tail.match(/[А-ЯЁA-Z]/g) || []).length;
  if (tail.length <= 15 && capitals <= 1) return token;
  const cut = token.indexOf('_');
  return cut === -1 ? token.slice(0, 28) : token.slice(0, cut + 1);
}

/** Признак авторства для внешних вызовов (используется в отчёте и тестах). */
export function looksAuthored(comment, prefixes = []) {
  const body = markerBody(comment);
  if (isVendorMarker(body, comment)) return false;
  return Boolean(matchOpening(comment)) || hasAuthorSignal(body, buildPrefixRegex(prefixes));
}

/**
 * Начало комментария вне строкового литерала.
 * В 1С строки — двойные кавычки, удвоение экранирует кавычку.
 */
function findCommentStart(line) {
  let inString = false;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

/** Пересекающиеся и вложенные участки схлопываются в один. */
function mergeOverlapping(regions) {
  if (regions.length < 2) return regions;
  const sorted = [...regions].sort((a, b) => a.startLine - b.startLine);
  const result = [sorted[0]];

  for (const region of sorted.slice(1)) {
    const last = result[result.length - 1];
    if (region.startLine <= last.endLine) {
      last.endLine = Math.max(last.endLine, region.endLine);
      if (last.author === UNKNOWN_AUTHOR) last.author = region.author;
    } else {
      result.push(region);
    }
  }
  return result;
}
