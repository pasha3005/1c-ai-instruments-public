/**
 * Драйвер утилиты ibcmd (входит в поставку платформы 8.3.14+).
 *
 * Преимущества перед конфигуратором:
 *   • работает без графической подсистемы и не открывает окон;
 *   • не требует лицензии 1С:Предприятие;
 *   • корректно возвращает код возврата и текст ошибки в stdout/stderr.
 *
 * Ограничение: ibcmd обращается к СУБД напрямую, поэтому применим только к
 * файловым базам (--db-path). Для серверных баз используется designer.js.
 */

import path from 'node:path';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { ensureDir } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('ibcmd');

/** Базовые аргументы адресации информационной базы. */
function targetArgs(conn, { user, password } = {}) {
  if (conn.kind !== 'file') {
    throw new Error('ibcmd поддерживает только файловые информационные базы');
  }
  const args = [`--db-path=${conn.dbPath}`];
  if (user) args.push(`--user=${user}`);
  if (password) args.push(`--password=${password}`);
  return args;
}

/**
 * Выгружает конфигурацию информационной базы в XML.
 *
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {import('./connection.js').Connection} params.conn
 * @param {string} params.outDir каталог назначения
 * @param {string} [params.user]
 * @param {string} [params.password]
 * @param {(text: string) => void} [params.onProgress]
 */
export async function exportConfig({ platform, conn, outDir, user, password, onProgress }) {
  await ensureDir(outDir);
  const args = [
    'infobase', 'config', 'export',
    ...targetArgs(conn, { user, password }),
    outDir,
  ];
  log.info(`Выгрузка конфигурации в ${outDir}`);
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.configExport,
    onStdout: onProgress,
  });
  return { outDir, stdout: result.stdout };
}

/**
 * Выгружает в XML ТОЛЬКО перечисленные объекты конфигурации.
 *
 * Ради двух изменённых модулей выгружать конфигурацию целиком — самая дорогая
 * глупость в режиме хранилища: на ERP это ~90 с против секунд. Команда
 * `config export objects` появилась не вчера и проверена живьём 17.08.2026
 * (8.3.24.1691): имена принимаются русские, ровно в том виде, в каком их
 * печатает история хранилища (`Документ.Документ1`), тексты модулей совпадают
 * с полной выгрузкой байт в байт, файлы ложатся по тем же каноническим путям.
 *
 * `recursive` (ключ `-r`) добавляет подчинённые объекты — формы, команды,
 * макеты. Без него у документа выгрузится только модуль объекта.
 *
 * @param {string[]} params.names имена объектов; пустой список — делать нечего
 */
export async function exportObjects({
  platform, conn, names, outDir, recursive = true, extension, user, password, onProgress,
}) {
  const list = recursive ? dropDescendants(names) : (names || []).filter(Boolean);
  if (!list.length) return { outDir, ok: true, skipped: true };
  await ensureDir(outDir);

  const args = [
    'infobase', 'config', 'export', 'objects',
    ...targetArgs(conn, { user, password }),
    `--out=${outDir}`,
  ];
  if (recursive) args.push('--recursive');
  if (extension) args.push(`--extension=${extension}`);
  args.push(...list);

  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.configExport,
    allowNonZeroExit: true,
    onStdout: onProgress,
  });
  if (result.code !== 0) {
    log.warn(`Выборочная выгрузка не удалась (${list.length} объектов): ${result.stderr || result.stdout}`);
  }
  return { outDir, ok: result.code === 0, reason: result.stderr || result.stdout };
}

/**
 * Убирает из списка объекты, которые и так попадут по рекурсии от родителя.
 *
 * История хранилища перечисляет и объект, и его форму:
 * `Документ.Документ1` и `Документ.Документ1.Форма.ФормаДокумента`. С ключом
 * `-r` платформа выгружает форму дважды — по рекурсии и по явному имени —
 * и падает с «Ошибка совместного доступа к файлу» (поймано живьём 17.08.2026
 * на двух объектах сразу; на одном объекте отказа не было, поэтому дефект
 * легко было и не заметить).
 *
 * Граница проверяется по точке: `Документ.Документ1` не должен считаться
 * родителем `Документ.Документ10`.
 */
export function dropDescendants(names) {
  const list = [...new Set((names || []).filter(Boolean))];
  return list.filter((name) => !list.some((other) => other !== name && name.startsWith(`${other}.`)));
}

/**
 * Список расширений конфигурации.
 * Возвращает массив имён; пустой массив — расширений нет.
 */
export async function listExtensions({ platform, conn, user, password }) {
  const args = [
    'infobase', 'config', 'extension', 'list',
    ...targetArgs(conn, { user, password }),
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.quick,
    allowNonZeroExit: true,
  });
  if (result.code !== 0) {
    log.warn(`Не удалось получить список расширений: ${result.stderr || result.stdout}`);
    return [];
  }
  return parseExtensionList(result.stdout);
}

/**
 * Разбирает вывод `ibcmd infobase config extension list`.
 *
 * Основной формат (проверено на 8.5.1) — блок «ключ : значение» на каждое
 * расширение:
 *
 *   name                         : "ПРО_Дополнения"
 *   version                      : "1.0.0.1"
 *   active                       : yes
 *
 * Прежний разбор считал такой вывод простым списком: строки `name : …`
 * отбрасывались как шапка таблицы, а в имена расширений попадали слова
 * «version», «active», «purpose», «scope». Пока имена ни на что не влияли,
 * ошибка не проявлялась; как только по ним стали искать недовыгруженные
 * расширения — вылезла сразу.
 *
 * Запасной разбор простого списка оставлен: у других версий формат иной.
 */
