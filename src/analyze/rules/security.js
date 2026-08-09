/**
 * Правила анализа безопасности.
 *
 * Проверяется работа с правами доступа, динамическое исполнение кода,
 * обращения к внешним компонентам и хранение секретов в коде.
 */

import { TOKEN } from '../bsl/lexer.js';
import { findEnclosingRoutine, readMemberChain } from '../bsl/structure.js';
import { SEVERITY, CATEGORY, snippetAt } from './context.js';

export const id = 'security';

export function run(ctx) {
  detectPrivilegedMode(ctx);
  detectDynamicExecution(ctx);
  detectExternalCodeLoading(ctx);
  detectComAndAddIns(ctx);
  detectHardcodedSecrets(ctx);
  detectPrivilegedCommonModule(ctx);
  detectSafeModeDisabling(ctx);
}

/**
 * Привилегированный режим отключает проверку прав.
 *
 * ВАЖНО, как платформа этим управляет: счётчик привилегированного режима
 * ведётся на стек вызовов, и **при выходе из процедуры, в которой режим был
 * включён, платформа восстанавливает его сама**. То есть отсутствие парного
 * УстановитьПривилегированныйРежим(Ложь) — НЕ утечка прав за пределы процедуры
 * и само по себе не является ошибкой. Раньше правило считало иначе и выдавало
 * высокую критичность — это было неверно.
 *
 * Что действительно стоит показать: насколько широк привилегированный участок.
 * Если режим включён в начале длинной процедуры и не выключен, без проверки
 * прав исполняется весь её остаток вместе со всем, что она вызывает. Это
 * замечание к качеству, а не дыра, поэтому низкая критичность и порог по
 * размеру остатка — короткие процедуры не засоряют отчёт.
 */
const PRIVILEGED_TAIL_LINES = 25;

function detectPrivilegedMode(ctx) {
  const { tokens, structure, source } = ctx;

  /** @type {Map<string, {on: number, off: number, firstLine: number, routine: object|null}>} */
  const perRoutine = new Map();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    if (token.value.toLowerCase() !== 'установитьпривилегированныйрежим'
      && token.value.toLowerCase() !== 'setprivilegedmode') continue;

    const argToken = tokens[i + 2];
    const enabling = argToken?.type === TOKEN.KEYWORD
      ? argToken.keyword === 'true'
      : true;

    const routine = findEnclosingRoutine(structure.routines, i);
    const key = routine ? routine.name : '<вне процедуры>';
    if (!perRoutine.has(key)) {
      perRoutine.set(key, { on: 0, off: 0, firstLine: token.line, routine });
    }
    const entry = perRoutine.get(key);
    if (enabling) entry.on += 1; else entry.off += 1;
  }

  for (const [routineName, entry] of perRoutine) {
    if (entry.on === 0) continue;
    if (entry.off >= entry.on) continue;

    // Вне процедуры (в теле модуля) режим действительно останется включённым
    // до конца вызова — вот это уже настоящая проблема.
    const outsideRoutine = !entry.routine;

    const tailLines = entry.routine
      ? Math.max(0, entry.routine.endLine - entry.firstLine)
      : 0;
    if (!outsideRoutine && tailLines < PRIVILEGED_TAIL_LINES) continue;

    ctx.report({
      ruleId: 'sec.unbalanced-privileged-mode',
      title: outsideRoutine
        ? 'Привилегированный режим включается вне процедуры'
        : `Привилегированный режим охватывает остаток процедуры «${routineName}» (${tailLines} строк)`,
      severity: outsideRoutine ? SEVERITY.HIGH : SEVERITY.LOW,
      category: CATEGORY.SECURITY,
      line: entry.firstLine,
      detail: outsideRoutine
        ? 'УстановитьПривилегированныйРежим(Истина) вызван в теле модуля, а не внутри процедуры. '
          + 'Автоматически режим снимается только при выходе из процедуры, в которой был включён, '
          + 'поэтому здесь он останется активным до конца вызова.'
        : `УстановитьПривилегированныйРежим(Истина) вызывается ${entry.on} раз(а), выключается ${entry.off}. `
          + 'За пределы процедуры режим не утекает — платформа восстанавливает его при выходе. '
          + `Но оставшиеся ${tailLines} строк процедуры и всё, что они вызывают, исполняются `
          + 'без проверки прав доступа и ограничений RLS.',
      recommendation: outsideRoutine
        ? 'Перенесите включение привилегированного режима внутрь процедуры.'
        : 'Ограничьте привилегированный участок минимальным блоком: включите режим непосредственно '
          + 'перед операцией, которой он нужен, и выключите сразу после неё.',
      snippet: snippetAt(source, entry.firstLine),
    });
  }
}

