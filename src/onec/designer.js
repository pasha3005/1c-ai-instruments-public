/**
 * Драйвер конфигуратора (1cv8.exe DESIGNER).
 *
 * Используется для серверных баз, где ibcmd неприменим (он ходит в СУБД напрямую,
 * а не через кластер), и как резервный путь для файловых баз на старых платформах.
 *
 * Особенности, которые приходится учитывать:
 *   • конфигуратор не пишет диагностику в stderr — только в файл, заданный /Out;
 *   • при ошибке аутентификации/блокировке он может показать модальное окно,
 *     поэтому обязательны /DisableStartupDialogs и /DisableStartupMessages;
 *   • код возврата 0 не гарантирует успех — результат проверяется по наличию
 *     ожидаемых файлов и содержимому лога.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { run, ProcessError } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { ensureDir, pathExists, readText } from '../util/fsx.js';
import { toClientArgs } from './connection.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('designer');

function authArgs({ user, password }) {
  const args = [];
  if (user) args.push(`/N${user}`);
  if (password) args.push(`/P${password}`);
  return args;
}

const COMMON_FLAGS = ['/DisableStartupDialogs', '/DisableStartupMessages'];

/**
 * Выгружает конфигурацию в XML-файлы.
 *
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {import('./connection.js').Connection} params.conn
 * @param {string} params.outDir
 * @param {string} [params.extension] имя расширения; без него — основная конфигурация
 * @param {boolean} [params.allExtensions] выгрузить все расширения
 */
export async function dumpConfigToFiles({
  platform, conn, outDir, extension, allExtensions, user, password, logFile,
}) {
  await ensureDir(outDir);
  const logPath = logFile || path.join(path.dirname(outDir), `designer-${Date.now()}.log`);

  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/DumpConfigToFiles', outDir,
    '-Format', 'Hierarchical',
  ];
  if (extension) args.push('-Extension', extension);
  if (allExtensions) args.push('-AllExtensions');
  args.push(...COMMON_FLAGS, '/Out', logPath);

  log.info(`Выгрузка конфигурации конфигуратором в ${outDir}`, { extension, allExtensions });

  let procResult;
  try {
    procResult = await run(platform.client, args, {
      timeout: TIMEOUTS.configExport,
      allowNonZeroExit: true,
    });
  } catch (err) {
    rethrowIfCancelled(err);
    const designerLog = await readLogSafe(logPath);
    throw new ProcessError(
      `Конфигуратор не смог выгрузить конфигурацию: ${err.message}${designerLog ? `\n${designerLog}` : ''}`,
      { code: err.code, stdout: err.stdout, stderr: err.stderr, command: platform.client },
    );
  }

  const designerLog = await readLogSafe(logPath);
  const produced = await pathExists(path.join(outDir, 'Configuration.xml'));

  if (!produced) {
    throw new Error(
      'Конфигуратор завершился, но файл Configuration.xml не создан. ' +
      (designerLog ? `Журнал конфигуратора:\n${designerLog}` : `Код возврата: ${procResult.code}.`) +
      '\nВероятные причины: неверные имя пользователя/пароль, база занята другим сеансом ' +
      'или у пользователя нет права «Администрирование».',
    );
  }
  if (designerLog && /ошибк|error/i.test(designerLog)) {
    log.warn(`Конфигуратор сообщил о проблемах: ${designerLog.slice(0, 500)}`);
  }
  return { outDir, log: designerLog };
}

/**
 * Загружает конфигурацию ИЗ XML-файлов в основную конфигурацию базы.
 *
 * Операция, которая пишет в базу, и потому устроена отдельно от всего
 * остального:
 *
 * • загружается **основная конфигурация** либо, если указано имя, одно
 *   расширение. Конфигурация базы данных этой командой не обновляется —
 *   это отдельный шаг (`checkConfig.js`, `/UpdateDBCfg`) и отдельное решение;
 * • нужен монопольный доступ: при работающих сеансах конфигуратор откажет,
 *   и его отказ передаётся пользователю дословно — гадать ему не о чем;
 * • ibcmd здесь не используется, хотя для файловых баз он быстрее:
 *   `/LoadConfigFromFiles` одинаково работает и с файловой, и с серверной
 *   базой, а два разных пути загрузки означали бы два разных набора граблей
 *   в самой опасной операции.
 */
