/**
 * Работа с конфигурацией поставщика.
 *
 * Зачем это нужно. Аудит должен оценивать РАБОТУ ИНТЕГРАТОРА, а не качество
 * типового решения. Если в базе стоит ERP на 14 000 объектов, замечания по
 * типовому коду вендора только засоряют отчёт: исправлять их никто не будет, а
 * оценка трудозатрат раздувается в десятки раз.
 *
 * Поэтому при наличии конфигурации поставщика анализ ограничивается только
 * изменёнными и добавленными объектами.
 *
 * Как определяются изменения. Платформа при выгрузке в XML формирует
 * ConfigDumpInfo.xml — карту версий (хешей) по каждому объекту И по каждому
 * модулю:
 *
 *   <Metadata name="Catalog.Номенклатура" configVersion="9be9034e…"/>
 *   <Metadata name="Catalog.Номенклатура.ObjectModule" configVersion="d38400…"/>
 *   <Metadata name="Catalog.Номенклатура.Form.ФормаЭлемента.Form" configVersion="…"/>
 *
 * Сравнение этих карт для клиентской и поставщиковой конфигураций даёт точный
 * перечень изменений — без эвристик и без доступа к служебным таблицам базы.
 *
 * Источник конфигурации поставщика:
 *   • каталог XML-выгрузки — используется напрямую;
 *   • файл .cf — выгружается в XML средствами платформы автоматически.
 * Получить его: Конфигуратор → Конфигурация → Поддержка →
 * «Сохранить конфигурацию поставщика в файл».
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { parseXml, child, childText } from '../parse/xml.js';
import { readText, pathExists, ensureDir, rmrf } from '../util/fsx.js';
import { readConfigDumpInfo } from './baselines.js';
import { extractSynonym } from '../parse/configuration.js';
import { ruName, ruPlural } from '../parse/metadataKinds.js';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';
import { compareWithVendorInBase } from '../onec/vendorCompare.js';
import { parseConnection } from '../onec/connection.js';
import { createInfobase, loadCfg, dumpConfigToFiles } from '../onec/designer.js';

const log = createLogger('vendor');

/**
 * @typedef {object} VendorConfig
 * @property {boolean} available
 * @property {string} [reason] почему недоступна
 * @property {string} [dir] каталог XML-выгрузки
 * @property {object} [properties] свойства конфигурации поставщика
 * @property {Record<string,string>} hashes карта configVersion
 * @property {string} [source] 'dump' | 'cf'
 */

/**
 * Готовит конфигурацию поставщика к сравнению.
 *
 * @param {object} params
 * @param {string} params.vendorPath путь к .cf или к каталогу выгрузки
 * @param {import('../onec/platform.js').PlatformInstall} params.platform
 * @param {import('../onec/connection.js').Connection} params.conn
 * @param {string} params.workDir
 * @param {(text: string) => void} [params.onProgress]
 * @returns {Promise<VendorConfig>}
 */
