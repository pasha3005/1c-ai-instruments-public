/**
 * Сравнение конфигурации с конфигурацией поставщика **прямо в базе**,
 * без ручного сохранения .cf.
 *
 * Долгое время считалось, что это невозможно: ни `ibcmd infobase config
 * support`, ни `ibcmd config support` не умеют ничего, кроме `disable`.
 * Но у конфигуратора есть пакетная команда `/CompareCfg`, и одним из типов
 * сравниваемых конфигураций является `VendorConfiguration` — конфигурация
 * поставщика, хранящаяся в самой базе.
 *
 * Проверено на реальной ERP (14 391 объект, поставщик БИТ):
 * отчёт на 231 КБ за 38 секунд, содержит все три вида отличий.
 *
 * **Отчёт запрашивается ПОДРОБНЫЙ (`-ReportType Full`), и это принципиально.**
 * Краткий отчёт сообщает только «Модуль - Изменено» — какой модуль отличается,
 * но не чем. Подробный печатает сами строки правки с номерами:
 *
 *   - ***ОбщийМодуль.АвансовыйОтчетЛокализация
 *       - Модуль - Различаются значения
 *           Объект присутствует только в основной конфигурации: 17 - 20
 *           "·// ++ ПРО_инт_и_Иванов И.И. 16.03.2021 #4878"
 *           "·Сообщить("ЗАВЕДОМО ПЛОХОЙ КОД");"
 *
 * То есть при сравнении прямо в базе исходников поставщика по-прежнему нет,
 * но ГДЕ в модуле правка — известно точно. Ровно этого раньше не хватало,
 * чтобы проверять изменённые типовые модули без пометок разработчика: модуль
 * объявлялся непроверяемым, хотя платформа отличия уже показала.
 *
 * Цена — время: на ERP подробный отчёт строится 65 с против 32 с и весит
 * 341 КБ против 231 КБ. За точность разбора доработок это дёшево.
 *
 * Ограничения:
 *  * нужен толстый клиент (1cv8.exe), ibcmd такого не умеет;
 *  * конфигурация должна стоять **на поддержке** — иначе конфигурации
 *    поставщика в базе просто нет;
 *  * обязательно имя конфигурации поставщика: поддержка бывает цепочкой
 *    (1С → отраслевой партнёр → клиент), и платформа требует уточнения.
 */

import path from 'node:path';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { ensureDir, pathExists, readText, rmrf } from '../util/fsx.js';
import { toClientArgs } from './connection.js';
import { tagByRu } from '../parse/metadataKinds.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('vendor-compare');

/** Маркеры отчёта сравнения. Пояснения к ним конфигуратор печатает в шапке. */
const MARK_CHANGED = '***';
const MARK_ONLY_MAIN = '-->'; // есть только в основной конфигурации — добавлено
const MARK_ONLY_VENDOR = '<--'; // есть только у поставщика — удалено

/**
 * Русские названия подчинённых свойств → суффикс ключа ConfigDumpInfo.
 * Пустая строка означает, что изменился сам объект (например, общий модуль).
 *
 * У формы суффикса нет намеренно. Конфигуратор печатает форму отдельным узлом
 * («***Справочник.X.Форма.ФормаЭлемента»), и ключ к этому моменту уже собран
 * целиком — `Catalog.X.Form.ФормаЭлемента.Form`. Строка «Форма - Изменено»
 * под ним относится к нему же. Пока здесь стояло `Form`, к готовому ключу
 * приписывался ещё один суффикс, и в набор изменённых попадал несуществующий
 * `…Form.ФормаЭлемента.Form.Form`: счётчик изменённых элементов завышался,
 * а в дереве отличий форма появлялась дважды.
 */
const MODULE_PROPERTY = new Map([
  ['модуль', ''],
  ['модуль объекта', 'ObjectModule'],
  ['модуль менеджера', 'ManagerModule'],
  ['модуль набора записей', 'RecordSetModule'],
  ['модуль менеджера значения', 'ValueManagerModule'],
  ['модуль команды', 'CommandModule'],
  ['модуль формы', ''],
  ['форма', ''],
]);

