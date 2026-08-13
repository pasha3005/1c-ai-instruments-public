/**
 * Правила, снятые прямо со стандартов ИТС (раздел v8std) и требований
 * «1С:Совместимо».
 *
 * Отдельным файлом, а не дописками в `standards.js`, по двум причинам.
 * Во-первых, у каждого правила здесь есть точный первоисточник — номер
 * стандарта и его уровень («Обязательно к выполнению» / «1С:Совместимо»), —
 * и он приводится в тексте замечания: разработчику, который будет спорить
 * с замечанием, нужна ссылка, а не наше мнение. Во-вторых, в свод попадают
 * только пункты, у которых в самом стандарте написано «Способ проверки:
 * Автоматически» И которые берутся нашим лексером без вывода типов
 * и межпроцедурного анализа. Остальное остаётся проверкой руками — обещать
 * в отчёте то, чего движок не делает, нельзя.
 *
 * Полный свод стандартов лежит в скилле `onec-standards`; здесь — та его
 * часть, которую программа действительно проверяет.
 */

import { TOKEN } from '../bsl/lexer.js';
import { findEnclosingRoutine } from '../bsl/structure.js';
import { word, testWord, E } from '../bsl/wordBoundary.js';
import { queryPlaceOf } from '../bsl/query.js';
import { SEVERITY, CATEGORY, snippetAt } from './context.js';

export const id = 'its';

/** Ссылка на стандарт — одинаковой строкой у всех замечаний свода. */
function std(number, title, level = 'Обязательно к выполнению') {
  return `Стандарт ИТС ${number} «${title}», уровень «${level}»: `;
}

/** @param {ReturnType<import('./context.js').createRuleContext>} ctx */
export function run(ctx) {
  detectCurrentDate(ctx);
  detectCommentedCode(ctx);
  detectExportInCommandModule(ctx);
  detectTransactionWithoutTry(ctx);
  detectMissingDataExchangeLoading(ctx);
  detectRoleCheck(ctx);
  detectMissingTimeout(ctx);
  detectUnsafeAppLaunch(ctx);
  detectHardcodedPath(ctx);
  analyzeQueries(ctx);
}

// --- Соглашения при написании кода -------------------------------------------

/**
 * ТекущаяДата() возвращает время серверного компьютера, а не сеанса.
 *
 * ИТС 643: во всех серверных процедурах вместо неё следует использовать
 * ТекущаяДатаСеанса(), в клиентском коде — не использовать вовсе.
 */
function detectCurrentDate(ctx) {
  const { tokens, source } = ctx;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const name = token.value.toLowerCase();
    if (name !== 'текущаядата' && name !== 'currentdate') continue;
    if (tokens[i + 1]?.value !== '(') continue;

    ctx.report({
      ruleId: 'std.deprecated-current-date',
      title: 'Использование ТекущаяДата()',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail: `${std(643, 'Работа в разных часовых поясах')}функция ТекущаяДата() `
        + 'возвращает дату и время СЕРВЕРНОГО компьютера. Если часовой пояс сервера '
        + 'не совпадает с часовым поясом пользователей, документы и записи получат '
        + 'чужое время, а вычисленное на клиенте и на сервере время разойдётся.',
      recommendation: 'На сервере — ТекущаяДатаСеанса(); для отметки, не зависящей от '
        + 'часового пояса, — УниверсальноеВремя(); на клиенте — получать дату с сервера '
        + 'либо брать дату документа.',
      snippet: snippetAt(source, token.line),
    });
  }
}

/**
 * Строка комментария, похожая на закомментированный код, а не на пояснение:
 * оператор с точкой с запятой либо строка, начинающаяся ключевым словом языка.
 *
 * Границы слова — через `word()`: стандартная `\b` с кириллицей не работает,
 * и «Если Истина Тогда» такой шаблон не находил вовсе.
 */
const CODE_LIKE_COMMENT = /.+;\s*$/;
const CODE_KEYWORD_START = new RegExp(
  '^\\s*(?:Если|Иначе|ИначеЕсли|КонецЕсли|Для|Пока|Цикл|КонецЦикла|Попытка|Исключение'
  + '|КонецПопытки|Процедура|Функция|КонецПроцедуры|КонецФункции|Возврат'
  + `|Продолжить|Прервать|Перем)${E}`,
  'i',
);