export async function prepareVendorConfig({
  vendorPath, platform, conn, workDir, user, password, configName, totalEntries, onProgress,
}) {
  // Путь не указан — пробуем взять конфигурацию поставщика из самой базы.
  // Это снимает с пользователя ручной шаг «сохранить .cf в конфигураторе».
  if (!vendorPath || !vendorPath.trim()) {
    onProgress?.('Поиск конфигурации поставщика в самой базе');
    const inBase = await compareWithVendorInBase({
      platform, conn, workDir, configName, user, password, onProgress,
    });

    if (inBase.ok) {
      const changeSet = changeSetFromSets(inBase.sets, totalEntries);
      // Строки правок из подробного отчёта конфигуратора. Исходников поставщика
      // на диске нет и не будет, но где именно в типовом модуле доработка —
      // отчёт уже показал, и анализировать надо ровно эти строки.
      changeSet.moduleLines = inBase.moduleLines || null;
      log.info(
        `Сравнение с поставщиком выполнено в базе: изменено ${changeSet.modified.size}, ` +
        `добавлено ${changeSet.added.size}, удалено ${changeSet.removed.size}, ` +
        `модулей со строками правок ${inBase.moduleLines?.size || 0}`,
      );
      return {
        available: true,
        source: 'in-base',
        changeSet,
        hashes: {},
        // Свойства объектов, реквизиты и табличные части: у них нет ключей
        // в ConfigDumpInfo, но из них складывается дерево отличий в отчёте.
        details: inBase.details || null,
        properties: { name: configName, vendor: '', version: '' },
        dir: null,
      };
    }

    // Совет зависит от того, ПОЧЕМУ не вышло. Когда платформа не отдаёт
    // поставщика, у пользователя есть два пути, и первый — в один клик:
    // окно «Настройка поддержки» умеет сохранить конфигурацию поставщика
    // в файл даже тогда, когда сравнивать с ней отказывается (кнопка
    // «Сравнить, объединить» там неактивна, а «Сохранить в файл» — активна).
    if (inBase.vendorUnavailable) {
      return unavailable(
        `${inBase.reason} Сохраните поставку в файл сами: Конфигуратор → Конфигурация → ` +
        'Поддержка → Настройка поддержки → «Сохранить в файл» — и укажите этот файл в поле ' +
        '«Конфигурация поставщика — текущая поставка». Если конфигурация снята с поддержки, ' +
        'подойдёт дистрибутив того релиза, который стоит в базе сейчас.',
        { vendorUnavailable: true },
      );
    }
    if (inBase.needsNewerPlatform) {
      return unavailable(inBase.reason, { needsNewerPlatform: true });
    }

    return unavailable(
      `${inBase.reason}. Укажите файл .cf конфигурации поставщика вручную ` +
      '(Конфигуратор → Конфигурация → Поддержка → «Сохранить конфигурацию поставщика в файл»).',
    );
  }

  const target = path.resolve(vendorPath.trim());
  if (!(await pathExists(target))) {
    return unavailable(`Путь к конфигурации поставщика не найден: ${target}`);
  }

  const stat = await fs.stat(target);
  let dumpDir = target;
  let source = 'dump';

  if (stat.isFile()) {
    if (!/\.cf$/i.test(target)) {
      return unavailable('Ожидается файл .cf или каталог XML-выгрузки конфигурации поставщика');
    }
    onProgress?.('Разворачивание .cf во временную базу');
    const exported = await exportCfToXml({ cfFile: target, platform, workDir, onProgress });
    if (!exported.ok) return unavailable(exported.reason);
    dumpDir = exported.dir;
    source = 'cf';
  }

  const configFile = path.join(dumpDir, 'Configuration.xml');
  if (!(await pathExists(configFile))) {
    return unavailable(`В каталоге конфигурации поставщика нет Configuration.xml: ${dumpDir}`);
  }

  const hashes = await readConfigDumpInfo(path.join(dumpDir, 'ConfigDumpInfo.xml'));
  if (!Object.keys(hashes).length) {
    return unavailable(
      'В выгрузке конфигурации поставщика нет ConfigDumpInfo.xml с версиями объектов. ' +
      'Выгрузите конфигурацию поставщика заново — файл формируется платформой автоматически.',
    );
  }

  const properties = await readConfigurationProperties(configFile);
  log.info(`Конфигурация поставщика: ${properties.synonym || properties.name} ${properties.version}, объектов в карте версий: ${Object.keys(hashes).length}`);

  return { available: true, dir: dumpDir, properties, hashes, source };
}

function unavailable(reason, flags = {}) {
  return { available: false, reason, hashes: {}, ...flags };
}

/**
 * Разворачивает .cf в XML через временную пустую базу.
 *
 * Почему не проще. Напрашивающийся способ —
 * `ibcmd infobase config export --db-path=<база клиента> --file=<vendor.cf>`:
 * взять рабочую базу как контекст и подсунуть ей чужой файл конфигурации.
 * На реальной ERP (.cf 1,8 ГБ) он **молча падает**: код возврата 1 через 15 с,
 * ни одной строки в stdout/stderr, в каталоге остаются 9 первых групп объектов
 * из 46. Диагностировать нечего, поведение невоспроизводимо объяснимо.
 *
 * Рабочий способ: создать пустую файловую базу, загрузить в неё .cf
 * (`infobase create --load=<cf>`) и выгрузить уже её конфигурацию. Замер на той
 * же ERP: создание с загрузкой ~40 с, экспорт ~50 с, на выходе 46 элементов
 * и ConfigDumpInfo.xml на 34 МБ — то, ради чего всё и делается.
 *
 * Побочная выгода: рабочая база клиента в операции вообще не участвует,
 * поэтому способ применим и к серверным базам, и не требует ни пользователя,
 * ни пароля.
 *
 * Имена подкаталогов задаются снаружи: обновление нетиповой конфигурации
 * разворачивает ДВА файла .cf в одном рабочем каталоге — старую поставку
 * и новую, — и общий каталог `vendor` они затирали бы друг другом.
 *
 * @param {object} params
 * @param {string} params.cfFile
 * @param {string} params.workDir
 * @param {string} [params.name] имя подкаталога выгрузки (по умолчанию `vendor`)
 */
