/**
 * Оценка трудозатрат на устранение выявленных проблем.
 *
 * Модель построена на нормативах, привычных для 1С-франчайзи: каждая находка
 * имеет базовую трудоёмкость исправления, которая масштабируется коэффициентом
 * сложности конфигурации. Отдельно оценивается обновление типового решения.
 *
 * Оценка сознательно даётся диапазоном (оптимистичный/базовый/пессимистичный) —
 * это честнее одной цифры и соответствует практике предпроектного обследования.
 */

/**
 * Базовые нормативы в часах на одну находку.
 * Значения соответствуют средней квалификации разработчика 1С.
 */
const RULE_EFFORT = {
  'perf.query-many-joins': 3,
  'perf.query-nested-subqueries': 2.5,
  'perf.query-no-filter': 1.5,
  'perf.query-dottedFilter': 2,
  'perf.query-leadingWildcard': 1.5,
  'perf.query-castInWhere': 1.5,
  'perf.query-functionInWhere': 1.5,
  'perf.query-in-hierarchy': 3,
  'perf.query-autoorder': 0.5,
  'perf.string-concat-in-loop': 1,

  'arch.query-in-form': 4,
  'arch.large-form-module': 8,
  'arch.big-procedure': 3,
  'arch.high-complexity': 4,
  'arch.deep-nesting': 2,
  'arch.big-module': 8,
  'arch.duplicate-code': 3,
  'arch.empty-except': 1,
  'arch.too-many-params': 1,
  'arch.global-common-module': 2,
  'arch.module-too-large-to-analyze': 12,

  'sec.unbalanced-privileged-mode': 2,
  'sec.dynamic-execution': 3,
  'sec.external-code-loading': 4,
  'sec.com-object': 3,
  'sec.hardcoded-secret': 1.5,
  'sec.privileged-common-module': 3,
  'sec.safe-mode-disabled': 1.5,

  'std.deprecated-sync-call': 1,
  'std.no-regions': 1,
  'std.undocumented-export': 2,
  'std.goto': 1,
  'std.deprecated-message': 0.5,
  'std.missing-directive': 1,
  'std.catch-without-log': 0.75,
};

/** Норматив по умолчанию, если правило не перечислено явно. */
const DEFAULT_EFFORT = 1.5;

/**
 * Коэффициенты на разбор и тестирование сверх «чистой» разработки.
 * Отражают реальность: правка в большой типовой конфигурации требует
 * регрессионного тестирования.
 */
const OVERHEAD = {
  analysis: 0.25,
  testing: 0.35,
  documentation: 0.1,
  management: 0.15,
};

/**
 * @param {object} params
 * @param {object} params.codeAnalysis
 * @param {object} params.updatability
 * @param {object} params.modifications
 * @param {object} params.parsed
 * @param {object} params.dataVolume
 * @param {number} [params.hourlyRate] ставка в рублях для расчёта бюджета
 */
