/**
 * Правила регламента разработки проекта.
 *
 * Набор работает, только когда пользователь выбрал MD-файл регламента: без
 * него `ctx.policy` пуст и правила молча выходят — отчёт остаётся ровно таким,
 * каким был. Логика каждой проверки статична, а её **состав** приходит
 * из файла: список запрещённых методов, перечень областей, набор пределов.
 * Дописанная в регламенте строка начинает работать сразу, без правки кода.
 *
 * Уровень критичности у замечания тоже проектный: он взят из блока правила.
 * В отчёте у такого замечания стоит ссылка на пункт регламента — читатель
 * должен видеть, что требование пришло из документа проекта.
 *
 * Что важно про изменённые типовые модули: правила видят там ТОЛЬКО строки
 * правки (`ctx.partialSource`). Проверки, считающие по модулю целиком —
 * состав областей, размер, — на таком тексте не выполняются: областей вендора
 * в нём нет, и любое замечание было бы ложью. Исключение сделано для области
 * добавленного функционала: ей нужен весь модуль, и она берёт `ctx.fullSource`.
 */

import { TOKEN } from '../bsl/lexer.js';
import { SEVERITY, CATEGORY, snippetAt } from './context.js';
import { DATE_RE, TICKET_RE, SURNAME_INITIALS_RE } from '../bsl/markerDictionary.js';
import { listOf, pairsOf, safePattern } from '../../policy/parsePolicy.js';
import {
  LIMIT_KINDS, FORMAT_RULES, MARKER_PARTS, MODULE_TYPE_BY_RU,
} from '../../policy/catalog.js';

export const id = 'policy';

export function run(ctx) {
  const policy = ctx.policy;
  if (!policy?.rules?.size) return;

  const active = (code) => {
    const rule = policy.rules.get(code);
    return rule && !rule.disabled ? rule : null;
  };

  checkChangeMarker(ctx, active('policy.change-marker'), policy);
  checkClosingMarker(ctx, active('policy.change-marker-closing'));
  checkRegions(ctx, active('policy.module-regions'));
  checkEmptyRegions(ctx, active('policy.empty-regions'));
  checkAddedCodeRegion(ctx, active('policy.added-code-region'));
  checkExtensionGuard(ctx, active('policy.extension-guard'));
  checkForbiddenMethods(ctx, active('policy.forbidden-methods'));
  checkForbiddenText(ctx, active('policy.forbidden-text'));
  checkLimits(ctx, active('policy.limits'));
  checkFormatting(ctx, active('policy.formatting'));
}

/** Замечание по регламенту: уровень, категория и ссылка на пункт — общие. */
function report(ctx, rule, finding) {
  ctx.report({
    ruleId: finding.ruleId || rule.code,
    // Код блока в регламенте: по нему отчёт находит пункт, а `applyPolicy`
    // отличает замечание регламента от встроенного.
    policyCode: rule.code,
    policyRef: rule.section || null,
    severity: rule.severity || SEVERITY.MEDIUM,
    category: CATEGORY.POLICY,
    ...finding,
    recommendation: finding.recommendation
      || (rule.text ? rule.text : 'Приведите код в соответствие с регламентом разработки проекта.'),
  });
}

// --- Пометки изменений --------------------------------------------------------

/**
 * Пометка вида «// ++» → выражение, терпимое к пробелам.
 *
 * И заданное значение, и значение по умолчанию экранируются одинаково:
 * это обычный текст пометки, а не готовое регулярное выражение.
 */