export async function exportCfToXml({
  platform, cfFile, workDir, name = 'vendor', onProgress, serviceBase = null,
}) {
  const outDir = path.join(workDir, name);
  const tempDbDir = path.join(workDir, `${name}-db`);

  // Служебная база, указанная пользователем, вместо своей временной.
  // Нужна там, где своя не заводится: конфигуратору на файловой базе требуется
  // лицензия на этой машине, а на терминальном сервере её может не быть вовсе
  // (лицензию там выдаёт сервер 1С и только для серверных баз).
  // Конфигурация служебной базы при этом перезаписывается — о чём сказано
  // в форме прямо, потому что иначе развернуть .cf нечем.
  if (serviceBase?.base) {
    return expandThroughBase({ platform, cfFile, outDir, serviceBase, onProgress });
  }

  try {
    // ibcmd не пишет в непустой каталог — оба чистим перед работой.
    await rmrf(tempDbDir).catch(() => {});
    await rmrf(outDir).catch(() => {});
    await ensureDir(tempDbDir);
    await ensureDir(outDir);

    onProgress?.('Загрузка .cf во временную базу (может занять несколько минут)');
    if (platform.ibcmd) {
      await run(platform.ibcmd, [
        'infobase', 'create',
        `--db-path=${tempDbDir}`,
        '--create-database',
        `--load=${cfFile}`,
      ], { timeout: TIMEOUTS.configExport });

      onProgress?.('Выгрузка конфигурации поставщика в XML');
      await run(platform.ibcmd, [
        'infobase', 'config', 'export',
        `--db-path=${tempDbDir}`,
        outDir,
      ], { timeout: TIMEOUTS.configExport });
    } else {
      // Клиентская установка платформы: ibcmd в неё не входит. Те же три шага
      // делает сам 1cv8 — создание базы, загрузка .cf, выгрузка в XML.
      // Дольше (конфигуратор поднимает больше подсистем) и требует лицензии,
      // но других отличий нет.
      const conn = parseConnection(tempDbDir);
      await createInfobase({ platform, dir: tempDbDir, logFile: `${tempDbDir}.log` });
      await loadCfg({ platform, conn, cfFile, logFile: `${tempDbDir}-loadcfg.log` });

      onProgress?.('Выгрузка конфигурации поставщика в XML');
      await dumpConfigToFiles({
        platform, conn, outDir, logFile: `${tempDbDir}-dump.log`,
      });
    }

    return { ok: true, dir: outDir };
  } catch (err) {
    rethrowIfCancelled(err);
    log.warn(`Не удалось развернуть .cf через временную базу: ${err.message}`);
    return {
      ok: false,
      reason:
        `Не удалось выгрузить конфигурацию поставщика из ${path.basename(cfFile)}: ${err.message}. ` +
        'Выгрузите её в XML вручную (Конфигуратор → Конфигурация → Выгрузить конфигурацию в файлы) ' +
        'и укажите путь к каталогу.',
    };
  } finally {
    // Временная база больше не нужна: на ERP это несколько гигабайт.
    await rmrf(tempDbDir).catch(() => {});
  }
}

/**
 * То же разворачивание, но в уже существующей базе, указанной пользователем.
 *
 * Своей базы здесь не создаётся вовсе — ни файловой, ни какой ещё: именно
 * в невозможности создать работающую файловую базу и состоит причина.
 * Конфигурация служебной базы перезаписывается содержимым `.cf`; конфигурация
 * базы данных при этом НЕ обновляется (`/UpdateDBCfg` не вызывается), то есть
 * данные базы не трогаются и её работоспособность не меняется.
 */
