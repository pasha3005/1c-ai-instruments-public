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
 * Загружает конфигурацию из файла `.cf` (или расширение из `.cfe`).
 *
 * Нужно там, где исходников в XML нет, а есть двоичная поставка: так забирается
 * конфигурация расширения, выгруженная из хранилища расширений. Для основной
 * конфигурации быстрее ibcmd (`infobase create --load=`), но расширение он так
 * не принимает — у расширения обязательно имя, и оно живёт внутри базы.
 */
export async function loadCfg({
  platform, conn, cfFile, extension = '', user, password, logFile,
}) {
  const logPath = logFile || path.join(path.dirname(cfFile), `designer-loadcfg-${Date.now()}.log`);
  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/LoadCfg', cfFile,
    ...(extension ? ['-Extension', extension] : []),
    ...COMMON_FLAGS,
    '/Out', logPath,
  ];

  log.info(`Загрузка конфигурации из файла ${cfFile}`, { extension });
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
      `Конфигуратор не смог загрузить ${path.basename(cfFile)}: ${err.message}`
      + (designerLog ? `\n${designerLog}` : ''),
      { code: err.code, stdout: err.stdout, stderr: err.stderr, command: platform.client },
    );
  }

  const designerLog = await readLogSafe(logPath);
  if (procResult.code !== 0 || /ошибк|error/i.test(designerLog)) {
    throw new Error(
      `Загрузка ${path.basename(cfFile)} не удалась.`
      + (designerLog ? ` Журнал конфигуратора:\n${designerLog}` : ` Код возврата: ${procResult.code}.`),
    );
  }
  return { log: designerLog };
}

/**
 * Создаёт пустую файловую базу клиентом платформы, без ibcmd.
 *
 * Зачем понадобилось (13.08.2026, сервер заказчика, платформа 8.3.27.1688).
 * **`ibcmd.exe` входит в СЕРВЕРНУЮ часть платформы, а не в клиентскую.**
 * На терминальном сервере, где люди только работают в 1С, ставят один клиент —
 * рядом с `1cv8.exe` лежат `1cv8c.exe` и `dumper.exe`, а `ibcmd.exe`, `ragent.exe`
 * и `rphost.exe` отсутствуют. Программа объявляла это старой платформой
 * и советовала «выберите 8.3.14 или новее», хотя стояла 8.3.27: версия была
 * ни при чём, и совет вёл в тупик.
 *
 * `CREATEINFOBASE` — режим самого `1cv8.exe`, он есть в любой установке.
 * Проверено на 8.3.22, 8.3.24, 8.3.27 и 8.5.1: код 0, 8 с, база создаётся.
 *
 * **Путь берётся в ОДИНАРНЫЕ кавычки** — и это не вкусовщина. Node, запуская
 * процесс, сам заключает аргумент с пробелом в двойные кавычки, а внутренние
 * двойные экранирует обратной косой чертой; разбор платформы такого не понимает
 * и отвечает «Неверные или отсутствующие параметры соединения с информационной
 * базой». Перебраны все четыре формы (`File="…";`, `File="…"`, `File=…;`,
 * `File=…`) на каталоге с пробелами — не прошла ни одна. Одинарные кавычки
 * Node не трогает, и платформа принимает их как ограничитель значения.
 */
export async function createInfobase({ platform, dir, logFile }) {
  const connectionString = fileConnectionString(dir);
  await ensureDir(dir);
  const logPath = logFile || path.join(path.dirname(dir), `createinfobase-${Date.now()}.log`);

  const result = await run(platform.client, [
    'CREATEINFOBASE', connectionString,
    ...COMMON_FLAGS,
    '/Out', logPath,
  ], { timeout: TIMEOUTS.configExport, allowNonZeroExit: true });

  const designerLog = await readLogSafe(logPath);
  // Проверяем не код возврата, а файл базы: код 0 у платформы не гарантирует
  // ничего, и здесь это особенно важно — на пустом каталоге всё «получится».
  if (!(await pathExists(path.join(dir, '1Cv8.1CD')))) {
    throw new Error(
      `Не удалось создать временную базу в ${dir}.`
      + (designerLog ? ` Журнал платформы:\n${designerLog}` : ` Код возврата: ${result.code}.`),
    );
  }
  log.info(`Создана пустая файловая база: ${dir}`);
  return { dir, log: designerLog };
}

