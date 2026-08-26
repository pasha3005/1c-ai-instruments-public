/**
 * Восстановление СТАРОЙ поставки по данным из самой базы.
 *
 * Долго считалось, что без файла `.cf` трёхстороннее объединение невозможно:
 * общей точки отсчёта нет, объединять нечем. Это неверно, и на это указал
 * пользователь: раз мы умеем СРАВНИВАТЬ конфигурацию с конфигурацией
 * поставщика прямо в базе, значит поставщика мы видим — надо лишь собрать
 * из сравнения его тексты.
 *
 * Собирается это из двух источников, и первый важнее второго:
 *
 * 1. **Всё, чего нет в перечне отличий, у поставщика ровно такое же.** Отчёт
 *    `/CompareCfg` перечисляет отличия исчерпывающе, поэтому для подавляющего
 *    большинства файлов выгрузки старая поставка совпадает с основной
 *    конфигурацией байт в байт. На реальной ERP это 14 000 объектов из 14 391.
 *
 * 2. **Для изменённых модулей подробный отчёт печатает обе стороны каждого
 *    участка** (`-ReportType Full`): наши строки и строки поставщика. Обратной
 *    подстановкой из нашего модуля получается модуль поставщика.
 *
 * Чего восстановить нельзя — и об этом говорится честно:
 *
 * * **XML изменённых объектов.** Отчёт называет изменённое свойство
 *   («Синоним», «Реквизит «Договор»»), но не печатает его прежнее значение.
 *   Такие файлы помечаются «неизвестно» и разбираются по объекту.
 * * **Строки, удалённые интегратором.** Блок «присутствует только
 *   в конфигурации поставщика» печатает лишь диапазон, без текста. Пропуск
 *   заполняется из НОВОЙ поставки: там эти строки почти всегда сохранились.
 *   Не нашлись — модуль честно уходит в «неизвестно».
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { splitLines, joinLines, changedHunks } from './diff3.js';
import { dumpInfoKey, describeDumpPath, childObjectLine, ROOT_KEY } from './dumpKeys.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('vendor-restore');

/**
 * Свои файлы конфигурации, о которых отчёт сравнения судить не даёт.
 *
 * `Configuration.xml` хранит свойства конфигурации и её СОСТАВ. Свойства
 * отчёт называет («Версия - Изменено»), состав — тоже, перечнем добавленных
 * и удалённых объектов; собрать из этого прежний файл поставщика можно точно
 * (`restoreConfigurationXml`), и только если отчёт сообщил о правке САМОЙ
 * конфигурации — какого-то её свойства помимо состава, — файл честно уходит
 * в «неизвестно».
 *
 * Корневые МОДУЛИ конфигурации с 26.08.2026 в этот список не входят: у них
 * появился ключ (`dumpInfoKey`), и они разбираются наравне с остальными
 * модулями — либо отчёт их не называет, и тогда у поставщика они наши, либо
 * называет со строками правок, и тогда текст поставщика собирается точно.
 * Раньше всё содержимое `Ext/` объявлялось неизвестным огулом, и пользователь
 * получал в спорные места «Модуль обычного приложения», который не трогал.
 *
 * Служебные файлы поставки (`ParentConfigurations.bin` — цепочка поддержки,
 * `MobileClientSignature.bin` — подпись мобильного клиента) не правятся
 * руками вовсе: их пишет платформа. Ключа у них нет, отчёт о них молчит,
 * и «молчит» здесь значит именно «у поставщика они такие же».
 */
function rootPropertiesChanged(compare) {
  return (compare?.details?.get(ROOT_KEY) || []).length > 0;
}

