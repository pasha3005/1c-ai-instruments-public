/**
 * Движок статического анализа кода 1С.
 *
 * Модули обрабатываются по одному и не удерживаются в памяти: у крупных типовых
 * конфигураций суммарный объём кода измеряется сотнями мегабайт.
 *
 * Помимо правил, работающих в пределах одного модуля, движок собирает
 * межмодульную статистику: дубли кода, сводные метрики, распределение находок.
 */

import { tokenize } from './bsl/lexer.js';
import { analyzeStructure, findRoutineAtLine } from './bsl/structure.js';
import { extractQueries } from './bsl/query.js';
import { createRuleContext, SEVERITY, CATEGORY, SEVERITY_ORDER } from './rules/context.js';
import * as performanceRules from './rules/performance.js';
import * as architectureRules from './rules/architecture.js';
import * as securityRules from './rules/security.js';
import * as standardsRules from './rules/standards.js';
import { shouldAnalyzeModule, isAddedModule, dumpInfoKeyForModule } from './vendorConfig.js';
import { findAuthoredRegions, authoredLineCount } from './bsl/authorship.js';
import { diffModule, diffModuleAligned, attachVendorLines, keepOnlyRegions, toRegions } from './bsl/moduleDiff.js';
import {
  pickAuthor, soleAuthor, prefixAuthor, originOf, groupByAuthor,
  signChangedFindings, keepAuthoredFindings,
} from './attribution.js';
import path from 'node:path';
import { readText } from '../util/fsx.js';
import { codeFingerprint } from '../util/id.js';
import { LIMITS } from '../config.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('analyze:code');

const RULE_SETS = [performanceRules, architectureRules, securityRules, standardsRules];

/**
 * @param {import('../parse/modules.js').ModuleRef[]} modules
 * @param {object} configuration результат parseConfigurationDump + индекс объектов
 * @param {{onProgress?: (done: number, total: number, title: string) => void}} [options]
 */
