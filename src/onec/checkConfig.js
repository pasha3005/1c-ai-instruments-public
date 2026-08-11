/**
 * Проверки конфигурации средствами платформы: синтаксический контроль,
 * применимость расширений, обновление конфигурации базы данных.
 *
 * Выполняются только после загрузки объединённой выгрузки в базу и только
 * по подтверждению пользователя: всё здесь работает с живой базой.
 *
 * **Набор ключей у `/CheckConfig` разный в разных версиях платформы.**
 * Поэтому команда не составляется «как в документации» раз и навсегда:
 * сначала пробуется полный набор, и если конфигуратор ругается на параметры,
 * набор сокращается до заведомо старого. Это дешевле, чем гадать, с какой
 * сборки появился очередной ключ, и не ломается на машине заказчика.
 *
 * **Код возврата 0 ничего не значит** — как и везде у конфигуратора. Итог
 * читается из журнала `/Out`.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { pathExists, readText } from '../util/fsx.js';
import { toClientArgs } from './connection.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('check');

const COMMON_FLAGS = ['/DisableStartupDialogs', '/DisableStartupMessages'];

function authArgs({ user, password }) {
  const args = [];
  if (user) args.push(`/N${user}`);
  if (password) args.push(`/P${password}`);
  return args;
}

/**
 * Полный набор проверок. Первым идёт синтаксический контроль всех контекстов
 * исполнения — ради него всё и затевается: обновление могло принести код,
 * который не компилируется в связке с доработкой.
 */
const CHECK_OPTIONS_FULL = [
  '-ConfigLogIntegrity',
  '-IncorrectReferences',
  '-ThinClient',
  '-WebClient',
  '-Server',
  '-ExternalConnection',
  '-ExtendedModulesCheck',
];

/** То, что понимает любая 8.3: на случай отказа по неизвестному параметру. */
const CHECK_OPTIONS_MIN = ['-ConfigLogIntegrity', '-IncorrectReferences'];

/**
 * Признак того, что конфигуратор не понял командную строку.
 *
 * Проверено на 8.5.1.1150: **несуществующий ключ платформа просто игнорирует**
 * (код 0, журнал «Ошибок не обнаружено»), поэтому сокращённый набор в реальности
 * почти никогда не понадобится. Оставлен на случай сборок, которые ругаются:
 * молча пропустить проверку хуже, чем повторить её урезанной.
 */
const BAD_ARGS = /неверн[а-яё]* парамет|неизвестн[а-яё]* парамет|unknown\s+(option|parameter)|invalid\s+(option|parameter)/i;

/**
 * Итоговые строки конфигуратора, которые сами по себе замечаниями не являются.
 *
 * «Ошибок не обнаружено» содержит слово «ошибок» и без этой оговорки попадало
 * бы в перечень замечаний — то есть успешная проверка выглядела бы проваленной.
 * Поймано на живом стенде.
 */
const NOT_A_FINDING = /^(ошибок не обнаружено|ошибки не обнаружены|no errors|ошибок\s*[:=]\s*0)/i;

/**
 * Синтаксический контроль конфигурации и расширений.
 *
 * @param {object} params
 * @param {'main'|'extensions'} [params.scope] что проверять
 * @returns {Promise<{ok: boolean, options: string[], log: string, errors: object[]}>}
 */
export async function checkConfig({
  platform, conn, user, password, workDir, scope = 'main',
}) {
  const logPath = path.join(workDir, `check-${scope}.log`);

  for (const options of [CHECK_OPTIONS_FULL, CHECK_OPTIONS_MIN]) {
    const args = [
      'DESIGNER',
      ...toClientArgs(conn),
      ...authArgs({ user, password }),
      '/CheckConfig',
      ...options,
      ...(scope === 'extensions' ? ['-AllExtensions'] : []),
      ...COMMON_FLAGS,
      '/Out', logPath,
    ];

    let result;
    try {
      result = await run(platform.client, args, {
        timeout: TIMEOUTS.configExport,
        allowNonZeroExit: true,
      });
    } catch (err) {
      rethrowIfCancelled(err);
      return {
        ok: false, options, log: `Конфигуратор не выполнил проверку: ${err.message}`, errors: [],
      };
    }

    const text = await readLogSafe(logPath);
    if (BAD_ARGS.test(text) && options !== CHECK_OPTIONS_MIN) {
      log.warn('Конфигуратор не принял расширенный набор проверок, повторяем сокращённым');
      continue;
    }

    const errors = parseCheckLog(text);
    log.info(`Проверка (${scope}): код ${result.code}, замечаний ${errors.length}`);
    return { ok: errors.length === 0, options, log: text, errors };
  }

  return { ok: false, options: [], log: '', errors: [] };
}

/**
 * Проверка возможности применения расширений.
 *
 * Отдельная команда платформы, а не часть `/CheckConfig`: она отвечает
 * на другой вопрос — не «компилируется ли», а «сможет ли платформа наложить
 * расширение на конфигурацию, которая теперь другая». Именно она падает после
 * обновления, когда вендор переписал процедуру, заимствованную расширением.
 *
 * Команда появилась не во всех сборках; отсутствие её не считается ошибкой
 * прогона — просто проверка помечается невыполненной.
 */