/** Служебные отметки процесса разработки: их стандарт называет отдельно. */
const DEV_MARKS = word('TODO|FIXME|MRG|ХАК|HACK|ЗАГЛУШКА|ОТЛАДКА|DEBUG', 'i');

/**
 * Закомментированный код и следы процесса разработки.
 *
 * ИТС 456, п. 3: модули не должны иметь закомментированных фрагментов кода,
 * а также отладочного кода и служебных отметок (TODO, MRG и т.п.).
 *
 * Замечание одно на модуль со счётчиком: комментариев в модуле сотни, и по
 * замечанию на каждый отчёт превратился бы в стену. Отличить пояснение
 * от закомментированного кода надёжно нельзя, поэтому берём только явное —
 * строку, которая заканчивается точкой с запятой либо начинается ключевым
 * словом языка.
 */
function detectCommentedCode(ctx) {
  const { comments, source } = ctx;
  let count = 0;
  let marks = 0;
  let firstLine = 0;

  for (const token of comments || []) {
    const text = token.value.replace(/^\/\/+/, '').trim();
    if (!text) continue;
    // Пометка авторства («// ++ Иванов») — не отладочный след, а способ
    // отметить доработку: по ним движок и определяет авторство в базе.
    if (/^[+-]{2}/.test(text)) continue;
    const isMark = DEV_MARKS.test(text);
    const looksLikeCode = CODE_LIKE_COMMENT.test(text) || CODE_KEYWORD_START.test(text);
    if (!isMark && !looksLikeCode) continue;
    if (isMark) marks += 1;
    count += 1;
    if (!firstLine) firstLine = token.line;
  }

  if (count < 3) return;

  ctx.report({
    ruleId: 'std.commented-code',
    title: `Закомментированный код и следы отладки (${count})`,
    severity: SEVERITY.LOW,
    category: CATEGORY.STANDARDS,
    line: firstLine,
    detail: `${std(456, 'Тексты модулей')}в модуле ${count} закомментированных строк, `
      + `похожих на код${marks ? `, из них служебных отметок (TODO, MRG и т.п.): ${marks}` : ''}. `
      + 'Стандарт требует удалять такие фрагменты после отладки и рефакторинга: они '
      + 'устаревают вместе с кодом и вводят в заблуждение следующего разработчика.',
    recommendation: 'Удалите закомментированный код — история правок хранится в хранилище '
      + 'конфигурации. Незакрытые задачи ведите в системе учёта задач, а не в комментариях.',
    snippet: snippetAt(source, firstLine, 1),
  });
}

/**
 * Экспортные методы в модулях команд.
 *
 * ИТС 544: к модулям команд и общих команд обратиться извне нельзя, поэтому
 * экспорт в них не имеет смысла.
 */
function detectExportInCommandModule(ctx) {
  const { structure, module } = ctx;
  if (module.moduleType !== 'command') return;

  const exported = structure.routines.filter((r) => r.isExport);
  if (!exported.length) return;

  ctx.report({
    ruleId: 'std.export-in-command-module',
    title: `Экспортные методы в модуле команды: ${exported.length}`,
    severity: SEVERITY.LOW,
    category: CATEGORY.STANDARDS,
    line: exported[0].startLine,
    detail: `${std(544, 'Ограничения на использование экспортных процедур и функций')}`
      + `в модуле команды объявлено ${exported.length} экспортных методов `
      + `(первый — «${exported[0].name}»). Вызвать их извне нельзя: к модулю команды `
      + 'нет доступа из внешнего по отношению к нему кода.',
    recommendation: 'Снимите «Экспорт», а код, нужный другим объектам, перенесите '
      + 'в общий модуль.',
  });
}

/**
 * Транзакция без обработки исключений.
 *
 * «1С:Совместимо», п. 2.13.3: НачатьТранзакцию() должен стоять непосредственно
 * перед оператором Попытка, а ОтменитьТранзакцию() — первым в блоке Исключение.
 * Проверяем самое грубое нарушение, различимое лексически: после
 * НачатьТранзакцию() в процедуре нет ни одной Попытки, либо нет парного
 * завершения транзакции вовсе.
 */
