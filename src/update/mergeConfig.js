/**
 * Объединение трёх выгрузок конфигурации — то же, что делает конфигуратор
 * при обновлении конфигурации на поддержке, но по файлам XML-выгрузки.
 *
 *   основная конфигурация  (ours)   ← результат пишется прямо в неё
 *   старая поставка        (base)   ← общая точка отсчёта
 *   новая поставка         (theirs) ← то, на что обновляемся
 *
 * Что здесь происходит и почему именно так.
 *
 * **Результат пишется в выгрузку основной конфигурации, на месте.** Требование
 * пользователя дословно: «все результаты объединения сохрани в файлах
 * конфигурации, которую ты выгрузил, после чего загрузи эти файлы обратно».
 * Отдельный каталог-результат означал бы второй экземпляр выгрузки — на ERP
 * это ещё несколько гигабайт, и главное: загружать в базу надо ровно то,
 * что человек мог перед этим поправить руками.
 *
 * **Конфликт не ломает файл.** При дважды изменённом участке в файл идёт наша
 * версия, а участок целиком уходит в отчёт и в каталог «Конфликты» тремя
 * версиями. Маркеры вида «<<<<<<<» сделали бы файл незагружаемым, а загрузка —
 * обязательный следующий шаг.
 *
 * **Чужие файлы, оставшиеся без ссылки, безвредны.** Если объект новой поставки
 * скопирован, но не попал в состав конфигурации, платформа его при загрузке
 * просто не увидит: состав читается из Configuration.xml и XML самих объектов,
 * а не по содержимому каталога. Поэтому состав правится отдельно
 * (`patchChildObjects`), и при неудаче правки риск сводится к «объект придётся
 * добавить руками», а не к испорченной конфигурации.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { merge3, splitLines, joinLines, twoWayHunks } from './diff3.js';
import { describeDumpPath, objectTitle, childObjectLine, ROOT_KEY } from './dumpKeys.js';
import { buildXmlOutline, describeXmlRange } from './xmlOutline.js';
import { tokenize } from '../analyze/bsl/lexer.js';
import { analyzeStructure, findRoutineAtLine } from '../analyze/bsl/structure.js';
import { ensureDir, pathExists, readText } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { throwIfCancelled, rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('merge');

/** Расширения, которые объединяются построчно. Остальное — двоичное. */
const TEXT_EXT = new Set(['.bsl', '.xml', '.txt', '.html', '.htm', '.json', '.svg', '.xsd', '.md', '.css', '.js']);

/** Карта версий выгрузки: после объединения она недействительна. */
const DUMP_INFO = 'ConfigDumpInfo.xml';

/** Сколько файлов с конфликтами сохранять подробно (код в отчёте и на диске). */
const CONFLICT_FILES_LIMIT = 300;
/** Сколько участков конфликта показывать по одному файлу. */
const CONFLICTS_PER_FILE = 20;
/** Сколько строк показывать в одной колонке участка. */
const FRAGMENT_LINES = 200;
/**
 * Сколько файлов перечислять по одному объекту и сколько объектов — в группе.
 *
 * На обновлении реальной ERP из новой поставки приходят десятки тысяч файлов,
 * и перечислить их все значило бы отдать в интерфейс результат на десятки
 * мегабайт. Числа в итогах при этом точные — обрезается только перечень.
 */
const ELEMENTS_PER_OBJECT = 50;
const OBJECTS_PER_GROUP = 500;
/** Каталог с тремя версиями каждого конфликтного файла. */
export const CONFLICT_DIR = 'Конфликты';

/**
 * @param {object} params
 * @param {string} params.mainDir выгрузка основной конфигурации (в неё же и пишем)
 * @param {string|null} params.baseDir выгрузка СТАРОЙ конфигурации поставщика
 * @param {string} params.targetDir выгрузка НОВОЙ конфигурации поставщика
 * @param {Set<string>|null} [params.touchedObjects] ключи объектов, изменённых
 *   интегратором — нужны только в режиме без старой поставки
 * @param {string} params.conflictRoot куда складывать три версии конфликтных файлов
 * @param {(done: number, total: number, rel: string) => void} [params.onProgress]
 */
