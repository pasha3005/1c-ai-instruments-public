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
import { exportConfiguration, exportExtensions, countExtensions } from '../onec/collector.js';
import { loadConfigFromFiles } from '../onec/designer.js';
import { checkModules, checkExtensionsApplicable, updateDbConfig } from '../onec/checkConfig.js';
import {
  prepareVendorConfig, exportCfToXml, readConfigurationProperties,
} from '../analyze/vendorConfig.js';
import { findVendorRelease } from '../onec/templates.js';
import { vendorConfigPresence, compareVendorWithTarget } from '../onec/vendorCompare.js';
import {
  launchEnterprise, waitUpdateApplied, waitResultsForm, updateSessionArgs,
  confirmUpdateLegality, deferredStatusText, runInfobaseUpdate, readUpdateState,
} from '../onec/enterprise.js';
import { updateCfgFromFile } from '../onec/updateCfg.js';
import { mergeConfigurations, dirTree, CONFLICT_DIR } from '../update/mergeConfig.js';
import { unresolvedCount, unresolvedByKind } from '../update/mergeReview.js';
import { restoreVendorTree } from '../update/vendorSources.js';
import { findParentCf } from '../update/parentCf.js';
import { fixExtensionAnnotations } from '../update/fixExtensions.js';
import { mergeExtensionSources } from '../update/extensionMerge.js';
import { checksLeft, buildCheckItems } from '../update/checkReview.js';
import { renderUpdateReport } from '../report/updateReport.js';
import { plural } from '../report/ui.js';
import * as store from '../store/updateStore.js';
import { ensureDir, pathExists, rmrf, dirSize, humanSize } from '../util/fsx.js';
import { removeUpdateOwnEntries } from '../util/workDir.js';
import { createLogger } from '../util/logger.js';
import { runCancellable, throwIfCancelled, isCancelled, CANCEL_MESSAGE } from '../util/cancel.js';

const log = createLogger('update');

/** Сколько раз чинить расширения и повторять проверку применимости. */
const FIX_ROUNDS = 3;

/**
 * Сколько кругов «разобрать ошибки → проверить заново» допускается.
 *
 * Предел нужен не ради экономии: если человек правит одно и то же без конца,
 * обновление всё равно должно завершиться, а не висеть в ожидании.
 */
const CHECK_REVIEW_ROUNDS = 4;

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

    // Текущая поставка чаще всего лежит прямо здесь же: выгружая конфигурацию
    // на поддержке, платформа кладёт .cf поставщика рядом с её настройкой
    // (`Ext/ParentConfigurations/<Имя>.cf`). Тогда восстанавливать поставку
    // по отчёту сравнения не нужно вовсе — она у нас целиком и настоящая.
    const parentCf = vendorGiven ? null : await findParentCf(exported.dir);
    if (parentCf?.ok) {
      progress.message(
        `Текущая конфигурация поставщика найдена в самой выгрузке: ${path.basename(parentCf.file)}, `
        + `${humanSize(parentCf.size)}${parentCf.version ? `, релиз ${parentCf.version}` : ''}. `
        + 'Платформа кладёт её рядом с настройкой поддержки при каждой выгрузке конфигурации '
        + 'в файлы, поэтому объединение пойдёт по настоящей поставке, а не по восстановленной '
        + 'из отчёта сравнения.',
      );
    } else if (parentCf) {
      log.info(`Конфигурация поставщика в выгрузке не найдена: ${parentCf.reason}`);
    }

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

    // ---------- 7. Что поставщик изменил в новом релизе ----------
    // Второе сравнение той же командой платформы: конфигурация поставщика
    // из базы против файла новой поставки. Без него о правках поставщика
    // в СВОЙСТВАХ судить нечем — первый отчёт называет свойство, но прежнего
    // значения не печатает, и «изменили оба» приходится не доказывать,
    // а предполагать.
    startStage('vendor-ahead', 'Сравнение конфигурации поставщика с новой поставкой');
    const ahead = await vendorAheadChanges({
      input, platform, conn, workRoot, mainProps, progress, parentCf,
    });

    // ---------- 8. Текущая конфигурация поставщика ----------
    startStage('vendor-old', 'Подготовка текущей конфигурации поставщика');
    const vendorCtx = {
      platform, conn, workDir: workRoot, user: input.user, password: input.password,
      configName: mainProps.name,
      totalEntries: 0,
      onProgress: (text) => progress.update('vendor-old', text),
    };
    let vendor = await prepareVendorConfig({
      vendorPath: input.vendorConfigPath || (parentCf?.ok ? parentCf.file : ''),
      ...vendorCtx,
    });

    // Поставка из выгрузки не развернулась (не хватило места, платформа
    // отказала). Прогон из-за этого не теряется: поставщика по-прежнему видно
    // из самой базы, и дальше работает восстановление по отчёту сравнения —
    // ровно так, как до появления этого источника.
    if (!vendor.available && parentCf?.ok && !String(input.vendorConfigPath || '').trim()) {
      progress.warn('vendor-old', `поставку из выгрузки развернуть не удалось: ${vendor.reason}`);
      warnings.push(
        `Конфигурацию поставщика, найденную в выгрузке (${path.basename(parentCf.file)}), развернуть `
        + `не удалось: ${vendor.reason} Текущая поставка восстановлена из самой базы по отчёту `
        + 'сравнения — по свойствам объектов она менее точна.',
      );
      vendor = await prepareVendorConfig({ vendorPath: '', ...vendorCtx });
    }

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
      vendor, exported, targetTree, mainProps, progress, warnings, ahead,
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
      // Текущая поставка, взятая из самой выгрузки: её никто не указывал
      // и не выгружал руками — платформа положила .cf рядом с настройкой
      // поддержки. Отчёт обязан говорить об этом прямо, иначе выйдет, что
      // файл «был предоставлен».
      parentCf: !vendorGiven && parentCf?.ok && vendor.source === 'cf'
        ? {
          name: parentCf.name,
          version: parentCf.version,
          vendor: parentCf.vendor,
          size: parentCf.size,
          file: parentCf.file,
        }
        : null,
      restore: restoreStats,
      // Итог второго сравнения — что поставщик изменил сам. null означает,
      // что сравнения не было: указан .cf, снят флаг либо платформа отказала.
      vendorAhead: ahead ? {
        modified: ahead.modified.size,
        added: ahead.addedByVendor.size,
        removed: ahead.removedByVendor.size,
      } : null,
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

    // ---------- 11. Очистка каталога выгрузки — по флагу ----------
    startStage('cleanup');
    await cleanupUpdateDump({ progress, workRoot, keep: input.keepDump === true, keepResult: !result.loaded });

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
  for (const id of ['export-main', 'vendor-new', 'vendor-ahead', 'vendor-old', 'merge']) {
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

  // ---------- Очистка каталога выгрузки — по флагу ----------
  throwIfCancelled();
  progress.start('cleanup');
  await cleanupUpdateDump({ progress, workRoot, keep: input.keepDump === true, keepResult: !result.loaded });

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

  startWrite(progress, 'check', 'Проверка модулей расширений');
  await checksWithReview({
    updateId, platform, conn, input, workRoot, mergedDir: '', progress, result, typical: true,
  });

  await runUpdateHandlers({ platform, conn, input, workRoot, progress, result });
}

