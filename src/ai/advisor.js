/**
 * Формирование рекомендаций.
 *
 * Два уровня:
 *   1. Детерминированный движок — работает всегда, строит связный текст из
 *      фактов анализа. Именно он обеспечивает воспроизводимость отчёта:
 *      одинаковые входные данные дают одинаковый вывод.
 *   2. LLM-обогащение — если задан ключ Claude API, поверх фактов формируются
 *      разделы «для руководителя» и «для архитектора» связным текстом.
 *
 * LLM не является источником фактов: все числа берутся из анализа.
 */

import { complete, isAvailable } from './client.js';
import { SYSTEM_ARCHITECT, SYSTEM_MANAGER, buildFactsDigest, managerPrompt, architectPrompt } from './prompts.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('advisor');

/**
 * @param {object} result результат runAnalysis
 * @param {{onProgress?: (text: string) => void}} [options]
 */
export async function buildRecommendations(result, options = {}) {
  const { onProgress } = options;

  const baseline = {
    manager: buildManagerSection(result),
    architect: buildArchitectSection(result),
    source: 'rules',
  };

  if (!(await isAvailable())) {
    log.info('Ключ Claude API не задан — используются детерминированные рекомендации');
    return { ...baseline, aiUsed: false, aiError: null };
  }

  const digest = buildFactsDigest(result);

  try {
    onProgress?.('Формирование раздела для руководителя');
    const manager = await complete({
      system: SYSTEM_MANAGER,
      prompt: managerPrompt(digest),
    });

    onProgress?.('Формирование технического раздела');
    const architect = await complete({
      system: SYSTEM_ARCHITECT,
      prompt: architectPrompt(digest),
    });

    return {
      manager: manager || baseline.manager,
      architect: architect || baseline.architect,
      source: 'ai',
      aiUsed: true,
      aiError: null,
      fallback: baseline,
    };
  } catch (err) {
    rethrowIfCancelled(err);
    log.warn(`AI-обогащение не выполнено: ${err.message}`);
    return { ...baseline, aiUsed: false, aiError: err.message };
  }
}

// --- Детерминированный движок -----------------------------------------------

/** Раздел для руководителя: бизнес-язык, риски, деньги. */
export function buildManagerSection(result) {
  const parts = [];
  const cfg = result.configuration;
  const health = result.scores.health;

  parts.push('### Главное');
  parts.push(
    `Обследована информационная база «${cfg.synonym || cfg.name || 'без названия'}»` +
    (cfg.version ? ` версии ${cfg.version}` : '') +
    `. Общее состояние оценено в ${health} из 100 баллов — ${healthVerdict(health)}.`,
  );
  parts.push(
    `В конфигурации ${result.metadata.totals.objects} объектов метаданных и ` +
    `${formatNumber(result.code.metrics.codeLines)} строк программного кода. ` +
    `Автоматическая проверка выявила ${result.code.summary.total} замечаний, ` +
    `из них требующих первоочередного внимания — ${criticalCount(result)}.`,
  );

  parts.push('');
  parts.push('### Ключевые риски');
  const risks = buildBusinessRisks(result);
  if (risks.length) {
    for (const risk of risks) parts.push(`- **${risk.title}.** ${risk.impact}`);
  } else {
    parts.push('- Существенных рисков не выявлено. База находится в хорошем состоянии.');
  }

  parts.push('');
  parts.push('### Что даст исправление');
  for (const benefit of buildBenefits(result)) parts.push(`- ${benefit}`);

  return parts.join('\n');
}