async function expandThroughBase({ platform, cfFile, outDir, serviceBase, onProgress }) {
  const conn = parseConnection(serviceBase.base);
  const auth = { user: serviceBase.user || '', password: serviceBase.password || '' };
  const logBase = path.join(path.dirname(outDir), `${path.basename(outDir)}-service`);

  try {
    await rmrf(outDir).catch(() => {});
    await ensureDir(outDir);

    onProgress?.(`Загрузка .cf в служебную базу ${conn.display} (может занять несколько минут)`);
    await loadCfg({ platform, conn, cfFile, ...auth, logFile: `${logBase}-loadcfg.log` });

    onProgress?.('Выгрузка конфигурации в XML');
    await dumpConfigToFiles({ platform, conn, outDir, ...auth, logFile: `${logBase}-dump.log` });

    return { ok: true, dir: outDir };
  } catch (err) {
    rethrowIfCancelled(err);
    log.warn(`Не удалось развернуть .cf через служебную базу: ${err.message}`);
    return {
      ok: false,
      reason: `Не удалось развернуть ${path.basename(cfFile)} через служебную базу `
        + `${conn.display}: ${err.message}`,
    };
  }
}

/**
 * Читает свойства конфигурации из Configuration.xml.
 *
 * Экспортируется: обновление нетиповой конфигурации показывает в отчёте все три
 * конфигурации — основную, текущую поставку и новую, — и читает свойства
 * каждой тем же кодом.
 */
export async function readConfigurationProperties(configFile) {
  try {
    const node = parseXml(await readText(configFile));
    const configNode = child(node, 'Configuration');
    const props = child(configNode, 'Properties');
    return {
      name: childText(props, 'Name'),
      synonym: extractSynonym(child(props, 'Synonym')),
      version: childText(props, 'Version'),
      vendor: childText(props, 'Vendor'),
      compatibilityMode: childText(props, 'CompatibilityMode'),
    };
  } catch (err) {
    log.warn(`Не удалось прочитать свойства конфигурации поставщика: ${err.message}`);
    return {};
  }
}

// --- Сравнение --------------------------------------------------------------

/**
 * Строит перечень изменений клиентской конфигурации относительно поставщика.
 *
 * @param {Record<string,string>} clientHashes
 * @param {Record<string,string>} vendorHashes
 */
export function buildChangeSet(clientHashes, vendorHashes) {
  const modified = new Set();
  const added = new Set();
  const removed = new Set();
  let unchanged = 0;

  for (const [key, hash] of Object.entries(clientHashes)) {
    const vendorHash = vendorHashes[key];
    if (vendorHash === undefined) {
      added.add(key);
    } else if (vendorHash !== hash) {
      modified.add(key);
    } else {
      unchanged += 1;
    }
  }

  for (const key of Object.keys(vendorHashes)) {
    if (clientHashes[key] === undefined) removed.add(key);
  }

  return {
    modified,
    added,
    removed,
    unchanged,
    totalClient: Object.keys(clientHashes).length,
    totalVendor: Object.keys(vendorHashes).length,
    /** Изменён или добавлен — то есть подлежит анализу. */
    isChanged(key) {
      return modified.has(key) || added.has(key);
    },
  };
}

/**
 * Тот же перечень изменений, но собранный не из карт хешей, а из готовых
 * множеств — так его отдаёт пакетное сравнение конфигуратора с конфигурацией
 * поставщика прямо в базе (см. `onec/vendorCompare.js`).
 *
 * Отличие от `buildChangeSet`: неизвестно число совпавших элементов —
 * конфигуратор печатает только различия. Поэтому `unchanged` считается
 * от общего числа элементов клиентской конфигурации, если оно передано.
 *
 * Размер конфигурации поставщика при этом выводится арифметически:
 * у поставщика есть всё, что совпало, всё, что изменено, и всё, что клиент
 * удалил, — но нет того, что клиент добавил. Раньше здесь стоял ноль, и отчёт
 * показывал «Элементов в конфигурации поставщика: 0» при сравнении прямо
 * в базе, хотя сравнение состоялось.
 *
 * @param {{modified: Set<string>, added: Set<string>, removed: Set<string>}} sets
 * @param {number} [totalClient] сколько всего элементов у клиента
 */
export function changeSetFromSets({ modified, added, removed }, totalClient = 0) {
  const differing = modified.size + added.size;
  const unchanged = Math.max(0, totalClient - differing);
  return {
    modified,
    added,
    removed,
    unchanged,
    totalClient,
    totalVendor: totalClient ? unchanged + modified.size + removed.size : 0,
    isChanged(key) {
      return modified.has(key) || added.has(key);
    },
  };
}

