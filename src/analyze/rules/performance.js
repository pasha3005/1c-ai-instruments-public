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
import {
  analyzeQueryText, findNonIndexableFilters, queryPlace, queryPlaceOf, QUERY_PATTERNS,
} from '../bsl/query.js';
import { SEVERITY, CATEGORY, snippetAt } from './context.js';

export const id = 'performance';

/** @param {ReturnType<import('./context.js').createRuleContext>} ctx */
export function run(ctx) {
  detectStringConcatInLoop(ctx);
  analyzeQueries(ctx);
}

/**
 * Слова, по которым переменную видно как строковую, и слова, по которым видно
 * число. Ни лексер, ни структура модуля типов не выводят, поэтому решение
 * принимается по тому, что написано прямо в этом же операторе.
 */
const STRING_WORDS = [
  'строк', 'текст', 'представлен', 'сообщени', 'описани', 'комментар',
  'заголов', 'наименован', 'подпис', 'html', 'xml', 'json',
];
const NUMBER_WORDS = [
  'счетчик', 'счётчик', 'количеств', 'колво', 'сумм', 'итог', 'номер', 'индекс',
  'процент', 'всего', 'размер', 'длина', 'цена', 'вес', 'объем', 'объём',
];

/** Функции, возвращающие строку: их вызов в правой части — доказательство. */
const STRING_FUNCTIONS = new Set([
  'строка', 'string', 'стршаблон', 'strtemplate', 'стрзаменить', 'strreplace',
  'стрсоединить', 'strconcat', 'сокрлп', 'trimall', 'сокрл', 'triml', 'сокрп', 'trimr',
  'формат', 'format', 'нстр', 'nstr', 'символы', 'chars', 'врег', 'upper', 'нрег', 'lower',
  'трег', 'title', 'стрполучитьстроку', 'strgetline', 'представлениепериода',
  'xmlстрока', 'xmlstring', 'получитьстрокуиздвоичныхданных',
]);

/** Есть ли в имени одно из слов-примет (сравнение без регистра). */
function hasWord(name, words) {
  const lower = String(name || '').toLowerCase();
  return words.some((w) => lower.includes(w));
}

/**
 * Что складывается в правой части присваивания: строка, число или непонятно.
 *
 * Просматриваются все токены выражения до конца оператора. Строковый литерал
 * либо вызов строковой функции — прямое доказательство строки, числовой
 * литерал — доказательство числа. Остальное («Итог = Итог + Строка.Процент»)
 * не доказывает ничего: имена реквизитов о типе не говорят.
 *
 * @returns {'string'|'number'|'unknown'}
 */
function expressionKind(tokens, from) {
  let sawNumber = false;
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === TOKEN.OPERATOR && token.value === ';') break;
    if (token.type === TOKEN.STRING) return 'string';
    if (token.type === TOKEN.NUMBER) sawNumber = true;
    if (token.type === TOKEN.IDENT && STRING_FUNCTIONS.has(token.value.toLowerCase())) return 'string';
  }
  return sawNumber ? 'number' : 'unknown';
}

/**
 * Накопление СТРОКИ конкатенацией в цикле — квадратичный расход памяти.
 *
 * Шаблон «Перем = Перем + …» у строки и у числа одинаков, а «Счетчик = Счетчик + 1»
 * проблемой не является: требование пользователя прямое — «научись различать,
 * что является строкой, а что нет». Поэтому замечание выдаётся, только когда
 * строку видно: в правой части стоит строковый литерал или вызов строковой
 * функции, либо (когда в выражении одни имена) о строке говорит имя самой
 * переменной и ничто в нём не говорит о числе. «ОбщийПроцентОплатыИтог =
 * ОбщийПроцентОплатыИтог + СтрокаТаблицы.ПроцентОплаты» замечанием не считается.
 */
/**
 * Условия отбора, не использующие индекс: свой код и свой заголовок каждому.
 *
 * Одинаковый заголовок у четырёх разных проверок давал в отчёте четыре
 * одинаковые строки в перечне типов: читатель видел дубли и не мог понять,
 * чем они отличаются (замечание пользователя, 20.08.2026).
 */
