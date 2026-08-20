/**
 * Правила соответствия стандартам разработки 1С и требованиям БСП.
 *
 * Опорные документы: «Система стандартов и методик разработки конфигураций
 * для платформы 1С:Предприятие 8» и требования к внедрению Библиотеки
 * стандартных подсистем.
 */

import { TOKEN } from '../bsl/lexer.js';
import { findEnclosingRoutine } from '../bsl/structure.js';
import { looksLikeQuery } from '../bsl/query.js';
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
  detectCollectionSelfInsert(ctx);
  detectProcedureReturnsValue(ctx);
  detectSelfAssignment(ctx);
  detectTempFileNotDeleted(ctx);
  detectUnlocalizedUserMessage(ctx);
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
      'Стандарт ИТС 455 «Структура модуля» требует выделять программный интерфейс, служебные ' +
      'процедуры и обработчики событий отдельными областями: в модуле любого объекта код тогда ' +
      'лежит на одном и том же месте, и разработчик находит его, не читая модуль целиком.',
    recommendation:
      'Добавьте области: #Область ПрограммныйИнтерфейс, #Область СлужебныеПроцедурыИФункции, ' +
      '#Область ОбработчикиСобытий — в порядке, предусмотренном стандартом. Собственные области ' +
      'помимо стандартных стандарт не запрещает.',
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

/** Методы добавления в коллекцию: ими же коллекцию вставляют саму в себя. */
const INSERT_METHODS = new Set(['добавить', 'add', 'вставить', 'insert']);

/**
 * Коллекция вставляется сама в себя.
 *
 * `Массив.Добавить(Массив)` и `Структура.Вставить("Ключ", Структура)` создают
 * циклическую ссылку: обход такой коллекции не заканчивается, а сериализация
 * (в XDTO, в JSON, в хранилище значения) падает.
 */
function detectCollectionSelfInsert(ctx) {
  const { tokens, source } = ctx;

  for (let i = 0; i < tokens.length - 3; i += 1) {
    const owner = tokens[i];
    if (owner.type !== TOKEN.IDENT) continue;
    if (tokens[i + 1]?.value !== '.') continue;
    const method = tokens[i + 2];
    if (method?.type !== TOKEN.IDENT || !INSERT_METHODS.has(String(method.value).toLowerCase())) continue;
    if (tokens[i + 3]?.value !== '(') continue;
    // Цепочка через точку слева («Структура.Свойство.Добавить») — другой объект,
    // и совпадение имени о циклической вставке не говорит.
    if (tokens[i - 1]?.value === '.') continue;

    const name = String(owner.value).toLowerCase();
    let depth = 0;
    let found = null;
    for (let j = i + 3; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token.value === '(') { depth += 1; continue; }
      if (token.value === ')') { depth -= 1; if (depth <= 0) break; continue; }
      if (token.type !== TOKEN.IDENT || String(token.value).toLowerCase() !== name) continue;
      // Аргументом должна быть сама переменная, а не её свойство или метод:
      // «Массив.Добавить(Массив.Количество())» вставкой в себя не является.
      if (tokens[j - 1]?.value === '.' || tokens[j + 1]?.value === '.' || tokens[j + 1]?.value === '(') continue;
      found = token;
      break;
    }
    if (!found) continue;

    ctx.report({
      ruleId: 'std.collection-self-insert',
      title: `Коллекция «${owner.value}» вставляется сама в себя`,
      severity: SEVERITY.HIGH,
      category: CATEGORY.STANDARDS,
      line: found.line,
      detail:
        `Вызов ${owner.value}.${method.value}(…) получает аргументом саму коллекцию «${owner.value}». `
        + 'Получается циклическая ссылка: обход такой коллекции не заканчивается, '
        + 'а запись её в хранилище значения или сериализация приводят к ошибке.',
      recommendation: 'Вставляйте копию коллекции либо её элементы — но не саму коллекцию.',
      snippet: snippetAt(source, found.line),
    });
  }
}

/** Ключевые слова, которыми блок кончается: после них «Возврат» пуст. */
const BLOCK_ENDINGS = new Set([
  'endprocedure', 'endfunction', 'endif', 'enddo', 'endtry', 'else', 'elsif',
]);