export async function analyzeCode(modules, configuration, options = {}) {
  const { onProgress, changeSet, analyzeVendorCode = false, vendorDir = null } = options;

  // Флаг «Проверять качество кода в типовой конфигурации» отменяет фильтр по
  // изменениям: проверяется всё, включая типовой код вендора. По умолчанию
  // снят — цель аудита — оценить работу интегратора, а не качество поставки.
  const filtering = Boolean(changeSet) && !analyzeVendorCode;

  // При наличии конфигурации поставщика анализируем только изменённые и
  // добавленные модули: цель аудита — оценить доработки, а не типовой код вендора.
  const skipped = { total: 0, byModuleType: {} };
  const targets = filtering
    ? modules.filter((m) => {
      // Расширение — доработка целиком, сравнивать его с поставщиком не с чем:
      // его модули анализируются всегда, даже при сравнении с поставщиком.
      if (m.extensionName) return true;
      if (shouldAnalyzeModule(m, changeSet)) return true;
      skipped.total += 1;
      skipped.byModuleType[m.moduleType] = (skipped.byModuleType[m.moduleType] || 0) + 1;
      return false;
    })
    : modules;

  if (filtering) {
    log.info(`Анализ ограничен доработками: ${targets.length} модулей из ${modules.length} (пропущено типовых: ${skipped.total})`);
  } else if (changeSet) {
    log.info(`Проверяется вся конфигурация по требованию пользователя: ${targets.length} модулей`);
  }

  /**
   * Модули поставщика, в которые интегратор что-то вставил.
   *
   * Такой модуль изменён, но почти целиком остаётся типовым: правка — это
   * несколько строк среди тысяч. Проверять его целиком бессмысленно, поэтому
   * замечания оставляем только по участкам, помеченным комментариями
   * разработчика. Модули добавленные и модули расширений — целиком авторские,
   * они анализируются полностью.
   */
  const partialTargets = new Set(
    filtering
      ? targets.filter((m) => !m.extensionName && !isAddedModule(m, changeSet))
      : [],
  );
  const customPrefixes = configuration?.customPrefixes || [];
  const partial = {
    total: partialTargets.size,
    withMarks: 0,
    withoutMarks: 0,
    /** Их имена — чтобы в отчёте было видно, что именно осталось непроверенным. */
    withoutMarksModules: [],
    /**
     * Модули без собственной записи в карте версий: модуль приложения, модуль
     * сеанса, модуль внешнего соединения. Они попадают в проверку по умолчанию
     * («ключа нет — анализируем, чтобы не потерять находки»), но утверждать,
     * что они изменены, нельзя: ни ConfigDumpInfo, ни отчёт о сравнении о них
     * ничего не говорят. Поэтому в отчёте они названы отдельно и другими словами.
     */
    withoutKeyModules: [],
    authoredLines: 0,
    droppedFindings: 0,
    /** Модулей, разобранных построчным сравнением с поставщиком. */
    diffed: 0,
    /** Строк, добавленных относительно поставщика. */
    diffLines: 0,
    /** Модулей, разобранных по строкам из отчёта конфигуратора о сравнении. */
    fromReport: 0,
    /** Строк правок, взятых из отчёта конфигуратора. */
    fromReportLines: 0,
    /** Сравнение доступно вообще: исходники поставщика лежат на диске. */
    diffAvailable: Boolean(vendorDir),
    /** Отчёт конфигуратора принёс строки правок хотя бы по одному модулю. */
    reportLinesAvailable: Boolean(changeSet?.moduleLines?.size),
  };
  /** Собственные модули интегратора, у которых удалось установить автора. */
  const authoredModules = new Set();

  /**
   * Что именно отличается в каждом модуле — для дерева отличий в отчёте.
   *
   * Здесь и только здесь известно, ГДЕ в модуле правка: построчное сравнение
   * с поставщиком и разбор пометок разработчика выполняются один раз, ради
   * анализа кода. Отдать эти сведения отчёту дешевле, чем считать их заново.
   */
  const moduleChanges = [];
  let fragmentBudget = FRAGMENT_MODULES_LIMIT;

  /** @type {object[]} */
  const findings = [];
  const metrics = {
    modules: 0,
    modulesWithCode: 0,
    totalLines: 0,
    codeLines: 0,
    commentLines: 0,
    blankLines: 0,
    routines: 0,
    exportRoutines: 0,
    loops: 0,
    queries: 0,
    maxModule: { title: '', codeLines: 0 },
    maxRoutine: { name: '', lines: 0, module: '' },
    byModuleType: {},
  };

  /** Отпечаток тела процедуры → места, где он встречается. */
  const fingerprints = new Map();

  let done = 0;
  for (const module of targets) {
    done += 1;
    if (onProgress && (done % 50 === 0 || done === targets.length)) {
      onProgress(done, targets.length, module.title);
    }

    let source;
    try {
      source = await readText(module.file);
    } catch (err) {
      log.warn(`Не удалось прочитать модуль ${module.rel}: ${err.message}`);
      continue;
    }

    metrics.modules += 1;
    if (source.length > LIMITS.maxModuleChars) {
      log.warn(`Модуль ${module.rel} слишком велик (${source.length} символов), анализ пропущен`);
      // «Модуль слишком велик» — свойство самого модуля, а не вставки в нём.
      // Для типового модуля вендора это замечание не наше дело.
      if (!partialTargets.has(module)) {
        findings.push({ ...oversizedModuleFinding(module, source.length), origin: originOf(module, changeSet) });
      }
      continue;
    }
    if (!source.trim()) continue;
    metrics.modulesWithCode += 1;

    const { tokens, stats } = tokenize(source);
    const structure = analyzeStructure(tokens);
    const queries = extractQueries(tokens);

    accumulateMetrics(metrics, module, stats, structure, queries);
    // Отпечатки тел процедур берём только с авторского кода: типовые процедуры
    // вендора повторяются в типовых же модулях, и это не доработка интегратора.
    if (!partialTargets.has(module)) collectFingerprints(fingerprints, module, structure, source);

    // Пометки разработчика ищем в КАЖДОМ проверяемом модуле, а не только
    // в изменённых типовых. Это была прямая ошибка: «//++ инт_и_Иванов»
    // стоят в основном в собственных модулях интегратора и в расширениях,
    // а их на авторство вообще не смотрели — в итоге ни одно замечание
    // по доработкам не получало имени, все уходили под «автор не определён».
    const regions = findAuthoredRegions(source, { prefixes: customPrefixes });

    // В изменённом типовом модуле правила должны видеть ТОЛЬКО отличия
    // от поставщика: отличия от типового кода типовым кодом не являются,
    // и проверять надо ровно их.
    //
    // Точный способ — построчное сравнение с исходником поставщика. Работает,
    // когда конфигурация поставщика указана файлом .cf или каталогом выгрузки:
    // тогда её исходники лежат на диске. Сравнение прямо в базе даёт лишь
    // перечень различающихся объектов, без текстов.
    let diff = null;
    if (partialTargets.has(module) && vendorDir) {
      const vendorSource = await readVendorModule(vendorDir, module);
      if (vendorSource !== null) {
        diff = diffModule(vendorSource, source);
        // Тот же диф, но с текстом строк поставщика на месте каждого участка —
        // для двустороннего показа отличий в отчёте (слева поставщик, справа
        // клиент, как в конфигураторе). `diffModule` и `diffModuleAligned` идут
        // от одной трассы Майерса, поэтому границы участков совпадают.
        const aligned = diffModuleAligned(vendorSource, source);
        if (aligned.exact) attachVendorLines(diff.regions, aligned.hunks);
        partial.diffed += 1;
        partial.diffLines += diff.addedLines;
        recordModuleChange(moduleChanges, module, {
          method: 'diff',
          changedLines: diff.addedLines,
          exact: diff.exact,
          regions: diff.regions,
          fragments: fragmentBudget > 0 ? takeFragments(source, diff.regions, structure.routines) : [],
        }, structure.routines);
        if (diff.regions.length && fragmentBudget > 0) fragmentBudget -= 1;
        if (!diff.regions.length) continue;
      }
    }

    // Исходников поставщика нет, но сравнение с ним выполнялось: подробный
    // отчёт конфигуратора уже назвал строки, дописанные и изменённые в этом
    // модуле относительно поставщика. Их и проверяем — это ровно доработка.
    //
    // Раньше такой модуль объявлялся непроверяемым («где именно правка,
    // определить нечем») — при том, что сравнение состоялось и отличия были
    // видны. Пользователь указал на противоречие прямо: «Ты ведь запустил
    // сравнение с конфигурацией поставщика и увидел различия».
    if (!diff && partialTargets.has(module)) {
      const reported = reportedRegions(module, changeSet, source);
      if (reported) {
        diff = reported;
        partial.fromReport += 1;
        partial.fromReportLines += reported.addedLines;
        recordModuleChange(moduleChanges, module, {
          method: 'compare',
          changedLines: reported.addedLines,
          removedLines: reported.removedLines,
          regions: reported.regions,
          fragments: fragmentBudget > 0 ? takeFragments(source, reported.regions, structure.routines) : [],
        }, structure.routines);
        if (reported.regions.length && fragmentBudget > 0) fragmentBudget -= 1;
        if (!reported.regions.length) continue;
      }
    }

    // Правила прогоняются по тексту, где типовые строки вычищены, а номера
    // строк сохранены. Фильтровать готовые замечания по номеру строки нельзя:
    // часть правил считает по модулю целиком и привязывает одно замечание
    // со счётчиком к первому вхождению — то есть к строке ВЕНДОРА.
    const ctx = diff
      ? runRuleSets({ module, source: keepOnlyRegions(source, diff.regions), configuration })
      : runRuleSets({ module, source, tokens, stats, structure, queries, configuration });

    if (diff) {
      // Правила здесь видят текст с вычищенными типовыми строками (включая
      // объявление «Процедура …»), поэтому в его собственной структуре
      // процедур не осталось — имя нужно искать в структуре ПОЛНОГО модуля,
      // разобранной до вычистки: номера строк те же, вычистка их не сдвигает.
      findings.push(...signChangedFindings(ctx.findings, regions).map((f) => (
        f.routine ? f : { ...f, routine: findRoutineAtLine(structure.routines, f.line)?.name || null }
      )));
      continue;
    }

    if (partialTargets.has(module)) {
      if (!regions.length) {
        // Пометок разработчика нет — модуль НЕ анализируется вовсе.
        //
        // Пробовали иначе: выдавать замечания и подписывать их «автор
        // не определён». На реальной ERP это дало 347 замечаний к типовому
        // коду вендора — например «Запрос без условия отбора» на строке 4605
        // модуля «ЗакрытиеМесяцаСервер», где никакой доработки
        // нет и в помине. Пользователь поймал это сразу: «С чего ты взял,
        // что это код, добавленный вендором? Почему ты включил его в анализ?»
        //
        // Различие хешей говорит лишь о том, что модуль отличается от
        // поставщика, но не о том, ГДЕ отличается. Без пометок отделить
        // десяток авторских строк от пяти тысяч типовых нечем, а замечания
        // к чужому коду обесценивают отчёт целиком. Такие модули считаются
        // и называются в отчёте — этого достаточно, чтобы о них не забыли.
        partial.withoutMarks += 1;
        if (dumpInfoKeyForModule(module)) partial.withoutMarksModules.push(module.title);
        else partial.withoutKeyModules.push(module.title);
        recordModuleChange(moduleChanges, module, { method: 'none' });
        continue;
      }
      partial.withMarks += 1;
      partial.authoredLines += authoredLineCount(regions);
      recordModuleChange(moduleChanges, module, {
        method: 'marks',
        changedLines: authoredLineCount(regions),
        regions,
        authors: [...new Set(regions.map((r) => r.author).filter(Boolean))],
        fragments: fragmentBudget > 0 ? takeFragments(source, regions, structure.routines) : [],
      }, structure.routines);
      if (fragmentBudget > 0) fragmentBudget -= 1;
      findings.push(...keepAuthoredFindings(ctx.findings, regions, partial));
      continue;
    }

    // Модуль авторский целиком (добавленный или из расширения). Замечания
    // здесь не фильтруем, но подписываем: по вставке, в которую попала строка,
    // а если строка вне вставок — автором модуля.
    const origin = originOf(module, changeSet);
    const moduleAuthor = origin === 'vendor'
      ? null
      // Комментариев может не быть вовсе — у собственных объектов интегратора
      // подписывать нечего, они его целиком. Тогда работает второй признак,
      // названный пользователем наравне с фамилиями: префикс в имени объекта.
      : soleAuthor(regions) || (origin === 'added' ? prefixAuthor(module, customPrefixes) : null);
    if (moduleAuthor) authoredModules.add(module.rel);

    // Модуль добавленного объекта: у поставщика его нет вовсе — в дереве
    // отличий показываем объём, а не участки. Модули расширений в дерево
    // не попадают: их ключ совпал бы с ключом типового объекта, который
    // расширение заимствует, и правка легла бы не туда.
    if (origin === 'added' && !module.extensionName) {
      recordModuleChange(moduleChanges, module, {
        method: 'added', changedLines: stats.codeLines, authors: moduleAuthor ? [moduleAuthor] : [],
      });
    }

    for (const finding of ctx.findings) {
      const author = pickAuthor(regions, finding.line, moduleAuthor, origin);
      findings.push(author ? { ...finding, origin, author } : { ...finding, origin });
    }
  }

  findings.push(...detectDuplicates(fingerprints));

  return {
    findings: sortFindings(findings),
    metrics,
    summary: summarize(findings),
    scope: {
      filtered: filtering,
      vendorComparisonUsed: Boolean(changeSet),
      analyzeVendorCode: Boolean(analyzeVendorCode),
      analyzedModules: targets.length,
      totalModules: modules.length,
      skippedModules: skipped.total,
      skippedByType: skipped.byModuleType,
      partial,
      /** Модулей интегратора, подписанных именем разработчика целиком. */
      authoredModules: authoredModules.size,
    },
    byAuthor: groupByAuthor(findings),
    /** Отличия по модулям — для дерева отличий от конфигурации поставщика. */
    moduleChanges,
  };
}

