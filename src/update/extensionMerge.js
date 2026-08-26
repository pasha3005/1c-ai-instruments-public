/**
 * Перенос доработок расширения на метод, который поставщик изменил.
 *
 * Расширение с аннотацией `&ИзменениеИКонтроль("Метод")` держит у себя КОПИЮ
 * исходного текста метода конфигурации, а свои правки помечает директивами
 * `#Вставка … #КонецВставки` и `#Удаление … #КонецУдаления`. Платформа при
 * наложении сверяет неразмеченную часть копии с текущим методом конфигурации;
 * разошлось хоть на строку — «не найден фрагмент», и расширение не применяется
 * ЦЕЛИКОМ. После перехода на новый релиз это самая частая причина отказа.
 *
 * Человек здесь берёт новый текст метода и переносит в него свои вставки.
 * Ровно это и делается — трёхсторонним объединением, без единой догадки:
 *
 *   base   — прежний метод поставщика. Его не надо ниоткуда брать: он лежит
 *            в самой копии, надо лишь снять разметку — выбросить вставки
 *            и вернуть удалённое;
 *   ours   — копия расширения как есть, со всеми директивами;
 *   theirs — метод обновлённой конфигурации.
 *
 * Объединение принимается, ТОЛЬКО если прошло без конфликтов и разметка
 * в результате осталась парной. Иначе место уходит человеку: испорченное
 * расширение хуже неприменённого — ошибка проявится не на проверке,
 * а у пользователя.
 *
 * Чего здесь нет: правки `&Вместо`, `&Вокруг`, `&До`, `&После`. Они копии
 * типового текста не держат, от изменения метода не ломаются, а если метод
 * переименован — это работа `fixExtensions.js`.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { merge3, splitLines, joinLines } from './diff3.js';
import { tokenize } from '../analyze/bsl/lexer.js';
import { analyzeStructure } from '../analyze/bsl/structure.js';
import { collectFiles } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('ext-merge');

/** Аннотация, при которой расширение держит копию типового текста. */
const CONTROL = /^\s*&ИзменениеИКонтроль\s*\(\s*"([^"]+)"\s*\)/i;

/**
 * Директивы разметки внутри копии.
 *
 * Конец слова — `(?=\s|$)`, а не `\b`: в JS `\b` это граница ASCII-слова,
 * и после кириллицы она не срабатывает вовсе. Ловушка известная — на ней
 * уже ломался поиск областей в регламенте разработки.
 */
const INSERT_OPEN = /^\s*#Вставка(?=\s|$)/i;
const INSERT_CLOSE = /^\s*#КонецВставки(?=\s|$)/i;
const DELETE_OPEN = /^\s*#Удаление(?=\s|$)/i;
const DELETE_CLOSE = /^\s*#КонецУдаления(?=\s|$)/i;

/**
 * Разбирает копию метода на прежний текст поставщика и разметку.
 *
 * Экспортируется ради теста: ошибка здесь портит расширение молча.
 *
 * @param {string[]} lines строки процедуры расширения
 * @returns {{ok: boolean, base: string[], reason?: string}}
 *   `base` — метод поставщика, каким он был до правок расширения
 */
export function vendorTextFromControl(lines) {
  const base = [];
  let inInsert = false;
  let inDelete = false;

  for (const line of lines) {
    if (INSERT_OPEN.test(line)) {
      if (inInsert || inDelete) return { ok: false, base: [], reason: 'вложенные директивы' };
      inInsert = true;
      continue;
    }
    if (INSERT_CLOSE.test(line)) {
      if (!inInsert) return { ok: false, base: [], reason: 'непарный «#КонецВставки»' };
      inInsert = false;
      continue;
    }
    if (DELETE_OPEN.test(line)) {
      if (inInsert || inDelete) return { ok: false, base: [], reason: 'вложенные директивы' };
      inDelete = true;
      continue;
    }
    if (DELETE_CLOSE.test(line)) {
      if (!inDelete) return { ok: false, base: [], reason: 'непарный «#КонецУдаления»' };
      inDelete = false;
      continue;
    }

    // Вставка расширения у поставщика отсутствовала; удалённое — было,
    // но лежит закомментированным: платформа требует комментировать его.
    if (inInsert) continue;
    if (inDelete) {
      const restored = line.replace(/^(\s*)\/\/\s?/, '$1');
      base.push(restored);
      continue;
    }
    base.push(line);
  }

  if (inInsert || inDelete) return { ok: false, base: [], reason: 'незакрытая директива' };
  return { ok: true, base };
}