export function estimateEffort({
  codeAnalysis, updatability, modifications, parsed, dataVolume, hourlyRate = 0,
}) {
  const complexityFactor = configurationComplexityFactor(parsed, modifications);

  const byCategory = new Map();
  let rawHours = 0;

  for (const finding of codeAnalysis.findings) {
    const base = RULE_EFFORT[finding.ruleId] ?? DEFAULT_EFFORT;
    const severityFactor = severityMultiplier(finding.severity);
    const hours = base * severityFactor * complexityFactor;
    rawHours += hours;

    const key = finding.category;
    if (!byCategory.has(key)) byCategory.set(key, { category: key, findings: 0, hours: 0 });
    const entry = byCategory.get(key);
    entry.findings += 1;
    entry.hours += hours;
  }

  // Работы по данным (индексы, свёртка, регламенты).
  const dataHours = estimateDataWork(dataVolume) * complexityFactor;
  if (dataHours > 0) {
    byCategory.set('data', { category: 'data', findings: dataVolume.risks?.length || 0, hours: dataHours });
    rawHours += dataHours;
  }

  const overheadHours = rawHours * (
    OVERHEAD.analysis + OVERHEAD.testing + OVERHEAD.documentation + OVERHEAD.management
  );

  const remediationHours = rawHours + overheadHours;
  const updateHours = estimateUpdateEffort({ updatability, modifications, parsed, complexityFactor });

  const total = remediationHours + updateHours.base;

  return {
    complexityFactor: round(complexityFactor, 2),
    byCategory: [...byCategory.values()]
      .map((e) => ({ ...e, hours: round(e.hours, 1) }))
      .sort((a, b) => b.hours - a.hours),
    remediation: {
      developmentHours: round(rawHours, 1),
      overheadHours: round(overheadHours, 1),
      hours: round(remediationHours, 1),
    },
    update: updateHours,
    total: {
      hours: round(total, 1),
      optimistic: round(total * 0.7, 1),
      pessimistic: round(total * 1.6, 1),
      days: round(total / 8, 1),
    },
    budget: hourlyRate > 0 ? buildBudget(total, hourlyRate) : null,
    breakdownNote:
      'Оценка включает разработку, анализ, тестирование, документирование и управление. ' +
      'Диапазон отражает неопределённость предпроектного обследования: точная оценка ' +
      'возможна после детализации требований по каждому пункту.',
  };
}

/**
 * Множитель сложности конфигурации.
 * Правка в ERP на 9000 объектов дороже такой же правки в небольшой конфигурации.
 */
export function configurationComplexityFactor(parsed, modifications) {
  const objects = parsed.totals.objects || 0;
  let factor = 1;

  if (objects > 6000) factor = 1.6;
  else if (objects > 3000) factor = 1.4;
  else if (objects > 1000) factor = 1.2;
  else if (objects > 300) factor = 1.05;

  // Типовая конфигурация на поддержке требует аккуратности при правках.
  if (modifications.isOnSupport && modifications.typical.matched) factor *= 1.15;

  // Расширения усложняют отладку: логика размазана между слоями.
  const extCount = modifications.extensionImpact?.count || 0;
  if (extCount > 0) factor *= 1 + Math.min(0.3, extCount * 0.03);

  return factor;
}

function severityMultiplier(severity) {
  switch (severity) {
    case 'critical': return 1.5;
    case 'high': return 1.2;
    case 'medium': return 1;
    case 'low': return 0.6;
    default: return 0.4;
  }
}

function estimateDataWork(dataVolume) {
  if (!dataVolume?.risks?.length) return 0;
  let hours = 0;
  for (const risk of dataVolume.risks) {
    if (risk.severity === 'high') hours += 8;
    else if (risk.severity === 'medium') hours += 4;
    else hours += 1;
  }
  return hours;
}

/**
 * Оценка обновления типовой конфигурации.
 * Базируется на числе затронутых объектов и характере доработок.
 */
export function estimateUpdateEffort({ updatability, modifications, parsed, complexityFactor }) {
  if (!modifications.isOnSupport) {
    // Конфигурация снята с поддержки: обновление — отдельный проект.
    const objects = parsed.totals.objects || 0;
    const hours = Math.max(80, objects * 0.05) * complexityFactor;
    return {
      hours: round(hours, 1),
      base: hours,
      scenario: 'Возврат на поддержку и обновление',
      detail:
        'Конфигурация снята с поддержки. Потребуется восстановить сравнение с типовой ' +
        'конфигурацией, перенести доработки в расширения либо принять решение о развитии ' +
        'решения как самостоятельного продукта.',
    };
  }

  const touched = modifications.modifiedCount || 0;
  // Норматив: около 1,2 часа на объект, требующий ручного объединения.
  const mergeHours = touched * 1.2;
  const testingHours = Math.max(16, touched * 0.5);
  const extensionHours = (modifications.extensionImpact?.insteadAnnotations || 0) * 2
    + (modifications.extensionImpact?.adoptedObjects || 0) * 0.3;

  const hours = (mergeHours + testingHours + extensionHours) * complexityFactor;

  return {
    hours: round(hours, 1),
    base: hours,
    scenario: `Обновление типовой конфигурации (${updatability.levelRu.toLowerCase()})`,
    detail: updatability.updateEffort,
    components: {
      merge: round(mergeHours * complexityFactor, 1),
      testing: round(testingHours * complexityFactor, 1),
      extensions: round(extensionHours * complexityFactor, 1),
    },
  };
}

