/**
 * Разбор правки помещения на блоки: что именно дописал разработчик и в какой
 * процедуре.
 *
 * Отдельно от `takeFragments` (`analyze/codeAnalyzer.js`) намеренно: там задача
 * другая — показать в отчёте обследования по одному характерному куску на
 * процедуру, чтобы читатель понял, о чём речь. Здесь же отчёт отвечает на
 * вопрос «что вошло ЭТИМ помещением», и любая вольность в границах блока —
 * это неправда о работе разработчика. Отсюда три отличия:
 *
 *  * **Блоков у процедуры может быть сколько угодно.** Два комментария,
 *    дописанные в разные места одной процедуры, — это две правки, и показывать
 *    надо обе. `takeFragments` оставлял по одной на процедуру, и второй правки
 *    в отчёте не было вовсе.
 *  * **В блок попадают только добавленные строки, без «склейки через разрыв».**
 *    `toRegions` соединяет участки, между которыми до трёх неизменных строк, —
 *    для замечаний это удобно (виден контекст), а для правки помещения ложь:
 *    в блок затягивался чужой, давно лежавший в модуле код. На живом примере
 *    так между новой функцией и новой процедурой оказался старый обработчик,
 *    и выглядело это как «разработчик добавил и его тоже».
 *  * **Границей блока служит граница процедуры.** Иначе новая функция и идущая
 *    следом новая процедура сливались в один блок под именем первой, и вторая
 *    в дереве не появлялась.
 */

/** Сколько блоков показываем по одному модулю: дальше отчёт нечитаем. */
const MAX_FRAGMENTS = 60;
/** Предел строк в одном блоке. */
const MAX_LINES = 400;
/** Предел длины строки — защита от однострочных «простыней». */
const MAX_LINE_CHARS = 400;

/**
 * Подпись процедуры так, как она объявлена: имя, все параметры и «Экспорт».
 *
 * Одного имени мало: «ПриЗаписи» в модуле объекта и «ПриЗаписи(Отказ)»
 * в подписке — разные вещи, а экспортность вообще определяет, часть это
 * программного интерфейса или внутренняя кухня. Прямое требование
 * пользователя (13.08.2026).
 */
export function routineSignature(routine) {
  if (!routine?.name) return '';
  const params = (routine.params || []).join(', ');
  return `${routine.name}(${params})${routine.isExport ? ' Экспорт' : ''}`;
}

/**
 * Границы процедур с захватом строк-приставок над заголовком.
 *
 * Директива компиляции («&НаКлиенте», «&После(...)») и комментарий-описание
 * стоят ВЫШЕ слова «Процедура», а структура модуля считает началом сам
 * заголовок. Без захвата такие строки оказывались «вне процедур и функций»,
 * и добавленный обработчик разваливался на два куска: приставку и тело.
 *
 * Захват не заходит за конец предыдущей процедуры — иначе пустые строки между
 * ними растащили бы границы.
 *
 * @param {string[]} lines строки модуля
 * @param {import('./structure.js').Routine[]} routines
 * @returns {{routine: object, fromLine: number, toLine: number}[]}
 */
export function routineSpans(lines, routines = []) {
  const sorted = [...routines].sort((a, b) => a.startLine - b.startLine);
  const spans = [];
  let previousEnd = 0;

  for (const routine of sorted) {
    let from = routine.startLine;
    while (from - 1 > previousEnd) {
      const text = (lines[from - 2] || '').trim();
      if (!text.startsWith('&') && !text.startsWith('//')) break;
      from -= 1;
    }
    spans.push({ routine, fromLine: from, toLine: routine.endLine });
    previousEnd = routine.endLine;
  }
  return spans;
}

/**
 * Дописана процедура целиком или правлена существующая.
 *
 * Сравнение по имени, а не по подписи: правка списка параметров — это всё
 * та же процедура, изменённая, а не новая. Прежних процедур не знаем
 * (модуль появился этим помещением, или разбор не удался) — состояние
 * не выдумываем, значка не будет.
 */
function routineStatusOf(before, routine) {
  if (!before) return null;
  return before.has(String(routine.name || '').toLowerCase()) ? 'modified' : 'added';
}

/** Индекс процедуры, которой принадлежит строка; -1 — вне процедур. */
function ownerOf(spans, line) {
  for (let i = 0; i < spans.length; i += 1) {
    if (line >= spans[i].fromLine && line <= spans[i].toLine) return i;
  }
  return -1;
}

/**
 * Блоки правки: подряд идущие добавленные строки одной процедуры.
 *
 * @param {object} params
 * @param {string} params.source текст модуля ПОСЛЕ помещения
 * @param {number[]} params.addedLines номера добавленных строк (с единицы)
 * @param {import('./structure.js').Routine[]} [params.routines]
 * @param {import('./structure.js').Routine[]} [params.previousRoutines] процедуры
 *   модуля ДО помещения — по ним видно, дописана процедура целиком или правлена
 *   существующая. Не передали — состояние остаётся неизвестным, и значка нет.
 * @returns {{fragments: object[], totalBlocks: number}} блоки с текстом,
 *   границами и процедурой; `totalBlocks` — сколько их нашлось всего, чтобы
 *   отчёт мог честно сказать, что показал не все.
 */
