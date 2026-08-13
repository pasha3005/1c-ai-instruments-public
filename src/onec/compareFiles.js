/**
 * Сравнение двух файлов `.cf` средствами платформы — БЕЗ ЗАПИСИ В БАЗУ.
 *
 * Зачем это появилось (13.08.2026, требование пользователя). Правки помещений
 * программа строила так: выгружала из хранилища версии N и N−1 файлами `.cf`,
 * разворачивала каждую в XML и сравнивала выгрузки сама. Разворачивание `.cf`
 * возможно только загрузкой в базу — то есть базу приходилось менять. У
 * разработчика на сервере заказчика есть лишь его рабочая база, и менять её
 * нельзя ни при каких условиях.
 *
 * Оказалось, разворачивать не нужно вовсе: `/CompareCfg` умеет сравнивать два
 * ФАЙЛА между собой — `-FirstConfigurationType File -FirstFile <a.cf>` и такая
 * же пара для второго. База при этом нужна только как контекст запуска
 * конфигуратора и **не меняется**: проверено сравнением её конфигурации
 * до и после (одинаковый sha256 выгрузки `.cf`).
 *
 * Первым файлом идёт ВЕРСИЯ N, вторым — N−1. Порядок не произволен: отчёт
 * печатает участки в координатах ПЕРВОЙ конфигурации и помечает их «объект
 * присутствует только в первой конфигурации» — то есть ровно то, что внесено
 * помещением, и с номерами строк новой версии. Разбирает отчёт тот же
 * `parseCompareReport`, что и сравнение с поставщиком: формат один.
 *
 * Побочная выгода: диф считает сама платформа. Свой (Майерса) на повторяющихся
 * строках вроде «КонецПроцедуры» даёт несколько равноправных минимумов, и это
 * стоило отдельной эвристики (`slideRuns`).
 */

import path from 'node:path';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { ensureDir, pathExists, readText, rmrf } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';
import { parseConnection, toClientArgs } from './connection.js';
import { parseCompareReport } from './vendorCompare.js';

const log = createLogger('compare-files');

/**
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {{base: string, user?: string, password?: string}} params.context база-контекст
 * @param {string} params.newer файл `.cf` более новой версии (её координаты в отчёте)
 * @param {string} params.older файл `.cf` предыдущей версии
 * @param {string} params.workDir куда писать отчёт и журнал
 * @param {string} params.name имя для файлов отчёта
 * @returns {Promise<{ok: boolean, sets?: object, reason?: string}>}
 */
export async function compareCfFiles({ platform, context, newer, older, workDir, name }) {
  if (!platform.client) {
    return { ok: false, reason: `в платформе ${platform.version} не найден 1cv8.exe` };
  }

  const dir = await ensureDir(path.join(workDir, 'compare'));
  const reportFile = path.join(dir, `${name}.txt`);
  const logFile = path.join(dir, `${name}.log`);
  await rmrf(reportFile).catch(() => {});

  const conn = parseConnection(context.base);
  const args = [
    'DESIGNER',
    ...toClientArgs(conn),
    ...(context.user ? [`/N${context.user}`] : []),
    ...(context.password ? [`/P${context.password}`] : []),
    '/CompareCfg',
    '-FirstConfigurationType', 'File', '-FirstFile', newer,
    '-SecondConfigurationType', 'File', '-SecondFile', older,
    '-IncludeChangedObjects', '-IncludeAddedObjects', '-IncludeDeletedObjects',
    '-ReportType', 'Full',
    '-ReportFormat', 'txt',
    '-ReportFile', reportFile,
    '/DisableStartupDialogs', '/DisableStartupMessages',
    '/Out', logFile,
  ];

  try {
    await run(platform.client, args, {
      timeout: TIMEOUTS.configExport,
      allowNonZeroExit: true,
    });
  } catch (err) {
    rethrowIfCancelled(err);
    return { ok: false, reason: `конфигуратор не выполнил сравнение версий: ${err.message}` };
  }

  if (!(await pathExists(reportFile))) {
    const text = (await readSafe(logFile)).trim();
    return {
      ok: false,
      reason: text
        ? `конфигуратор не построил отчёт сравнения версий: ${text.slice(0, 300)}`
        : 'конфигуратор не построил отчёт сравнения версий',
    };
  }

  const sets = parseCompareReport(await readText(reportFile));
  log.info(
    `Сравнение версий ${path.basename(older)} → ${path.basename(newer)}: `
    + `изменено ${sets.modified.size}, добавлено ${sets.added.size}, `
    + `модулей со строками правок ${sets.moduleLines.size}`,
  );
  return { ok: true, sets };
}

async function readSafe(file) {
  try {
    return await readText(file);
  } catch {
    return '';
  }
}
