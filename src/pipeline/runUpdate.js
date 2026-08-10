/**
 * Конвейер обновления нетиповой конфигурации.
 *
 * Повторяет обновление конфигурации, находящейся на поддержке, так, как его
 * делает конфигуратор, — но без ручного разбора тысячи строк в окне сравнения:
 *
 *   1. выгружаем основную конфигурацию базы в XML;
 *   2. разворачиваем ТЕКУЩУЮ конфигурацию поставщика (общая точка отсчёта);
 *   3. разворачиваем НОВУЮ поставку (то, на что обновляемся);
 *   4. объединяем три версии: правку вендора берём, свою сохраняем,
 *      дважды изменённое отдаём человеку;
 *   5. пишем результат в файлы выгрузки и, если попросили, загружаем их
 *      в основную конфигурацию базы.
 *
 * Почему обследование и обновление — разные конвейеры, хотя первые три этапа
 * похожи. Обследование ничего не меняет и живёт результатом-отчётом; обновление
 * меняет файлы выгрузки, а по просьбе — и конфигурацию базы, и его результат —
 * сама выгрузка. Общий конвейер с флагом «а теперь ещё и обнови» означал бы,
 * что случайно поставленная галочка ведёт к записи в базу.
 *
 * Выгрузка после обновления НЕ удаляется: в ней лежит результат, её правят
 * руками в конфликтных местах и из неё загружают конфигурацию — иногда не
 * в тот же день.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { resolvePlatform } from '../onec/platform.js';
import { parseConnection, validateConnection } from '../onec/connection.js';
import { exportConfiguration } from '../onec/collector.js';
import { loadConfigFromFiles } from '../onec/designer.js';
import { readConfigDumpInfo } from '../analyze/baselines.js';
import {
  prepareVendorConfig, exportCfToXml, readConfigurationProperties,
} from '../analyze/vendorConfig.js';
import { mergeConfigurations, CONFLICT_DIR } from '../update/mergeConfig.js';
import { touchedObjectKeys } from '../update/dumpKeys.js';
import { renderUpdateReport } from '../report/updateReport.js';
import * as store from '../store/updateStore.js';
import { ensureDir, pathExists, rmrf, dirSize, humanSize } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { runCancellable, throwIfCancelled, isCancelled, CANCEL_MESSAGE } from '../util/cancel.js';

const log = createLogger('update');

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

    // ---------- 5. Текущая конфигурация поставщика ----------
    startStage('vendor-old', 'Подготовка текущей конфигурации поставщика');
    const vendor = await prepareVendorConfig({
      vendorPath: input.vendorConfigPath,
      platform, conn, workDir: workRoot, user: input.user, password: input.password,
      configName: mainProps.name,
      totalEntries: await countDumpEntries(exported.dir, input.vendorConfigPath),
      onProgress: (text) => progress.update('vendor-old', text),
    });

    if (!vendor.available) {
      throw new Error(
        `Не удалось получить текущую конфигурацию поставщика: ${vendor.reason} `
        + 'Без неё обновление невозможно: непонятно, какие изменения ваши, а какие пришли '
        + 'от поставщика, и объединять нечего.',
      );
    }

    const baseDir = vendor.dir || null;
    const baseProps = baseDir
      ? await readConfigurationProperties(path.join(baseDir, 'Configuration.xml'))
      : { name: mainProps.name, version: '', vendor: '' };

    /**
     * Режим без исходников старой поставки.
     *
     * Сравнение прямо в базе даёт перечень объектов, изменённых интегратором,
     * но не тексты поставщика. Построчно объединять нечем, зато главное правило
     * обновления выполнимо: объект, которого доработка не касалась, берётся
     * из новой поставки целиком.
     */
    const touched = baseDir ? null : touchedObjectKeys(vendor.changeSet);
    if (!baseDir) {
      progress.message(
        'Файл .cf текущей поставки не указан. Сравнение выполнено прямо в базе: известно, '
        + `какие объекты вы изменили (${touched.size}), но не тексты поставщика. Объекты без `
        + 'доработок будут взяты из новой поставки целиком, изменённые — оставлены вашими '
        + 'и перечислены для ручного разбора.',
        'warn',
      );
      warnings.push(
        'Текущая конфигурация поставщика указана не была, поэтому построчного объединения '
        + 'не выполнялось. Чтобы объединять код автоматически, сохраните конфигурацию '
        + 'поставщика в файл .cf (Конфигуратор → Конфигурация → Поддержка) и повторите.',
      );
      progress.warn('vendor-old', `сравнение в базе, изменённых объектов: ${touched.size}`);
    } else {
      progress.done('vendor-old',
        `${baseProps.name || ''} ${baseProps.version || ''}`.trim() || vendor.source);
    }

    // ---------- 6. Новая поставка ----------
    startStage('vendor-new', 'Подготовка целевой конфигурации');
    const target = await prepareTarget({ input, platform, workRoot, progress });
    const targetProps = await readConfigurationProperties(path.join(target.dir, 'Configuration.xml'));
    progress.done('vendor-new',
      `${targetProps.name || ''} ${targetProps.version || ''}`.trim() || target.dir);

    checkTarget({ mainProps, baseProps, targetProps, warnings, progress });

    // ---------- 7. Объединение ----------
    startStage('merge', 'Трёхстороннее сравнение и объединение');
    const merge = await mergeConfigurations({
      mainDir: exported.dir,
      baseDir,
      targetDir: target.dir,
      touchedObjects: touched,
      conflictRoot,
      onProgress: (done, total, rel) => {
        progress.update('merge', `${done} из ${total}: ${rel}`);
      },
    });
    const manualCount = (merge.totals.conflicted || 0) + (merge.totals.manual || 0);
    progress.done('merge',
      `взято от поставщика ${merge.totals.fromVendor + merge.totals.merged}, `
      + `новых объектов ${merge.totals.addedByVendor}, требует решения ${manualCount}`);

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
        base: baseDir ? baseProps : null,
        target: targetProps,
      },
      vendorSource: vendor.source,
      mergedDir: exported.dir,
      conflictDir: merge.conflictIndex.length ? conflictRoot : '',
      merge,
      warnings,
      loaded: false,
      durationMs: Date.now() - startedAt,
    };

    await store.saveResult(updateId, result);
    await store.saveReport(updateId, renderUpdateReport(result));
    progress.done('report', 'отчёт готов');

    // ---------- 9. Загрузка в конфигурацию ----------
    if (input.loadBack === true) {
      startStage('load', 'Загрузка объединённых файлов в основную конфигурацию');
      if (warnings.some(isBlockingWarning)) {
        progress.warn('load', 'загрузка отменена: конфигурации не совпадают');
        progress.message(
          'Автоматическая загрузка отменена: имя целевой конфигурации не совпадает с именем '
          + 'основной. Проверьте, тот ли файл .cf указан, и при необходимости загрузите '
          + 'выгрузку вручную из конфигуратора.',
          'warn',
        );
      } else {
        await loadIntoBase({ platform, conn, input, dir: exported.dir, progress, result, updateId });
      }
    } else {
      progress.skip('load', 'по умолчанию не выполняется');
      progress.message(
        'Результат объединения записан в файлы выгрузки. Загрузить его в конфигурацию можно '
        + 'кнопкой «Загрузить в конфигурацию» — после того как вы разберёте места, '
        + 'требующие решения.',
      );
    }

    result.durationMs = Date.now() - startedAt;
    await store.saveResult(updateId, result);
    await store.saveReport(updateId, renderUpdateReport(result));

    progress.finish({
      updateId,
      manual: manualCount,
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
 * Загрузка ранее объединённой выгрузки в конфигурацию — отдельным действием.
 *
 * Главный сценарий именно такой: объединение прошло, человек разобрал дважды
 * изменённые места прямо в файлах выгрузки (иногда на другой день) и только
 * потом загружает результат. Поэтому загрузка не привязана к прогону и берёт
 * каталог из его результата.
 *
 * Пароль в результате не хранится (`sanitize`), поэтому он передаётся заново.
 */
export async function loadUpdateResult({ updateId, user, password }) {
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

  await loadConfigFromFiles({
    platform,
    conn,
    srcDir: result.mergedDir,
    user: user || meta.input?.user || '',
    password: password || '',
    logFile: path.join(path.dirname(result.mergedDir), 'designer-load.log'),
  });

  const loadedAt = new Date().toISOString();
  result.loaded = true;
  result.loadedAt = loadedAt;
  await store.saveResult(updateId, result);
  await store.saveReport(updateId, renderUpdateReport(result));
  await store.updateMeta(updateId, { loadedAt, loadError: null });
  log.info(`Объединение ${updateId} загружено в конфигурацию базы`);
  return { loadedAt };
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
 * в выгрузке. Поэтому расхождение имён — громкое предупреждение, а
 * автоматическую загрузку в базу оно запрещает совсем (см. isBlockingWarning).
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

/** Загрузка результата в основную конфигурацию базы. */
async function loadIntoBase({ platform, conn, input, dir, progress, result, updateId }) {
  try {
    progress.update('load', 'Конфигуратор загружает файлы (нужен монопольный доступ к базе)');
    await loadConfigFromFiles({
      platform, conn, srcDir: dir, user: input.user, password: input.password,
      logFile: path.join(path.dirname(dir), 'designer-load.log'),
    });
    result.loaded = true;
    result.loadedAt = new Date().toISOString();
    await store.updateMeta(updateId, { loadedAt: result.loadedAt, loadError: null });
    progress.done('load', 'загружено в основную конфигурацию');
    progress.message(
      'Файлы загружены в ОСНОВНУЮ конфигурацию. Конфигурация базы данных не обновлена — '
      + 'откройте конфигуратор и выполните «Обновить конфигурацию базы данных»: платформа '
      + 'покажет предупреждения о реструктуризации, и решение по ним за вами.',
    );
  } catch (err) {
    if (isCancelled(err)) throw err;
    result.loaded = false;
    result.loadError = err.message;
    await store.updateMeta(updateId, { loadError: err.message });
    // Не проваливаем прогон: объединение выполнено и лежит в файлах, а загрузку
    // можно повторить кнопкой, устранив причину отказа.
    progress.warn('load', `не удалось: ${err.message}`);
    progress.message(`Загрузка в конфигурацию не выполнена: ${err.message}`, 'warn');
  }
}

/** Сколько элементов в карте версий основной конфигурации — только для режима без .cf. */
async function countDumpEntries(dumpDir, vendorPath) {
  if (String(vendorPath || '').trim()) return 0;
  const hashes = await readConfigDumpInfo(path.join(dumpDir, 'ConfigDumpInfo.xml'));
  return Object.keys(hashes || {}).length;
}

function sanitize(input) {
  const { password, ...rest } = input || {};
  return { ...rest, hasPassword: Boolean(password) };
}
