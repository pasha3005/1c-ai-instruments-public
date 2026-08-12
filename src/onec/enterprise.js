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
 * Отсюда три части, и ни одна из них не меняет конфигурацию:
 *
 *  1. **Клиент запускается и остаётся работать.** Монопольные обработчики
 *     платформа выполняет сама при первом входе в базу после смены версии
 *     конфигурации. Ждать завершения процесса нельзя и не нужно: в этом окне
 *     потом работает человек.
 *  2. **Признак того, что монопольная часть закончилась, — освободившаяся
 *     база.** Пока идут монопольные обработчики, база занята монопольно,
 *     и внешнее соединение к ней не встаёт. Как только соединение прошло,
 *     монопольная часть отработала. Признак ничей не выдуманный: его даёт
 *     сама платформа, и он не зависит ни от версии БСП, ни от состава
 *     обработчиков.
 *  3. **Отложенные обработчики запускаются фоновым заданием** — тем самым
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
 * Ждёт, пока база освободится от монопольного обновления.
 *
 * Проверка — попытка внешнего соединения: пока платформа выполняет монопольные
 * обработчики, она держит базу монопольно и соединение не даёт. Первое успешное
 * соединение и означает, что монопольная часть закончилась.
 *
 * Первые несколько секунд соединение может пройти ещё ДО того, как клиент
 * успел взять базу монопольно, поэтому сначала выдерживается пауза: иначе
 * мы объявили бы обработчики выполненными, не дав им начаться.
 *
 * @returns {Promise<{ok: boolean, seconds: number, reason?: string}>}
 */
export async function waitExclusiveReleased({
  platform, conn, user, password, workDir,
  settleMs = 20_000, budgetMs = 30 * 60_000, pollMs = 10_000, onProgress,
}) {
  const startedAt = Date.now();
  await sleep(settleMs);

  let lastReason = '';
  while (Date.now() - startedAt < budgetMs) {
    throwIfCancelled();
    const probe = await probeConnection({ platform, conn, user, password, workDir });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (probe.ok) {
      log.info(`База освободилась через ${seconds} с — монопольные обработчики отработали`);
      return { ok: true, seconds };
    }
    lastReason = probe.reason || '';
    onProgress?.(`ждём монопольные обработчики, ${seconds} с${lastReason ? `: ${short(lastReason)}` : ''}`);
    await sleep(pollMs);
  }

  return {
    ok: false,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    reason: lastReason || 'база так и не освободилась',
  };
}

/**
 * Однократная попытка внешнего соединения — она же проверка «база свободна».
 *
 * Отдельным процессом PowerShell, тем же мостом, что и всё остальное COM:
 * соединение из Node напрямую невозможно, а держать его нам и не нужно.
 */
async function probeConnection({ platform, conn, user, password, workDir }) {
  const dir = await ensureDir(path.join(workDir, 'handlers'));
  const inputFile = path.join(dir, 'probe-input.json');
  const outputFile = path.join(dir, 'probe-output.json');
  await rmrf(outputFile).catch(() => {});

  await writeJson(inputFile, {
    binDir: platform.binDir,
    progId: comConnectorProgId(platform.version),
    connectionString: toComConnectionString(conn, { user, password }),
    // Соединяемся и сразу отпускаем: задача — узнать, пускает ли база.
    jobNamePattern: JOB_PATTERN,
    jobTitle: 'проверка доступности базы',
    budgetSeconds: 0,
    pollSeconds: 5,
    names: RU_NAMES,
    probeOnly: true,
  });

  try {
    await runPowerShell(SCRIPT, ['-InputFile', inputFile, '-OutputFile', outputFile], {
      timeout: 120_000,
      allowNonZeroExit: true,
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    return { ok: false, reason: err.message };
  }

  const output = await readJson(outputFile);
  if (!output) return { ok: false, reason: 'мост не вернул результат' };
  // В режиме проверки скрипт соединяется и сразу выходит: `ok` здесь означает
  // ровно то, что база пустила, — никаких заданий он не запускает.
  if (output.ok) return { ok: true };
  return { ok: false, reason: (output.errors || [])[0] || 'соединение не встало' };
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

function short(text) {
  const line = String(text).split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}
