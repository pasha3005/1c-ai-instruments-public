/**
 * Анализ доработок типовой конфигурации.
 *
 * Важное методологическое замечание, которое отражается и в отчёте.
 * Признак «объект снят с поддержки / изменён» хранится в служебных таблицах
 * информационной базы и НЕ попадает в XML-выгрузку конфигурации. Поэтому
 * определить состав изменений с точностью до объекта, имея только выгрузку,
 * невозможно ни одним инструментом.
 *
 * Отсюда двухуровневая модель:
 *
 *   1. ТОЧНОЕ СРАВНЕНИЕ — если для этой конфигурации зарегистрирован эталон
 *      (см. baselines.js), сравниваются перечни объектов и хеши из
 *      ConfigDumpInfo. Результат помечается как confidence = 'exact'.
 *
 *   2. ОЦЕНКА ПО КОСВЕННЫМ ПРИЗНАКАМ — когда эталона нет. Используются:
 *        • объекты с нетиповым префиксом имени (добавленные интегратором);
 *        • отклонение числа объектов от ожидаемого для данного решения;
 *        • расширения, подменяющие типовую логику;
 *        • нетиповые подсистемы.
 *      Результат помечается как confidence = 'estimated', и в отчёте прямо
 *      сказано, что это оценка.
 *
 * Такой подход честнее, чем выдавать эвристику за точный результат.
 */

import { detectTypicalSolution, detectBspUsage } from './typicalCatalog.js';
import { ruName } from '../parse/metadataKinds.js';

/**
 * @param {object} params
 * @param {object} params.parsed результат parseConfigurationDump
 * @param {Map<string,object>} params.objectIndex
 * @param {object[]} params.extensions
 * @param {object|null} params.baseline эталон для точного сравнения
 */
export function analyzeModifications({
  parsed, objectIndex, extensions, baseline, changeSet = null, vendorComparison = null,
  extensionChanges = null,
}) {
  const configuration = parsed.configuration;
  const typical = detectTypicalSolution(configuration);
  const bsp = detectBspUsage(objectIndex);

  const prefixAnalysis = analyzeNamePrefixes(parsed.objects, configuration);
  const subsystems = analyzeSubsystems(parsed.objects, configuration, prefixAnalysis);

  const extensionImpact = summarizeExtensionImpact(extensions);
  // Что расширения меняют в составе метаданных. Считается здесь же, чтобы
  // цифра «затронуто объектов» учитывала и доработки, сделанные расширением,
  // а не только отличия основной конфигурации от поставщика.
  const extChanges = extensionChanges || extensionObjectChanges(extensions, changeSet);

  // Приоритет источников: конфигурация поставщика → эталон из реестра → эвристика.
  const exact = changeSet && vendorComparison?.available
    ? compareWithVendorChangeSet(changeSet, vendorComparison, parsed)
    : (baseline ? compareWithBaseline(parsed, baseline) : null);

  const estimate = exact || estimateFromHeuristics({
    typical, parsed, prefixAnalysis, extensionImpact, extChanges,
  });

  return {
    typical,
    bsp,
    isOnSupport: Boolean(configuration.vendor && configuration.version),
    vendor: configuration.vendor,
    version: configuration.version,
    prefixAnalysis,
    subsystems,
    extensionImpact,
    extensionChanges: extChanges,
    ...estimate,
  };
}

/**
 * Анализ префиксов имён объектов.
 *
 * Логика: интегратор добавляет объекты со своим префиксом («Кл_», «УТ_ДОР»,
 * «xxx_»). Такие префиксы встречаются у меньшинства объектов, но систематически.
 * Префикс самой конфигурации (свойство NamePrefix) считается вендорским.
 */
