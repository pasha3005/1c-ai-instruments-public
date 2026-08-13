/**
 * Конвейер проверки качества кода.
 *
 * Третий раздел продукта. От обследования отличается не движком — движок тот же
 * самый, — а вопросом: здесь нужны только замечания к коду, без оценок
 * состояния, объёма данных, прав и трудозатрат. И источник кода может быть
 * другим.
 *
 * **Два источника.**
 *
 *  * `infobase` — информационная база, как в обследовании: выгрузка в XML,
 *    сравнение с поставщиком, анализ только доработок. Авторство берётся
 *    из пометок в коде.
 *  * `repository` — хранилище конфигурации 1С. Ценнее тем, что авторство
 *    в хранилище записано платформой, а не угадывается: видно, кто и когда
 *    что поместил. Анализируются **только объекты, помещённые за указанный
 *    период**, и каждое замечание достаётся автору помещения.
 *
 * Почему в режиме хранилища анализ ограничен помещениями периода. В хранилище
 * лежит вся конфигурация, включая типовой код вендора, а главное правило
 * продукта — типовой код не анализировать никогда. Помещения за период дают
 * ровно тот перечень объектов, за которые отвечают разработчики, — это и есть
 * предмет проверки.
 */

import path from 'node:path';
import { resolvePlatform } from '../onec/platform.js';
import { parseConnection, validateConnection } from '../onec/connection.js';
import { exportConfiguration, exportExtensions } from '../onec/collector.js';
import {
  findRepositories, parseRepositoryAddresses, repositoryHistory, repositoryDumpCfg,
  filterByPeriod, authorsByObject, createContextInfobase, ensureContextExtension,
  expandExtensionCf, isExtensionRepositoryRefusal, isNetworkRepository,
} from '../onec/repository.js';
import { parseConfigurationDump } from '../parse/configuration.js';
import { collectModules } from '../parse/modules.js';
import { parseExtensions } from '../parse/extensions.js';
import { readConfigDumpInfo } from '../analyze/baselines.js';
import {
  prepareVendorConfig, buildChangeSet, summarizeVendorComparison, exportCfToXml,
} from '../analyze/vendorConfig.js';
import { diffModule } from '../analyze/bsl/moduleDiff.js';
import { placementFragments } from '../analyze/bsl/placementFragments.js';
import { tokenize } from '../analyze/bsl/lexer.js';
import { analyzeStructure } from '../analyze/bsl/structure.js';
import { runAnalysis } from '../analyze/index.js';
import { tagByRu } from '../parse/metadataKinds.js';
import { renderQualityReport } from '../report/qualityReport.js';
import * as store from '../store/qualityStore.js';
import { ensureDir, pathExists, dirSize, humanSize, readText } from '../util/fsx.js';
import { removeQualityOwnEntries } from '../util/workDir.js';
import { createLogger } from '../util/logger.js';
import {
  runCancellable, throwIfCancelled, isCancelled, rethrowIfCancelled, CANCEL_MESSAGE,
} from '../util/cancel.js';

const log = createLogger('quality');

export function runQuality({ qualityId, input, progress }) {
  return runCancellable(progress?.signal || null, () => runPipeline({ qualityId, input, progress }));
}