/**
 * Запускает пакетное сравнение и возвращает разобранный результат.
 *
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {import('./connection.js').Connection} params.conn
 * @param {string} params.workDir
 * @param {string} params.configName имя конфигурации (из Configuration.xml)
 * @param {string} [params.user]
 * @param {string} [params.password]
 * @param {(text: string) => void} [params.onProgress]
 * @returns {Promise<{ok: boolean, reason?: string, sets?: {modified: Set<string>, added: Set<string>, removed: Set<string>}, reportFile?: string}>}
 */
export async function compareWithVendorInBase({
  platform, conn, workDir, configName, user, password, onProgress,
}) {
  if (!platform.client) {
    return { ok: false, reason: `В платформе ${platform.version} не найден 1cv8.exe` };
  }
  if (!configName) {
    return { ok: false, reason: 'Не определено имя конфигурации — сравнение с поставщиком в базе невозможно' };
  }

  const dir = await ensureDir(path.join(workDir, 'vendor-compare'));
  const reportFile = path.join(dir, 'compare.txt');
  const logFile = path.join(dir, 'designer.log');

  const buildArgs = (reportType) => [
    'DESIGNER',
    ...toClientArgs(conn),
    ...(user ? [`/N${user}`] : []),
    ...(password ? [`/P${password}`] : []),
    '/CompareCfg',
    '-FirstConfigurationType', 'MainConfiguration',
    '-SecondConfigurationType', 'VendorConfiguration',
    '-SecondName', configName,
    '-IncludeChangedObjects',
    '-IncludeAddedObjects',
    '-IncludeDeletedObjects',
    '-ReportType', reportType,
    '-ReportFormat', 'txt',
    '-ReportFile', reportFile,
    '/DisableStartupDialogs',
    '/DisableStartupMessages',
    '/Out', logFile,
  ];

  onProgress?.('Сравнение с конфигурацией поставщика средствами платформы');
  log.info(`Пакетное сравнение с поставщиком «${configName}»`);

  /**
   * Подробный отчёт — основной: только он печатает строки правок. Краткий
   * остаётся запасным на случай, если версия платформы подробный не построит:
   * состав отличий он даёт тот же, теряются лишь строки внутри модулей.
   */
  let failure = null;
  for (const reportType of ['Full', 'Brief']) {
    await rmrf(reportFile).catch(() => {});
    await rmrf(logFile).catch(() => {});

    try {
      await run(platform.client, buildArgs(reportType), {
        timeout: TIMEOUTS.configExport,
        allowNonZeroExit: true,
      });
    } catch (err) {
      rethrowIfCancelled(err);
      failure = `Конфигуратор не выполнил сравнение: ${err.message}`;
      continue;
    }

    if (!(await pathExists(reportFile))) {
      const designerLog = (await readLogSafe(logFile)).trim();
      failure = designerLog
        ? `Конфигуратор не сформировал отчёт сравнения: ${designerLog.slice(0, 300)}`
        : 'Конфигуратор не сформировал отчёт сравнения с конфигурацией поставщика';
      continue;
    }

    const sets = parseCompareReport(await readText(reportFile));
    await rmrf(logFile).catch(() => {});

    if (!sets.modified.size && !sets.added.size && !sets.removed.size) {
      failure = 'Отчёт сравнения пуст — возможно, конфигурация не на поддержке';
      continue;
    }

    log.info(
      `Отчёт сравнения (${reportType}): изменено ${sets.modified.size}, добавлено ${sets.added.size}, ` +
      `удалено ${sets.removed.size}, модулей со строками правок ${sets.moduleLines.size}`,
    );
    return {
      ok: true,
      sets,
      details: sets.details,
      // Строки правок по модулям: при сравнении в базе это единственный
      // источник сведений о том, ГДЕ в типовом модуле доработка.
      moduleLines: sets.moduleLines,
      reportType,
      reportFile,
    };
  }

  return { ok: false, reason: failure };
}

