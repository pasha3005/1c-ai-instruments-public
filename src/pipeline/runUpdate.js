/**
 * Конвейер обновления конфигурации, находящейся на поддержке.
 *
 * **Путей два, и выбирается он за пять секунд, до всякой тяжёлой работы**
 * (`vendorConfigPresence`). Требование пользователя дословно (11.08.2026):
 * «если ты видишь, что конфигурация "на замке", то есть, на поддержке, значит,
 * используй типовой метод обновления, и сравнение тебе не нужно вообще. Но если
 * включена возможность изменения, и ты видишь доработки — тут уже подключай
 * свой инструмент по автоматическому обновлению».
 *
 * **Доработок нет** (конфигурации поставщика в базе для сравнения не оказалось):
 * обновление выполняет сама платформа — `/UpdateCfg` новой поставкой, затем
 * `/UpdateDBCfg` и проверки. Ни выгрузки в XML, ни разворачивания поставки,
 * ни объединения: решений, которые стоило бы принимать, здесь нет. На демо-базе
 * УНФ это 56 секунд против примерно четверти часа своим путём.
 *
 * **Доработки есть** — прежний, длинный путь:
 *
 *   1. выгружаем основную конфигурацию базы в XML;
 *   2. разворачиваем НОВУЮ поставку (то, на что обновляемся);
 *   3. получаем ТЕКУЩУЮ конфигурацию поставщика — из файла .cf либо
 *      восстановлением прямо из базы (`update/vendorSources.js`);
 *   4. объединяем три версии: правку вендора берём, свою сохраняем,
 *      дважды изменённое сначала пробуем разобрать сами;
 *   5. пишем результат в файлы выгрузки и показываем отчёт;
 *   6. спрашиваем разрешение и, получив его, загружаем результат в базу,
 *      обновляем конфигурацию базы данных и прогоняем проверки — включая
 *      применимость расширений, которую чиним и проверяем заново.
 *
 * Почему обследование и обновление — разные конвейеры, хотя первые три этапа
 * похожи. Обследование ничего не меняет и живёт результатом-отчётом; обновление
 * меняет файлы выгрузки, а по подтверждению — и саму базу, и его результат —
 * сама выгрузка. Общий конвейер с флагом «а теперь ещё и обнови» означал бы,
 * что случайно поставленная галочка ведёт к записи в базу.
 *
 * Выгрузка после обновления НЕ удаляется: в ней лежит результат, её правят
 * руками в местах, где решение за человеком, и из неё же потом загружают
 * конфигурацию — иногда не в тот же день.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { resolvePlatform } from '../onec/platform.js';
import { parseConnection, validateConnection } from '../onec/connection.js';
import { exportConfiguration, exportExtensions } from '../onec/collector.js';
import { loadConfigFromFiles } from '../onec/designer.js';
import { checkConfig, checkExtensionsApplicable, updateDbConfig } from '../onec/checkConfig.js';
import {
  prepareVendorConfig, exportCfToXml, readConfigurationProperties,
} from '../analyze/vendorConfig.js';
import { findVendorRelease } from '../onec/templates.js';
import { vendorConfigPresence } from '../onec/vendorCompare.js';
import { launchEnterprise, waitExclusiveReleased, runDeferredUpdate } from '../onec/enterprise.js';
import { updateCfgFromFile } from '../onec/updateCfg.js';
import { mergeConfigurations, dirTree, CONFLICT_DIR } from '../update/mergeConfig.js';
import { restoreVendorTree } from '../update/vendorSources.js';
import { fixExtensionAnnotations } from '../update/fixExtensions.js';
import { renderUpdateReport } from '../report/updateReport.js';
import * as store from '../store/updateStore.js';
import { ensureDir, pathExists, rmrf, dirSize, humanSize } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { runCancellable, throwIfCancelled, isCancelled, CANCEL_MESSAGE } from '../util/cancel.js';

const log = createLogger('update');

/** Сколько раз чинить расширения и повторять проверку применимости. */
const FIX_ROUNDS = 3;

/**
 * @param {object} params
 * @param {string} params.updateId
 * @param {object} params.input параметры с формы
 * @param {import('../server/progress.js').AuditProgress} params.progress
 */
export function runUpdate({ updateId, input, progress }) {
  return runCancellable(progress?.signal || null, () => runPipeline({ updateId, input, progress }));
}