/**
 * Обработчики обновления — последний шаг, и весь он укладывается в ОДНО окно 1С.
 *
 * Требование пользователя (12.08.2026): «Я хочу, чтобы ты всё обновление сделал
 * в одном окне 1С в режиме предприятия, последовательно». Порядок такой:
 *
 *   1. подтверждаем легальность получения обновления — иначе БСП обработчики
 *      не начнёт и будет ждать человека;
 *   2. выполняем обработчики через внешнее соединение, без окна, — штатной
 *      неинтерактивной функцией БСП;
 *   3. запускаем единственный сеанс 1С сразу на форме результатов обновления
 *      и оставляем его открытым.
 *
 * Раньше окон было два: одно выполняло обработчики, второе открывалось ради
 * формы. Второе окно было ошибкой — и, как выяснилось, форму нельзя удержать
 * открытой в том же сеансе, который делает обновление: БСП закрывает окна
 * вместе со своим окном «Обновление версии приложения».
 *
 * Конфигурацию здесь не меняем. Записей в базу ровно две, и обе — то, что
 * в интерфейсе делает сам человек: подтверждение легальности и, собственно,
 * работа обработчиков обновления.
 */
async function runUpdateHandlers({ platform, conn, input, workRoot, progress, result }) {
  startWrite(progress, 'handlers', 'Подтверждение легальности получения обновления');

  const handlers = { launched: false, exclusiveSeconds: null };
  result.handlers = handlers;

  // Подтверждение — ДО запуска клиента: подтверждённое заранее, оно не даёт
  // форме легальности открыться вовсе, и монопольные обработчики начинаются сами.
  // Этим же вызовом читается форма результатов обновления: её полное имя нужно
  // ключу /URL при запуске, то есть ДО того, как клиент стартовал.
  const legality = await confirmUpdateLegality({
    platform, conn, user: input.user, password: input.password, workDir: workRoot,
  });
  handlers.legality = legality;
  handlers.formMeta = legality.form || null;
  reportLegality(progress, legality);

  // Обработчики — без окна, штатной неинтерактивной функцией БСП. Так окно 1С
  // остаётся ровно одно, и запускается оно уже с открытой формой результатов.
  progress.update('handlers', 'выполнение обработчиков обновления');
  const applied = await runHandlersQuietly({
    platform, conn, input, workRoot, progress, handlers,
  });
  if (!applied) return;

  // Флаг «Открывать базу для просмотра формы результатов обновления»: обработчики
  // уже выполнены без единого окна 1С, и всё, что осталось, — необязательный шаг
  // просмотра. Требование пользователя: снят флаг — база вообще не открывается.
  if (input.openResultsForm !== true) {
    handlers.form = {
      opened: false,
      reason: 'флаг «Открывать базу для просмотра формы результатов обновления» снят — '
        + 'база не открывается',
    };
    progress.message(
      'База в режиме предприятия не запускалась: флаг «Открывать базу для просмотра формы '
      + 'результатов обновления» снят. Итог обновления можно посмотреть, войдя в базу самим: '
      + '«Администрирование → Обслуживание → Результаты обновления и дополнительная обработка данных».',
    );
    reportDeferred(progress, handlers);
    return;
  }

  // Единственное окно 1С: обработчики уже выполнены, и сеанс нужен ровно затем,
  // чтобы открыть форму результатов обновления и оставить её открытой.
  progress.update('handlers', 'Запуск 1С в режиме предприятия');
  try {
    const { pid } = launchEnterprise({
      platform,
      conn,
      user: input.user,
      password: input.password,
      extraArgs: updateSessionArgs(handlers.formMeta),
    });
    handlers.launched = true;
    handlers.pid = pid;
    progress.message(
      'Запущена 1С в режиме предприятия — одним окном, и это единственное окно за весь прогон. '
      + (handlers.formMeta
        ? 'В нём сразу открывается форма результатов обновления; окно остаётся открытым — '
          + 'в нём потом работаете вы.'
        : 'Форму результатов обновления открыть нечем: в метаданных базы она не найдена.'),
    );
  } catch (err) {
    if (isCancelled(err)) throw err;
    handlers.error = err.message;
    progress.warn('handlers', `1С не запущена: ${err.message}`);
    progress.message(
      `Обработчики обновления выполнены, но запустить 1С не удалось: ${err.message}. `
      + 'Войдите в базу сами; итог обновления виден в «Администрирование → Обслуживание → '
      + 'Результаты обновления и дополнительная обработка данных».',
      'warn',
    );
    return;
  }

  progress.update('handlers', 'ожидание формы результатов обновления');
  handlers.form = handlers.formMeta
    ? await waitResultsForm({
      processId: handlers.pid, form: handlers.formMeta, workDir: workRoot,
    })
    : { opened: false, reason: 'форма результатов обновления в метаданных базы не найдена' };
  reportForm(progress, handlers.form);

  reportDeferred(progress, handlers);
}