/**
 * Процедура возвращает значение.
 *
 * Значение возвращает функция; `Возврат <выражение>` в процедуре платформа
 * не выполнит — при проверке конфигурации это ошибка.
 */
function detectProcedureReturnsValue(ctx) {
  const { tokens, structure, source } = ctx;

  for (const routine of structure.routines) {
    if (routine.kind !== 'procedure') continue;
    for (let i = routine.bodyStartIdx; i <= routine.endIdx && i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type !== TOKEN.KEYWORD || token.keyword !== 'return') continue;
      const next = tokens[i + 1];
      // «Возврат;» и «Возврат» перед концом блока — обычный выход. А вот
      // «Возврат Истина» — уже значение, хотя «Истина» тоже ключевое слово.
      if (!next || next.value === ';') continue;
      if (next.type === TOKEN.KEYWORD && BLOCK_ENDINGS.has(next.keyword)) continue;

      ctx.report({
        ruleId: 'std.procedure-returns-value',
        title: `Процедура «${routine.name}» возвращает значение`,
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.STANDARDS,
        line: token.line,
        detail:
          `В процедуре «${routine.name}» стоит «Возврат» со значением. Возвращать значение может `
          + 'только функция; проверка конфигурации сообщит об ошибке.',
        recommendation: 'Объявите метод функцией либо уберите значение из оператора Возврат.',
        snippet: snippetAt(source, token.line),
      });
    }
  }
}

/**
 * Присваивание переменной её собственного значения.
 *
 * `А = А;` — почти всегда след потерянной правки: в правой части должно было
 * стоять другое. Смотрим только строки, где присваивание занимает строку
 * целиком: так знак равенства не спутать со сравнением.
 */
function detectSelfAssignment(ctx) {
  const { tokens, source } = ctx;

  const byLine = new Map();
  for (const token of tokens) {
    if (!byLine.has(token.line)) byLine.set(token.line, []);
    byLine.get(token.line).push(token);
  }

  for (const [line, list] of byLine) {
    const eq = list.findIndex((t) => t.type === TOKEN.OPERATOR && t.value === '=');
    if (eq <= 0) continue;
    const tail = list[list.length - 1];
    if (tail.type !== TOKEN.OPERATOR || tail.value !== ';') continue;

    const left = list.slice(0, eq);
    const right = list.slice(eq + 1, list.length - 1);
    if (!left.length || left.length !== right.length) continue;
    if (!left.every((t, i) => sameToken(t, right[i]))) continue;
    // Цепочка из имён и точек: вызовы и индексы могут возвращать разное,
    // и «Список[0] = Список[0]» бессмысленным считать нельзя.
    if (!left.every((t) => t.type === TOKEN.IDENT || (t.type === TOKEN.OPERATOR && t.value === '.'))) continue;

    ctx.report({
      ruleId: 'std.self-assignment',
      title: 'Переменной присваивается её собственное значение',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.STANDARDS,
      line,
      detail:
        `Строка ${line} присваивает «${left.map((t) => t.value).join('')}» самому себе. Такая строка ничего `
        + 'не делает и обычно означает потерянную правку.',
      recommendation: 'Уберите строку либо допишите выражение, которое должно было стоять справа.',
      snippet: snippetAt(source, line),
    });
  }
}

function sameToken(a, b) {
  return a.type === b.type && String(a.value).toLowerCase() === String(b.value).toLowerCase();
}

const TEMP_FILE_METHODS = new Set(['получитьимявременногофайла', 'gettempfilename']);
const FILE_DELETE_METHODS = new Set([
  'удалитьфайлы', 'deletefiles', 'начатьудалениефайлов', 'begindeletingfiles',
]);

/**
 * Временный файл не удаляется.
 *
 * Каталог временных файлов на сервере 1С растёт, пока не кончится место.
 * Метод, который ВОЗВРАЩАЕТ имя файла, не проверяется: удаляет его вызывающий,
 * и требовать удаления здесь было бы ошибкой.
 */
