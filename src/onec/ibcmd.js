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