/**
 * Итог по отложенным обработчикам — словами БСП, а не догадками.
 *
 * Пустая строка у БСП значит «необработанных не осталось», `null` — «спросить
 * не удалось»; выдавать второе за первое нельзя.
 */
function reportDeferred(progress, handlers) {
  if (handlers.deferredStatus === '') {
    progress.done('handlers', 'обработчики обновления выполнены');
    progress.message(
      'Обновление информационной базы закончено: необработанных отложенных обработчиков '
      + 'у БСП не осталось.',
    );
    return;
  }

  if (handlers.deferredStatus === null || handlers.deferredStatus === undefined) {
    progress.done('handlers', 'обработчики обновления выполнены');
    progress.message(
      'Обновление информационной базы выполнено. Состояние отложенных обработчиков спросить '
      + 'у БСП не удалось — посмотрите его в форме результатов обновления.',
    );
    return;
  }

  progress.warn('handlers', 'отложенные обработчики выполнены не полностью');
  progress.message(
    `Монопольная часть обновления закончена, но ${deferredStatusText(handlers.deferredStatus)}. `
    + 'БСП выполняет их порциями и продолжит сама. '
    + (handlers.form?.opened
      ? `Ход виден в открытой форме «${handlers.form.title}» — она остаётся открытой.`
      : 'Ход виден в 1С: «Администрирование → Обслуживание → Результаты обновления '
        + 'и дополнительная обработка данных».'),
    'warn',
  );
}

/**
 * Выполняет обработчики обновления без окна — и честно отчитывается.
 *
 * Основной путь: неинтерактивная функция БСП через внешнее соединение. Она для
 * этого и сделана, а нам даёт главное — окно 1С остаётся ровно одно и
 * открывается уже с формой результатов.
 *
 * Запасной путь нужен там, где спросить БСП нечем (не БСП-конфигурация либо
 * у общих модулей снят флаг «Внешнее соединение»): тогда обработчики выполняет
 * сама платформа при входе в базу, а программа ждёт их завершения. Форма в этом
 * случае может и не открыться — БСП закрывает окна вместе со своим окном
 * обновления, — и об этом говорится прямо, а не замалчивается.
 *
 * @returns {Promise<boolean>} можно ли продолжать (запускать окно и форму)
 */