const NONINDEXED = {
  dottedFilter: {
    ruleId: 'perf.query-dotted-filter',
    title: 'Отбор через цепочку точек не использует индекс',
  },
  leadingWildcard: {
    ruleId: 'perf.query-leading-wildcard',
    title: 'ПОДОБНО с ведущим «%» не использует индекс',
  },
  castInWhere: {
    ruleId: 'perf.query-cast-in-where',
    title: 'ВЫРАЗИТЬ в условии отбора не даёт использовать индекс',
  },
  functionInWhere: {
    ruleId: 'perf.query-function-in-where',
    title: 'Функция над полем в условии отбора не даёт использовать индекс',
  },
};

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

    const kind = expressionKind(tokens, i + 3);
    if (kind === 'number') continue;
    const namedAsString = hasWord(target.value, STRING_WORDS) && !hasWord(target.value, NUMBER_WORDS);
    if (kind !== 'string' && !namedAsString) continue;

    const loop = findEnclosingLoop(structure.loops, i);
    if (!loop) continue;

    ctx.report({
      ruleId: 'perf.string-concat-in-loop',
      title: 'Накопление строки конкатенацией внутри цикла',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.PERFORMANCE,
      line: eq.line,
      detail:
        `Переменная «${target.value}» наращивается конкатенацией на каждой итерации. `
        + 'В 1С строки неизменяемы, поэтому расход памяти и времени растёт квадратично от числа итераций.',
      recommendation:
        'Используйте объект СтроковыйБуфер (8.3.24+) либо накапливайте фрагменты в массиве '
        + 'и объединяйте один раз через СтрСоединить().',
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
      // Место конкретного условия, а не начало запроса: замечание называет
      // выражение из условия ГДЕ, и фрагмент обязан показывать именно его.
      const place = queryPlace(query.text, issue.offset);
      ctx.report({
        ruleId: NONINDEXED[issue.kind]?.ruleId || 'perf.query-nonindexed-filter',
        title: NONINDEXED[issue.kind]?.title || 'Условие отбора не использует индекс',
        severity: SEVERITY.HIGH,
        category: CATEGORY.PERFORMANCE,
        line: query.line + place.lineOffset,
        detail: issue.detail,
        recommendation:
          'Перепишите условие так, чтобы отбор выполнялся по полю таблицы напрямую: ' +
          'вынесите значение в параметр запроса, добавьте нужный реквизит в индексируемое поле ' +
          'или подготовьте данные во временной таблице.',
        snippet: place.snippet,
      });
    }

    if (metrics.hasInHierarchy) {
      const place = queryPlaceOf(query.text, QUERY_PATTERNS.inHierarchy);
      ctx.report({
        ruleId: 'perf.query-in-hierarchy',
        title: 'Использование «В ИЕРАРХИИ»',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line + place.lineOffset,
        detail:
          'Условие «В ИЕРАРХИИ» разворачивается СУБД в рекурсивный обход дерева и на глубоких ' +
          'иерархиях выполняется значительно медленнее обычного отбора.',
        recommendation:
          'Если иерархия используется часто, храните признак принадлежности группе в отдельном ' +
          'индексируемом реквизите или регистре сведений и отбирайте по нему.',
        snippet: place.snippet,
      });
    }

    if (metrics.hasAutoOrder) {
      const place = queryPlaceOf(query.text, QUERY_PATTERNS.autoOrder);
      ctx.report({
        ruleId: 'perf.query-autoorder',
        title: 'Использование АВТОУПОРЯДОЧИВАНИЕ',
        severity: SEVERITY.LOW,
        category: CATEGORY.PERFORMANCE,
        line: query.line + place.lineOffset,
        detail: 'АВТОУПОРЯДОЧИВАНИЕ добавляет неявную сортировку по представлению ссылки, что требует соединения со справочником.',
        recommendation: 'Задайте явный порядок через УПОРЯДОЧИТЬ ПО по индексируемым полям.',
        snippet: place.snippet,
      });
    }
  }
}

/**
 * Начало запроса — для замечаний о запросе ЦЕЛИКОМ: соединений слишком много,
 * подзапросов слишком много, отбора нет вовсе. Здесь показать одну строку
 * нечего, речь о всей конструкции.
 */
function firstLines(text, n) {
  return text.split('\n').slice(0, n).join('\n').slice(0, 600);
}