async function runPipeline({ qualityId, input, progress }) {
  const startedAt = Date.now();
  const workRoot = path.resolve(String(input.workDir || '').trim());
  const warnings = [];
  // Флаг «Сохранить выгрузку» — как в остальных разделах. Каталог задаёт
  // пользователь, поэтому удаляется только созданное самой проверкой.
  let cleanupWorkDir = input.keepDump !== true;

  const startStage = (id, detail = '') => {
    throwIfCancelled();
    progress.start(id, detail);
  };

  try {
    startStage('prepare');
    await ensureDir(workRoot);
    progress.done('prepare', workRoot);

    startStage('platform', 'Поиск установленных версий 1С:Предприятие');
    const { platform, exact, available } = await resolvePlatform(input.platformVersion);
    if (!exact && input.platformVersion) {
      progress.message(
        `Версия ${input.platformVersion} не найдена. Используется ${platform.version}. `
        + `Доступны: ${available.join(', ')}`, 'warn',
      );
    }
    progress.done('platform', platform.version);

    const prepared = input.source === 'repository'
      ? await fromRepository({ input, platform, workRoot, progress, warnings })
      : await fromInfobase({ input, platform, workRoot, progress, warnings });

    // ---------- Анализ ----------
    startStage('analyze', 'Статический анализ кода');
    const analysis = await runAnalysis({
      parsed: prepared.parsed,
      modules: prepared.modules,
      extensions: prepared.extensions,
      roles: [],
      live: { available: false, reason: 'не требуется для проверки качества', counts: [], tables: [] },
      infobaseFacts: null,
      baseline: null,
      changeSet: prepared.changeSet,
      vendorComparison: prepared.vendorComparison,
      vendorDir: prepared.vendorDir,
      vendorDetails: prepared.vendorDetails,
      input,
      hooks: {
        onCodeProgress: (done, total) => progress.update('analyze', `модуль ${done} из ${total}`),
      },
    });

    // В режиме хранилища авторство даёт платформа, а не пометки в коде:
    // подменяем его до сборки отчёта, чтобы группировка по разработчикам
    // строилась на записях хранилища.
    if (prepared.authorsByObject) {
      applyRepositoryAuthors(analysis.findings, prepared.authorsByObject);
    }

    const bySeverity = countBy(analysis.findings, (f) => f.severity);
    const authors = new Set(analysis.findings.map((f) => f.author).filter(Boolean));
    progress.done('analyze',
      `замечаний ${analysis.findings.length}, критичных ${bySeverity.critical || 0}`);

    // ---------- Отчёт ----------
    startStage('report', 'Сборка отчёта');
    const result = {
      qualityId,
      source: input.source === 'repository' ? 'repository' : 'infobase',
      generatedAt: new Date().toISOString(),
      input: sanitize(input),
      platformVersion: platform.version,
      infobase: prepared.infobase || null,
      repositories: prepared.repositories || null,
      period: prepared.period || null,
      commits: prepared.commits || null,
      configuration: prepared.parsed.configuration,
      vendorComparison: prepared.vendorComparison,
      findings: analysis.findings,
      codeStats: analysis.code || null,
      effort: analysis.effort || null,
      dictionaries: analysis.dictionaries,
      bySeverity,
      totals: {
        modules: prepared.modules.length,
        analyzedModules: analysis.code?.analyzedModules ?? null,
        findings: analysis.findings.length,
        authors: authors.size,
      },
      warnings,
      durationMs: Date.now() - startedAt,
    };

    await store.saveResult(qualityId, result);
    await store.saveReport(qualityId, renderQualityReport(result));
    progress.done('report', 'отчёт готов');

    // Уборка — видимым этапом, а не молча после завершения: выгрузка хранилищ
    // и база-контекст занимают место, и пользователь должен видеть, что с ними
    // стало. Проверка считается законченной после уборки.
    startStage('cleanup');
    await cleanupQualityDump({ progress, workRoot, keep: !cleanupWorkDir });
    cleanupWorkDir = false;

    result.durationMs = Date.now() - startedAt;
    progress.finish({
      qualityId,
      findings: analysis.findings.length,
      critical: bySeverity.critical || 0,
      durationMs: result.durationMs,
    });
    log.info(`Проверка качества ${qualityId} завершена: замечаний ${analysis.findings.length}`);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (isCancelled(err)) {
      progress.cancelled(CANCEL_MESSAGE);
      await store.markCancelled(qualityId, durationMs, CANCEL_MESSAGE);
      return null;
    }
    log.error(`Проверка качества ${qualityId} завершилась ошибкой: ${err.message}`, { stack: err.stack });
    progress.fail(err);
    await store.markFailed(qualityId, err, durationMs);
    cleanupWorkDir = false; // Оставляем выгрузку для разбора причины.
    throw err;
  } finally {
    // Сюда попадаем только после прерывания: успешный прогон убирает за собой
    // видимым этапом, а неудачный оставляет выгрузку намеренно.
    if (cleanupWorkDir) {
      const removed = await removeQualityOwnEntries(workRoot).catch(() => 0);
      log.info(`Выгрузка проверки качества удалена: элементов ${removed} в ${workRoot}`);
    }
  }
}

/** Очистка каталога выгрузки — по флагу «Сохранить выгрузку», видимым этапом. */
async function cleanupQualityDump({ progress, workRoot, keep }) {
  if (keep) {
    progress.skip('cleanup', 'выгрузка сохранена по требованию пользователя');
    return;
  }
  progress.update('cleanup', workRoot);
  try {
    const removed = await removeQualityOwnEntries(workRoot);
    log.info(`Выгрузка проверки качества очищена: элементов ${removed} в ${workRoot}`);
    progress.done('cleanup', `удалено элементов: ${removed}`);
  } catch (err) {
    // Отчёт уже готов — не повод считать проверку неудачной. Но сказать надо:
    // иначе пользователь найдёт лишнее на диске и не поймёт откуда.
    log.warn(`Не удалось очистить каталог выгрузки: ${err.message}`);
    progress.warn('cleanup', `не удалось очистить: ${err.message}`);
  }
}