/**
 * Выполнить()/Вычислить() — исполнение произвольного кода во время работы.
 *
 * Опасен только глобальный оператор. Одноимённые МЕТОДЫ объектов платформы
 * (Запрос.Выполнить(), ПостроительОтчета.Выполнить(), ТабличныйДокумент.Вычислить())
 * никакого кода не исполняют, поэтому обращения через точку не учитываются —
 * иначе правило давало бы ложные срабатывания в каждом модуле с запросом.
 */
function detectDynamicExecution(ctx) {
  const { tokens, source } = ctx;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const isKeywordForm = token.type === TOKEN.KEYWORD
      && (token.keyword === 'execute' || token.keyword === 'eval');
    const isIdentForm = token.type === TOKEN.IDENT
      && ['выполнить', 'вычислить', 'execute', 'eval'].includes(token.value.toLowerCase());
    if (!isKeywordForm && !isIdentForm) continue;

    // Обращение через точку — это метод объекта, а не глобальный оператор.
    const prev = tokens[i - 1];
    if (prev?.type === TOKEN.OPERATOR && prev.value === '.') continue;

    // Учитываем только вызовы: Выполнить(<текст>).
    if (tokens[i + 1]?.value !== '(') continue;

    // Аргумент-литерал безопаснее, чем переменная с внешними данными.
    const argToken = tokens[i + 2];
    const literalArg = argToken?.type === TOKEN.STRING;

    ctx.report({
      ruleId: 'sec.dynamic-execution',
      title: `Динамическое исполнение кода (${token.value})`,
      severity: literalArg ? SEVERITY.MEDIUM : SEVERITY.HIGH,
      category: CATEGORY.SECURITY,
      line: token.line,
      detail:
        `Используется ${token.value}(). ` +
        (literalArg
          ? 'Аргумент — строковый литерал, риск внедрения ниже, но код остаётся непроверяемым при компиляции.'
          : 'Аргумент вычисляется во время работы: если в него попадают данные из базы или из интерфейса, ' +
            'возможно исполнение произвольного кода с правами текущего пользователя.'),
      recommendation:
        'Замените динамическое исполнение явным вызовом методов; если это невозможно — ' +
        'валидируйте источник строки и выполняйте её в безопасном режиме (УстановитьБезопасныйРежим).',
      snippet: snippetAt(source, token.line),
    });
  }
}

/** Загрузка внешних обработок — обход контроля версий и прав. */
function detectExternalCodeLoading(ctx) {
  const { tokens, source } = ctx;
  const targets = [
    'внешниеобработки.создать', 'externaldataprocessors.create',
    'внешниеотчеты.создать', 'externalreports.create',
    'внешниеобработки.подключить', 'externaldataprocessors.connect',
    'внешниеотчеты.подключить', 'externalreports.connect',
  ];

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== TOKEN.IDENT) continue;
    const chain = readMemberChain(tokens, i, 2);
    if (!targets.includes(chain)) continue;

    ctx.report({
      ruleId: 'sec.external-code-loading',
      title: 'Подключение внешней обработки из кода',
      severity: SEVERITY.HIGH,
      category: CATEGORY.SECURITY,
      line: tokens[i].line,
      detail:
        `Вызов «${chain}» загружает и выполняет код, которого нет в конфигурации. ` +
        'Такой код не проходит проверку при обновлении, не отслеживается в хранилище ' +
        'и может исполняться с повышенными правами.',
      recommendation:
        'Переведите функциональность в расширение конфигурации или в саму конфигурацию. ' +
        'Если внешние обработки необходимы, используйте механизм дополнительных отчётов и обработок БСП ' +
        'с проверкой безопасного режима и хранением в справочнике.',
      snippet: snippetAt(source, tokens[i].line),
    });
    i += 2;
  }
}

