/**
 * Разбор ошибок проверок платформы — тем же окном, что и спорные места.
 *
 * После обновления платформа отвечает на два вопроса: компилируется ли код
 * («Проверка модулей») и сможет ли она наложить расширения на изменившуюся
 * конфигурацию («Проверка возможности применения»). Оба ответа до сих пор
 * попадали в отчёт и на этом заканчивались — исправлять приходилось
 * в конфигураторе. Требование пользователя 26.08.2026: показать ошибки
 * в том же окне, что и спорные места, дать исправить или пропустить, а потом
 * проверить заново.
 *
 * Здесь собирается перечень таких мест. Каждое — либо уже разобранное
 * программой (перенос доработки расширения на новый метод, `extensionMerge.js`,
 * значок «шестерёнка с галочкой»), либо ждущее человека.
 *
 * **Пропуск — это решение, а не отмена.** Часть замечаний платформы к делу
 * не относится: они были в конфигурации и до обновления (проверено на чистой
 * УНФ 3.0.14.115 — платформа находит их и там). Помеченное пропущенным
 * из счёта уходит, и когда не остаётся ничего, кроме пропущенного, обновление
 * продолжается.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { pathExists } from '../util/fsx.js';
import { kindByDir, tagByRu } from '../parse/metadataKinds.js';
import { highlightLines, diffMarks } from './mergeReview.js';

/**
 * Место ошибки в журнале платформы: `{ОбщийМодуль.Имя.Модуль(25,3)}`.
 *
 * Дальше через двоеточие идёт текст, а следующей строкой — сама строка кода
 * с пометкой `<<?>>`. Нам нужны вид, имя и род модуля: по ним ищется файл
 * в выгрузке.
 */
const PLACE = /^\{([^.{}]+)\.([^.{}]+)(?:\.([^.{}(]+))?\s*\((\d+)\s*,\s*(\d+)\)\}\s*:?\s*(.*)$/;

/** Род модуля из журнала → имя файла в выгрузке. */
const MODULE_FILE = new Map([
  ['модуль', 'Module.bsl'],
  ['модульобъекта', 'ObjectModule.bsl'],
  ['модульменеджера', 'ManagerModule.bsl'],
  ['модульнаборазаписей', 'RecordSetModule.bsl'],
  ['модульменеджеразначения', 'ValueManagerModule.bsl'],
  ['модулькоманды', 'CommandModule.bsl'],
  ['модульприложения', 'ApplicationModule.bsl'],
  ['модульобычногоприложения', 'OrdinaryApplicationModule.bsl'],
  ['модульуправляемогоприложения', 'ManagedApplicationModule.bsl'],
  ['модульсеанса', 'SessionModule.bsl'],
  ['модульвнешнегосоединения', 'ExternalConnectionModule.bsl'],
]);

/** Каталог выгрузки по виду объекта: обратная сторона `kindByDir`. */
const DIR_BY_TAG = buildDirIndex();

function buildDirIndex() {
  const map = new Map();
  for (const dir of [
    'Catalogs', 'Documents', 'CommonModules', 'InformationRegisters', 'AccumulationRegisters',
    'AccountingRegisters', 'CalculationRegisters', 'Enums', 'Reports', 'DataProcessors',
    'ChartsOfCharacteristicTypes', 'ChartsOfAccounts', 'ChartsOfCalculationTypes',
    'BusinessProcesses', 'Tasks', 'ExchangePlans', 'DocumentJournals', 'CommonCommands',
    'Constants', 'FilterCriteria', 'SettingsStorages', 'Subsystems',
  ]) {
    const kind = kindByDir(dir);
    if (kind?.tag) map.set(kind.tag, dir);
  }
  return map;
}

/**
 * Файл выгрузки, в котором лежит место ошибки.
 *
 * Экспортируется ради теста: разбор строки журнала легко испортить незаметно.
 *
 * @returns {{rel: string, line: number, column: number, text: string,
 *            kindRu: string, name: string}|null}
 */
export function locateCheckError(message) {
  const hit = PLACE.exec(String(message || '').trim());
  if (!hit) return null;
  const [, kindRu, name, moduleRu, line, column, text] = hit;

  const tag = tagByRu(kindRu);
  const dir = tag ? DIR_BY_TAG.get(tag) : null;
  const file = MODULE_FILE.get(normalize(moduleRu || 'Модуль'));

  // Корневые модули конфигурации лежат вне каталога объекта.
  if (!dir && /^конфигурация$/i.test(kindRu)) {
    const root = MODULE_FILE.get(normalize(moduleRu || ''));
    return root
      ? { rel: `Ext/${root}`, line: Number(line), column: Number(column), text, kindRu, name }
      : null;
  }
  if (!dir || !file) return { rel: '', line: Number(line), column: Number(column), text, kindRu, name };

  const rel = tag === 'CommonModule'
    ? `${dir}/${name}/Ext/Module.bsl`
    : `${dir}/${name}/Ext/${file}`;
  return { rel, line: Number(line), column: Number(column), text, kindRu, name };
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s-]/g, '').replace(/ё/g, 'е');
}

/**
 * Перечень мест, требующих внимания после проверок платформы.
 *
 * Порядок значим: сначала то, где решение за человеком, потом разобранное
 * программой. Читают этот список сверху вниз.
 */