/** Раздел для архитектора: конкретика по объектам и механизмам. */
export function buildArchitectSection(result) {
  const parts = [];

  parts.push('### Оценка архитектурного состояния');
  parts.push(
    `Качество кода — ${result.scores.code}/100, архитектура — ${result.scores.architecture}/100, ` +
    `обновляемость — ${result.scores.updatability}/100.`,
  );

  const formShare = formCodeShare(result);
  if (formShare > 0.25) {
    parts.push(
      `В модулях форм сосредоточено ${Math.round(formShare * 100)}% всего кода — это указывает ` +
      'на смешение слоя представления и бизнес-логики. Такой код невозможно переиспользовать ' +
      'и он создаёт наибольшее число конфликтов при обновлении типовой конфигурации.',
    );
  }

  parts.push('');
  parts.push('### Первоочередные технические задачи');
  const tasks = buildTechnicalTasks(result);
  if (tasks.length) {
    tasks.forEach((task, i) => parts.push(`${i + 1}. **${task.title}** — ${task.action} ${task.effect}`));
  } else {
    parts.push('Критичных технических задач не выявлено.');
  }

  parts.push('');
  parts.push('### Риски при обновлении');
  parts.push(result.updatability.updateEffort);
  if (result.updatability.reasons.length) {
    parts.push('');
    parts.push('Что снижает обновляемость:');
    for (const reason of result.updatability.reasons.slice(0, 6)) {
      parts.push(`- **−${reason.points} баллов.** ${reason.title}. ${reason.detail}`);
    }
  }

  if (result.modifications.confidence !== 'exact' && result.modifications.note) {
    parts.push('');
    parts.push(`> ${result.modifications.note}`);
  }

  parts.push('');
  parts.push('### Рекомендации по архитектуре');
  for (const rec of buildArchitectureRecommendations(result)) parts.push(`- ${rec}`);

  return parts.join('\n');
}

function buildBusinessRisks(result) {
  const risks = [];
  const sev = result.code.summary.bySeverity;

  if ((sev.critical || 0) > 0) {
    risks.push({
      title: `Проблемы производительности (${sev.critical} критичных замечаний)`,
      impact:
        'Обнаружены обращения к базе данных внутри циклов — операции, время выполнения которых ' +
        'растёт вместе с объёмом данных. По мере накопления данных работа пользователей будет ' +
        'замедляться, вплоть до срыва сроков закрытия периода.',
    });
  }

  if (result.updatability.score < 55) {
    risks.push({
      title: `Затруднённое обновление (оценка ${result.updatability.score} из 100)`,
      impact:
        'Обновление типовой конфигурации требует значительной ручной работы. Это означает высокую ' +
        'стоимость каждого обновления и риск отставания от изменений законодательства.',
    });
  }

  if (result.security.criticalCount > 0) {
    risks.push({
      title: `Нарушения в разграничении доступа (${result.security.criticalCount})`,
      impact:
        'В коде есть участки, выполняющиеся в обход проверки прав. Сотрудник может получить доступ ' +
        'к данным, не предназначенным для его должности.',
    });
  }

  if (!result.security.rlsUsed && result.roles.count > 2) {
    risks.push({
      title: 'Данные не разграничены между подразделениями',
      impact:
        'Ограничения доступа на уровне записей не настроены: любой пользователь с правом чтения ' +
        'видит все документы и справочники целиком.',
    });
  }

  const highDataRisks = (result.dataVolume.risks || []).filter((r) => r.severity === 'high');
  if (highDataRisks.length) {
    risks.push({
      title: `Крупные таблицы без регламента обслуживания (${highDataRisks.length})`,
      impact:
        'Отдельные таблицы базы достигли объёмов, на которых операции без правильных индексов ' +
        'выполняются минутами. Требуется регламент обслуживания и, возможно, архивирование истории.',
    });
  }

  if (!result.configuration.isOnSupport) {
    risks.push({
      title: 'Конфигурация снята с поддержки поставщика',
      impact:
        'Штатное обновление невозможно. Каждое обновление придётся выполнять как отдельный проект ' +
        'со сравнением и объединением конфигураций вручную.',
    });
  }

  return risks.slice(0, 5);
}

function buildBenefits(result) {
  const benefits = [];
  const sev = result.code.summary.bySeverity;

  if ((sev.critical || 0) + (sev.high || 0) > 0) {
    benefits.push(
      'Ускорение массовых операций и проведения документов — за счёт устранения обращений ' +
      'к базе внутри циклов и оптимизации запросов.',
    );
  }
  if (result.updatability.score < 80) {
    benefits.push(
      'Возврат к штатному обновлению типовой конфигурации: обновления станут регулярными ' +
      'и предсказуемыми по стоимости.',
    );
  }
  if (result.code.findings.some((f) => f.ruleId === 'arch.duplicate-code')) {
    benefits.push(
      'Снижение стоимости доработок: устранение дублирования означает, что исправление вносится ' +
      'один раз, а не в каждой копии кода.',
    );
  }
  if (result.security.findingsCount > 0) {
    benefits.push('Снижение риска несанкционированного доступа к данным и утечки информации.');
  }
  if (!benefits.length) {
    benefits.push('Поддержание текущего уровня качества и предсказуемая стоимость сопровождения.');
  }
  return benefits;
}