/** COM-объекты и внешние компоненты — выход за периметр платформы. */
function detectComAndAddIns(ctx) {
  const { tokens, source } = ctx;

  for (let i = 0; i < tokens.length - 2; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.KEYWORD || token.keyword !== 'new') continue;
    const typeToken = tokens[i + 1];
    if (typeToken?.type !== TOKEN.IDENT) continue;

    const typeName = typeToken.value.toLowerCase();
    if (typeName === 'comобъект' || typeName === 'comobject') {
      ctx.report({
        ruleId: 'sec.com-object',
        title: 'Создание COM-объекта',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.SECURITY,
        line: token.line,
        detail:
          'Новый COMОбъект выполняет код вне контроля платформы, требует регистрации компоненты ' +
          'на сервере и не работает на Linux-серверах 1С.',
        recommendation:
          'Оцените возможность замены на HTTP-сервис, внешнюю компоненту NativeAPI ' +
          'или штатные средства платформы. При переносе на Linux этот код потребует переработки.',
        snippet: snippetAt(source, token.line),
      });
    }
  }
}

/** Пароли и токены в исходном коде. */
function detectHardcodedSecrets(ctx) {
  const { tokens, source } = ctx;
  const secretNames = /^(пароль|password|pwd|токен|token|apikey|api_key|секрет|secret|ключдоступа)$/i;

  for (let i = 2; i < tokens.length; i += 1) {
    const value = tokens[i];
    if (value.type !== TOKEN.STRING || !value.value || value.value.length < 4) continue;
    const eq = tokens[i - 1];
    if (eq?.type !== TOKEN.OPERATOR || eq.value !== '=') continue;
    const name = tokens[i - 2];
    if (name?.type !== TOKEN.IDENT) continue;
    if (!secretNames.test(name.value)) continue;

    ctx.report({
      ruleId: 'sec.hardcoded-secret',
      title: `Секрет в исходном коде («${name.value}»)`,
      severity: SEVERITY.HIGH,
      category: CATEGORY.SECURITY,
      line: value.line,
      detail:
        `Переменной «${name.value}» присваивается строковый литерал. ` +
        'Секреты в конфигурации доступны всем, кто имеет доступ к конфигуратору или к выгрузке, ' +
        'и попадают в системы контроля версий.',
      recommendation:
        'Храните секреты в защищённом хранилище: регистр сведений с ограничением прав, ' +
        'константа с признаком «Пароль», или БСП-механизм «Безопасное хранилище данных».',
      // Сам секрет в отчёт не выводим.
      snippet: `${name.value} = "***";`,
    });
  }
}

/** Общий модуль с признаком «Привилегированный». */
function detectPrivilegedCommonModule(ctx) {
  const { module, configuration } = ctx;
  if (module.moduleType !== 'common' || !module.ownerName) return;

  const meta = configuration?.objectIndex?.get?.(`CommonModule.${module.ownerName}`);
  if (meta?.props?.Privileged !== 'true') return;

  ctx.report({
    ruleId: 'sec.privileged-common-module',
    title: `Общий модуль «${module.ownerName}» помечен как привилегированный`,
    severity: SEVERITY.MEDIUM,
    category: CATEGORY.SECURITY,
    detail:
      'Весь код модуля выполняется без проверки прав доступа. Любая новая процедура в нём ' +
      'автоматически получает полный доступ к данным.',
    recommendation:
      'Снимите признак «Привилегированный» с модуля и включайте привилегированный режим точечно, ' +
      'только вокруг операций, которым он действительно нужен.',
  });
}

/** Отключение безопасного режима. */
function detectSafeModeDisabling(ctx) {
  const { tokens, source } = ctx;

  for (let i = 0; i < tokens.length - 3; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT) continue;
    const name = token.value.toLowerCase();
    if (name !== 'установитьбезопасныйрежим' && name !== 'setsafemode') continue;

    const arg = tokens[i + 2];
    const disabling = arg?.type === TOKEN.KEYWORD && arg.keyword === 'false';
    if (!disabling) continue;

    ctx.report({
      ruleId: 'sec.safe-mode-disabled',
      title: 'Явное отключение безопасного режима',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.SECURITY,
      line: token.line,
      detail:
        'УстановитьБезопасныйРежим(Ложь) снимает ограничения на обращение к файловой системе, ' +
        'COM-объектам и внешним компонентам.',
      recommendation:
        'Убедитесь, что отключение действительно необходимо и область его действия минимальна; ' +
        'используйте профили безопасности кластера для контроля разрешённых операций.',
      snippet: snippetAt(source, token.line),
    });
  }
}