export async function mergeConfigurations({
  mainDir, baseDir, targetDir, touchedObjects = null, conflictRoot, onProgress,
}) {
  const mode = baseDir ? 'three-way' : 'keys';
  const [main, base, target] = await Promise.all([
    listFiles(mainDir),
    baseDir ? listFiles(baseDir) : Promise.resolve(new Map()),
    listFiles(targetDir),
  ]);

  const rels = [...new Set([...main.keys(), ...base.keys(), ...target.keys()])]
    .filter((rel) => rel !== DUMP_INFO)
    .sort();

  const state = {
    mode,
    mainDir,
    baseDir,
    targetDir,
    conflictRoot,
    main,
    base,
    target,
    touchedObjects,
    objects: new Map(),
    totals: {
      files: rels.length,
      unchanged: 0,
      fromVendor: 0,
      keptOurs: 0,
      merged: 0,
      conflicted: 0,
      addedByVendor: 0,
      removedByVendor: 0,
      ourOwn: 0,
      manual: 0,
      failed: 0,
    },
    /** Объекты, чей файл описания пришёл из новой поставки — их надо внести в состав. */
    childAdd: new Set(),
    /** Объекты, удалённые вслед за поставщиком, — их надо убрать из состава. */
    childRemove: new Set(),
    conflictFiles: 0,
    conflictsSkipped: 0,
    conflictIndex: [],
    notes: [],
  };

  let done = 0;
  for (const rel of rels) {
    if (done % 200 === 0) throwIfCancelled();
    try {
      await mergeOne(state, rel);
    } catch (err) {
      rethrowIfCancelled(err);
      state.totals.failed += 1;
      log.warn(`Файл ${rel} не объединён: ${err.message}`);
      record(state, rel, { action: 'failed', note: err.message });
    }
    done += 1;
    if (done % 250 === 0 || done === rels.length) onProgress?.(done, rels.length, rel);
  }

  await patchConfigurationComposition(state);
  await dropDumpInfo(state);
  await writeConflictIndex(state);

  return buildResult(state);
}

// --- Один файл ---------------------------------------------------------------

async function mergeOne(state, rel) {
  const inMain = state.main.has(rel);
  const inBase = state.base.has(rel);
  const inTarget = state.target.has(rel);

  if (state.mode === 'keys') {
    await mergeByObject(state, rel, { inMain, inTarget });
    return;
  }

  // --- Полное трёхстороннее объединение ---

  if (inMain && inTarget && inBase) {
    const oursSameAsBase = await same(state, 'main', 'base', rel);
    const theirsSameAsBase = await same(state, 'target', 'base', rel);

    if (oursSameAsBase && theirsSameAsBase) {
      state.totals.unchanged += 1;
      return;
    }
    if (oursSameAsBase) {
      // Тронул только поставщик — ради этого обновление и делается.
      await copyFrom(state, 'target', rel);
      state.totals.fromVendor += 1;
      record(state, rel, { action: 'from-vendor' });
      return;
    }
    if (theirsSameAsBase) {
      // Тронули только мы: обновление не должно затирать доработку.
      state.totals.keptOurs += 1;
      record(state, rel, { action: 'kept-ours' });
      return;
    }
    if (await same(state, 'main', 'target', rel)) {
      state.totals.unchanged += 1;
      record(state, rel, { action: 'same-both' });
      return;
    }
    await mergeContents(state, rel);
    return;
  }

  if (inMain && inTarget && !inBase) {
    // Файла нет в старой поставке: элемент добавлен и нами, и поставщиком.
    // Объединять построчно нечего — общей точки отсчёта не существует.
    if (await same(state, 'main', 'target', rel)) {
      state.totals.unchanged += 1;
      return;
    }
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    const element = record(state, rel, {
      action: 'conflict-both-added',
      note: 'Этого элемента нет в старой поставке: он добавлен и вами, и поставщиком. '
        + 'Общей точки отсчёта нет, поэтому оставлен ваш вариант — ниже отличия от новой поставки.',
    });
    await attachTwoWay(state, rel, element);
    await saveConflictVersions(state, rel);
    return;
  }

  if (inMain && !inTarget && inBase) {
    if (await same(state, 'main', 'base', rel)) {
      await removeFile(state, rel);
      return;
    }
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    record(state, rel, {
      action: 'conflict-vendor-deleted',
      note: 'Поставщик удалил этот элемент, а у вас он изменён. Оставлен ваш вариант — '
        + 'решите, нужен ли он в новой версии.',
    });
    await saveConflictVersions(state, rel);
    return;
  }

  if (inMain && !inTarget && !inBase) {
    state.totals.ourOwn += 1;
    return;
  }

  if (!inMain && inTarget && inBase) {
    if (await same(state, 'target', 'base', rel)) {
      // Мы этот элемент удалили, поставщик его не менял — удалённым и остаётся.
      record(state, rel, { action: 'deleted-by-us' });
      return;
    }
    state.totals.manual += 1;
    record(state, rel, {
      action: 'manual-deleted-by-us',
      note: 'Элемент удалён в вашей конфигурации, но изменён в новой поставке. '
        + 'Автоматически он не возвращён — решите, нужен ли он снова.',
    });
    return;
  }

  if (!inMain && inTarget && !inBase) {
    await copyFrom(state, 'target', rel);
    state.totals.addedByVendor += 1;
    record(state, rel, { action: 'added-by-vendor' });
    noteChildAdd(state, rel);
    return;
  }

  // Остался случай «есть только в старой поставке» — удалён обеими сторонами.
  state.totals.unchanged += 1;
}