export async function checkExtensionsApplicable({
  platform, conn, user, password, workDir,
}) {
  const logPath = path.join(workDir, 'check-extensions.log');
  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/CheckCanApplyConfigurationExtensions',
    ...COMMON_FLAGS,
    '/Out', logPath,
  ];

  let result;
  try {
    result = await run(platform.client, args, {
      timeout: TIMEOUTS.configExport,
      allowNonZeroExit: true,
    });
  } catch (err) {
    rethrowIfCancelled(err);
    return { available: false, ok: false, log: err.message, errors: [] };
  }

  const text = await readLogSafe(logPath);
  if (BAD_ARGS.test(text)) {
    return {
      available: false,
      ok: false,
      log: text,
      errors: [],
      note: `Платформа ${platform.version} не умеет проверять применимость расширений `
        + 'в пакетном режиме. Выполните проверку в конфигураторе: '
        + 'Конфигурация → Расширения → Проверить возможность применения.',
    };
  }

  const errors = parseCheckLog(text);
  log.info(`Применимость расширений: код ${result.code}, замечаний ${errors.length}`);
  return { available: true, ok: errors.length === 0, log: text, errors };
}

/**
 * Обновление конфигурации базы данных.
 *
 * Реструктуризация таблиц. Раньше продукт её не делал вовсе, и это было
 * записано отдельным правилом; 11.08.2026 пользователь развернул своё решение:
 * загрузка и обновление базы данных выполняются подряд, по одному
 * подтверждению прямо в ходе прогона.
 *
 * `-Dynamic-` намеренно: динамическое обновление не применяет изменения,
 * требующие реструктуризации, и молча оставило бы конфигурацию базы данных
 * отличной от основной — то есть обновление выглядело бы выполненным, не будучи
 * им. Ради этого и нужен монопольный доступ.
 */
export async function updateDbConfig({
  platform, conn, user, password, workDir,
}) {
  const logPath = path.join(workDir, 'update-db.log');
  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/UpdateDBCfg', '-Dynamic-',
    ...COMMON_FLAGS,
    '/Out', logPath,
  ];

  let result;
  try {
    result = await run(platform.client, args, {
      timeout: TIMEOUTS.configExport,
      allowNonZeroExit: true,
    });
  } catch (err) {
    rethrowIfCancelled(err);
    throw new Error(`Конфигуратор не смог обновить конфигурацию базы данных: ${err.message}`);
  }

  const text = await readLogSafe(logPath);
  if (result.code !== 0 || /ошибк|error/i.test(text)) {
    throw new Error(
      'Обновление конфигурации базы данных не выполнено.'
      + (text ? ` Журнал конфигуратора:\n${text.slice(0, 2000)}` : ` Код возврата: ${result.code}.`)
      + '\nЧастые причины: база занята сеансами (нужен монопольный доступ) '
      + 'или платформа требует подтверждения потери данных при реструктуризации.',
    );
  }
  return { log: text };
}

/**
 * Разбор журнала проверки.
 *
 * Конфигуратор пишет по строке на замечание, вида
 *   «Расширение1: ОбщийМодуль.РаботаСФайлами.Модуль(12,4): Процедура не найдена»
 * Формат от версии к версии слегка плавает, поэтому разбор мягкий: главное —
 * выделить строки-замечания и вытащить из них расширение, объект и текст.
 * Всё, что распознать не удалось, попадает в результат как есть: молча терять
 * строку журнала об ошибке нельзя.
 */
export function parseCheckLog(text) {
  const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (NOT_A_FINDING.test(line)) continue;
    if (!/ошибк|error|не найден|невозможно|нельзя|отсутствует|failed/i.test(line)) continue;

    errors.push({
      text: line,
      extension: extensionOf(line),
      method: methodOf(line),
      annotation: annotationOf(line),
    });
    if (errors.length >= 500) break;
  }
  return errors;
}

/**
 * «Расширение «ДРБ_Доработки»: …» либо «Расширение1: …».
 *
 * Окончания слов перечислены явным кириллическим классом: `\w` в JavaScript —
 * это только латиница с цифрами, и «Расширение» через `расширени\w*` не ловится.
 */
function extensionOf(line) {
  const quoted = /расширени[а-яё]*\s*«([^»]+)»/i.exec(line);
  if (quoted) return quoted[1];
  const plain = /^([A-Za-zА-Яа-яЁё0-9_]+)\s*:/.exec(line);
  return plain ? plain[1] : '';
}

/** Имя процедуры или функции, о которой речь. */
function methodOf(line) {
  const m = /(?:процедур[а-яё]*|функци[а-яё]*|метод[а-яё]*)\s+[«"]?([A-Za-zА-Яа-яЁё0-9_.]+)[»"]?/i.exec(line);
  return m ? m[1] : '';
}

/** Какая аннотация расширения не применилась. */
function annotationOf(line) {
  const m = /&(Вместо|Вокруг|После|Перед|ИзменениеИКонтроль)/i.exec(line);
  return m ? m[1] : '';
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