function detectTransactionWithoutTry(ctx) {
  const { tokens, structure, source } = ctx;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const name = token.value.toLowerCase();
    if (name !== 'начатьтранзакцию' && name !== 'begintransaction') continue;
    if (tokens[i + 1]?.value !== '(') continue;

    const routine = findEnclosingRoutine(structure.routines, i);
    const from = i;
    const to = routine ? routine.endIdx : tokens.length - 1;

    let hasTry = false;
    let hasFinish = false;
    for (let j = from; j <= to; j += 1) {
      const t = tokens[j];
      if (t.type === TOKEN.KEYWORD && t.keyword === 'try') hasTry = true;
      if (t.type !== TOKEN.IDENT) continue;
      const call = t.value.toLowerCase();
      if (call === 'зафиксироватьтранзакцию' || call === 'committransaction'
        || call === 'отменитьтранзакцию' || call === 'rollbacktransaction') hasFinish = true;
    }
    if (hasTry && hasFinish) continue;

    ctx.report({
      ruleId: 'std.transaction-without-try',
      title: hasFinish
        ? 'Транзакция без обработки исключений'
        : 'Транзакция начата и не завершена в этой же процедуре',
      severity: SEVERITY.HIGH,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail: `${std('«1С:Совместимо» 2.13', 'Использование транзакций', '1С:Совместимо')}`
        + `после НачатьТранзакцию()${routine ? ` в процедуре «${routine.name}»` : ''} `
        + (hasFinish
          ? 'нет блока Попытка. Исключение внутри транзакции оставит её незакрытой, '
            + 'и платформа завершит сеанс ошибкой «В данной транзакции происходила ошибка».'
          : 'нет ни ЗафиксироватьТранзакцию(), ни ОтменитьТранзакцию(). Начало транзакции '
            + 'и её завершение обязаны находиться в одном методе.'),
      recommendation: 'НачатьТранзакцию() — непосредственно перед Попытка; все действия — '
        + 'внутри Попытки; ЗафиксироватьТранзакцию() — последним оператором перед Исключение; '
        + 'ОтменитьТранзакцию() — первым в блоке Исключение, следом запись в журнал регистрации.',
      snippet: snippetAt(source, token.line, 1),
    });
  }
}

/** Обработчики, которые обязаны начинаться с проверки ОбменДанными.Загрузка. */
const EXCHANGE_HANDLERS = new Set([
  'передзаписью', 'призаписи', 'передудалением', 'обработкапроведения',
  'обработкаудаленияпроведения', 'передудалениемобъекта',
]);

/**
 * Обработчик записи без проверки ОбменДанными.Загрузка.
 *
 * ИТС 464 и 465: все действия в ПередЗаписью и ПриЗаписи должны выполняться
 * после проверки на ОбменДанными.Загрузка — иначе при загрузке данных обмена
 * прикладная логика отработает второй раз и переопределит присланные значения.
 *
 * Проверяются только модули объектов и наборов записей: в модуле формы
 * обработчик с тем же именем к обмену отношения не имеет.
 */
function detectMissingDataExchangeLoading(ctx) {
  const { tokens, structure, module } = ctx;
  if (module.moduleType !== 'object' && module.moduleType !== 'recordset') return;

  for (const routine of structure.routines) {
    const name = routine.name.toLowerCase();
    if (!EXCHANGE_HANDLERS.has(name)) continue;
    // Тело пустое — проверять нечего, обработчик ничего не делает.
    let hasBody = false;
    let checked = false;
    for (let i = routine.bodyStartIdx; i <= routine.endIdx; i += 1) {
      const t = tokens[i];
      if (!t) break;
      if (t.type === TOKEN.IDENT || t.type === TOKEN.KEYWORD) hasBody = true;
      if (t.type !== TOKEN.IDENT) continue;
      if (t.value.toLowerCase() !== 'обменданными' && t.value.toLowerCase() !== 'dataexchange') continue;
      if (tokens[i + 1]?.value !== '.') continue;
      const member = tokens[i + 2]?.value?.toLowerCase();
      if (member === 'загрузка' || member === 'load') { checked = true; break; }
    }
    if (!hasBody || checked) continue;

    ctx.report({
      ruleId: 'std.data-exchange-loading',
      title: `Обработчик «${routine.name}» без проверки ОбменДанными.Загрузка`,
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: routine.startLine,
      detail: `${std('464, 465', 'Обработчики событий ПередЗаписью и ПриЗаписи')}`
        + `все действия обработчика «${routine.name}» должны выполняться после проверки `
        + 'на ОбменДанными.Загрузка. Без неё прикладная логика отработает и при загрузке '
        + 'данных обмена: присланные значения будут пересчитаны и перезаписаны, а узлы '
        + 'обмена разойдутся.',
      recommendation: 'Первой строкой обработчика: «Если ОбменДанными.Загрузка Тогда '
        + 'Возврат; КонецЕсли;».',
    });
  }
}