/**
 * Сколько модулей сопровождать фрагментами кода.
 *
 * Фрагменты — самое ценное в дереве отличий и самое тяжёлое: это текст
 * исходников внутри результата аудита. На ERP изменённых типовых модулей
 * бывают сотни, и без ограничения result.json растёт на мегабайты ради
 * страницы, которую никто не пролистает до конца.
 */
const FRAGMENT_MODULES_LIMIT = 300;
/**
 * Раньше — просто первые 3 участка модуля. При группировке дерева отличий
 * по процедурам это давало пустые группы: у процедуры есть строка «участков:
 * N», но раскрывать нечего — текст достался только первым трём участкам
 * модуля, а не первому участку КАЖДОЙ задетой процедуры. Снаружи это
 * выглядело как «процедура не раскрывается». Теперь бюджет считается
 * на процедуру: по одному фрагменту на каждую, до этого предела процедур.
 */
const FRAGMENTS_PER_MODULE = 20;
const LINES_PER_FRAGMENT = 12;
const MAX_LINE_CHARS = 200;

/** Сколько участков изменений хранить по одному модулю. */
const REGIONS_PER_MODULE = 40;

/**
 * Запись об отличиях одного модуля. Без ключа ConfigDumpInfo она бесполезна.
 *
 * Участки сохраняются только номерами строк: в разборе по пометкам к ним
 * прилагается ещё и текст маркера, а он уже учтён в списке авторов и в самих
 * фрагментах — второй раз внутри результата аудита он не нужен.
 */