function buildBudget(hours, rate) {
  const base = hours * rate;
  return {
    hourlyRate: rate,
    optimistic: Math.round(base * 0.7),
    base: Math.round(base),
    pessimistic: Math.round(base * 1.6),
    currency: 'RUB',
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Формирует поэтапный план работ, отсортированный по соотношению «эффект/затраты». */
export function buildImprovementPlan({ codeAnalysis, dataVolume, updatability, effort }) {
  const stages = [];

  const critical = codeAnalysis.findings.filter((f) => f.severity === 'critical');
  const high = codeAnalysis.findings.filter((f) => f.severity === 'high');
  const security = codeAnalysis.findings.filter((f) => f.category === 'security' && f.severity !== 'low');
  const dataRisks = (dataVolume.risks || []).filter((r) => r.severity === 'high');

  if (critical.length || dataRisks.length) {
    stages.push({
      order: 1,
      title: 'Этап 1. Устранение критичных проблем производительности',
      goal: 'Снять текущие тормоза в работе пользователей',
      durationWeeks: estimateWeeks(critical.length * 3 + dataRisks.length * 8),
      items: [
        ...topItems(critical, 8),
        ...dataRisks.slice(0, 5).map((r) => r.title),
      ],
      effect: 'Заметное ускорение массовых операций и проведения документов',
    });
  }

  if (security.length) {
    stages.push({
      order: stages.length + 1,
      title: 'Этап 2. Приведение в порядок безопасности',
      goal: 'Исключить обход прав доступа и утечку секретов',
      durationWeeks: estimateWeeks(security.length * 2),
      items: topItems(security, 8),
      effect: 'Снижение риска несанкционированного доступа к данным',
    });
  }

  if (high.length) {
    stages.push({
      order: stages.length + 1,
      title: `Этап ${stages.length + 1}. Рефакторинг проблемных участков`,
      goal: 'Снизить стоимость дальнейшего сопровождения',
      durationWeeks: estimateWeeks(high.length * 2.5),
      items: topItems(high, 10),
      effect: 'Ускорение доработок и снижение числа регрессий',
    });
  }

  if (updatability.score < 80) {
    stages.push({
      order: stages.length + 1,
      title: `Этап ${stages.length + 1}. Повышение обновляемости`,
      goal: 'Вернуть возможность штатного обновления типовой конфигурации',
      durationWeeks: estimateWeeks(effort.update.hours),
      items: updatability.reasons.slice(0, 6).map((r) => r.title),
      effect: 'Обновления выходят регулярно и предсказуемо, снижается риск отставания от законодательства',
    });
  }

  if (!stages.length) {
    stages.push({
      order: 1,
      title: 'Этап 1. Поддержание текущего состояния',
      goal: 'Существенных проблем не выявлено',
      durationWeeks: 0,
      items: ['Регламентное обслуживание базы', 'Плановое обновление типовой конфигурации'],
      effect: 'Сохранение текущего уровня качества',
    });
  }

  return stages;
}

function topItems(findings, limit) {
  const seen = new Map();
  for (const f of findings) {
    if (!seen.has(f.ruleId)) seen.set(f.ruleId, { title: f.title, count: 0 });
    seen.get(f.ruleId).count += 1;
  }
  return [...seen.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((e) => (e.count > 1 ? `${e.title} — ${e.count} случаев` : e.title));
}

function estimateWeeks(hours) {
  if (!hours) return 0;
  // Одна ставка разработчика, 30 продуктивных часов в неделю.
  return Math.max(1, Math.ceil(hours / 30));
}
