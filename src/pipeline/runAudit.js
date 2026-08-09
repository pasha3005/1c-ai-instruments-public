/**
 * Конвейер аудита: от параметров на форме до готового отчёта.
 *
 * Каждый этап отражается в объекте прогресса, поэтому пользователь видит,
 * что происходит, и получает осмысленное сообщение при сбое.
 *
 * Принцип отказоустойчивости: обязателен только этап выгрузки конфигурации.
 * Всё остальное (расширения, живые данные, AI) при недоступности помечается
 * как пропущенное, а отчёт формируется с явной оговоркой.
 */

import path from 'node:path';
import { resolvePlatform } from '../onec/platform.js';
import { parseConnection, validateConnection } from '../onec/connection.js';
import { exportConfiguration, exportExtensions, collectInfobaseFacts, chooseStrategy } from '../onec/collector.js';
import { collectLiveData, COUNTABLE_KINDS } from '../onec/comBridge.js';
import { parseConfigurationDump } from '../parse/configuration.js';
import { collectModules } from '../parse/modules.js';
import { parseRoles } from '../parse/roles.js';
import { parseExtensions } from '../parse/extensions.js';
import { findBaselineFor, readConfigDumpInfo } from '../analyze/baselines.js';
import { prepareVendorConfig, buildChangeSet, summarizeVendorComparison } from '../analyze/vendorConfig.js';
import { runAnalysis } from '../analyze/index.js';
import { buildRecommendations } from '../ai/advisor.js';
import { renderHtmlReport } from '../report/html.js';
import { renderMarkdownReport } from '../report/markdown.js';
import * as store from '../store/auditStore.js';
import { DEFAULT_WORK_DIR } from '../config.js';
import { ensureDir, rmrf, dirSize, humanSize } from '../util/fsx.js';
import { removeOwnEntries } from '../util/workDir.js';
import { createLogger } from '../util/logger.js';
import { runCancellable, throwIfCancelled, isCancelled, CANCEL_MESSAGE } from '../util/cancel.js';

const log = createLogger('pipeline');

/**
 * @param {object} params
 * @param {string} params.auditId
 * @param {object} params.input параметры с формы
 * @param {import('../server/progress.js').AuditProgress} params.progress
 */
export function runAudit({ auditId, input, progress }) {
  // Область прерывания: из неё util/proc.js берёт сигнал и снимает внешние
  // процессы, не дожидаясь их естественного завершения.
  return runCancellable(progress?.signal || null, () => runPipeline({ auditId, input, progress }));
}