/**
 * Строит дерево старой поставки поверх выгрузки основной конфигурации.
 *
 * Файлы не копируются на диск: выгрузка ERP весит гигабайты, а второй её
 * экземпляр нужен ровно для чтения. Дерево отдаёт содержимое по требованию —
 * либо тот же файл основной конфигурации, либо восстановленный текст.
 *
 * @param {object} params
 * @param {string} params.mainDir каталог выгрузки основной конфигурации
 * @param {Map<string, number>} params.mainFiles путь → размер
 * @param {object} params.compare результат `compareWithVendorInBase`
 * @param {{files: Map<string, number>, read: (rel: string) => Promise<Buffer>}} params.targetTree
 *   новая поставка — из неё заполняются пропуски удалённых строк
 * @param {(text: string) => void} [params.onProgress]
 */
export async function restoreVendorTree({
  mainDir, mainFiles, compare, targetTree, onProgress,
}) {
  const modified = compare?.sets?.modified || new Set();
  const added = compare?.sets?.added || new Set();
  const removed = compare?.sets?.removed || new Set();
  const moduleLines = compare?.moduleLines || new Map();
  const rootUnknown = rootPropertiesChanged(compare);
  const changedProps = changedProperties(compare);

  /** Файлы, содержимое которых у поставщика известно и отличается от нашего. */
  const restored = new Map();
  /** Файлы, о которых судить нельзя. */
  const unknown = new Set();
  /** Что есть в старой поставке: путь → размер (для быстрого сравнения). */
  const files = new Map();

  const stats = {
    sameAsOurs: 0, restoredModules: 0, approxModules: 0, unknown: 0, ourOwn: 0, deletedByUs: 0,
    /** Собран ли состав конфигурации: 1 — да, 0 — файл ушёл в «неизвестно». */
    restoredRoot: 0,
  };

  let seen = 0;
  for (const [rel, size] of mainFiles) {
    seen += 1;
    if (seen % 2000 === 0) onProgress?.(`восстановлено файлов поставки: ${seen} из ${mainFiles.size}`);

    const entry = describeDumpPath(rel);
    const objectKey = entry.objectKey;

    // Объект добавлен интегратором — в старой поставке его нет вовсе.
    if (objectKey !== ROOT_KEY && added.has(objectKey)) {
      stats.ourOwn += 1;
      continue;
    }

    // Свойства и состав конфигурации: собираются из перечня добавленных
    // и удалённых объектов, а не объявляются неизвестными огулом.
    if (rel === 'Configuration.xml') {
      const rebuilt = rootUnknown
        ? null
        : await restoreConfigurationXml(path.join(mainDir, rel), added, removed);
      if (rebuilt) {
        restored.set(rel, rebuilt);
        files.set(rel, rebuilt.length);
        stats.restoredRoot += 1;
      } else {
        unknown.add(rel);
        files.set(rel, size);
        stats.unknown += 1;
      }
      continue;
    }

    const key = dumpInfoKey(rel);
    let changed = key ? modified.has(key) : false;

    // Описание объекта — особый случай. Узел объекта отчёт помечает изменённым
    // и тогда, когда изменились ОДНИ ЕГО МОДУЛИ: «*** Документ.АвансовыйОтчет»
    // и под ним только «Модуль объекта - Различаются значения». Свойств
    // и реквизитов отчёт при этом не называет ни одного — значит описание
    // объекта у нас и у поставщика совпадает, и объявлять его неизвестным
    // не за что. Из-за этого пользователь получал в спорные места тип
    // реквизита, которого не касался (живой случай 27.08.2026, сверено с его
    // же отчётом сравнения).
    if (changed && entry.isObjectFile && !(changedProps.get(objectKey) || []).length) {
      changed = false;
    }

    if (!changed) {
      // Отличий у файла нет — значит у поставщика он ровно такой же.
      files.set(rel, size);
      stats.sameAsOurs += 1;
      continue;
    }

    if (entry.isModule && moduleLines.has(key)) {
      let oursText;
      try {
        oursText = await fs.readFile(path.join(mainDir, rel), 'utf8');
      } catch {
        oursText = null;
      }
      const theirsText = await readTextSafe(targetTree, rel);
      const rebuilt = oursText == null
        ? { ok: false }
        : rebuildVendorModule(oursText, moduleLines.get(key), theirsText);

      if (rebuilt.ok) {
        const buffer = Buffer.from(rebuilt.text, 'utf8');
        restored.set(rel, buffer);
        files.set(rel, buffer.length);
        stats.restoredModules += 1;
        if (!rebuilt.exact) stats.approxModules += 1;
        continue;
      }
    }

    unknown.add(rel);
    files.set(rel, size);
    stats.unknown += 1;
  }

  // Объекты, удалённые интегратором: в старой поставке они были. Точного текста
  // у нас нет, но новая поставка почти всегда содержит их же — этого достаточно,
  // чтобы объединение увидело «удалено нами», а не «добавлено поставщиком».
  for (const rel of targetTree.files.keys()) {
    if (files.has(rel) || mainFiles.has(rel)) continue;
    const objectKey = describeDumpPath(rel).objectKey;
    if (objectKey === ROOT_KEY || !removed.has(objectKey)) continue;
    files.set(rel, targetTree.files.get(rel));
    restored.set(rel, await targetTree.read(rel));
    stats.deletedByUs += 1;
  }

  log.info(
    `Старая поставка восстановлена из базы: совпадает ${stats.sameAsOurs}, `
    + `модулей собрано ${stats.restoredModules} (приблизительно ${stats.approxModules}), `
    + `неизвестно ${stats.unknown}`,
  );

  return {
    source: 'restored',
    files,
    unknown,
    /**
     * Свойства, изменённые интегратором: ключ объекта → подписи из отчёта.
     * По ним объединение разбирает XML, прежнего состояния которого
     * у поставщика мы не знаем: участок в НЕтронутом свойстве изменил один
     * поставщик, и его версию можно взять смело.
     */
    changedProps,
    stats,
    async read(rel) {
      const ready = restored.get(rel);
      if (ready) return ready;
      return fs.readFile(path.join(mainDir, rel));
    },
  };
}