export function analyzeNamePrefixes(objects, configuration) {
  const vendorPrefix = (configuration.namePrefix || '').trim();
  /** @type {Map<string, {prefix: string, count: number, samples: string[], kinds: Set<string>}>} */
  const prefixes = new Map();

  // Учитываем только прикладные объекты — языки и стили не показательны.
  const relevant = objects.filter((o) => !['Language', 'Style', 'StyleItem', 'CommonPicture'].includes(o.kind));

  for (const obj of relevant) {
    const prefix = extractPrefix(obj.name);
    if (!prefix) continue;
    if (!prefixes.has(prefix)) {
      prefixes.set(prefix, { prefix, count: 0, samples: [], kinds: new Set() });
    }
    const entry = prefixes.get(prefix);
    entry.count += 1;
    entry.kinds.add(obj.kind);
    if (entry.samples.length < 8) entry.samples.push(obj.fullName);
  }

  const total = relevant.length || 1;
  const candidates = [...prefixes.values()]
    // Префикс должен встречаться хотя бы у 2 объектов, но не быть массовым:
    // массовый префикс — это стиль именования вендора, а не признак доработки.
    .filter((e) => e.count >= 2 && e.count / total < 0.25)
    .filter((e) => !vendorPrefix || e.prefix.toLowerCase() !== vendorPrefix.toLowerCase())
    .map((e) => ({ ...e, kinds: [...e.kinds], share: e.count / total }))
    .sort((a, b) => b.count - a.count);

  const customObjectCount = candidates.reduce((sum, e) => sum + e.count, 0);

  return {
    vendorPrefix,
    totalRelevantObjects: relevant.length,
    candidates: candidates.slice(0, 20),
    customObjectCount,
    customShare: relevant.length ? customObjectCount / relevant.length : 0,
  };
}

/**
 * Выделяет префикс имени: часть до подчёркивания либо ведущие заглавные,
 * отделённые от остального имени.
 */
function extractPrefix(name) {
  const underscore = name.indexOf('_');
  if (underscore > 0 && underscore <= 6) {
    return name.slice(0, underscore + 1);
  }
  return null;
}

/** Нетиповые подсистемы — верхнеуровневый признак доработки. */
function analyzeSubsystems(objects, configuration, prefixAnalysis) {
  const customPrefixes = new Set(prefixAnalysis.candidates.map((c) => c.prefix.toLowerCase()));
  const all = objects.filter((o) => o.kind === 'Subsystem');
  const custom = all.filter((o) => {
    const prefix = extractPrefix(o.name);
    return prefix && customPrefixes.has(prefix.toLowerCase());
  });
  return {
    total: all.length,
    custom: custom.length,
    customNames: custom.slice(0, 20).map((o) => o.name),
  };
}

/**
 * Что расширения меняют в составе метаданных.
 *
 * Пользователь указал на пробел прямо: «в раздел изменённые объекты метаданных
 * должны попадать все объекты, которые изменены в том числе в расширениях».
 * Сравнение с конфигурацией поставщика расширений не видит вовсе — оно
 * сравнивает основную конфигурацию с её эталоном, а расширение лежит рядом
 * и в это сравнение не входит. Между тем это ровно такая же доработка:
 *
 *   • заимствованный объект (`ObjectBelonging = Adopted`) — типовой объект,
 *     ИЗМЕНЁННЫЙ расширением;
 *   • собственный объект расширения — ДОБАВЛЕННЫЙ в конфигурацию;
 *   • удалить типовой объект одним расширением нельзя, поэтому третьего
 *     множества здесь не бывает.
 *
 * Ключи, уже названные сравнением с поставщиком, отбрасываются: объект,
 * изменённый и в конфигурации, и расширением, — это один объект, а не два.
 *
 * @param {object[]} extensions
 * @param {{modified: Set<string>, added: Set<string>}|null} [changeSet]
 */