/**
 * Режим без старой поставки: решение принимается по ОБЪЕКТУ целиком.
 *
 * Старой поставки на диске нет, значит построчно объединять нечего: различие
 * между основной конфигурацией и новой поставкой видно, но кто его внёс —
 * неизвестно. Зато известно другое: сравнение прямо в базе (`/CompareCfg`)
 * даёт перечень объектов, изменённых интегратором. Этого достаточно для
 * главного правила обновления — «объект, которого вы не трогали, берём
 * из новой поставки», — а всё, что тронуто, честно уходит в ручной разбор.
 *
 * Гранулярность именно объектная, а не файловая: если взять из поставки часть
 * файлов объекта, а часть оставить свою, получится объект, собранный из двух
 * несогласованных половин (форма ссылается на реквизит, которого нет).
 */
async function mergeByObject(state, rel, { inMain, inTarget }) {
  const entry = describeDumpPath(rel);
  const touched = entry.objectKey === ROOT_KEY
    || !state.touchedObjects
    || state.touchedObjects.has(entry.objectKey);

  if (!touched) {
    if (inTarget && inMain) {
      if (await same(state, 'main', 'target', rel)) {
        state.totals.unchanged += 1;
        return;
      }
      await copyFrom(state, 'target', rel);
      state.totals.fromVendor += 1;
      record(state, rel, { action: 'from-vendor' });
      return;
    }
    if (inTarget && !inMain) {
      await copyFrom(state, 'target', rel);
      state.totals.addedByVendor += 1;
      record(state, rel, { action: 'added-by-vendor' });
      noteChildAdd(state, rel);
      return;
    }
    await removeFile(state, rel);
    return;
  }

  // Объект тронут интегратором — оставляем своё и показываем отличия.
  if (!inMain) {
    if (inTarget) {
      state.totals.manual += 1;
      record(state, rel, {
        action: 'manual-deleted-by-us',
        note: 'Элемент удалён в вашей конфигурации и присутствует в новой поставке.',
      });
    }
    return;
  }

  state.totals.keptOurs += 1;
  if (!inTarget) {
    record(state, rel, { action: 'ours-own' });
    state.totals.ourOwn += 1;
    return;
  }
  if (await same(state, 'main', 'target', rel)) {
    state.totals.unchanged += 1;
    return;
  }

  state.totals.manual += 1;
  const element = record(state, rel, {
    action: 'manual-two-way',
    note: 'Объект изменён вами, и в новой поставке он тоже другой. Старой поставки на диске '
      + 'нет, поэтому автоматически объединить нельзя — ниже отличия от новой поставки.',
  });
  await attachTwoWay(state, rel, element);
  await saveConflictVersions(state, rel);
}