/** Русское слово отчёта → внутреннее обозначение вида отличия. */
const CHANGE_BY_RU = new Map([
  ['изменено', 'modified'],
  ['добавлено', 'added'],
  ['удалено', 'removed'],
  // Подробный отчёт вместо «Изменено» пишет «Различаются значения» — то же
  // самое. Пока это слово не разбиралось, из подробного отчёта терялись
  // подчинённые модули («Модуль менеджера - Различаются значения»),
  // и набор изменённых элементов оказывался беднее, чем у краткого.
  ['различаются значения', 'modified'],
]);

/** Состояние свойства: «Модуль - Различаются значения». */
const PROPERTY_LINE = /^(.+?)\s*-\s*(Изменено|Добавлено|Удалено|Различаются значения)$/i;

/**
 * Заголовки блоков строк внутри изменённого модуля (только подробный отчёт).
 *
 * **Номерам строк доверять нельзя, тексту — можно.** Проверено на реальной ERP:
 * из 52 блоков вставок на файл модуля точно легли 40, остальные оказались
 * сдвинуты, а у блоков «Изменено» номера и вовсе принадлежат конфигурации
 * поставщика — в модуле `СобытияФормКлиент` пара участков (135 и 143) в файле
 * стоит наоборот (143 и 135). Похоже, конфигуратор нумерует строки в общем
 * пространстве сравнения, где удалённые строки поставщика тоже занимают места,
 * поэтому сдвиг накапливается по мере удалений.
 *
 * Поэтому из отчёта берётся **текст** строк правки, а место в модуле
 * определяется поиском этого текста (`reportedRegions` в `codeAnalyzer`).
 * Номер остаётся подсказкой для разрешения повторов. Строку, которую найти
 * не удалось, просто не проверяем: пропущенная доработка — потеря, а вот
 * сдвинутый участок означал бы замечания к коду вендора, то есть ровно ту
 * ошибку, ради устранения которой всё и делалось.
 *
 * «Только в конфигурации поставщика» — удалённые строки: в проверяемом модуле
 * такого кода нет вовсе, поэтому от блока остаётся только счётчик.
 */
const CLIENT_ONLY_LINES = /только в основной конфигурации:\s*(\d+)\s*-\s*(\d+)$/i;
const CHANGED_LINES = /^Изменено:\s*(\d+)\s*-\s*(\d+)$/i;
const VENDOR_ONLY_LINES = /только в конфигурации поставщика:\s*(\d+)\s*-\s*(\d+)$/i;

/** Узел «Состав» подсистемы: под ним перечисляются чужие объекты. */
const COMPOSITION_NODE = /^(Состав|Командный интерфейс|Подсистемы)$/i;

/** Сколько участков правки хранить по одному модулю. */
const REGIONS_PER_MODULE = 200;

/** И сколько строк их текста: это исходники в памяти, предел нужен. */
const LINES_PER_MODULE = 5_000;

/**
 * Разбирает текстовый отчёт сравнения в ключи ConfigDumpInfo.
 *
 * Формат (отступы — табуляции, вложенность значима):
 *   - ***Справочник.Номенклатура            объект изменён
 *       - Модуль менеджера - Изменено       изменился конкретный модуль
 *       - История выбора при вводе - Изменено   изменилось свойство объекта
 *       - -->Справочник.Номенклатура.Реквизит.X   добавлен реквизит
 *   - -->Подсистема.ДРБ_Казначейство        объект есть только у клиента
 *   - <--Документ.Устаревший                объект есть только у поставщика
 *
 * Строки-пояснения из шапки («***- Объект изменен») отбрасываются: у них
 * маркер стоит перед дефисом, а не после имени вида.
 *
 * Кроме ключей возвращаются **подробности** — свойства, реквизиты, табличные
 * части и подсистемы, у которых собственного ключа в ConfigDumpInfo нет.
 * Для фильтра анализа кода они бесполезны (кода в них нет), но именно из них
 * складывается дерево отличий в отчёте: «изменён реквизит», «добавлена
 * табличная часть» — то, что пользователь ждёт увидеть от сравнения
 * конфигураций и чего хеш объекта не рассказывает.
 *
 * И главное, ради чего отчёт запрашивается подробным, — **строки правок**
 * внутри модулей (`moduleLines`). Ниже строки «Модуль - Различаются значения»
 * конфигуратор печатает блоки вида
 *
 *   Объект присутствует только в основной конфигурации: 17 - 20
 *   "·// ++ ПРО_инт_и_Иванов И.И. 16.03.2021 #4878"
 *
 * — то есть прямо указывает, какие строки проверяемого модуля дописаны
 * относительно поставщика. Этого достаточно, чтобы проверить доработку
 * в типовом модуле, не имея исходников поставщика вовсе.
 *
 * @param {string} text
 * @returns {{modified: Set<string>, added: Set<string>, removed: Set<string>,
 *            details: Map<string, {label: string, change: string}[]>,
 *            moduleLines: Map<string, {regions: {startLine: number, endLine: number}[],
 *                                      changedLines: number, removedLines: number}>}}
 */
