/**
 * Запуск 1С в режиме предприятия и отложенное обновление информационной базы.
 *
 * Последний шаг обновления, и делает он то, чего не умеет ни `/UpdateCfg`,
 * ни `/UpdateDBCfg`: **выполняет обработчики обновления**. Требование
 * пользователя (12.08.2026) дословно: «тебе нужно запустить после выполнения
 * обновления 1С в режиме предприятия и монопольные обработчики обновления
 * запустятся сами автоматически. Тебе нужно будет после этого, когда они
 * выполнятся, самому запустить фоновое задание для выполнения отложенных
 * обработчиков обновления, модификации в базу вносить никакие не нужно».
 *
 * Отсюда четыре части, и ни одна из них не меняет конфигурацию:
 *
 *  1. **Подтверждение легальности получения обновления — до запуска клиента.**
 *     БСП не начинает обработчики обновления, пока человек не подтвердит
 *     легальность в форме «Легальность получения обновлений». Программа
 *     подтверждает это сама — процедурой самой БСП, той же, что вызывает
 *     кнопка «Продолжить» на этой форме (`confirmUpdateLegality`).
 *  2. **Клиент запускается и остаётся работать.** Монопольные обработчики
 *     платформа выполняет сама при первом входе в базу после смены версии
 *     конфигурации. Ждать завершения процесса нельзя и не нужно: в этом окне
 *     потом работает человек.
 *  3. **Завершение монопольной части спрашиваем у БСП.** Прежний признак —
 *     «внешнее соединение встало, значит база освободилась» — оказался ЛОЖНЫМ:
 *     пока форма легальности ждёт ответа, база монопольно не занята, и
 *     соединение встаёт свободно. Измерено на живой базе (УНФ 3.0.14.115):
 *     соединение проходило на нулевой секунде, монополия начиналась на 41-й,
 *     а обновление заканчивалось на 67-й. Поэтому спрашиваем БСП её же
 *     функцией «необходимо ли обновление ИБ» (`waitUpdateApplied`).
 *  4. **Отложенные обработчики запускаются фоновым заданием** — тем самым
 *     методом, который стоит у регламентного задания отложенного обновления.
 *     Ждём, пока фоновое задание перестанет быть активным, и смотрим,
 *     осталось ли регламентное задание включённым: БСП гасит его, когда
 *     отложенных обработчиков больше нет. Это и есть ответ на вопрос
 *     «всё ли выполнилось».
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { runPowerShell } from '../util/proc.js';
import { comConnectorProgId } from './platform.js';
import { toClientArgs, toComConnectionString } from './connection.js';
import { ensureDir, readJson, writeJson, rmrf } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { throwIfCancelled, isCancelled } from '../util/cancel.js';
import { fileURLToPath } from 'node:url';

const log = createLogger('enterprise');

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'deferred-update.ps1');

const STATE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'update-state.ps1');

/**
 * Русские имена того, что скрипт-мост дёргает у COM-соединения.
 *
 * В самом `.ps1` кириллицы быть не может (Windows PowerShell 5.1 читает файл
 * без BOM в ANSI), поэтому имена приходят отсюда. Английские имена скрипт
 * пробует первыми и обычно ими и обходится; русские — страховка на случай
 * сборки, где англоязычные обращения не проходят.
 */
const RU_NAMES = {
  scheduledJobs: 'РегламентныеЗадания',
  getJobs: 'ПолучитьРегламентныеЗадания',
  count: 'Количество',
  get: 'Получить',
  metadata: 'Метаданные',
  name: 'Имя',
  methodName: 'ИмяМетода',
  use: 'Использование',
  backgroundJobs: 'ФоновыеЗадания',
  execute: 'Выполнить',
  uuid: 'УникальныйИдентификатор',
  findByUuid: 'НайтиПоУникальномуИдентификатору',
  state: 'Состояние',
  errorInfo: 'ИнформацияОбОшибке',
  description: 'Описание',
  end: 'Конец',
  stringFn: 'Строка',
  dataProcessors: 'Обработки',
  forms: 'Формы',
  fullName: 'ПолноеИмя',
  synonym: 'Синоним',
  version: 'Версия',
};