async function runPipeline({ auditId, input, progress }) {
  const workRoot = input.workDir?.trim()
    ? path.resolve(input.workDir.trim())
    : path.join(DEFAULT_WORK_DIR, auditId);

  // Флаг «Сохранить выгрузку» действует всегда, а не только для временного
  // каталога: раньше указанный пользователем каталог не чистился никогда,
  // и снятый флаг ничего не менял.
  const usesOwnDir = Boolean(input.workDir?.trim());
  let cleanupWorkDir = input.keepDump !== true;
  const startedAt = Date.now();

  /**
   * Начало этапа. Заодно единственная точка, где проверяется прерывание:
   * между этапами конвейер всегда останавливается мгновенно, а внутри этапа —
   * когда снятый внешний процесс отдаст управление.
   */
  const startStage = (id, detail = '') => {
    throwIfCancelled();
    progress.start(id, detail);
  };

  try {
    // ---------- 1. Подготовка ----------
    startStage('prepare');
    await ensureDir(workRoot);
    progress.message(`Рабочий каталог: ${workRoot}`);
    progress.done('prepare', workRoot);

    // ---------- 2. Платформа ----------
    startStage('platform', 'Поиск установленных версий 1С:Предприятие');
    const { platform, exact, available } = await resolvePlatform(input.platformVersion);
    if (!exact && input.platformVersion) {
      progress.message(
        `Версия ${input.platformVersion} не найдена. Используется ${platform.version}. ` +
        `Доступны: ${available.join(', ')}`,
        'warn',
      );
    }
    progress.done('platform', `${platform.version}${platform.ibcmd ? ' (ibcmd)' : ''}`);

    // ---------- 3. Проверка доступа ----------
    startStage('connect', 'Проверка пути к информационной базе');
    const conn = parseConnection(input.infobasePath);
    const validation = await validateConnection(conn);
    for (const warning of validation.warnings) progress.message(warning, 'warn');
    const strategy = chooseStrategy({ platform, conn });
    progress.message(`Тип базы: ${connKindRu(conn.kind)}. Способ выгрузки: ${strategy.driver} (${strategy.reason})`);
    const infobaseFacts = await collectInfobaseFacts({ platform, conn, user: input.user, password: input.password });
    progress.done('connect', conn.display);

    const collectCtx = {
      platform,
      conn,
      workDir: workRoot,
      user: input.user,
      password: input.password,
    };

    // ---------- 4. Выгрузка конфигурации ----------
    startStage('export-config', 'Выгрузка конфигурации в XML (может занять несколько минут)');
    const exported = await exportConfiguration({
      ...collectCtx,
      onProgress: (text) => {
        const line = text.trim().split('\n').pop();
        if (line) progress.update('export-config', line.slice(0, 160));
      },
    });
    const dumpBytes = await dirSize(exported.dir);
    progress.done('export-config', `${humanSize(dumpBytes)}, драйвер: ${exported.driver}`);

    // ---------- 5. Расширения ----------
    startStage('export-extensions', 'Поиск и выгрузка расширений');
    let extensionDirs = [];
    /** Расширения, которые есть в базе, но исходников платформа не отдала. */
    let missingExtensions = [];
    try {
      const result = await exportExtensions({
        ...collectCtx,
        onProgress: (text) => {
          const line = text.trim().split('\n').pop();
          if (line) progress.update('export-extensions', line.slice(0, 160));
        },
      });
      extensionDirs = result.extensions;
      // Расширение, которое не выгрузилось, — это непроверенная доработка.
      // Молчать об этом нельзя: в отчёте её не будет, и понять, что она
      // пропущена, читателю неоткуда.
      missingExtensions = result.missing || [];
      if (missingExtensions.length) {
        progress.warn('export-extensions',
          `выгружено ${extensionDirs.length}, не удалось: ${missingExtensions.join(', ')}`);
        progress.message(
          `Не выгружены расширения: ${missingExtensions.join(', ')}. ` +
          'Их код в аудит не попал — платформа не отдала исходники.',
          'warn',
        );
      } else {
        progress.done('export-extensions', extensionDirs.length
          ? `найдено: ${extensionDirs.length}`
          : 'расширения не используются');
      }
    } catch (err) {
      if (isCancelled(err)) throw err;
      progress.warn('export-extensions', `не удалось: ${err.message}`);
    }

    // ---------- 6. Разбор метаданных ----------
    startStage('parse-metadata', 'Чтение состава объектов метаданных');
    const parsed = await parseConfigurationDump(exported.dir, {
      onProgress: (done, total, name) => {
        progress.update('parse-metadata', `${done} из ${total}: ${name}`);
      },
    });
    parsed.hashes = await readConfigDumpInfo(path.join(exported.dir, 'ConfigDumpInfo.xml'));
    progress.done('parse-metadata', `объектов: ${parsed.totals.objects}`);

    progress.message(
      `Конфигурация: ${parsed.configuration.synonym || parsed.configuration.name}` +
      `${parsed.configuration.version ? ` ${parsed.configuration.version}` : ''}` +
      `${parsed.configuration.vendor ? `, поставщик: ${parsed.configuration.vendor}` : ''}`,
    );

    // ---------- 7. Модули и роли ----------
    startStage('parse-modules', 'Поиск модулей кода');
    const modules = await collectModules(exported.dir);

    // Код расширений анализируется наравне с доработками конфигурации:
    // расширение целиком является доработкой интегратора.
    for (const ext of extensionDirs) {
      const extModules = await collectModules(ext.dir, ext.name);
      modules.push(...extModules);
      progress.update('parse-modules', `расширение ${ext.name}: модулей ${extModules.length}`);
    }
    progress.update('parse-modules', `найдено модулей: ${modules.length}, разбор ролей`);

    const roleNames = parsed.objects.filter((o) => o.kind === 'Role').map((o) => o.name);
    const roles = await parseRoles(exported.dir, roleNames);

    const extensions = await parseExtensions(extensionDirs);
    progress.done('parse-modules', `модулей: ${modules.length}, ролей: ${roles.length}`);

    // ---------- 8. Живые данные ----------
    startStage('live-data', 'Подключение к базе для подсчёта записей');
    let live = { available: false, reason: 'сбор не запрашивался', counts: [], tables: [] };

    if (input.collectLiveData === false) {
      progress.skip('live-data', 'отключено пользователем');
      live.reason = 'Сбор данных отключён в параметрах аудита';
    } else {
      const countable = parsed.objects
        .filter((o) => COUNTABLE_KINDS.includes(o.kind))
        .map((o) => ({ kind: o.kind, name: o.name }));

      progress.update('live-data', `объектов для подсчёта: ${countable.length}`);
      live = await collectLiveData({
        ...collectCtx,
        objects: countable,
        scriptVariant: parsed.configuration.scriptVariant,
        onProgress: (done, total, id) => {
          progress.update('live-data', `${done} из ${total}: ${id}`);
        },
      });

      if (live.available) {
        progress.done('live-data', `посчитано объектов: ${live.counts.filter((c) => !c.error).length}`);
        // Подключение удалось, но COM-класс мог фактически указывать не на ту
        // сборку платформы, что выбрана на форме (см. comConnectorProgId
        // в platform.js) — не сбой, но пользователь должен об этом знать.
        if (live.warning) progress.message(live.warning, 'warn');
      } else {
        progress.warn('live-data', live.reason);
        progress.message(
          `Сбор данных из базы недоступен: ${live.reason}. ` +
          'Отчёт будет построен по статическому анализу конфигурации.',
          'warn',
        );
      }
    }

    // ---------- 9. Конфигурация поставщика ----------
    startStage('vendor', 'Подготовка конфигурации поставщика');
    const vendor = await prepareVendorConfig({
      vendorPath: input.vendorConfigPath,
      platform, conn, workDir: workRoot, user: input.user, password: input.password,
      // Имя конфигурации нужно для сравнения с поставщиком прямо в базе:
      // поддержка бывает цепочкой, и платформа требует уточнить, с чьей сравнивать.
      configName: parsed.configuration.name,
      totalEntries: Object.keys(parsed.hashes || {}).length,
      onProgress: (text) => progress.update('vendor', text),
    });

    let changeSet = null;
    let vendorComparison = { available: false, reason: vendor.reason };

    if (vendor.available) {
      changeSet = vendor.changeSet || buildChangeSet(parsed.hashes || {}, vendor.hashes);
      vendorComparison = summarizeVendorComparison(vendor, changeSet, parsed.objects);
      progress.done('vendor',
        `изменено ${changeSet.modified.size}, добавлено ${changeSet.added.size}, ` +
        `удалено ${changeSet.removed.size}, совпадает ${changeSet.unchanged}`);
      progress.message(
        `Конфигурация поставщика: ${vendorComparison.vendorConfigName} ${vendorComparison.vendorVersion}. ` +
        `Анализ будет ограничен доработками.`,
      );
    } else {
      progress.skip('vendor', vendor.reason || 'не указана');
      progress.message(
        `Конфигурация поставщика не используется: ${vendor.reason}. ` +
        'Анализируется вся конфигурация целиком.',
        'warn',
      );
    }

    // ---------- 10. Анализ ----------
    startStage('analyze', 'Статический анализ кода и расчёт оценок');
    const baseline = await findBaselineFor(parsed.configuration);
    if (baseline) {
      progress.message(`Найден эталон для точного сравнения: ${baseline.title}`);
    }

    const result = await runAnalysis({
      parsed,
      modules,
      extensions,
      roles,
      live,
      infobaseFacts,
      baseline,
      changeSet,
      vendorComparison,
      // Каталог XML-выгрузки поставщика. Есть только когда конфигурация
      // поставщика указана файлом .cf или каталогом: сравнение прямо в базе
      // даёт лишь перечень различий, без исходников.
      vendorDir: vendor.dir || null,
      // Свойства, реквизиты и табличные части из отчёта конфигуратора:
      // своих ключей в ConfigDumpInfo у них нет, а в дереве отличий это
      // самое содержательное.
      vendorDetails: vendor.details || null,
      missingExtensions,
      input: { ...input, platformVersion: platform.version, driver: exported.driver },
      hooks: {
        // Анализ кода — единственный длительный этап без внешнего процесса,
        // поэтому прерывание проверяется прямо в его колбэке прогресса.
        onCodeProgress: (done, total, title) => {
          throwIfCancelled();
          progress.update('analyze', `модуль ${done} из ${total}: ${title}`);
        },
      },
    });
    progress.done('analyze', `замечаний: ${result.findings.length}, оценка: ${result.scores.health}/100`);

    // ---------- 10. Рекомендации ----------
    startStage('ai', 'Формирование рекомендаций');
    const recommendations = await buildRecommendations(result, {
      onProgress: (text) => progress.update('ai', text),
    });
    result.recommendations = recommendations;
    if (recommendations.aiUsed) {
      progress.done('ai', 'с использованием Claude API');
    } else if (recommendations.aiError) {
      progress.warn('ai', `детерминированные рекомендации (${recommendations.aiError})`);
    } else {
      progress.done('ai', 'детерминированный движок');
    }

    // ---------- 12. Отчёт ----------
    startStage('report', 'Сборка отчёта');
    result.durationMs = Date.now() - startedAt;

    const html = renderHtmlReport(result, recommendations);
    const markdown = renderMarkdownReport(result, recommendations);

    await store.saveResult(auditId, result);
    await store.saveReport(auditId, 'html', html);
    await store.saveReport(auditId, 'markdown', markdown);
    progress.done('report', 'отчёт и Markdown готовы');

    // ---------- 13. Уборка ----------
    // Отдельным видимым этапом, а не в `finally` после `finish()`: выгрузка
    // ERP — это гигабайты, её удаление занимает время, и пользователь должен
    // видеть, что происходит. Аудит считается завершённым только после уборки.
    startStage('cleanup');
    await cleanupDump({ progress, workRoot, usesOwnDir, keep: !cleanupWorkDir });
    cleanupWorkDir = false; // Уже убрано, повторять в `finally` незачем.

    result.durationMs = Date.now() - startedAt;
    progress.finish({
      auditId,
      health: result.scores.health,
      updatability: result.scores.updatability,
      findings: result.findings.length,
      durationMs: result.durationMs,
    });

    log.info(`Аудит ${auditId} завершён: оценка ${result.scores.health}/100`);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    if (isCancelled(err)) {
      log.info(`Аудит ${auditId} остановлен пользователем через ${Math.round(durationMs / 1000)} с`);
      progress.cancelled(CANCEL_MESSAGE);
      await store.markCancelled(auditId, durationMs, CANCEL_MESSAGE);
      // Незавершённая выгрузка бесполезна — убираем, если её не просили сохранить.
      return null;
    }

    log.error(`Аудит ${auditId} завершился ошибкой: ${err.message}`, { stack: err.stack });
    progress.fail(err);
    await store.markFailed(auditId, err, durationMs);
    cleanupWorkDir = false; // Оставляем выгрузку для диагностики.
    throw err;
  } finally {
    if (cleanupWorkDir) {
      if (usesOwnDir) {
        // Каталог выбрал пользователь — удаляем только созданное аудитом.
        const removed = await removeOwnEntries(workRoot).catch(() => 0);
        log.info(`Выгрузка удалена: элементов ${removed} в ${workRoot}`);
      } else {
        await rmrf(workRoot).catch(() => {});
      }
    }
  }
}