function buildTechnicalTasks(result) {
  const tasks = [];
  const byRule = new Map();
  for (const f of result.code.findings) {
    if (!byRule.has(f.ruleId)) {
      byRule.set(f.ruleId, { ruleId: f.ruleId, title: f.title, severity: f.severity, count: 0, sample: f });
    }
    byRule.get(f.ruleId).count += 1;
  }

  const weight = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  const ranked = [...byRule.values()]
    .sort((a, b) => (weight[b.severity] * Math.log2(b.count + 1)) - (weight[a.severity] * Math.log2(a.count + 1)))
    .slice(0, 8);

  for (const rule of ranked) {
    tasks.push({
      title: `${stripCount(rule.title)} — ${rule.count} ${plural(rule.count, 'случай', 'случая', 'случаев')}`,
      action: rule.sample.recommendation || 'Требуется анализ и исправление.',
      effect: '',
    });
  }
  return tasks;
}

function buildArchitectureRecommendations(result) {
  const recs = [];

  if (formCodeShare(result) > 0.2) {
    recs.push(
      'Перенести бизнес-логику из модулей форм в общие модули и модули менеджеров. ' +
      'Форма должна отвечать только за представление.',
    );
  }
  if (result.extensions.impact.insteadAnnotations > 0) {
    recs.push(
      `Пересмотреть ${result.extensions.impact.insteadAnnotations} ${plural(result.extensions.impact.insteadAnnotations, 'аннотацию', 'аннотации', 'аннотаций')} &Вместо: ` +
      'заменить на &Перед/&После/&ИзменениеИКонтроль там, где это возможно. ' +
      '&Вместо блокирует получение исправлений вендора внутри заменённого метода.',
    );
  }
  if (result.modifications.addedCount > 0 && result.extensions.count === 0) {
    recs.push(
      'Рассмотреть перенос доработок из конфигурации в расширения: это вернёт возможность ' +
      'штатного обновления типового решения.',
    );
  }
  if (!result.configuration.bsp?.detected && result.configuration.typicalSolution?.bspBased) {
    recs.push(
      'Проверить актуальность версии Библиотеки стандартных подсистем: её механизмы ' +
      'не обнаружены в конфигурации, которая должна быть на ней построена.',
    );
  }
  if (result.configuration.compatibilityMode && result.configuration.compatibilityMode !== 'DontUse') {
    recs.push(
      `Спланировать снятие режима совместимости (${result.configuration.compatibilityMode}): ` +
      'он ограничивает доступ к возможностям актуальной платформы.',
    );
  }
  if (result.code.findings.some((f) => f.ruleId === 'std.deprecated-sync-call')) {
    recs.push(
      'Перевести синхронные диалоги на асинхронные вызовы — это обязательное условие ' +
      'работы в веб-клиенте и мобильном клиенте.',
    );
  }
  if (!recs.length) {
    recs.push('Архитектура решения не вызывает существенных замечаний. Поддерживать текущие практики.');
  }
  return recs;
}

// --- Вспомогательные функции ------------------------------------------------

function healthVerdict(score) {
  if (score >= 85) return 'состояние хорошее';
  if (score >= 70) return 'состояние удовлетворительное';
  if (score >= 50) return 'есть существенные проблемы';
  if (score >= 30) return 'состояние неудовлетворительное';
  return 'состояние критическое';
}

function criticalCount(result) {
  const sev = result.code.summary.bySeverity;
  return (sev.critical || 0) + (sev.high || 0);
}

function formCodeShare(result) {
  const total = result.code.metrics.codeLines || 1;
  const form = result.code.metrics.byModuleType?.form?.codeLines || 0;
  return form / total;
}

function stripCount(title) {
  return title.replace(/\s*\(\d+\)\s*$/, '').replace(/:\s*\d+\s*$/, '');
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(value));
}

export { plural, formatNumber };