/**
 * Проверка прав через РольДоступна().
 *
 * ИТС 737: проверять нужно право доступа (ПравоДоступа), а не наличие роли:
 * состав ролей у пользователя меняется, а право — это то, что действительно
 * требуется коду.
 */
function detectRoleCheck(ctx) {
  const { tokens, source } = ctx;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const name = token.value.toLowerCase();
    if (name !== 'рольдоступна' && name !== 'isinrole') continue;
    if (tokens[i + 1]?.value !== '(') continue;

    ctx.report({
      ruleId: 'std.role-check',
      title: 'Проверка прав через РольДоступна()',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail: `${std(737, 'Проверка прав доступа')}РольДоступна() проверяет не право, `
        + 'а состав ролей. Стоит администратору выдать то же право другой ролью — '
        + 'и проверка начнёт запрещать разрешённое; у пользователя с полными правами '
        + 'она, наоборот, пропустит запрещённое.',
      recommendation: 'Используйте ПравоДоступа("Изменение", Метаданные.Справочники.X) '
        + 'либо готовые методы БСП (ПравоДоступа, РолиДоступны для проверки профиля).',
      snippet: snippetAt(source, token.line),
    });
  }
}

/** Объекты, работающие с внешними ресурсами: им обязателен таймаут. */
const EXTERNAL_RESOURCES = new Map([
  ['httpсоединение', 'HTTPСоединение'],
  ['httpconnection', 'HTTPСоединение'],
  ['ftpсоединение', 'FTPСоединение'],
  ['ftpconnection', 'FTPСоединение'],
  ['wsопределения', 'WSОпределения'],
  ['wsdefinitions', 'WSОпределения'],
  ['wsпрокси', 'WSПрокси'],
  ['wsproxy', 'WSПрокси'],
  ['интернетпочтовыйпрофиль', 'ИнтернетПочтовыйПрофиль'],
  ['internetmailprofile', 'ИнтернетПочтовыйПрофиль'],
]);

/**
 * Работа с внешним ресурсом без таймаута.
 *
 * ИТС 748: при работе с HTTPСоединение, FTPСоединение, WSОпределения,
 * WSПрокси, ИнтернетПочтовыйПрофиль таймаут задавать обязательно — иначе
 * при недоступности удалённой стороны программа зависает.
 *
 * Правило намеренно грубое: таймаут задаётся то шестым параметром конструктора,
 * то свойством объекта, то через настройку профиля, и разобрать все написания
 * лексически нельзя. Поэтому замечание выдаётся, только если слова «Таймаут»
 * во всём модуле нет вовсе. Так правило не спорит с написанием, но ловит
 * главный случай — про таймаут просто забыли.
 */
function detectMissingTimeout(ctx) {
  const { tokens, source } = ctx;
  const hasTimeout = tokens.some(
    (t) => t.type === TOKEN.IDENT && /^(таймаут|timeout)$/i.test(t.value),
  );
  if (hasTimeout) return;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const previous = tokens[i - 1];
    if (previous.type !== TOKEN.KEYWORD || previous.keyword !== 'new') continue;
    const kind = EXTERNAL_RESOURCES.get(token.value.toLowerCase());
    if (!kind) continue;

    ctx.report({
      ruleId: 'std.external-resource-timeout',
      title: `${kind} без таймаута`,
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail: `${std(748, 'Таймауты при работе с внешними ресурсами')}объект ${kind} `
        + 'создаётся, но слова «Таймаут» в модуле нет ни разу. Без предельного времени '
        + 'ожидания недоступность удалённой стороны выглядит как зависшая программа, '
        + 'а в регламентном задании блокирует часть функциональности целиком.',
      recommendation: 'Задайте таймаут: у HTTPСоединение и FTPСоединение — параметром '
        + 'конструктора, у WSПрокси и ИнтернетПочтовыйПрофиль — свойством. Для быстрых '
        + 'операций — секунды, в общем случае не более 3 минут.',
      snippet: snippetAt(source, token.line),
    });
  }
}