/** Парна ли разметка в получившемся тексте: непарная сделает расширение негодным. */
export function markupBalanced(lines) {
  let inserts = 0;
  let deletes = 0;
  for (const line of lines) {
    if (INSERT_OPEN.test(line)) inserts += 1;
    else if (INSERT_CLOSE.test(line)) inserts -= 1;
    else if (DELETE_OPEN.test(line)) deletes += 1;
    else if (DELETE_CLOSE.test(line)) deletes -= 1;
    if (inserts < 0 || deletes < 0) return false;
  }
  return inserts === 0 && deletes === 0;
}

/**
 * Переносит доработки всех расширений на обновлённые методы конфигурации.
 *
 * @param {object} params
 * @param {{name: string, dir: string}[]} params.extensions выгрузки расширений
 * @param {string} params.mainDir выгрузка основной конфигурации (уже объединённая)
 * @param {boolean} [params.apply] писать ли правки в файлы
 * @param {(text: string) => void} [params.onProgress]
 * @returns {Promise<{resolved: object[], conflicts: object[], changedExtensions: string[]}>}
 */
export async function mergeExtensionSources({
  extensions, mainDir, apply = true, onProgress,
}) {
  const resolved = [];
  const conflicts = [];
  const changed = new Set();

  for (const extension of extensions) {
    const files = await collectFiles(extension.dir, '.bsl');
    for (const file of files) {
      const rel = path.relative(extension.dir, file).replace(/\\/g, '/');
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (!/&ИзменениеИКонтроль/i.test(text)) continue;

      onProgress?.(`расширение «${extension.name}»: ${rel}`);
      const mainText = await readMainModule(mainDir, rel);
      if (mainText == null) {
        conflicts.push({
          extension: extension.name,
          rel,
          reason: 'Одноимённого модуля в обновлённой конфигурации нет — сверять не с чем.',
        });
        continue;
      }

      // Пути кладутся в каждое место: окно разбора правит именно эти файлы,
      // а искать их заново по имени расширения значило бы повторять здешнюю
      // логику во второй раз.
      const outcome = mergeControlledRoutines(text, mainText, {
        extension: extension.name,
        rel,
        file,
        mainFile: path.join(mainDir, rel),
      });
      resolved.push(...outcome.resolved);
      conflicts.push(...outcome.conflicts);

      if (outcome.changed && apply) {
        await fs.writeFile(file, outcome.text, 'utf8');
        changed.add(extension.name);
        log.info(`Расширение «${extension.name}»: перенесено методов ${outcome.resolved.length} (${rel})`);
      }
    }
  }

  return { resolved, conflicts, changedExtensions: [...changed] };
}

/**
 * Объединяет все `&ИзменениеИКонтроль` одного модуля расширения.
 *
 * Экспортируется ради теста — на живом расширении такое не проверишь.
 */
export function mergeControlledRoutines(extensionText, mainText, context = {}) {
  const shape = splitLines(extensionText);
  const lines = shape.lines.slice();
  const resolved = [];
  const conflicts = [];

  const mainRoutines = routineIndex(mainText);
  const spans = controlledSpans(shape.lines);

  // С конца: замена меняет длину модуля, а участки заданы номерами строк.
  for (const span of [...spans].reverse()) {
    const ours = lines.slice(span.startLine - 1, span.endLine);
    const target = mainRoutines.get(span.name.toLowerCase());
    const where = `${context.rel || ''} · ${span.name}`;

    if (!target) {
      conflicts.push({
        ...context,
        routine: span.name,
        where,
        reason: `Процедуры «${span.name}» в обновлённой конфигурации нет: `
          + 'перенести доработку некуда — либо она переименована, либо удалена.',
        ours,
        theirs: [],
      });
      continue;
    }

    const stripped = vendorTextFromControl(ours);
    if (!stripped.ok) {
      conflicts.push({
        ...context,
        routine: span.name,
        where,
        reason: `Разметку «#Вставка/#Удаление» разобрать не удалось: ${stripped.reason}.`,
        ours,
        theirs: target.lines,
      });
      continue;
    }

    // Объединяется только ТЕЛО метода. Заголовок расширения — его аннотация
    // и собственное имя процедуры («Расш1_Пересчитать») — остаётся своим:
    // взяв заголовок поставщика, мы переименовали бы процедуру расширения,
    // и модуль перестал бы компилироваться.
    const oursParts = splitRoutine(ours);
    const baseParts = splitRoutine(stripped.base);
    const theirsParts = splitRoutine(target.lines);

    // Метод конфигурации уже такой же, как база расширения — значит поставщик
    // его не менял, и переносить нечего.
    if (sameCode(baseParts.body, theirsParts.body)) continue;

    const merge = merge3(
      baseParts.body.join('\n'),
      oursParts.body.join('\n'),
      theirsParts.body.join('\n'),
    );

    const mergedLines = [...oursParts.head, ...merge.lines];
    if (!merge.ok || merge.conflicts.length || !markupBalanced(mergedLines)) {
      conflicts.push({
        ...context,
        routine: span.name,
        where,
        reason: merge.ok && merge.conflicts.length
          ? 'Поставщик изменил ровно те строки, которые правит расширение: '
            + 'решение может принять только человек.'
          : 'Перенести доработку автоматически не удалось: результат получился '
            + 'с непарной разметкой «#Вставка/#Удаление».',
        ours,
        theirs: target.lines,
        base: stripped.base,
      });
      continue;
    }

    lines.splice(span.startLine - 1, span.endLine - span.startLine + 1, ...mergedLines);
    resolved.push({
      ...context,
      routine: span.name,
      where,
      how: 'доработка перенесена в новый текст метода',
      why: `Поставщик изменил метод «${span.name}», а расширение держит его копию `
        + 'с вставками. Взят новый текст метода, вставки расширения возвращены на место.',
      base: stripped.base,
      ours,
      theirs: target.lines,
      result: mergedLines,
    });
  }

  return {
    text: joinLines(lines, shape),
    changed: resolved.length > 0,
    resolved: resolved.reverse(),
    conflicts,
  };
}