async function runPipeline({ updateId, input, progress }) {
  const workRoot = path.resolve(String(input.workDir || '').trim());
  const startedAt = Date.now();
  const warnings = [];

  const startStage = (id, detail = '') => {
    throwIfCancelled();
    progress.start(id, detail);
  };

  try {
    // ---------- 1. Подготовка ----------
    startStage('prepare');
    await ensureDir(workRoot);
    const conflictRoot = path.join(workRoot, CONFLICT_DIR);
    await rmrf(conflictRoot).catch(() => {});
    progress.message(`Рабочий каталог: ${workRoot}`);
    progress.done('prepare', workRoot);

    // ---------- 2. Платформа ----------
    startStage('platform', 'Поиск установленных версий 1С:Предприятие');
    const { platform, exact, available } = await resolvePlatform(input.platformVersion);
    if (!exact && input.platformVersion) {
      progress.message(
        `Версия ${input.platformVersion} не найдена. Используется ${platform.version}. `
        + `Доступны: ${available.join(', ')}`,
        'warn',
      );
    }
    progress.done('platform', platform.version);

    // ---------- 3. Доступ к базе ----------
    startStage('connect', 'Проверка пути к информационной базе');
    const conn = parseConnection(input.infobasePath);
    const validation = await validateConnection(conn);
    for (const warning of validation.warnings) progress.message(warning, 'warn');
    progress.done('connect', conn.display);

    const collectCtx = {
      platform, conn, workDir: workRoot, user: input.user, password: input.password,
    };

    // ---------- 4. Есть ли в базе доработки ----------
    // Пять секунд до всего дорогого. Если конфигурации поставщика в базе нет,
    // значит возможность изменения не включали и доработок нет: обновлять такую
    // конфигурацию должна сама платформа, а сравнивать и объединять нечего.
    startStage('detect', 'Проверка, есть ли в базе конфигурация поставщика');
    const vendorGiven = Boolean(String(input.vendorConfigPath || '').trim());
    const presence = vendorGiven
      ? { present: true, log: '' }
      : await vendorConfigPresence({ ...collectCtx });

    if (presence.present === false) {
      progress.done('detect', 'доработок нет — обновление типовое');
      return await runTypical({
        updateId, input, platform, conn, workRoot, progress, startedAt, warnings, collectCtx,
      });
    }
    progress.done('detect', vendorGiven
      ? 'указана текущая поставка — объединяем'
      : (presence.present ? 'конфигурация поставщика в базе есть' : 'определить не удалось, объединяем'));
    // Дальше идёт длинный путь; типовое обновление в нём не участвует.
    progress.skip('update-cfg', 'не подходит: в конфигурации есть доработки');

    // ---------- 5. Основная конфигурация ----------
    startStage('export-main', 'Выгрузка основной конфигурации в XML (может занять несколько минут)');
    const exported = await exportConfiguration({
      ...collectCtx,
      onProgress: (text) => {
        const line = text.trim().split('\n').pop();
        if (line) progress.update('export-main', line.slice(0, 160));
      },
    });
    const mainProps = await readConfigurationProperties(path.join(exported.dir, 'Configuration.xml'));
    progress.done('export-main',
      `${humanSize(await dirSize(exported.dir))}, ${mainProps.name || 'конфигурация'} ${mainProps.version || ''}`.trim());

    // ---------- 6. Новая поставка ----------
    // Она готовится ПЕРЕД старой: восстановление старой поставки из базы
    // заглядывает в новую, чтобы заполнить строки, которые интегратор удалил, —
    // их текста отчёт сравнения не печатает. Порядок в `UPDATE_STAGES` держать
    // таким же: пользователь читает шкалу как последовательность и этап,
    // отработавший раньше стоящего над ним, принимает за сбой.
    startStage('vendor-new', 'Подготовка целевой конфигурации');
    const target = await prepareTarget({ input, platform, workRoot, progress });
    const targetTree = await dirTree(target.dir);
    const targetProps = await readConfigurationProperties(path.join(target.dir, 'Configuration.xml'));
    progress.done('vendor-new',
      `${targetProps.name || ''} ${targetProps.version || ''}`.trim() || target.dir);

    // ---------- 7. Текущая конфигурация поставщика ----------
    startStage('vendor-old', 'Подготовка текущей конфигурации поставщика');
    const vendorCtx = {
      platform, conn, workDir: workRoot, user: input.user, password: input.password,
      configName: mainProps.name,
      totalEntries: 0,
      onProgress: (text) => progress.update('vendor-old', text),
    };
    let vendor = await prepareVendorConfig({ vendorPath: input.vendorConfigPath, ...vendorCtx });

    // Платформа не отдала поставщика. Прежде чем сдаться и просить файл, ищем
    // дистрибутив текущего релиза сами: это та же поставка, и у того, кто эту
    // конфигурацию когда-нибудь обновлял, он уже лежит на диске.
    if (!vendor.available && vendor.vendorUnavailable && !String(input.vendorConfigPath || '').trim()) {
      vendor = await lookForRelease({ vendor, vendorCtx, mainProps, progress, warnings });
    }

    if (!vendor.available) {
      throw new Error(
        `Не удалось получить текущую конфигурацию поставщика: ${vendor.reason} `
        + 'Без неё обновление невозможно: непонятно, какие изменения ваши, а какие пришли '
        + 'от поставщика, и объединять нечего.',
      );
    }

    const { baseTree, baseProps, restoreStats } = await prepareBase({
      vendor, exported, targetTree, mainProps, progress, warnings,
    });

    checkTarget({ mainProps, baseProps, targetProps, warnings, progress });

    // ---------- 8. Объединение ----------
    startStage('merge', 'Трёхстороннее сравнение и объединение');
    const merge = await mergeConfigurations({
      mainDir: exported.dir,
      baseTree,
      targetTree,
      conflictRoot,
      onProgress: (done, total, rel) => {
        progress.update('merge', `${done} из ${total}: ${rel}`);
      },
    });
    const manualCount = (merge.totals.conflicted || 0) + (merge.totals.manual || 0);
    progress.done('merge',
      `взято от поставщика ${merge.totals.fromVendor + merge.totals.merged}, `
      + `разобрано автоматически ${merge.totals.autoResolved}, `
      + `требует решения ${manualCount}`);

    // ---------- 9. Отчёт ----------
    startStage('report', 'Сборка отчёта об объединении');
    const result = {
      updateId,
      generatedAt: new Date().toISOString(),
      input: sanitize(input),
      infobase: { kind: conn.kind, display: conn.display },
      platformVersion: platform.version,
      driver: exported.driver,
      configs: {
        main: mainProps,
        base: baseProps,
        target: targetProps,
      },
      vendorSource: vendor.source,
      restore: restoreStats,
      mergedDir: exported.dir,
      conflictDir: merge.conflictIndex.length ? conflictRoot : '',
      merge,
      warnings,
      loaded: false,
      durationMs: Date.now() - startedAt,
    };

    await save(updateId, result);
    progress.done('report', 'отчёт готов');

    // ---------- 10. Запись в базу — по подтверждению ----------
    await applyToBase({
      updateId, input, platform, conn, workRoot, progress, result, manualCount,
    });

    result.durationMs = Date.now() - startedAt;
    await save(updateId, result);

    progress.finish({
      updateId,
      manual: manualCount,
      autoResolved: merge.totals.autoResolved,
      fromVendor: merge.totals.fromVendor + merge.totals.merged,
      durationMs: result.durationMs,
    });
    log.info(`Обновление ${updateId} завершено: требует решения ${manualCount}`);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    if (isCancelled(err)) {
      log.info(`Обновление ${updateId} остановлено пользователем через ${Math.round(durationMs / 1000)} с`);
      progress.cancelled(CANCEL_MESSAGE);
      await store.markCancelled(updateId, durationMs, CANCEL_MESSAGE);
      return null;
    }

    log.error(`Обновление ${updateId} завершилось ошибкой: ${err.message}`, { stack: err.stack });
    progress.fail(err);
    await store.markFailed(updateId, err, durationMs);
    throw err;
  }
}

