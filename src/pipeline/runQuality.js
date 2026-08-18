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
import { exportConfiguration, exportExtensions, exportObjectsToXml } from '../onec/collector.js';
import {
  findRepositories, parseRepositoryAddresses, repositoryHistory, repositoryDumpCfg,
  filterByPeriod, authorsByObject, createContextInfobase, ensureContextExtension,
  expandExtensionCf, isExtensionRepositoryRefusal, isMissingExtension, isNetworkRepository,
} from '../onec/repository.js';
import { readInfobaseBindings, matchRepository, describeBindings } from '../onec/infobaseBinding.js';
import { openRepositoryStore } from '../onec/store/repositoryStore.js';
import { loadLearnedKinds, saveLearnedKinds, matchKindsByReport } from '../onec/store/kinds.js';
import { parseConfigurationDump } from '../parse/configuration.js';
import { collectModules } from '../parse/modules.js';
import { parseExtensions } from '../parse/extensions.js';
import { readConfigDumpInfo } from '../analyze/baselines.js';
import {
  prepareVendorConfig, buildChangeSet, summarizeVendorComparison, exportCfToXml,
} from '../analyze/vendorConfig.js';
import { diffModule } from '../analyze/bsl/moduleDiff.js';
import { placementFragments } from '../analyze/bsl/placementFragments.js';
import { compareCfFiles } from '../onec/compareFiles.js';
import { reportedRegions } from '../analyze/codeAnalyzer.js';
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

    // Хранилище-каталог читается своими силами, платформа для него
    // не запускается ни разу — искать её незачем, и на машине без 1С
    // проверка всё равно проходит.
    const byFiles = input.source === 'repository' && repositoryKindOf(input) === 'folder';
    let platform = null;
    if (byFiles) {
      progress.skip('platform', 'не требуется: хранилище читается напрямую');
    } else {
      startStage('platform', 'Поиск установленных версий 1С:Предприятие');
      const resolved = await resolvePlatform(input.platformVersion);
      platform = resolved.platform;
      if (!resolved.exact && input.platformVersion) {
        progress.message(
          `Версия ${input.platformVersion} не найдена. Используется ${platform.version}. `
          + `Доступны: ${resolved.available.join(', ')}`, 'warn',
        );
      }
      progress.done('platform', platform.version);
    }

    let prepared;
    if (input.source !== 'repository') {
      prepared = await fromInfobase({ input, platform, workRoot, progress, warnings });
    } else if (byFiles) {
      prepared = await fromRepositoryByStore({ input, workRoot, progress, warnings });
    } else {
      prepared = await fromRepository({ input, platform, workRoot, progress, warnings });
    }

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
      platformVersion: platform ? platform.version : "",
      infobase: prepared.infobase || null,
      repositories: prepared.repositories || null,
      period: prepared.period || null,
      commits: prepared.commits || null,
      // Откуда взят код: из самих хранилищ или (когда развернуть их нечем)
      // выгрузкой служебной базы. Отчёт обязан говорить об этом прямо —
      // от этого зависит, что в нём вообще может быть видно.
      codeSource: prepared.codeSource || null,
      placementDiffs: prepared.placementDiffs || null,
      missingObjects: prepared.missingObjects || null,
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
 * Разбирает поле «Хранилище конфигурации» на источники.
 *
 * Поле одно на оба вида хранилища, и переключателя «каталог или адрес» больше
 * нет — он был вложен в переключатель источника и замечался не сразу. Живой
 * случай 13.08.2026 на сервере заказчика: адрес `tcp://сервер/erp25/хранилище`
 * ввели в поле каталога, переключатель остался на «Каталог на диске», и
 * программа честно пошла искать в этом «каталоге» файл `cfgrepo.conf`, а не
 * найдя, обвинила пользователя. Спрашивать было не о чем: строка вида `tcp://`
 * ни на какой каталог не похожа и толкуется однозначно.
 *
 * Строк может быть сколько угодно и вперемешку: у основной конфигурации и
 * у каждого расширения хранилище своё, каталог с ними бывает не один, а часть
 * может лежать на сервере хранилищ. Точка с запятой разделяет только адреса —
 * в пути к каталогу она встречается редко, но встречается, и рвать по ней путь
 * было бы хуже, чем не поддержать привычную запись адресов в строку.
 *
 * @returns {{byAddress: boolean, value: string}[]}
 */
/**
 * Где лежит хранилище: каталогом на диске или на сервере хранилищ.
 *
 * Выбор делает пользователь — от него зависит и способ работы, и набор полей
 * формы: каталог программа читает сама, к серверу ходит только платформа.
 * Прогоны, сохранённые прежними версиями, выбора не знают, поэтому там он
 * выводится из самих строк: сплошь адреса — значит сервер.
 */
export function repositoryKindOf(input) {
  if (input?.repositoryKind === 'tcp' || input?.repositoryKind === 'folder') {
    return input.repositoryKind;
  }
  const sources = repositorySources(input);
  return sources.length && sources.every((source) => source.byAddress) ? 'tcp' : 'folder';
}

export function repositorySources(input) {
  // `repositoryAddress` — поле прежних версий формы: у сохранённых прогонов
  // адрес лежит в нём, и повторный запуск из истории не должен уходить пустым.
  const raw = [input.repositoryPath, input.repositoryAddress]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');

  const sources = [];
  for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const parts = line.split(';').map((item) => item.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(isNetworkRepository)) {
      for (const part of parts) sources.push({ byAddress: true, value: part });
    } else {
      sources.push({ byAddress: isNetworkRepository(line), value: line });
    }
  }
  return sources;
}

/**
 * Чьё это хранилище с точки зрения служебной базы — и её ли оно вообще.
 *
 * Условие пользователя (18.08.2026): по `tcp://` указываются **только те
 * адреса, к которым служебная база уже подключена** — основной конфигурацией
 * либо одним из её расширений. Отсюда три следствия, и все три здесь:
 *
 *  1. чужой сетевой адрес — остановка прогона с перечнем того, к чему база
 *     подключена на самом деле. Идти к такому хранилищу вслепую нельзя:
 *     непонятно ни чьё оно, ни каким расширением его читать;
 *  2. распознанное хранилище расширения снимает главный отказ режима «только
 *     чтение». Раньше программа отказывалась читать такие хранилища, потому
 *     что конфигуратору нужно расширение в базе, а создавать его в служебной
 *     базе запрещено. Но подключённое расширение в базе **уже есть** —
 *     создавать нечего, и чтение остаётся чтением;
 *  3. пользователь хранилища сверяется с тем, под которым база подключена:
 *     переподключать чужую базу под другим пользователем программа не станет.
 *
 * Каталоги проверяются мягче: к хранилищу-каталогу база может быть и не
 * подключена — он читается по пути, — поэтому там расхождение это
 * предупреждение, а распознавание работает так же и служит только тому, чтобы
 * сразу знать, где хранилище расширений.
 *
 * Без служебной базы (работает своя временная) сверять не с чем: своя база
 * не подключена ни к чему.
 *
 * Само решение принимает `classifyRepositories` — оно чистое и потому
 * проверяется тестами; `bindRepositories` читает привязку с диска и превращает
 * решение в остановку прогона.
 *
 * @returns {{strangers: string[], mismatched: string[], notes: string[]}}
 */
