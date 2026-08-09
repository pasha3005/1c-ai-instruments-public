/**
 * Модель оценки обновляемости конфигурации: 0–100 баллов.
 *
 * 100 — чистая типовая конфигурация, обновляется штатно и автоматически.
 *   0 — конфигурация полностью переработана, обновление равносильно
 *       повторному внедрению.
 *
 * Модель штрафная и объяснимая: каждый фактор снимает определённое число
 * баллов, и в отчёт выводится полная расшифровка. Это принципиально — заказчик
 * аудита должен видеть, из чего сложилась оценка, а не «магическое число».
 */

/**
 * Веса факторов. Сумма максимальных штрафов заведомо больше 100 —
 * итог ограничивается снизу нулём.
 */
const FACTORS = {
  notOnSupport: 45,
  modificationShare: 40,
  customObjects: 20,
  /**
   * Удалённые объекты поставщика. Вес выше, чем у собственных объектов:
   * добавленное обновлению не мешает, а удалённое типовое ломает его прямо —
   * механизм обновления будет пытаться восстановить объект либо упрётся
   * в ссылки на него из типового кода.
   */
  removedVendorObjects: 25,
  extensionsInstead: 25,
  extensionsAdopted: 15,
  extensionCount: 10,
  postingChanges: 12,
  criticalFindings: 10,
  bspAbsent: 5,
  compatibilityMode: 6,
  unknownConfiguration: 15,
};

/**
 * @param {object} params
 * @param {object} params.modifications результат analyzeModifications
 * @param {object[]} params.extensions
 * @param {object} params.codeAnalysis
 * @param {object} params.parsed
 * @returns {{score: number, level: string, levelRu: string, reasons: object[], updateEffort: string}}
 */