/**
 * Типовое обновление: конфигурация без доработок, всё делает платформа.
 *
 * Здесь нет ни выгрузки, ни объединения — и это не упрощение, а правильный
 * ответ: у конфигурации, где возможность изменения не включали, нет ни одного
 * места, о котором надо принимать решение. Ровно так обновляет конфигуратор,
 * своей конфигурацией поставщика и своими правилами поддержки.
 *
 * Что всё-таки делается сверх команды платформы:
 *  * запись в базу — только по подтверждению, как и во втором пути;
 *  * у платформы запрашивается список дважды изменённых свойств. Если он
 *    непустой, значит доработки всё-таки есть, и это громкое предупреждение:
 *    такую базу надо вести объединением;
 *  * после обновления — `/UpdateDBCfg`, синтаксический контроль и проверка
 *    применимости расширений с починкой аннотаций.
 */
async function runTypical({
  updateId, input, platform, conn, workRoot, progress, startedAt, warnings, collectCtx,
}) {
  for (const id of ['export-main', 'vendor-new', 'vendor-old', 'merge']) {
    progress.skip(id, 'не требуется: доработок нет');
  }

  progress.message(
    'Конфигурация поставщика в базе для сравнения недоступна. Так отвечает база, где '
    + 'возможность изменения конфигурации не включали, — то есть доработок нет, объединять '
    + 'нечего. Обновление выполнит сама платформа, как это делает конфигуратор командой '
    + '«Обновить конфигурацию».',
  );

  const source = await typicalSource(input);

  progress.start('report', 'Подготовка сведений об обновлении');
  const result = {
    updateId,
    mode: 'typical',
    generatedAt: new Date().toISOString(),
    input: sanitize(input),
    infobase: { kind: conn.kind, display: conn.display },
    platformVersion: platform.version,
    // Свойства конфигураций читаются из XML-выгрузки, а её здесь нет намеренно:
    // ради двух строк в отчёте выгружать гигабайты незачем. Что известно точно —
    // файл поставки, которым обновляемся.
    configs: { main: {}, target: {} },
    typicalSource: source,
    warnings,
    loaded: false,
    durationMs: Date.now() - startedAt,
  };
  await save(updateId, result);
  progress.done('report', 'сведения готовы');

  const answer = await progress.ask('confirm', {
    title: 'Обновить конфигурацию базы средствами платформы?',
    manual: 0,
    infobase: conn.display,
    text: 'Доработок в конфигурации нет, поэтому обновление типовое: платформа применит '
      + `поставку ${path.basename(source)} к основной конфигурации, затем будет выполнено `
      + 'обновление конфигурации базы данных и проверки. Базе нужен монопольный доступ.',
  });

  if (!answer?.ok) {
    progress.skip('confirm', 'обновление отложено');
    for (const id of ['update-cfg', 'load', 'db-update', 'check', 'handlers']) progress.skip(id, 'не выполнялось');
    progress.message('Обновление не выполнялось: вы отложили запись в базу.');
  } else {
    progress.done('confirm', 'разрешено пользователем');
    progress.skip('load', 'не требуется: обновление выполняет платформа');
    await applyTypical({ updateId, input, platform, conn, workRoot, progress, result, source, collectCtx });
  }

  result.durationMs = Date.now() - startedAt;
  await save(updateId, result);
  progress.finish({
    updateId,
    mode: 'typical',
    manual: 0,
    autoResolved: 0,
    fromVendor: 0,
    durationMs: result.durationMs,
  });
  log.info(`Обновление ${updateId} завершено типовым путём`);
  return result;
}

/**
 * Файл поставки для типового обновления.
 *
 * `/UpdateCfg` принимает файл — `.cf` или `.cfu`. Каталог XML-выгрузки для этого
 * пути не годится, и подсунуть его платформе нечем: превращать выгрузку в `.cf`
 * пришлось бы через временную базу, то есть возвращаться к тем самым минутам,
 * которые типовой путь и экономит. Поэтому — честный отказ с объяснением.
 */
async function typicalSource(input) {
  const raw = String(input.targetConfigPath || '').trim();
  if (!raw) throw new Error('Не указана целевая конфигурация (файл .cf новой поставки)');
  const target = path.resolve(raw);

  if (!(await pathExists(target))) {
    throw new Error(`Целевая конфигурация не найдена: ${target}`);
  }
  if ((await fs.stat(target)).isDirectory()) {
    throw new Error(
      'Доработок в конфигурации нет, поэтому обновление выполняется штатной командой платформы, '
      + `а ей нужен файл поставки .cf или .cfu — указан каталог: ${target}. Укажите файл поставки.`,
    );
  }
  if (!/\.(cf|cfu)$/i.test(target)) {
    throw new Error(`Ожидается файл поставки .cf или .cfu, указано: ${path.basename(target)}`);
  }
  return target;
}