function markerRe(value, fallback) {
  const text = String(value || fallback).replace(/^\s*\/\/+\s*/, '').trim() || fallback;
  return new RegExp(`^\\s*//+\\s*${escapeRe(text)}`);
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Формат пометки изменения: префикс, фамилия, дата, номер задачи.
 *
 * Проверяется состав, а не порядок: порядок в регламентах разный, а требование
 * везде одно — по пометке должно быть понятно, кто, когда и по какой задаче
 * правил код.
 */
function checkChangeMarker(ctx, rule, policy) {
  if (!rule) return;

  const open = markerRe(rule.params['открывающая пометка'], '++');
  const parts = new Set(listOf(rule.params['состав']).map((p) => MARKER_PARTS.get(p.toLowerCase())).filter(Boolean));
  if (!parts.size) return;
  const ticketRe = safePattern(rule.params['маска номера задачи'], null, '') || TICKET_RE;
  const prefix = String(policy.prefix || '').toLowerCase();

  for (const comment of ctx.comments) {
    if (!open.test(comment.value)) continue;
    const body = comment.value.replace(open, '').trim();

    const missing = [];
    if (parts.has('prefix') && prefix && !body.toLowerCase().includes(prefix)) {
      missing.push(`префикс «${policy.prefix}»`);
    }
    if (parts.has('author') && !SURNAME_INITIALS_RE.test(body)) missing.push('фамилия с инициалами');
    if (parts.has('date') && !DATE_RE.test(body)) missing.push('дата');
    if (parts.has('ticket') && !ticketRe.test(body)) missing.push('номер задачи');
    if (!missing.length) continue;

    report(ctx, rule, {
      title: `Пометка изменения неполна: нет ${missing.join(', ')}`,
      line: comment.line,
      detail:
        `В пометке «${body.slice(0, 120)}» не хватает: ${missing.join(', ')}. `
        + 'По пометке восстанавливают, кто и по какой задаче правил типовой код.',
      snippet: snippetAt(ctx.source, comment.line),
    });
  }
}

/**
 * Закрывающая пометка: на одних проектах обязательна, на других запрещена.
 *
 * Это тот самый случай, ради которого регламент и делается файлом: логика
 * проверки одна, а требование прямо противоположное.
 */
function checkClosingMarker(ctx, rule) {
  if (!rule) return;
  const mode = String(rule.params['закрывающая пометка'] || '').toLowerCase();
  if (!mode) return;

  const open = markerRe('++', '++');
  const close = markerRe('--', '--');
  const opened = ctx.comments.filter((c) => open.test(c.value));
  const closed = ctx.comments.filter((c) => close.test(c.value));

  if (mode.startsWith('запрещ')) {
    for (const comment of closed) {
      report(ctx, rule, {
        title: 'Закрывающая пометка изменения не используется на проекте',
        line: comment.line,
        detail: 'Регламент проекта оставляет только открывающую пометку перед объявлением метода.',
        snippet: snippetAt(ctx.source, comment.line),
      });
    }
    return;
  }

  if (!mode.startsWith('обязат')) return;
  // Пары считаются по порядку: закрывающая пометка относится к ближайшей
  // открывающей выше. Незакрытыми остаются лишние открывающие.
  let free = [...closed];
  for (const mark of opened) {
    const at = free.findIndex((c) => c.line > mark.line);
    if (at >= 0) { free = free.slice(at + 1); continue; }
    report(ctx, rule, {
      title: 'Блок изменений не закрыт пометкой',
      line: mark.line,
      detail: 'У пометки нет парной закрывающей: границу правки не видно.',
      snippet: snippetAt(ctx.source, mark.line),
    });
  }
}

// --- Области ------------------------------------------------------------------

/** Имена областей модуля в порядке появления. */
function regionNames(preprocessor) {
  const names = [];
  for (const entry of preprocessor || []) {
    const match = /^#\s*(?:Область|Region)\s+(.+)$/i.exec(entry.text.trim());
    if (match) names.push({ name: match[1].trim(), line: entry.line });
  }
  return names;
}

/** Область разрешена: точное совпадение либо шаблон с «*» на конце. */
function regionAllowed(name, allowed) {
  return allowed.some((pattern) => (pattern.endsWith('*')
    ? name.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase())
    : name.toLowerCase() === pattern.toLowerCase()));
}