export function classifyRepositories({ repositories, bindings, repositoryUser }) {
  const strangers = [];
  const mismatched = [];
  const notes = [];
  const given = String(repositoryUser || '').trim();

  for (const repo of repositories) {
    const isNetwork = isNetworkRepository(repo.dir);
    const match = matchRepository(repo.dir, bindings);
    if (!match) {
      // Каталог читается по пути, и подключённость базы к нему ничего не
      // решает; сетевой адрес без привязки — это тот самый случай, ради
      // которого всё и делается.
      if (isNetwork) strangers.push(repo.dir);
      continue;
    }

    repo.role = match.kind;
    if (match.kind === 'extension') {
      repo.boundExtension = match.extensionName || '';
      // Контекстом годится ЛЮБОЕ существующее расширение базы: имя расширения
      // в базе платформа с именем расширения в хранилище не сверяет (проверено
      // 12.08.2026 двумя разными именами на одном хранилище). Поэтому первым
      // идёт опознанное, а следом остальные — на случай устаревшего профиля.
      repo.extensionCandidates = [
        ...(match.extensionName ? [match.extensionName] : []),
        ...(bindings.extensionNames || []).filter((name) => name !== match.extensionName),
      ];
      repo.extension = repo.extensionCandidates[0] || '';
    }

    if (match.user && given && match.user.toLowerCase() !== given.toLowerCase()) {
      if (isNetwork) {
        mismatched.push(`${repo.name}: база подключена под «${match.user}», указан «${given}»`);
      } else {
        notes.push(`Хранилище «${repo.name}»: служебная база подключена к нему под пользователем `
          + `хранилища «${match.user}», а в форме указан «${given}».`);
      }
    }
  }

  return { strangers, mismatched, notes };
}

async function bindRepositories({ input, repositories, progress, warnings }) {
  if (!input.serviceBase) return null;

  const network = repositories.filter((r) => isNetworkRepository(r.dir));
  const bindings = await readInfobaseBindings(input.serviceBase);

  if (!bindings.ok) {
    if (!network.length) {
      warnings.push(`Привязку служебной базы к хранилищам проверить не удалось: ${bindings.reason}. `
        + 'Хранилища заданы каталогами и читаются по пути, поэтому проверка не обязательна.');
      return null;
    }
    throw new Error(
      `Сетевые адреса хранилищ сверить не с чем: ${bindings.reason}. `
      + 'По сети (tcp://) программа работает только с теми хранилищами, к которым служебная база '
      + 'уже подключена: иначе неизвестно ни чьё это хранилище, ни каким расширением его читать. '
      + 'Откройте служебную базу конфигуратором на этой машине под этим пользователем Windows '
      + '(Конфигурация → Хранилище конфигурации) и запустите проверку заново.',
    );
  }

  const { strangers, mismatched, notes } = classifyRepositories({
    repositories, bindings, repositoryUser: input.repositoryUser,
  });
  warnings.push(...notes);

  if (strangers.length) {
    throw new Error(
      `Служебная база не подключена к этим хранилищам: ${strangers.join(', ')}. `
      + 'Ни основная конфигурация базы, ни одно из её расширений с этими адресами не связаны. '
      + `База «${bindings.base}» подключена к: ${describeBindings(bindings).join('; ') || 'ничему'}. `
      + 'Проверьте адрес или укажите ту базу, через которую вы работаете с этим хранилищем: '
      + 'переподключать базу программа не станет.',
    );
  }
  if (mismatched.length) {
    throw new Error(
      `Указан не тот пользователь хранилища. ${mismatched.join('; ')}. `
      + 'Программа работает с хранилищем от имени того пользователя, под которым база к нему '
      + 'подключена, и переподключать её под другим не станет — укажите в форме этого же '
      + 'пользователя и его пароль.',
    );
  }

  const named = repositories.filter((r) => r.role);
  progress.update('source', `привязка служебной базы: опознано хранилищ ${named.length} из ${repositories.length}`);
  return bindings;
}

/**
 * Что из помещений периода идёт в анализ и кому достаются замечания.
 *
 * История печатает русские имена объектов, а анализ знает их ключами
 * ConfigDumpInfo — переводим сразу, и авторов раскладываем по тем же ключам,
 * иначе замечания к ним не привяжутся.
 *
 * У хранилища нет понятия «поставщик» — сравнивать помещённый код не с чем.
 * Поэтому все тронутые за период объекты идут в `added`, а не в `modified`:
 * `modified` в остальном движке означает «изменённый ТИПОВОЙ модуль», и тогда
 * анализ ищет в нём только участки, обрамлённые пометками разработчика
 * («// ++ Фамилия»). В хранилище таких пометок обычно нет — код и так весь
 * авторский, — и модуль без пометок тихо исключался из анализа целиком.
 */
function repositoryChangeSet(parsedData, commits) {
  const touched = new Set();
  const byObject = new Map();
  for (const [russian, entry] of authorsByObject(commits)) {
    const key = keyFromRussian(russian);
    if (!key) continue;
    touched.add(key);
    byObject.set(key, entry);
  }

  return {
    changeSet: {
      modified: new Set(),
      added: touched,
      removed: new Set(),
      unchanged: 0,
      totalClient: parsedData.modules.length,
      totalVendor: 0,
      isChanged: (key) => touched.has(key) || touched.has(key.split('.').slice(0, 2).join('.')),
    },
    vendorComparison: { available: false, reason: 'источник — хранилище конфигурации' },
    vendorDir: null,
    vendorDetails: null,
    authorsByObject: byObject,
  };
}

/**
 * Спрашивает у платформы виды объектов, которых нет в таблице.
 *
 * Платформа печатает в отчёте по хранилищу полные имена
 * («ОбщийМодуль.Расш1_ОбщийМодуль1»), а имена объектов в хранилище уникальны —
 * значит, соответствие «идентификатор класса → вид» получается точным.
 * Один вызов конфигуратора, и только когда незнакомый вид действительно
 * встретился; выученное сохраняется и дальше работает без платформы.
 *
 * Платформы на машине может не быть вовсе — хранилище-каталог читается и без
 * неё. Тогда просто ничего не выучим: об этом скажет отчёт.
 */
async function learnKindsByPlatform({ repo, store, workRoot, progress, warnings }) {
  try {
    progress.update('export', `хранилище «${repo.name}»: уточняем виды объектов у платформы`);
    const { platform } = await resolvePlatform('');
    const contextBase = await createContextInfobase({ platform, workDir: workRoot });
    const history = await repositoryHistory({
      platform, contextBase, dir: repo.dir, workDir: workRoot,
    });
    if (!history.ok) throw new Error(history.reason);
    return matchKindsByReport({ store, unknown: store.unknownClasses, commits: history.commits });
  } catch (err) {
    rethrowIfCancelled(err);
    warnings.push(`Виды некоторых объектов хранилища «${repo.name}» уточнить не удалось `
      + `(${err.message}). Их код в проверку не попадёт.`);
    return new Map();
  }
}