/** Запись в базу типовым путём: /UpdateCfg → /UpdateDBCfg → проверки. */
async function applyTypical({
  updateId, input, platform, conn, workRoot, progress, result, source, collectCtx,
}) {
  startWrite(progress, 'update-cfg', 'Платформа применяет поставку (нужен монопольный доступ)');
  const upd = await updateCfgFromFile({
    ...collectCtx,
    cfFile: source,
    onProgress: (text) => progress.update('update-cfg', text),
  });

  result.typical = {
    ok: upd.ok,
    log: upd.log,
    twiceChanged: upd.twiceChanged,
    reason: upd.reason || '',
  };

  if (!upd.ok) {
    result.loadError = upd.reason;
    await store.updateMeta(updateId, { loadError: upd.reason });
    progress.warn('update-cfg', 'не выполнено');
    for (const id of ['db-update', 'check', 'handlers']) progress.skip(id, 'обновление не выполнено');
    progress.message(
      `Платформа обновление не выполнила: ${upd.reason}. База не изменена.`
      + ' Если конфигурация снята с поддержки, типовое обновление невозможно —'
      + ' укажите текущую поставку файлом, и объединение будет выполнено разбором.',
      'warn',
    );
    return;
  }

  result.loaded = true;
  result.loadedAt = new Date().toISOString();
  await store.updateMeta(updateId, { loadedAt: result.loadedAt, loadError: null });
  progress.done('update-cfg', 'конфигурация обновлена платформой');

  if (upd.twiceChanged.length) {
    const text = `Платформа сообщила о дважды изменённых свойствах: ${upd.twiceChanged.length}. `
      + 'Значит доработки в конфигурации всё-таки есть, и решения по этим местам платформа '
      + 'приняла по правилам поддержки, а не разбором. Проверьте их и, если правки важны, '
      + 'ведите обновление объединением: укажите текущую поставку файлом.';
    result.warnings.push(text);
    progress.message(text, 'warn');
  }

  startWrite(progress, 'db-update', 'Реструктуризация таблиц (может занять долго)');
  try {
    await updateDbConfig({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
    });
    result.dbUpdated = true;
    progress.done('db-update', 'конфигурация базы данных обновлена');
  } catch (err) {
    if (isCancelled(err)) throw err;
    result.dbUpdated = false;
    result.dbUpdateError = err.message;
    progress.warn('db-update', 'не выполнено');
    progress.message(`Обновление конфигурации базы данных не выполнено: ${err.message}`, 'warn');
  }

  startWrite(progress, 'check', 'Синтаксический контроль расширений');
  result.checks = await runChecks({
    platform, conn, input, workRoot, mergedDir: '', progress, typical: true,
  });
  reportChecks(progress, result.checks);

  await runUpdateHandlers({ platform, conn, input, workRoot, progress, result });
}

/**
 * Обработчики обновления: монопольные — самой платформой, отложенные — заданием.
 *
 * Шаг общий для обоих путей обновления и идёт последним: обработчики выполняются
 * при первом входе в базу после смены версии конфигурации, то есть уже после
 * `/UpdateDBCfg`.
 *
 * Конфигурацию здесь не меняем — этого и не требуется: 1С запускается в режиме
 * предприятия, и монопольные обработчики отрабатывают сами. Наша работа —
 * дождаться их, запустить отложенные и не соврать о результате.
 */
