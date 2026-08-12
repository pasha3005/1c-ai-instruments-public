/**
 * Оркестрация анализа: собирает результаты всех анализаторов в единую модель
 * отчёта. Здесь нет ввода-вывода — только вычисления над уже разобранными
 * данными, поэтому модуль полностью покрывается тестами.
 */

import { analyzeCode } from './codeAnalyzer.js';
import { buildVendorDiffTree } from './vendorConfig.js';
import {
  analyzeModifications, describeModificationLevel, topCustomObjects, analyzeNamePrefixes,
  extensionObjectChanges,
} from './modifications.js';
import { scoreUpdatability, scoreHealth } from './updatability.js';
import { analyzeDataVolume } from './dataVolume.js';
import { estimateEffort, buildImprovementPlan } from './effort.js';
import { orderedKindStats } from '../parse/configuration.js';
import { SEVERITY_RU, CATEGORY_RU } from './rules/context.js';
import { ruPlural } from '../parse/metadataKinds.js';

/**
 * @param {object} params
 * @param {object} params.parsed результат parseConfigurationDump
 * @param {import('../parse/modules.js').ModuleRef[]} params.modules
 * @param {object[]} params.extensions
 * @param {object[]} params.roles
 * @param {object} params.live результат COM-сбора
 * @param {object} params.infobaseFacts
 * @param {object|null} params.baseline
 * @param {object} params.input исходные параметры аудита
 * @param {object} [params.hooks] колбэки прогресса
 */
export async function runAnalysis({
  parsed, modules, extensions, roles, live, infobaseFacts, baseline,
  changeSet = null, vendorComparison = null, vendorDir = null, vendorDetails = null,
  missingExtensions = [], input, hooks = {},
}) {
  const objectIndex = new Map(parsed.objects.map((o) => [o.fullName, o]));

  // Префиксы доработок («ДРБ_», «инт_») считаются до анализа кода: по ним
  // распознаются авторские вставки в типовых модулях — интеграторы обычно
  // помечают правки тем же префиксом, что и собственные объекты.
  const prefixes = analyzeNamePrefixes(parsed.objects, parsed.configuration);
  const customPrefixes = prefixes.candidates.map((c) => c.prefix);

  const configurationContext = { ...parsed, objectIndex, customPrefixes };

  // --- Анализ кода ---
  // При наличии конфигурации поставщика анализируются только доработки.
  const codeAnalysis = await analyzeCode(modules, configurationContext, {
    onProgress: hooks.onCodeProgress,
    changeSet,
    // Исходники поставщика на диске — тогда изменённые типовые модули
    // разбираются построчным сравнением, а не по пометкам.
    vendorDir,
  });

  // --- Дерево отличий от конфигурации поставщика ---
  // Строится после анализа кода: только он знает, что именно изменилось
  // внутри каждого модуля.
  const diffTree = changeSet && vendorComparison?.available
    ? await buildVendorDiffTree({
      changeSet,
      details: vendorDetails,
      objects: parsed.objects,
      moduleChanges: codeAnalysis.moduleChanges || [],
      vendorDir,
    })
    : null;

  // --- Доработки и обновляемость ---
  //
  // Сравнение с поставщиком видит только основную конфигурацию: расширения
  // в него не входят вовсе. Но заимствованный расширением типовой объект —
  // такая же изменённая доработка, а собственный объект расширения — такая же
  // добавленная. Поэтому перечни объектов и счётчики дополняются ещё до
  // расчёта уровня доработанности: иначе «затронуто объектов» не сходилось бы
  // с тем, что видно в конфигураторе.
  const extensionChanges = extensionObjectChanges(extensions, changeSet);
  const comparison = withExtensionChanges(vendorComparison, extensionChanges);

  // Точное сравнение с конфигурацией поставщика имеет приоритет над эталоном
  // из реестра и над оценкой по косвенным признакам.
  const modifications = analyzeModifications({
    parsed, objectIndex, extensions, baseline, changeSet,
    vendorComparison: comparison, extensionChanges,
  });
  const updatability = scoreUpdatability({ modifications, extensions, codeAnalysis, parsed });

  // --- Данные ---
  const dataVolume = analyzeDataVolume({ live, parsed, objectIndex, infobaseFacts });

  // --- Трудозатраты ---
  const effort = estimateEffort({
    codeAnalysis, updatability, modifications, parsed, dataVolume,
    hourlyRate: Number(input?.hourlyRate) || 0,
  });

  const plan = buildImprovementPlan({ codeAnalysis, dataVolume, updatability, effort });

  // --- Итоговые оценки ---
  const scores = scoreHealth({ updatability, codeAnalysis, parsed, dataVolume });

  const security = summarizeSecurity({ roles, codeAnalysis });

  return {
    generatedAt: new Date().toISOString(),
    input: sanitizeInput(input),
    configuration: {
      ...parsed.configuration,
      typicalSolution: modifications.typical,
      bsp: modifications.bsp,
      isOnSupport: modifications.isOnSupport,
    },
    infobase: infobaseFacts,
    vendorComparison: diffTree ? { ...comparison, tree: diffTree } : comparison,
    metadata: {
      totals: parsed.totals,
      countsByKind: parsed.countsByKind,
      kindStats: orderedKindStats(parsed.countsByKind),
      heaviestObjects: findHeaviestObjects(parsed.objects),
    },
    code: codeAnalysis,
    modifications: {
      ...modifications,
      levelDescription: describeModificationLevel(modifications.modificationLevel),
      topCustomObjects: topCustomObjects(modifications.prefixAnalysis),
    },
    extensions: {
      count: extensions.length,
      items: extensions,
      impact: modifications.extensionImpact,
      // Есть в базе, но исходников платформа не отдала: их код не проверялся.
      missing: missingExtensions,
    },
    roles: {
      count: roles.length,
      items: roles,
      ...security.roleSummary,
    },
    security: security.summary,
    dataVolume,
    updatability,
    effort,
    plan,
    scores: {
      health: scores.health,
      updatability: updatability.score,
      ...scores.components,
    },
    findings: codeAnalysis.findings,
    dictionaries: { SEVERITY_RU, CATEGORY_RU },
  };
}