export function parseCompareReport(text) {
  const modified = new Set();
  const added = new Set();
  const removed = new Set();
  /** Ключ объекта → перечень его подчинённых отличий. */
  const details = new Map();
  /** Ключ модуля → участки правок в координатах проверяемой конфигурации. */
  const moduleLines = new Map();

  const addKey = (change, key) => {
    if (change === 'modified') modified.add(key);
    else if (change === 'added') added.add(key);
    else removed.add(key);
  };

  /** Последний встреченный изменённый объект — к нему относятся свойства ниже. */
  let currentObject = null;
  /** Модуль, чьи строки правок сейчас перечисляются (подробный отчёт). */
  let currentModule = null;
  /** Разбираемый участок правки: заголовок прочитан, дальше идут строки кода. */
  const blockState = { block: null, kind: null };
  /**
   * Стек узлов по отступу — нужен, чтобы отличить объект конфигурации
   * от объекта, перечисленного в составе подсистемы. Подробный отчёт
   * печатает состав подсистем, и запись «-->ОбщаяКоманда.X» под узлом
   * «Состав» означает «команда включена в подсистему», а не «команда
   * добавлена в конфигурацию». Без этой проверки в набор добавленных
   * попадали типовые объекты, у которых сменилась принадлежность.
   */
  const stack = [];

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (!line.startsWith('-')) {
      // Внутри блока модуля: заголовок участка правки либо сама строка кода.
      if (currentModule) readModuleLines(moduleLines, currentModule, line, blockState);
      continue;
    }

    currentModule = null;
    blockState.block = null;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const inComposition = stack.length > 0 && stack[stack.length - 1].composition;

    const body = line.replace(/^-\s*/, '');
    const marker = [MARK_CHANGED, MARK_ONLY_MAIN, MARK_ONLY_VENDOR].find((m) => body.startsWith(m));

    if (marker) {
      const label = body.slice(marker.length).trim();
      const parsed = parseObjectPath(label);
      const change = marker === MARK_CHANGED ? 'modified'
        : marker === MARK_ONLY_MAIN ? 'added' : 'removed';

      if (!parsed) {
        // Узел-свойство: «Состав», «Командный интерфейс», «По умолчанию».
        stack.push({ indent, composition: inComposition || COMPOSITION_NODE.test(label) });
        continue;
      }

      if (inComposition) {
        // Принадлежность объекта подсистеме — свойство подсистемы.
        addDetail(details, currentObject, parsed.label || prettyName(label), change);
        stack.push({ indent, composition: true });
        continue;
      }

      if (parsed.key) {
        addKey(change, parsed.key);
        if (change === 'modified') currentObject = parsed.key;
      } else {
        // Реквизит, табличная часть, подсистема: своего ключа в ConfigDumpInfo
        // у них нет — запоминаем как подробность объекта-владельца.
        addDetail(details, parsed.ownerKey, parsed.label, change);
        currentObject = parsed.ownerKey;
      }
      stack.push({ indent, composition: false });
      continue;
    }

    // Свойство изменённого объекта: «Модуль менеджера - Изменено».
    const prop = PROPERTY_LINE.exec(body);
    if (prop && currentObject) {
      const label = prop[1].trim();
      const suffix = MODULE_PROPERTY.get(label.toLowerCase());
      if (suffix !== undefined) {
        // Суффикс добавляется, только если его ещё нет: конфигуратор печатает
        // команду отдельным узлом («Обработка.X.Команда.Согласование»), и ключ
        // к моменту строки «Модуль команды - Изменено» уже собран целиком —
        // `…Command.Согласование.CommandModule`. Приписанный второй суффикс
        // давал несуществующий элемент: счётчик изменённых завышался, а сам
        // модуль команды не находил своих строк правок и попадал в список
        // непроверенных. У общей команды («ОбщаяКоманда.X») суффикса, наоборот,
        // ещё нет, и его надо добавить — поэтому проверка, а не отказ.
        const key = suffix && !currentObject.endsWith(`.${suffix}`)
          ? `${currentObject}.${suffix}`
          : currentObject;
        modified.add(key);
        // Дальше подробный отчёт печатает строки правок именно этого модуля.
        currentModule = key;
        continue;
      }
      addDetail(details, currentObject, label, CHANGE_BY_RU.get(prop[2].toLowerCase()) || 'modified');
    }
    stack.push({ indent, composition: inComposition });
  }

  return { modified, added, removed, details, moduleLines };
}