function checkRegions(ctx, rule) {
  // Состав областей — свойство модуля целиком. У изменённого типового модуля
  // виден только кусок правки, и судить по нему о структуре модуля нельзя.
  if (!rule || ctx.partialSource) return;
  if (!ctx.stats.codeLines) return;

  const present = regionNames(ctx.structure.preprocessor);
  const allowed = listOf(rule.params['разрешённые области']);

  if (allowed.length) {
    for (const region of present) {
      if (regionAllowed(region.name, allowed)) continue;
      report(ctx, rule, {
        title: `Область «${region.name}» не предусмотрена регламентом`,
        line: region.line,
        detail:
          `Регламент проекта перечисляет допустимые области модуля; «${region.name}» в перечень не входит. `
          + 'Единообразие областей позволяет находить код на том же месте в любом модуле.',
      });
    }
  }

  for (const pair of pairsOf(rule.params['обязательные области'])) {
    if (MODULE_TYPE_BY_RU.get(pair.from.toLowerCase()) !== ctx.module.moduleType) continue;
    const names = pair.to.split(',').map((s) => s.trim()).filter(Boolean);
    const missing = names.filter((name) => !present.some((r) => r.name.toLowerCase() === name.toLowerCase()));
    if (!missing.length) continue;
    report(ctx, rule, {
      title: `В модуле нет обязательных областей: ${missing.join(', ')}`,
      detail:
        `Регламент требует для этого вида модуля области: ${names.join(', ')}. `
        + `Не найдены: ${missing.join(', ')}.`,
    });
  }
}

function checkEmptyRegions(ctx, rule) {
  if (!rule || ctx.partialSource) return;
  if (!String(rule.params['пустые области'] || '').toLowerCase().startsWith('запрещ')) return;

  const stack = [];
  const empty = [];
  for (const entry of ctx.structure.preprocessor || []) {
    const text = entry.text.trim();
    const open = /^#\s*(?:Область|Region)\s+(.+)$/i.exec(text);
    if (open) { stack.push({ name: open[1].trim(), line: entry.line }); continue; }
    if (!/^#\s*(?:КонецОбласти|EndRegion)/i.test(text)) continue;
    const region = stack.pop();
    if (region) empty.push({ ...region, endLine: entry.line });
  }

  for (const region of empty) {
    // Инструкции препроцессора и директивы компиляции кодом не считаются:
    // иначе внешняя область с пустой внутренней выглядела бы наполненной.
    const hasCode = ctx.tokens.some((t) => t.line > region.line && t.line < region.endLine
      && t.type !== TOKEN.PREPROC && t.type !== TOKEN.DIRECTIVE);
    if (hasCode) continue;
    report(ctx, rule, {
      title: `Пустая область «${region.name}»`,
      line: region.line,
      detail:
        `Между «#Область ${region.name}» (строка ${region.line}) и «#КонецОбласти» (строка ${region.endLine}) `
        + 'нет кода. Пустая область — след незаконченной правки.',
    });
  }
}

/**
 * Область добавленного функционала.
 *
 * Единственная проверка регламента, которой нужен модуль ЦЕЛИКОМ даже
 * у изменённого типового: смысл требования в том, где лежит вставка
 * относительно всего модуля.
 */
function checkAddedCodeRegion(ctx, rule) {
  if (!rule) return;
  const name = String(rule.params['область добавленного кода'] || '').trim();
  if (!name) return;

  const inExtension = String(rule.params['область добавленного кода в расширении'] || '').toLowerCase();
  // Граница слова `\b` здесь не годится: в JS это граница ASCII-слова,
  // и после кириллической буквы её нет вовсе — имя области с русскими
  // буквами не находилось бы никогда.
  const found = new RegExp(`#\\s*(?:Область|Region)\\s+${escapeRe(name)}(?=\\s|$)`, 'i')
    .test(ctx.fullSource);

  if (ctx.module.extensionName) {
    if (!inExtension.startsWith('запрещ') || !found) return;
    report(ctx, rule, {
      title: `Область «${name}» в расширении не используется`,
      detail:
        'Собственные методы расширения размещаются в стандартных областях, а иерархия областей '
        + 'заимствованной типовой процедуры переносится в расширение полностью.',
    });
    return;
  }

  // Типовой модуль основной конфигурации со вставкой интегратора.
  if (!ctx.partialSource || found) return;
  const line = firstMeaningfulLine(ctx.source);
  report(ctx, rule, {
    title: `Добавленный код вне области «${name}»`,
    line,
    detail:
      `Регламент требует собирать новые процедуры и функции типового модуля в области «${name}» `
      + 'в конце модуля: так их видно и они не мешают обновлению.',
    snippet: line ? snippetAt(ctx.source, line) : undefined,
  });
}

function checkExtensionGuard(ctx, rule) {
  if (!rule || !ctx.module.extensionName) return;
  const expected = String(rule.params['первая строка'] || '').trim();
  if (!expected) return;

  const kinds = listOf(rule.params['виды модулей'])
    .map((k) => MODULE_TYPE_BY_RU.get(k.toLowerCase()))
    .filter(Boolean);
  if (kinds.length && !kinds.includes(ctx.module.moduleType)) return;
  if (!ctx.stats.codeLines) return;

  const first = (ctx.fullSource.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('//')) || '').trim();
  if (normalizeSpaces(first) === normalizeSpaces(expected)) return;

  report(ctx, rule, {
    title: 'Модуль расширения без инструкции препроцессора в первой строке',
    line: 1,
    detail:
      `Первой строкой модуля регламент требует «${expected}». Сейчас первая строка кода — `
      + `«${first.slice(0, 120) || 'пусто'}».`,
  });
}

