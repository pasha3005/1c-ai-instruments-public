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
  findRepositories, repositoryHistory, repositoryDumpCfg, filterByPeriod, authorsByObject,
  createContextInfobase,
} from '../onec/repository.js';
import { parseConfigurationDump } from '../parse/configuration.js';
import { collectModules } from '../parse/modules.js';
import { parseExtensions } from '../parse/extensions.js';
import { readConfigDumpInfo } from '../analyze/baselines.js';
import {
  prepareVendorConfig, buildChangeSet, summarizeVendorComparison, exportCfToXml,
} from '../analyze/vendorConfig.js';
import { runAnalysis } from '../analyze/index.js';
import { tagByRu } from '../parse/metadataKinds.js';
import { renderQualityReport } from '../report/qualityReport.js';
import * as store from '../store/qualityStore.js';
import { ensureDir, pathExists, dirSize, humanSize } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { runCancellable, throwIfCancelled, isCancelled, CANCEL_MESSAGE } from '../util/cancel.js';

const log = createLogger('quality');

export function runQuality({ qualityId, input, progress }) {
  return runCancellable(progress?.signal || null, () => runPipeline({ qualityId, input, progress }));
}

async function runPipeline({ qualityId, input, progress }) {
  const startedAt = Date.now();
  const workRoot = path.resolve(String(input.workDir || '').trim());
  const warnings = [];

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
    throw err;
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

async function fromRepository({ input, platform, workRoot, progress, warnings }) {
  startOrThrow(progress, 'source', 'Поиск хранилищ конфигурации');
  const repositories = await findRepositories(input.repositoryPath);
  if (!repositories.length) {
    throw new Error(
      `В каталоге ${input.repositoryPath} не найдено хранилищ конфигурации 1С. Каталог хранилища `
      + 'опознаётся по файлу cfgrepo.conf; укажите каталог, где лежат хранилища.',
    );
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

  for (const repo of repositories) {
    progress.update('export', `хранилище «${repo.name}»: история`);
    const history = await repositoryHistory({
      platform, contextBase, dir: repo.dir, workDir: workRoot,
      user: input.repositoryUser, password: input.repositoryPassword,
    });
    if (!history.ok) {
      warnings.push(`Хранилище «${repo.name}»: ${history.reason}`);
      progress.message(`Хранилище «${repo.name}» не прочитано: ${history.reason}`, 'warn');
      continue;
    }
    const own = filterByPeriod(history.commits, period);
    for (const commit of own) commits.push({ ...commit, repository: repo.name });
    progress.update('export', `хранилище «${repo.name}»: помещений за период ${own.length}`);

    progress.update('export', `хранилище «${repo.name}»: выгрузка конфигурации`);
    const dumped = await repositoryDumpCfg({
      platform, contextBase, dir: repo.dir, workDir: workRoot,
      user: input.repositoryUser, password: input.repositoryPassword,
    });
    if (!dumped.ok) {
      warnings.push(`Хранилище «${repo.name}»: код не получен — ${dumped.reason}`);
      continue;
    }

    const expanded = await exportCfToXml({
      cfFile: dumped.file, platform, workDir: workRoot, name: `repo-${repo.name}`,
      onProgress: (text) => progress.update('export', `«${repo.name}»: ${text}`),
    });
    if (!expanded.ok) {
      warnings.push(`Хранилище «${repo.name}»: конфигурация не развернулась — ${expanded.reason}`);
      continue;
    }
    // Первое хранилище с Configuration.xml считаем основной конфигурацией,
    // остальные — расширениями: у расширения свой корень, но модули читаются
    // тем же кодом.
    if (!mainDir) mainDir = expanded.dir;
    else extensionDirs.push({ name: repo.name, dir: expanded.dir });
  }

  if (!mainDir) {
    throw new Error(
      'Ни из одного хранилища не удалось получить конфигурацию. Проверьте имя пользователя '
      + 'и пароль хранилища: ' + (warnings[warnings.length - 1] || 'причина не определена'),
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

  const changeSet = {
    modified: touched,
    added: new Set(),
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
    repositories: repositories.map((r) => ({ name: r.name, dir: r.dir })),
    period,
    commits,
    authorsByObject: byObject,
  };
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

/** Ключ объекта замечания в русских именах — как их печатает хранилище. */
function objectKeyOf(finding) {
  const owner = finding.module?.ownerKind && finding.module?.ownerName
    ? `${finding.module.ownerKind}.${finding.module.ownerName}`
    : null;
  if (!owner) return null;
  // История хранилища печатает русские имена, а ключи анализа — английские.
  // Сопоставляем по второй части: имя объекта платформа не переводит.
  return owner;
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

function sanitize(input) {
  const { password, repositoryPassword, ...rest } = input || {};
  return { ...rest, hasPassword: Boolean(password), hasRepositoryPassword: Boolean(repositoryPassword) };
}

/** Существует ли путь — для проверок входных данных в маршруте. */
export { pathExists };