// --- Безопасность ------------------------------------------------------------

/** Запуск внешней программы. */
const LAUNCH_METHODS = new Map([
  ['запуститьприложение', 'ЗапуститьПриложение'],
  ['runapp', 'ЗапуститьПриложение'],
  ['командасистемы', 'КомандаСистемы'],
  ['system', 'КомандаСистемы'],
  ['начатьзапускприложения', 'НачатьЗапускПриложения'],
  ['beginrunningapplication', 'НачатьЗапускПриложения'],
]);

/**
 * Запуск программы строкой, собранной из непроверенных частей.
 *
 * ИТС 774: строка запуска должна собираться только из проверенных частей.
 * Лексически видно главное: первый аргумент — не строковый литерал, а значит
 * склеен из переменных, и что в них попало, из кода не видно.
 */
function detectUnsafeAppLaunch(ctx) {
  const { tokens, source } = ctx;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const method = LAUNCH_METHODS.get(token.value.toLowerCase());
    if (!method) continue;
    if (tokens[i + 1]?.value !== '(') continue;

    // Первый аргумент — целиком строковый литерал: собирать нечего,
    // проверять нечего.
    const first = tokens[i + 2];
    const after = tokens[i + 3];
    const literal = first?.type === TOKEN.STRING
      && (after?.value === ',' || after?.value === ')');
    if (literal && method !== 'КомандаСистемы') continue;

    ctx.report({
      ruleId: 'sec.unsafe-app-launch',
      title: `Запуск внешней программы: ${method}()`,
      severity: literal ? SEVERITY.MEDIUM : SEVERITY.HIGH,
      category: CATEGORY.SECURITY,
      line: token.line,
      detail: `${std(774, 'Безопасность запуска приложений')}строка запуска ${method}() `
        + (literal
          ? 'задана литералом, но команда выполняется через командный интерпретатор.'
          : 'собирается из выражения, а не из строкового литерала. Если хоть одна часть '
            + 'пришла из базы, из поля ввода или из хранилища настроек, в неё можно '
            + 'подставить свою команду.'),
      recommendation: 'Проверяйте составные части на символы «$», «`», «|», «;», «&» — '
        + 'либо используйте программный интерфейс БСП: ФайловаяСистемаКлиент.ОткрытьФайл, '
        + 'ОткрытьПроводник, ОткрытьНавигационнуюСсылку.',
      snippet: snippetAt(source, token.line),
    });
  }
}

/** Строковый литерал, похожий на путь файловой системы или на сетевой адрес. */
const HARDCODED_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:home|opt|usr|var|etc|tmp|mnt)\/|(?:https?|ftp):\/\/(?:\d{1,3}\.){3}\d{1,3})/;

/**
 * Путь к файлу или сетевой адрес прямо в коде.
 *
 * Стандарт ИТС «Использование платформеннозависимого кода» (проверяется
 * автоматически, уровень «Обязательно к выполнению»): путь вида «C:\Обмен\»
 * работает только на Windows и только на той машине, где его написали,
 * а при переносе базы к клиенту молча ломается.
 */
