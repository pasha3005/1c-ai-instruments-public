/**
 * Каталог проверок регламента разработки.
 *
 * Регламент проекта — обычный MD-файл, который пользователь выбирает в форме
 * проверки качества. Алгоритм проверки статичен и никакого ИИ во время прогона
 * не зовёт, поэтому регламент не приносит НОВУЮ логику: он приносит **состав**
 * правил. Список запрещённых методов, перечень областей, набор пределов,
 * маска номера задачи — всё это живёт в файле и растёт свободно, а ищет их
 * в коде один и тот же алгоритм.
 *
 * Этот каталог — единственный источник правды о том, какие коды правил
 * программа понимает. По нему разбирается файл (`parsePolicy.js`), по нему же
 * отчёт называет коды, которые в регламенте есть, а в программе нет: обещать
 * проверку, которой не существует, продукт не имеет права.
 *
 * Один блок в файле — один код — один уровень критичности. Поэтому близкие
 * требования разведены по разным кодам («формат пометки» и «закрывающая
 * пометка»): у них на проекте разные уровни, и в одном блоке их было бы
 * не различить.
 */

import { SEVERITY } from '../analyze/rules/context.js';

/** Уровень критичности по-русски → значение движка. */
export const SEVERITY_BY_RU = new Map([
  ['критично', SEVERITY.CRITICAL],
  ['критический', SEVERITY.CRITICAL],
  ['высокий', SEVERITY.HIGH],
  ['средний', SEVERITY.MEDIUM],
  ['низкий', SEVERITY.LOW],
  ['информация', SEVERITY.INFO],
]);

/** Утвердительные значения. */
export const YES = new Set(['да', 'истина', 'yes', 'true', '1']);

/**
 * Виды проверок.
 *
 *  * `module` — по тексту модуля, набор правил `analyze/rules/policy.js`;
 *  * `metadata` — по перечню объектов конфигурации, `analyze/metadataChecks.js`;
 *  * `commit` — по комментариям помещений в хранилище, `pipeline/runQuality.js`.
 */
export const POLICY_CHECKS = [
  {
    code: 'policy.change-marker',
    scope: 'module',
    title: 'Формат пометки изменения',
    keys: {
      'открывающая пометка': 'text',
      'состав': 'list',
      'маска номера задачи': 'text',
      'пример номера задачи': 'text',
    },
  },
  {
    code: 'policy.change-marker-closing',
    scope: 'module',
    title: 'Закрывающая пометка изменения',
    keys: { 'закрывающая пометка': 'choice' },
  },
  {
    code: 'policy.module-regions',
    scope: 'module',
    title: 'Области модуля',
    keys: { 'обязательные области': 'pairs' },
  },
  {
    code: 'policy.empty-regions',
    scope: 'module',
    title: 'Пустые области',
    keys: { 'пустые области': 'choice' },
  },
  {
    code: 'policy.added-code-region',
    scope: 'module',
    title: 'Область добавленного кода',
    keys: {
      'область добавленного кода': 'text',
      'область добавленного кода в расширении': 'choice',
    },
  },
  {
    code: 'policy.extension-guard',
    scope: 'module',
    title: 'Инструкция препроцессора в модулях расширения',
    keys: {
      'первая строка': 'text',
      'виды модулей': 'list',
    },
  },
  {
    code: 'policy.extension-annotations',
    scope: 'module',
    title: 'Аннотации расширения',
    keys: {
      'аннотация замены': 'text',
      'вызов продолжения': 'text',
    },
  },
  {
    code: 'policy.own-routine-region',
    scope: 'module',
    title: 'Область собственного метода расширения',
    keys: { 'области собственных методов': 'pairs' },
  },
  {
    code: 'policy.short-names',
    scope: 'module',
    title: 'Сокращения в именах',
    keys: {
      'минимальная длина имени': 'text',
      'разрешённые имена': 'list',
    },
  },
  {
    code: 'policy.forbidden-methods',
    scope: 'module',
    title: 'Методы, которые использовать нельзя',
    keys: { 'замены': 'pairs' },
  },
  {
    code: 'policy.forbidden-text',
    scope: 'module',
    title: 'Записи, запрещённые в коде',
    keys: { 'записи': 'pairs' },
  },
  {
    code: 'policy.limits',
    scope: 'module',
    title: 'Пределы',
    keys: { 'пределы': 'pairs' },
  },
  {
    code: 'policy.formatting',
    scope: 'module',
    title: 'Оформление кода',
    keys: { 'требования': 'list' },
  },
  {
    code: 'policy.name-prefix',
    scope: 'metadata',
    title: 'Префикс доработок в именах объектов',
    keys: {
      'префикс': 'text',
      'проверять': 'list',
      'не проверять виды': 'list',
    },
  },
  {
    code: 'policy.role-synonym-suffix',
    scope: 'metadata',
    title: 'Признак проекта в синониме роли',
    keys: { 'суффикс синонима роли': 'text' },
  },
  {
    code: 'policy.manager-procedures',
    scope: 'metadata',
    title: 'Обязательные процедуры модуля менеджера',
    keys: { 'обязательные процедуры': 'pairs' },
  },
  {
    code: 'policy.commit-ticket',
    scope: 'commit',
    title: 'Номер задачи в комментарии помещения',
    keys: {
      'маска номера задачи': 'text',
      'пример номера задачи': 'text',
    },
  },
];