function recordModuleChange(moduleChanges, module, change, routines = []) {
  const key = dumpInfoKeyForModule(module);
  if (!key) return;

  // Имя процедуры/функции, которой принадлежит участок — для группировки
  // в дереве отличий: без него длинный список правок в изменённом типовом
  // модуле не отвечает на вопрос «в какой процедуре что».
  const regions = (change.regions || [])
    .slice(0, REGIONS_PER_MODULE)
    .map((r) => ({
      startLine: r.startLine,
      endLine: r.endLine,
      routine: findRoutineAtLine(routines, r.startLine)?.name || null,
      ...(r.vendorLines?.length ? { vendorLines: r.vendorLines } : {}),
    }));

  moduleChanges.push({
    key,
    title: module.title,
    rel: module.rel,
    ...change,
    ...(change.regions ? { regions, regionCount: change.regions.length } : {}),
  });
}

/**
 * Куски исходного текста по участкам изменений — чтобы в дереве отличий
 * было видно не «модуль изменён», а что именно дописано.
 */
function takeFragments(source, regions, routines = []) {
  if (!regions?.length) return [];
  const lines = source.split(/\r?\n/);

  // По одному участку на каждую процедуру (первому встреченному), а не
  // просто первые N участков модуля целиком — иначе у процедуры со вторым
  // и далее номером в списке правок текста не остаётся вовсе.
  const seen = new Set();
  const selected = [];
  for (const region of regions) {
    const routine = findRoutineAtLine(routines, region.startLine)?.name || null;
    const dedupeKey = routine || `#${region.startLine}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    selected.push({ region, routine });
    if (selected.length >= FRAGMENTS_PER_MODULE) break;
  }

  return selected.map(({ region, routine }) => {
    const from = Math.max(1, region.startLine);
    const to = Math.min(lines.length, region.endLine);
    // Дальше конца участка не берём. Раньше фрагмент всегда тянул
    // LINES_PER_FRAGMENT строк от начала, и под заголовком «строки 17–20»
    // печаталось двенадцать — восемь из них типовые, с пометками вендора
    // «//++ НЕ УТ». Читатель видел код поставщика там, где обещана доработка.
    const count = Math.min(to - from + 1, LINES_PER_FRAGMENT);
    return {
      startLine: from,
      endLine: to,
      truncated: Math.max(0, to - from + 1 - LINES_PER_FRAGMENT),
      lines: lines.slice(from - 1, from - 1 + count)
        .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)),
      routine,
      // Код поставщика на этом же месте — для двустороннего показа отличий.
      // Пуст для чистой вставки: у поставщика здесь ничего не было.
      vendorLines: region.vendorLines || [],
    };
  });
}

/**
 * Оставляет только замечания, попавшие в авторские вставки, и подписывает
 * каждое именем разработчика.
 *
 * Замечания без строки (о модуле целиком: «слишком большой модуль»,
 * «привилегированный общий модуль») отбрасываются: они относятся к типовому
 * модулю вендора, а не к вставке интегратора.
 */
/**
 * Читает тот же модуль из выгрузки конфигурации поставщика.
 *
 * Раскладка каталогов у выгрузок совпадает, поэтому относительный путь модуля
 * одинаков в обеих. Нет файла — значит, модуля у поставщика нет вовсе
 * (добавлен интегратором) либо выгрузка неполная; в обоих случаях сравнивать
 * нечего, и работает разбор по пометкам.
 */
/**
 * Участки правок модуля по отчёту конфигуратора о сравнении с поставщиком.
 *
 * Это второй по точности источник после построчного сравнения с исходниками
 * и единственный, когда исходников поставщика нет вовсе, — то есть при
 * сравнении прямо в базе, а это самый частый сценарий.
 *
 * **Место в модуле ищется по тексту, а не по номеру строки из отчёта.**
 * Номера конфигуратор печатает в собственном пространстве сравнения, где
 * удалённые строки поставщика тоже занимают позиции: на реальной ERP из 52
 * участков вставок точно легли на файл 40, а у блоков «Изменено» номера двух
 * участков одного модуля оказались переставлены местами. Сдвинутый участок
 * хуже пропущенного: он открыл бы правилам код вендора — ровно то, чего
 * весь механизм и избегает. Поэтому номер служит подсказкой при выборе
 * из повторов, а строку, которой в модуле не нашлось, мы просто не проверяем.
 *
 * Форма результата совпадает с `diffModule`, чтобы дальше по коду ветвление
 * не размножалось: правила в обоих случаях видят только изменённые строки.
 */
function reportedRegions(module, changeSet, source) {
  const lines = changeSet?.moduleLines;
  if (!lines?.size) return null;

  const key = dumpInfoKeyForModule(module);
  const entry = key && lines.get(key);
  if (!entry) return null;

  const index = indexSourceLines(source);
  // Номер строки клиента → строка поставщика, стоявшая на этом месте (null —
  // строка добавлена, у поставщика её не было). Отчёт платформы для строк
  // блока «Изменено» печатает обе версии («<» и «>»), а для чистой вставки —
  // только клиентскую. Нужно для двустороннего показа отличий в отчёте.
  const found = new Map();

  for (const block of entry.blocks || []) {
    // Опора участка: первая строка, которая в модуле встречается единожды.
    // От неё считается сдвиг, по которому разрешаются повторяющиеся строки
    // вроде «КонецПроцедуры» и «&НаКлиенте».
    let shift = null;
    for (let i = 0; i < block.lines.length; i += 1) {
      const places = index.get(normalizeLine(block.lines[i]));
      if (places?.length === 1) {
        shift = places[0] - i;
        break;
      }
    }

    const vendorAt = (i) => block.vendorLines?.[i] ?? null;

    for (let i = 0; i < block.lines.length; i += 1) {
      const places = index.get(normalizeLine(block.lines[i]));
      if (!places?.length) continue;
      if (places.length === 1) {
        found.set(places[0], vendorAt(i));
        continue;
      }
      if (shift === null) continue;
      // Повтор: берём вхождение, ближайшее к ожидаемому месту, и только если
      // оно там действительно рядом — иначе это другой такой же фрагмент кода.
      const expected = shift + i;
      const nearest = places.reduce((a, b) => (Math.abs(b - expected) < Math.abs(a - expected) ? b : a));
      if (Math.abs(nearest - expected) <= NEARBY_LINES) found.set(nearest, vendorAt(i));
    }
  }

  if (!found.size) return { regions: [], addedLines: 0, removedLines: entry.removedLines, exact: true };

  const regions = toRegions([...found.keys()]);
  for (const region of regions) {
    const vendorLines = [];
    for (let ln = region.startLine; ln <= region.endLine; ln += 1) {
      const v = found.get(ln);
      if (v !== undefined && v !== null) vendorLines.push(v);
    }
    if (vendorLines.length) region.vendorLines = vendorLines;
  }

  return {
    regions,
    addedLines: found.size,
    removedLines: entry.removedLines,
    exact: true,
  };
}

/** На сколько строк вхождение может отстоять от ожидаемого места. */
const NEARBY_LINES = 3;

/** Текст строки → номера строк, где она встречается (нумерация с единицы). */
function indexSourceLines(source) {
  const index = new Map();
  const lines = String(source ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const key = normalizeLine(lines[i]);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(i + 1);
  }
  return index;
}

/**
 * Отступы и хвостовые пробелы конфигуратор в отчёте рисует по-своему,
 * поэтому сравниваем по содержимому строки.
 */
function normalizeLine(line) {
  return String(line ?? '').replace(/\s+/g, ' ').trim();
}

async function readVendorModule(vendorDir, module) {
  if (!module.rel || module.extensionName) return null;
  try {
    return await readText(path.join(vendorDir, module.rel));
  } catch {
    return null;
  }
}

/**
 * Прогон всех наборов правил над модулем.
 *
 * Разбор кода передаётся снаружи, если он уже сделан: для изменённого типового
 * модуля правила читают не исходный текст, а очищенный от типовых строк,
 * и разбирать приходится заново.
 */
function runRuleSets({ module, source, tokens, stats, structure, queries, configuration }) {
  let parsed = { tokens, stats, structure, queries };
  if (!parsed.tokens) {
    const lexed = tokenize(source);
    parsed = {
      tokens: lexed.tokens,
      stats: lexed.stats,
      structure: analyzeStructure(lexed.tokens),
      queries: extractQueries(lexed.tokens),
    };
  }

  const ctx = createRuleContext({ module, source, configuration, ...parsed });
  for (const ruleSet of RULE_SETS) {
    try {
      ruleSet.run(ctx);
    } catch (err) {
      log.warn(`Правило ${ruleSet.id} упало на ${module.rel}: ${err.message}`);
    }
  }
  return ctx;
}

function oversizedModuleFinding(module, chars) {
  return {
    ruleId: 'arch.module-too-large-to-analyze',
    title: 'Модуль слишком велик для автоматического анализа',
    severity: SEVERITY.MEDIUM,
    category: CATEGORY.ARCHITECTURE,
    detail: `Размер модуля — ${Math.round(chars / 1024)} КБ. Такой объём кода в одном файле сам по себе является архитектурной проблемой.`,
    recommendation: 'Разделите модуль на несколько по зонам ответственности.',
    moduleTitle: module.title,
    moduleFile: module.rel,
    moduleType: module.moduleType,
    moduleTypeRu: module.moduleTypeRu,
    ownerKind: module.ownerKind,
    ownerName: module.ownerName,
    formName: module.formName,
  };
}

function accumulateMetrics(metrics, module, stats, structure, queries) {
  metrics.totalLines += stats.lines;
  metrics.codeLines += stats.codeLines;
  metrics.commentLines += stats.commentLines;
  metrics.blankLines += stats.blankLines;
  metrics.routines += structure.routines.length;
  metrics.exportRoutines += structure.routines.filter((r) => r.isExport).length;
  metrics.loops += structure.loops.length;
  metrics.queries += queries.length;

  const byType = metrics.byModuleType[module.moduleType] || { count: 0, codeLines: 0 };
  byType.count += 1;
  byType.codeLines += stats.codeLines;
  metrics.byModuleType[module.moduleType] = byType;

  if (stats.codeLines > metrics.maxModule.codeLines) {
    metrics.maxModule = { title: module.title, codeLines: stats.codeLines, file: module.rel };
  }
  for (const routine of structure.routines) {
    if (routine.lines > metrics.maxRoutine.lines) {
      metrics.maxRoutine = { name: routine.name, lines: routine.lines, module: module.title };
    }
  }
}

/**
 * Собирает отпечатки тел процедур для поиска дублей.
 * Учитываются только процедуры от 15 строк — короткие совпадения не значимы.
 */
function collectFingerprints(fingerprints, module, structure, source) {
  const lines = source.split('\n');
  for (const routine of structure.routines) {
    if (routine.lines < 15) continue;
    const body = lines.slice(routine.startLine, routine.endLine - 1).join('\n');
    if (body.trim().length < 200) continue;
    const key = codeFingerprint(body);
    if (!fingerprints.has(key)) fingerprints.set(key, []);
    const places = fingerprints.get(key);
    if (places.length < 20) {
      places.push({
        module: module.title,
        file: module.rel,
        moduleType: module.moduleType,
        moduleTypeRu: module.moduleTypeRu,
        ownerKind: module.ownerKind,
        ownerName: module.ownerName,
        formName: module.formName,
        routine: routine.name,
        line: routine.startLine,
        lines: routine.lines,
      });
    }
  }
}

/** Дублирующийся код между модулями. */
function detectDuplicates(fingerprints) {
  const findings = [];
  for (const places of fingerprints.values()) {
    if (places.length < 2) continue;
    const [first] = places;
    findings.push({
      ruleId: 'arch.duplicate-code',
      title: `Дублирование кода: «${first.routine}» повторяется ${places.length} раз(а)`,
      severity: places.length >= 4 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      category: CATEGORY.ARCHITECTURE,
      line: first.line,
      detail:
        `Тело процедуры «${first.routine}» (${first.lines} строк) с точностью до форматирования ` +
        `повторяется в ${places.length} местах: ` +
        places.slice(0, 5).map((p) => `${p.module} → ${p.routine}`).join('; ') +
        (places.length > 5 ? ` и ещё ${places.length - 5}` : '') + '.',
      recommendation:
        'Вынесите общий код в экспортную процедуру общего модуля. Дублирование означает, ' +
        'что исправление дефекта придётся вносить в каждую копию отдельно.',
      moduleTitle: first.module,
      moduleFile: first.file,
      moduleType: first.moduleType,
      moduleTypeRu: first.moduleTypeRu,
      ownerKind: first.ownerKind,
      ownerName: first.ownerName,
      formName: first.formName,
      routine: first.routine,
      duplicates: places,
    });
  }
  return findings;
}

function sortFindings(findings) {
  const order = new Map(SEVERITY_ORDER.map((s, i) => [s, i]));
  return findings.sort((a, b) => {
    const diff = (order.get(a.severity) ?? 9) - (order.get(b.severity) ?? 9);
    if (diff) return diff;
    return String(a.ruleId).localeCompare(String(b.ruleId));
  });
}

/** Сводка находок по критичности, категории и правилу. */
export function summarize(findings) {
  const bySeverity = {};
  const byCategory = {};
  const byRule = {};

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    if (!byRule[f.ruleId]) {
      byRule[f.ruleId] = { ruleId: f.ruleId, title: f.title, severity: f.severity, category: f.category, count: 0 };
    }
    byRule[f.ruleId].count += 1;
  }

  return {
    total: findings.length,
    bySeverity,
    byCategory,
    topRules: Object.values(byRule).sort((a, b) => b.count - a.count).slice(0, 25),
  };
}