function detectHardcodedPath(ctx) {
  const { tokens, source } = ctx;
  for (const token of tokens) {
    if (token.type !== TOKEN.STRING) continue;
    const text = token.value.replace(/^"|"$/g, '');
    if (text.length < 4 || !HARDCODED_PATH.test(text)) continue;

    ctx.report({
      ruleId: 'sec.hardcoded-path',
      title: 'Путь или сетевой адрес прямо в коде',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail: 'Стандарт ИТС «Использование платформеннозависимого кода», уровень '
        + `«Обязательно к выполнению»: в коде записан путь «${text.slice(0, 80)}». `
        + 'Он привязан к операционной системе и к конкретной машине: на сервере Linux, '
        + 'в веб-клиенте и у клиента с другой структурой каталогов такой код не работает, '
        + 'причём отказ виден только во время выполнения.',
      recommendation: 'Храните пути в константах, регистрах сведений или настройках '
        + 'программы; каталоги получайте методами платформы (КаталогВременныхФайлов, '
        + 'КаталогДокументов) и собирайте через ОбъединитьПути().',
      snippet: snippetAt(source, token.line),
    });
  }
}

// --- Язык запросов -----------------------------------------------------------

const FULL_JOIN = word('ПОЛНОЕ(?:\\s+ВНЕШНЕЕ)?\\s+СОЕДИНЕНИЕ|FULL(?:\\s+OUTER)?\\s+JOIN');
// «ОБЪЕДИНИТЬ», за которым НЕ идёт «ВСЕ», — то самое дорогое объединение
// с устранением дублей.
const UNION_DISTINCT = word('ОБЪЕДИНИТЬ(?!\\s+ВСЕ)|UNION(?!\\s+ALL)');
const SUM_ONE = /СУММА\s*\(\s*1\s*\)|SUM\s*\(\s*1\s*\)/i;

function analyzeQueries(ctx) {
  for (const query of ctx.queries) {
    if (testWord(FULL_JOIN, query.text)) {
      const place = queryPlaceOf(query.text, FULL_JOIN);
      ctx.report({
        ruleId: 'perf.query-full-outer-join',
        title: 'Полное внешнее соединение в запросе',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line + place.lineOffset,
        detail: `${std(435, 'Ограничение на использование конструкции «ПОЛНОЕ ВНЕШНЕЕ СОЕДИНЕНИЕ»')}`
          + 'на PostgreSQL производительность запросов с полным соединением значительно '
          + 'падает, особенно если таких соединений в запросе два и более.',
        recommendation: 'Перепишите запрос без полного соединения: как правило, хватает '
          + 'левого соединения, объединённого через ОБЪЕДИНИТЬ ВСЕ со второй частью.',
        snippet: place.snippet,
      });
    }

    if (testWord(UNION_DISTINCT, query.text)) {
      const place = queryPlaceOf(query.text, UNION_DISTINCT);
      ctx.report({
        ruleId: 'perf.query-union-distinct',
        title: 'ОБЪЕДИНИТЬ вместо ОБЪЕДИНИТЬ ВСЕ',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line + place.lineOffset,
        detail: `${std(434, 'Использование ключевых слов «ОБЪЕДИНИТЬ» и «ОБЪЕДИНИТЬ ВСЕ»')}`
          + 'ОБЪЕДИНИТЬ заменяет полностью одинаковые строки одной, и СУБД тратит время '
          + 'на поиск дублей — даже когда их заведомо быть не может.',
        recommendation: 'Используйте ОБЪЕДИНИТЬ ВСЕ. ОБЪЕДИНИТЬ оставляйте только там, '
          + 'где устранение дублей действительно нужно по логике запроса.',
        snippet: place.snippet,
      });
    }

    if (SUM_ONE.test(query.text)) {
      const place = queryPlaceOf(query.text, new RegExp(SUM_ONE.source, 'gi'));
      ctx.report({
        ruleId: 'perf.query-sum-instead-of-count',
        title: 'СУММА(1) вместо КОЛИЧЕСТВО',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.PERFORMANCE,
        line: query.line + place.lineOffset,
        detail: `${std(787, 'Вычисление количества записей в запросах')}СУММА(1) считает `
          + 'количество числом разрядности по умолчанию (7 разрядов). На 10 млн записей '
          + 'и более произойдёт переполнение, и запрос завершится ошибкой.',
        recommendation: 'Считайте количество функцией КОЛИЧЕСТВО(*) или КОЛИЧЕСТВО(Поле). '
          + 'Если количество вычисляется условно, расширьте разрядность: '
          + 'ВЫРАЗИТЬ(1 КАК ЧИСЛО(17, 0)).',
        snippet: place.snippet,
      });
    }
  }
}