/**
 * Configuration.xml поставщика: наш файл, у которого состав приведён к прежнему.
 *
 * Свойства самой конфигурации мы не меняли — иначе отчёт назвал бы их, и файл
 * ушёл бы в «неизвестно» ещё до вызова. Значит от нашего файла поставка
 * отличается ровно составом: объекты, добавленные интегратором, у поставщика
 * отсутствуют, а удалённые им — присутствуют. И то и другое отчёт перечисляет
 * исчерпывающе, так что сборка получается точной, а не приблизительной.
 *
 * Почему нельзя просто счесть файл совпадающим с нашим: тогда объединение
 * увидело бы «тронул только поставщик» и взяло бы Configuration.xml новой
 * поставки ЦЕЛИКОМ — вместе с составом, где наших объектов нет. Конфигурация
 * загрузилась бы без единой доработки.
 *
 * @returns {Promise<Buffer|null>} null — файл не прочитан либо в нём нет
 *   блока ChildObjects: судить о таком нельзя.
 */
export async function restoreConfigurationXml(file, added, removed) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const patched = vendorChildObjects(text, added, removed);
  if (!patched) return null;
  return Buffer.from(patched, 'utf8');
}

/**
 * Состав конфигурации, каким он был у поставщика.
 *
 * Экспортируется ради теста: ошибка здесь ломает загрузку всей конфигурации,
 * а проявляется только на живой базе.
 */