/** Построчное объединение содержимого файла. */
async function mergeContents(state, rel) {
  const ext = path.extname(rel).toLowerCase();
  const oursBuf = await read(state, 'main', rel);
  const theirsBuf = await read(state, 'target', rel);
  const baseBuf = await read(state, 'base', rel);

  // Файл не в UTF-8 (встречается UTF-16 в старых выгрузках) построчно
  // не объединяем: записать его обратно в исходной кодировке нечем, а молча
  // перекодировать файл конфигурации нельзя.
  if (!TEXT_EXT.has(ext) || [oursBuf, theirsBuf, baseBuf].some(isUtf16)) {
    // Двоичный файл (макет .mxl, картинка): объединять построчно нечего.
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    record(state, rel, {
      action: 'conflict-binary',
      note: 'Двоичный файл изменён и вами, и поставщиком. Оставлен ваш — сравните вручную '
        + 'в конфигураторе, автоматическое объединение для таких файлов невозможно.',
    });
    await saveConflictVersions(state, rel);
    return;
  }

  const oursText = oursBuf.toString('utf8');
  const theirsText = theirsBuf.toString('utf8');
  const baseText = baseBuf.toString('utf8');

  const result = merge3(baseText, oursText, theirsText);
  if (!result.ok) {
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    record(state, rel, {
      action: 'conflict-too-big',
      note: `Объединить построчно не удалось: ${result.reason}. Оставлен ваш вариант.`,
    });
    await saveConflictVersions(state, rel);
    return;
  }

  const shape = splitLines(oursText);
  if (result.changed) {
    await writeFile(state, rel, Buffer.from(joinLines(result.lines, shape), 'utf8'));
  }

  if (result.conflicts.length) {
    state.totals.conflicted += 1;
    const element = record(state, rel, {
      action: 'conflict',
      autoFromVendor: result.fromVendor,
    });
    await attachConflicts(state, rel, element, result, { oursText, theirsText, baseText });
    await saveConflictVersions(state, rel);
    return;
  }

  if (result.fromVendor) {
    state.totals.merged += 1;
    record(state, rel, {
      action: 'merged',
      autoFromVendor: result.fromVendor,
      autoKeptOurs: result.keptOurs,
    });
  } else {
    state.totals.keptOurs += 1;
    record(state, rel, { action: 'kept-ours' });
  }
}

// --- Подробности конфликтов --------------------------------------------------

/**
 * Дописывает участки конфликта в запись элемента.
 *
 * «Где именно» определяется по-разному в зависимости от вида файла: в XML это
 * путь до свойства («Свойства → Синоним», «Состав → Реквизит «Договор» → Тип»),
 * в модуле — имя процедуры. Номер строки в файле выгрузки сам по себе
 * пользователю не говорит ничего, а требование было увидеть, в каких свойствах
 * изменения.
 */
async function attachConflicts(state, rel, element, result, texts) {
  element.conflicts = [];
  element.conflictCount = result.conflicts.length;
  if (state.conflictFiles >= CONFLICT_FILES_LIMIT) {
    state.conflictsSkipped += result.conflicts.length;
    return;
  }
  state.conflictFiles += 1;

  const where = placeFinder(rel, texts.oursText, texts.baseText);

  for (const conflict of result.conflicts.slice(0, CONFLICTS_PER_FILE)) {
    element.conflicts.push({
      where: where(conflict.oursStartLine, conflict.baseStartLine, conflict.baseEndLine),
      baseStartLine: conflict.baseStartLine,
      oursStartLine: conflict.oursStartLine,
      theirsStartLine: conflict.theirsStartLine,
      base: cut(conflict.base),
      ours: cut(conflict.ours),
      theirs: cut(conflict.theirs),
    });
  }
  if (result.conflicts.length > CONFLICTS_PER_FILE) {
    element.conflictsTruncated = result.conflicts.length - CONFLICTS_PER_FILE;
  }
}

/**
 * Строит функцию «номер строки → место в файле».
 *
 * Разбор делается один раз на файл: и лексер, и разбор XML стоят времени,
 * а участков в одном файле бывает десятки.
 */
function placeFinder(rel, oursText, baseText = '') {
  const ext = path.extname(rel).toLowerCase();

  if (ext === '.xml') {
    const outline = buildXmlOutline(baseText || oursText);
    return (oursLine, baseStart, baseEnd) => describeXmlRange(
      outline,
      baseText ? baseStart : oursLine,
      baseText ? baseEnd : oursLine,
    );
  }

  if (ext === '.bsl') {
    try {
      const { routines } = analyzeStructure(tokenize(oursText).tokens);
      return (oursLine) => {
        const routine = findRoutineAtLine(routines, oursLine);
        return routine ? `Процедура «${routine.name}»` : 'Вне процедур';
      };
    } catch {
      return () => '';
    }
  }

  return () => '';
}