export function buildCheckItems(checks) {
  if (!checks) return [];
  const items = [];

  for (const item of checks.extensionConflicts || []) {
    items.push({
      id: `ext:${item.extension}:${item.rel}:${item.routine || ''}`,
      kind: 'extension',
      status: 'manual',
      extension: item.extension,
      title: `Расширение «${item.extension}»`,
      element: item.routine ? `Метод «${item.routine}»` : item.rel,
      rel: item.rel,
      routine: item.routine || '',
      reason: item.reason || '',
      file: item.file || '',
      mainFile: item.mainFile || '',
    });
  }

  for (const item of checks.extensionMerges || []) {
    items.push({
      id: `ext-auto:${item.extension}:${item.rel}:${item.routine || ''}`,
      kind: 'extension',
      status: 'auto',
      extension: item.extension,
      title: `Расширение «${item.extension}»`,
      element: item.routine ? `Метод «${item.routine}»` : item.rel,
      rel: item.rel,
      routine: item.routine || '',
      how: item.how || '',
      why: item.why || '',
      reason: '',
      file: item.file || '',
      mainFile: item.mainFile || '',
    });
  }

  for (const [scope, check] of [['config', checks.config], ['extensions', checks.extensionsSyntax]]) {
    for (const error of check?.errors || []) {
      const place = locateCheckError(error.message || error.text || String(error));
      items.push({
        id: `mod:${scope}:${error.message || error.text || ''}`.slice(0, 300),
        kind: 'module',
        status: 'manual',
        scope,
        title: scope === 'config' ? 'Проверка модулей конфигурации' : 'Проверка модулей расширений',
        element: place?.rel || place?.name || 'место не определено',
        rel: place?.rel || '',
        line: place?.line || 0,
        reason: error.message || error.text || String(error),
        file: '',
        mainFile: '',
      });
    }
  }

  return items;
}

/** Сколько мест ещё ждут решения: разобранное и пропущенное из счёта уходит. */
export function checksLeft(checks, state = {}) {
  const decided = state.checks || {};
  return buildCheckItems(checks)
    .filter((item) => item.status === 'manual' && !decided[item.id]).length;
}

/** Дерево для окна: расширение либо «Проверка модулей» → места. */
export function buildCheckReview(checks, state = {}) {
  const decided = state.checks || {};
  const items = buildCheckItems(checks).map((item) => ({
    ...item, decision: decided[item.id] || null,
  }));

  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.title)) groups.set(item.title, { key: item.title, title: item.title, files: [] });
    groups.get(item.title).files.push(item);
  }

  const objects = [...groups.values()];
  for (const object of objects) {
    object.manual = object.files.filter((f) => f.status === 'manual').length;
    object.auto = object.files.filter((f) => f.status === 'auto').length;
    object.left = object.files.filter((f) => f.status === 'manual' && !f.decision).length;
  }

  return {
    objects,
    totals: {
      files: items.length,
      manual: items.filter((i) => i.status === 'manual').length,
      auto: items.filter((i) => i.status === 'auto').length,
      decided: items.filter((i) => decided[i.id]).length,
      left: items.filter((i) => i.status === 'manual' && !decided[i.id]).length,
    },
  };
}

/** Тексты одного места: что правим слева и с чем сверяемся справа. */
export async function readCheckItem(checks, state, id) {
  const item = buildCheckItems(checks).find((i) => i.id === id);
  if (!item) throw new Error('Это место не значится среди ошибок проверок');

  const own = item.file || (item.kind === 'module' && item.rel && checks.mergedDir
    ? path.join(checks.mergedDir, item.rel)
    : '');
  const other = item.mainFile || (item.kind === 'extension' && item.rel && checks.mergedDir
    ? path.join(checks.mergedDir, item.rel)
    : '');

  const current = await readSafe(own);
  const otherText = await readSafe(other);
  // Колонки приходят в том же виде, что у спорных мест: подсвеченные строки
  // и цвета отличий. Окно тогда одно на обе группы, а не два похожих.
  const marks = diffMarks(current, otherText);
  const ext = path.extname(own || item.rel || '.bsl').toLowerCase();

  return {
    ...item,
    decision: (state.checks || {})[id] || null,
    current,
    ours: current == null ? null : { lines: highlightLines(current, ext), marks: marks.left },
    theirs: otherText == null ? null : { lines: highlightLines(otherText, ext), marks: marks.right },
    base: null,
    hasAuto: false,
    ownPath: own,
    otherPath: other,
    editable: Boolean(own) && (await pathExists(own)),
  };
}

/** Записывает правку человека в файл выгрузки расширения либо конфигурации. */
export async function writeCheckItem(checks, id, text) {
  const item = buildCheckItems(checks).find((i) => i.id === id);
  if (!item) throw new Error('Это место не значится среди ошибок проверок');
  const own = item.file || (item.rel && checks.mergedDir ? path.join(checks.mergedDir, item.rel) : '');
  if (!own || !(await pathExists(own))) {
    throw new Error('Файл этого места не найден — исправьте его в конфигураторе либо пропустите');
  }

  let eol = '\r\n';
  try {
    const before = await fs.readFile(own, 'utf8');
    eol = before.includes('\r\n') ? '\r\n' : '\n';
  } catch {
    /* прочитать не вышло — пишем в принятом для выгрузки виде */
  }
  await fs.writeFile(own, String(text).replace(/\r\n?/g, '\n').split('\n').join(eol), 'utf8');
  return { id, path: own };
}

async function readSafe(file) {
  if (!file) return null;
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}
