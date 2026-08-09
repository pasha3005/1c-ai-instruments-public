/**
 * Промпты для формирования разделов отчёта.
 *
 * Принцип: LLM не придумывает факты. На вход подаётся уже посчитанная сводка,
 * задача модели — изложить её языком, понятным конкретному адресату
 * (руководителю или архитектору), и расставить приоритеты.
 */

export const SYSTEM_ARCHITECT = `Ты — ведущий технический архитектор 1С с 15-летним опытом обследования и оптимизации баз 1С:Предприятие 8.

Ты пишешь разделы отчёта об аудите информационной базы для компании-франчайзи 1С.

Жёсткие правила:
1. Используй ТОЛЬКО факты из предоставленных данных. Не выдумывай числа, имена объектов, версии.
2. Если данных для вывода недостаточно — прямо скажи об этом.
3. Пиши по-русски, профессионально, без маркетинговых оборотов и воды.
4. Никаких обращений к читателю вроде «давайте рассмотрим». Только содержание.
5. Не повторяй исходные цифры списком — интерпретируй их.
6. Формат ответа — Markdown без заголовка первого уровня.`;

export const SYSTEM_MANAGER = `Ты — руководитель проектов внедрения 1С, который объясняет результаты технического аудита руководителю компании-заказчика.

Жёсткие правила:
1. Используй ТОЛЬКО факты из предоставленных данных. Не выдумывай числа.
2. Пиши на языке бизнеса: риски, деньги, сроки, последствия бездействия.
3. Никакого технического жаргона без пояснения. Вместо «цикломатическая сложность» — «код, который трудно менять без ошибок».
4. По-русски, кратко, по делу.
5. Формат ответа — Markdown без заголовка первого уровня.`;

/** Компактная выжимка результата анализа для передачи модели. */
export function buildFactsDigest(result) {
  const cfg = result.configuration;
  const code = result.code;
  const sev = code.summary.bySeverity;

  const lines = [];

  lines.push('## Конфигурация');
  lines.push(`- Название: ${cfg.synonym || cfg.name || 'не указано'}`);
  lines.push(`- Версия: ${cfg.version || 'не указана'}`);
  lines.push(`- Поставщик: ${cfg.vendor || 'не указан'}`);
  lines.push(`- На поддержке: ${cfg.isOnSupport ? 'да' : 'нет'}`);
  lines.push(`- Опознано как типовое решение: ${cfg.typicalSolution?.title || 'нет'}`);
  lines.push(`- Признаки БСП: ${cfg.bsp?.detected ? 'обнаружены' : 'не обнаружены'}`);
  lines.push(`- Режим совместимости: ${cfg.compatibilityMode || 'не задан'}`);

  lines.push('');
  lines.push('## Объём метаданных');
  lines.push(`- Всего объектов: ${result.metadata.totals.objects}`);
  for (const stat of result.metadata.kindStats.slice(0, 12)) {
    lines.push(`- ${stat.ru}: ${stat.count}`);
  }

  lines.push('');
  lines.push('## Код');
  lines.push(`- Модулей: ${code.metrics.modules}, строк кода: ${code.metrics.codeLines}`);
  lines.push(`- Процедур и функций: ${code.metrics.routines}, из них экспортных: ${code.metrics.exportRoutines}`);
  lines.push(`- Запросов в коде: ${code.metrics.queries}`);
  lines.push(`- Самый большой модуль: ${code.metrics.maxModule.title} (${code.metrics.maxModule.codeLines} строк)`);

  lines.push('');
  lines.push('## Замечания по коду');
  lines.push(`- Всего: ${code.summary.total}`);
  lines.push(`- Критичных: ${sev.critical || 0}, высоких: ${sev.high || 0}, средних: ${sev.medium || 0}, низких: ${sev.low || 0}`);
  lines.push('- Наиболее частые:');
  for (const rule of code.summary.topRules.slice(0, 12)) {
    lines.push(`  - ${rule.title} — ${rule.count} случаев (критичность: ${rule.severity})`);
  }

  lines.push('');
  lines.push('## Доработки');
  lines.push(`- Уровень: ${result.modifications.levelDescription}`);
  lines.push(`- Достоверность оценки: ${confidenceRu(result.modifications.confidence)}`);
  lines.push(`- Затронуто объектов: ${result.modifications.modifiedCount}`);
  lines.push(`- Добавлено собственных объектов: ${result.modifications.addedCount}`);

  lines.push('');
  lines.push('## Расширения');
  lines.push(`- Количество: ${result.extensions.count}`);
  lines.push(`- Заимствовано типовых объектов: ${result.extensions.impact.adoptedObjects}`);
  lines.push(`- Аннотаций &Вместо (подмена типовой логики): ${result.extensions.impact.insteadAnnotations}`);
  for (const ext of result.extensions.items.slice(0, 10)) {
    lines.push(`  - ${ext.name} (${ext.purposeRu}), объектов: ${ext.objectCount}, риск: ${ext.risk}`);
  }

  lines.push('');
  lines.push('## Обновляемость');
  lines.push(`- Оценка: ${result.updatability.score}/100 (${result.updatability.levelRu})`);
  lines.push('- Причины снижения:');
  for (const reason of result.updatability.reasons.slice(0, 8)) {
    lines.push(`  - −${reason.points}: ${reason.title}`);
  }

  lines.push('');
  lines.push('## Данные');
  if (result.dataVolume.available) {
    lines.push(`- Записей всего: ${result.dataVolume.totalRecords}`);
    lines.push(`- Размер базы: ${result.dataVolume.databaseSizeHuman || 'не определён'}`);
    lines.push('- Крупнейшие таблицы:');
    for (const t of result.dataVolume.topTables.slice(0, 10)) {
      lines.push(`  - ${t.kindRu} «${t.synonym || t.name}»: ${t.count} записей`);
    }
    lines.push('- Объёмы по видам объектов:');
    for (const k of result.dataVolume.byKind.slice(0, 10)) {
      lines.push(`  - ${k.kindRu}: ${k.objects} объектов, ${k.records} записей`);
    }
    lines.push(`- Объектов без данных: ${result.dataVolume.emptyObjects?.length || 0}`);
    if (result.dataVolume.insights?.length) {
      lines.push('- Выводы по составу данных:');
      for (const insight of result.dataVolume.insights) {
        lines.push(`  - ${insight.title}: ${insight.detail}`);
      }
    }
  } else {
    lines.push(`- Сбор данных не выполнен: ${result.dataVolume.reason}`);
  }

  lines.push('');
  lines.push('## Безопасность');
  lines.push(`- Ролей: ${result.roles.count}, с полным доступом: ${result.roles.fullAccessCount}`);
  lines.push(`- Ограничений RLS: ${result.roles.totalRestrictions}`);

  lines.push('');
  lines.push('## Оценки');
  lines.push(`- Общее состояние: ${result.scores.health}/100`);
  lines.push(`- Качество кода: ${result.scores.code}/100`);
  lines.push(`- Архитектура: ${result.scores.architecture}/100`);
  lines.push(`- Обновляемость: ${result.scores.updatability}/100`);

  lines.push('');
  lines.push('## Трудозатраты (расчёт инструмента)');
  lines.push(`- Устранение замечаний: ${result.effort.remediation.hours} ч`);
  lines.push(`- Обновление: ${result.effort.update.hours} ч`);
  lines.push(`- Итого: ${result.effort.total.hours} ч (диапазон ${result.effort.total.optimistic}–${result.effort.total.pessimistic} ч)`);

  return lines.join('\n');
}