// --- Списки методов, записей, пределов ---------------------------------------

function checkForbiddenMethods(ctx, rule) {
  if (!rule) return;
  const replacements = new Map(pairsOf(rule.params['замены']).map((p) => [p.from.toLowerCase(), p.to]));
  if (!replacements.size) return;

  for (let i = 0; i < ctx.tokens.length; i += 1) {
    const token = ctx.tokens[i];
    if (token.type !== TOKEN.IDENT && token.type !== TOKEN.KEYWORD) continue;
    const replacement = replacements.get(String(token.value).toLowerCase());
    if (replacement === undefined) continue;
    // Обращение через точку — метод коллекции или объекта: «Массив.Найти(…)»
    // запрещённым методом платформы не является. Там, где одна и та же запись
    // бывает и проблемой, и нормой, правило молчит.
    if (ctx.tokens[i - 1]?.type === TOKEN.OPERATOR && ctx.tokens[i - 1].value === '.') continue;
    if (token.type === TOKEN.IDENT && ctx.tokens[i + 1]?.value !== '(') continue;

    report(ctx, rule, {
      title: `Метод ${token.value} использовать нельзя`,
      line: token.line,
      detail: replacement
        ? `Регламент проекта требует заменить ${token.value} на ${replacement}.`
        : `Регламент проекта запрещает использовать ${token.value}.`,
      recommendation: replacement ? `Используйте ${replacement}.` : rule.text || undefined,
      snippet: snippetAt(ctx.source, token.line),
    });
  }
}

/**
 * Запрещённые записи в тексте модуля.
 *
 * Запись ищется подстрокой; запись, взятая в косые черты, — регулярным
 * выражением. Так требование, которого мы не предвидели, всё равно
 * проверяется: «не использовать &Вместо», «не оставлять КонецПроцедуры //--».
 */
function checkForbiddenText(ctx, rule) {
  if (!rule) return;
  const entries = pairsOf(rule.params['записи']);
  if (!entries.length) return;

  const lines = ctx.source.split(/\r?\n/);
  for (const entry of entries) {
    const asRegExp = entry.from.length > 2 && entry.from.startsWith('/') && entry.from.endsWith('/')
      ? safePattern(entry.from.slice(1, -1), null, '')
      : null;
    const needle = entry.from.toLowerCase();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      const hit = asRegExp ? asRegExp.test(line) : line.toLowerCase().includes(needle);
      if (!hit) continue;
      report(ctx, rule, {
        title: `Запись «${entry.from}» запрещена регламентом`,
        line: i + 1,
        detail: entry.to || 'Регламент проекта запрещает эту запись.',
        snippet: snippetAt(ctx.source, i + 1),
      });
    }
  }
}