export function placementFragments({
  source, addedLines, routines = [], previousRoutines = null,
}) {
  if (!addedLines?.length) return { fragments: [], totalBlocks: 0 };
  const lines = String(source ?? '').split(/\r?\n/);
  const spans = routineSpans(lines, routines);
  const before = previousRoutines
    ? new Set(previousRoutines.map((r) => String(r.name || '').toLowerCase()))
    : null;

  const runs = slideRuns(lines, contiguousRuns(lines, addedLines));

  /** @type {{owner: number, start: number, end: number}[]} */
  const blocks = [];
  for (const run of runs) {
    for (let line = run.start; line <= run.end; line += 1) {
      const owner = ownerOf(spans, line);
      const last = blocks[blocks.length - 1];
      // Новый блок начинается на разрыве строк ИЛИ на границе процедуры: и то,
      // и другое означает, что это уже другая правка.
      if (last && last.owner === owner && line === last.end + 1) {
        last.end = line;
        continue;
      }
      blocks.push({ owner, start: line, end: line });
    }
  }

  // Блок из одних пустых строк показывать нечего: он остаётся хвостом
  // от вставки, съехавшей к границе процедуры.
  const meaningful = blocks.filter(
    (b) => lines.slice(b.start - 1, b.end).some((line) => line.trim()),
  );

  const fragments = meaningful.slice(0, MAX_FRAGMENTS).map((block) => {
    const span = block.owner >= 0 ? spans[block.owner] : null;
    const total = block.end - block.start + 1;
    const count = Math.min(total, MAX_LINES);
    return {
      startLine: block.start,
      endLine: block.end,
      truncated: Math.max(0, total - MAX_LINES),
      lines: lines.slice(block.start - 1, block.start - 1 + count)
        .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)),
      routine: span?.routine.name || null,
      routineKind: span?.routine.kind || null,
      routineSignature: span ? routineSignature(span.routine) : null,
      // Состояние процедуры — тем же значком, что у объекта и модуля:
      // процедуры не было в прежней версии — «добавлена», была — «изменена».
      routineStatus: span ? routineStatusOf(before, span.routine) : null,
      // Пусто всегда: у помещения нет «кода поставщика на этом месте».
      // Поле оставлено ради единого вида блока с отчётом обследования.
      vendorLines: [],
    };
  });

  return { fragments, totalBlocks: meaningful.length };
}

/** Подряд идущие добавленные строки — одной вставкой. */
function contiguousRuns(lines, addedLines) {
  const sorted = [...new Set(addedLines)]
    .filter((line) => line >= 1 && line <= lines.length)
    .sort((a, b) => a - b);
  const runs = [];
  for (const line of sorted) {
    const last = runs[runs.length - 1];
    if (last && line === last.end + 1) last.end = line;
    else runs.push({ start: line, end: line });
  }
  return runs;
}

/**
 * Сдвигает вставку туда, где она начинается по-человечески.
 *
 * Зачем это нужно. Диф Майерса даёт минимальное число различий, но когда
 * одинаковые строки повторяются — а в 1С они повторяются постоянно
 * («КонецПроцедуры», пустая строка, «// Вставить содержимое обработчика.») —
 * минимумов несколько, и все они равноправны. Живой пример 13.08.2026:
 * разработчик добавил в конец модуля процедуру «Расш1_ПриЗаписи», а диф
 * с тем же счётом отнёс вставку на три строки выше — в середину чужого
 * обработчика «Расш1_ПередУдалением». Число строк совпадало, а вот кто их
 * написал — уже нет.
 *
 * Сдвиг допустим ровно настолько, насколько текст от него не меняется: вниз —
 * пока строка, покидающая блок сверху, совпадает со строкой, входящей снизу;
 * вверх — наоборот. Из допустимых положений выбирается лучшее (`runScore`).
 * Соседние вставки друг на друга не наезжают: между ними обязана остаться
 * хотя бы одна неизменная строка, иначе это была бы одна вставка.
 */
function slideRuns(lines, runs) {
  return runs.map((run, i) => {
    const length = run.end - run.start + 1;
    const lowest = i > 0 ? runs[i - 1].end + 2 : 1;
    const highest = (i < runs.length - 1 ? runs[i + 1].start - 1 : lines.length) - length + 1;

    let best = run.start;
    let bestScore = runScore(lines, run.start);

    for (let start = run.start; start > lowest; start -= 1) {
      // Вверх: строка, уходящая из блока снизу, должна совпасть с той,
      // что входит сверху.
      if (lines[start + length - 2] !== lines[start - 2]) break;
      const score = runScore(lines, start - 1);
      if (score > bestScore) { bestScore = score; best = start - 1; }
    }
    for (let start = run.start; start < highest; start += 1) {
      if (lines[start - 1] !== lines[start + length - 1]) break;
      // При равном счёте побеждает положение ниже: диф Майерса и без того
      // тянет вставку вверх, к первому из одинаковых мест, а дописывают
      // код обычно всё-таки в конец.
      const score = runScore(lines, start + 1);
      if (score >= bestScore) { bestScore = score; best = start + 1; }
    }

    return { start: best, end: best + length - 1 };
  });
}

/**
 * Насколько положение вставки похоже на границу правки.
 *
 * Разработчик дописывает код целыми кусками, а куски в 1С начинаются
 * с пустой строки над ними и с объявления либо его приставки: директивы
 * компиляции, комментария, «Процедура»/«Функция», «#Область». Чем больше
 * этого совпало, тем вероятнее, что мы поймали настоящее начало правки.
 */
function runScore(lines, start) {
  const first = (lines[start - 1] || '').trim();
  const before = start > 1 ? (lines[start - 2] || '').trim() : '';
  let score = 0;
  if (start === 1 || before === '') score += 4;
  if (/^(&|\/\/|#)/.test(first)) score += 2;
  if (/^(процедура|функция)\b/i.test(first)) score += 2;
  return score;
}