async function runUpdateHandlers({ platform, conn, input, workRoot, progress, result }) {
  startWrite(progress, 'handlers', 'Запуск 1С в режиме предприятия');

  const handlers = { launched: false, exclusiveSeconds: null, deferred: null };
  result.handlers = handlers;

  try {
    const { pid } = launchEnterprise({
      platform, conn, user: input.user, password: input.password,
    });
    handlers.launched = true;
    handlers.pid = pid;
    progress.message(
      'Запущена 1С в режиме предприятия. Монопольные обработчики обновления платформа '
      + 'выполняет сама при первом входе в базу; окно остаётся открытым — работайте в нём. '
      + 'Программа ждёт, пока монопольная часть закончится, и после этого сама запустит '
      + 'отложенное обновление.',
    );
  } catch (err) {
    if (isCancelled(err)) throw err;
    handlers.error = err.message;
    progress.warn('handlers', `1С не запущена: ${err.message}`);
    progress.message(
      `Не удалось запустить 1С в режиме предприятия: ${err.message}. Обработчики обновления `
      + 'выполнятся при первом входе в базу — войдите в неё сами, затем запустите отложенное '
      + 'обновление из «Администрирование → Обслуживание».',
      'warn',
    );
    return;
  }

  // Монопольная часть: пока она идёт, база занята и внешнее соединение не встаёт.
  progress.update('handlers', 'ожидание монопольных обработчиков обновления');
  const exclusive = await waitExclusiveReleased({
    platform, conn, user: input.user, password: input.password, workDir: workRoot,
    onProgress: (text) => progress.update('handlers', text),
  });
  handlers.exclusiveSeconds = exclusive.seconds;

  if (!exclusive.ok) {
    handlers.error = exclusive.reason;
    progress.warn('handlers', `монопольная часть не завершилась за ${exclusive.seconds} с`);
    progress.message(
      `База так и не освободилась за ${Math.round(exclusive.seconds / 60)} мин: ${exclusive.reason}. `
      + 'Отложенное обновление не запускалось — сделайте это вручную, когда монопольные '
      + 'обработчики закончатся.',
      'warn',
    );
    return;
  }
  progress.message(`Монопольные обработчики обновления отработали за ${exclusive.seconds} с.`);

  // Отложенные: тем же методом, что стоит у регламентного задания.
  progress.update('handlers', 'запуск отложенного обновления фоновым заданием');
  const deferred = await runDeferredUpdate({
    platform, conn, user: input.user, password: input.password, workDir: workRoot,
    onProgress: (seconds, state) => progress.update('handlers',
      `отложенное обновление: ${state || 'выполняется'}, ${seconds} с`),
  });
  handlers.deferred = deferred;

  if (!deferred.ok) {
    progress.warn('handlers', 'отложенное обновление не запущено');
    progress.message(
      `Отложенное обновление запустить не удалось: ${deferred.reason}. Запустите регламентное `
      + 'задание отложенного обновления вручную: «Администрирование → Обслуживание → '
      + 'Обновление информационной базы».'
      + (deferred.jobNames?.length
        ? ` Регламентные задания в базе: ${deferred.jobNames.slice(0, 12).join(', ')}.`
        : ''),
      'warn',
    );
    return;
  }

  if (deferred.finished) {
    const nothingPending = deferred.job?.useBefore === false;
    progress.done('handlers', nothingPending
      ? 'обработчики выполнены, отложенных не было'
      : 'обработчики обновления выполнены');
    progress.message(
      nothingPending
        ? 'Отложенных обработчиков в этой базе не было: регламентное задание отложенного '
          + 'обновления выключено и до запуска, и после. Монопольные обработчики отработали, '
          + 'обновление закончено.'
        : 'Отложенное обновление завершено: регламентное задание больше не включено — значит '
          + 'необработанных отложенных обработчиков не осталось. Форму их просмотра открывать '
          + 'уже не за чем, но она в «Администрирование → Обслуживание → Обновление '
          + 'информационной базы».',
    );
    return;
  }

  // Не дождались: задание ещё работает. Выдавать это за выполнение нельзя —
  // на живой проверке задание шло 8 минут и не закончилось, а результат
  // говорил «выполнено».
  if (deferred.background?.stillRunning) {
    progress.warn('handlers', 'отложенное обновление ещё идёт');
    progress.message(
      `Отложенное обновление запущено и продолжает работу (состояние: `
      + `${deferred.background?.state || 'выполняется'}). Отведённое время ожидания вышло — `
      + 'задание от этого не остановилось и доработает само. Следить за ним в 1С: '
      + '«Администрирование → Обслуживание → Обновление информационной базы».',
      'warn',
    );
    return;
  }

  // Задание закончилось, но обработчики остались: БСП обрабатывает их порциями
  // и оставляет регламентное задание включённым до полного завершения.
  progress.warn('handlers', 'отложенные обработчики выполнены не полностью');
  progress.message(
    `Отложенное обновление отработало (состояние задания: ${deferred.background?.state || '?'}`
    + `${deferred.background?.error ? `, ошибка: ${deferred.background.error}` : ''}), но `
    + 'регламентное задание осталось включённым — часть отложенных обработчиков ещё не выполнена. '
    + 'БСП обрабатывает их порциями: откройте в 1С «Администрирование → Обслуживание → Обновление '
    + 'информационной базы» и следите за ходом там; задание продолжит работу само.',
    'warn',
  );
}

/** Сколько всего замечаний нашла платформа и как это показать на шкале. */
function reportChecks(progress, checks) {
  const problems = (checks.config?.errors?.length || 0)
    + (checks.extensionsSyntax?.errors?.length || 0)
    + (checks.extensions?.errors?.length || 0);
  if (problems) progress.warn('check', `замечаний платформы: ${problems}`);
  else progress.done('check', 'ошибок не найдено');
}

/**
 * Сколько найденных дистрибутивов пробовать.
 *
 * Каждая попытка — разворачивание `.cf` во временную базу, на крупной
 * конфигурации это минуты. Кандидаты отсортированы по надёжности, и если
 * не подошли два лучших, дешевле спросить файл, чем перебирать диск дальше.
 */
const RELEASE_TRIES = 2;

/**
 * Ищет дистрибутив текущего релиза среди шаблонов обновлений и проверяет его.
 *
 * Проверка обязательна: файл выбран по версии в имени каталога или в манифесте,
 * а версии у разных конфигураций совпадают запросто. Объединение с поставкой
 * ЧУЖОЙ конфигурации дало бы тысячи ложных отличий и мусор в выгрузке, поэтому
 * не подошедший файл отбрасывается, а причина проговаривается вслух.
 */
async function lookForRelease({ vendor, vendorCtx, mainProps, progress, warnings }) {
  progress.update('vendor-old', 'Поиск дистрибутива текущего релиза среди шаблонов обновлений');
  const { candidates, roots } = await findVendorRelease({
    version: mainProps.version,
    onProgress: (text) => progress.update('vendor-old', text),
  });

  if (!candidates.length) {
    progress.message(
      `Дистрибутив релиза ${mainProps.version || '—'} на этом компьютере тоже не нашёлся`
      + (roots.length
        ? `. Искал в каталогах шаблонов обновлений: ${roots.join('; ')}. `
        : ': каталоги шаблонов обновлений не заданы в 1CEStart.cfg. ')
      + 'Сохраните текущую поставку сами — Конфигуратор → Конфигурация → Поддержка → '
      + 'Настройка поддержки → «Сохранить в файл» — и укажите файл в поле «Конфигурация '
      + 'поставщика — текущая поставка».',
      'warn',
    );
    return vendor;
  }

  for (const candidate of candidates.slice(0, RELEASE_TRIES)) {
    progress.message(
      'Дистрибутив текущего релиза нашёлся сам: '
      + `${candidate.file} (${candidate.why}). Разворачиваю его как текущую поставку.`,
    );
    const next = await prepareVendorConfig({ vendorPath: candidate.file, ...vendorCtx });
    if (!next.available) {
      progress.message(`Файл ${candidate.file} не подошёл: ${next.reason}`, 'warn');
      continue;
    }

    const props = await readConfigurationProperties(path.join(next.dir, 'Configuration.xml'));
    const wrongName = props.name && mainProps.name && props.name !== mainProps.name;
    const wrongVersion = props.version && mainProps.version && props.version !== mainProps.version;
    if (wrongName || wrongVersion) {
      progress.message(
        `Файл ${candidate.file} не подошёл: это «${props.name || '?'}» ${props.version || '?'}, `
        + `а в базе «${mainProps.name}» ${mainProps.version}.`,
        'warn',
      );
      continue;
    }

    warnings.push(
      'Платформа не отдала конфигурацию поставщика из базы, поэтому за текущую поставку взят '
      + `дистрибутив того же релиза, найденный на этом компьютере: ${candidate.file}. `
      + 'Убедитесь, что это действительно та поставка, с которой начинали доработку.',
    );
    return next;
  }

  return vendor;
}

