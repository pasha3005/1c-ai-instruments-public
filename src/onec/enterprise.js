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
 * **Всё происходит в ОДНОМ сеансе 1С** — прямое требование пользователя
 * (12.08.2026): «Я хочу, чтобы ты всё обновление сделал в одном окне 1С
 * в режиме предприятия, последовательно». Прежде программа открывала второй
 * сеанс ради формы результатов, и это была ошибка: ключ `/URL` можно передать
 * тому же первому запуску, а отложенные обработчики умеет выполнить в этом же
 * сеансе сама БСП.
 *
 * Отсюда три части, и ни одна из них не меняет конфигурацию:
 *
 *  1. **Подтверждение легальности получения обновления.** БСП не начинает
 *     обработчики, пока человек не подтвердит легальность в форме «Легальность
 *     получения обновлений». Программа подтверждает это сама — процедурой самой
 *     БСП, той же, что вызывает кнопка «Продолжить» (`confirmUpdateLegality`).
 *  2. **Обработчики выполняются через внешнее соединение, без окна**
 *     (`runInfobaseUpdate`). Это штатный путь, а не обходной: у функции БСП
 *     в комментарии написано «Выполнить неинтерактивное обновление данных ИБ.
 *     Для вызова через внешнее соединение». Монопольные выполняются всегда,
 *     отложенные — тем же вызовом.
 *  3. **Запускается единственный сеанс 1С — уже с открытой формой результатов**
 *     (`updateSessionArgs`, `waitResultsForm`): ключ `/URL` с навигационной
 *     ссылкой. Окно остаётся у пользователя, форма — открытой.
 *
 * Почему обработчики не выполняются в самом окне предприятия, раз пользователь
 * просил одно окно. Именно поэтому. Форму результатов открывает только ключ
 * `/URL` при СТАРТЕ сеанса, а в сеансе, который сам выполняет обновление, эта
 * форма не живёт: БСП закрывает открытые окна вместе со своим окном
 * «Обновление версии приложения» — измерено на живой базе, форма была видна
 * с 11-й по 44-ю секунду и была закрыта. Передать ссылку в уже работающий
 * сеанс платформа не даёт: открывается второй сеанс (проверено). Значит одно
 * окно с открытой формой возможно только так — обработчики без окна, а окно
 * запускается после них.
 *
 * Фоновое задание отложенного обновления через отдельное COM-соединение убрано:
 * это был ещё один сеанс, делавший работу, которую БСП делает сама.
 * `waitUpdateApplied` остаётся запасным путём — на случай, когда неинтерактивное
 * обновление недоступно и обработчики приходится выполнять входом в базу.
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

const STATE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'update-state.ps1');

const RUN_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'run-update.ps1');

/**
 * Русские имена того, что скрипт-мост дёргает у COM-соединения.
 *
 * В самом `.ps1` кириллицы быть не может (Windows PowerShell 5.1 читает файл
 * без BOM в ANSI), поэтому имена приходят отсюда. Английские имена скрипт
 * пробует первыми и обычно ими и обходится; русские — страховка на случай
 * сборки, где англоязычные обращения не проходят.
 */
const RU_NAMES = {
  count: 'Количество',
  get: 'Получить',
  metadata: 'Метаданные',
  name: 'Имя',
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
  deferredStatus: ['СтатусОтложенногоОбновления'],
  runUpdate: ['ВыполнитьОбновлениеИнформационнойБазы'],
};

/**
 * Ответы БСП на выполнение обновления информационной базы.
 *
 * Строки вендорские, из комментария к функции: «Успешно», «НеТребуется»,
 * «ОшибкаУстановкиМонопольногоРежима». Переводить их своими словами нельзя —
 * можно только объяснить.
 */
const UPDATE_RESULT = {
  ok: 'Успешно',
  notRequired: 'НеТребуется',
  exclusiveFailed: 'ОшибкаУстановкиМонопольногоРежима',
};

/**
 * Что означает статус отложенного обновления, который отдаёт БСП.
 *
 * Пустая строка — необработанных отложенных обработчиков не осталось; всё
 * остальное БСП называет своими словами, и переводить их догадками нельзя.
 */