export function extensionObjectChanges(extensions = [], changeSet = null) {
  const alreadyChanged = changeSet?.modified || new Set();
  const alreadyAdded = changeSet?.added || new Set();

  const changed = new Map();
  const added = new Map();

  const push = (map, key, label) => {
    if (!map.has(key)) map.set(key, []);
    const names = map.get(key);
    if (!names.includes(label)) names.push(label);
  };

  for (const ext of extensions) {
    const label = ext.synonym || ext.name;
    for (const key of ext.adoptedKeys || []) {
      if (alreadyChanged.has(key)) continue;
      push(changed, key, label);
    }
    for (const key of ext.ownKeys || []) {
      if (alreadyAdded.has(key)) continue;
      push(added, key, label);
    }
  }

  const toList = (map) => [...map.entries()]
    .map(([key, names]) => ({ key, extensions: names }))
    .sort((a, b) => a.key.localeCompare(b.key, 'ru'));

  const changedObjects = toList(changed);
  const addedObjects = toList(added);

  return {
    changedObjects,
    addedObjects,
    changedCount: changedObjects.length,
    addedCount: addedObjects.length,
    total: changedObjects.length + addedObjects.length,
  };
}

/** Сводное влияние расширений на типовые объекты. */
function summarizeExtensionImpact(extensions) {
  let adoptedObjects = 0;
  let insteadAnnotations = 0;
  let safeAnnotations = 0;
  let highRisk = 0;

  for (const ext of extensions) {
    adoptedObjects += ext.adoptedCount || 0;
    insteadAnnotations += ext.annotations?.instead || 0;
    safeAnnotations += (ext.annotations?.before || 0) + (ext.annotations?.after || 0)
      + (ext.annotations?.changeAndValidate || 0);
    if (ext.risk === 'high') highRisk += 1;
  }

  return {
    count: extensions.length,
    adoptedObjects,
    insteadAnnotations,
    safeAnnotations,
    highRiskExtensions: highRisk,
  };
}

/**
 * Точное сравнение с конфигурацией поставщика.
 *
 * Считаем доработками только ОБЪЕКТЫ метаданных (не отдельные модули и формы):
 * так цифра «доработано N объектов из M» остаётся сопоставимой с тем, что видит
 * специалист в конфигураторе.
 */
export function compareWithVendorChangeSet(changeSet, vendorComparison, parsed) {
  const total = parsed.totals.objects || 1;
  // Доработка — любое отличие от поставщика: изменение, добавление И удаление.
  // Удалённый объект поставщика ломает обновление не меньше изменённого,
  // поэтому он равноправно входит в состав доработок (так же считает и ветка
  // сравнения с эталоном — compareWithBaseline).
  const modifiedCount =
    vendorComparison.changedObjectCount +
    vendorComparison.addedObjectCount +
    vendorComparison.removedObjectCount;
  const share = modifiedCount / total;

  return {
    confidence: 'exact',
    source: 'vendor',
    baselineTitle: `${vendorComparison.vendorConfigName || vendorComparison.vendorName}${vendorComparison.vendorVersion ? ` ${vendorComparison.vendorVersion}` : ''}`,
    addedObjects: vendorComparison.addedObjects.slice(0, 500),
    addedCount: vendorComparison.addedObjectCount,
    removedObjects: vendorComparison.removedObjects.slice(0, 500),
    removedCount: vendorComparison.removedObjectCount,
    changedObjects: vendorComparison.changedObjects.slice(0, 500),
    changedCount: vendorComparison.changedObjectCount,
    modifiedCount,
    modificationShare: share,
    modificationLevel: levelFromShare(share, modifiedCount),
    note:
      `Состав доработок определён точным сравнением с конфигурацией поставщика ` +
      `«${vendorComparison.vendorConfigName || vendorComparison.vendorName}»` +
      `${vendorComparison.vendorVersion ? ` версии ${vendorComparison.vendorVersion}` : ''}: ` +
      `изменено ${vendorComparison.modifiedEntries}, добавлено ${vendorComparison.addedEntries}, ` +
      `удалено ${vendorComparison.removedEntries} элементов (объектов, модулей и форм), ` +
      `совпадает с поставщиком ${vendorComparison.unchangedEntries}. ` +
      `Код анализировался по изменённым и добавленным модулям; у удалённых ` +
      `анализировать нечего — их нет в конфигурации, но как отличие от поставщика ` +
      `они учтены.`,
  };
}

