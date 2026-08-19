/**
 * Контекст выполнения правил анализа кода и вспомогательные словари.
 *
 * Правило получает разобранный модуль (токены, структура, запросы) и добавляет
 * находки через ctx.report(). Такой контракт позволяет добавлять новые правила
 * одним файлом, не трогая движок.
 */

import { LIMITS } from '../../config.js';
import { findRoutineAtLine } from '../bsl/structure.js';

/** Уровни критичности находок. */
export const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

export const SEVERITY_ORDER = [
  SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW, SEVERITY.INFO,
];

export const SEVERITY_RU = {
  critical: 'Критично',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
  info: 'Информация',
};

/** Категории находок — определяют раздел отчёта. */
export const CATEGORY = {
  PERFORMANCE: 'performance',
  ARCHITECTURE: 'architecture',
  SECURITY: 'security',
  STANDARDS: 'standards',
  MAINTAINABILITY: 'maintainability',
  /** Требования регламента разработки проекта, а не наши и не ИТС. */
  POLICY: 'policy',
};

export const CATEGORY_RU = {
  performance: 'Производительность',
  architecture: 'Архитектура',
  security: 'Безопасность',
  standards: 'Стандарты разработки 1С',
  maintainability: 'Сопровождаемость',
  policy: 'Регламент проекта',
};

/** Небезопасные конструкции: динамическое исполнение кода. */
export const UNSAFE_EXECUTION = new Set(['выполнить', 'execute', 'вычислить', 'eval']);

/**
 * Методы работы с правами, требующие внимания при аудите безопасности.
 */
export const PRIVILEGE_METHODS = new Set([
  'установитьпривилегированныйрежим', 'setprivilegedmode',
  'привилегированныйрежим', 'privilegedmode',
  'установитьбезопасныйрежим', 'setsafemode',
]);

/** Устаревшие и запрещённые стандартами 1С методы. */
export const DEPRECATED_METHODS = new Map([
  ['предупреждение', 'Предупреждение() — синхронный вызов; используйте ПоказатьПредупреждение()'],
  ['вопрос', 'Вопрос() — синхронный вызов; используйте ПоказатьВопрос()'],
  ['открытьзначение', 'ОткрытьЗначение() — синхронный вызов; используйте ПоказатьЗначение()'],
  ['ввестичисло', 'ВвестиЧисло() — синхронный вызов; используйте ПоказатьВводЧисла()'],
  ['ввестистроку', 'ВвестиСтроку() — синхронный вызов; используйте ПоказатьВводСтроки()'],
  ['ввестидату', 'ВвестиДату() — синхронный вызов; используйте ПоказатьВводДаты()'],
  ['ввестизначение', 'ВвестиЗначение() — синхронный вызов; используйте ПоказатьВводЗначения()'],
  ['открытьформумодально', 'ОткрытьФормуМодально() — используйте ОткрытьФорму() с оповещением'],
]);

/**
 * Создаёт контекст для набора правил.
 * @param {object} params
 */
export function createRuleContext({
  module, source, tokens, stats, structure, queries, comments = [], configuration,
  policy = null, fullSource = null, partialSource = false,
}) {
  /** @type {object[]} */
  const findings = [];
  const perRuleCount = new Map();

  return {
    module,
    source,
    tokens,
    stats,
    structure,
    queries,
    // Комментарии лежат отдельным списком, а не в потоке токенов: правила
    // опираются на соседство токенов, и вклиненный комментарий его бы разорвал.
    // Нужны они одному правилу — «закомментированный код» (ИТС 456).
    comments,
    configuration,
    // Регламент разработки проекта: набор правил, выбранный пользователем
    // MD-файлом. Пуст — набор `rules/policy.js` молча выходит.
    policy,
    // Текст модуля ЦЕЛИКОМ и признак того, что `source` от него урезан.
    //
    // У изменённого типового модуля правила видят только строки правки:
    // отличия от типового кода типовым кодом не являются. Но проверкам
    // регламента иногда нужен весь модуль — например, чтобы убедиться, что
    // вставка лежит внутри области добавленного функционала. Правила,
    // считающие по модулю целиком (области, размер), на урезанном тексте
    // не работают вовсе: там нет ни областей вендора, ни его строк.
    fullSource: fullSource || source,
    partialSource,
    findings,

    /**
     * Регистрирует находку.
     * @param {object} finding
     * @param {string} finding.ruleId
     * @param {string} finding.title
     * @param {string} finding.severity
     * @param {string} finding.category
     * @param {string} [finding.detail]
     * @param {string} [finding.recommendation]
     * @param {number} [finding.line]
     * @param {string} [finding.snippet]
     */
    report(finding) {
      const count = perRuleCount.get(finding.ruleId) || 0;
      if (count >= LIMITS.maxFindingsPerRule) return;
      perRuleCount.set(finding.ruleId, count + 1);

      // Процедура/функция, которой принадлежит строка замечания — для колонки
      // «где» в отчёте: вид.объект → вид модуля → имя процедуры. Строится здесь,
      // а не в каждом правиле, ровно по той же причине, что и фрагмент кода.
      const routine = finding.line ? findRoutineAtLine(structure.routines, finding.line) : null;

      findings.push({
        ...finding,
        // Фрагмент кода добавляется здесь, а не в каждом правиле: в отчёте
        // у каждого замечания должен быть виден сам код разработчика, иначе
        // читателю приходится открывать конфигуратор, чтобы понять, о чём речь.
        // Правило может задать свой фрагмент — тогда он и остаётся.
        snippet: finding.snippet ?? (finding.line ? snippetAt(source, finding.line, 1) : undefined),
        moduleTitle: module.title,
        moduleFile: module.rel,
        moduleType: module.moduleType,
        moduleTypeRu: module.moduleTypeRu,
        ownerKind: module.ownerKind,
        ownerName: module.ownerName,
        formName: module.formName,
        routine: finding.routine || routine?.name || null,
      });
    },
  };
}

/** Возвращает фрагмент исходного текста вокруг строки — для отчёта. */
export function snippetAt(source, line, contextLines = 0) {
  const lines = source.split('\n');
  const from = Math.max(0, line - 1 - contextLines);
  const to = Math.min(lines.length, line + contextLines);
  return lines.slice(from, to).map((s) => s.trimEnd()).join('\n').slice(0, 400);
}