/**
 * Ключ в ConfigDumpInfo для верхнеуровневого объекта метаданных.
 * Формат совпадает с полным именем объекта: «Catalog.Номенклатура».
 */
export function dumpInfoKeyForObject(kind, name) {
  return `${kind}.${name}`;
}

/**
 * Ключ в ConfigDumpInfo для модуля кода.
 *
 * Раскладка ключей, подтверждённая на выгрузке ERP:
 *   CommonModule.Имя                                  — общий модуль
 *   Catalog.Имя.ObjectModule                          — модуль объекта
 *   Catalog.Имя.ManagerModule                         — модуль менеджера
 *   InformationRegister.Имя.RecordSetModule           — модуль набора записей
 *   Catalog.Имя.Form.ФормаЭлемента.Form               — форма
 *   Catalog.Имя.Command.Команда.CommandModule         — модуль команды
 *
 * @param {import('../parse/modules.js').ModuleRef} module
 * @returns {string|null} null — если ключ построить нельзя
 */
export function dumpInfoKeyForModule(module) {
  const { ownerKind, ownerName, moduleType, formName } = module;
  if (!ownerKind || !ownerName) return null;
  const base = `${ownerKind}.${ownerName}`;

  switch (moduleType) {
    case 'common': return base;
    case 'object': return `${base}.ObjectModule`;
    case 'manager': return `${base}.ManagerModule`;
    case 'recordset': return `${base}.RecordSetModule`;
    case 'valueManager': return `${base}.ValueManagerModule`;
    case 'form': return formName ? `${base}.Form.${formName}.Form` : null;
    case 'command': return formName ? `${base}.Command.${formName}.CommandModule` : null;
    default: return null;
  }
}

/**
 * Модуль целиком авторский: он сам или его объект-владелец добавлены
 * интегратором, у поставщика их нет.
 *
 * Такой модуль анализируется полностью. Изменённый типовой модуль — наоборот:
 * в нём проверяются только помеченные вставки (см. `bsl/authorship.js`).
 *
 * @param {import('../parse/modules.js').ModuleRef} module
 * @param {ReturnType<typeof buildChangeSet>} changeSet
 */
export function isAddedModule(module, changeSet) {
  const moduleKey = dumpInfoKeyForModule(module);
  if (moduleKey && changeSet.added.has(moduleKey)) return true;

  if (module.ownerKind && module.ownerName) {
    return changeSet.added.has(dumpInfoKeyForObject(module.ownerKind, module.ownerName));
  }
  // Корневые модули конфигурации (модуль приложения, модуль сеанса) типовые.
  return false;
}

/**
 * Решает, нужно ли анализировать модуль.
 *
 * Модуль анализируется, если изменился он сам ИЛИ изменился/добавлен объект-владелец
 * (у добавленного объекта все модули новые, отдельных записей о них может не быть).
 * Если ключ построить не удалось — анализируем, чтобы не потерять находки.
 *
 * @param {import('../parse/modules.js').ModuleRef} module
 * @param {ReturnType<typeof buildChangeSet>} changeSet
 */
export function shouldAnalyzeModule(module, changeSet) {
  const moduleKey = dumpInfoKeyForModule(module);
  if (moduleKey && changeSet.isChanged(moduleKey)) return true;

  if (module.ownerKind && module.ownerName) {
    const ownerKey = dumpInfoKeyForObject(module.ownerKind, module.ownerName);
    if (changeSet.added.has(ownerKey)) return true;
    // Изменение самого объекта (состав реквизитов) не означает изменения кода,
    // поэтому модуль без собственных изменений не анализируем.
    if (moduleKey) return false;
    if (changeSet.isChanged(ownerKey)) return true;
    return false;
  }

  // Корневые модули конфигурации (модуль приложения, модуль сеанса) — ключа нет.
  return true;
}