/**
 * Дополняет сравнение с поставщиком объектами, которые тронуты расширениями.
 *
 * Ключи расширений уже очищены от пересечений с `changeSet` (см.
 * `extensionObjectChanges`), поэтому один объект не посчитается дважды.
 * Источник изменения запоминается в `objectSource`: в перечне важно видеть,
 * пришло отличие из самой конфигурации или из расширения — чинить их
 * приходится по-разному.
 */
function withExtensionChanges(comparison, extensionChanges) {
  if (!comparison?.available || !extensionChanges?.total) return comparison;

  const objectSource = { ...(comparison.objectSource || {}) };
  const label = (entry) => `расширение «${entry.extensions.join('», «')}»`;
  for (const entry of extensionChanges.changedObjects) objectSource[entry.key] = label(entry);
  for (const entry of extensionChanges.addedObjects) objectSource[entry.key] = label(entry);

  const changedObjects = [...comparison.changedObjects, ...extensionChanges.changedObjects.map((e) => e.key)];
  const addedObjects = [...comparison.addedObjects, ...extensionChanges.addedObjects.map((e) => e.key)];

  return {
    ...comparison,
    objectSource,
    changedObjects: changedObjects.sort((a, b) => a.localeCompare(b, 'ru')),
    addedObjects: addedObjects.sort((a, b) => a.localeCompare(b, 'ru')),
    changedObjectCount: comparison.changedObjectCount + extensionChanges.changedCount,
    addedObjectCount: comparison.addedObjectCount + extensionChanges.addedCount,
    /** Сколько из перечисленного пришло из расширений — показывается в отчёте. */
    extensionChangedCount: extensionChanges.changedCount,
    extensionAddedCount: extensionChanges.addedCount,
  };
}

/** Пароль в результат не попадает. */
function sanitizeInput(input) {
  if (!input) return {};
  const { password, ...rest } = input;
  return { ...rest, hasPassword: Boolean(password) };
}

/**
 * «Тяжёлые» объекты: много реквизитов, табличных частей и форм.
 * Это косвенный признак объектов, которые дороже всего сопровождать.
 */