function checkLimits(ctx, rule) {
  if (!rule) return;

  for (const pair of pairsOf(rule.params['пределы'])) {
    const kind = LIMIT_KINDS.get(pair.from.toLowerCase());
    const limit = Number(String(pair.to).replace(',', '.'));
    if (!kind || !Number.isFinite(limit) || limit <= 0) continue;
    const common = { ruleId: `policy.limit.${kind.id}` };

    if (kind.id === 'module-lines') {
      if (ctx.partialSource || ctx.stats.codeLines <= limit) continue;
      report(ctx, rule, {
        ...common,
        title: `${kind.title}: ${ctx.stats.codeLines} строк при пределе ${limit}`,
        detail: `Регламент проекта ограничивает модуль ${limit} строками кода.`,
      });
      continue;
    }

    if (kind.id === 'query-lines') {
      for (const query of ctx.queries) {
        const count = query.text.split('\n').length;
        if (count <= limit) continue;
        report(ctx, rule, {
          ...common,
          title: `${kind.title}: ${count} строк при пределе ${limit}`,
          line: query.line,
          detail:
            `Запрос длиной ${count} строк записан прямо в коде. Регламент требует выносить запросы `
            + `длиннее ${limit} строк в отдельные функции.`,
          snippet: snippetAt(ctx.source, query.line),
        });
      }
      continue;
    }

    for (const routine of ctx.structure.routines) {
      const value = kind.id === 'routine-lines' ? routine.lines
        : kind.id === 'params' ? routine.params.length
          : routine.maxNesting;
      if (value <= limit) continue;
      report(ctx, rule, {
        ...common,
        title: `${kind.title}: «${routine.name}» — ${value} при пределе ${limit}`,
        line: routine.startLine,
        detail: `Регламент проекта ограничивает показатель «${pair.from}» значением ${limit}.`,
      });
    }
  }
}

function checkFormatting(ctx, rule) {
  if (!rule) return;
  const wanted = new Set(listOf(rule.params['требования'])
    .map((r) => FORMAT_RULES.get(r.toLowerCase())).filter(Boolean));
  if (!wanted.size) return;

  if (wanted.has('tabs')) checkTabs(ctx, rule);
  if (wanted.has('one-statement')) checkOneStatement(ctx, rule);
  if (wanted.has('identifier-language')) checkIdentifierLanguage(ctx, rule);
}

/**
 * Отступ табуляцией.
 *
 * Одна-две строки с пробелами — случайность при копировании, и замечание
 * о них было бы шумом. Замечание одно на модуль и только когда пробельных
 * отступов действительно много. Строки продолжения строкового литерала
 * (начинаются с «|») не считаются: их выравнивают как придётся.
 */
const SPACE_INDENT_MIN = 3;

function checkTabs(ctx, rule) {
  const lines = ctx.source.split(/\r?\n/);
  const spaced = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^ {2,}\S/.test(lines[i])) continue;
    if (lines[i].trim().startsWith('|')) continue;
    spaced.push(i + 1);
  }
  if (spaced.length < SPACE_INDENT_MIN) return;

  report(ctx, rule, {
    ruleId: 'policy.format.tabs',
    title: `Отступы пробелами вместо табуляции: строк ${spaced.length}`,
    line: spaced[0],
    detail:
      `Регламент проекта требует отступов табуляцией. Пробельные отступы найдены в ${spaced.length} строках, `
      + `первая — ${spaced[0]}.`,
    snippet: snippetAt(ctx.source, spaced[0]),
  });
}

function checkOneStatement(ctx, rule) {
  const perLine = new Map();
  for (const token of ctx.tokens) {
    if (token.type !== TOKEN.OPERATOR || token.value !== ';') continue;
    perLine.set(token.line, (perLine.get(token.line) || 0) + 1);
  }

  for (const [line, count] of perLine) {
    if (count < 2) continue;
    report(ctx, rule, {
      ruleId: 'policy.format.one-statement',
      title: `В строке ${count} оператора`,
      line,
      detail: 'Регламент проекта требует размещать на строке один оператор: так читается изменение в сравнении версий.',
      snippet: snippetAt(ctx.source, line),
    });
  }
}

function checkIdentifierLanguage(ctx, rule) {
  for (const routine of ctx.structure.routines) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(routine.name)) continue;
    report(ctx, rule, {
      ruleId: 'policy.format.identifier-language',
      title: `Имя метода латиницей: «${routine.name}»`,
      line: routine.startLine,
      detail: 'Регламент проекта требует писать тексты модулей и имена на русском языке.',
    });
  }
}

function firstMeaningfulLine(source) {
  const lines = String(source || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim()) return i + 1;
  }
  return 0;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