/** Сводка сравнения для отчёта. */
export function summarizeVendorComparison(vendor, changeSet, parsedObjects) {
  const objectKeys = new Set(parsedObjects.map((o) => `${o.kind}.${o.name}`));

  const changedObjects = [];
  const addedObjects = [];
  for (const key of changeSet.modified) {
    if (objectKeys.has(key)) changedObjects.push(key);
  }
  for (const key of changeSet.added) {
    if (objectKeys.has(key)) addedObjects.push(key);
  }

  const changedModules = countKeys(changeSet.modified, isModuleKey);
  const addedModules = countKeys(changeSet.added, isModuleKey);

  // Удалённых объектов нет в клиентской выгрузке, поэтому определить их можно
  // только по форме ключа: «Вид.Имя» — объект, «Вид.Имя.ObjectModule» — модуль.
  const removedObjects = [...changeSet.removed].filter(isObjectKey).sort();
  const removedModules = countKeys(changeSet.removed, isModuleKey);

  return {
    available: true,
    vendorName: vendor.properties?.vendor || '',
    vendorConfigName: vendor.properties?.synonym || vendor.properties?.name || '',
    vendorVersion: vendor.properties?.version || '',
    source: vendor.source,
    totalVendorEntries: changeSet.totalVendor,
    totalClientEntries: changeSet.totalClient,
    unchangedEntries: changeSet.unchanged,
    modifiedEntries: changeSet.modified.size,
    addedEntries: changeSet.added.size,
    removedEntries: changeSet.removed.size,
    changedObjects: changedObjects.sort(),
    addedObjects: addedObjects.sort(),
    removedObjects,
    changedObjectCount: changedObjects.length,
    addedObjectCount: addedObjects.length,
    removedObjectCount: removedObjects.length,
    changedModuleCount: changedModules,
    addedModuleCount: addedModules,
    removedModuleCount: removedModules,
  };
}

// --- Дерево отличий ---------------------------------------------------------

/**
 * Дерево отличий от конфигурации поставщика — то же, что показывает
 * конфигуратор в отчёте о сравнении конфигураций.
 *
 * Зачем оно, когда рядом уже есть таблица «изменено / добавлено / удалено».
 * Таблица отвечает на вопрос «насколько много», дерево — на вопрос «что
 * именно»: какой объект тронут, что в нём изменилось (реквизит, форма,
 * модуль) и чем отличается каждый модуль. Без этого сравнение остаётся
 * числом в отчёте, которое невозможно проверить.
 *
 * Источники подробностей, от самого точного к самому грубому:
 *   1. `moduleChanges` — построчное сравнение модулей с поставщиком
 *      (когда указан .cf или каталог выгрузки) либо разбор по пометкам;
 *   2. `details` — отчёт конфигуратора о сравнении прямо в базе: реквизиты,
 *      табличные части, свойства объектов;
 *   3. `composition` — сверка состава объекта с XML поставщика на диске;
 *   4. сами ключи ConfigDumpInfo — объекты, модули, формы, команды.
 *
 * Ни один из источников не обязателен: дерево строится из того, что есть.
 *
 * @param {object} params
 * @param {ReturnType<typeof buildChangeSet>} params.changeSet
 * @param {Map<string, {label: string, change: string}[]>|null} [params.details]
 * @param {object[]} [params.objects] объекты клиентской конфигурации
 * @param {object[]} [params.moduleChanges] отличия по модулям из анализа кода
 * @param {string|null} [params.vendorDir] каталог XML-выгрузки поставщика
 * @param {number} [params.limitObjectsPerKind]
 */