/**
 * Имена, которыми у БСП спрашивают состояние обновления информационной базы.
 *
 * Это имена НЕ платформы, а библиотеки, поэтому взяты они не из головы:
 * прочитаны в исходниках БСП конкретной базы (УНФ 3.0.14.115, выгрузка
 * конфигурации в XML) и проверены живым вызовом через внешнее соединение.
 * У всех трёх модулей стоит флаг «Внешнее соединение», иначе спросить было бы
 * нечем.
 *
 *  * `updateRequired` — «Проверить необходимость обновления информационной базы
 *    при смене версии конфигурации». Истина, пока обработчики обновления
 *    не выполнены; она и есть честный признак завершения монопольной части.
 *  * `legalityRequired` — Истина, когда БСП ждёт подтверждения легальности
 *    получения обновления. Внутри сравнивается «легальная версия», записанная
 *    в базе, с версией конфигурации.
 *  * `confirmLegality` — записывает подтверждение. Это ровно та процедура,
 *    которую вызывает кнопка «Продолжить» формы «Легальность получения
 *    обновлений», и БСП сама числит её среди методов, разрешённых к вызову
 *    как произвольный код.
 *
 * Английские имена перечислены только для модулей — их в БСП зовут именно так.
 * Английских имён функций здесь нет намеренно: угадывать их и выдавать догадку
 * за факт нельзя, а проверить не на чем. Не отозвался ни один вариант — так
 * и сообщаем: «спросить нечем».
 */
const BSP_NAMES = {
  updateModule: ['ОбновлениеИнформационнойБазы', 'InfobaseUpdate'],
  internalModule: ['ОбновлениеИнформационнойБазыСлужебный', 'InfobaseUpdateInternal'],
  updateRequired: ['НеобходимоОбновлениеИнформационнойБазы'],
  legalityRequired: ['ТребуетсяПроверитьЛегальностьПолученияОбновления'],
  confirmLegality: ['ЗаписатьПодтверждениеЛегальностиПолученияОбновлений'],
  deferredDone: ['ОтложенноеОбновлениеЗавершено'],
};

/**
 * Как узнать в метаданных форму результатов обновления.
 *
 * Имя формы не зашито: в базе его читает мост, и оттуда же берётся полное имя
 * для навигационной ссылки. В БСП это `Обработка.РезультатыОбновленияПрограммы`,
 * форма `РезультатыОбновленияПрограммы` — та самая, что открывается из
 * «Администрирование → Обслуживание → Результаты обновления и дополнительная
 * обработка данных». Ищем по образцу, потому что имя объекта у отраслевых
 * решений и у англоязычных метаданных отличается.
 */
const FORM_PATTERN = 'РезультатыОбновления|UpdateResult';

const WINDOW_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'window-titles.ps1');

/**
 * Как узнать регламентное задание отложенного обновления.
 *
 * Имя объекта метаданных в БСП — латиницей (`DeferredIBUpdate`), но у разных
 * версий и у отраслевых решений встречаются варианты, поэтому ищем по образцу,
 * а не по точному имени. Русские написания тоже учтены: в самописных
 * конфигурациях задание могло быть названо по-русски.
 */
const JOB_PATTERN = 'Deferred.*(IB|Infobase)?Update|DeferredUpdate|ОтложенноеОбновление';

/**
 * Запускает клиент 1С в режиме предприятия и НЕ ждёт его завершения.
 *
 * Процесс отвязывается намеренно: окно остаётся у пользователя, а конвейер
 * идёт дальше. Прервать прогон это не помешает — клиент нам не потомок.
 *
 * @returns {{pid: number|null}}
 */
export function launchEnterprise({ platform, conn, user, password, extraArgs = [] }) {
  if (!platform.client) {
    throw new Error(`В платформе ${platform.version} не найден 1cv8.exe — запустить предприятие нечем`);
  }

  const args = [
    'ENTERPRISE',
    ...toClientArgs(conn),
    ...(user ? [`/N${user}`] : []),
    ...(password ? [`/P${password}`] : []),
    ...extraArgs,
    '/DisableStartupDialogs',
    '/DisableStartupMessages',
  ];

  const child = spawn(platform.client, args, { detached: true, stdio: 'ignore' });
  child.unref();
  log.info(`1С запущена в режиме предприятия, pid ${child.pid || '?'}`);
  return { pid: child.pid || null };
}

