/**
 * Правила соответствия стандартам разработки 1С и требованиям БСП.
 *
 * Опорные документы: «Система стандартов и методик разработки конфигураций
 * для платформы 1С:Предприятие 8» и требования к внедрению Библиотеки
 * стандартных подсистем.
 */

import { TOKEN } from '../bsl/lexer.js';
import { findEnclosingRoutine } from '../bsl/structure.js';
import { SEVERITY, CATEGORY, DEPRECATED_METHODS, snippetAt } from './context.js';

export const id = 'standards';

export function run(ctx) {
  detectDeprecatedSyncCalls(ctx);
  detectMissingRegions(ctx);
  detectUndocumentedExports(ctx);
  detectGoto(ctx);
  detectDirectMessageCalls(ctx);
  detectMissingCompilationDirectives(ctx);
  detectSilentCatchWithoutLog(ctx);
}

/**
 * Синхронные диалоги запрещены в режиме «Использовать модальность: Не использовать»
 * и не работают в веб-клиенте.
 */
function detectDeprecatedSyncCalls(ctx) {
  const { tokens, source, configuration } = ctx;
  const modalityForbidden = configuration?.configuration?.modalityUseMode === 'DontUse';

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const advice = DEPRECATED_METHODS.get(token.value.toLowerCase());
    if (!advice) continue;

    // Должен быть вызовом.
    if (tokens[i + 1]?.value !== '(') continue;

    ctx.report({
      ruleId: 'std.deprecated-sync-call',
      title: `Синхронный вызов ${token.value}()`,
      severity: modalityForbidden ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail:
        advice +
        (modalityForbidden
          ? '. В конфигурации установлен режим «Использовать модальность: Не использовать» — такой вызов приведёт к ошибке во время работы.'
          : '. Метод не поддерживается веб-клиентом и мобильным клиентом.'),
      recommendation:
        'Перейдите на асинхронный вариант с описанием оповещения (ОписаниеОповещения) ' +
        'либо используйте асинхронные методы платформы 8.3.18+ (Ждать / Асинх).',
      snippet: snippetAt(source, token.line),
    });
  }
}

/**
 * Стандарт 1С требует структурировать модули областями #Область.
 * Для крупных модулей их отсутствие — заметная проблема читаемости.
 */
function detectMissingRegions(ctx) {
  const { structure, stats, module } = ctx;
  if (stats.codeLines < 100) return;
  if (module.moduleType === 'command') return;

  // NB: \b не работает с кириллицей — проверяем явный разделитель после слова.
  const hasRegions = structure.preprocessor.some((p) => /^#\s*(Область|Region)(\s|$)/i.test(p.text));
  if (hasRegions) return;

  ctx.report({
    ruleId: 'std.no-regions',
    title: 'Модуль не структурирован областями',
    severity: SEVERITY.LOW,
    category: CATEGORY.STANDARDS,
    detail:
      `Модуль содержит ${stats.codeLines} строк кода, но не разделён инструкциями #Область. ` +
      'Стандарт разработки 1С требует выделять программный интерфейс, служебные процедуры ' +
      'и обработчики событий отдельными областями.',
    recommendation:
      'Добавьте области: #Область ПрограммныйИнтерфейс, #Область СлужебныеПроцедурыИФункции, ' +
      '#Область ОбработчикиСобытий — в порядке, предусмотренном стандартом.',
  });
}

/** Экспортные методы должны иметь описание — это публичный интерфейс модуля. */
function detectUndocumentedExports(ctx) {
  const { structure, source, module } = ctx;
  if (module.moduleType !== 'common') return;

  const lines = source.split('\n');
  let undocumented = 0;
  let firstLine = 0;

  for (const routine of structure.routines) {
    if (!routine.isExport) continue;
    // Ищем комментарий непосредственно перед объявлением.
    let idx = routine.startLine - 2;
    let hasComment = false;
    while (idx >= 0) {
      const text = (lines[idx] || '').trim();
      if (text === '') { idx -= 1; continue; }
      if (text.startsWith('//')) { hasComment = true; }
      break;
    }
    if (!hasComment) {
      undocumented += 1;
      if (!firstLine) firstLine = routine.startLine;
    }
  }

  if (undocumented === 0) return;
  const total = structure.routines.filter((r) => r.isExport).length;

  ctx.report({
    ruleId: 'std.undocumented-export',
    title: `Экспортные методы без описания: ${undocumented} из ${total}`,
    severity: undocumented / Math.max(1, total) > 0.5 ? SEVERITY.MEDIUM : SEVERITY.LOW,
    category: CATEGORY.STANDARDS,
    line: firstLine || undefined,
    detail:
      `В общем модуле ${undocumented} экспортных методов не имеют комментария-описания. ` +
      'Экспортные методы образуют программный интерфейс модуля, которым пользуются другие разработчики.',
    recommendation:
      'Опишите назначение, параметры и возвращаемое значение в формате, принятом стандартом 1С ' +
      '(секции «Параметры», «Возвращаемое значение»).',
  });
}

/** Оператор Перейти запрещён стандартами разработки. */
function detectGoto(ctx) {
  const { tokens, source } = ctx;
  for (const [i, token] of tokens.entries()) {
    if (token.type !== TOKEN.KEYWORD || token.keyword !== 'goto') continue;
    ctx.report({
      ruleId: 'std.goto',
      title: 'Использование оператора Перейти',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail: 'Безусловный переход запрещён стандартами разработки 1С: он ломает структуру кода и затрудняет анализ.',
      recommendation: 'Замените на структурные конструкции: Если/Иначе, Продолжить, Прервать, Возврат.',
      snippet: snippetAt(source, token.line),
    });
    void i;
  }
}

/** Сообщить() устарел: не работает в фоновых заданиях предсказуемо. */
function detectDirectMessageCalls(ctx) {
  const { tokens, source } = ctx;
  let count = 0;
  let firstLine = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const name = token.value.toLowerCase();
    if (name !== 'сообщить' && name !== 'message') continue;
    if (tokens[i + 1]?.value !== '(') continue;
    count += 1;
    if (!firstLine) firstLine = token.line;
  }

  if (count === 0) return;
  ctx.report({
    ruleId: 'std.deprecated-message',
    title: `Использование устаревшего метода Сообщить() (${count})`,
    severity: SEVERITY.LOW,
    category: CATEGORY.STANDARDS,
    line: firstLine,
    detail:
      `Метод Сообщить() вызывается ${count} раз(а). Он не позволяет привязать сообщение к реквизиту формы ` +
      'и ведёт себя непредсказуемо в фоновых заданиях.',
    recommendation: 'Используйте объект СообщениеПользователю с указанием поля и ключа данных.',
    snippet: snippetAt(source, firstLine),
  });
}