/**
 * Хранилище-КАТАЛОГ: читается напрямую, без платформы.
 *
 * Всё, что нужно отчёту, лежит в файлах хранилища (`onec/store/`): история
 * помещений, авторы, комментарии и код каждой версии. Платформа здесь
 * не запускается ни разу, поэтому не нужны ни лицензия, ни служебная база,
 * ни пользователь хранилища — и не спрашиваются в форме. Сверено с отчётом
 * самой платформы на двух хранилищах: история совпала полностью, тексты
 * модулей — побайтно.
 */
async function fromRepositoryByStore({ input, workRoot, progress, warnings }) {
  startOrThrow(progress, 'source', 'Поиск хранилищ конфигурации');
  const sources = repositorySources(input);
  const addresses = sources.filter((source) => source.byAddress).map((source) => source.value);
  if (addresses.length) {
    throw new Error(
      `В режиме «Каталог на диске» указан сетевой адрес: ${addresses.join(', ')}. `
      + 'Сетевое хранилище читается только платформой — переключитесь на «Сервер хранилищ (tcp)».',
    );
  }
  const dirs = sources.map((source) => source.value);
  const repositories = [];
  for (const dir of dirs) {
    for (const found of await findRepositories(dir)) {
      if (!repositories.some((known) => known.dir === found.dir)) repositories.push(found);
    }
  }
  if (!repositories.length) {
    throw new Error(
      `Хранилищ конфигурации 1С не найдено: ${dirs.join(', ') || 'каталог не указан'}. `
      + 'Каталог хранилища опознаётся по файлу cfgrepo.conf; укажите сам каталог хранилища '
      + 'или каталог, в котором их несколько.',
    );
  }
  progress.done('source', `хранилищ: ${repositories.length} (${repositories.map((r) => r.name).join(', ')})`);

  startOrThrow(progress, 'export', 'Чтение хранилищ');
  const period = { from: input.periodFrom || '', to: input.periodTo || '' };
  const commits = [];
  const repoStatus = [];
  const extensionDirs = [];
  const stores = new Map();
  const unknownClasses = new Set();
  let mainDir = null;

  const learnedKinds = await loadLearnedKinds();

  for (const repo of repositories) {
    progress.update('export', `хранилище «${repo.name}»: история`);
    try {
      const store = await openRepositoryStore(repo.dir, { extraKinds: learnedKinds });
      stores.set(repo.name, store);

      let all = store.history();
      // Незнакомый вид объекта — не приговор: платформа печатает полные имена
      // в отчёте по этому же хранилищу, и по ним вид выясняется точно.
      // Спрашиваем только когда действительно нужно, и запоминаем навсегда.
      if (store.unknownClasses.size) {
        const learned = await learnKindsByPlatform({ repo, store, workRoot, progress, warnings });
        if (learned.size) {
          store.learnKinds(learned);
          for (const [id, tag] of learned) learnedKinds.set(id, tag);
          await saveLearnedKinds(learned);
          all = store.history();
        }
      }
      const own = filterByPeriod(all, period);
      for (const commit of own) commits.push({ ...commit, repository: repo.name });

      const latest = all.reduce((max, commit) => Math.max(max, commit.version), 0);
      const objects = placedObjects(own);
      progress.update('export', `хранилище «${repo.name}»: помещений ${own.length}, объектов ${objects.length}`);

      // Первое хранилище считается основной конфигурацией, остальные —
      // расширениями: по файлам хранилища одно от другого не отличить,
      // а угадывать по имени корня нельзя — конфигурацию могут звать как
      // угодно.
      const isMain = !mainDir;
      const dir = path.join(workRoot, `store-${safeFileName(repo.name)}`);
      const done = await store.materialize({ version: latest, outDir: dir, objects });
      for (const cls of store.unknownClasses) unknownClasses.add(cls);

      repoStatus.push({
        name: repo.name,
        dir: repo.dir,
        ok: true,
        isMain,
        isExtension: !isMain,
        role: isMain ? 'main' : 'extension',
        boundExtension: null,
      });
      if (isMain) mainDir = done.dir;
      else extensionDirs.push({ name: repo.name, dir: done.dir });
    } catch (err) {
      rethrowIfCancelled(err);
      warnings.push(`Хранилище «${repo.name}» не прочитано: ${err.message}`);
      progress.message(`Хранилище «${repo.name}» не прочитано: ${err.message}`, 'warn');
      repoStatus.push({ name: repo.name, dir: repo.dir, ok: false, reason: err.message });
    }
  }

  if (!mainDir) {
    throw new Error(`Ни одно хранилище прочитать не удалось. ${warnings[warnings.length - 1] || ''}`);
  }

  // Правки помещений строятся всегда: версия достаётся из файлов хранилища
  // за миллисекунды, и выбирать тут не из чего.
  const diffStats = await buildPlacementDiffs({
    progress,
    commits,
    versionDir: async (repoName, version, objects) => {
      const store = stores.get(repoName);
      if (!store) return null;
      const done = await store.materialize({
        version,
        outDir: path.join(workRoot, `store-${safeFileName(repoName)}-v${version}`),
        objects,
      });
      return done.dir;
    },
  });

  if (unknownClasses.size) {
    warnings.push(`Вид некоторых объектов хранилища программе неизвестен `
      + `(${[...unknownClasses].join(', ')}) — их код в проверку не попал. `
      + 'Сообщите об этом: таблица видов пополняется только проверенными значениями.');
  }

  progress.done('export', `помещений за период: ${commits.length}`);

  const parsedData = await parseAll({
    dir: mainDir,
    extensionDirs,
    progress,
    fallbackConfiguration: { version: lastConfigVersion(commits) },
  });
  progress.skip('vendor', 'не требуется: разбираются помещения за период');

  return {
    ...parsedData,
    ...repositoryChangeSet(parsedData, commits),
    repositories: repoStatus,
    period,
    commits,
    codeSource: 'repository-files',
    placementDiffs: {
      mode: 'always', skipped: '', limited: Boolean(diffStats.limited), dumps: diffStats.dumps,
    },
    missingObjects: [],
  };
}