const DEFERRED_STATUS_TEXT = {
  СтатусНеВыполнено: 'часть отложенных обработчиков ещё не выполнена',
  СтатусОшибка: 'часть отложенных обработчиков завершилась с ошибкой',
  СтатусПриостановлен: 'отложенное обновление приостановлено',
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
 * Ключи единственного сеанса 1С, который остаётся у пользователя.
 *
 * Обработчики обновления к этому моменту уже выполнены (внешним соединением),
 * поэтому сеанс нужен ровно за одним: открыть форму результатов обновления
 * и оставить её открытой. Делает это ключ `/URL` с навигационной ссылкой.
 *
 * Формы в метаданных не нашлось — ключа не будет: запуск без него правильнее,
 * чем запуск со ссылкой в никуда.
 */
export function updateSessionArgs(form) {
  const full = String(form?.full || '').trim();
  return full ? ['/URL', navigationLink(full)] : [];
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
    formNamePattern: FORM_PATTERN,
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
    deferredStatus: null,
    form: null,
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
    // Пустая строка от БСП значит «необработанных отложенных не осталось»,
    // а `null` — «спросить не удалось». Разница существенная, поэтому пустую
    // строку не подменяем на null.
    deferredStatus: typeof output.deferredStatus === 'string' ? output.deferredStatus : null,
    form: output.form?.full ? { full: String(output.form.full), title: String(output.form.title || '') } : null,
    version: String(output.version || ''),
    reason: (output.errors || [])[0] || '',
  };
}

/**
 * Выполняет обработчики обновления через внешнее соединение — без окна 1С.
 *
 * Это штатный, документированный вендором путь, а не обходной: у функции БСП
 * в комментарии прямо написано «Выполнить неинтерактивное обновление данных ИБ.
 * Для вызова через внешнее соединение». Монопольные обработчики выполняются
 * всегда, отложенные — если попросить (`deferredNow`); в файловой базе БСП
 * и так выполняет их в основном цикле обновления.
 *
 * Почему не в окне предприятия, раз пользователь просил одно окно. Именно
 * поэтому: окно должно остаться ОДНО и с открытой формой результатов, а форму
 * можно открыть только ключом `/URL` при старте сеанса. В сеансе, который сам
 * выполняет обновление, она не живёт — БСП закрывает открытые окна вместе со
 * своим окном «Обновление версии приложения» (измерено на живой базе: форма
 * была видна с 11-й по 44-ю секунду и была закрыта). Поэтому обработчики
 * выполняются здесь, без окна, а единственный сеанс запускается уже после них.
 *
 * @returns {Promise<{ok: boolean, result: string, seconds: number,
 *                    exclusiveFailed: boolean, reason: string}>}
 */
