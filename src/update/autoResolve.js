/**
 * Автоматическое разрешение дважды изменённых мест.
 *
 * Конфигуратор в такой ситуации только разводит руками и показывает окно
 * сравнения. Требование пользователя прямое: «разработчик, который выполняет
 * обновление, может это сделать, значит и ты можешь» — поэтому здесь собраны
 * приёмы, которыми человек и разбирает такие места руками.
 *
 * Порядок ровно тот же, что у человека: сперва отбрасывается мнимый конфликт
 * (переформатирование, правка, которая у нас уже есть), потом раскладывается
 * настоящий (наша вставка рядом с правкой вендора), и только затем берётся
 * самый трудный случай — вендор переименовал или перенёс процедуру, в которую
 * была внесена доработка.
 *
 * Чего здесь нет намеренно: угадывания «по смыслу». Каждый приём либо доказуемо
 * даёт тот же результат, что сделал бы человек, либо не срабатывает вовсе.
 * Нерешённое место уходит в отчёт — это честнее тихого выбора наугад.
 */

import { merge3, splitLines, joinLines } from './diff3.js';
import { tokenize } from '../analyze/bsl/lexer.js';
import { analyzeStructure } from '../analyze/bsl/structure.js';

/** Насколько похожими должны быть тела процедур, чтобы счесть их одной и той же. */
const RENAME_SIMILARITY = 0.6;

/** Приёмы, применяемые к одному участку. Порядок значим. */
const TACTICS = [
  sameAfterNormalize,
  vendorAlreadyInOurs,
  ourChangeInVendor,
  ourAdditionAroundVendor,
  ourCommentsOnly,
];

/**
 * Разбирает конфликты одного файла.
 *
 * @param {object} params
 * @param {string} params.rel путь файла в выгрузке
 * @param {string} params.baseText старая поставка
 * @param {string} params.oursText основная конфигурация
 * @param {string} params.theirsText новая поставка
 * @param {ReturnType<import('./diff3.js').merge3>} params.merge результат объединения
 * @returns {{lines: string[], conflicts: object[], resolved: object[], changed: boolean}}
 */
export function autoResolve({ rel, baseText, oursText, theirsText, merge }) {
  const isModule = /\.bsl$/i.test(rel);
  let lines = merge.lines.slice();
  const resolved = [];
  const remaining = [];

  // С конца: разрешение меняет длину результата, а участки заданы позициями
  // в нём. Идя с конца, не приходится пересчитывать позиции оставшихся.
  const ordered = [...merge.conflicts].sort((a, b) => b.mergedStartLine - a.mergedStartLine);

  for (const conflict of ordered) {
    const decision = decide(conflict, isModule);
    if (!decision) {
      remaining.push(conflict);
      continue;
    }
    const at = conflict.mergedStartLine - 1;
    lines.splice(at, conflict.ours.length, ...decision.lines);
    resolved.push({
      ...conflict,
      how: decision.how,
      why: decision.why,
      result: decision.lines,
    });
  }

  if (isModule && remaining.length) {
    const moved = transplantRoutines({
      baseText, oursText, theirsText, lines, conflicts: remaining,
    });
    if (moved.changed) {
      lines = moved.lines;
      resolved.push(...moved.resolved);
      remaining.length = 0;
      remaining.push(...moved.remaining);
    }
  }

  return {
    lines,
    conflicts: remaining.sort((a, b) => a.mergedStartLine - b.mergedStartLine),
    resolved: resolved.sort((a, b) => a.mergedStartLine - b.mergedStartLine),
    changed: resolved.length > 0,
  };
}

function decide(conflict, isModule) {
  for (const tactic of TACTICS) {
    const decision = tactic(conflict, isModule);
    if (decision) return decision;
  }
  return null;
}

// --- Приёмы -----------------------------------------------------------------

/**
 * Разошлось только оформление.
 *
 * Вендор переформатировал участок, мы — тоже, но смысл один и тот же. Берётся
 * версия поставщика: спорить об отступах смысла нет, а дальше сравнивать наш
 * код придётся с его форматированием.
 */
function sameAfterNormalize(conflict) {
  if (!normalizedEqual(conflict.ours, conflict.theirs)) return null;
  return {
    lines: conflict.theirs,
    how: 'форматирование',
    why: 'Обе стороны изменили только оформление: смысл участка одинаков. '
      + 'Взята версия поставщика.',
  };
}

/**
 * Правка поставщика у нас уже есть.
 *
 * Частый случай при переносе исправлений «наперёд»: интегратор внёс тот же фикс
 * руками, а теперь он пришёл в поставке. Наши строки содержат все строки
 * поставщика в том же порядке — значит его правка не потеряется.
 */