async function runHandlersQuietly({ platform, conn, input, workRoot, progress, handlers }) {
  const ctx = {
    platform, conn, user: input.user, password: input.password, workDir: workRoot,
  };

  // Пока идёт обновление, показываем, сколько оно длится: вызов синхронный,
  // и без этого шкала выглядит замершей.
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    progress.update('handlers', `обработчики обновления выполняются, ${seconds} с`);
  }, 10_000);

  let run;
  try {
    run = await runInfobaseUpdate(ctx);
  } finally {
    clearInterval(ticker);
  }

  handlers.run = run;
  handlers.exclusiveSeconds = run.seconds;

  if (run.ok) {
    const state = await readUpdateState(ctx);
    handlers.deferredStatus = state.deferredStatus;
    progress.message(
      run.result === 'НеТребуется'
        ? 'Обработчики обновления не потребовались: БСП отвечает, что обновление информационной '
          + 'базы не нужно.'
        : `Обработчики обновления выполнены за ${run.seconds} с — неинтерактивно, через внешнее `
          + 'соединение. Это штатный путь БСП: у её функции так и написано — «для вызова через '
          + 'внешнее соединение». Отдельного окна 1С для этого не открывалось.',
    );
    return true;
  }

  if (run.exclusiveFailed) {
    handlers.error = run.reason;
    progress.warn('handlers', 'не удалось занять базу монопольно');
    progress.message(
      'Обработчики обновления не выполнены: БСП не смогла установить монопольный режим — '
      + 'в базе есть другие сеансы. Закройте их и повторите: обработчики выполнятся при первом '
      + 'входе в базу либо повторным запуском этого шага.',
      'warn',
    );
    return false;
  }

  // Спросить БСП нечем — остаётся прежний путь: вход в базу и ожидание. База
  // открывается независимо от флага «Открывать базу…»: это единственный способ
  // выполнить монопольные обработчики в этом случае, а не просмотр результата.
  // Флаг решает только последнее — вести ли этот же сеанс сразу на форму.
  const showForm = input.openResultsForm === true;
  progress.message(
    `Неинтерактивное обновление недоступно: ${run.reason}. Тогда обработчики выполнит сама `
    + 'платформа при входе в базу — запускаю 1С и жду (это не связано с флагом «Открывать базу '
    + 'для просмотра формы результатов обновления»: без окна здесь обработчики не выполнить). '
    + (showForm
      ? 'Форма результатов обновления в этом случае может не открыться: БСП закрывает окна '
        + 'вместе со своим окном обновления.'
      : 'Флаг снят, поэтому на форму результатов сеанс не наводится.'),
    'warn',
  );

  try {
    const { pid } = launchEnterprise({
      platform, conn, user: input.user, password: input.password,
      extraArgs: showForm ? updateSessionArgs(handlers.formMeta) : [],
    });
    handlers.launched = true;
    handlers.pid = pid;
  } catch (err) {
    if (isCancelled(err)) throw err;
    handlers.error = err.message;
    progress.warn('handlers', `1С не запущена: ${err.message}`);
    progress.message(
      `Не удалось запустить 1С в режиме предприятия: ${err.message}. Обработчики обновления `
      + 'выполнятся при первом входе в базу — войдите в неё сами.',
      'warn',
    );
    return false;
  }

  const waited = await waitUpdateApplied({
    ...ctx, onProgress: (text) => progress.update('handlers', text),
  });
  handlers.exclusiveSeconds = waited.seconds;
  handlers.askedBsp = waited.askedBsp;
  handlers.deferredStatus = waited.deferredStatus;

  if (!waited.ok) {
    handlers.error = waited.reason;
    progress.warn('handlers', `обработчики не завершились за ${waited.seconds} с`);
    progress.message(
      `Обновление информационной базы не завершилось за ${Math.round(waited.seconds / 60)} мин: `
      + `${waited.reason}. `
      + (waited.legalityWaiting
        ? 'В открытом окне 1С поставьте галочку в форме «Легальность получения обновления» '
          + 'и нажмите «Продолжить» — без этого БСП обработчики не начнёт. '
        : '')
      + 'Окно 1С осталось открытым: ход виден в «Администрирование → Обслуживание → '
      + 'Результаты обновления и дополнительная обработка данных».',
      'warn',
    );
    return false;
  }

  progress.message(`Обработчики обновления отработали за ${waited.seconds} с.`);
  // Окно уже открыто этим путём: второго не запускаем.
  if (showForm) {
    handlers.form = handlers.formMeta
      ? await waitResultsForm({
        processId: handlers.pid, form: handlers.formMeta, workDir: workRoot, budgetMs: 30_000,
      })
      : { opened: false, reason: 'форма результатов обновления в метаданных базы не найдена' };
    reportForm(progress, handlers.form);
  } else {
    handlers.form = {
      opened: false,
      reason: 'флаг «Открывать базу для просмотра формы результатов обновления» снят — '
        + 'на форму не наводились',
    };
  }
  reportDeferred(progress, handlers);
  return false;
}

/**
 * Сообщение о подтверждении легальности получения обновления.
 *
 * Говорится вслух всегда, когда подтверждение потребовалось: программа делает
 * от имени пользователя то, что в интерфейсе делает он сам галочкой и кнопкой
 * «Продолжить», и умолчать об этом нельзя.
 */
function reportLegality(progress, legality) {
  if (!legality) return;

  if (legality.confirmed) {
    progress.message(
      'БСП не начинает обработчики обновления, пока не подтверждена легальность получения '
      + 'обновления: при первом входе в базу она открывает форму «Легальность получения '
      + 'обновлений» и ждёт человека. Подтвердил за вас — той же процедурой БСП, которую '
      + 'вызывает кнопка «Продолжить»; проверено: подтверждения БСП больше не требует. '
      + 'Согласие на отправку статистики в центр мониторинга, которое та же форма предлагает '
      + 'рядом, программа не трогает — это ваше отдельное решение.',
    );
    return;
  }

  if (legality.needed === false) {
    progress.update('handlers', 'подтверждение легальности обновления не требуется');
    return;
  }

  progress.message(
    `Подтвердить легальность получения обновления не удалось: ${legality.reason || 'причина неизвестна'}. `
    + (legality.bspAvailable
      ? 'Если 1С откроет форму «Легальность получения обновлений» — поставьте галочку и нажмите '
        + '«Продолжить»: пока этого не сделать, монопольные обработчики обновления не начнутся.'
      : 'Спросить об этом БСП нечем — либо это не БСП-конфигурация, либо у общих модулей '
        + 'обновления информационной базы снят флаг «Внешнее соединение». Если 1С откроет форму '
        + '«Легальность получения обновлений» — подтвердите её сами.'),
    'warn',
  );
}

/**
 * Сообщение о форме результатов обновления.
 *
 * Разделено на «открыл» и «не открыл» намеренно: сказать «форма открыта», не
 * дождавшись окна, значит соврать — а проверка открытия у нас как раз есть.
 */