export function parseExtensionList(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[(INFO|WARN|ERROR)]/i.test(line));

  const named = lines
    .map((line) => /^name\s*:\s*(.*)$/i.exec(line))
    .filter(Boolean)
    .map((m) => m[1].trim().replace(/^"|"$/g, '').trim())
    .filter(Boolean);
  if (named.length) return named;

  return lines
    // Отбрасываем возможную шапку таблицы (\b не работает с кириллицей).
    .filter((line) => !/^(имя|name)(\s|$)/i.test(line))
    .filter((line) => !line.includes(':'))
    .map((line) => line.split(/\s{2,}|\t/)[0].trim())
    .filter((name) => /^[A-Za-zА-Яа-яЁё_][\wЀ-ӿ]*$/.test(name));
}

/** Подробные свойства расширения (активность, безопасный режим, назначение). */
export async function extensionInfo({ platform, conn, name, user, password }) {
  const args = [
    'infobase', 'config', 'extension', 'info',
    `--name=${name}`,
    ...targetArgs(conn, { user, password }),
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.quick,
    allowNonZeroExit: true,
  });
  if (result.code !== 0) return { name };
  return { name, ...parseKeyValueOutput(result.stdout) };
}

/**
 * Создаёт в базе пустое расширение.
 *
 * Нужно ради хранилищ расширений: команды хранилища работают не с основной
 * конфигурацией базы-контекста, а с её расширением, и без него платформа
 * отвечает «Соединение основной конфигурации с хранилищем расширений
 * конфигураций невозможно» (проверено 12.08.2026 на 8.5.1.1150).
 *
 * Возвращает `{ok, reason}`: повторное создание того же имени — не ошибка
 * прогона, а сигнал «расширение уже есть».
 */
export async function createExtension({ platform, conn, name, prefix, user, password }) {
  const args = [
    'infobase', 'config', 'extension', 'create',
    ...targetArgs(conn, { user, password }),
    `--name=${name}`,
    `--name-prefix=${prefix || name}`,
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.configExport,
    allowNonZeroExit: true,
  });
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || '').trim();
    log.warn(`Расширение «${name}» не создано: ${reason}`);
    return { ok: false, reason };
  }
  log.info(`В базе создано расширение «${name}»`);
  return { ok: true };
}

/** Выгружает все расширения в XML: <outDir>/<ИмяРасширения>/... */
export async function exportAllExtensions({ platform, conn, outDir, user, password, onProgress }) {
  await ensureDir(outDir);
  const args = [
    'infobase', 'config', 'export', 'all-extensions',
    ...targetArgs(conn, { user, password }),
    outDir,
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.configExport,
    allowNonZeroExit: true,
    onStdout: onProgress,
  });
  if (result.code !== 0) {
    log.warn(`Выгрузка расширений завершилась с ошибкой: ${result.stderr || result.stdout}`);
  }
  return { outDir, ok: result.code === 0 };
}

/**
 * Выгружает ОДНО расширение по имени.
 *
 * Нужно потому, что `export all-extensions` на реальной базе молча теряет
 * расширения: на ERP из четырёх выгрузились три, код возврата 1, ни строки
 * пояснения ни в stdout, ни в stderr. Поимённый экспорт того же расширения
 * отрабатывает штатно и полностью. Это тот же класс молчаливых отказов ibcmd,
 * что и с `--file=<vendor.cf>`, — чинить пакетную команду бесполезно,
 * её нужно достраивать поимённой.
 */
export async function exportExtension({ platform, conn, name, outDir, user, password, onProgress }) {
  await ensureDir(outDir);
  const args = [
    'infobase', 'config', 'export',
    ...targetArgs(conn, { user, password }),
    `--extension=${name}`,
    outDir,
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.configExport,
    allowNonZeroExit: true,
    onStdout: onProgress,
  });
  if (result.code !== 0) {
    log.warn(`Расширение «${name}» не выгружено: ${result.stderr || result.stdout}`);
  }
  return { outDir, ok: result.code === 0 };
}

/**
 * Сохраняет ConfigDumpInfo — карту версий (хешей) объектов конфигурации.
 * Используется для сравнения с эталонной типовой конфигурацией.
 */
export async function exportConfigDumpInfo({ platform, conn, outFile, user, password }) {
  await ensureDir(path.dirname(outFile));
  const args = [
    'infobase', 'config', 'export', 'info',
    `--out=${outFile}`,
    ...targetArgs(conn, { user, password }),
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.quick,
    allowNonZeroExit: true,
  });
  return { ok: result.code === 0, outFile };
}

/** Идентификатор поколения конфигурации — меняется при любой правке. */
export async function generationId({ platform, conn, user, password }) {
  const args = [
    'infobase', 'config', 'generation-id',
    ...targetArgs(conn, { user, password }),
  ];
  const result = await run(platform.ibcmd, args, {
    timeout: TIMEOUTS.quick,
    allowNonZeroExit: true,
  });
  if (result.code !== 0) return null;
  const line = result.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || null;
}

/**
 * Собирает внешнюю обработку из XML-исходников.
 * Проверено: команда не изменяет конфигурацию базы — результат пишется в --out.
 */
export async function buildExternalDataProcessor({ platform, conn, srcDir, outFile, user, password }) {
  await ensureDir(path.dirname(outFile));
  const args = [
    'infobase', 'config', 'import',
    `--out=${outFile}`,
    ...targetArgs(conn, { user, password }),
    srcDir,
  ];
  await run(platform.ibcmd, args, { timeout: TIMEOUTS.quick });
  return outFile;
}

function parseKeyValueOutput(stdout) {
  const out = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m && !/^\[(INFO|WARN|ERROR)]/i.test(m[1])) out[m[1].trim()] = m[2].trim();
  }
  return out;
}