/**
 * Строка соединения для `CREATEINFOBASE`.
 *
 * Отдельной функцией ради одной строчки, потому что эта строчка уже стоила
 * разбора: кавычки здесь ОДИНАРНЫЕ. Двойные Node экранирует обратной косой
 * чертой, когда сам заключает аргумент с пробелом в кавычки, и платформа
 * отвечает «Неверные или отсутствующие параметры соединения с информационной
 * базой». Проверены все четыре формы с двойными кавычками и без — на каталоге
 * с пробелом не прошла ни одна.
 */
export function fileConnectionString(dir) {
  if (String(dir).includes("'")) {
    // Ограничитель значения внутри значения строку соединения и оборвёт.
    throw new Error(
      `В пути ${dir} есть апостроф — платформа не примет такую строку соединения. `
      + 'Выберите рабочий каталог без апострофа в имени.',
    );
  }
  return `File='${dir}';`;
}

/**
 * Заводит в базе пустое расширение — тоже без ibcmd.
 *
 * Обходной путь, и он выглядит странно, поэтому объясняю целиком.
 * Отдельной команды «создать расширение» у конфигуратора нет — она есть только
 * у `ibcmd` (`infobase config extension create`), которого на клиентской
 * установке не бывает. Зато `/LoadConfigFromFiles … -Extension <имя>`
 * расширение с таким именем **создаёт сам**, прежде чем разбирать исходники.
 * Значит, каталог-источник может быть и пустым: загрузка развалится
 * («Файл объекта не существует … Configuration.xml»), а расширение останется.
 *
 * Проверено 13.08.2026 на четырёх сборках — 8.3.22.1923, 8.3.24.1691,
 * 8.3.27.1989 и 8.5.1.1150: везде код 1 и везде расширение в базе есть.
 *
 * Опираться на побочный итог неудачной команды всё же нельзя, поэтому итог
 * ПРОВЕРЯЕТСЯ: расширение выгружается обратно (`/DumpConfigToFiles -Extension`).
 * Прошло с кодом 0 и тремя файлами — расширение настоящее и пригодно
 * как контекст для хранилища; режим совместимости платформа проставила сама
 * (`Version8_3_22`, `Version8_3_27`, `Version8_5_1` соответственно).
 * Перестанет платформа его создавать — проверка это увидит и скажет прямо,
 * вместо того чтобы уронить работу с хранилищем непонятной ошибкой.
 *
 * Готового пустого расширения в поставке нет намеренно: у выгрузки расширения
 * в `Configuration.xml` стоит версия формата (`version="2.20"` у 8.3.27),
 * и 8.3.22 такой файл не принимает — «Неизвестная версия формата 2.20».
 * Шаблон пришлось бы держать на каждую сборку платформы.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function createExtensionByDesigner({
  platform, conn, name, workDir, user, password,
}) {
  const emptyDir = path.join(workDir, 'ext-seed');
  const probeDir = path.join(workDir, 'ext-probe');
  await ensureDir(emptyDir);
  await fs.rm(probeDir, { recursive: true, force: true });

  const probe = () => dumpConfigToFiles({
    platform, conn, outDir: probeDir, extension: name, user, password,
    logFile: path.join(workDir, `designer-extension-probe-${Date.now()}.log`),
  });

  // Расширение уже есть — трогать его нечем и незачем. Проверка тем же
  // способом, что и итоговая: списка расширений без ibcmd взять негде.
  try {
    await probe();
    return { ok: true };
  } catch (err) {
    rethrowIfCancelled(err);
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }

  const logPath = path.join(workDir, `designer-extension-${Date.now()}.log`);
  await run(platform.client, [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/LoadConfigFromFiles', emptyDir,
    '-Extension', name,
    ...COMMON_FLAGS,
    '/Out', logPath,
  ], { timeout: TIMEOUTS.configExport, allowNonZeroExit: true });

  try {
    await probe();
  } catch (err) {
    rethrowIfCancelled(err);
    const designerLog = await readLogSafe(logPath);
    return {
      ok: false,
      reason: `расширение «${name}» в базе-контексте не появилось`
        + (designerLog ? `: ${firstMeaningfulLine(designerLog)}` : ''),
    };
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }

  log.info(`В базе создано расширение «${name}» (конфигуратором, без ibcmd)`);
  return { ok: true };
}

function firstMeaningfulLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
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