export async function loadConfigFromFiles({
  platform, conn, srcDir, user, password, logFile, extension = '',
}) {
  if (!(await pathExists(path.join(srcDir, 'Configuration.xml')))) {
    throw new Error(`В каталоге ${srcDir} нет Configuration.xml — загружать нечего`);
  }
  const logPath = logFile || path.join(path.dirname(srcDir), `designer-load-${Date.now()}.log`);

  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/LoadConfigFromFiles', srcDir,
    ...(extension ? ['-Extension', extension] : []),
    ...COMMON_FLAGS,
    '/Out', logPath,
  ];

  log.info(`Загрузка конфигурации из ${srcDir}`, { extension });
  let procResult;
  try {
    procResult = await run(platform.client, args, {
      timeout: TIMEOUTS.configExport,
      allowNonZeroExit: true,
    });
  } catch (err) {
    rethrowIfCancelled(err);
    const designerLog = await readLogSafe(logPath);
    throw new ProcessError(
      `Конфигуратор не смог загрузить конфигурацию: ${err.message}${designerLog ? `\n${designerLog}` : ''}`,
      { code: err.code, stdout: err.stdout, stderr: err.stderr, command: platform.client },
    );
  }

  const designerLog = await readLogSafe(logPath);
  if (procResult.code !== 0 || /ошибк|error/i.test(designerLog)) {
    throw new Error(
      'Загрузка конфигурации не удалась.'
      + (designerLog ? ` Журнал конфигуратора:\n${designerLog}` : ` Код возврата: ${procResult.code}.`)
      + '\nЧастые причины: база занята другими сеансами (нужен монопольный доступ), '
      + 'неверные имя пользователя или пароль, нет права «Администрирование».',
    );
  }
  return { log: designerLog };
}

/**
 * Собирает .epf из XML-исходников (используется для служебной обработки сбора данных).
 * Доступно с 8.3.9.
 */
export async function loadExternalDataProcessorFromFiles({
  platform, conn, srcXml, outFile, user, password,
}) {
  await ensureDir(path.dirname(outFile));
  const logPath = `${outFile}.log`;
  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/LoadExternalDataProcessorOrReportFromFiles', srcXml, outFile,
    ...COMMON_FLAGS,
    '/Out', logPath,
  ];
  await run(platform.client, args, { timeout: TIMEOUTS.quick, allowNonZeroExit: true });
  if (!(await pathExists(outFile))) {
    const designerLog = await readLogSafe(logPath);
    throw new Error(`Не удалось собрать внешнюю обработку. ${designerLog || ''}`);
  }
  return outFile;
}

/**
 * Проверяет доступность базы: запускает конфигуратор с заведомо безобидной
 * операцией выгрузки списка расширений в временный каталог.
 * Возвращает текст ошибки или null, если доступ есть.
 */
export async function checkAccess({ platform, conn, user, password, workDir }) {
  const probeDir = path.join(workDir, 'probe');
  await ensureDir(probeDir);
  const logPath = path.join(workDir, 'probe.log');
  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/DumpConfigToFiles', probeDir,
    '-Extension', '__ЗаведомоНесуществующее__',
    ...COMMON_FLAGS,
    '/Out', logPath,
  ];
  const result = await run(platform.client, args, {
    timeout: TIMEOUTS.quick,
    allowNonZeroExit: true,
  });
  const designerLog = await readLogSafe(logPath);
  // Ошибка «расширение не найдено» означает, что подключение и аутентификация прошли.
  if (/не найден|not found/i.test(designerLog)) return null;
  if (/пароль|password|аутентификац|authentic/i.test(designerLog)) {
    return `Ошибка аутентификации: ${designerLog.slice(0, 300)}`;
  }
  if (result.code !== 0 && designerLog) return designerLog.slice(0, 300);
  return null;
}

async function readLogSafe(logPath) {
  try {
    if (!(await pathExists(logPath))) return '';
    const text = (await readText(logPath)).trim();
    await fs.rm(logPath, { force: true }).catch(() => {});
    return text;
  } catch {
    return '';
  }
}