/**
 * В модулях форм каждая процедура должна иметь директиву компиляции.
 * Без неё процедура компилируется «на клиенте», что часто не то, что задумано.
 */
function detectMissingCompilationDirectives(ctx) {
  const { structure, module } = ctx;
  if (module.moduleType !== 'form') return;

  const missing = structure.routines.filter((r) => r.directives.length === 0);
  if (!missing.length) return;

  ctx.report({
    ruleId: 'std.missing-directive',
    title: `Процедуры формы без директивы компиляции: ${missing.length}`,
    severity: SEVERITY.LOW,
    category: CATEGORY.STANDARDS,
    line: missing[0].startLine,
    detail:
      `${missing.length} процедур(ы) объявлены без &НаКлиенте/&НаСервере/&НаСервереБезКонтекста ` +
      `(например, «${missing[0].name}»). Такие процедуры компилируются на клиенте.`,
    recommendation:
      'Проставьте директивы явно. Для процедур, не использующих данные формы, ' +
      'предпочитайте &НаСервереБезКонтекста — это снижает объём передаваемых данных.',
  });
}

/** Перехват исключения без записи в журнал регистрации. */
function detectSilentCatchWithoutLog(ctx) {
  const { tokens, structure, source } = ctx;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.KEYWORD || token.keyword !== 'except') continue;

    let logged = false;
    let hasBody = false;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.type === TOKEN.KEYWORD && t.keyword === 'endtry') break;
      hasBody = true;
      if (t.type === TOKEN.IDENT) {
        const name = t.value.toLowerCase();
        if (name === 'записьжурналарегистрации' || name === 'writelogevent'
          || name === 'вызватьисключение' || name === 'raise') {
          logged = true;
          break;
        }
      }
      if (t.type === TOKEN.KEYWORD && t.keyword === 'raise') { logged = true; break; }
    }

    // Полностью пустой блок уже покрыт правилом arch.empty-except.
    if (!hasBody || logged) continue;

    const routine = findEnclosingRoutine(structure.routines, i);
    ctx.report({
      ruleId: 'std.catch-without-log',
      title: 'Исключение обрабатывается без записи в журнал регистрации',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail:
        `Блок «Исключение»${routine ? ` в процедуре «${routine.name}»` : ''} содержит код, ` +
        'но не записывает информацию об ошибке в журнал регистрации и не пробрасывает исключение. ' +
        'Причина сбоя будет потеряна.',
      recommendation:
        'Добавьте ЗаписьЖурналаРегистрации() с ПодробноеПредставлениеОшибки(ИнформацияОбОшибке()) — ' +
        'это требование стандартов 1С к обработке исключений.',
      snippet: snippetAt(source, token.line, 1),
    });
  }
}