/** Отличия от новой поставки, когда объединять нечем (режим без старой поставки). */
async function attachTwoWay(state, rel, element) {
  if (state.conflictFiles >= CONFLICT_FILES_LIMIT) {
    state.conflictsSkipped += 1;
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext)) return;
  state.conflictFiles += 1;

  const oursBuf = await read(state, 'main', rel);
  const theirsBuf = await read(state, 'target', rel);
  if (isUtf16(oursBuf) || isUtf16(theirsBuf)) return;
  const oursText = oursBuf.toString('utf8');
  const theirsText = theirsBuf.toString('utf8');
  const where = placeFinder(rel, oursText);

  const hunks = twoWayHunks(oursText, theirsText, { limit: CONFLICTS_PER_FILE });
  element.conflicts = hunks.map((hunk) => ({
    where: where(hunk.oursStartLine),
    oursStartLine: hunk.oursStartLine,
    theirsStartLine: hunk.theirsStartLine,
    base: [],
    ours: cut(hunk.ours),
    theirs: cut(hunk.theirs),
  }));
  element.conflictCount = element.conflicts.length;
}

function cut(lines) {
  return lines.length > FRAGMENT_LINES
    ? { lines: lines.slice(0, FRAGMENT_LINES), truncated: lines.length - FRAGMENT_LINES }
    : { lines, truncated: 0 };
}

/**
 * Три версии конфликтного файла рядом, в каталоге «Конфликты».
 *
 * Отчёт показывает участки, но править человек будет файл целиком и своим
 * инструментом сравнения. Пути внутри выгрузки длинные, а Windows ограничивает
 * путь 260 знаками, поэтому файлы раскладываются по номерам, а соответствие
 * номера и пути пишется в «список.txt».
 */
async function saveConflictVersions(state, rel) {
  if (!state.conflictRoot) return;
  if (state.conflictIndex.length >= CONFLICT_FILES_LIMIT) return;

  const number = String(state.conflictIndex.length + 1).padStart(3, '0');
  const dir = path.join(state.conflictRoot, number);
  const ext = path.extname(rel) || '.txt';

  try {
    await ensureDir(dir);
    for (const [tree, name] of [
      ['base', 'старая-поставка'],
      ['target', 'новая-поставка'],
      ['main', 'основная-конфигурация'],
    ]) {
      if (!state[tree].has(rel)) continue;
      const buf = await read(state, tree, rel);
      await fs.writeFile(path.join(dir, `${name}${ext}`), buf);
    }
    state.conflictIndex.push({ number, rel });
  } catch (err) {
    log.warn(`Не удалось сохранить версии файла ${rel}: ${err.message}`);
  }
}

async function writeConflictIndex(state) {
  if (!state.conflictRoot || !state.conflictIndex.length) return;
  const lines = [
    'Три версии каждого файла, который пришлось решать вручную.',
    '',
    'старая-поставка         — конфигурация поставщика, с которой начинали',
    'новая-поставка          — то же место в новой поставке',
    'основная-конфигурация   — ваша версия, она же записана в выгрузку',
    '',
    ...state.conflictIndex.map((item) => `${item.number}  ${item.rel}`),
  ];
  try {
    await fs.writeFile(path.join(state.conflictRoot, 'список.txt'), `${lines.join('\r\n')}\r\n`, 'utf8');
  } catch (err) {
    log.warn(`Не удалось записать список конфликтов: ${err.message}`);
  }
}

// --- Состав конфигурации -----------------------------------------------------

function noteChildAdd(state, rel) {
  const entry = describeDumpPath(rel);
  if (entry.isObjectFile && entry.objectKey !== ROOT_KEY) state.childAdd.add(entry.objectKey);
}

/**
 * Правит список ChildObjects в Configuration.xml.
 *
 * Объект новой поставки, не внесённый в состав, платформа при загрузке
 * не увидит; объект, удалённый из каталога, но оставшийся в составе, — это
 * ошибка загрузки. В полном трёхстороннем режиме состав чаще всего сходится
 * сам (Configuration.xml объединяется построчно), но проверить дешевле,
 * чем разбираться потом с отказом загрузки.
 */