function detectTempFileNotDeleted(ctx) {
  const { tokens, structure, source } = ctx;

  for (const routine of structure.routines) {
    let created = null;
    let deleted = false;
    let returnsValue = false;

    for (let i = routine.bodyStartIdx; i <= routine.endIdx && i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type === TOKEN.KEYWORD && token.keyword === 'return') {
        const next = tokens[i + 1];
        if (next && next.value !== ';' && next.type !== TOKEN.KEYWORD) returnsValue = true;
        continue;
      }
      if (token.type !== TOKEN.IDENT) continue;
      const name = String(token.value).toLowerCase();
      if (!created && TEMP_FILE_METHODS.has(name)) created = token;
      if (FILE_DELETE_METHODS.has(name)) deleted = true;
    }

    if (!created || deleted || returnsValue) continue;
    ctx.report({
      ruleId: 'std.temp-file-not-deleted',
      title: `Временный файл не удаляется в «${routine.name}»`,
      severity: SEVERITY.LOW,
      category: CATEGORY.STANDARDS,
      line: created.line,
      detail:
        `В методе «${routine.name}» создаётся временный файл, но ни УдалитьФайлы(), `
        + 'ни НачатьУдалениеФайлов() не вызываются. Каталог временных файлов на сервере растёт, '
        + 'пока не кончится место на диске.',
      recommendation:
        'Удаляйте файл после использования — в блоке «Попытка … Исключение», чтобы удаление '
        + 'выполнялось и при ошибке.',
      snippet: snippetAt(source, created.line),
    });
  }
}

/** Методы, которыми текст показывают пользователю. */
const USER_MESSAGE_CALLS = new Set(['сообщить', 'message']);
/** Свойство, в которое кладут текст сообщения пользователю. */
const MESSAGE_TEXT_PROPS = new Set(['текст', 'text', 'заголовок', 'title', 'подсказка', 'tooltip']);

/**
 * Текст пользователю мимо НСтр().
 *
 * Проверяется только то, что заведомо видит пользователь: аргумент Сообщить(),
 * текст исключения и присваивание свойству «Текст». Строка без кириллицы
 * замечанием не считается — это служебное значение, а не фраза; текст запроса
 * тоже пропускается: «Запрос.Текст = "ВЫБРАТЬ …"» к локализации отношения
 * не имеет. Там, где одна и та же запись бывает и проблемой, и нормой,
 * правило молчит.
 */
function detectUnlocalizedUserMessage(ctx) {
  const { tokens, source } = ctx;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.STRING) continue;
    if (!/[А-Яа-яЁё]/.test(token.value)) continue;
    if (looksLikeQuery(token.value)) continue;

    const before = tokens[i - 1];
    if (!before) continue;

    let where = '';
    if (before.value === '(' && tokens[i - 2]?.type === TOKEN.IDENT
      && USER_MESSAGE_CALLS.has(String(tokens[i - 2].value).toLowerCase())) {
      where = `вызов ${tokens[i - 2].value}()`;
    } else if (before.type === TOKEN.KEYWORD && before.keyword === 'raise') {
      where = 'текст исключения';
    } else if (before.type === TOKEN.OPERATOR && before.value === '='
      && tokens[i - 2]?.type === TOKEN.IDENT && tokens[i - 3]?.value === '.'
      && MESSAGE_TEXT_PROPS.has(String(tokens[i - 2].value).toLowerCase())) {
      where = `свойство ${tokens[i - 4]?.value || ''}.${tokens[i - 2].value}`;
    }
    if (!where) continue;

    ctx.report({
      ruleId: 'std.unlocalized-user-message',
      title: 'Текст пользователю задан строкой, а не НСтр()',
      severity: SEVERITY.LOW,
      category: CATEGORY.STANDARDS,
      line: token.line,
      detail:
        `Строка «${token.value.slice(0, 80)}» показывается пользователю (${where}) прямым литералом. `
        + 'Такой текст не переводится и не собирается в общий словарь конфигурации.',
      recommendation:
        'Оформите текст через НСтр("ru = \'…\'; en = \'…\'"), а подстановки — через СтрШаблон().',
      snippet: snippetAt(source, token.line),
    });
  }
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
