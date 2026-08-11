/**
 * Конвейер обновления нетиповой конфигурации.
 *
 * Повторяет обновление конфигурации, находящейся на поддержке, так, как его
 * делает конфигуратор, — но без ручного разбора тысячи строк в окне сравнения:
 *
 *   1. выгружаем основную конфигурацию базы в XML;
 *   2. получаем ТЕКУЩУЮ конфигурацию поставщика — из файла .cf либо
 *      восстановлением прямо из базы (`update/vendorSources.js`);
 *   3. разворачиваем НОВУЮ поставку (то, на что обновляемся);
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

    // ---------- 4. Основная конфигурация ----------
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

    // ---------- 5. Новая поставка ----------
    // Раньше она готовилась после старой. Теперь наоборот: восстановление
    // старой поставки из базы заглядывает в новую, чтобы заполнить строки,
    // которые интегратор удалил, — их текста отчёт сравнения не печатает.
    startStage('vendor-new', 'Подготовка целевой конфигурации');
    const target = await prepareTarget({ input, platform, workRoot, progress });
    const targetTree = await dirTree(target.dir);
    const targetProps = await readConfigurationProperties(path.join(target.dir, 'Configuration.xml'));
    progress.done('vendor-new',
      `${targetProps.name || ''} ${targetProps.version || ''}`.trim() || target.dir);

    // ---------- 6. Текущая конфигурация поставщика ----------
    startStage('vendor-old', 'Подготовка текущей конфигурации поставщика');
    const vendor = await prepareVendorConfig({
      vendorPath: input.vendorConfigPath,
      platform, conn, workDir: workRoot, user: input.user, password: input.password,
      configName: mainProps.name,
      totalEntries: 0,
      onProgress: (text) => progress.update('vendor-old', text),
    });

    if (!vendor.available) {
      throw new Error(
        `Не удалось получить текущую конфигурацию поставщика: ${vendor.reason} `
        + 'Без неё обновление невозможно: непонятно, какие изменения ваши, а какие пришли '
        + 'от поставщика, и объединять нечего. Проверьте, что конфигурация стоит на поддержке, '
        + 'либо укажите файл .cf текущей поставки.',
      );
    }

    const { baseTree, baseProps, restoreStats } = await prepareBase({
      vendor, exported, targetTree, mainProps, progress, warnings,
    });

    checkTarget({ mainProps, baseProps, targetProps, warnings, progress });

    // ---------- 7. Объединение ----------
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

    // ---------- 8. Отчёт ----------
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

    // ---------- 9. Запись в базу — по подтверждению ----------
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
    for (const id of ['load', 'db-update', 'check']) progress.skip(id, 'не выполнялось');
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
    for (const id of ['db-update', 'check']) progress.skip(id, 'не выполнялось');
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
    for (const id of ['db-update', 'check']) progress.skip(id, 'загрузка не выполнена');
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
  startWrite(progress, 'check', 'Синтаксический контроль конфигурации');
  result.checks = await runChecks({
    platform, conn, input, workRoot, mergedDir: result.mergedDir, progress,
  });

  const problems = (result.checks.config?.errors?.length || 0)
    + (result.checks.extensions?.errors?.length || 0);
  if (problems) {
    progress.warn('check', `замечаний платформы: ${problems}`);
  } else {
    progress.done('check', 'ошибок не найдено');
  }
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
async function runChecks({ platform, conn, input, workRoot, mergedDir, progress }) {
  const checks = { rounds: [], fixed: [], manual: [] };

  const config = await checkConfig({
    platform, conn, user: input.user, password: input.password, workDir: workRoot,
  });
  checks.config = config;
  progress.update('check', `синтаксический контроль: замечаний ${config.errors.length}`);

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