async function patchConfigurationComposition(state) {
  if (!state.childAdd.size && !state.childRemove.size) return;
  const file = path.join(state.mainDir, 'Configuration.xml');
  if (!(await pathExists(file))) {
    state.notes.push('В выгрузке нет Configuration.xml — состав конфигурации не выправлен.');
    return;
  }

  try {
    const text = await readText(file);
    const patched = patchChildObjects(text, {
      add: [...state.childAdd],
      remove: [...state.childRemove],
    });
    if (patched.changed) {
      const shape = splitLines(text);
      await fs.writeFile(file, joinLines(patched.lines, shape), 'utf8');
      state.notes.push(
        `Состав конфигурации выправлен: добавлено ${patched.added}, убрано ${patched.removed} объектов.`,
      );
    }
  } catch (err) {
    state.notes.push(`Не удалось выправить состав конфигурации: ${err.message}`);
  }
}

/**
 * Вносит и убирает строки `<Вид>Имя</Вид>` внутри блока ChildObjects.
 *
 * Экспортируется ради теста: ошибка здесь ломает загрузку всей конфигурации,
 * а проявляется только на живой базе.
 */
export function patchChildObjects(text, { add = [], remove = [] }) {
  const { lines } = splitLines(text);
  const openIdx = lines.findIndex((line) => line.includes('<ChildObjects>'));
  const closeIdx = lines.findIndex((line) => line.includes('</ChildObjects>'));
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
    return { lines, changed: false, added: 0, removed: 0 };
  }

  const removeXml = new Set(remove.map((key) => childObjectLine(key)?.xml).filter(Boolean));
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (i > openIdx && i < closeIdx && removeXml.has(lines[i].trim())) {
      removed += 1;
      continue;
    }
    out.push(lines[i]);
  }

  // Границы блока могли сдвинуться после удаления — ищем заново.
  const close = out.findIndex((line) => line.includes('</ChildObjects>'));
  const indent = /^(\s*)/.exec(out[close] || '')?.[1] || '\t\t';
  let added = 0;

  for (const key of add) {
    const item = childObjectLine(key);
    if (!item) continue;
    if (out.some((line) => line.trim() === item.xml)) continue;
    // Ставим рядом с однородными объектами: конфигуратор держит состав
    // сгруппированным по видам, и вразнобой его читать неудобно.
    let at = -1;
    for (let i = 0; i < close; i += 1) {
      if (out[i].trim().startsWith(`<${item.kind}>`)) at = i;
    }
    const insertAt = at === -1 ? close : at + 1;
    const lineIndent = at === -1 ? `${indent}\t` : /^(\s*)/.exec(out[at])?.[1] || indent;
    out.splice(insertAt, 0, `${lineIndent}${item.xml}`);
    added += 1;
  }

  return { lines: out, changed: added > 0 || removed > 0, added, removed };
}

/**
 * Карта версий объектов после объединения недействительна: файлы изменились,
 * а хеши в ней остались прежними. Платформа по ней решает, какие файлы читать
 * при загрузке, поэтому устаревшая карта опаснее отсутствующей — часть правок
 * молча не загрузилась бы.
 */
async function dropDumpInfo(state) {
  const file = path.join(state.mainDir, DUMP_INFO);
  if (!(await pathExists(file))) return;
  await fs.rm(file, { force: true }).catch(() => {});
  state.notes.push(
    'ConfigDumpInfo.xml удалён из выгрузки: после объединения он не соответствует файлам, '
    + 'и платформа должна прочитать выгрузку целиком.',
  );
}

// --- Ввод-вывод --------------------------------------------------------------

async function listFiles(dir) {
  const map = new Map();
  if (!dir) return map;

  async function walk(current, prefix) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        try {
          map.set(rel, (await fs.stat(full)).size);
        } catch {
          /* файл исчез между чтением каталога и stat — пропускаем */
        }
      }
    }
  }

  await walk(dir, '');
  return map;
}

function dirOf(state, tree) {
  return { main: state.mainDir, base: state.baseDir, target: state.targetDir }[tree];
}

async function read(state, tree, rel) {
  return fs.readFile(path.join(dirOf(state, tree), rel));
}

/**
 * Одинаковы ли файлы в двух выгрузках.
 *
 * Сначала сравниваются размеры: на типовой конфигурации совпадает почти всё,
 * и читать по три гигабайта, чтобы это подтвердить, незачем.
 */
async function same(state, treeA, treeB, rel) {
  const sizeA = state[treeA].get(rel);
  const sizeB = state[treeB].get(rel);
  if (sizeA === undefined || sizeB === undefined) return false;
  if (sizeA !== sizeB) return false;
  const [a, b] = await Promise.all([read(state, treeA, rel), read(state, treeB, rel)]);
  return a.equals(b);
}