/**
 * Старая поставка: файл .cf либо восстановление прямо из базы.
 *
 * Второй путь — обычный, а не запасной. Раз конфигурацию можно СРАВНИТЬ
 * с конфигурацией поставщика прямо в базе, значит поставщик виден: всё, чего
 * нет в перечне отличий, у него ровно такое же, а для изменённых модулей
 * подробный отчёт печатает обе стороны каждого участка. На это указал
 * пользователь, и это снимает с него обязанность заранее выгружать .cf.
 */
async function prepareBase({ vendor, exported, targetTree, mainProps, progress, warnings }) {
  if (vendor.dir) {
    const baseProps = await readConfigurationProperties(path.join(vendor.dir, 'Configuration.xml'));
    progress.done('vendor-old',
      `${baseProps.name || ''} ${baseProps.version || ''}`.trim() || vendor.source);
    return { baseTree: await dirTree(vendor.dir), baseProps, restoreStats: null };
  }

  progress.update('vendor-old', 'Восстановление текстов поставщика по сравнению с базой');
  const main = await dirTree(exported.dir);
  const baseTree = await restoreVendorTree({
    mainDir: exported.dir,
    mainFiles: main.files,
    compare: { sets: vendor.changeSet, moduleLines: vendor.changeSet?.moduleLines },
    targetTree,
    onProgress: (text) => progress.update('vendor-old', text),
  });

  const stats = baseTree.stats;
  progress.done('vendor-old',
    `восстановлено из базы: совпадает ${stats.sameAsOurs}, модулей собрано ${stats.restoredModules}, `
    + `неизвестно ${stats.unknown}`);
  progress.message(
    'Текущая конфигурация поставщика восстановлена из самой базы: файл .cf не понадобился. '
    + `Совпадает с основной конфигурацией ${stats.sameAsOurs} файлов, тексты ${stats.restoredModules} `
    + `изменённых модулей собраны из подробного сравнения, ${stats.unknown} файлов остались `
    + 'неизвестными — по ним решение за вами.',
  );
  if (stats.unknown) {
    warnings.push(
      `По ${stats.unknown} файлам прежнее значение поставщика восстановить нельзя: отчёт сравнения `
      + 'называет изменённое свойство, но не печатает его прежнее значение. Такие места оставлены '
      + 'вашими и показаны в отчёте отличиями от новой поставки.',
    );
  }

  return {
    baseTree,
    baseProps: { name: mainProps.name, version: '', vendor: '' },
    restoreStats: stats,
  };
}

/**
 * Запись в информационную базу: загрузка, обновление конфигурации БД, проверки.
 *
 * Всё это выполняется только после явного ответа пользователя прямо в ходе
 * прогона. Флажок на форме убран намеренно: между заполнением формы и этим
 * моментом проходит время объединения, и решение принимается уже с отчётом
 * в руках.
 */