async function fromRepository({ input, platform, workRoot, progress, warnings }) {
  const sources = repositorySources(input);
  // Только адреса — значит и говорить надо про адреса; хоть один каталог —
  // работа начинается с его обхода, и это тоже надо сказать честно.
  const byAddress = sources.length > 0 && sources.every((s) => s.byAddress);
  const anyAddress = sources.some((s) => s.byAddress);
  startOrThrow(progress, 'source', byAddress
    ? 'Проверка сетевых адресов хранилищ'
    : 'Поиск хранилищ конфигурации');

  // Каталог программа обходит сама и находит в нём все хранилища; сетевые
  // адреса перечислить нечем — сервер хранилищ списка не отдаёт, — поэтому
  // там разбирается ровно то, что указал пользователь. Адреса разбираются
  // все разом: имена хранилищ для отчёта уточняются при совпадении, а для
  // этого их нужно видеть вместе.
  const addresses = sources.filter((s) => s.byAddress).map((s) => s.value);
  const repositories = addresses.length ? parseRepositoryAddresses(addresses.join('\n')) : [];
  for (const source of sources) {
    if (source.byAddress) continue;
    const found = await findRepositories(source.value);
    // Один и тот же каталог легко указать дважды — сам и вместе с родителем.
    for (const repo of found) {
      if (!repositories.some((known) => known.dir === repo.dir)) repositories.push(repo);
    }
  }

  if (!repositories.length) {
    const dirs = sources.filter((s) => !s.byAddress).map((s) => s.value);
    throw new Error(byAddress
      ? 'Не указан ни один сетевой адрес хранилища. Адрес выглядит так: '
        + 'tcp://сервер/хранилище; несколько адресов пишутся по одному в строке.'
      : `Хранилищ конфигурации 1С не найдено: ${dirs.join(', ') || 'хранилище не указано'}. `
        + 'Каталог хранилища опознаётся по файлу cfgrepo.conf; укажите сам каталог '
        + 'хранилища, каталог, где их несколько, или сетевой адрес вида '
        + 'tcp://сервер/хранилище.');
  }
  // Чьё это хранилище с точки зрения служебной базы — до первого обращения
  // к платформе: чужой адрес должен остановить прогон сразу, а не через минуту
  // работы, и распознанное расширение избавляет от лишней неудачной попытки.
  await bindRepositories({ input, repositories, progress, warnings });

  progress.done('source', `хранилищ: ${repositories.length} (${repositories.map((r) => r.name).join(', ')})`);

  startOrThrow(progress, 'export', 'Чтение истории и выгрузка конфигурации из хранилища');
  // Командам хранилища нужна база-контекст, но привязывать её к хранилищу
  // не требуется — проверено. Поэтому создаём пустую временную.
  // Базу проверяем сразу: ошибиться в строке соединения легко, а узнать
  // об этом через минуту работы обидно.
  if (input.serviceBase) await validateConnection(parseConnection(input.serviceBase));

  // Указана служебная база — в неё не пишется ничего, ни при каких условиях
  // (13.08.2026, прямое требование пользователя: у разработчика на сервере
  // заказчика есть только его рабочая база). Флага, снимающего этот запрет,
  // нет и не должно быть. Своей временной базе запрещать нечего — она наша.
  const readOnly = Boolean(input.serviceBase);

  // База, из которой конфигуратор говорит с хранилищем. Своя временная —
  // либо служебная, указанная пользователем: на терминальном сервере без
  // лицензий на файловые базы своя не заводится вовсе.
  const contextBase = await createContextInfobase({
    platform, workDir: workRoot,
    serviceBase: input.serviceBase,
    user: input.serviceBaseUser,
    password: input.serviceBasePassword,
  });
  if (contextBase.service) {
    progress.update('export', `работаем через служебную базу ${input.serviceBase}`);
  }

  // Куда разворачивать выгрузку хранилища. Служебная база в этом НЕ участвует
  // никогда: своя временная база, созданная `ibcmd`, лицензии не требует
  // и принадлежит нам — писать в неё можно сколько угодно. Отсюда правило:
  // есть ibcmd — код для проверки берётся из САМОГО хранилища; нет (клиентская
  // установка платформы, где ibcmd не поставляется) — остаётся прежний путь,
  // выгрузка служебной базы.
  const expandBase = readOnly
    ? await ownExpandBase({ platform, workRoot, progress, warnings })
    : contextBase;

  const period = { from: input.periodFrom || '', to: input.periodTo || '' };
  const commits = [];
  let mainDir = null;
  let extensionDirs = [];
  // Статус каждого хранилища — отдельно от warnings (тех же текстов, но
  // строкой для всего прогона): отчёту нужно показать таблицу помещений
  // при каждом хранилище персонально, включая те, что не прочитались.
  const repoStatus = [];
  // Объекты, которых в служебной базе не нашлось: их код проверить нечем,
  // и отчёт обязан назвать их поимённо, а не молчать.
  const missingObjects = [];

  for (const repo of repositories) {
    progress.update('export', `хранилище «${repo.name}»: история`);
    // Хранилище опознано как расширение служебной базы — идём сразу через
    // расширение этой базы, без заведомо неудачной попытки основной
    // конфигурацией. Профиль конфигуратора отстаёт от базы (расширение могли
    // переименовать), поэтому имён пробуется столько, сколько есть.
    let history = null;
    for (const extension of repo.extensionCandidates?.length ? repo.extensionCandidates : ['']) {
      history = await repositoryHistory({
        platform, contextBase, dir: repo.dir, workDir: workRoot,
        user: input.repositoryUser, password: input.repositoryPassword,
        extension, period,
      });
      if (history.ok) {
        repo.extension = extension;
        break;
      }
      if (!isMissingExtension(history.reason)) break;
    }

    // Хранилище расширений отвечает «Соединение основной конфигурации
    // с хранилищем расширений конфигураций невозможно»: ему нужно расширение
    // базы-контекста, а не сама база. Заводим пустое и повторяем — имя
    // расширения в базе с именем расширения в хранилище платформа не сверяет
    // (проверено), поэтому одного хватает на все хранилища расширений.
    if (!history.ok && isExtensionRepositoryRefusal(history.reason) && readOnly) {
      // Прочитать хранилище расширений можно только через расширение той базы,
      // из которой работает конфигуратор. ГОТОВОЕ расширение служебной базы для
      // этого годится (это чтение) — но лишь когда известно, что оно там есть:
      // такие хранилища распознаёт `bindRepositories` по привязке базы. Сюда
      // мы попадаем, когда распознать не вышло, а заводить расширение самим
      // нельзя: создание расширения — запись в служебную базу.
      history = {
        ...history,
        reason: repo.extensionCandidates?.length
          ? 'это хранилище РАСШИРЕНИЙ, и расширения служебной базы для него не подошли '
            + `(пробовали: ${repo.extensionCandidates.join(', ')}). Завести своё программа `
            + 'не может: в служебную базу не пишется ничего.'
          : 'это хранилище РАСШИРЕНИЙ. Чтобы его прочитать, конфигуратору нужно расширение '
            + 'в базе, через которую он работает. Готовое расширение служебной базы подошло бы, '
            + 'но эта база к данному хранилищу не подключена — а заводить своё нельзя: '
            + 'в служебную базу программа не пишет ничего. Укажите базу, через которую вы '
            + 'работаете с этим хранилищем, либо проверьте его на машине с лицензией '
            + 'на файловые базы: там служебная база не нужна вовсе.',
      };
    } else if (!history.ok && isExtensionRepositoryRefusal(history.reason)) {
      progress.update('export', `хранилище «${repo.name}»: это хранилище расширений`);
      const context = await ensureContextExtension({
        platform, contextBase, workDir: workRoot,
      });
      if (context.ok) {
        repo.extension = context.name;
        history = await repositoryHistory({
          platform, contextBase, dir: repo.dir, workDir: workRoot,
          user: input.repositoryUser, password: input.repositoryPassword,
          extension: repo.extension, period,
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

    // Выгрузка `.cf` нужна ровно затем, чтобы развернуть её в XML. Разворачивать
    // нечем (`expandBase === null`, клиентская установка без ibcmd) — значит,
    // и выгружать незачем: раньше программа честно скачивала полную
    // конфигурацию хранилища и тут же её выбрасывала, а на ERP это минуты
    // впустую в самом начале прогона.
    const dumped = expandBase
      ? await (async () => {
        progress.update('export', `хранилище «${repo.name}»: выгрузка конфигурации`);
        return repositoryDumpCfg({
          platform, contextBase, dir: repo.dir, workDir: workRoot,
          user: input.repositoryUser, password: input.repositoryPassword,
          extension: repo.extension || '',
        });
      })()
      : { ok: true, file: null };
    if (!dumped.ok) {
      warnings.push(`Хранилище «${repo.name}»: код не получен — ${dumped.reason}`);
      repoStatus.push({ name: repo.name, dir: repo.dir, ok: false, reason: dumped.reason });
      continue;
    }

    // Разворачивать выгрузку есть куда только тогда, когда есть СВОЯ база
    // (`expandBase`). Нет её — код для разбора берётся выгрузкой служебной
    // базы ниже, а правки помещений строит сравнение двух файлов `.cf`
    // средствами платформы.
    const expanded = expandBase
      ? await expandRepositoryCf({
        repo, cfFile: dumped.file, platform, contextBase: expandBase, workRoot,
        onProgress: (text) => progress.update('export', `«${repo.name}»: ${text}`),
      })
      : { ok: true, dir: null };
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
      // Чем хранилище оказалось по привязке служебной базы: у сетевых адресов
      // это единственный способ понять, основной конфигурации оно или
      // расширения, — по самому адресу не видно.
      role: repo.role || null,
      boundExtension: repo.boundExtension || null,
    });
    if (!expanded.dir) continue;
    if (isMain) mainDir = expanded.dir;
    else extensionDirs.push({ name: repo.name, dir: expanded.dir });
  }

  // Развернуть хранилище было нечем — исходники берутся выгрузкой самой
  // служебной базы. Операция читающая: платформа выгружает конфигурацию
  // в XML, ничего в базе не меняя. Код в базе тот же, что в хранилище, пока
  // разработчик обновлён из хранилища; расхождение возможно и оговаривается
  // в отчёте.
  // «Нечем» — это когда из хранилищ не развернулось НИЧЕГО: ни конфигурация,
  // ни расширения. Каталог с одними хранилищами расширений — законный случай,
  // и подменять его выгрузкой базы нельзя: код из хранилища уже получен.
  // Ни одно хранилище не прочиталось — отчёта быть не может. Раньше это
  // ловилось проверкой `!mainDir` ниже, но выборочная выгрузка даёт каталог
  // всегда (пусть и пустой), и без этой проверки прогон завершался бы пустым
  // отчётом, как будто помещений просто не было.
  if (!repoStatus.some((r) => r.ok)) {
    throw new Error(
      'Ни одно хранилище прочитать не удалось. '
      + (warnings[warnings.length - 1] || 'причина не определена'),
    );
  }

  const nothingExpanded = !mainDir && !extensionDirs.length;
  const codeSource = nothingExpanded ? 'service-base' : 'repository';
  // Хранилища расширений — чтобы не просить их объекты у основной конфигурации:
  // объекта расширения в ней нет, и одно такое имя срывает всю выгрузку.
  const extensionRepos = new Set(repositories.filter((r) => r.extension).map((r) => r.name));
  if (readOnly && nothingExpanded) {
    const ctx = {
      platform,
      conn: parseConnection(contextBase.base),
      workDir: workRoot,
      user: contextBase.user,
      password: contextBase.password,
      onProgress: (text) => {
        const line = String(text).trim().split('\n').pop();
        if (line) progress.update('export', line.slice(0, 160));
      },
    };

    // ВЫБОРОЧНАЯ выгрузка: только объекты, помещённые за период. Раньше здесь
    // выгружалась вся конфигурация целиком и все расширения — на ERP это
    // десятки минут ради двух-трёх модулей, притом что анализируются всё равно
    // одни помещения (18.08.2026, замечание пользователя).
    const mainCommits = commits.filter((c) => !extensionRepos.has(c.repository));
    const wanted = placedObjects(mainCommits);
    progress.update('export', `выгрузка объектов базы: ${wanted.length} (в базу ничего не пишется)`);
    const exported = await exportObjectsToXml({
      ...ctx, outDir: path.join(workRoot, 'config'), objects: wanted, name: 'config',
    });
    mainDir = exported.dir;
    missingObjects.push(...exported.missing);

    // Расширения — только те, чьи хранилища разбирались, и только их объекты.
    for (const repo of repositories) {
      if (!repo.extension) continue;
      const own = placedObjects(commits.filter((c) => c.repository === repo.name));
      if (!own.length) continue;
      progress.update('export', `выгрузка объектов расширения «${repo.extension}»: ${own.length}`);
      try {
        const ext = await exportObjectsToXml({
          ...ctx,
          outDir: path.join(workRoot, 'extensions', safeFileName(repo.extension)),
          objects: own,
          extension: repo.extension,
          name: `ext-${safeFileName(repo.extension)}`,
        });
        if (ext.exported) extensionDirs.push({ name: repo.name, dir: ext.dir });
        missingObjects.push(...ext.missing);
      } catch (err) {
        rethrowIfCancelled(err);
        warnings.push(`Расширение «${repo.extension}» не выгружено: ${err.message} — `
          + 'его код в проверку не попал.');
      }
    }
  }

  if (missingObjects.length) {
    warnings.push(`Код этих объектов не проверен — в служебной базе их нет: `
      + `${[...new Set(missingObjects)].join(', ')}. Так бывает, если объект поместили `
      + 'и потом удалили либо база не обновлена из хранилища.');
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
      + (anyAddress
        ? 'Проверьте адрес хранилища, доступность сервера хранилищ, имя пользователя и пароль: '
        : 'Проверьте имя пользователя и пароль хранилища: ')
      + (warnings[warnings.length - 1] || 'причина не определена'),
    );
  }

  // Правки помещений: код из хранилища есть — считаем их по выгрузкам версий,
  // это тот же путь, что и без служебной базы. Кода из хранилища нет — остаётся
  // сравнение двух файлов `.cf` средствами платформы с привязкой к тексту базы.
  const diffs = placementDiffsWanted(input, codeSource);
  const diffStats = !diffs.wanted
    ? { limited: false, dumps: 0, skipped: diffs.reason }
    : codeSource === 'repository'
      ? await buildPlacementDiffs({
        progress,
        commits,
        versionDir: platformVersionDir({
          platform, contextBase, expandBase, workRoot, repositories,
          user: input.repositoryUser, password: input.repositoryPassword,
        }),
      })
      : await buildPlacementDiffsByCompare({
        platform, contextBase, workRoot, progress, commits, repositories, mainDir, extensionDirs,
        user: input.repositoryUser, password: input.repositoryPassword,
      });
  if (diffStats.skipped) warnings.push(diffStats.skipped);
  if (diffStats.limited) {
    warnings.push(
      `Правки показаны не по всем помещениям периода: на выгрузку версий хранилища `
      + `отведено ${Math.round(PLACEMENT_BUDGET_MS / 60000)} мин, и за это время удалось `
      + `получить ${diffStats.dumps} версий. Сузьте период, чтобы увидеть правки остальных `
      + 'помещений.',
    );
  }

  progress.done('export', `помещений за период: ${commits.length}`);

  // При выборочной выгрузке `Configuration.xml` не создаётся, и свойства
  // конфигурации взять неоткуда — кроме самой истории хранилища: версию
  // конфигурации платформа записывает в каждое помещение.
  const parsedData = await parseAll({
    dir: mainDir,
    extensionDirs,
    progress,
    fallbackConfiguration: { version: lastConfigVersion(commits) },
  });

  progress.skip('vendor', 'не требуется: разбираются помещения за период');

  return {
    ...parsedData,
    ...repositoryChangeSet(parsedData, commits),
    repositories: repoStatus,
    period,
    commits,
    codeSource,
    // Что стало с кодом правок и чего в отчёте нет: отчёт обязан сказать это
    // сам, а не оставить читателя гадать, почему у помещений пусто.
    placementDiffs: {
      mode: input.placementDiffs || 'auto',
      skipped: diffStats.skipped || '',
      limited: Boolean(diffStats.limited),
      dumps: diffStats.dumps || 0,
    },
    missingObjects: [...new Set(missingObjects)],
  };
}

/**
 * Своя пустая база — рабочее место для разворачивания выгрузок хранилища.
 *
 * Нужна там, где указана служебная база: в неё писать нельзя ни при каких
 * условиях, а развернуть `.cf` и `.cfe` в XML можно только загрузкой в базу.
 * Своя временная базе пользователя не мешает и лицензии не требует —
 * при одном условии: её создаёт и наполняет `ibcmd`, а не конфигуратор.
 * Конфигуратору лицензия нужна всегда, и на терминальном сервере без местных
 * лицензий он на файловой базе не работает вовсе — с этого вся служебная база
 * и началась.
 *
 * Нет ibcmd (клиентская установка платформы — там его не поставляют) — базы
 * не будет, и код для проверки придётся читать выгрузкой служебной базы.
 * Это честно сказано в отчёте, а не подменено молчанием.
 */
async function ownExpandBase({ platform, workRoot, progress, warnings }) {
  if (!platform.ibcmd) {
    warnings.push(
      `В платформе ${platform.version} нет ibcmd (он входит в серверную часть, а не в клиентскую), `
      + 'поэтому развернуть выгрузку хранилища на этой машине нечем: писать в служебную базу '
      + 'запрещено, а конфигуратору на своей временной базе нужна лицензия. Код для проверки '
      + 'взят из служебной базы — она должна быть обновлена из хранилища.',
    );
    return null;
  }
  try {
    const base = await createContextInfobase({ platform, workDir: workRoot, name: 'repo-expand' });
    progress.update('export', 'код будет взят из самого хранилища (своя временная база, ibcmd)');
    return base;
  } catch (err) {
    rethrowIfCancelled(err);
    warnings.push(`Своя временная база под разбор хранилища не создалась: ${err.message}. `
      + 'Код для проверки взят из служебной базы.');
    return null;
  }
}

/** Сколько дополнительных выгрузок хранилища допускается ради диффов правок. */
const MAX_PLACEMENT_DUMPS = Number(process.env.ONEC_AUDIT_MAX_PLACEMENT_DUMPS || 200);

/**
 * Сколько времени отводится на выгрузки версий ради правок.
 *
 * Прежний предел считался в штуках (40 выгрузок) и был выбран вслепую: на
 * маленькой конфигурации он обрезал отчёт зря, на ERP сорок выгрузок и так
 * не уложились бы в разумное время. Пользователь назвал ориентир прямо
 * (17.08.2026): недельный отчёт по ERP — 20–30 минут. Столько и отводим,
 * а что не успели — отчёт говорит прямо, как и раньше.
 */
const PLACEMENT_BUDGET_MS = Number(process.env.ONEC_AUDIT_PLACEMENT_BUDGET_MS || 25 * 60 * 1000);

/**
 * Кончился ли отпущенный на выгрузки запас — по времени или по числу.
 *
 * Правило одно на оба пути построения правок, и живёт оно здесь именно поэтому:
 * пока проверка стояла внутри каждого из них, в запасном пути (сравнение двух
 * `.cf` без разворачивания) остался только счёт в штуках — 200 выгрузок, то
 * есть сотня версий подряд. На ERP это часы вместо обещанных 25 минут, причём
 * молча. Найдено 18.08.2026 разбором кода, тестов на тот путь не было.
 */
export function outOfPlacementBudget({ dumps, startedAt, now = Date.now() }) {
  return dumps >= MAX_PLACEMENT_DUMPS || now - startedAt > PLACEMENT_BUDGET_MS;
}

/**
 * Какие объекты нужны на каждой версии хранилища.
 *
 * Ради двух изменённых модулей помещения незачем разворачивать конфигурацию
 * целиком: платформа умеет выгружать выбранные объекты (`config export objects`
 * у ibcmd, `-listFile` у конфигуратора). Список собирается заранее, потому что
 * одна и та же версия нужна двум соседним помещениям: версии V — как «после»
 * своего помещения, и как «до» для следующего.
 *
 * Тонкость: на версию V−1 просить объекты из `added` НЕЛЬЗЯ — их там ещё нет,
 * а неизвестное имя в списке платформа считает ошибкой (код возврата 1
 * и пустая выгрузка). Поэтому «до» просится только для изменённых.
 */
/**
 * Строить ли код правок по каждому помещению.
 *
 * Правки стоят одной полной выгрузки `.cf` на версию хранилища, и дешевле
 * не выйдет: сравнивать версии хранилища напрямую платформа не умеет
 * (проверено 18.08.2026 — `/CompareCfg` значение `ConfigurationRepository`
 * не принимает). Когда код разворачивается своей временной базой, на версию
 * выгружаются только объекты помещения, и это секунды. Когда своей базы нет
 * (служебная база без ibcmd), выгружается ВСЯ конфигурация версии — на ERP
 * это десятки минут на одно помещение, и недельный отчёт так не собрать.
 *
 * Отсюда три положения переключателя: `auto` (по умолчанию) строит правки
 * везде, кроме дорогого пути; `on` — всегда; `off` — никогда.
 */
export function placementDiffsWanted(input, codeSource) {
  const mode = input?.placementDiffs || 'auto';
  if (mode === 'off') {
    return { wanted: false, reason: 'Код правок по помещениям не строился: так выбрано в форме.' };
  }
  if (mode === 'auto' && codeSource === 'service-base') {
    return {
      wanted: false,
      reason: 'Код правок по помещениям не строился: программа работает через служебную базу, '
        + 'а в этом режиме на каждую версию хранилища платформа выгружает конфигурацию целиком '
        + '(на больших конфигурациях — десятки минут на одно помещение). Нужны фрагменты кода — '
        + 'выберите в форме «Всегда» и сузьте период.',
    };
  }
  return { wanted: true };
}

/**
 * Объекты, помещённые за период, — списком для ВЫБОРОЧНОЙ выгрузки базы.
 *
 * Три правила, каждое снято с живой платформы 18.08.2026 и обязательное:
 *
 *  1. только **верхний уровень**: `Документ.Документ4.Форма.ФормаДокумента`
 *     конфигуратор отвергает («Объект метаданных … не существует
 *     в конфигурации»), и выгрузка не состоится вовсе. Формы и команды
 *     выгружаются вместе со своим объектом;
 *  2. только **известные виды**: незнакомый вид означает, что имя мы толкуем
 *     неверно, а неверное имя рвёт всю выгрузку;
 *  3. без **удалённых**: объект, помещённый и затем удалённый, в базе
 *     отсутствует, и просить его — заведомо сорвать выгрузку.
 */
export function placedObjects(commits) {
  const removed = new Set();
  for (const commit of commits || []) {
    for (const name of commit.removed || []) removed.add(topLevelName(name));
  }

  const wanted = new Set();
  for (const commit of commits || []) {
    for (const name of [...(commit.added || []), ...(commit.changed || [])]) {
      const top = topLevelName(name);
      if (!top || removed.has(top)) continue;
      // Вид объекта должен быть нам знаком: `keyFromRussian` возвращает null
      // на всём, чего мы не понимаем, включая саму «Конфигурацию».
      if (!keyFromRussian(top)) continue;
      wanted.add(top);
    }
  }
  return [...wanted];
}

/** «Документ.Док.Форма.ФормаДокумента» → «Документ.Док». */
function topLevelName(name) {
  const parts = String(name || '').split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : '';
}

export function neededObjects(commits) {
  const needed = new Map();
  const add = (repo, version, names) => {
    if (version < 1 || !names.length) return;
    const key = `${repo} ${version}`;
    if (!needed.has(key)) needed.set(key, new Set());
    const set = needed.get(key);
    for (const name of names) set.add(name);
  };
  for (const c of commits) {
    const added = c.added || [];
    const changed = c.changed || [];
    add(c.repository, c.version, [...added, ...changed]);
    add(c.repository, c.version - 1, changed);
  }
  return needed;
}

/**
 * Разворачивает выгрузку хранилища в XML — тем способом, который годится
 * для этого хранилища.
 *
 * Конфигурация приходит файлом `.cf` и разворачивается своей временной базой
 * (ibcmd умеет создать базу сразу из файла). Расширение приходит `.cfe`,
 * и так его не развернуть: расширение живёт внутри базы под именем. Поэтому
 * оно загружается в расширение-заглушку базы `contextBase` и выгружается
 * оттуда.
 *
 * `contextBase` здесь — всегда НАША база, а не служебная база пользователя:
 * решение об этом принимает `ownExpandBase`, и в служебную базу не пишется
 * ничего ни при каких условиях.
 */
async function expandRepositoryCf({
  repo, cfFile, platform, contextBase, workRoot, onProgress, objects = null,
}) {
  const name = `repo-${safeFileName(repo.name)}${repo.suffix || ''}`;
  if (repo.extension) {
    // У расширения выборочная выгрузка не задействована: оно и так небольшое,
    // а путь к нему идёт через заглушку базы-контекста, а не через ibcmd.
    return expandExtensionCf({
      platform, contextBase, cfFile, workDir: workRoot, name, extension: repo.extension,
    });
  }
  return exportCfToXml({ cfFile, platform, workDir: workRoot, name, onProgress, objects });
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
/**
 * Каталог с кодом версии — средствами платформы.
 *
 * Версия выгружается из хранилища файлом `.cf` и разворачивается в XML,
 * причём только запрошенными объектами: ради двух модулей помещения
 * конфигурацию целиком разворачивать незачем.
 */
function platformVersionDir({
  platform, contextBase, expandBase, workRoot, repositories, user, password,
}) {
  const repoByName = new Map(repositories.map((r) => [r.name, r]));
  return async (repoName, version, objects) => {
    const repo = repoByName.get(repoName);
    if (!repo) return null;
    const dumped = await repositoryDumpCfg({
      platform, contextBase, dir: repo.dir, workDir: workRoot, user, password, version,
      extension: repo.extension || '',
    });
    if (!dumped.ok) return null;
    // К хранилищу ходим через `contextBase` (там может быть служебная база —
    // только чтение), а разворачиваем в `expandBase` — своей.
    const expanded = await expandRepositoryCf({
      repo: { ...repo, suffix: `-v${version}` },
      cfFile: dumped.file, platform, contextBase: expandBase || contextBase, workRoot,
      objects,
    });
    return expanded.ok ? expanded.dir : null;
  };
}

async function buildPlacementDiffs({ progress, commits, versionDir }) {
  const withCode = commits.filter((c) => (c.added.length || c.changed.length));
  if (!withCode.length) return { limited: false, dumps: 0 };

  const cache = new Map();
  const needed = neededObjects(withCode);
  const startedAt = Date.now();
  let dumps = 0;
  let limited = false;

  const versionModules = async (repoName, version) => {
    if (version < 1) return null;
    const key = `${repoName} ${version}`;
    if (cache.has(key)) return cache.get(key);
    // Бюджет времени вместо жёсткого числа выгрузок: дорога сама выгрузка
    // версии, а сколько она длится, зависит от размера конфигурации — на ERP
    // это минуты, на маленькой базе секунды. Считать в минутах честнее,
    // чем в штуках. Прямому чтению каталога бюджет не мешает: там версия
    // достаётся за миллисекунды и до предела дело не доходит.
    if (outOfPlacementBudget({ dumps, startedAt })) {
      limited = true;
      cache.set(key, null);
      return null;
    }
    dumps += 1;
    const objects = [...(needed.get(key) || [])];
    progress.update('export', `хранилище «${repoName}»: версия ${version} — объектов ${objects.length}`);
    let entry = null;
    try {
      const dir = await versionDir(repoName, version, objects);
      if (dir) {
        const modules = await collectModules(dir);
        const byObject = new Map();
        for (const m of modules) {
          if (!m.ownerKind || !m.ownerName) continue;
          const k = `${m.ownerKind}.${m.ownerName}`;
          if (!byObject.has(k)) byObject.set(k, []);
          byObject.get(k).push(m);
        }
        entry = { byObject };
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
 * Правки помещений БЕЗ ЗАПИСИ В БАЗУ.
 *
 * Прежний путь требовал развернуть версии N и N−1 в XML, а развернуть `.cf`
 * можно только загрузкой в базу. У разработчика на сервере заказчика есть
 * лишь его рабочая база, менять которую нельзя, — поэтому здесь всё иначе:
 *
 *  1. версии N и N−1 выгружаются из хранилища файлами `.cf` (чтение);
 *  2. их сравнивает сама платформа — `/CompareCfg` между двумя ФАЙЛАМИ
 *     (`onec/compareFiles.js`); база при этом только контекст запуска
 *     и не меняется — проверено сверкой её конфигурации до и после;
 *  3. подробный отчёт печатает и номера строк, и сам добавленный код;
 *  4. участки привязываются к тексту модуля ИЗ БАЗЫ (`reportedRegions`) —
 *     по совпадению строк, а не по номерам: в базе может стоять другая
 *     версия. Не нашлось — правка не показывается, и это честнее выдумки.
 *
 * Отсюда же ограничение, которое отчёт оговаривает: код берётся из базы.
 * Если разработчик не обновлён из хранилища, свежих чужих помещений в его
 * базе нет — их правки показать неоткуда.
 */
async function buildPlacementDiffsByCompare({
  platform, contextBase, workRoot, progress, commits, repositories,
  mainDir, extensionDirs, user, password,
}) {
  const withCode = commits.filter((c) => (c.added.length || c.changed.length));
  if (!withCode.length) return { limited: false, dumps: 0 };

  // Модули базы — единый источник текста для всех помещений.
  const byObject = new Map();
  for (const dir of [mainDir, ...(extensionDirs || []).map((e) => e.dir)]) {
    if (!dir) continue;
    for (const m of await collectModules(dir)) {
      if (!m.ownerKind || !m.ownerName) continue;
      const k = `${m.ownerKind}.${m.ownerName}`;
      if (!byObject.has(k)) byObject.set(k, []);
      byObject.get(k).push(m);
    }
  }

  const repoByName = new Map(repositories.map((r) => [r.name, r]));
  const cache = new Map();
  const startedAt = Date.now();
  let dumps = 0;
  let limited = false;

  /**
   * Файл `.cf` версии — с кэшем.
   *
   * Каждая версия нужна дважды: как «после» своего помещения и как «до»
   * следующего. Без кэша она и выгружалась дважды, а выгрузка версии — самая
   * дорогая операция всего прогона (на ERP это минуты). Для k подряд идущих
   * версий выходит k+1 выгрузка вместо 2k.
   */
  const cfCache = new Map();
  const cfOfVersion = async (repo, version) => {
    const key = `${repo.name} ${version}`;
    if (cfCache.has(key)) return cfCache.get(key);
    dumps += 1;
    progress.update('export', `хранилище «${repo.name}»: выгрузка версии ${version}`);
    const dumped = await repositoryDumpCfg({
      platform, contextBase, dir: repo.dir, workDir: workRoot, user, password, version,
      extension: repo.extension || '',
    });
    if (!dumped.ok) throw new Error(dumped.reason);
    cfCache.set(key, dumped.file);
    return dumped.file;
  };

  /** Отчёт сравнения версии N с N−1. Кэш — соседние помещения делят версии. */
  const compareVersions = async (repoName, version) => {
    const key = `${repoName} ${version}`;
    if (cache.has(key)) return cache.get(key);
    const repo = repoByName.get(repoName);
    if (!repo || version < 2) return null;
    // Тот же бюджет, что у основного пути: здесь на версию приходится ДВЕ
    // выгрузки, и без ограничения по времени сотня помещений растянула бы
    // проверку на часы.
    if (outOfPlacementBudget({ dumps, startedAt })) {
      limited = true;
      cache.set(key, null);
      return null;
    }

    let sets = null;
    try {
      progress.update('export', `хранилище «${repoName}»: сравнение версий ${version - 1} и ${version}`);
      const files = [];
      for (const v of [version, version - 1]) {
        files.push(await cfOfVersion(repo, v));
      }
      const compared = await compareCfFiles({
        platform, context: contextBase, newer: files[0], older: files[1],
        workDir: workRoot, name: `${safeFileName(repoName)}-v${version}`,
      });
      if (!compared.ok) throw new Error(compared.reason);
      sets = compared.sets;
    } catch (err) {
      rethrowIfCancelled(err);
      log.warn(`Хранилище «${repoName}», версия ${version}: сравнение не вышло (${err.message})`);
    }
    cache.set(key, sets);
    return sets;
  };

  for (const commit of withCode) {
    throwIfCancelled();
    const sets = await compareVersions(commit.repository, commit.version);
    if (!sets) continue;

    const diffs = [];
    for (const russian of [...new Set([...commit.added, ...commit.changed])]) {
      const key = keyFromRussian(russian);
      if (!key) continue;

      for (const module of narrowByRussianSuffix(russian, byObject.get(key) || [])) {
        throwIfCancelled();
        const source = await readTextSafe(module.file);
        if (source == null) continue;

        // Привязка блоков отчёта к тексту модуля из базы — по совпадению
        // строк. Тот же код, что привязывает правки к типовым модулям
        // в обследовании: задача одна и та же.
        const found = reportedRegions(module, sets, source);
        if (!found?.lines?.length) continue;

        const routines = routinesOf(source);
        // Процедур прежней версии у нас нет — версия N−1 в XML не
        // разворачивалась. Но значок состояния по ним и считается: процедура
        // «добавлена», если её объявление среди внесённых строк, и «изменена»
        // иначе. Ровно это и означает список «прежних» процедур.
        const addedSet = new Set(found.lines);
        const previousRoutines = routines.filter((r) => !addedSet.has(r.line));

        const { fragments, totalBlocks } = placementFragments({
          source, addedLines: found.lines, routines, previousRoutines,
        });
        if (!fragments.length) continue;

        diffs.push({
          object: russian,
          moduleTitle: module.title,
          moduleType: module.moduleType,
          moduleTypeRu: module.moduleTypeRu,
          formName: module.formName || null,
          isNew: sets.added.has(key),
          addedLines: found.lines.length,
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

/** Версия конфигурации из последнего помещения — для выборочной выгрузки. */
function lastConfigVersion(commits) {
  const withVersion = (commits || []).filter((c) => c.configVersion);
  if (!withVersion.length) return '';
  return withVersion.sort((a, b) => Number(a.version) - Number(b.version)).slice(-1)[0].configVersion;
}

async function parseAll({ dir, extensionDirs, progress, fallbackConfiguration }) {
  startOrThrow(progress, 'parse', 'Чтение состава объектов и модулей');
  const parsed = await parseConfigurationDump(dir, {
    fallbackConfiguration,
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
 * Автор замечания в этом режиме — тот, кто поместил объект: всё, что вошло
 * в помещение, принадлежит его автору. Пометки в коде («// ++ Иванов») здесь
 * не используются вовсе, поэтому автор из них ЗАТИРАЕТСЯ: они пишутся кем
 * угодно и когда угодно, а запись хранилища одна и точна. Не нашлось объекта
 * в помещениях периода — автор пуст, и это честнее фамилии из комментария.
 */
function applyRepositoryAuthors(findings, byObject) {
  for (const finding of findings) {
    const key = objectKeyOf(finding);
    const entry = key ? byObject.get(key) : null;
    finding.author = entry?.author || '';
    finding.authorSource = 'хранилище конфигурации';
    finding.committedAt = entry?.at || '';
    finding.commitComment = entry?.comment || '';
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
  // Пароль служебной базы вычищается наравне с остальными: прогон сохраняется
  // в data/quality/*.json, и хранить там пароль от чужой базы нельзя.
  const {
    password, repositoryPassword, serviceBasePassword, ...rest
  } = input || {};
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasRepositoryPassword: Boolean(repositoryPassword),
    hasServiceBasePassword: Boolean(serviceBasePassword),
  };
}

/** Существует ли путь — для проверок входных данных в маршруте. */
export { pathExists };

/** Экспортируется ради теста: привязка авторов — место, где уже ломалось. */
export { applyRepositoryAuthors };

/** Экспортируется ради теста: разбор процедур ломался молча, без ошибки. */
export { routinesOf };
