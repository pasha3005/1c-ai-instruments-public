/**
 * Типовое обновление конфигурации силами самой платформы — `/UpdateCfg`.
 *
 * Зачем это здесь, когда рядом лежит собственное трёхстороннее объединение.
 * Потому что объединение нужно **только там, где есть доработки**. Если
 * конфигурация стоит на поддержке «на замке» — возможность изменения
 * не включалась, своих правок нет, — то обновление на новый релиз не содержит
 * ни одного решения, которое стоило бы принимать: всё берётся из поставки.
 * Ровно это и делает конфигуратор командой «Обновить конфигурацию», и делает
 * лучше нас: своей же конфигурацией поставщика, своими правилами поддержки,
 * без выгрузки в XML и обратной загрузки.
 *
 * Требование пользователя дословно (11.08.2026): «если ты видишь, что
 * конфигурация "на замке", то есть, на поддержке, значит, используй типовой
 * метод обновления, и сравнение тебе не нужно вообще. Но если включена
 * возможность изменения, и ты видишь доработки — тут уже подключай свой
 * инструмент по автоматическому обновлению».
 *
 * Проверено на копии демо-базы УНФ 3.0.13.374 (2,5 ГБ) файлом поставки
 * 3.0.14.115 (1,1 ГБ): код 0, журнал «Обновление конфигурации успешно
 * завершено», **56 секунд**. Своим конвейером то же самое обошлось бы
 * в выгрузку XML (~4 мин), разворачивание новой поставки во временную базу
 * (~10 мин) и объединение десятков тысяч файлов — ради результата, который
 * заведомо равен «взять поставку целиком».
 *
 * **Список дважды изменённых свойств платформа умеет отдавать сама** —
 * ключ `-DumpListOfTwiceChangedProperties <файл>` (найден в строках самой
 * платформы 8.5.1.1150 вместе с остальными параметрами `/UpdateCfg`).
 * На базе без доработок файл не создаётся вовсе — проверено. Если он всё же
 * появился, это важный сигнал: доработки есть, и такую базу надо вести своим
 * объединением, а не типовым обновлением.
 *
 * **`-force` не передаётся намеренно.** Он велит продолжать, несмотря на
 * предупреждения; на обновлении рабочей базы громкий отказ полезнее тихого
 * «продолжил как смог».
 */

import path from 'node:path';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { pathExists, readText } from '../util/fsx.js';
import { toClientArgs } from './connection.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('update-cfg');

/** Так платформа сообщает об удаче. Код возврата 0 сам по себе не доказательство. */
const SUCCESS = /обновление конфигурации успешно завершено|configuration update completed/i;

/**
 * Обновляет основную конфигурацию базы из файла поставки.
 *
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {import('./connection.js').Connection} params.conn
 * @param {string} params.cfFile файл новой поставки (.cf или .cfu)
 * @param {string} params.workDir куда писать журналы
 * @param {string} [params.user]
 * @param {string} [params.password]
 * @param {(text: string) => void} [params.onProgress]
 * @returns {Promise<{ok: boolean, log: string, twiceChanged: string[], reason?: string}>}
 */
export async function updateCfgFromFile({
  platform, conn, cfFile, workDir, user, password, onProgress,
}) {
  if (!platform.client) {
    return { ok: false, log: '', twiceChanged: [], reason: `в платформе ${platform.version} не найден 1cv8.exe` };
  }

  const logFile = path.join(workDir, 'designer-update-cfg.log');
  const twiceFile = path.join(workDir, 'дважды-изменённые.txt');

  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...(user ? [`/N${user}`] : []),
    ...(password ? [`/P${password}`] : []),
    '/UpdateCfg', cfFile,
    '-DumpListOfTwiceChangedProperties', twiceFile,
    '/DisableStartupDialogs',
    '/DisableStartupMessages',
    '/Out', logFile,
  ];

  onProgress?.('Платформа обновляет конфигурацию из файла поставки');
  log.info(`Типовое обновление конфигурации из ${path.basename(cfFile)}`);

  let code = -1;
  try {
    ({ code } = await run(platform.client, args, {
      timeout: TIMEOUTS.configExport,
      allowNonZeroExit: true,
    }));
  } catch (err) {
    rethrowIfCancelled(err);
    return { ok: false, log: '', twiceChanged: [], reason: err.message };
  }

  const text = (await readSafe(logFile)).trim();
  const twiceChanged = await readTwiceChanged(twiceFile);

  if (SUCCESS.test(text)) {
    log.info(`Конфигурация обновлена платформой${twiceChanged.length ? `, дважды изменённых свойств ${twiceChanged.length}` : ''}`);
    return { ok: true, log: text, twiceChanged, twiceChangedFile: twiceChanged.length ? twiceFile : '' };
  }

  return {
    ok: false,
    log: text,
    twiceChanged,
    reason: text
      ? `платформа не подтвердила обновление: ${text.slice(0, 400)}`
      : `платформа не сообщила ничего, код возврата ${code}`,
  };
}

/**
 * Разбирает файл дважды изменённых свойств.
 *
 * Формат — простой перечень строк; пустые и служебные заголовки отбрасываем.
 * Содержимое важно само по себе: одно наличие таких строк означает, что база
 * не «на замке», и типовой путь для неё не годится.
 */
async function readTwiceChanged(file) {
  const text = await readSafe(file);
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^-+$/.test(line))
    .slice(0, 2000);
}

async function readSafe(file) {
  try {
    if (!(await pathExists(file))) return '';
    return await readText(file);
  } catch {
    return '';
  }
}