/**
 * Состояние обновления информационной базы глазами самой БСП.
 *
 * Отдельным процессом PowerShell, тем же мостом, что и всё остальное COM:
 * соединение из Node напрямую невозможно.
 *
 * Отказ соединения — не ошибка, а ответ: пока платформа выполняет монопольные
 * обработчики, база занята монопольно и никого не пускает. Поэтому
 * `connected: false` возвращается со причиной, а не исключением.
 *
 * @returns {Promise<{connected: boolean, bspAvailable: boolean,
 *                    updateRequired: boolean|null, legalityRequired: boolean|null,
 *                    legalityConfirmed: boolean, deferredDone: boolean|null,
 *                    version: string, reason: string}>}
 */
export async function readUpdateState({
  platform, conn, user, password, workDir, confirmLegality = false,
}) {
  const dir = await ensureDir(path.join(workDir, 'handlers'));
  const inputFile = path.join(dir, 'state-input.json');
  const outputFile = path.join(dir, 'state-output.json');
  await rmrf(outputFile).catch(() => {});

  await writeJson(inputFile, {
    binDir: platform.binDir,
    progId: comConnectorProgId(platform.version),
    connectionString: toComConnectionString(conn, { user, password }),
    confirmLegality,
    bsp: BSP_NAMES,
    names: RU_NAMES,
  });

  const empty = {
    connected: false,
    bspAvailable: false,
    updateRequired: null,
    legalityRequired: null,
    legalityConfirmed: false,
    deferredDone: null,
    version: '',
  };

  try {
    await runPowerShell(STATE_SCRIPT, ['-InputFile', inputFile, '-OutputFile', outputFile], {
      timeout: 180_000,
      allowNonZeroExit: true,
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    return { ...empty, reason: err.message };
  }

  const output = await readJson(outputFile);
  if (!output) return { ...empty, reason: 'мост не вернул результат (см. журнал приложения)' };

  return {
    connected: output.connected === true,
    bspAvailable: output.bspAvailable === true,
    updateRequired: typeof output.updateRequired === 'boolean' ? output.updateRequired : null,
    legalityRequired: typeof output.legalityRequired === 'boolean' ? output.legalityRequired : null,
    legalityConfirmed: output.legalityConfirmed === true,
    deferredDone: typeof output.deferredDone === 'boolean' ? output.deferredDone : null,
    version: String(output.version || ''),
    reason: (output.errors || [])[0] || '',
  };
}

/**
 * Подтверждает легальность получения обновления — до запуска предприятия.
 *
 * Зачем это здесь. БСП не начинает обработчики обновления, пока человек
 * не подтвердит легальность получения обновления: при первом входе в базу она
 * открывает форму «Легальность получения обновлений» и ждёт галочки и кнопки
 * «Продолжить». На живом прогоне это и произошло — прогон встал, а программа
 * тем временем решила, что монопольные обработчики отработали.
 *
 * Подтверждение записывается процедурой самой БСП — той же, которую вызывает
 * кнопка «Продолжить» (см. `BSP_NAMES`), и успехом считается не отсутствие
 * ошибки, а то, что БСП на повторный вопрос отвечает «подтверждения больше
 * не требуется». Ничего кроме легальности мы не подтверждаем: согласие
 * на отправку статистики в центр мониторинга, которое та же форма предлагает
 * рядом, — отдельное решение пользователя, и его программа не трогает.
 *
 * @returns {Promise<{needed: boolean|null, confirmed: boolean,
 *                    bspAvailable: boolean, reason: string}>}
 */
export async function confirmUpdateLegality(ctx) {
  const state = await readUpdateState({ ...ctx, confirmLegality: true });

  if (!state.connected) {
    return {
      needed: null, confirmed: false, bspAvailable: false,
      reason: state.reason || 'база не пустила внешнее соединение',
    };
  }
  if (!state.bspAvailable) {
    return {
      needed: null, confirmed: false, bspAvailable: false,
      reason: state.reason || 'функции обновления ИБ через внешнее соединение недоступны',
    };
  }

  // Подтверждения не требовалось — значит и подтверждать нечего: либо оно уже
  // записано, либо конфигурация его не спрашивает.
  if (state.legalityRequired === false && !state.legalityConfirmed) {
    return { needed: false, confirmed: false, bspAvailable: true, reason: '' };
  }

  if (state.legalityConfirmed) {
    log.info('Легальность получения обновления подтверждена процедурой БСП');
    return { needed: true, confirmed: true, bspAvailable: true, reason: '' };
  }

  return {
    needed: state.legalityRequired,
    confirmed: false,
    bspAvailable: true,
    reason: state.reason || 'БСП всё равно требует подтверждения легальности',
  };
}

/**
 * Что означает прочитанное состояние базы.
 *
 * Вынесено отдельной функцией не для красоты: именно здесь прежняя версия
 * ошибалась, принимая «база пустила соединение» за «обработчики отработали».
 * Разбор случаев проверяется тестами.
 *
 *  * `exclusive` — база не пустила: идут монопольные обработчики. Единственное
 *    место, где отказ соединения — хорошая новость;
 *  * `applied` — БСП говорит, что обновление ИБ больше не требуется;
 *  * `legality` — БСП ждёт подтверждения легальности, обработчики не начаты;
 *  * `running` — обновление ещё требуется, значит обработчики идут;
 *  * `unknown` — спросить БСП нечем.
 *
 * @returns {{kind: 'exclusive'|'applied'|'legality'|'running'|'unknown'}}
 */
export function judgeUpdateState(state) {
  if (!state || state.connected !== true) return { kind: 'exclusive' };
  if (state.bspAvailable !== true) return { kind: 'unknown' };
  if (state.updateRequired === false) return { kind: 'applied' };
  if (state.updateRequired === true) {
    return { kind: state.legalityRequired === true ? 'legality' : 'running' };
  }
  return { kind: 'unknown' };
}

/**
 * Ждёт, пока обновление информационной базы действительно выполнится.
 *
 * Признак берётся у БСП: пока её функция «необходимо ли обновление ИБ»
 * отвечает Истина, монопольные обработчики не выполнены. Прежний признак —
 * «внешнее соединение встало, значит база освободилась» — был ЛОЖНЫМ, и это
 * измерено: на живой базе соединение проходило сразу, монополия начиналась
 * на 41-й секунде, обновление заканчивалось на 67-й. По ложному признаку
 * программа объявляла монопольную часть выполненной через 20 секунд, запускала
 * отложенное обновление и открывала форму вторым сеансом — а БСП этот второй
 * сеанс не пускала: «Вход в приложение временно невозможен».
 *
 * Отказ соединения по ходу ожидания — это нормальный этап, а не сбой: именно
 * так выглядит монопольная работа обработчиков.
 *
 * Если спросить БСП нечем (не БСП-конфигурация либо у модулей снят флаг
 * «Внешнее соединение»), остаётся прежний способ — ждать, пока база начнёт
 * пускать соединение, — и об этом говорится вслух: точности того признака мы
 * уже знаем цену.
 *
 * @returns {Promise<{ok: boolean, seconds: number, reason?: string,
 *                    askedBsp: boolean, exclusiveSeen: boolean,
 *                    legalityWaiting: boolean}>}
 */
export async function waitUpdateApplied({
  platform, conn, user, password, workDir,
  budgetMs = 30 * 60_000, pollMs = 10_000, settleMs = 20_000, onProgress,
}) {
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  let askedBsp = false;
  let exclusiveSeen = false;
  let legalityWaiting = false;
  let lastReason = '';

  while (Date.now() - startedAt < budgetMs) {
    throwIfCancelled();
    const state = await readUpdateState({ platform, conn, user, password, workDir });
    const seconds = elapsed();
    const { kind } = judgeUpdateState(state);

    if (kind === 'applied') {
      log.info(`Обновление информационной базы выполнено за ${seconds} с (по данным БСП)`);
      return { ok: true, seconds, askedBsp: true, exclusiveSeen, legalityWaiting };
    }

    if (kind === 'exclusive') {
      exclusiveSeen = true;
      lastReason = state.reason || '';
      onProgress?.(`монопольные обработчики обновления идут, база занята, ${seconds} с`);
      await sleep(pollMs);
      continue;
    }

    if (kind === 'legality' || kind === 'running') {
      askedBsp = true;
      if (kind === 'legality') {
        legalityWaiting = true;
        onProgress?.(`1С ждёт подтверждения легальности получения обновления, ${seconds} с`);
      } else {
        onProgress?.(`обработчики обновления выполняются, ${seconds} с`);
      }
      await sleep(pollMs);
      continue;
    }

    // Спросить БСП нечем. Возвращаемся к прежнему признаку — база пускает
    // соединение, — но выдерживаем паузу: сразу после запуска клиента база
    // ещё не занята, и без паузы мы объявили бы обработчики выполненными,
    // не дав им начаться.
    if (seconds * 1000 < settleMs) {
      onProgress?.(`ожидание обработчиков обновления, ${seconds} с`);
      await sleep(pollMs);
      continue;
    }
    return {
      ok: true,
      seconds,
      askedBsp: false,
      exclusiveSeen,
      legalityWaiting,
      reason: state.reason || 'состояние обновления у БСП спросить нечем',
    };
  }

  return {
    ok: false,
    seconds: elapsed(),
    askedBsp,
    exclusiveSeen,
    legalityWaiting,
    reason: legalityWaiting
      ? 'БСП так и ждёт подтверждения легальности получения обновления'
      : (lastReason || 'обновление информационной базы так и не завершилось'),
  };
}

/**
 * Разбор строки, которую печатает мост.
 *
 * Мост сообщает три вещи: найденную форму результатов обновления, момент
 * запуска задания и ход ожидания. Разбор вынесен отдельной функцией, потому
 * что именно на нём держится момент открытия формы: ошибись здесь — и форма
 * откроется не тогда, когда нужно, или не откроется вовсе.
 *
 * @returns {{kind: 'form', full: string, title: string}
 *          |{kind: 'started', uuid: string}
 *          |{kind: 'progress', seconds: number, state: string}
 *          |null}
 */
export function parseBridgeLine(line) {
  const text = String(line ?? '').trim();

  const progress = /^PROGRESS\|(\d+)\|(.*)$/.exec(text);
  if (progress) return { kind: 'progress', seconds: Number(progress[1]), state: progress[2] };

  const started = /^STARTED\|(.*)$/.exec(text);
  if (started) return { kind: 'started', uuid: started[1] };

  // В синониме формы могут быть любые символы, кроме перевода строки, поэтому
  // разбираем по первым двум разделителям, а остаток считаем заголовком.
  const form = /^FORM\|([^|]*)\|(.*)$/.exec(text);
  if (form && form[1]) return { kind: 'form', full: form[1], title: form[2] };

  return null;
}

/** Навигационная ссылка на форму по её полному имени из метаданных. */
export function navigationLink(fullName) {
  return `e1cib/app/${String(fullName).trim()}`;
}

/**
 * Открывает форму результатов обновления и проверяет, что окно появилось.
 *
 * Открывается вторым сеансом 1С с ключом `/URL` и навигационной ссылкой:
 * ключ проверен на 8.5.1.1150 — клиент запускается, входит в базу и открывает
 * ровно ту форму, что указана в ссылке. Первый сеанс не трогаем: в нём человек
 * может уже работать, а «вставить» команду в чужой запущенный клиент нечем.
 *
 * Успех не объявляется по факту запуска процесса: программа ждёт окно с
 * заголовком, равным синониму формы. Не дождались — так и говорим.
 *
 * @returns {Promise<{opened: boolean, link: string, title: string,
 *                    pid: number|null, seconds: number, reason?: string}>}
 */
export async function openResultsForm({
  platform, conn, user, password, workDir, form, budgetMs = 3 * 60_000, pollMs = 5_000,
}) {
  const link = navigationLink(form.full);
  const title = String(form.title || '').trim();
  const startedAt = Date.now();

  let pid = null;
  try {
    ({ pid } = launchEnterprise({
      platform, conn, user, password, extraArgs: ['/URL', link],
    }));
  } catch (err) {
    return { opened: false, link, title, pid: null, seconds: 0, reason: err.message };
  }

  if (!title) {
    return {
      opened: false, link, title, pid,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      reason: 'у формы нет синонима — проверить открытие нечем',
    };
  }

  while (Date.now() - startedAt < budgetMs) {
    throwIfCancelled();
    await sleep(pollMs);
    const titles = await windowTitles({ processId: pid, workDir });
    if (titles.some((t) => t.toLowerCase().includes(title.toLowerCase()))) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      log.info(`Форма «${title}» открыта через ${seconds} с`);
      return { opened: true, link, title, pid, seconds };
    }
  }

  return {
    opened: false, link, title, pid,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    reason: `окно «${title}» не появилось за отведённое время`,
  };
}

/** Заголовки видимых окон процесса — через отдельный скрипт на WinAPI. */
async function windowTitles({ processId, workDir }) {
  if (!processId) return [];
  const dir = await ensureDir(path.join(workDir, 'handlers'));
  const outputFile = path.join(dir, `windows-${processId}.json`);
  try {
    await runPowerShell(WINDOW_SCRIPT, ['-ProcessId', String(processId), '-OutputFile', outputFile], {
      timeout: 60_000,
      allowNonZeroExit: true,
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    log.warn(`Не удалось прочитать заголовки окон: ${err.message}`);
    return [];
  }
  const output = await readJson(outputFile);
  return Array.isArray(output?.titles) ? output.titles.map(String) : [];
}

/**
 * Запускает отложенное обновление фоновым заданием и ждёт его завершения.
 *
 * `onStarted` вызывается ровно в тот момент, когда задание запущено, — по нему
 * конвейер открывает форму результатов обновления, чтобы человек видел ход
 * отложенных обработчиков с самого начала, а не по факту.
 *
 * @returns {Promise<{ok: boolean, finished: boolean, job?: object,
 *                    background?: object, jobNames?: string[], reason?: string}>}
 */
export async function runDeferredUpdate({
  platform, conn, user, password, workDir, budgetMs = 60 * 60_000, onProgress, onStarted,
}) {
  const dir = await ensureDir(path.join(workDir, 'handlers'));
  const inputFile = path.join(dir, 'deferred-input.json');
  const outputFile = path.join(dir, 'deferred-output.json');
  await rmrf(outputFile).catch(() => {});

  await writeJson(inputFile, {
    binDir: platform.binDir,
    progId: comConnectorProgId(platform.version),
    connectionString: toComConnectionString(conn, { user, password }),
    jobNamePattern: JOB_PATTERN,
    formNamePattern: FORM_PATTERN,
    jobTitle: 'Отложенное обновление (запущено из «1С: AI инструменты»)',
    budgetSeconds: Math.floor(budgetMs / 1000),
    pollSeconds: 10,
    names: RU_NAMES,
  });

  // Мост сообщает найденную форму раньше, чем запуск задания, — запоминаем её,
  // чтобы в момент старта было чем открыть окно.
  let foundForm = null;

  log.info('Запуск отложенного обновления фоновым заданием');
  try {
    await runPowerShell(SCRIPT, ['-InputFile', inputFile, '-OutputFile', outputFile], {
      // Мост сам ждёт задание, поэтому его собственный запас времени больше.
      timeout: budgetMs + 120_000,
      allowNonZeroExit: true,
      onStdout: (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const event = parseBridgeLine(line);
          if (!event) continue;
          if (event.kind === 'progress') onProgress?.(event.seconds, event.state);
          if (event.kind === 'form') foundForm = { full: event.full, title: event.title };
          // Форму открываем в момент старта задания, а не после ожидания:
          // ждать здесь нельзя, поэтому вызов не блокирует разбор вывода.
          if (event.kind === 'started') onStarted?.(foundForm);
        }
      },
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    return { ok: false, finished: false, reason: err.message };
  }

  const output = await readJson(outputFile);
  if (!output) {
    return { ok: false, finished: false, reason: 'мост не вернул результат (см. журнал приложения)' };
  }
  if (!output.ok) {
    return {
      ok: false,
      finished: false,
      jobNames: output.jobNames || [],
      reason: (output.errors || []).join('; ') || 'отложенное обновление не запустилось',
    };
  }

  log.info(
    `Отложенное обновление: задание «${output.job?.name}», состояние ${output.background?.state || '?'}, `
    + `осталось включённым: ${output.job?.useAfter}`,
  );
  return {
    ok: true,
    finished: output.finished === true,
    job: output.job,
    background: output.background,
    form: output.form || foundForm,
    jobNames: output.jobNames || [],
  };
}

/**
 * Пауза между проверками.
 *
 * Таймер намеренно НЕ снимается с учёта (`unref`): снятый таймер не держит
 * событийный цикл, и процесс, которому больше нечего делать, выходит прямо
 * посреди ожидания. В сервере это скрыто — там живёт HTTP-сервер, — а в отдельном
 * прогоне ожидание молча обрывалось: поймано на живой проверке, Node сказал
 * «unsettled top-level await».
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