function vendorAlreadyInOurs(conflict) {
  if (!conflict.theirs.length || conflict.ours.length <= conflict.theirs.length) return null;
  if (!isSubsequence(conflict.theirs, conflict.ours)) return null;
  return {
    lines: conflict.ours,
    how: 'правка поставщика уже учтена',
    why: 'Все строки новой поставки присутствуют в нашем коде — правка была '
      + 'внесена раньше вручную. Оставлена наша версия.',
  };
}

/**
 * Наша правка вошла в новую поставку.
 *
 * Обратный случай: поставщик принял доработку (или сделал ту же сам), и его
 * версия содержит нашу целиком. Берётся поставка — она новее.
 */
function ourChangeInVendor(conflict) {
  if (!conflict.ours.length || conflict.theirs.length <= conflict.ours.length) return null;
  if (!isSubsequence(conflict.ours, conflict.theirs)) return null;
  return {
    lines: conflict.theirs,
    how: 'наша правка есть в поставке',
    why: 'Новая поставка содержит наши строки целиком — доработка учтена вендором. '
      + 'Взята версия поставщика.',
  };
}

/**
 * Наша правка — вставка рядом, вендор переписал сам участок.
 *
 * Самый частый настоящий конфликт: доработка дописала строки перед типовым
 * кодом или после него, а вендор этот типовой код изменил. Человек в такой
 * ситуации берёт новый типовой код и возвращает свою вставку на место —
 * ровно это и делается.
 */
function ourAdditionAroundVendor(conflict) {
  const { base, ours, theirs } = conflict;
  if (!base.length || !ours.length || !theirs.length) return null;

  const head = commonPrefix(base, ours);
  const tail = commonSuffix(base, ours, head);
  // База целиком должна укладываться в нашу версию: тогда всё, что сверх неё, —
  // наша вставка, и переносить её к новому коду поставщика безопасно.
  if (head + tail !== base.length) return null;

  const insertion = ours.slice(head, ours.length - tail);
  if (!insertion.length) return null;

  // Вставка стояла до типового кода или после него — там же и остаётся.
  const atStart = head === 0;

  return {
    lines: atStart ? [...insertion, ...theirs] : [...theirs, ...insertion],
    how: 'вставка перенесена',
    why: `Наша правка — вставка ${insertion.length} стр. рядом с типовым кодом, `
      + 'который вендор изменил. Взят новый код поставщика, вставка возвращена на место.',
  };
}

/**
 * Мы дописали только комментарии.
 *
 * Пометки разработчика («// ++ Фамилия …»), пояснения и закомментированный
 * старый вариант. Код при этом наш и поставщика совпадает — берётся поставка,
 * комментарии сохраняются.
 */
function ourCommentsOnly(conflict, isModule) {
  if (!isModule) return null;
  const ourCode = conflict.ours.filter((line) => !isComment(line));
  const theirCode = conflict.theirs.filter((line) => !isComment(line));
  if (!normalizedEqual(ourCode, theirCode)) return null;

  const comments = conflict.ours.filter(isComment);
  if (!comments.length) return null;

  return {
    lines: [...comments, ...conflict.theirs],
    how: 'комментарии сохранены',
    why: 'Код у нас и в поставке одинаков, отличались только комментарии. '
      + 'Взята версия поставщика, ваши комментарии оставлены рядом.',
  };
}

// --- Перенос доработки в переехавшую процедуру -------------------------------

/**
 * Вендор переименовал или перенёс процедуру, в которой была доработка.
 *
 * Пользователь описал этот случай дословно: «была доработка в какой-то
 * процедуре, а в новом релизе этой процедуры нету… вероятно, она переехала
 * куда-то неподалёку либо у неё поменялось название. Попытайся всё равно
 * делать всё сам».
 *
 * Так и делается. Процедура старой поставки, которой в новой поставке нет
 * по имени, ищется по ТЕЛУ: у переименованной процедуры текст почти тот же.
 * Найдя её, доработка переносится обычным трёхсторонним объединением уже
 * внутри процедуры, а наша осиротевшая копия убирается — иначе в модуле
 * остались бы две почти одинаковые процедуры, из которых вызывается новая.
 *
 * Перенос выполняется, только если объединение внутри процедуры прошло
 * без конфликтов. Иначе решать всё равно человеку, и лучше он увидит участок
 * на своём месте.
 */