function findHeaviestObjects(objects, limit = 20) {
  return objects
    .map((o) => ({
      fullName: o.fullName,
      kind: o.kind,
      kindRu: ruPlural(o.kind),
      name: o.name,
      synonym: o.synonym,
      attributeCount: o.attributeCount || 0,
      tabularSectionCount: o.tabularSectionCount || 0,
      tabularAttributeCount: o.tabularAttributeCount || 0,
      formCount: o.forms?.length || 0,
      weight:
        (o.attributeCount || 0) +
        (o.tabularAttributeCount || 0) +
        (o.tabularSectionCount || 0) * 5 +
        (o.forms?.length || 0) * 3,
    }))
    .filter((o) => o.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** Сводка по безопасности: роли + находки в коде. */
function summarizeSecurity({ roles, codeAnalysis }) {
  const fullAccessRoles = roles.filter((r) => r.hasFullAccess);
  const rolesWithoutRls = roles.filter((r) => r.restrictionCount === 0 && r.rightCount > 0);
  const setForNewObjects = roles.filter((r) => r.setForNewObjects);
  const totalRestrictions = roles.reduce((s, r) => s + r.restrictionCount, 0);

  const securityFindings = codeAnalysis.findings.filter((f) => f.category === 'security');

  return {
    roleSummary: {
      fullAccessCount: fullAccessRoles.length,
      fullAccessNames: fullAccessRoles.map((r) => r.name).slice(0, 20),
      withoutRlsCount: rolesWithoutRls.length,
      setForNewObjectsCount: setForNewObjects.length,
      setForNewObjectsNames: setForNewObjects.map((r) => r.name).slice(0, 20),
      totalRestrictions,
    },
    summary: {
      findingsCount: securityFindings.length,
      criticalCount: securityFindings.filter((f) => f.severity === 'critical' || f.severity === 'high').length,
      rlsUsed: totalRestrictions > 0,
      observations: buildSecurityObservations({
        roles, fullAccessRoles, setForNewObjects, totalRestrictions, securityFindings,
      }),
    },
  };
}

function buildSecurityObservations({ roles, fullAccessRoles, setForNewObjects, totalRestrictions, securityFindings }) {
  const observations = [];

  if (fullAccessRoles.length > 1) {
    observations.push({
      severity: 'medium',
      title: `Ролей с правом администрирования: ${fullAccessRoles.length}`,
      detail:
        `Полный доступ дают роли: ${fullAccessRoles.map((r) => r.name).slice(0, 5).join(', ')}` +
        (fullAccessRoles.length > 5 ? ' и другие' : '') + '. ' +
        'Чем больше таких ролей, тем сложнее контролировать, кто фактически имеет полный доступ к данным.',
      recommendation: 'Оставьте одну административную роль и выдавайте её только администраторам.',
    });
  }

  if (totalRestrictions === 0 && roles.length > 2) {
    observations.push({
      severity: 'medium',
      title: 'Ограничения доступа на уровне записей (RLS) не используются',
      detail:
        'Ни в одной роли не заданы ограничения доступа к данным. Любой пользователь, ' +
        'имеющий право чтения объекта, видит все его записи без исключения.',
      recommendation:
        'Если данные разных подразделений, организаций или менеджеров должны быть разграничены, ' +
        'настройте RLS либо используйте механизм групп доступа БСП.',
    });
  }

  if (setForNewObjects.length > 0) {
    observations.push({
      severity: 'low',
      title: `Роли с признаком «Устанавливать права для новых объектов»: ${setForNewObjects.length}`,
      detail:
        `Роли ${setForNewObjects.map((r) => r.name).slice(0, 5).join(', ')} автоматически получают права ` +
        'на все вновь добавляемые объекты метаданных.',
      recommendation:
        'Отключите признак у прикладных ролей: права на новые объекты должны выдаваться осознанно.',
    });
  }

  const bySeverity = securityFindings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  if (bySeverity.high || bySeverity.critical) {
    observations.push({
      severity: 'high',
      title: `Замечания по безопасности в коде: ${(bySeverity.critical || 0) + (bySeverity.high || 0)} высокой критичности`,
      detail: 'Подробности приведены в разделе технических находок.',
      recommendation: 'Устраните в первую очередь незакрытый привилегированный режим и динамическое исполнение кода.',
    });
  }

  return observations;
}
