/**
 * Правила анализа производительности.
 *
 * Приоритет отдан проблемам, которые в реальных внедрениях 1С дают наибольший
 * эффект: неоптимальные запросы, отборы, не использующие индексы, накопление
 * строк конкатенацией.
 *
 * ## Чего здесь намеренно нет
 *
 * **«Обращение к базе данных внутри цикла» и «Текст запроса формируется
 * внутри цикла» исключены по требованию пользователя: проблемой они
 * не являются.** Оба правила срабатывали статически — по факту вызова внутри
 * `Цикл`, — и на реальной ERP давали сотни замечаний там, где цикл выполняется
 * по двум-трём элементам или запрос строится один раз перед выборкой.
 * Отличить дорогой случай от безобидного статическим анализом нечем: нужны
 * число итераций и планы запросов, а их даёт только замер на живых данных.
 * Не восстанавливать без отдельной просьбы.
 */

import { TOKEN } from '../bsl/lexer.js';
import { findEnclosingLoop } from '../bsl/structure.js';
import { analyzeQueryText, findNonIndexableFilters } from '../bsl/query.js';
import { SEVERITY, CATEGORY, snippetAt } from './context.js';

export const id = 'performance';

/** @param {ReturnType<import('./context.js').createRuleContext>} ctx */
export function run(ctx) {
  detectStringConcatInLoop(ctx);
  analyzeQueries(ctx);
}

/** Конкатенация строк в цикле — квадратичное потребление памяти. */
function detectStringConcatInLoop(ctx) {
  const { tokens, structure, source } = ctx;
  if (!structure.loops.length) return;

  for (let i = 1; i < tokens.length - 2; i += 1) {
    const eq = tokens[i];
    if (eq.type !== TOKEN.OPERATOR || eq.value !== '=') continue;
    const target = tokens[i - 1];
    if (target?.type !== TOKEN.IDENT) continue;

    // Шаблон: Перем = Перем + <строка>
    const next = tokens[i + 1];
    const plus = tokens[i + 2];
    if (next?.type !== TOKEN.IDENT) continue;
    if (next.value.toLowerCase() !== target.value.toLowerCase()) continue;
    if (plus?.type !== TOKEN.OPERATOR || plus.value !== '+') continue;

    const loop = findEnclosingLoop(structure.loops, i);
    if (!loop) continue;

    ctx.report({
      ruleId: 'perf.string-concat-in-loop',
      title: 'Накопление строки конкатенацией внутри цикла',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.PERFORMANCE,
      line: eq.line,
      detail:
        `Переменная «${target.value}» наращивается конкатенацией на каждой итерации. ` +
        'В 1С строки неизменяемы, поэтому расход памяти и времени растёт квадратично от числа итераций.',
      recommendation:
        'Используйте объект СтроковыйБуфер (8.3.24+) либо накапливайте фрагменты в массиве ' +
        'и объединяйте один раз через СтрСоединить().',
      snippet: snippetAt(source, eq.line),
    });
  }
}

/** Разбор текстов запросов: соединения, подзапросы, отборы. */
function analyzeQueries(ctx) {
  const { queries, source } = ctx;

  for (const query of queries) {
    const metrics = analyzeQueryText(query.text);

    if (metrics.joins >= 4) {
      ctx.report({
        ruleId: 'perf.query-many-joins',
        title: `Запрос с большим количеством соединений (${metrics.joins})`,
        severity: metrics.joins >= 7 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line,
        detail:
          `В запросе ${metrics.joins} соединений и ${metrics.tableCount} таблиц. ` +
          'Оптимизатор СУБД на таких запросах часто выбирает неоптимальный план, ' +
          'а при росте данных время выполнения растёт нелинейно.',
        recommendation:
          'Разбейте запрос на этапы через временные таблицы (ПОМЕСТИТЬ), ' +
          'проиндексируйте временные таблицы по полям соединения (ИНДЕКСИРОВАТЬ ПО) ' +
          'и уберите соединения, результат которых не используется.',
        snippet: firstLines(query.text, 6),
      });
    }

    if (metrics.subQueries >= 3) {
      ctx.report({
        ruleId: 'perf.query-nested-subqueries',
        title: `Запрос с вложенными подзапросами (${metrics.subQueries})`,
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line,
        detail: `Обнаружено ${metrics.subQueries} подзапросов. Соединение с подзапросом не может быть оптимизировано индексами.`,
        recommendation: 'Замените подзапросы временными таблицами с индексами по полям соединения.',
        snippet: firstLines(query.text, 6),
      });
    }

    if (!metrics.hasWhere && !metrics.hasTop && metrics.virtualTables === 0 && metrics.tableCount > 0) {
      ctx.report({
        ruleId: 'perf.query-no-filter',
        title: 'Запрос без условия отбора',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line,
        detail:
          `Запрос к таблицам (${metrics.tables.slice(0, 3).join(', ')}) не содержит ни ГДЕ, ни ПЕРВЫЕ. ` +
          'На больших таблицах это приводит к полному сканированию.',
        recommendation:
          'Добавьте условие отбора по индексируемым полям либо ограничьте выборку конструкцией ПЕРВЫЕ N.',
        snippet: firstLines(query.text, 6),
      });
    }

    for (const issue of findNonIndexableFilters(query.text)) {
      ctx.report({
        ruleId: `perf.query-${issue.kind}`,
        title: 'Условие отбора не использует индекс',
        severity: SEVERITY.HIGH,
        category: CATEGORY.PERFORMANCE,
        line: query.line,
        detail: issue.detail,
        recommendation:
          'Перепишите условие так, чтобы отбор выполнялся по полю таблицы напрямую: ' +
          'вынесите значение в параметр запроса, добавьте нужный реквизит в индексируемое поле ' +
          'или подготовьте данные во временной таблице.',
        snippet: firstLines(query.text, 6),
      });
    }

    if (metrics.hasInHierarchy) {
      ctx.report({
        ruleId: 'perf.query-in-hierarchy',
        title: 'Использование «В ИЕРАРХИИ»',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line,
        detail:
          'Условие «В ИЕРАРХИИ» разворачивается СУБД в рекурсивный обход дерева и на глубоких ' +
          'иерархиях выполняется значительно медленнее обычного отбора.',
        recommendation:
          'Если иерархия используется часто, храните признак принадлежности группе в отдельном ' +
          'индексируемом реквизите или регистре сведений и отбирайте по нему.',
        snippet: firstLines(query.text, 6),
      });
    }

    if (metrics.hasAutoOrder) {
      ctx.report({
        ruleId: 'perf.query-autoorder',
        title: 'Использование АВТОУПОРЯДОЧИВАНИЕ',
        severity: SEVERITY.LOW,
        category: CATEGORY.PERFORMANCE,
        line: query.line,
        detail: 'АВТОУПОРЯДОЧИВАНИЕ добавляет неявную сортировку по представлению ссылки, что требует соединения со справочником.',
        recommendation: 'Задайте явный порядок через УПОРЯДОЧИТЬ ПО по индексируемым полям.',
        snippet: firstLines(query.text, 6),
      });
    }
  }
}

function firstLines(text, n) {
  return text.split('\n').slice(0, n).join('\n').slice(0, 400);
}