export async function runInfobaseUpdate({
  platform, conn, user, password, workDir, deferredNow = true, timeoutMs = 4 * 60 * 60_000,
}) {
  const dir = await ensureDir(path.join(workDir, 'handlers'));
  const inputFile = path.join(dir, 'run-input.json');
  const outputFile = path.join(dir, 'run-output.json');
  await rmrf(outputFile).catch(() => {});

  await writeJson(inputFile, {
    binDir: platform.binDir,
    progId: comConnectorProgId(platform.version),
    connectionString: toComConnectionString(conn, { user, password }),
    deferredNow,
    bsp: BSP_NAMES,
  });

  log.info('Выполнение обработчиков обновления через внешнее соединение');
  try {
    await runPowerShell(RUN_SCRIPT, ['-InputFile', inputFile, '-OutputFile', outputFile], {
      timeout: timeoutMs,
      allowNonZeroExit: true,
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    return { ok: false, result: '', seconds: 0, exclusiveFailed: false, reason: err.message };
  }

  const output = await readJson(outputFile);
  if (!output) {
    return {
      ok: false, result: '', seconds: 0, exclusiveFailed: false,
      reason: 'мост не вернул результат (см. журнал приложения)',
    };
  }

  const result = String(output.result || '');
  const exclusiveFailed = result === UPDATE_RESULT.exclusiveFailed;
  const ok = output.ok === true
    && (result === UPDATE_RESULT.ok || result === UPDATE_RESULT.notRequired);

  log.info(`Обработчики обновления: ${result || 'ответа нет'}, ${output.seconds || 0} с`);
  return {
    ok,
    result,
    seconds: Number(output.seconds) || 0,
    exclusiveFailed,
    reason: ok ? '' : ((output.errors || [])[0] || result || 'обновление не выполнено'),
  };
}

/** Человеческими словами: что БСП думает об отложенных обработчиках. */
export function deferredStatusText(status) {
  if (status === null || status === undefined) return '';
  if (status === '') return 'отложенных обработчиков не осталось';
  return DEFERRED_STATUS_TEXT[status] || `состояние отложенного обновления: ${status}`;
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

  // Форма результатов обновления читается тем же вызовом: её полное имя нужно
  // ключу /URL при запуске клиента, то есть ДО того, как сеанс начался.
  const form = state.form || null;

  if (!state.connected) {
    return {
      needed: null, confirmed: false, bspAvailable: false, form,
      reason: state.reason || 'база не пустила внешнее соединение',
    };
  }
  if (!state.bspAvailable) {
    return {
      needed: null, confirmed: false, bspAvailable: false, form,
      reason: state.reason || 'функции обновления ИБ через внешнее соединение недоступны',
    };
  }

  // Подтверждения не требовалось — значит и подтверждать нечего: либо оно уже
  // записано, либо конфигурация его не спрашивает.
  if (state.legalityRequired === false && !state.legalityConfirmed) {
    return { needed: false, confirmed: false, bspAvailable: true, form, reason: '' };
  }

  if (state.legalityConfirmed) {
    log.info('Легальность получения обновления подтверждена процедурой БСП');
    return { needed: true, confirmed: true, bspAvailable: true, form, reason: '' };
  }

  return {
    needed: state.legalityRequired,
    confirmed: false,
    bspAvailable: true,
    form,
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
      return {
        ok: true, seconds, askedBsp: true, exclusiveSeen, legalityWaiting,
        // Что с отложенными обработчиками, знает та же БСП: пустая строка —
        // необработанных не осталось, иначе она называет причину.
        deferredStatus: state.deferredStatus,
      };
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
      deferredStatus: null,
      reason: state.reason || 'состояние обновления у БСП спросить нечем',
    };
  }

  return {
    ok: false,
    seconds: elapsed(),
    askedBsp,
    exclusiveSeen,
    legalityWaiting,
    deferredStatus: null,
    reason: legalityWaiting
      ? 'БСП так и ждёт подтверждения легальности получения обновления'
      : (lastReason || 'обновление информационной базы так и не завершилось'),
  };
}

/** Навигационная ссылка на форму по её полному имени из метаданных. */
export function navigationLink(fullName) {
  return `e1cib/app/${String(fullName).trim()}`;
}

/**
 * Ждёт, пока форма результатов обновления появится в ОКНЕ ЗАПУЩЕННОГО сеанса.
 *
 * Второй сеанс ради формы больше не открывается: ссылка `/URL` передана тому же
 * клиенту при запуске, и форма открывается в нём — после того как БСП закончит
 * обработчики обновления. Здесь остаётся только дождаться окна.
 *
 * Успех не объявляется по факту запуска процесса: программа ждёт окно
 * с заголовком, равным синониму формы. Не дождались — так и говорим.
 *
 * @returns {Promise<{opened: boolean, title: string, link: string,
 *                    pid: number|null, seconds: number, reason?: string}>}
 */
export async function waitResultsForm({
  processId, form, workDir, budgetMs = 3 * 60_000, pollMs = 5_000,
}) {
  const title = String(form?.title || '').trim();
  const link = form?.full ? navigationLink(form.full) : '';
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  if (!processId) {
    return { opened: false, title, link, pid: null, seconds: 0, reason: '1С не запущена' };
  }
  if (!title) {
    return {
      opened: false, title, link, pid: processId, seconds: 0,
      reason: 'у формы нет синонима — проверить открытие нечем',
    };
  }

  while (Date.now() - startedAt < budgetMs) {
    throwIfCancelled();
    const titles = await windowTitles({ processId, workDir });
    if (titles.some((t) => t.toLowerCase().includes(title.toLowerCase()))) {
      log.info(`Форма «${title}» открыта в том же сеансе через ${elapsed()} с`);
      return { opened: true, title, link, pid: processId, seconds: elapsed() };
    }
    await sleep(pollMs);
  }

  return {
    opened: false, title, link, pid: processId, seconds: elapsed(),
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