export async function buildVendorDiffTree({
  changeSet, details = null, objects = [], moduleChanges = [], vendorDir = null,
  limitObjectsPerKind = 250,
}) {
  if (!changeSet) return null;

  const clientObjects = new Map(objects.map((o) => [`${o.kind}.${o.name}`, o]));
  /** Ключ объекта → узел дерева. */
  const nodes = new Map();

  const nodeFor = (ownerKey) => {
    if (!nodes.has(ownerKey)) {
      const dot = ownerKey.indexOf('.');
      const kind = dot === -1 ? ownerKey : ownerKey.slice(0, dot);
      const name = dot === -1 ? '' : ownerKey.slice(dot + 1);
      const object = clientObjects.get(ownerKey);
      nodes.set(ownerKey, {
        key: ownerKey,
        kind,
        kindRu: ruName(kind) || kind,
        name,
        synonym: object?.synonym && object.synonym !== name ? object.synonym : '',
        status: statusOf(changeSet, ownerKey) || 'modified',
        children: new Map(),
      });
    }
    return nodes.get(ownerKey);
  };

  const childFor = (ownerKey, childKey, label, kind, status) => {
    const parent = nodeFor(ownerKey);
    if (!parent.children.has(childKey)) {
      parent.children.set(childKey, { key: childKey, label, kind, status, notes: [] });
    }
    return parent.children.get(childKey);
  };

  // 1. Ключи ConfigDumpInfo: объекты, модули, формы, команды, макеты.
  for (const [status, keys] of [
    ['modified', changeSet.modified], ['added', changeSet.added], ['removed', changeSet.removed],
  ]) {
    for (const key of keys) {
      const parts = String(key).split('.');
      if (parts.length < 2) continue;
      const ownerKey = `${parts[0]}.${parts[1]}`;
      if (parts.length === 2) {
        nodeFor(ownerKey).status = status;
        continue;
      }
      const { label, kind } = describeChildPath(parts.slice(2));
      childFor(ownerKey, key, label, kind, status);
    }
  }

  // 2. Подробности из отчёта конфигуратора: реквизиты, табличные части, свойства.
  if (details) {
    for (const [ownerKey, list] of details) {
      for (const item of list) {
        childFor(ownerKey, `${ownerKey}#${item.label}`, item.label, kindOfLabel(item.label), item.change);
      }
    }
  }

  // 3. Состав объекта против XML поставщика — когда исходники эталона на диске.
  if (vendorDir) {
    await addCompositionDiff({ nodes, clientObjects, vendorDir, changeSet });
  }

  // 4. Отличия внутри модулей — из анализа кода.
  for (const change of moduleChanges) {
    if (!change?.key) continue;
    const parts = String(change.key).split('.');
    if (parts.length < 2) continue;
    const ownerKey = `${parts[0]}.${parts[1]}`;
    const target = parts.length === 2
      ? nodeFor(ownerKey)
      : childFor(
        ownerKey, change.key,
        describeChildPath(parts.slice(2)).label,
        'module',
        statusOf(changeSet, change.key) || 'modified',
      );
    target.diff = change;
  }

  return assembleTree(nodes, { limitObjectsPerKind, changeSet, vendorDir, details });
}

function statusOf(changeSet, key) {
  if (changeSet.added.has(key)) return 'added';
  if (changeSet.removed.has(key)) return 'removed';
  if (changeSet.modified.has(key)) return 'modified';
  return null;
}

/** Русская подпись подчинённого элемента по «хвосту» ключа ConfigDumpInfo. */
function describeChildPath(tail) {
  const [first, second] = tail;
  const named = {
    Form: ['Форма', 'form'],
    Command: ['Команда', 'command'],
    Template: ['Макет', 'template'],
    Attribute: ['Реквизит', 'attribute'],
    TabularSection: ['Табличная часть', 'attribute'],
    Subsystem: ['Подсистема', 'other'],
    Recalculation: ['Перерасчёт', 'other'],
  }[first];
  if (named && second) return { label: `${named[0]} «${second}»`, kind: named[1] };

  const module = {
    ObjectModule: 'Модуль объекта',
    ManagerModule: 'Модуль менеджера',
    RecordSetModule: 'Модуль набора записей',
    ValueManagerModule: 'Модуль менеджера значения',
    CommandModule: 'Модуль команды',
    Module: 'Модуль',
  }[first];
  if (module) return { label: module, kind: 'module' };

  return { label: tail.join('.'), kind: 'other' };
}

/** Вид подчинённого элемента по русской подписи из отчёта конфигуратора. */
function kindOfLabel(label) {
  if (/^модуль/i.test(label)) return 'module';
  if (/^форма/i.test(label)) return 'form';
  if (/^команда/i.test(label)) return 'command';
  if (/^макет/i.test(label)) return 'template';
  if (/^(реквизит|измерение|ресурс|табличная часть|признак)/i.test(label)) return 'attribute';
  return 'property';
}

/**
 * Сверяет состав изменённых объектов с XML поставщика: какие реквизиты,
 * табличные части, формы и макеты появились, а какие исчезли.
 *
 * ConfigDumpInfo про состав молчит — там только хеш объекта целиком. Поэтому
 * при сравнении по .cf дерево без этого шага показывало бы «объект изменён»
 * и ни слова о том, что именно в нём поменялось.
 */
