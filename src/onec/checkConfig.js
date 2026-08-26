/**
 * Проверки конфигурации средствами платформы: проверка модулей, применимость
 * расширений, обновление конфигурации базы данных.
 *
 * Выполняются только после загрузки объединённой выгрузки в базу и только
 * по подтверждению пользователя: всё здесь работает с живой базой.
 *
 * **Проверка модулей — это `/CheckModules`, а не `/CheckConfig`.** Первое —
 * «Конфигурация → Проверка модулей» в конфигураторе: компилируется ли код.
 * Второе — «Проверить конфигурацию»: полный аудит с десятком настроек.
 * После обновления нужен первый вопрос.
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
 * Итоговые строки конфигуратора, которые сами по себе замечаниями не являются.
 *
 * «Ошибок не обнаружено» содержит слово «ошибок» и без этой оговорки попадало
 * бы в перечень замечаний — то есть успешная проверка выглядела бы проваленной.
 * Поймано на живом стенде.
 */
const NOT_A_FINDING = /^(ошибок не обнаружено|ошибки не обнаружены|синтаксических ошибок не обнаружено|no errors|ошибокs*[:=]s*0)/i;

/**
 * Признак того, что конфигуратор не понял командную строку.
 *
 * Проверено на 8.5.1.1150: **несуществующий ключ платформа просто игнорирует**
 * (код 0, журнал «Ошибок не обнаружено»). Оставлено для команд, которых
 * в старых сборках нет вовсе, — молча пропустить проверку хуже, чем сказать
 * об этом вслух.
 */
const BAD_ARGS = /неверн[а-яё]* парамет|неизвестн[а-яё]* парамет|unknowns+(option|parameter)|invalids+(option|parameter)/i;

/**
 * Контексты исполнения — только для РАСШИРЕННОЙ проверки.
 *
 * Замеры на демо-базе УНФ 3.0.13.374, платформа 8.5.1.1150:
 *
 *   /CheckModules без ключей ................................. 5 с
 *   /CheckModules -AllExtensions ............................. 6 с
 *   /CheckModules + шесть контекстов ....................... 473 с
 *   /CheckModules + контексты + -ExtendedModulesCheck ...... 287 с
 *   /CheckConfig (для сравнения) ............................ 53 с
 *
 * Находят они при этом разное: без ключей платформа отвечает
 * «Синтаксических ошибок не обнаружено!», с контекстами показывает код,
 * который не соберётся в конкретном контексте («Переменная не определена
 * (…Клиент)»). Дорогое — контексты, а не разбор типов.
 */
const MODULE_CONTEXTS = [
  '-ThinClient',
  '-WebClient',
  '-Server',
  '-ExternalConnection',
  '-ThickClientManagedApplication',
  '-ThickClientOrdinaryApplication',
];

/**
 * Ключи команды. Вынесены отдельно ради теста: цена ошибки здесь — минуты
 * ожидания на каждом прогоне, а увидеть её можно только на живой базе.
 */
export function checkModulesOptions({ scope = 'main', extended = false } = {}) {
  return [
    ...(extended ? [...MODULE_CONTEXTS, '-ExtendedModulesCheck'] : []),
    ...(scope === 'extensions' ? ['-AllExtensions'] : []),
  ];
}

/**
 * Проверка модулей — то же, что «Конфигурация → Проверка модулей»
 * в конфигураторе.
 *
 * **Это НЕ `/CheckConfig`.** `/CheckConfig` — «Проверить конфигурацию»:
 * там и неразрешимые ссылки, и целостность, и логическая проверка, и настроек
 * у неё десяток. Пользователь просил именно проверку модулей (26.08.2026),
 * и он прав: после обновления важно, компилируется ли код, а не полный аудит
 * конфигурации.
 *
 * **Без ключей — и это не упрощение.** Пункт меню «Проверка модулей» настроек
 * не имеет и отрабатывает быстро; ровно так же ведёт себя `/CheckModules`
 * без единого ключа: 5 секунд на демо-базе УНФ. Контексты исполнения
 * и `-ExtendedModulesCheck` находят больше, но стоят минут и десятков минут —
 * прогон при этом выглядит зависшим, что пользователь и наблюдал 26.08.2026.
 * Поэтому они уехали под флаг «Расширенная проверка модулей», снятый
 * по умолчанию.
 *
 * @param {object} params
 * @param {'main'|'extensions'} [params.scope] конфигурация или все расширения
 * @param {boolean} [params.extended] контексты исполнения и разбор типов (долго)
 * @returns {Promise<{ok: boolean, options: string[], log: string, errors: object[]}>}
 */
export async function checkModules({
  platform, conn, user, password, workDir, scope = 'main', extended = false,
}) {
  const logPath = path.join(workDir, `check-${scope}.log`);
  const options = checkModulesOptions({ scope, extended });

  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...authArgs({ user, password }),
    '/CheckModules',
    ...options,
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
      ok: false, options, log: `Конфигуратор не выполнил проверку модулей: ${err.message}`, errors: [],
    };
  }

  const text = await readLogSafe(logPath);
  const errors = parseCheckLog(text);
  log.info(`Проверка модулей (${scope}): код ${result.code}, замечаний ${errors.length}`);
  return { ok: errors.length === 0, options, log: text, errors };
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