function reportForm(progress, form) {
  if (form?.opened) {
    progress.message(
      `В том же окне 1С открыта форма «${form.title}» — в ней виден итог обновления и `
      + 'состояние отложенных обработчиков. Форма остаётся открытой: закрывать её не нужно, '
      + 'пока обработчики идут. В интерфейсе она же — «Администрирование → Обслуживание → '
      + 'Результаты обновления и дополнительная обработка данных».',
    );
    return;
  }
  progress.message(
    `Форма результатов обновления в окне 1С не появилась: ${form?.reason || 'причина неизвестна'}. `
    + 'Откройте её сами в том же окне: «Администрирование → Обслуживание → Результаты обновления '
    + 'и дополнительная обработка данных».',
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
 * Что поставщик изменил сам — сравнение его конфигурации с новой поставкой.
 *
 * Отвечает на вопрос, на который первое сравнение ответить не может. Отчёт
 * «основная ↔ поставщик» называет свойства, которые менял интегратор, но
 * прежних значений не печатает, а выгрузить конфигурацию поставщика в файл
 * из командной строки нельзя. Значит «изменили оба» приходилось предполагать.
 * Второе сравнение — той же командой, но сторонами «поставщик ↔ файл новой
 * поставки» — говорит прямо, какие объекты и свойства поставщик тронул
 * в новом релизе. Пересечение с нашими правками и есть настоящие спорные
 * места; всё остальное решается само.
 *
 * **Выполняется всегда**, и флажка на форме у него нет — прямое требование
 * пользователя 27.08.2026: «это хорошее решение, и оно должно работать
 * всегда». Пропускается ровно там, где ответ и без него точен либо получить
 * его нечем, и оба случая — не сбой:
 *  * текущая поставка указана файлом .cf. Тогда точка отсчёта есть, и она
 *    точнее любого отчёта;
 *  * новая поставка задана не файлом, а каталогом выгрузки: второй стороной
 *    сравнения платформа принимает только `.cf`.
 */
async function vendorAheadChanges({
  input, platform, conn, workRoot, mainProps, progress, parentCf = null,
}) {
  if (String(input.vendorConfigPath || '').trim()) {
    progress.skip('vendor-ahead', 'не нужно: текущая поставка указана файлом');
    return null;
  }

  // Поставка есть целиком — прежние значения свойств известны точно, и второе
  // сравнение доказывать больше нечего.
  if (parentCf?.ok) {
    progress.skip('vendor-ahead', 'не нужно: текущая поставка есть в выгрузке');
    return null;
  }

  const targetFile = String(input.targetConfigPath || '').trim();
  if (!/\.cfe?$/i.test(targetFile)) {
    progress.skip('vendor-ahead', 'новая поставка задана не файлом .cf');
    return null;
  }

  const ahead = await compareVendorWithTarget({
    platform,
    conn,
    workDir: workRoot,
    configName: mainProps.name,
    targetFile,
    user: input.user,
    password: input.password,
    onProgress: (text) => progress.update('vendor-ahead', text),
  });

  if (!ahead.ok) {
    // Не удалось — работаем как раньше. Терять из-за этого весь прогон нельзя:
    // сравнение уточняет разбор, но не является его условием.
    progress.warn('vendor-ahead', `не выполнено: ${ahead.reason}`);
    progress.message(
      `Сравнение конфигурации поставщика с новой поставкой не выполнено: ${ahead.reason} `
      + 'Объединение продолжается без него: свойства, изменённые вами, останутся вашими, '
      + 'но проверить, менял ли их и поставщик, будет нечем.',
      'warn',
    );
    return null;
  }

  progress.done('vendor-ahead',
    `поставщик изменил ${ahead.modified.size}, добавил ${ahead.addedByVendor.size}, `
    + `убрал ${ahead.removedByVendor.size}`);
  return ahead;
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
async function prepareBase({ vendor, exported, targetTree, mainProps, progress, warnings, ahead }) {
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
    // Подробности (изменённые свойства, реквизиты, табличные части) нужны
    // не только отчёту: по ним объединение разбирает XML, прежнего состояния
    // которого у поставщика мы не знаем.
    compare: {
      sets: vendor.changeSet,
      moduleLines: vendor.changeSet?.moduleLines,
      details: vendor.details || null,
    },
    targetTree,
    // Второе сравнение: что поставщик изменил сам. Им доказывается, что
    // тронутое нами свойство он не трогал, — и место перестаёт быть спорным.
    ahead,
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
    + 'неизвестными — по ним решение за вами.'
    + (stats.fromTarget
      ? ` Ещё по ${stats.fromTarget} описаниям объектов поставка взята из нового релиза: `
        + 'второе сравнение показало, что поставщик их не менял, — значит в текущей поставке '
        + 'они были такими же.'
      : ''),
  );
  if (stats.unknown) {
    // Число без имён ничего не объясняет: «неизвестно 3» читатель прочтёт как
    // «программа чего-то не поняла». Называем файлы поимённо — по ним потом
    // и принимается решение.
    const listed = (stats.unknownFiles || []).slice(0, 10);
    warnings.push(
      `По ${plural(stats.unknown, 'файлу', 'файлам', 'файлам')} прежнее значение `
      + 'поставщика восстановить нельзя: отчёт сравнения называет изменённое свойство, но не '
      + 'печатает его прежнее значение. Такие места оставлены вашими и показаны в отчёте '
      + 'отличиями от новой поставки.'
      + (listed.length
        ? ` Это ${listed.join(', ')}${stats.unknown > listed.length
          ? ` и ещё ${stats.unknown - listed.length}` : ''}.`
        : ''),
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
 *
 * **Пока есть неразобранные спорные места, записать в базу не предлагается** —
 * прямое требование пользователя (26.08.2026): «никогда не предлагай записать
 * изменения в базу, если есть спорные места». Но и бросать прогон нельзя:
 * второе требование того же дня — «приостанови прогресс перед загрузкой
 * и жди, пока я не подтвержу, что всё разобрано; и только после подтверждения
 * продолжай». Поэтому конвейер ЖДЁТ здесь: вопрос задаётся сразу, но кнопка
 * записи в нём недоступна, пока в окне разбора остаётся хоть одно место.
 * Разобрав их, человек отвечает — и прогон идёт дальше уже с его решениями,
 * они лежат в тех же файлах выгрузки.
 *
 * Согласие проверяется ещё раз на сервере (`/answer`): между показом вопроса
 * и ответом проходит сколько угодно времени, и полагаться на то, что кнопку
 * нельзя нажать, нельзя.
 */
/**
 * Одна фраза о том, чего ждёт прогон.
 *
 * Роды мест разные, и смешивать их в одно число нельзя: нерешённое — работа,
 * которую придётся сделать, а разобранное программой — чужое решение, которое
 * человек должен увидеть прежде, чем оно уедет в базу.
 */
function waitingSentence({ manual, auto }) {
  if (manual && auto) {
    return `Объединение выполнено. Спорных мест: ${manual} требуют вашего решения, `
      + `ещё ${auto} программа разобрала сама — их нужно просмотреть и подтвердить.`;
  }
  if (manual) {
    return `Объединение выполнено, но спорных мест, требующих вашего решения, ${manual}.`;
  }
  return 'Объединение выполнено, решать вручную нечего: спорных мест, разобранных программой, '
    + `${auto}. Их нужно просмотреть и подтвердить — в базу уйдёт именно то, что она решила.`;
}

async function applyToBase({
  updateId, input, platform, conn, workRoot, progress, result, manualCount,
}) {
  // Ждёт человека не только нерешённое: места, разобранные программой, тоже
  // ждут — просмотра и подтверждения (требование пользователя 27.08.2026).
  const waiting = unresolvedByKind(result, await store.getReviewState(updateId));

  progress.start('confirm', waiting.total > 0
    ? `Ожидается разбор спорных мест: ${waiting.total}`
    : 'Ожидается решение о записи в базу');

  if (waiting.total > 0) {
    progress.message(
      `${waitingSentence(waiting)} Прогон приостановлен и ждёт: откройте «Разобрать спорные `
      + 'места» — там видно, что программа объединила сама, а что осталось вам, и там же '
      + 'правится и сохраняется результат. Когда неразобранных мест не останется, нажмите '
      + '«Всё разобрано — записать в базу», и прогон продолжится с вашими решениями.',
      'warn',
    );
  }

  const answer = await progress.ask('confirm', {
    title: waiting.total > 0
      ? 'Разберите спорные места — и прогон продолжится'
      : 'Загрузить результат в информационную базу?',
    kind: waiting.total > 0 ? 'review' : 'plain',
    updateId,
    manual: manualCount,
    infobase: conn.display,
    text: waiting.total > 0
      ? `${waitingSentence(waiting)} Пока хоть одно место не разобрано, записать в базу `
        + 'нельзя: в нерешённом месте в выгрузке лежит ваша версия участка, а правка '
        + 'поставщика в нём потеряна, а решение программы — предположение, которое вы '
        + 'ещё не видели.'
      : 'Объединение выполнено полностью, мест, требующих вашего внимания, не осталось.',
  });

  if (!answer?.ok) {
    progress.skip('confirm', 'загрузка отложена');
    for (const id of ['load', 'db-update', 'check', 'handlers']) progress.skip(id, 'не выполнялось');
    progress.message(
      'Результат объединения записан в файлы выгрузки. Загрузить его в конфигурацию можно '
      + 'кнопкой «Загрузить в конфигурацию» — когда сочтёте нужным.',
    );
    return;
  }

  // Последняя проверка перед записью: между показом вопроса и ответом прошло
  // сколько угодно времени, и полагаться на то, что кнопку нельзя нажать,
  // нельзя. Считается тем же счётчиком, что и застава у кнопки «Загрузить
  // в конфигурацию».
  const left = unresolvedCount(result, await store.getReviewState(updateId));
  if (left > 0) {
    progress.warn('confirm', `загрузка отменена: не разобрано ${left}`);
    for (const id of ['load', 'db-update', 'check', 'handlers']) progress.skip(id, 'не выполнялось');
    progress.message(
      `Загрузка отменена: спорных мест, ожидающих вас, ещё ${left}. Разберите нерешённые `
      + 'и подтвердите те, что программа разобрала сама, — в окне «Разобрать спорные места», '
      + 'и запустите загрузку кнопкой «Загрузить в конфигурацию».',
      'warn',
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
  startWrite(progress, 'check', 'Проверка модулей и применимость расширений');
  await checksWithReview({
    updateId, platform, conn, input, workRoot, mergedDir: result.mergedDir, progress, result,
  });

  await runUpdateHandlers({ platform, conn, input, workRoot, progress, result });
}

function startWrite(progress, id, detail) {
  throwIfCancelled();
  progress.start(id, detail);
}

/**
 * Очистка каталога выгрузки — по флагу «Сохранить выгрузку», видимым этапом.
 *
 * В отличие от обследования, чистить можно не всё: результат объединения
 * (`config`) и «Конфликты» бережём, пока он не загружен в базу (`keepResult`),
 * иначе кнопке «Загрузить в конфигурацию» стало бы нечем загружать. Входные
 * выгрузки (текущая и новая поставка, временные файлы проверки расширений)
 * чистятся всегда, когда флаг снят.
 */
async function cleanupUpdateDump({ progress, workRoot, keep, keepResult }) {
  if (keep) {
    progress.skip('cleanup', 'выгрузка сохранена по требованию пользователя');
    return;
  }

  progress.update('cleanup', workRoot);
  try {
    const removed = await removeUpdateOwnEntries(workRoot, { keepResult });
    log.info(`Выгрузка обновления очищена: элементов ${removed} в ${workRoot}`);
    progress.done('cleanup', keepResult
      ? `удалено элементов: ${removed} (результат объединения сохранён — ещё не загружен в базу)`
      : `удалено элементов: ${removed}`);
  } catch (err) {
    // Не повод считать обновление неудачным: результат уже готов. Но сказать
    // надо — иначе пользователь найдёт лишнее на диске и не поймёт откуда.
    log.warn(`Не удалось очистить каталог выгрузки обновления: ${err.message}`);
    progress.warn('cleanup', `не удалось очистить: ${err.message}`);
  }
}

/**
 * Проверки платформы с разбором ошибок и повтором.
 *
 * Требование пользователя 26.08.2026: не просто показать ошибки в отчёте,
 * а дать их исправить прямо здесь — и проверить заново. Круг такой:
 *
 *   проверить → остались места, требующие решения? → ждать разбора
 *   → перезагрузить исправленное в базу → проверить заново.
 *
 * Круг повторяется, пока не останется ничего, кроме помеченного пропущенным.
 * Пропуск — это тоже решение: часть замечаний платформы к обновлению
 * отношения не имеет, они есть и в чистой типовой конфигурации.
 *
 * Кругов не больше `CHECK_REVIEW_ROUNDS`: если человек правит одно и то же
 * без конца, обновление всё равно должно завершиться, а не висеть.
 */
async function checksWithReview({
  updateId, platform, conn, input, workRoot, mergedDir, progress, result, typical = false,
}) {
  let checks = null;

  for (let round = 1; round <= CHECK_REVIEW_ROUNDS; round += 1) {
    throwIfCancelled();
    checks = await runChecks({
      platform, conn, input, workRoot, mergedDir, progress, typical,
    });
    // Окну разбора нужен корень выгрузки: по нему оно находит модули,
    // на которые указывает платформа.
    checks.mergedDir = mergedDir || '';
    checks.round = round;
    result.checks = checks;
    await save(updateId, result);
    reportChecks(progress, checks);

    const left = checksLeft(checks, await store.getReviewState(updateId));
    if (!left) return checks;

    if (round === CHECK_REVIEW_ROUNDS) {
      progress.message(
        `Ошибок проверок, требующих решения, осталось ${left}, а кругов разбора уже ${round}. `
        + 'Дальше обновление продолжается: остальное разберите в конфигураторе.',
        'warn',
      );
      return checks;
    }

    progress.warn('check', `ошибок, требующих решения: ${left}`);
    progress.message(
      `Проверки платформы нашли ${left} мест, требующих решения. Прогон приостановлен: `
      + 'откройте «Разобрать ошибки проверок» — там видно, что программа исправила сама '
      + '(перенос доработок расширения на изменённые методы), а что осталось вам. Место можно '
      + 'исправить прямо там либо пометить пропущенным, если замечание к обновлению '
      + 'отношения не имеет. Нажмёте «Проверить заново» — исправленное загрузится в базу '
      + 'и проверки пойдут по новому кругу.',
      'warn',
    );

    const answer = await progress.ask('check', {
      title: 'Разберите ошибки проверок — и прогон продолжится',
      kind: 'checks',
      updateId,
      manual: left,
      infobase: conn.display,
      text: `Проверки платформы нашли ${left} мест, требующих решения. Исправьте их в окне `
        + 'разбора или пометьте пропущенными — и прогон пойдёт дальше.',
    });

    if (!answer?.ok) {
      progress.message(
        'Разбор ошибок отложен. Исправить их можно позже — в конфигураторе либо повторным '
        + 'прогоном обновления.',
      );
      return checks;
    }

    await reloadFixed({ platform, conn, input, workRoot, mergedDir, progress, checks });
  }

  return checks;
}

/**
 * Загружает в базу то, что человек исправил в окне разбора.
 *
 * Конфигурация грузится целиком, только если правили её модули: это минуты,
 * и платить их ради правки в одном расширении незачем. Расширения грузятся
 * поимённо — те, чьи файлы человек трогал.
 */
async function reloadFixed({ platform, conn, input, workRoot, mergedDir, progress, checks }) {
  const dirs = new Map();
  let mainTouched = false;

  for (const item of buildCheckItems(checks)) {
    if (item.kind === 'extension' && item.file) {
      const root = extensionRoot(item.file, item.rel);
      if (root) dirs.set(item.extension, root);
    } else if (item.kind === 'module' && item.scope === 'config') {
      mainTouched = true;
    }
  }

  if (mainTouched && mergedDir) {
    startWrite(progress, 'check', 'Загрузка исправленной конфигурации');
    try {
      await loadConfigFromFiles({
        platform, conn, srcDir: mergedDir, user: input.user, password: input.password,
        logFile: path.join(workRoot, 'designer-recheck.log'),
      });
    } catch (err) {
      if (isCancelled(err)) throw err;
      progress.message(`Исправленная конфигурация не загрузилась: ${err.message}`, 'warn');
    }
  }

  for (const [name, dir] of dirs) {
    progress.update('check', `загрузка исправленного расширения «${name}»`);
    try {
      await loadConfigFromFiles({
        platform, conn, srcDir: dir, extension: name,
        user: input.user, password: input.password,
        logFile: path.join(workRoot, `designer-ext-recheck-${name}.log`),
      });
    } catch (err) {
      if (isCancelled(err)) throw err;
      progress.message(`Расширение «${name}» не загрузилось: ${err.message}`, 'warn');
    }
  }
}

/** Корень выгрузки расширения: путь файла минус путь внутри выгрузки. */
function extensionRoot(file, rel) {
  if (!file || !rel) return null;
  const normalized = String(file).replace(/\\/g, '/');
  const tail = `/${String(rel).replace(/\\/g, '/')}`;
  return normalized.endsWith(tail) ? normalized.slice(0, -tail.length) : null;
}

/**
 * Проверка модулей и применимость расширений — с починкой и повтором.
 *
 * Требование пользователя: «если ты видишь, что проверки применимости
 * не прошли, ты их устраняешь, и снова загружаешь XML файлы в базу, и снова
 * выполняешь проверку до тех пор, пока всё не будет красиво». Чинится то,
 * что чинится однозначно, — потерявшие цель аннотации расширений
 * (`update/fixExtensions.js`); всё остальное честно уходит в отчёт.
 */
async function runChecks({ platform, conn, input, workRoot, mergedDir, progress, typical = false }) {
  const wantModules = input.checkModules !== false;
  const wantExtensions = input.checkExtensions !== false;
  const checks = {
    rounds: [], fixed: [], manual: [], typical, wantModules, wantExtensions,
  };

  if (!wantModules && !wantExtensions) {
    progress.skip('check', 'проверки отключены на форме');
    return checks;
  }

  // Основную конфигурацию проверяем только там, где её меняли мы. После типового
  // обновления она ровно такая, какой её выпустил вендор: замечания в ней есть
  // (проверено — на чистой УНФ 3.0.14.115 их находит и сама платформа), но это
  // замечания к типовому решению, исправлять их никто не будет, а в отчёте они
  // выглядели бы следствием обновления. Требование пользователя (11.08.2026):
  // «нет смысла проверять конфигурацию, она типовая».
  if (wantModules && !typical) {
    progress.update('check', 'проверка модулей конфигурации');
    const config = await checkModules({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
      extended: input.extendedCheck === true,
    });
    checks.config = config;
    progress.update('check', `проверка модулей конфигурации: замечаний ${config.errors.length}`);
  }

  // Расширения проверяются всегда: их писали не в 1С, и обновление ломает
  // именно их. Отдельный вызов с `-AllExtensions`, а не часть проверки
  // конфигурации: платформа считает это разными проверками.
  if (wantModules) {
    progress.update('check', 'проверка модулей расширений');
    const extensionsSyntax = await checkModules({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
      scope: 'extensions', extended: input.extendedCheck === true,
    });
    checks.extensionsSyntax = extensionsSyntax;
    progress.update('check', `проверка модулей расширений: замечаний ${extensionsSyntax.errors.length}`);
  }

  if (!wantExtensions) return checks;

  // Считаем расширения ДО проверки применимости: на базе без расширений
  // журнал `/CheckCanApplyConfigurationExtensions` пуст точно так же, как
  // когда все расширения применяются успешно — не узнав число заранее,
  // «расширений нет» не отличить от «все применяются».
  const extCount = await countExtensions({
    platform, conn, workDir: workRoot, user: input.user, password: input.password,
  });
  progress.update('check', `расширений в базе: ${extCount.count}`);

  if (extCount.count === 0) {
    checks.extensions = { available: true, ok: true, errors: [], count: 0 };
    checks.rounds.push({ round: 1, ok: true, errors: 0, note: 'расширений нет' });
    return checks;
  }

  for (let round = 1; round <= FIX_ROUNDS; round += 1) {
    throwIfCancelled();
    progress.update('check', `проверка применимости расширений, попытка ${round}`);
    const applicable = await checkExtensionsApplicable({
      platform, conn, user: input.user, password: input.password, workDir: workRoot,
    });
    checks.extensions = { ...applicable, count: extCount.count };
    checks.rounds.push({
      round, ok: applicable.ok, errors: applicable.errors?.length || 0, note: applicable.note || '',
    });

    if (applicable.ok || !applicable.available) break;
    if (round === FIX_ROUNDS) break;

    // Починка сверяет расширение с текстами основной конфигурации, а их даёт
    // только XML-выгрузка. При типовом обновлении её нет намеренно, поэтому
    // здесь честный отказ, а не тихое «ничего не нашлось».
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

    // Сначала — самое ценное: заимствованный метод, который поставщик изменил
    // в новом релизе. Его можно объединить трёхсторонне, как обычный модуль:
    // старая поставка есть, новая есть, наша версия лежит в расширении.
    const merged = await mergeExtensionSources({
      extensions: dumped.extensions,
      mainDir: mergedDir,
      vendorDir: checks.vendorDir || null,
      onProgress: (text) => progress.update('check', text),
    });
    checks.extensionMerges = [...(checks.extensionMerges || []), ...merged.resolved];
    checks.extensionConflicts = [...(checks.extensionConflicts || []), ...merged.conflicts];

    const fix = await fixExtensionAnnotations({
      extensions: dumped.extensions, mainDir: mergedDir,
    });
    checks.fixed.push(...fix.fixed);
    checks.manual.push(...fix.manual);

    const changed = [...new Set([...fix.changedExtensions, ...merged.changedExtensions])];
    if (!changed.length) break;

    for (const name of changed) {
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

  // Застава перед единственным действием продукта, меняющим базу: пока хоть
  // одно спорное место не разобрано, в выгрузке лежит наша версия участка,
  // а правка поставщика в нём потеряна. Загружать такое — тихо откатывать
  // часть нового релиза.
  const left = unresolvedCount(result, await store.getReviewState(updateId));
  if (left > 0) {
    throw new Error(
      `Загрузка запрещена: спорных мест, ожидающих вас, ещё ${left}. `
      + 'Разберите их в окне «Разобрать спорные места» — там показано, что объединено '
      + 'программой (это нужно подтвердить), а что осталось вам, — и повторите загрузку.',
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