export function scoreUpdatability({ modifications, extensions, codeAnalysis, parsed }) {
  const reasons = [];
  let penalty = 0;

  const add = (points, title, detail) => {
    if (points <= 0) return;
    penalty += points;
    reasons.push({ points: Math.round(points), title, detail });
  };

  // --- Снятие с поддержки ---
  if (!modifications.isOnSupport) {
    add(
      FACTORS.notOnSupport,
      'Конфигурация не находится на поддержке поставщика',
      'Не заполнены свойства «Поставщик» и/или «Версия». Автоматическое обновление ' +
      'типового решения штатными средствами невозможно — потребуется ручное сравнение и объединение.',
    );
  } else if (!modifications.typical.matched) {
    add(
      FACTORS.unknownConfiguration,
      'Решение не опознано как типовое',
      `Конфигурация «${parsed.configuration.synonym || parsed.configuration.name}» ` +
      `поставщика «${modifications.vendor}» не найдена в каталоге типовых решений. ` +
      'Возможно, это отраслевое или заказное решение — порядок обновления определяется его разработчиком.',
    );
  }

  // --- Объём доработок ---
  const share = modifications.modificationShare || 0;
  if (share > 0) {
    const points = Math.min(FACTORS.modificationShare, share * 100 * 2.5);
    const confidenceNote = modifications.confidence === 'exact'
      ? 'по результатам сравнения с эталонной выгрузкой'
      : 'по оценке на основании косвенных признаков';
    add(
      points,
      `Доработки затрагивают ${(share * 100).toFixed(1)}% объектов`,
      `Затронуто объектов: ${modifications.modifiedCount} из ${parsed.totals.objects} (${confidenceNote}). ` +
      'Каждый изменённый типовой объект требует ручного анализа при обновлении.',
    );
  }

  if (modifications.addedCount > 0) {
    const points = Math.min(FACTORS.customObjects, modifications.addedCount * 0.15);
    add(
      points,
      `Добавлено собственных объектов: ${modifications.addedCount}`,
      'Собственные объекты не конфликтуют с обновлением напрямую, но требуют проверки ' +
      'совместимости с новыми версиями типовых механизмов.',
    );
  }

  if (modifications.removedCount > 0) {
    const points = Math.min(FACTORS.removedVendorObjects, modifications.removedCount * 0.5);
    add(
      points,
      `Удалено объектов поставщика: ${modifications.removedCount}`,
      'Объекты, присутствующие у поставщика, но отсутствующие в базе. При обновлении ' +
      'каждый из них потребует отдельного решения: механизм обновления попытается их ' +
      'вернуть, а типовой код может обращаться к ним по ссылке. ' +
      'Проверить код таких объектов невозможно — в конфигурации его нет.',
    );
  }

  // --- Расширения ---
  const impact = modifications.extensionImpact;
  if (impact.insteadAnnotations > 0) {
    const points = Math.min(FACTORS.extensionsInstead, impact.insteadAnnotations * 2.5);
    add(
      points,
      `Расширения подменяют типовые методы: ${impact.insteadAnnotations} аннотаций &Вместо`,
      'Аннотация &Вместо полностью заменяет типовой метод. При обновлении типовой конфигурации ' +
      'изменения внутри заменённого метода будут потеряны, а расширение может перестать работать ' +
      'без явных сообщений об ошибке.',
    );
  }
  if (impact.adoptedObjects > 0) {
    const points = Math.min(FACTORS.extensionsAdopted, impact.adoptedObjects * 0.25);
    add(
      points,
      `Расширения заимствуют типовые объекты: ${impact.adoptedObjects}`,
      'Заимствованные объекты требуют проверки после каждого обновления типовой конфигурации: ' +
      'при изменении структуры объекта расширение может не примениться.',
    );
  }
  if (extensions.length > 3) {
    add(
      Math.min(FACTORS.extensionCount, (extensions.length - 3) * 2),
      `Большое число расширений: ${extensions.length}`,
      'Каждое расширение — отдельная точка отказа при обновлении. Их взаимное влияние ' +
      'платформой не контролируется.',
    );
  }

  // --- Изменения проведения документов ---
  const postingFindings = countPostingRelatedFindings(codeAnalysis);
  if (postingFindings > 0) {
    add(
      Math.min(FACTORS.postingChanges, postingFindings * 1.5),
      `Признаки изменения логики проведения документов: ${postingFindings}`,
      'Модули проведения — наиболее конфликтная часть при обновлении: они часто меняются ' +
      'и вендором, и интегратором одновременно.',
    );
  }

  // --- Качество кода как фактор риска обновления ---
  const critical = codeAnalysis.summary.bySeverity.critical || 0;
  if (critical > 0) {
    add(
      Math.min(FACTORS.criticalFindings, critical * 0.5),
      `Критичных замечаний к коду: ${critical}`,
      'Критичные дефекты в доработках повышают вероятность того, что обновление ' +
      'выявит скрытые проблемы и потребует дополнительной отладки.',
    );
  }

  // --- Архитектурные факторы ---
  if (modifications.typical.matched && modifications.typical.bspBased && !modifications.bsp.detected) {
    add(
      FACTORS.bspAbsent,
      'Не обнаружены признаки Библиотеки стандартных подсистем',
      'Для решения, которое должно быть построено на БСП, отсутствие её механизмов ' +
      'указывает на глубокую переработку или устаревшую версию.',
    );
  }

  const compat = parsed.configuration.compatibilityMode;
  if (compat && compat !== 'DontUse') {
    add(
      FACTORS.compatibilityMode,
      `Включён режим совместимости: ${humanCompat(compat)}`,
      'Режим совместимости ограничивает доступные возможности платформы и обычно означает, ' +
      'что конфигурация не адаптирована под актуальную версию.',
    );
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const level = levelFromScore(score);

  return {
    score,
    level,
    levelRu: levelRu(level),
    reasons: reasons.sort((a, b) => b.points - a.points),
    updateEffort: updateEffortDescription(level),
    confidence: modifications.confidence,
  };
}

/**
 * Ищет признаки вмешательства в проведение документов.
 * Замечания в модулях объекта и менеджера документа означают, что код проведения
 * и формирования движений дорабатывался — а это самая конфликтная зона обновления.
 */
function countPostingRelatedFindings(codeAnalysis) {
  let count = 0;
  for (const finding of codeAnalysis.findings) {
    if (finding.ownerKind !== 'Document') continue;
    if (finding.moduleType === 'object' || finding.moduleType === 'manager') count += 1;
  }
  return count;
}

function levelFromScore(score) {
  if (score >= 80) return 'low';
  if (score >= 55) return 'medium';
  if (score >= 30) return 'high';
  return 'critical';
}

function levelRu(level) {
  return {
    low: 'Низкий риск',
    medium: 'Средний риск',
    high: 'Высокий риск',
    critical: 'Критический риск',
  }[level] || 'Не определён';
}

/** Текстовое описание того, что означает уровень для планирования работ. */
function updateEffortDescription(level) {
  switch (level) {
    case 'low':
      return 'Обновление выполняется штатно, в основном автоматически. ' +
        'Требуется тестирование доработанных участков.';
    case 'medium':
      return 'Обновление требует анализа: часть объектов придётся объединять вручную. ' +
        'Необходимы регламент тестирования и резервная копия.';
    case 'high':
      return 'Обновление требует значительной ручной работы по сравнению и объединению, ' +
        'полного регрессионного тестирования и планирования простоя.';
    case 'critical':
      return 'Обновление сопоставимо по трудоёмкости с повторным внедрением. ' +
        'Рекомендуется отдельный проект с этапом реархитектуры доработок.';
    default:
      return '';
  }
}

function humanCompat(value) {
  const m = /Version(\d+)_(\d+)_(\d+)/.exec(value || '');
  return m ? `8.${m[2]}.${m[3]}` : value;
}

/**
 * Общая оценка «здоровья» базы 0–100 — агрегат по всем осям.
 * Используется на титульном листе отчёта.
 */
export function scoreHealth({ updatability, codeAnalysis, parsed, dataVolume }) {
  const weights = { updatability: 0.35, code: 0.35, architecture: 0.2, data: 0.1 };

  const codeScore = scoreCodeQuality(codeAnalysis, parsed);
  const archScore = scoreArchitecture(codeAnalysis, parsed);
  const dataScore = dataVolume?.available ? scoreDataHealth(dataVolume) : 70;

  const total = Math.round(
    updatability.score * weights.updatability +
    codeScore * weights.code +
    archScore * weights.architecture +
    dataScore * weights.data,
  );

  return {
    health: Math.max(0, Math.min(100, total)),
    components: {
      updatability: updatability.score,
      code: codeScore,
      architecture: archScore,
      data: dataScore,
    },
  };
}

/** Качество кода: плотность находок на 1000 строк с учётом критичности. */
export function scoreCodeQuality(codeAnalysis, parsed) {
  const kloc = Math.max(1, codeAnalysis.metrics.codeLines / 1000);
  const s = codeAnalysis.summary.bySeverity;
  const weighted =
    (s.critical || 0) * 10 +
    (s.high || 0) * 4 +
    (s.medium || 0) * 1.5 +
    (s.low || 0) * 0.4;
  const density = weighted / kloc;

  // 0 находок → 100 баллов; плотность 40 взвешенных находок на 1000 строк → 0.
  const score = Math.round(100 - Math.min(100, density * 2.5));
  void parsed;
  return Math.max(0, score);
}

/** Архитектура: доля кода в формах, дубли, гигантские модули. */
export function scoreArchitecture(codeAnalysis, parsed) {
  let score = 100;
  const metrics = codeAnalysis.metrics;

  const formLines = metrics.byModuleType.form?.codeLines || 0;
  const totalLines = Math.max(1, metrics.codeLines);
  const formShare = formLines / totalLines;
  // Норма — до 25% кода в формах; выше начинается размывание слоёв.
  if (formShare > 0.25) score -= Math.min(30, (formShare - 0.25) * 120);

  const duplicates = codeAnalysis.findings.filter((f) => f.ruleId === 'arch.duplicate-code').length;
  score -= Math.min(25, duplicates * 1.5);

  const bigProcedures = codeAnalysis.findings.filter((f) => f.ruleId === 'arch.big-procedure').length;
  score -= Math.min(20, bigProcedures * 0.4);

  const complexity = codeAnalysis.findings.filter((f) => f.ruleId === 'arch.high-complexity').length;
  score -= Math.min(15, complexity * 0.6);

  void parsed;
  return Math.max(0, Math.round(score));
}

/** Здоровье данных: перекос объёмов, гигантские таблицы. */
export function scoreDataHealth(dataVolume) {
  let score = 100;
  for (const risk of dataVolume.risks || []) {
    if (risk.severity === 'high') score -= 15;
    else if (risk.severity === 'medium') score -= 7;
    else score -= 2;
  }
  return Math.max(0, Math.round(score));
}