// --- Источник: информационная база -------------------------------------------

async function fromInfobase({ input, platform, workRoot, progress, warnings }) {
  startOrThrow(progress, 'source', 'Проверка пути к информационной базе');
  const conn = parseConnection(input.infobasePath);
  const validation = await validateConnection(conn);
  for (const warning of validation.warnings) progress.message(warning, 'warn');
  progress.done('source', conn.display);

  const ctx = {
    platform, conn, workDir: workRoot, user: input.user, password: input.password,
  };

  startOrThrow(progress, 'export', 'Выгрузка конфигурации в XML (может занять несколько минут)');
  const exported = await exportConfiguration({
    ...ctx,
    onProgress: (text) => {
      const line = text.trim().split('\n').pop();
      if (line) progress.update('export', line.slice(0, 160));
    },
  });
  let extensionDirs = [];
  try {
    const ext = await exportExtensions({ ...ctx });
    extensionDirs = ext.extensions;
    if ((ext.missing || []).length) {
      warnings.push(`Не выгружены расширения: ${ext.missing.join(', ')} — их код в проверку не попал.`);
    }
  } catch (err) {
    if (isCancelled(err)) throw err;
    progress.message(`Расширения не выгружены: ${err.message}`, 'warn');
  }
  progress.done('export', `${humanSize(await dirSize(exported.dir))}, расширений ${extensionDirs.length}`);

  const parsedData = await parseAll({ dir: exported.dir, extensionDirs, progress });

  startOrThrow(progress, 'vendor', 'Сравнение с конфигурацией поставщика');
  const vendor = await prepareVendorConfig({
    vendorPath: input.vendorConfigPath,
    ...ctx,
    configName: parsedData.parsed.configuration.name,
    totalEntries: Object.keys(parsedData.parsed.hashes || {}).length,
    onProgress: (text) => progress.update('vendor', text),
  });

  let changeSet = null;
  let vendorComparison = { available: false, reason: vendor.reason };
  if (vendor.available) {
    changeSet = vendor.changeSet || buildChangeSet(parsedData.parsed.hashes || {}, vendor.hashes);
    vendorComparison = summarizeVendorComparison(vendor, changeSet, parsedData.parsed.objects);
    progress.done('vendor', `изменено ${changeSet.modified.size}, добавлено ${changeSet.added.size}`);
  } else {
    progress.skip('vendor', vendor.reason || 'не используется');
    warnings.push(
      `Конфигурация поставщика недоступна: ${vendor.reason} Проверен весь код конфигурации, `
      + 'включая типовой, — замечания к типовому решению исправлять обычно не нужно.',
    );
  }

  return {
    ...parsedData,
    changeSet,
    vendorComparison,
    vendorDir: vendor.dir || null,
    vendorDetails: vendor.details || null,
    infobase: { kind: conn.kind, display: conn.display },
  };
}

// --- Источник: хранилище конфигурации ----------------------------------------

/**
 * Что считать хранилищем: каталог на диске или адрес сервера хранилищ.
 *
 * Переключатель в форме — не единственное основание, и это исправление
 * по живому случаю (13.08.2026, сервер заказчика). Адрес
 * `tcp://сервер/erp25/хранилище` был вставлен в поле «Каталог с хранилищами»,
 * переключатель остался на «Каталог на диске» — и программа честно пошла
 * искать в этом «каталоге» файл `cfgrepo.conf`, а не найдя, обвинила
 * пользователя: «укажите каталог, где лежат хранилища». Между тем строка
 * вида `tcp://…` ни на какой каталог не похожа и толкуется однозначно.
 *
 * Поэтому адрес узнаётся по себе самому, где бы его ни ввели. Переключатель
 * остаётся — он решает, какое поле показывать, — но ошибиться им больше
 * не значит получить отказ.
 */
export function repositorySource(input) {
  const address = String(input.repositoryAddress || '').trim();
  const dir = String(input.repositoryPath || '').trim();

  if (input.repositoryKind === 'address' && address) return { byAddress: true, value: address };
  // Похоже на адрес — значит адрес, независимо от положения переключателя.
  if (looksLikeAddresses(dir)) return { byAddress: true, value: dir };
  if (!dir && address) return { byAddress: true, value: address };
  return { byAddress: false, value: dir };
}