/**
 * Удаление выгрузки — видимым этапом.
 *
 * Из чужого каталога удаляется только созданное аудитом: каталог выбирает
 * пользователь, там может лежать что угодно.
 */
async function cleanupDump({ progress, workRoot, usesOwnDir, keep }) {
  if (keep) {
    progress.skip('cleanup', 'выгрузка сохранена по требованию пользователя');
    return;
  }

  progress.update('cleanup', workRoot);
  try {
    if (usesOwnDir) {
      const removed = await removeOwnEntries(workRoot);
      log.info(`Выгрузка удалена: элементов ${removed} в ${workRoot}`);
      progress.done('cleanup', `удалено элементов: ${removed}`);
    } else {
      await rmrf(workRoot);
      progress.done('cleanup', 'каталог удалён');
    }
  } catch (err) {
    // Не повод считать аудит неудачным: отчёт уже готов. Но сказать надо —
    // иначе пользователь найдёт гигабайты на диске и не поймёт откуда.
    log.warn(`Не удалось очистить каталог выгрузки: ${err.message}`);
    progress.warn('cleanup', `не удалось очистить каталог: ${err.message}`);
  }
}

function connKindRu(kind) {
  return { file: 'файловая', server: 'серверная (клиент-сервер)', web: 'веб-подключение' }[kind] || kind;
}