async function addCompositionDiff({ nodes, clientObjects, vendorDir, changeSet }) {
  const { parseSingleObject } = await import('../parse/configuration.js');

  let parsed = 0;
  for (const node of nodes.values()) {
    if (node.status !== 'modified') continue;
    if (parsed >= COMPOSITION_LIMIT) break;
    const client = clientObjects.get(node.key);
    if (!client?.attributes) continue;

    let vendorObject;
    try {
      vendorObject = await parseSingleObject(vendorDir, node.kind, node.name);
    } catch (err) {
      log.debug(`Состав объекта ${node.key} у поставщика не прочитан: ${err.message}`);
      continue;
    }
    if (!vendorObject) continue;
    parsed += 1;

    for (const [listName, ru] of COMPOSITION_PARTS) {
      const vendorNames = new Set(vendorObject[listName] || []);
      const clientNames = new Set(client[listName] || []);
      for (const name of clientNames) {
        if (vendorNames.has(name)) continue;
        addComposition(node, changeSet, `${ru} «${name}»`, 'added');
      }
      for (const name of vendorNames) {
        if (clientNames.has(name)) continue;
        addComposition(node, changeSet, `${ru} «${name}»`, 'removed');
      }
    }
  }
}

/** Сколько объектов сверять по составу: разбор XML стоит времени. */
const COMPOSITION_LIMIT = 400;

const COMPOSITION_PARTS = [
  ['attributes', 'Реквизит'],
  ['tabularSections', 'Табличная часть'],
  ['forms', 'Форма'],
  ['templates', 'Макет'],
  ['commands', 'Команда'],
];

function addComposition(node, changeSet, label, status) {
  const key = `${node.key}#${label}`;
  if (node.children.has(key)) return;
  node.children.set(key, { key, label, kind: kindOfLabel(label), status, notes: [] });
}

/** Раскладывает узлы по видам объектов и приводит к виду, пригодному для отчёта. */
function assembleTree(nodes, { limitObjectsPerKind, changeSet, vendorDir, details }) {
  const groups = new Map();
  const totals = { modified: 0, added: 0, removed: 0, details: 0 };

  for (const node of nodes.values()) {
    totals[node.status] = (totals[node.status] || 0) + 1;
    totals.details += node.children.size;

    if (!groups.has(node.kind)) {
      groups.set(node.kind, {
        kind: node.kind,
        kindRu: ruPlural(node.kind) || node.kind,
        counts: { modified: 0, added: 0, removed: 0 },
        objects: [],
      });
    }
    const group = groups.get(node.kind);
    group.counts[node.status] = (group.counts[node.status] || 0) + 1;
    group.objects.push({
      key: node.key,
      name: node.name,
      synonym: node.synonym,
      kindRu: node.kindRu,
      status: node.status,
      diff: node.diff || null,
      children: [...node.children.values()].sort(compareChildren),
    });
  }

  const list = [...groups.values()].sort((a, b) => b.objects.length - a.objects.length);
  for (const group of list) {
    group.objects.sort(compareObjects);
    group.total = group.objects.length;
    if (group.objects.length > limitObjectsPerKind) {
      group.truncated = group.objects.length - limitObjectsPerKind;
      group.objects = group.objects.slice(0, limitObjectsPerKind);
    }
  }

  return {
    totals,
    unchanged: changeSet.unchanged,
    /** Насколько подробно удалось разобрать отличия. */
    depth: vendorDir ? 'sources' : (details ? 'report' : 'keys'),
    groups: list,
  };
}

const STATUS_ORDER = { modified: 0, added: 1, removed: 2 };

function compareObjects(a, b) {
  const diff = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
  return diff || a.name.localeCompare(b.name, 'ru');
}

const CHILD_ORDER = { property: 0, attribute: 1, module: 2, form: 3, command: 4, template: 5, other: 6 };

function compareChildren(a, b) {
  const diff = (CHILD_ORDER[a.kind] ?? 9) - (CHILD_ORDER[b.kind] ?? 9);
  return diff || a.label.localeCompare(b.label, 'ru');
}

function isModuleKey(key) {
  return /\.(ObjectModule|ManagerModule|RecordSetModule|ValueManagerModule|CommandModule)$/.test(key)
    || /\.Form\.[^.]+\.Form$/.test(key);
}

/**
 * Ключ верхнеуровневого объекта метаданных: ровно «Вид.Имя».
 *
 * Имена объектов в 1С не содержат точек, поэтому две части — надёжный признак.
 * Вложенные подсистемы («Subsystem.А.Subsystem.Б») сюда намеренно не попадают:
 * лучше недосчитать, чем принять модуль за объект.
 */
function isObjectKey(key) {
  return !isModuleKey(key) && key.split('.').length === 2;
}

function countKeys(set, predicate) {
  let n = 0;
  for (const key of set) if (predicate(key)) n += 1;
  return n;
}