// --- Мелочи ------------------------------------------------------------------

/** Строка перед объявлением: аннотация либо комментарий. */
const PREFIX_LINE = /^\s*(&|\/\/)/;

/** Строка объявления процедуры или функции. */
const DECLARATION = /^\s*(Процедура|Функция)\s/i;

/**
 * Делит процедуру на заголовок и тело.
 *
 * Заголовок — аннотации, комментарии перед объявлением и само объявление
 * со всеми параметрами (оно бывает в несколько строк — считаем скобки).
 * Объединяется только тело: заголовок у расширения свой, там его имя
 * процедуры, и подменять его текстом поставщика нельзя.
 *
 * Экспортируется ради теста.
 */
export function splitRoutine(lines) {
  let i = 0;
  while (i < lines.length && (PREFIX_LINE.test(lines[i]) || !lines[i].trim())) i += 1;

  if (i >= lines.length || !DECLARATION.test(lines[i])) {
    return { head: lines.slice(0, i), body: lines.slice(i) };
  }

  let depth = 0;
  do {
    for (const ch of lines[i]) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    i += 1;
  } while (depth > 0 && i < lines.length);

  return { head: lines.slice(0, i), body: lines.slice(i) };
}

function sameCode(a, b) {
  const norm = (lines) => lines.map((l) => l.trim()).filter(Boolean);
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((line, i) => line === y[i]);
}

/** Процедуры модуля конфигурации: имя → строки вместе с приставками. */
function routineIndex(text) {
  const map = new Map();
  const lines = splitLines(text).lines;
  let routines = [];
  try {
    routines = analyzeStructure(tokenize(text).tokens).routines;
  } catch {
    return map;
  }
  for (const routine of routines) {
    map.set(routine.name.toLowerCase(), {
      name: routine.name,
      lines: lines.slice(routine.startLine - 1, routine.endLine),
    });
  }
  return map;
}

/**
 * Участки модуля расширения под `&ИзменениеИКонтроль`.
 *
 * Границы берутся у разбора структуры, а не поиском «КонецПроцедуры»: строка
 * с таким текстом встречается и в комментарии, и в тексте запроса. Аннотация
 * стоит ПЕРЕД объявлением, поэтому участок начинается с её строки.
 */
function controlledSpans(lines) {
  const text = lines.join('\n');
  let routines = [];
  try {
    routines = analyzeStructure(tokenize(text).tokens).routines;
  } catch {
    return [];
  }

  const spans = [];
  for (const routine of routines) {
    // Аннотация и другие приставки стоят выше объявления.
    let start = routine.startLine;
    let name = '';
    for (let i = routine.startLine - 2; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.trim()) { start = i + 1; continue; }
      if (/^\s*&/.test(line) || /^\s*\/\//.test(line)) {
        start = i + 1;
        const hit = CONTROL.exec(line);
        if (hit) name = hit[1];
        continue;
      }
      break;
    }
    if (name) spans.push({ name, startLine: start, endLine: routine.endLine });
  }
  return spans;
}

/** Текст одноимённого модуля обновлённой конфигурации. */
async function readMainModule(mainDir, rel) {
  try {
    return await fs.readFile(path.join(mainDir, rel), 'utf8');
  } catch {
    return null;
  }
}