export function transplantRoutines({ baseText, oursText, theirsText, lines, conflicts }) {
  const base = routineIndex(baseText);
  const ours = routineIndex(oursText);
  const theirs = routineIndex(theirsText);
  const merged = routineIndex(joinLines(lines, { eol: '\n' }));
  if (!base.list.length || !theirs.list.length) {
    return { changed: false, lines, resolved: [], remaining: conflicts };
  }

  const resolved = [];
  const remaining = [];
  /** Замены в результате: имя процедуры → новый текст. Применяются разом. */
  const replacements = new Map();
  const removals = new Set();

  for (const conflict of conflicts) {
    const routine = base.at(conflict.baseStartLine);
    if (!routine || theirs.byName.has(routine.name.toLowerCase())) {
      remaining.push(conflict);
      continue;
    }

    const candidate = findMoved(base.text(routine), theirs);
    const ourRoutine = ours.byName.get(routine.name.toLowerCase());
    if (!candidate || !ourRoutine || !merged.byName.has(candidate.name.toLowerCase())) {
      remaining.push(conflict);
      continue;
    }

    const inner = merge3(
      base.text(routine).join('\n'),
      ours.text(ourRoutine).join('\n'),
      theirs.text(candidate).join('\n'),
    );
    if (!inner.ok || inner.conflicts.length) {
      remaining.push(conflict);
      continue;
    }

    replacements.set(candidate.name.toLowerCase(), inner.lines);
    removals.add(routine.name.toLowerCase());
    resolved.push({
      ...conflict,
      how: 'доработка перенесена',
      why: `В новой поставке процедуры «${routine.name}» нет — вендор переименовал её `
        + `в «${candidate.name}». Доработка перенесена туда, наша прежняя копия убрана.`,
      result: inner.lines,
    });
  }

  if (!resolved.length) return { changed: false, lines, resolved: [], remaining: conflicts };

  // Правки применяются с конца файла: иначе смещаются границы следующих.
  const edits = [];
  for (const [name, text] of replacements) {
    const routine = merged.byName.get(name);
    if (routine) edits.push({ from: routine.startLine - 1, to: routine.endLine, lines: text });
  }
  for (const name of removals) {
    const routine = merged.byName.get(name);
    if (routine) edits.push({ from: routine.startLine - 1, to: routine.endLine, lines: [] });
  }
  edits.sort((a, b) => b.from - a.from);

  const out = lines.slice();
  for (const edit of edits) out.splice(edit.from, edit.to - edit.from, ...edit.lines);

  return { changed: true, lines: out, resolved, remaining };
}

/** Процедура новой поставки, больше всего похожая на исчезнувшую. */
function findMoved(bodyLines, theirs) {
  const wanted = new Set(bodyLines.map((l) => l.trim()).filter(Boolean));
  if (wanted.size < 3) return null;

  let best = null;
  let bestScore = 0;
  for (const routine of theirs.list) {
    const body = theirs.text(routine).map((l) => l.trim()).filter(Boolean);
    if (!body.length) continue;
    let hits = 0;
    for (const line of body) if (wanted.has(line)) hits += 1;
    const score = hits / Math.max(wanted.size, body.length);
    if (score > bestScore) {
      bestScore = score;
      best = routine;
    }
  }
  return bestScore >= RENAME_SIMILARITY ? best : null;
}

/** Разбор модуля на процедуры с доступом по имени и по строке. */
function routineIndex(text) {
  const lines = splitLines(text).lines;
  let list = [];
  try {
    list = analyzeStructure(tokenize(text).tokens).routines;
  } catch {
    list = [];
  }
  const byName = new Map();
  for (const routine of list) byName.set(routine.name.toLowerCase(), routine);
  return {
    list,
    byName,
    lines,
    at: (line) => list.find((r) => r.startLine <= line && line <= r.endLine) || null,
    text: (routine) => lines.slice(routine.startLine - 1, routine.endLine),
  };
}

// --- Мелочи ------------------------------------------------------------------

function isComment(line) {
  return /^\s*\/\//.test(line);
}

function normalizedEqual(a, b) {
  const norm = (lines) => lines.map((l) => l.trim()).filter(Boolean);
  const x = norm(a);
  const y = norm(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

/** Встречаются ли все строки `needle` внутри `hay` в том же порядке. */
function isSubsequence(needle, hay) {
  let i = 0;
  for (const line of hay) {
    if (i < needle.length && line.trim() === needle[i].trim()) i += 1;
  }
  return i === needle.length;
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a, b, skip) {
  let i = 0;
  while (i < a.length - skip && i < b.length - skip
    && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}