/**
 * Точное сравнение с эталонной выгрузкой.
 * @param {object} parsed
 * @param {{objects: string[], hashes?: Record<string,string>, title: string}} baseline
 */
export function compareWithBaseline(parsed, baseline) {
  const current = new Set(parsed.objects.map((o) => o.fullName));
  const reference = new Set(baseline.objects || []);

  const added = [...current].filter((n) => !reference.has(n));
  const removed = [...reference].filter((n) => !current.has(n));

  /** @type {string[]} */
  const changed = [];
  if (baseline.hashes && parsed.hashes) {
    for (const [name, hash] of Object.entries(parsed.hashes)) {
      const ref = baseline.hashes[name];
      if (ref && ref !== hash) changed.push(name);
    }
  }

  const modifiedCount = added.length + removed.length + changed.length;
  const share = reference.size ? modifiedCount / reference.size : 0;

  return {
    confidence: 'exact',
    baselineTitle: baseline.title,
    addedObjects: added.slice(0, 500),
    addedCount: added.length,
    removedObjects: removed.slice(0, 500),
    removedCount: removed.length,
    changedObjects: changed.slice(0, 500),
    changedCount: changed.length,
    modifiedCount,
    modificationShare: share,
    modificationLevel: levelFromShare(share, modifiedCount),
  };
}

/** Оценка по косвенным признакам, когда эталона нет. */
function estimateFromHeuristics({ typical, parsed, prefixAnalysis, extensionImpact, extChanges }) {
  const totalObjects = parsed.totals.objects;
  const custom = prefixAnalysis.customObjectCount;

  // Отклонение от ожидаемого объёма типового решения.
  let deviation = null;
  if (typical.matched && typical.expectedObjects) {
    deviation = (totalObjects - typical.expectedObjects) / typical.expectedObjects;
  }

  // Совокупный объём доработок: собственные объекты + затронутые расширениями.
  const touched = custom + extensionImpact.adoptedObjects;
  const share = totalObjects ? touched / totalObjects : 0;

  return {
    confidence: typical.matched ? 'estimated' : 'unknown',
    baselineTitle: null,
    addedObjects: prefixAnalysis.candidates.flatMap((c) => c.samples).slice(0, 100),
    addedCount: custom,
    removedObjects: [],
    removedCount: 0,
    // Объекты, изменённые расширениями, известны точно даже без поставщика:
    // признак заимствования лежит в самом расширении.
    changedObjects: (extChanges?.changedObjects || []).map((e) => e.key),
    changedCount: extChanges?.changedCount || 0,
    modifiedCount: touched,
    modificationShare: share,
    objectCountDeviation: deviation,
    modificationLevel: levelFromShare(share, touched),
    note:
      'Точный состав изменений типовых объектов определяется по служебным данным ' +
      'информационной базы, которых нет в XML-выгрузке. Приведена оценка по косвенным ' +
      'признакам: объекты с нетиповыми префиксами имён и объекты, затронутые расширениями. ' +
      'Для точного расчёта зарегистрируйте эталонную выгрузку той же версии типового решения.',
  };
}

function levelFromShare(share, count) {
  if (count === 0) return 'none';
  if (share < 0.02) return 'low';
  if (share < 0.08) return 'medium';
  return 'high';
}

/** Человекочитаемое описание уровня доработок. */
export function describeModificationLevel(level) {
  switch (level) {
    case 'none': return 'Доработки не обнаружены';
    case 'low': return 'Незначительные доработки';
    case 'medium': return 'Умеренные доработки';
    case 'high': return 'Значительные доработки';
    default: return 'Уровень доработок не определён';
  }
}

/** Формирует перечень «самых доработанных» объектов для отчёта. */
export function topCustomObjects(prefixAnalysis, limit = 30) {
  const out = [];
  for (const candidate of prefixAnalysis.candidates) {
    for (const sample of candidate.samples) {
      if (out.length >= limit) return out;
      const [kind, name] = sample.split('.');
      out.push({ fullName: sample, kind, kindRu: ruName(kind), name, prefix: candidate.prefix });
    }
  }
  return out;
}