async function copyFrom(state, tree, rel) {
  const target = path.join(state.mainDir, rel);
  await ensureDir(path.dirname(target));
  await fs.copyFile(path.join(dirOf(state, tree), rel), target);
  state.main.set(rel, state[tree].get(rel));
}

async function writeFile(state, rel, buffer) {
  const target = path.join(state.mainDir, rel);
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, buffer);
  state.main.set(rel, buffer.length);
}

async function removeFile(state, rel) {
  if (!state.main.has(rel)) return;
  await fs.rm(path.join(state.mainDir, rel), { force: true }).catch(() => {});
  state.main.delete(rel);
  state.totals.removedByVendor += 1;
  record(state, rel, { action: 'removed-by-vendor' });

  const entry = describeDumpPath(rel);
  if (entry.isObjectFile && entry.objectKey !== ROOT_KEY) state.childRemove.add(entry.objectKey);
}

/** UTF-16 с BOM: такие файлы построчно не объединяются (см. mergeContents). */
function isUtf16(buffer) {
  if (buffer.length < 2) return false;
  const [a, b] = buffer;
  return (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff);
}

// --- Сборка результата -------------------------------------------------------

/** Заносит файл в дерево объектов результата и возвращает запись элемента. */
function record(state, rel, data) {
  const entry = describeDumpPath(rel);
  if (!state.objects.has(entry.objectKey)) {
    state.objects.set(entry.objectKey, {
      key: entry.objectKey,
      title: objectTitle(entry.objectKey),
      kind: entry.kind,
      kindRu: entry.kindRu,
      name: entry.name,
      elements: [],
      elementsTruncated: 0,
    });
  }
  const object = state.objects.get(entry.objectKey);
  const element = {
    rel,
    element: entry.element,
    isModule: entry.isModule,
    conflicts: [],
    conflictCount: 0,
    ...data,
  };
  // Перечень файлов по объекту ограничен, а вот участки, требующие решения,
  // не теряются никогда: они и есть смысл всей операции.
  if (object.elements.length >= ELEMENTS_PER_OBJECT && !CONFLICT_ACTIONS.has(element.action)) {
    object.elementsTruncated += 1;
    return element;
  }
  object.elements.push(element);
  return element;
}

/** Группы результата в том порядке, в котором их читают. */
const CONFLICT_ACTIONS = new Set([
  'conflict', 'conflict-binary', 'conflict-too-big', 'conflict-vendor-deleted',
  'conflict-both-added', 'manual-two-way', 'manual-deleted-by-us', 'failed',
]);

function buildResult(state) {
  const objects = [...state.objects.values()];
  for (const object of objects) {
    object.elements.sort((a, b) => a.element.localeCompare(b.element, 'ru'));
    object.status = objectStatus(object);
  }

  const groups = {};
  const truncated = {};
  for (const status of ['manual', 'applied', 'added', 'removed', 'kept']) {
    const all = objects
      .filter((o) => o.status === status)
      .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    // Перечень «что решить руками» не обрезается: обрезать его — значит
    // умолчать о работе, которую всё равно придётся сделать.
    const limit = status === 'manual' ? all.length : OBJECTS_PER_GROUP;
    groups[status] = all.slice(0, limit);
    truncated[status] = Math.max(0, all.length - limit);
    groups[`${status}Count`] = all.length;
  }

  return {
    mode: state.mode,
    totals: state.totals,
    /** Главное: что предстоит решить руками. */
    manual: groups.manual,
    manualCount: groups.manualCount,
    applied: groups.applied,
    appliedCount: groups.appliedCount,
    added: groups.added,
    addedCount: groups.addedCount,
    removed: groups.removed,
    removedCount: groups.removedCount,
    kept: groups.kept,
    keptCount: groups.keptCount,
    truncated,
    conflictFiles: state.conflictFiles,
    conflictsSkipped: state.conflictsSkipped,
    conflictIndex: state.conflictIndex,
    notes: state.notes,
  };
}

function objectStatus(object) {
  if (object.elements.some((e) => CONFLICT_ACTIONS.has(e.action))) return 'manual';
  if (object.elements.some((e) => e.action === 'merged' || e.action === 'from-vendor')) return 'applied';
  if (object.elements.every((e) => e.action === 'added-by-vendor')) return 'added';
  if (object.elements.every((e) => e.action === 'removed-by-vendor')) return 'removed';
  return 'kept';
}