/** Все ли строки значения — сетевые адреса. Каталог не бывает вперемешку с ними. */
function looksLikeAddresses(value) {
  const lines = String(value || '').split(/[\n;]+/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(isNetworkRepository);
}

async function fromRepository({ input, platform, workRoot, progress, warnings }) {
  const { byAddress, value } = repositorySource(input);
  startOrThrow(progress, 'source', byAddress
    ? 'Проверка сетевого адреса хранилища'
    : 'Поиск хранилищ конфигурации');

  // Каталог программа обходит сама и находит в нём все хранилища; сетевые
  // адреса перечислить нечем — сервер хранилищ списка не отдаёт, — поэтому
  // там разбирается ровно то, что указал пользователь.
  const repositories = byAddress
    ? parseRepositoryAddresses(value)
    : await findRepositories(value);

  if (!repositories.length) {
    throw new Error(byAddress
      ? 'Не указан ни один сетевой адрес хранилища. Адрес выглядит так: '
        + 'tcp://сервер/хранилище; несколько адресов пишутся по одному в строке.'
      : `В каталоге ${value} не найдено хранилищ конфигурации 1С. Каталог хранилища `
        + 'опознаётся по файлу cfgrepo.conf; укажите каталог, где лежат хранилища.');
  }
  progress.done('source', `хранилищ: ${repositories.length} (${repositories.map((r) => r.name).join(', ')})`);

  startOrThrow(progress, 'export', 'Чтение истории и выгрузка конфигурации из хранилища');
  // Командам хранилища нужна база-контекст, но привязывать её к хранилищу
  // не требуется — проверено. Поэтому создаём пустую временную.
  const contextBase = await createContextInfobase({ platform, workDir: workRoot });

  const period = { from: input.periodFrom || '', to: input.periodTo || '' };
  const commits = [];
  let mainDir = null;
  const extensionDirs = [];
  // Статус каждого хранилища — отдельно от warnings (тех же текстов, но
  // строкой для всего прогона): отчёту нужно показать таблицу помещений
  // при каждом хранилище персонально, включая те, что не прочитались.
  const repoStatus = [];

  for (const repo of repositories) {
    progress.update('export', `хранилище «${repo.name}»: история`);
    let history = await repositoryHistory({
      platform, contextBase, dir: repo.dir, workDir: workRoot,
      user: input.repositoryUser, password: input.repositoryPassword,
    });

    // Хранилище расширений отвечает «Соединение основной конфигурации
    // с хранилищем расширений конфигураций невозможно»: ему нужно расширение
    // базы-контекста, а не сама база. Заводим пустое и повторяем — имя
    // расширения в базе с именем расширения в хранилище платформа не сверяет
    // (проверено), поэтому одного хватает на все хранилища расширений.
    if (!history.ok && isExtensionRepositoryRefusal(history.reason)) {
      progress.update('export', `хранилище «${repo.name}»: это хранилище расширений`);
      const context = await ensureContextExtension({ platform, contextBase });
      if (context.ok) {
        repo.extension = context.name;
        history = await repositoryHistory({
          platform, contextBase, dir: repo.dir, workDir: workRoot,
          user: input.repositoryUser, password: input.repositoryPassword,
          extension: repo.extension,
        });
        // Если и через расширение не вышло — сказать об этом прямо. Иначе
        // сообщение слово в слово повторяет первую попытку, и по нему нельзя
        // понять, дошло ли дело до второй: на этом однажды потерялся день.
        if (!history.ok) {
          history = {
            ...history,
            reason: `${history.reason} (повторная попытка через расширение базы-контекста `
              + `«${context.name}» тоже не удалась)`,
          };
        }
      } else {
        history = {
          ...history,
          reason: `${history.reason}. Расширение в базе-контексте не создано: ${context.reason}`,
        };
      }
    }

    if (!history.ok) {
      warnings.push(`Хранилище «${repo.name}»: ${history.reason}`);
      progress.message(`Хранилище «${repo.name}» не прочитано: ${history.reason}`, 'warn');
      repoStatus.push({ name: repo.name, dir: repo.dir, ok: false, reason: history.reason });
      continue;
    }
    const own = filterByPeriod(history.commits, period);
    for (const commit of own) commits.push({ ...commit, repository: repo.name });
    progress.update('export', `хранилище «${repo.name}»: помещений за период ${own.length}`);

    progress.update('export', `хранилище «${repo.name}»: выгрузка конфигурации`);
    const dumped = await repositoryDumpCfg({
      platform, contextBase, dir: repo.dir, workDir: workRoot,
      user: input.repositoryUser, password: input.repositoryPassword,
      extension: repo.extension || '',
    });
    if (!dumped.ok) {
      warnings.push(`Хранилище «${repo.name}»: код не получен — ${dumped.reason}`);
      repoStatus.push({ name: repo.name, dir: repo.dir, ok: false, reason: dumped.reason });
      continue;
    }

    const expanded = await expandRepositoryCf({
      repo, cfFile: dumped.file, platform, contextBase, workRoot,
      onProgress: (text) => progress.update('export', `«${repo.name}»: ${text}`),
    });
    if (!expanded.ok) {
      warnings.push(`Хранилище «${repo.name}»: конфигурация не развернулась — ${expanded.reason}`);
      repoStatus.push({ name: repo.name, dir: repo.dir, ok: false, reason: expanded.reason });
      continue;
    }
    // Основная конфигурация — первое хранилище БЕЗ расширения: у расширения
    // свой корень, и подменять им конфигурацию нельзя. Модули и там, и там
    // читаются одним кодом.
    const isMain = !mainDir && !repo.extension;
    repoStatus.push({
      name: repo.name, dir: repo.dir, ok: true, isMain, isExtension: Boolean(repo.extension),
    });
    if (isMain) mainDir = expanded.dir;
    else extensionDirs.push({ name: repo.name, dir: expanded.dir });
  }

  if (!mainDir && extensionDirs.length) {
    // Указали каталог с одними хранилищами расширений — это законный случай
    // (расширения ведут отдельно от конфигурации). Разбор состава объектов
    // ждёт один корень, поэтому корнем становится первое расширение,
    // а остальные остаются расширениями.
    const first = extensionDirs.shift();
    mainDir = first.dir;
    const status = repoStatus.find((r) => r.name === first.name);
    if (status) status.isMain = true;
  }

  if (!mainDir) {
    // Что проверять в первую очередь — зависит от того, как задано хранилище:
    // у каталога это почти всегда доступ, у адреса — сам адрес и доступность
    // сервера хранилищ, и отсылать пользователя к паролю было бы вредным
    // советом.
    throw new Error(
      'Ни из одного хранилища не удалось получить конфигурацию. '
      + (byAddress
        ? 'Проверьте адрес хранилища, доступность сервера хранилищ, имя пользователя и пароль: '
        : 'Проверьте имя пользователя и пароль хранилища: ')
      + (warnings[warnings.length - 1] || 'причина не определена'),
    );
  }

  const diffStats = await buildPlacementDiffs({
    platform, contextBase, workRoot, progress, commits, repositories,
    user: input.repositoryUser, password: input.repositoryPassword,
  });
  if (diffStats.limited) {
    warnings.push(
      `Правки показаны не по всем помещениям периода: выгрузок понадобилось больше `
      + `${diffStats.dumps}, и дальше отчёт бы собирался слишком долго. Сузьте период, `
      + 'чтобы увидеть правки остальных помещений.',
    );
  }

  progress.done('export', `помещений за период: ${commits.length}`);

  const parsedData = await parseAll({ dir: mainDir, extensionDirs, progress });

  // Анализируем только то, что помещали за период. История печатает русские
  // имена объектов, а анализ знает их ключами ConfigDumpInfo — переводим сразу,
  // и авторов раскладываем по тем же ключам, иначе замечания к ним не привяжутся.
  const byRussian = authorsByObject(commits);
  const touched = new Set();
  const byObject = new Map();
  for (const [russian, entry] of byRussian) {
    const key = keyFromRussian(russian);
    if (!key) continue;
    touched.add(key);
    byObject.set(key, entry);
  }
  progress.skip('vendor', 'не требуется: разбираются помещения за период');

  // У хранилища нет понятия «поставщик» — сравнивать помещённый код не с чем.
  // Поэтому все тронутые за период объекты идут в `added`, а не в `modified`:
  // `modified` в остальном движке означает «изменённый ТИПОВОЙ модуль», и тогда
  // анализ ищет в нём только участки, обрамлённые пометками разработчика
  // («// ++ Фамилия»). В хранилище таких пометок обычно нет — код и так весь
  // авторский, — и модуль без пометок тихо исключался из анализа целиком.
  // Так, например, не находился вызов Сообщить() во вновь помещённом модуле:
  // модуль был в `touched`, но `isAddedModule` смотрел только в `added`,
  // видел пустое множество и включал модуль в «типовые с пометками».
  const changeSet = {
    modified: new Set(),
    added: touched,
    removed: new Set(),
    unchanged: 0,
    totalClient: parsedData.modules.length,
    totalVendor: 0,
    isChanged: (key) => touched.has(key) || touched.has(key.split('.').slice(0, 2).join('.')),
  };

  return {
    ...parsedData,
    changeSet,
    vendorComparison: { available: false, reason: 'источник — хранилище конфигурации' },
    vendorDir: null,
    vendorDetails: null,
    repositories: repoStatus,
    period,
    commits,
    authorsByObject: byObject,
  };
}

/** Сколько дополнительных выгрузок хранилища допускается ради диффов правок. */
const MAX_PLACEMENT_DUMPS = 40;

/**
 * Разворачивает выгрузку хранилища в XML — тем способом, который годится
 * для этого хранилища.
 *
 * Конфигурация приходит файлом `.cf` и разворачивается своей временной базой
 * (ibcmd умеет создать базу сразу из файла). Расширение приходит `.cfe`,
 * и так его не развернуть: расширение живёт внутри базы под именем. Поэтому
 * оно загружается в расширение-заглушку базы-контекста и выгружается оттуда.
 */
async function expandRepositoryCf({ repo, cfFile, platform, contextBase, workRoot, onProgress }) {
  const name = `repo-${safeFileName(repo.name)}${repo.suffix || ''}`;
  if (repo.extension) {
    return expandExtensionCf({
      platform, contextBase, cfFile, workDir: workRoot, name, extension: repo.extension,
    });
  }
  return exportCfToXml({ cfFile, platform, workDir: workRoot, name, onProgress });
}

/**
 * Дифф каждого помещённого модуля — именно той правки, что внесена ЭТИМ
 * помещением, а не накопленной за весь период.
 *
 * Версии хранилища атомарны: между версией V-1 и версией V поменялось ровно
 * то, что перечислено в помещении V, — поэтому выгрузки конфигурации на этих
 * двух версиях достаточно, чтобы построить точный дифф каждого затронутого
 * объекта. Соседние помещения делят выгрузки версий между собой через кэш,
 * поэтому число выгрузок растёт с числом РАЗНЫХ версий в периоде, а не
 * с числом помещений.
 *
 * Предел числа выгрузок — не подстраховка «на всякий случай»: каждая
 * выгрузка — это отдельный вызов конфигуратора на десятки секунд-минуты,
 * а не миллисекунды, и период в сотню помещений растянул бы проверку
 * на часы. При достижении предела часть диффов остаётся без текста — это
 * показано в отчёте предупреждением, а не подменяется тишиной.
 */
async function buildPlacementDiffs({
  platform, contextBase, workRoot, progress, commits, repositories, user, password,
}) {
  const withCode = commits.filter((c) => (c.added.length || c.changed.length));
  if (!withCode.length) return { limited: false, dumps: 0 };

  const repoByName = new Map(repositories.map((r) => [r.name, r]));
  const cache = new Map();
  let dumps = 0;
  let limited = false;

  const versionModules = async (repoName, version) => {
    if (version < 1) return null;
    const key = `${repoName} ${version}`;
    if (cache.has(key)) return cache.get(key);
    if (dumps >= MAX_PLACEMENT_DUMPS) {
      limited = true;
      cache.set(key, null);
      return null;
    }
    const repo = repoByName.get(repoName);
    if (!repo) return null;
    dumps += 1;
    progress.update('export', `хранилище «${repoName}»: версия ${version} для диффа правок`);
    let entry = null;
    try {
      const dumped = await repositoryDumpCfg({
        platform, contextBase, dir: repo.dir, workDir: workRoot, user, password, version,
        extension: repo.extension || '',
      });
      if (dumped.ok) {
        const expanded = await expandRepositoryCf({
          repo: { ...repo, suffix: `-v${version}` },
          cfFile: dumped.file, platform, contextBase, workRoot,
        });
        if (expanded.ok) {
          const modules = await collectModules(expanded.dir);
          const byObject = new Map();
          for (const m of modules) {
            if (!m.ownerKind || !m.ownerName) continue;
            const k = `${m.ownerKind}.${m.ownerName}`;
            if (!byObject.has(k)) byObject.set(k, []);
            byObject.get(k).push(m);
          }
          entry = { byObject };
        }
      }
    } catch (err) {
      rethrowIfCancelled(err);
      log.warn(`Хранилище «${repoName}», версия ${version}: диф не построен (${err.message})`);
    }
    cache.set(key, entry);
    return entry;
  };

  for (const commit of withCode) {
    throwIfCancelled();
    const objects = [...new Set([...commit.added, ...commit.changed])];
    const after = await versionModules(commit.repository, commit.version);
    if (!after) continue;
    const before = await versionModules(commit.repository, commit.version - 1);

    const diffs = [];
    for (const russian of objects) {
      const key = keyFromRussian(russian);
      if (!key) continue;
      const afterModules = after.byObject.get(key) || [];
      const beforeModules = before?.byObject.get(key) || [];

      for (const am of narrowByRussianSuffix(russian, afterModules)) {
        throwIfCancelled();
        const bm = beforeModules.find(
          (m) => m.moduleType === am.moduleType && m.formName === am.formName,
        );
        const afterSource = await readTextSafe(am.file);
        if (afterSource == null) continue;
        const beforeSource = bm ? ((await readTextSafe(bm.file)) ?? '') : '';

        // Нужны только сами внесённые строки: колонки «до помещения» в отчёте
        // больше нет, а значит незачем и выравнивать версии построчно
        // (`diffModuleAligned` + `attachVendorLines`).
        const diff = diffModule(beforeSource, afterSource);

        // Модуль появился этим помещением — значит, добавлены все его строки,
        // и спрашивать об этом диф незачем. Более того, вредно: пустой текст
        // «до» — это одна пустая строка, диф находит ей пару среди пустых строк
        // модуля, и новый модуль разваливался на два блока с провалом
        // на случайной пустой строке (видно на живом хранилище 13.08.2026).
        const addedLines = bm
          ? diff.lines
          : afterSource.split(/\r?\n/).map((_, i) => i + 1);

        // Разбор структуры нужен ради группировки правок по процедурам
        // и функциям: без списка процедур блоки правки остались бы безымянными
        // «строками 12–18».
        const routines = routinesOf(afterSource);

        // Блоки строит `placementFragments`, а не `takeFragments`: второй
        // оставляет по одному участку на процедуру и склеивает участки через
        // разрыв в три строки. Для отчёта обследования это удобно, а здесь
        // приводило к двум неправдам сразу — вторая правка в процедуре
        // пропадала, а в блок затягивался давно лежавший в модуле чужой код.
        // Процедуры прежней версии — чтобы у каждой в дереве стоял значок
        // состояния: не было раньше — «добавлена», была — «изменена». Модуль,
        // появившийся этим помещением, сравнивать не с чем: там всё добавлено,
        // и пустой список прежних процедур это и означает.
        const { fragments, totalBlocks } = placementFragments({
          source: afterSource,
          addedLines,
          routines,
          previousRoutines: bm ? routinesOf(beforeSource) : [],
        });

        diffs.push({
          object: russian,
          moduleTitle: am.title,
          moduleType: am.moduleType,
          moduleTypeRu: am.moduleTypeRu,
          formName: am.formName || null,
          isNew: !bm,
          addedLines: addedLines.length,
          regionCount: totalBlocks,
          hiddenBlocks: Math.max(0, totalBlocks - fragments.length),
          fragments,
        });
      }
    }
    if (diffs.length) commit.moduleDiffs = diffs;
  }

  return { limited, dumps };
}

/**
 * Сужает список модулей объекта до того, о котором говорит история хранилища.
 *
 * Помещение перечисляет не только объекты целиком («Справочник.Номенклатура»),
 * но и подчинённые им формы и команды («Справочник.Номенклатура.Форма.ФормаЭлемента»).
 * Ключ анализа знает только владельца, поэтому без сужения к одной помещённой
 * форме приписались бы правки всех форм объекта разом.
 *
 * Сужаем ТОЛЬКО при точном совпадении имени формы или команды с хвостом
 * русского имени. Не совпало — возвращаем всё: перечень русских имён подчинённых
 * объектов у платформы шире, чем проверено живьём, и потерять правку хуже,
 * чем показать соседнюю.
 */
function narrowByRussianSuffix(russian, modules) {
  const parts = String(russian).split('.');
  if (parts.length < 3 || modules.length < 2) return modules;
  const tail = parts[parts.length - 1];
  const exact = modules.filter((m) => m.formName === tail);
  return exact.length ? exact : modules;
}

/**
 * Процедуры и функции модуля — для группировки правок по ним.
 *
 * Разбор дешёвый (лексер + один проход), но модулей в помещении бывает много,
 * поэтому сбой разбора не должен ронять весь прогон: без списка процедур
 * правки просто останутся негруппированными.
 */
function routinesOf(source) {
  try {
    // tokenize отдаёт `{tokens, stats}`, а структуре нужен сам массив токенов:
    // на объекте она молча возвращает ноль процедур, и все правки оказывались
    // «вне процедур» — ошибка тихая, поэтому на неё есть тест.
    return analyzeStructure(tokenize(source).tokens).routines;
  } catch (err) {
    log.warn(`Структура модуля не разобрана, правки покажем без процедур: ${err.message}`);
    return [];
  }
}

async function readTextSafe(file) {
  try {
    return await readText(file);
  } catch {
    return null;
  }
}

// --- Общее -------------------------------------------------------------------

async function parseAll({ dir, extensionDirs, progress }) {
  startOrThrow(progress, 'parse', 'Чтение состава объектов и модулей');
  const parsed = await parseConfigurationDump(dir, {
    onProgress: (done, total, name) => progress.update('parse', `${done} из ${total}: ${name}`),
  });
  parsed.hashes = await readConfigDumpInfo(path.join(dir, 'ConfigDumpInfo.xml'));

  const modules = await collectModules(dir);
  for (const ext of extensionDirs) {
    const extModules = await collectModules(ext.dir, ext.name);
    modules.push(...extModules);
  }
  const extensions = await parseExtensions(extensionDirs);
  progress.done('parse', `объектов ${parsed.totals.objects}, модулей ${modules.length}`);
  return { parsed, modules, extensions };
}

/**
 * Русское имя объекта из истории хранилища → ключ, которым его знает анализ.
 *
 * «Справочник.Номенклатура» → «Catalog.Номенклатура». Имена объектов платформа
 * не переводит, переводится только вид. Что не опознали — пропускаем: лучше
 * недосчитать объект, чем открыть анализу типовой код.
 */
function keyFromRussian(name) {
  const parts = String(name).split('.');
  if (parts.length < 2) return null;
  const tag = tagByRu(parts[0]);
  return tag ? `${tag}.${parts[1]}` : null;
}

/**
 * Ставит замечаниям автора из хранилища.
 *
 * Пометки в коде («// ++ Иванов») здесь не нужны: хранилище знает автора точно.
 * Если объект замечания в помещениях периода не значится, автор остаётся
 * прежним — так видно, что замечание пришло не из разбираемых помещений.
 */
function applyRepositoryAuthors(findings, byObject) {
  for (const finding of findings) {
    const key = objectKeyOf(finding);
    const entry = key ? byObject.get(key) : null;
    if (!entry?.author) continue;
    finding.author = entry.author;
    finding.authorSource = 'хранилище конфигурации';
    finding.committedAt = entry.at;
    finding.commitComment = entry.comment;
  }
}

/**
 * Ключ объекта замечания — «Document.Документ4», как их складывает
 * `keyFromRussian` из истории хранилища.
 *
 * Владелец лежит у замечания ПЛОСКО (`ownerKind`, `ownerName`), а не во
 * вложенном `module`: так его кладёт `analyze/codeAnalyzer.js`. Пока здесь
 * читалось только `finding.module.*`, ключ всегда получался пустым, автор
 * из хранилища не проставлялся ни одному замечанию, и в колонке «Чей код»
 * вместо фамилии оставался значок происхождения. Вложенную форму читаем тоже:
 * так замечание выглядит в тестах и в старых сохранённых прогонах.
 */
function objectKeyOf(finding) {
  const kind = finding.ownerKind || finding.module?.ownerKind;
  const name = finding.ownerName || finding.module?.ownerName;
  return kind && name ? `${kind}.${name}` : null;
}

function countBy(items, pick) {
  const out = {};
  for (const item of items) {
    const key = pick(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function startOrThrow(progress, id, detail) {
  throwIfCancelled();
  progress.start(id, detail);
}

/** Имя хранилища → безопасное имя файла журнала. */
function safeFileName(name) {
  return String(name).replace(/[^\wа-яёА-ЯЁ-]+/g, '_').slice(0, 40) || 'repo';
}

function sanitize(input) {
  const { password, repositoryPassword, ...rest } = input || {};
  return { ...rest, hasPassword: Boolean(password), hasRepositoryPassword: Boolean(repositoryPassword) };
}

/** Существует ли путь — для проверок входных данных в маршруте. */
export { pathExists };

/** Экспортируется ради теста: привязка авторов — место, где уже ломалось. */
export { applyRepositoryAuthors };

/** Экспортируется ради теста: разбор процедур ломался молча, без ошибки. */
export { routinesOf };