/**
 * Разбор участков правки внутри модуля: заголовок участка и строки кода под ним.
 *
 * Собирается **текст** строк, принадлежащих проверяемой конфигурации:
 *  * блок «только в основной конфигурации» — это дописанные строки, они идут
 *    в кавычках подряд;
 *  * блок «Изменено» — пара «было / стало», клиентская сторона помечена «>»;
 *  * блок «только в конфигурации поставщика» — удалённые строки, в проверяемом
 *    модуле их нет: от блока остаётся только счётчик.
 *
 * Номер строки сохраняется как подсказка, а не как истина — см. комментарий
 * к `CLIENT_ONLY_LINES`.
 */
function readModuleLines(moduleLines, key, line, state) {
  // Заголовок участка — обычный текст. Строки кода конфигуратор печатает
  // в кавычках, а различающиеся значения — со знаками «<» и «>».
  const isHead = !/^["<>]/.test(line);

  if (isHead) {
    const vendor = VENDOR_ONLY_LINES.exec(line);
    const client = vendor ? null : CLIENT_ONLY_LINES.exec(line);
    const changed = vendor || client ? null : CHANGED_LINES.exec(line);
    if (!vendor && !client && !changed) {
      state.block = null;
      return;
    }

    if (!moduleLines.has(key)) {
      moduleLines.set(key, { blocks: [], removedLines: 0, storedLines: 0 });
    }
    const entry = moduleLines.get(key);

    if (vendor) {
      entry.removedLines += Math.max(0, Number(vendor[2]) - Number(vendor[1]) + 1);
      state.block = null;
      return;
    }

    if (entry.blocks.length >= REGIONS_PER_MODULE) {
      state.block = null;
      return;
    }
    const startLine = Number((client || changed)[1]);
    state.block = { startLine: Number.isFinite(startLine) ? startLine : 0, lines: [] };
    state.kind = client ? 'client' : 'changed';
    entry.blocks.push(state.block);
    return;
  }

  const entry = moduleLines.get(key);
  if (!state.block || !entry || entry.storedLines >= LINES_PER_MODULE) return;

  // В блоке вставки строка кода идёт в кавычках, версии поставщика у нею нет —
  // это чистое добавление. В блоке «Изменено» клиентская сторона помечена «>»,
  // версия поставщика — «<»: раньше её просто отбрасывали, а для двустороннего
  // показа в отчёте (как в 1С — слева поставщик, справа клиент) нужна и она.
  if (state.kind === 'client' && line.startsWith('"')) {
    state.block.lines.push(unquoteReportLine(line));
    entry.storedLines += 1;
    return;
  }
  if (state.kind === 'changed' && line.startsWith('<')) {
    (state.block.vendorLines ||= []).push(unquoteReportLine(line.slice(1).trim()));
    return;
  }
  if (state.kind === 'changed' && line.startsWith('>')) {
    state.block.lines.push(unquoteReportLine(line.slice(1).trim()));
    entry.storedLines += 1;
  }
}

/**
 * `"·Сообщить(\"текст\");"` → `\tСообщить("текст");`
 *
 * Конфигуратор берёт строку в кавычки целиком и рисует табуляции точками.
 */
function unquoteReportLine(text) {
  return String(text)
    .replace(/^"/, '')
    .replace(/"$/, '')
    .replace(/·/g, '\t');
}

/** «ОбщаяКоманда.СоздатьРезервнуюКопию» → «Общая команда «СоздатьРезервнуюКопию»». */
function prettyName(russianName) {
  const dot = String(russianName).indexOf('.');
  if (dot === -1) return russianName;
  return `${russianName.slice(0, dot)} «${russianName.slice(dot + 1)}»`;
}

function addDetail(details, ownerKey, label, change) {
  if (!ownerKey || !label) return;
  if (!details.has(ownerKey)) details.set(ownerKey, []);
  const list = details.get(ownerKey);
  if (list.some((d) => d.label === label && d.change === change)) return;
  // Отчёт по крупной конфигурации может перечислять сотни реквизитов одного
  // объекта; в дереве столько не нужно, а вес результата это удваивает.
  if (list.length >= 200) return;
  list.push({ label, change });
}

/**
 * Разбирает русское имя из отчёта конфигуратора.
 *
 * «Справочник.Номенклатура.Форма.ФормаЭлемента» →
 *   key = «Catalog.Номенклатура.Form.ФормаЭлемента.Form»
 * «Справочник.Номенклатура.Реквизит.ДРБ_Ключ» →
 *   key = null, ownerKey = «Catalog.Номенклатура», label = «Реквизит «ДРБ_Ключ»»
 *
 * Русскими остаются только имена объектов — их платформа не переводит.
 *
 * @returns {{key: string|null, ownerKey: string|null, label: string}|null}
 *   null — вид не опознан
 */
function parseObjectPath(russianName) {
  const parts = String(russianName).split('.');
  if (parts.length < 2) return null;

  const tag = tagByRu(parts[0]);
  if (!tag) return null;

  const ownerKey = `${tag}.${parts[1]}`;
  const key = [tag, parts[1]];

  // Вложенные части: Форма, Команда, Реквизит, Подсистема…
  for (let i = 2; i < parts.length; i += 2) {
    const childKind = parts[i];
    const childName = parts[i + 1];
    if (!childName) break;
    if (/^форма$/i.test(childKind)) {
      key.push('Form', childName, 'Form');
    } else if (/^команда$/i.test(childKind)) {
      // Именно команда, а не её модуль. Раньше здесь сразу приписывался
      // `CommandModule`, и любое изменение команды — например только «Тип
      // параметра команды» — объявляло изменённым её МОДУЛЬ. На реальной ERP
      // так получился единственный «непроверенный» модуль: команда
      // «Согласование» обработки `инт_УстановкаВиз`, где кода никто не трогал.
      // Модуль команды помечается строкой «Модуль команды - Изменено», как
      // и у прочих объектов.
      key.push('Command', childName);
    } else {
      // Реквизиты, табличные части, подсистемы — собственных модулей нет,
      // отдельными ключами в ConfigDumpInfo не значатся.
      return { key: null, ownerKey, label: `${childKind} «${childName}»` };
    }
  }

  return { key: key.join('.'), ownerKey, label: '' };
}

async function readLogSafe(file) {
  try {
    if (!(await pathExists(file))) return '';
    return await readText(file);
  } catch {
    return '';
  }
}

/** Удаляет временные файлы сравнения. */
export async function cleanupCompare(workDir) {
  await rmrf(path.join(workDir, 'vendor-compare')).catch(() => {});
}