async function applyToBase({
  updateId, input, platform, conn, workRoot, progress, result, manualCount,
}) {
  progress.start('confirm', 'Ожидается решение о записи в базу');

  const answer = await progress.ask('confirm', {
    title: 'Загрузить результат в информационную базу?',
    manual: manualCount,
    infobase: conn.display,
    text: manualCount
      ? `Объединение выполнено, но ${manualCount} мест требуют вашего решения. Их можно `
        + 'разобрать в файлах выгрузки и загрузить позже кнопкой «Загрузить в конфигурацию».'
      : 'Объединение выполнено полностью, мест, требующих решения, не осталось.',
  });

  if (!answer?.ok) {
    progress.skip('confirm', 'загрузка отложена');
    for (const id of ['load', 'db-update', 'check', 'handlers']) progress.skip(id, 'не выполнялось');
    progress.message(
      'Результат объединения записан в файлы выгрузки. Загрузить его в конфигурацию можно '
      + 'кнопкой «Загрузить в конфигурацию» — после того как вы разберёте места, '
      + 'требующие решения.',
    );
    return;
  }

  progress.done('confirm', 'разрешено пользователем');

  if ((result.warnings || []).some(isBlockingWarning)) {
    progress.warn('load', 'загрузка отменена: конфигурации не совпадают');
    for (const id of ['db-update', 'check', 'handlers']) progress.skip(id, 'не выполнялось');
    progress.message(
      'Загрузка отменена: имя целевой конфигурации не совпадает с именем основной. '
      + 'Проверьте, тот ли файл .cf указан.',
      'warn',
    );
    return;
  }

  // --- Загрузка ---
  startWrite(progress, 'load', 'Конфигуратор загружает файлы (нужен монопольный доступ к базе)');
  try {
    await loadConfigFromFiles({
      platform, conn, srcDir: result.mergedDir, user: input.user, password: input.password,
      logFile: path.join(workRoot, 'designer-load.log'),
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    result.loaded = false;
    result.loadError = err.message;
    await store.updateMeta(updateId, { loadError: err.message });
    progress.warn('load', `не удалось: ${err.message}`);
    for (const id of ['db-update', 'check', 'handlers']) progress.skip(id, 'загрузка не выполнена');
    progress.message(`Загрузка в конфигурацию не выполнена: ${err.message}`, 'warn');
    return;
  }

  result.loaded = true;
  result.loadedAt = new Date().toISOString();
  await store.updateMeta(updateId, { loadedAt: result.loadedAt, loadError: null });
  progress.done('load', 'загружено в основную конфигурацию');

  // --- Обновление конфигурации базы данных ---
  startWrite(progress, 'db-update', 'Реструктуризация таблиц (может занять долго)');
  try {
    await updateDbConfig({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
    });
    result.dbUpdated = true;
    progress.done('db-update', 'конфигурация базы данных обновлена');
  } catch (err) {
    if (isCancelled(err)) throw err;
    result.dbUpdated = false;
    result.dbUpdateError = err.message;
    progress.warn('db-update', 'не выполнено');
    progress.message(`Обновление конфигурации базы данных не выполнено: ${err.message}`, 'warn');
  }

  // --- Проверки ---
  startWrite(progress, 'check', 'Синтаксический контроль конфигурации и расширений');
  result.checks = await runChecks({
    platform, conn, input, workRoot, mergedDir: result.mergedDir, progress,
  });
  reportChecks(progress, result.checks);

  await runUpdateHandlers({ platform, conn, input, workRoot, progress, result });
}

function startWrite(progress, id, detail) {
  throwIfCancelled();
  progress.start(id, detail);
}

/**
 * Синтаксический контроль и применимость расширений — с починкой и повтором.
 *
 * Требование пользователя: «если ты видишь, что проверки применимости
 * не прошли, ты их устраняешь, и снова загружаешь XML файлы в базу, и снова
 * выполняешь проверку до тех пор, пока всё не будет красиво». Чинится то,
 * что чинится однозначно, — потерявшие цель аннотации расширений
 * (`update/fixExtensions.js`); всё остальное честно уходит в отчёт.
 */
async function runChecks({ platform, conn, input, workRoot, mergedDir, progress, typical = false }) {
  const checks = { rounds: [], fixed: [], manual: [], typical };

  // Основную конфигурацию проверяем только там, где её меняли мы. После типового
  // обновления она ровно такая, какой её выпустил вендор: замечания в ней есть
  // (проверено — на чистой УНФ 3.0.14.115 их находит и сама платформа), но это
  // замечания к типовому решению, исправлять их никто не будет, а в отчёте они
  // выглядели бы следствием обновления. Требование пользователя (11.08.2026):
  // «нет смысла проверять конфигурацию, она типовая».
  if (!typical) {
    const config = await checkConfig({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
    });
    checks.config = config;
    progress.update('check', `синтаксический контроль конфигурации: замечаний ${config.errors.length}`);
  }

  // Расширения проверяются всегда: их писали не в 1С, и обновление ломает
  // именно их. Отдельный вызов с `-AllExtensions`, а не часть проверки
  // конфигурации: платформа считает это разными проверками.
  const extensionsSyntax = await checkConfig({
    platform, conn, user: input.user, password: input.password, workDir: workRoot,
    scope: 'extensions',
  });
  checks.extensionsSyntax = extensionsSyntax;
  progress.update('check', `синтаксический контроль расширений: замечаний ${extensionsSyntax.errors.length}`);

  for (let round = 1; round <= FIX_ROUNDS; round += 1) {
    throwIfCancelled();
    progress.update('check', `проверка применимости расширений, попытка ${round}`);
    const applicable = await checkExtensionsApplicable({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
    });
    checks.extensions = applicable;
    checks.rounds.push({
      round, ok: applicable.ok, errors: applicable.errors?.length || 0, note: applicable.note || '',
    });

    if (applicable.ok || !applicable.available) break;
    if (round === FIX_ROUNDS) break;

    // Починка аннотаций сверяет расширение с текстами основной конфигурации,
    // а их даёт только XML-выгрузка. При типовом обновлении её нет намеренно,
    // поэтому здесь честный отказ, а не тихое «ничего не нашлось».
    if (!mergedDir) {
      checks.manual.push({
        reason: 'Расширения не применяются. Проверить, какие аннотации потеряли цель, '
          + 'программа здесь не может: для этого нужна XML-выгрузка конфигурации, а типовое '
          + 'обновление обходится без неё. Откройте расширения в конфигураторе либо запустите '
          + 'обновление объединением, указав текущую поставку файлом.',
      });
      break;
    }

    progress.update('check', 'расширения не применяются — разбираем причины');
    const dumped = await exportExtensions({
      platform, conn, workDir: path.join(workRoot, `ext-fix-${round}`),
      user: input.user, password: input.password,
    });
    if (!dumped.extensions.length) break;

    const fix = await fixExtensionAnnotations({
      extensions: dumped.extensions, mainDir: mergedDir,
    });
    checks.fixed.push(...fix.fixed);
    checks.manual.push(...fix.manual);
    if (!fix.changedExtensions.length) break;

    for (const name of fix.changedExtensions) {
      const dir = dumped.extensions.find((e) => e.name === name)?.dir;
      if (!dir) continue;
      progress.update('check', `загрузка исправленного расширения «${name}»`);
      try {
        await loadConfigFromFiles({
          platform, conn, srcDir: dir, extension: name,
          user: input.user, password: input.password,
          logFile: path.join(workRoot, `designer-ext-load-${round}.log`),
        });
      } catch (err) {
        if (isCancelled(err)) throw err;
        checks.manual.push({
          extension: name,
          reason: `Исправленное расширение не загрузилось: ${err.message}`,
        });
      }
    }
  }

  return checks;
}

async function save(updateId, result) {
  await store.saveResult(updateId, result);
  await store.saveReport(updateId, renderUpdateReport(result));
}

/**
 * Загрузка ранее объединённой выгрузки в конфигурацию — отдельным действием.
 *
 * Нужна, когда на вопрос в ходе прогона ответили «не сейчас»: человек разобрал
 * дважды изменённые места прямо в файлах выгрузки (иногда на другой день)
 * и только потом загружает результат. Поэтому загрузка не привязана к прогону
 * и берёт каталог из его результата.
 *
 * Пароль в результате не хранится (`sanitize`), поэтому он передаётся заново.
 */
export async function loadUpdateResult({ updateId, user, password, updateDb = true }) {
  const meta = await store.getMeta(updateId);
  const result = await store.getResult(updateId);
  if (!meta || !result) throw new Error('Прогон объединения не найден');
  if (!result.mergedDir || !(await pathExists(result.mergedDir))) {
    throw new Error(
      'Каталог с объединённой выгрузкой больше не существует: '
      + `${result.mergedDir || 'путь не сохранён'}. Выполните объединение заново.`,
    );
  }
  if ((result.warnings || []).some(isBlockingWarning)) {
    throw new Error(
      'Загрузка запрещена: имя целевой конфигурации не совпадает с именем основной. '
      + 'Похоже, при объединении был указан файл другой конфигурации.',
    );
  }

  const { platform } = await resolvePlatform(meta.input?.platformVersion || result.platformVersion);
  const conn = parseConnection(meta.input?.infobasePath || result.infobase?.display);
  const workRoot = path.dirname(result.mergedDir);

  await loadConfigFromFiles({
    platform,
    conn,
    srcDir: result.mergedDir,
    user: user || meta.input?.user || '',
    password: password || '',
    logFile: path.join(workRoot, 'designer-load.log'),
  });

  const loadedAt = new Date().toISOString();
  result.loaded = true;
  result.loadedAt = loadedAt;

  if (updateDb) {
    try {
      await updateDbConfig({
        platform, conn, user: user || meta.input?.user || '', password: password || '',
        workDir: workRoot,
      });
      result.dbUpdated = true;
    } catch (err) {
      result.dbUpdated = false;
      result.dbUpdateError = err.message;
    }
  }

  await save(updateId, result);
  await store.updateMeta(updateId, { loadedAt, loadError: null });
  log.info(`Объединение ${updateId} загружено в конфигурацию базы`);
  return { loadedAt, dbUpdated: result.dbUpdated === true, dbUpdateError: result.dbUpdateError || '' };
}

/**
 * Целевая конфигурация: файл .cf разворачивается в XML, каталог берётся как есть.
 *
 * Каталог принимается наравне с файлом по той же причине, что и у конфигурации
 * поставщика в обследовании: XML-выгрузка новой поставки у интегратора часто
 * уже есть, и заставлять его собирать из неё .cf ради нашего удобства незачем.
 */
async function prepareTarget({ input, platform, workRoot, progress }) {
  const raw = String(input.targetConfigPath || '').trim();
  if (!raw) throw new Error('Не указана целевая конфигурация (файл .cf новой поставки)');

  const target = path.resolve(raw);
  if (!(await pathExists(target))) {
    throw new Error(`Целевая конфигурация не найдена: ${target}`);
  }

  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    if (!(await pathExists(path.join(target, 'Configuration.xml')))) {
      throw new Error(`В каталоге целевой конфигурации нет Configuration.xml: ${target}`);
    }
    return { dir: target, source: 'dump' };
  }

  if (!/\.cf$/i.test(target)) {
    throw new Error('Целевая конфигурация задаётся файлом .cf либо каталогом XML-выгрузки');
  }

  progress.update('vendor-new', 'Разворачивание .cf новой поставки во временную базу');
  const expanded = await exportCfToXml({
    cfFile: target,
    platform,
    workDir: workRoot,
    name: 'target',
    onProgress: (text) => progress.update('vendor-new', text),
  });
  if (!expanded.ok) throw new Error(expanded.reason);
  return { dir: expanded.dir, source: 'cf' };
}

/**
 * Сверка трёх конфигураций между собой.
 *
 * Указать не тот .cf — самая вероятная ошибка на этой форме, и цена её высока:
 * объединение двух неродственных конфигураций даёт тысячи конфликтов и мусор
 * в выгрузке. Поэтому расхождение имён — громкое предупреждение, а запись
 * в базу оно запрещает совсем (см. isBlockingWarning).
 */
function checkTarget({ mainProps, baseProps, targetProps, warnings, progress }) {
  if (targetProps.name && mainProps.name && targetProps.name !== mainProps.name) {
    const text = `Имя целевой конфигурации («${targetProps.name}») не совпадает с именем `
      + `основной («${mainProps.name}»). Похоже, указан файл другой конфигурации. `
      + 'Объединение выполнено, но загружать его в базу нельзя, пока это не выяснено.';
    warnings.push(text);
    progress.message(text, 'warn');
  }

  if (baseProps.version && targetProps.version && baseProps.version === targetProps.version) {
    const text = `Версии текущей и новой поставки совпадают (${targetProps.version}) — `
      + 'возможно, указан один и тот же файл. Обновлять нечего.';
    warnings.push(text);
    progress.message(text, 'warn');
  }
}

function isBlockingWarning(text) {
  return /не совпадает с именем/.test(text);
}

function sanitize(input) {
  const { password, ...rest } = input || {};
  return { ...rest, hasPassword: Boolean(password) };
}