export const CHECK_BY_CODE = new Map(POLICY_CHECKS.map((c) => [c.code, c]));

/**
 * Пределы, которые умеет проверять `policy.limits`.
 *
 * Показатель называется по-русски ровно так, как написан в регламенте: набор
 * значений проектный, а перечень самих показателей — наш.
 */
export const LIMIT_KINDS = new Map([
  ['строк в процедуре', { id: 'routine-lines', title: 'Слишком длинная процедура' }],
  ['строк в запросе', { id: 'query-lines', title: 'Слишком длинный запрос в коде' }],
  ['строк в модуле', { id: 'module-lines', title: 'Слишком большой модуль' }],
  ['параметров у метода', { id: 'params', title: 'Слишком много параметров у метода' }],
  ['глубина вложенности', { id: 'nesting', title: 'Слишком глубокая вложенность' }],
]);

/** Требования оформления, которые умеет проверять `policy.formatting`. */
export const FORMAT_RULES = new Map([
  ['отступ табуляцией', 'tabs'],
  ['один оператор в строке', 'one-statement'],
  ['язык имён: русский', 'identifier-language'],
]);

/**
 * Аннотации расширения перед объявлением метода.
 *
 * По ним метод расширения отличается от собственного: заимствованный лежит
 * в той же области, что и в модуле конфигурации, и правило размещения
 * собственных методов на него не распространяется. Директивы компиляции
 * (`&НаКлиенте`, `&НаСервере`) сюда не входят — они есть и у собственных.
 */
export const EXTENSION_ANNOTATIONS = new Set([
  '&вместо', '&около', '&после', '&перед', '&изменениеиконтроль',
  '&around', '&after', '&before', '&changeandvalidate',
]);

/** Части пометки изменения, которых регламент может потребовать. */
export const MARKER_PARTS = new Map([
  ['префикс', 'prefix'],
  ['фамилия и инициалы', 'author'],
  ['дата', 'date'],
  ['номер задачи', 'ticket'],
]);

/**
 * Виды модулей регламента → `moduleType` разбора (`parse/modules.js`).
 * В регламенте они называются по-русски: файл читает человек.
 */
export const MODULE_TYPE_BY_RU = new Map([
  ['общий модуль', 'common'],
  ['модуль объекта', 'object'],
  ['модуль менеджера', 'manager'],
  ['модуль формы', 'form'],
  ['модуль команды', 'command'],
  ['модуль набора записей', 'recordset'],
  ['модуль приложения', 'application'],
  ['модуль сеанса', 'session'],
  ['модуль внешнего соединения', 'externalConnection'],
]);

/**
 * Идентификаторы встроенных правил движка.
 *
 * Регламент может задать им свой уровень или выключить их — нового кода это
 * не требует. Список сверяется с исходниками правил тестом
 * (`test/policy.test.js`): забытый здесь идентификатор означал бы, что
 * регламент молча не может управлять существующей проверкой.
 */
export const BUILTIN_RULE_IDS = [
  'arch.big-module',
  'arch.big-procedure',
  'arch.deep-nesting',
  'arch.duplicate-code',
  'arch.empty-except',
  'arch.global-common-module',
  'arch.high-complexity',
  'arch.large-form-module',
  'arch.module-too-large-to-analyze',
  'arch.query-in-form',
  'arch.too-many-params',
  'perf.query-autoorder',
  'perf.query-cast-in-where',
  'perf.query-dotted-filter',
  'perf.query-function-in-where',
  'perf.query-full-outer-join',
  'perf.query-leading-wildcard',
  'perf.query-in-hierarchy',
  'perf.query-many-joins',
  'perf.query-nested-subqueries',
  'perf.query-no-filter',
  'perf.query-sum-instead-of-count',
  'perf.query-union-distinct',
  'perf.string-concat-in-loop',
  'sec.com-object',
  'sec.dynamic-execution',
  'sec.external-code-loading',
  'sec.hardcoded-path',
  'sec.hardcoded-secret',
  'sec.privileged-common-module',
  'sec.safe-mode-disabled',
  'sec.unbalanced-privileged-mode',
  'sec.unsafe-app-launch',
  'std.catch-without-log',
  'std.collection-self-insert',
  'std.commented-code',
  'std.data-exchange-loading',
  'std.deprecated-current-date',
  'std.deprecated-message',
  'std.deprecated-sync-call',
  'std.export-in-command-module',
  'std.external-resource-timeout',
  'std.goto',
  'std.missing-directive',
  'std.no-regions',
  'std.procedure-returns-value',
  'std.role-check',
  'std.self-assignment',
  'std.subscription-without-handler',
  'std.temp-file-not-deleted',
  'std.transaction-without-try',
  'std.undocumented-export',
  'std.unlocalized-user-message',
];

export const BUILTIN_RULE_SET = new Set(BUILTIN_RULE_IDS);

/** Код известен программе: свой конструктор либо встроенное правило. */
export function isKnownCode(code) {
  return CHECK_BY_CODE.has(code) || BUILTIN_RULE_SET.has(code);
}
