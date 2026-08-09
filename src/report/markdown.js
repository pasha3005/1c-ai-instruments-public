/**
 * Генератор Markdown-отчёта.
 *
 * Markdown удобен для включения в системы документации франчайзи (Confluence,
 * Notion, Git) и для дальнейшей автоматической обработки.
 */

import { SEVERITY_RU, CATEGORY_RU } from '../analyze/rules/context.js';
import { formatNumber } from '../analyze/dataVolume.js';
import { APP } from '../config.js';

/**
 * @param {object} result
 * @param {object} recommendations
 * @returns {string}
 */
export function renderMarkdownReport(result, recommendations) {
  const cfg = result.configuration;
  const out = [];
  const p = (...lines) => out.push(...lines);

  // --- Титул ---
  p(`# Аудит информационной базы 1С`);
  p('');
  p(`**${cfg.synonym || cfg.name || 'Информационная база'}**${cfg.version ? ` ${cfg.version}` : ''}`);
  p('');
  p('| Параметр | Значение |');
  p('| --- | --- |');
  p(`| Конфигурация | ${cfg.synonym || cfg.name || '—'} |`);
  p(`| Версия | ${cfg.version || 'не указана'} |`);
  p(`| Поставщик | ${cfg.vendor || 'не указан'} |`);
  p(`| Информационная база | ${result.infobase?.display || '—'} |`);
  p(`| Платформа | ${result.input?.platformVersion || '—'} |`);
  p(`| Объектов метаданных | ${formatNumber(result.metadata.totals.objects)} |`);
  p(`| Дата обследования | ${formatDate(result.generatedAt)} |`);
  p('');

  // --- 1. Общая оценка ---
  p('## 1. Общая оценка состояния базы');
  p('');
  p('| Показатель | Оценка |');
  p('| --- | --- |');
  p(`| Общее состояние | **${result.scores.health} / 100** |`);
  p(`| Обновляемость | ${result.scores.updatability} / 100 (${result.updatability.levelRu}) |`);
  p(`| Качество кода | ${result.scores.code} / 100 |`);
  p(`| Архитектура | ${result.scores.architecture} / 100 |`);
  p('');
  const sev = result.code.summary.bySeverity;
  p(`Всего замечаний: **${result.code.summary.total}** — ` +
    `критичных ${sev.critical || 0}, высоких ${sev.high || 0}, ` +
    `средних ${sev.medium || 0}, низких ${sev.low || 0}.`);
  p('');

  // --- 2. Архитектура ---
  p('## 2. Архитектурное состояние');
  p('');
  p('### Состав объектов метаданных');
  p('');
  p('| Вид объекта | Количество |');
  p('| --- | ---: |');
  for (const k of result.metadata.kindStats.slice(0, 22)) {
    p(`| ${k.ru} | ${formatNumber(k.count)} |`);
  }
  p('');
  p('### Метрики кода');
  p('');
  p(`- Модулей: ${formatNumber(result.code.metrics.modules)}`);
  p(`- Строк кода: ${formatNumber(result.code.metrics.codeLines)}`);
  p(`- Процедур и функций: ${formatNumber(result.code.metrics.routines)} (экспортных: ${formatNumber(result.code.metrics.exportRoutines)})`);
  p(`- Запросов в коде: ${formatNumber(result.code.metrics.queries)}`);
  p(`- Самый большой модуль: ${result.code.metrics.maxModule.title || '—'} (${formatNumber(result.code.metrics.maxModule.codeLines)} строк)`);
  p('');

  // --- 3. Технические риски ---
  p('## 3. Технические риски');
  p('');
  p('| Замечание | Категория | Критичность | Случаев |');
  p('| --- | --- | --- | ---: |');
  for (const r of result.code.summary.topRules.slice(0, 20)) {
    p(`| ${escapePipes(r.title)} | ${CATEGORY_RU[r.category] || r.category} | ${SEVERITY_RU[r.severity]} | ${r.count} |`);
  }
  p('');

  // --- 4. Производительность ---
  const perf = result.findings.filter((f) => f.category === 'performance');
  p('## 4. Проблемы производительности');
  p('');
  if (!perf.length) {
    p('Проблем производительности не выявлено.');
  } else {
    p(`Выявлено ${perf.length} замечаний. Наиболее значимые:`);
    p('');
    for (const f of perf.slice(0, 12)) {
      p(`#### ${f.title}`);
      p('');
      p(`- **Где:** ${f.moduleTitle || ''}${f.line ? `, строка ${f.line}` : ''}`);
      p(`- **Критичность:** ${SEVERITY_RU[f.severity]}`);
      if (f.detail) p(`- **Суть:** ${f.detail}`);
      if (f.recommendation) p(`- **Рекомендация:** ${f.recommendation}`);
      p('');
    }
  }
  p('');

  // --- 5. Доработки ---
  const m = result.modifications;
  p('## 5. Анализ доработок');
  p('');
  p(`- Типовое решение: ${m.typical.matched ? m.typical.title : 'не опознано'}`);
  p(`- На поддержке: ${m.isOnSupport ? 'да' : '**нет**'}`);
  p(`- Уровень доработок: ${m.levelDescription}`);
  p(`- Достоверность оценки: ${confidenceRu(m.confidence)}`);
  p(`- Затронуто объектов: ${formatNumber(m.modifiedCount)} из ${formatNumber(result.metadata.totals.objects)} (${(m.modificationShare * 100).toFixed(1)}%)`);
  p(`  - изменено: ${formatNumber(m.changedCount || 0)}, добавлено: ${formatNumber(m.addedCount || 0)}, удалено объектов поставщика: ${formatNumber(m.removedCount || 0)}`);
  if (m.removedObjects?.length) {
    p(`  - удалены: ${m.removedObjects.slice(0, 30).join(', ')}${m.removedCount > 30 ? ` и ещё ${m.removedCount - 30}` : ''}`);
  }
  p('');
  if (m.note) {
    p(`> ${m.note}`);
    p('');
  }

  p('### Расширения конфигурации');
  p('');
  if (!result.extensions.count) {
    p('Расширения не используются.');
  } else {
    p('| Расширение | Назначение | Объектов | Заимствовано | &Вместо | Риск |');
    p('| --- | --- | ---: | ---: | ---: | --- |');
    for (const e of result.extensions.items) {
      p(`| ${escapePipes(e.synonym || e.name)} | ${e.purposeRu} | ${e.objectCount} | ${e.adoptedCount} | ${e.annotations?.instead || 0} | ${riskRu(e.risk)} |`);
    }
  }
  p('');

  // --- 6. Обновляемость ---
  p('## 6. Анализ обновляемости');
  p('');
  p(`**Оценка: ${result.updatability.score} / 100 — ${result.updatability.levelRu}**`);
  p('');
  p(result.updatability.updateEffort);
  p('');
  if (result.updatability.reasons.length) {
    p('| Штраф | Фактор | Пояснение |');
    p('| ---: | --- | --- |');
    for (const r of result.updatability.reasons) {
      p(`| −${r.points} | ${escapePipes(r.title)} | ${escapePipes(r.detail)} |`);
    }
    p('');
  }

  // --- 7. Данные ---
  p('## 7. Анализ данных');
  p('');
  if (!result.dataVolume.available) {
    p(`Сбор данных из базы не выполнялся: ${result.dataVolume.reason}.`);
  } else {
    const d = result.dataVolume;
    p(`- Размер файла базы: ${d.databaseSizeHuman || 'не определён'}`);
    p(`- Записей всего: ${formatNumber(d.totalRecords)}`);
    p(`- Объектов с данными: ${(d.allCounts || []).filter((c) => c.count > 0).length} из ${d.countedObjects}`);
    p('');

    p('### Объёмы по видам объектов');
    p('');
    p('| Вид объекта | Объектов | Записей | Доля |');
    p('| --- | ---: | ---: | ---: |');
    for (const k of d.byKind) {
      const share = d.totalRecords ? ((k.records / d.totalRecords) * 100).toFixed(1) : '0.0';
      p(`| ${k.kindRu} | ${formatNumber(k.objects)} | ${formatNumber(k.records)} | ${share}% |`);
    }
    p(`| **Итого** | **${formatNumber(d.byKind.reduce((s, k) => s + k.objects, 0))}** | **${formatNumber(d.totalRecords)}** | |`);
    p('');

    p('### Количество записей по всем объектам');
    p('');
    p('Все объекты, содержащие данные, по убыванию количества записей.');
    p('');
    p('| № | Объект | Вид | Записей | Доля | Накопительно |');
    p('| ---: | --- | --- | ---: | ---: | ---: |');
    const rows = (d.allCounts || []).filter((c) => c.count > 0);
    let cumulative = 0;
    rows.slice(0, 1500).forEach((c, i) => {
      cumulative += c.count;
      const share = d.totalRecords ? ((c.count / d.totalRecords) * 100).toFixed(2) : '0.00';
      const cum = d.totalRecords ? ((cumulative / d.totalRecords) * 100).toFixed(1) : '0.0';
      p(`| ${i + 1} | ${escapePipes(c.synonym || c.name)} (\`${escapePipes(c.fullName)}\`) | ${c.kindRu} | ${formatNumber(c.count)} | ${share}% | ${cum}% |`);
    });
    if (rows.length > 1500) p(`| … | _и ещё ${rows.length - 1500} объектов_ | | | | |`);
    p('');

    if (d.emptyObjects?.length) {
      p(`### Объекты без данных (${d.emptyObjects.length})`);
      p('');
      p('Существуют в конфигурации, но не содержат ни одной записи — функциональность не используется.');
      p('');
      const grouped = new Map();
      for (const obj of d.emptyObjects) {
        if (!grouped.has(obj.kindRu)) grouped.set(obj.kindRu, []);
        grouped.get(obj.kindRu).push(obj);
      }
      p('| Вид объекта | Объектов | Объекты |');
      p('| --- | ---: | --- |');
      for (const [kindRu, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const names = items.slice(0, 25).map((o) => o.synonym || o.name).join(', ');
        p(`| ${kindRu} | ${items.length} | ${escapePipes(names)}${items.length > 25 ? ` и ещё ${items.length - 25}` : ''} |`);
      }
      p('');
    }

    if (d.insights?.length) {
      p('### Выводы по составу данных');
      p('');
      for (const insight of d.insights) {
        p(`**${insight.title}.** ${insight.detail}`);
        p('');
      }
    }
  }
  p('');
  if (result.dataVolume.risks?.length) {
    p('### Риски роста данных');
    p('');
    for (const r of result.dataVolume.risks.slice(0, 12)) {
      p(`- **${r.title}** (${SEVERITY_RU[r.severity] || r.severity}). ${r.detail} _Рекомендация:_ ${r.recommendation}`);
    }
    p('');
  }

  // --- 8. Безопасность ---
  p('## 8. Безопасность и права доступа');
  p('');
  p(`- Ролей: ${result.roles.count}, с правом администрирования: ${result.roles.fullAccessCount}`);
  p(`- Ограничений RLS: ${result.roles.totalRestrictions || 'не используются'}`);
  p(`- Замечаний по безопасности в коде: ${result.security.findingsCount}`);
  p('');
  for (const o of result.security.observations || []) {
    p(`- **${o.title}.** ${o.detail} _Рекомендация:_ ${o.recommendation}`);
  }
  p('');

  // --- 9. Рекомендации ---
  p('## 9. Рекомендации');
  p('');
  p('### Для руководителя');
  p('');
  p(recommendations.manager);
  p('');
  p('### Для технического архитектора');
  p('');
  p(recommendations.architect);
  p('');

  // --- 10. План ---
  p('## 10. План улучшений');
  p('');
  for (const stage of result.plan) {
    p(`### ${stage.title}`);
    p('');
    p(`**Цель:** ${stage.goal}`);
    if (stage.durationWeeks) p(`**Длительность:** ≈ ${stage.durationWeeks} нед.`);
    p('');
    for (const item of stage.items) p(`- ${item}`);
    p('');
    p(`**Ожидаемый эффект:** ${stage.effect}`);
    p('');
  }

  // --- 11. Трудозатраты ---
  const e = result.effort;
  p('## 11. Оценка трудозатрат');
  p('');
  p('| Сценарий | Часов |');
  p('| --- | ---: |');
  p(`| Оптимистично | ${formatNumber(e.total.optimistic)} |`);
  p(`| **Базовая оценка** | **${formatNumber(e.total.hours)}** |`);
  p(`| Пессимистично | ${formatNumber(e.total.pessimistic)} |`);
  p('');
  p('### Структура');
  p('');
  p('| Направление | Замечаний | Часов |');
  p('| --- | ---: | ---: |');
  for (const c of e.byCategory) {
    p(`| ${CATEGORY_RU[c.category] || (c.category === 'data' ? 'Работы по данным' : c.category)} | ${c.findings} | ${c.hours} |`);
  }
  p(`| Накладные (анализ, тестирование, документирование, управление) | | ${e.remediation.overheadHours} |`);
  p(`| ${e.update.scenario} | | ${e.update.hours} |`);
  p(`| **ИТОГО** | | **${e.total.hours}** |`);
  p('');
  if (e.budget) {
    p(`Бюджет при ставке ${formatNumber(e.budget.hourlyRate)} ₽/час: ` +
      `**${formatNumber(e.budget.base)} ₽** ` +
      `(${formatNumber(e.budget.optimistic)} — ${formatNumber(e.budget.pessimistic)} ₽).`);
    p('');
  }
  p(`> ${e.breakdownNote}`);
  p('');

  // --- Приложение ---
  p('## Приложение. Детальный перечень замечаний');
  p('');
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  const bySeverity = {};
  for (const f of result.findings) (bySeverity[f.severity] ||= []).push(f);

  for (const s of order) {
    const list = bySeverity[s];
    if (!list?.length) continue;
    p(`### ${SEVERITY_RU[s]} — ${list.length}`);
    p('');
    for (const f of list.slice(0, 80)) {
      p(`- **${f.title}** — ${f.moduleTitle || ''}${f.line ? `, строка ${f.line}` : ''}`);
      if (f.detail) p(`  ${f.detail}`);
      if (f.recommendation) p(`  _Рекомендация:_ ${f.recommendation}`);
    }
    if (list.length > 80) p(`- …и ещё ${list.length - 80}`);
    p('');
  }

  p('---');
  p('');
  p(`Отчёт сформирован системой «${APP.name}» v${APP.version} ${formatDate(result.generatedAt)}.`);

  return out.join('\n');
}

function escapePipes(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function riskRu(risk) {
  return { high: 'Высокий', medium: 'Средний', low: 'Низкий' }[risk] || 'не определён';
}

function confidenceRu(confidence) {
  return {
    exact: 'точная (сравнение с эталоном)',
    estimated: 'оценочная (косвенные признаки)',
    unknown: 'низкая (конфигурация не опознана)',
  }[confidence] || 'не определена';
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}