function confidenceRu(confidence) {
  return {
    exact: 'точная (сравнение с эталонной выгрузкой)',
    estimated: 'оценочная (по косвенным признакам)',
    unknown: 'низкая (конфигурация не опознана)',
  }[confidence] || 'не определена';
}

export function managerPrompt(digest) {
  return `Ниже — результаты технического аудита информационной базы 1С.

${digest}

Составь раздел отчёта для руководителя компании-заказчика. Структура:

**Главное в двух абзацах** — общее состояние базы и что это значит для бизнеса.

**Ключевые риски** — 3–5 пунктов. Для каждого: в чём риск, к чему приведёт бездействие. Без технических терминов.

**Что даст исправление** — конкретные выгоды: скорость работы, снижение стоимости поддержки, возможность обновляться.

**Рекомендуемый порядок действий** — что делать в первую очередь и почему именно это.

**О бюджете** — интерпретация приведённой оценки трудозатрат: от чего зависит итоговая цифра, что может её изменить.`;
}

export function architectPrompt(digest) {
  return `Ниже — результаты технического аудита информационной базы 1С.

${digest}

Составь технический раздел отчёта для архитектора и разработчиков. Структура:

**Оценка архитектурного состояния** — что говорят цифры о качестве решения.

**Первоочередные технические задачи** — 5–8 пунктов с конкретикой: что менять, каким образом, какой ожидается эффект. Опирайся на приведённые типы замечаний.

**Риски при обновлении** — что именно сломается и где искать проблемы, исходя из состава доработок и расширений.

**Рекомендации по архитектуре** — как изменить подход, чтобы проблемы не воспроизводились.

Если каких-то данных не хватает для однозначного вывода — укажи, что нужно дополнительно обследовать.`;
}