export function vendorChildObjects(text, added = new Set(), removed = new Set()) {
  const shape = splitLines(text);
  const lines = shape.lines;
  const openIdx = lines.findIndex((line) => line.includes('<ChildObjects>'));
  const closeIdx = lines.findIndex((line) => line.includes('</ChildObjects>'));
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return null;

  const drop = new Set();
  for (const key of added) {
    const item = childObjectLine(key);
    if (item) drop.add(item.xml);
  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > openIdx && i < closeIdx && drop.has(lines[i].trim())) continue;
    out.push(lines[i]);
  }

  // Объекты, удалённые интегратором, у поставщика были — возвращаем их
  // к однородным соседям, как это делает конфигуратор.
  const close = out.findIndex((line) => line.includes('</ChildObjects>'));
  const indent = /^(s*)/.exec(out[close] || '')?.[1] || '		';
  for (const key of removed) {
    const item = childObjectLine(key);
    if (!item) continue;
    if (out.some((line) => line.trim() === item.xml)) continue;
    let at = -1;
    for (let i = 0; i < close; i += 1) {
      if (out[i].trim().startsWith(`<${item.kind}>`)) at = i;
    }
    const insertAt = at === -1 ? close : at + 1;
    const lineIndent = at === -1 ? `${indent}	` : /^(s*)/.exec(out[at])?.[1] || indent;
    out.splice(insertAt, 0, `${lineIndent}${item.xml}`);
  }

  return joinLines(out, shape);
}

/** Подписи изменённых свойств из отчёта сравнения: ключ объекта → перечень. */
function changedProperties(compare) {
  const out = new Map();
  const details = compare?.details;
  if (!details) return out;
  for (const [key, items] of details) {
    const labels = (items || [])
      .filter((item) => item.change === 'modified' || item.change === 'added')
      .map((item) => item.label)
      .filter(Boolean);
    if (labels.length) out.set(key, labels);
  }
  return out;
}

async function readTextSafe(tree, rel) {
  if (!tree?.files?.has(rel)) return '';
  try {
    return (await tree.read(rel)).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Восстанавливает текст модуля поставщика из нашего модуля и участков отчёта.
 *
 * @param {string} oursText модуль основной конфигурации
 * @param {{blocks: {startLine: number, kind: string, lines: string[], vendorLines?: string[]}[],
 *          gaps: {order: number, count: number}[]}} entry участки из отчёта
 * @param {string} [theirsText] новая поставка — источник для пропусков
 * @returns {{ok: boolean, text?: string, exact?: boolean, reason?: string}}
 */
export function rebuildVendorModule(oursText, entry, theirsText = '') {
  const shape = splitLines(oursText);
  const ours = shape.lines;
  const blocks = (entry?.blocks || []).filter((b) => b.lines?.length);
  const gaps = entry?.gaps || [];

  if (!blocks.length && !gaps.length) {
    return { ok: false, reason: 'в отчёте нет участков правки' };
  }

  const located = locateBlocks(ours, blocks);
  if (!located.ok) return { ok: false, reason: located.reason };

  // Сборка без пропусков: наши строки заменяются строками поставщика,
  // дописанные нами — выбрасываются.
  const ordered = [...located.placed].sort((a, b) => a.at - b.at);
  const out = [];
  /** Позиция в собираемом тексте, где стоит каждый участок, — для пропусков. */
  const anchorByBlock = new Map();
  let cursor = 0;

  for (const item of ordered) {
    for (let i = cursor; i < item.at; i += 1) out.push(ours[i]);
    anchorByBlock.set(item.block, out.length);
    if (item.block.kind === 'changed') out.push(...(item.block.vendorLines || []));
    cursor = item.at + item.block.lines.length;
  }
  for (let i = cursor; i < ours.length; i += 1) out.push(ours[i]);

  // Пропуски — строки, удалённые интегратором. Их текста в отчёте нет.
  let exact = true;
  if (gaps.length) {
    const filled = fillGaps(out, gaps, blocks, anchorByBlock, theirsText);
    if (!filled.ok) return { ok: false, reason: filled.reason };
    return { ok: true, text: joinLines(filled.lines, shape), exact: filled.exact };
  }

  return { ok: true, text: joinLines(out, shape), exact };
}

/**
 * Ищет каждый участок в нашем модуле по ТЕКСТУ.
 *
 * Номерам строк в отчёте доверять нельзя (проверено на реальной ERP: из 52
 * участков точно легли 40), поэтому номер служит лишь подсказкой при выборе
 * из нескольких одинаковых мест. Участки с единственным вариантом занимают
 * место первыми — иначе неоднозначный участок мог бы забрать чужое место.
 */
function locateBlocks(ours, blocks) {
  const candidates = blocks.map((block) => ({
    block,
    positions: findOccurrences(ours, block.lines),
  }));

  const missing = candidates.find((c) => !c.positions.length);
  if (missing) {
    return { ok: false, reason: 'участок правки не найден в модуле' };
  }

  candidates.sort((a, b) => a.positions.length - b.positions.length);

  const taken = [];
  const placed = [];
  for (const candidate of candidates) {
    const hint = (candidate.block.startLine || 1) - 1;
    const free = candidate.positions.filter(
      (at) => !taken.some((r) => at < r.end && at + candidate.block.lines.length > r.start),
    );
    if (!free.length) return { ok: false, reason: 'участки правки накладываются друг на друга' };
    const at = free.reduce((best, p) => (Math.abs(p - hint) < Math.abs(best - hint) ? p : best), free[0]);
    taken.push({ start: at, end: at + candidate.block.lines.length });
    placed.push({ block: candidate.block, at });
  }

  return { ok: true, placed };
}

/** Все позиции, с которых последовательность строк встречается в тексте. */
function findOccurrences(lines, needle) {
  const found = [];
  if (!needle.length) return found;
  const last = lines.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (lines[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) found.push(i);
    // Больше нескольких десятков одинаковых мест — участок бесполезен как якорь.
    if (found.length > 50) break;
  }
  return found;
}

/**
 * Заполняет пропуски удалённых строк из новой поставки.
 *
 * Пропуск — это N строк, которые у поставщика были, а у нас их нет; их текст
 * отчёт не печатает. Зато новая поставка — прямой потомок старой, и в ней эти
 * строки чаще всего лежат нетронутыми. Сравнив собранный текст с новой
 * поставкой, берём то, что новая поставка «добавляет» ровно в этом месте.
 *
 * Если взять неоткуда — восстановление объявляется неудачным. Молча оставить
 * пропуск нельзя: тогда объединение сочло бы эти строки правкой поставщика
 * и вернуло бы в конфигурацию то, что интегратор осознанно удалил.
 */
function fillGaps(lines, gaps, blocks, anchorByBlock, theirsText) {
  if (!theirsText) return { ok: false, reason: 'нечем заполнить удалённые строки' };

  const theirs = splitLines(theirsText).lines;
  const hunks = changedHunks(lines, theirs);
  if (!hunks) return { ok: false, reason: 'новая поставка отличается слишком сильно' };

  const inserts = [];
  let exact = true;

  for (const gap of gaps) {
    // Пропуск стоит перед участком, который в отчёте шёл следом за ним.
    const nextBlock = blocks[gap.order];
    const at = nextBlock && anchorByBlock.has(nextBlock)
      ? anchorByBlock.get(nextBlock)
      : lines.length;

    const source = hunks.find((h) => h.baseStart <= at && at <= h.baseEnd && h.sideEnd > h.sideStart);
    if (!source) return { ok: false, reason: 'удалённые строки не найдены в новой поставке' };

    const available = theirs.slice(source.sideStart, source.sideEnd);
    const take = available.slice(0, gap.count);
    if (take.length !== gap.count) exact = false;
    inserts.push({ at, lines: take });
  }

  const out = [];
  let cursor = 0;
  for (const insert of inserts.sort((a, b) => a.at - b.at)) {
    for (let i = cursor; i < insert.at; i += 1) out.push(lines[i]);
    out.push(...insert.lines);
    cursor = insert.at;
  }
  for (let i = cursor; i < lines.length; i += 1) out.push(lines[i]);

  return { ok: true, lines: out, exact };
}
