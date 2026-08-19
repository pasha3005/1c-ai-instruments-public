/**
 * Разбор регламента разработки: MD-файл → набор правил.
 *
 * Файл читают двое. Человек — как обычный Markdown: заголовки, абзацы,
 * таблицы. Программа — только огороженные блоки ```регламент``` (шапка)
 * и ```правило``` (одно правило). Всё остальное для разбора не существует,
 * поэтому регламент можно писать как живой документ, а не как конфигурацию.
 *
 * Внутри блока — «ключ: значение» и списки строками «  - элемент». Элемент
 * вида «а -> б» разбирается в пару: так записаны таблицы замен методов
 * и пределы. Хвостовых комментариев НЕТ намеренно: `#` начинает комментарий
 * только в начале строки, иначе развалилась бы маска номера задачи (`#\d+`).
 *
 * Разбор ничего не читает с диска и ничего не запускает — чистая функция,
 * покрываемая тестами целиком.
 */

import {
  CHECK_BY_CODE, BUILTIN_RULE_SET, SEVERITY_BY_RU, YES,
} from './catalog.js';

/** Сколько символов маски регулярного выражения принимается из файла. */
const MAX_PATTERN_CHARS = 200;

/**
 * @param {string} markdown текст файла регламента
 * @returns {object} разобранный регламент
 */
export function parsePolicy(markdown) {
  const text = String(markdown ?? '');
  const lines = text.split(/\r?\n/);

  const policy = {
    name: '',
    version: '',
    /** `extend` — дополняет встроенные правила, `replace` — заменяет их. */
    mode: 'extend',
    prefix: '',
    /** code → правило регламента. */
    rules: new Map(),
    /** Коды, которых нет в каталоге программы: проверены не будут. */
    unknown: [],
    /** Что в файле не понято: показывается в отчёте и в журнале прогона. */
    errors: [],
    /** Блоков всего — чтобы отличить «файл не про регламент» от пустого. */
    blocks: 0,
  };

  let heading = '';
  let paragraph = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      heading = headingMatch[1].trim();
      paragraph = [];
      continue;
    }

    const fence = /^(`{3,})\s*(регламент|правило)\s*$/.exec(line.trim());
    if (!fence) {
      // Проза перед блоком становится текстом замечания в отчёте: правило
      // должно звучать словами регламента, а не нашими.
      if (line.trim()) paragraph.push(line.trim());
      else if (paragraph.length) paragraph = [];
      continue;
    }

    const body = [];
    let closed = false;
    for (i += 1; i < lines.length; i += 1) {
      if (new RegExp(`^${fence[1]}\`*\\s*$`).test(lines[i].trim())) { closed = true; break; }
      body.push(lines[i]);
    }
    if (!closed) {
      policy.errors.push(`Блок «${fence[2]}» не закрыт до конца файла.`);
      break;
    }

    policy.blocks += 1;
    const fields = parseFields(body, policy.errors);
    if (fence[2] === 'регламент') applyHeader(policy, fields);
    else applyRule(policy, fields, { heading, text: paragraph.join(' ') });
    paragraph = [];
  }

  return policy;
}

/** Шапка регламента: название, версия, режим, префикс доработок. */
function applyHeader(policy, fields) {
  policy.name = text(fields, 'название') || policy.name;
  policy.version = text(fields, 'версия') || policy.version;
  policy.prefix = text(fields, 'префикс доработок') || policy.prefix;

  const mode = text(fields, 'режим').toLowerCase();
  if (!mode) return;
  if (mode.startsWith('замен')) policy.mode = 'replace';
  else if (mode.startsWith('дополн')) policy.mode = 'extend';
  else policy.errors.push(`Режим «${mode}» не понят: ожидается «дополняет» или «заменяет».`);
}

/** Одно правило: код из каталога, уровень и параметры. */
function applyRule(policy, fields, place) {
  const code = text(fields, 'код');
  if (!code) {
    policy.errors.push(`Блок «правило» без кода${place.heading ? ` (раздел «${place.heading}»)` : ''} — пропущен.`);
    return;
  }

  const check = CHECK_BY_CODE.get(code);
  const builtin = BUILTIN_RULE_SET.has(code);
  if (!check && !builtin) {
    // Неизвестный код файл не ломает: правило пропускается, а отчёт называет
    // его поимённо. Продукт не утверждает того, чего не делал.
    policy.unknown.push({ code, section: place.heading });
    return;
  }

  const rule = policy.rules.get(code) || {
    code,
    builtin: builtin && !check,
    scope: check ? check.scope : 'builtin',
    severity: null,
    disabled: false,
    params: {},
    section: place.heading,
    text: place.text,
  };
  if (!rule.section && place.heading) rule.section = place.heading;
  if (!rule.text && place.text) rule.text = place.text;

  const level = text(fields, 'уровень').toLowerCase();
  if (level) {
    const severity = SEVERITY_BY_RU.get(level);
    if (severity) rule.severity = severity;
    else policy.errors.push(`Уровень «${level}» у правила ${code} не понят: критично, высокий, средний, низкий, информация.`);
  }
  if (YES.has(text(fields, 'выключено').toLowerCase())) rule.disabled = true;

  for (const [key, value] of fields) {
    if (key === 'код' || key === 'уровень' || key === 'выключено') continue;
    if (!check || !check.keys[key]) {
      policy.errors.push(`Параметр «${key}» у правила ${code} программе неизвестен и не учитывается.`);
      continue;
    }
    rule.params[key] = value;
  }

  policy.rules.set(code, rule);
}

/**
 * Тело блока → поля.
 *
 * Скаляр: «ключ: значение». Список: «ключ:» и дальше строки «  - элемент».
 * Значение скаляра берётся до конца строки целиком, вместе с двоеточиями
 * и решётками: маска номера задачи содержит и то, и другое.
 */
function parseFields(body, errors) {
  const fields = new Map();
  let listKey = null;

  for (const raw of body) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;

    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!listKey) {
        errors.push(`Строка списка «${item[1]}» стоит вне списка и пропущена.`);
        continue;
      }
      fields.get(listKey).push(item[1].trim());
      continue;
    }

    const field = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!field) {
      errors.push(`Строка «${line.trim()}» не разобрана: ожидается «ключ: значение».`);
      continue;
    }

    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    if (value) {
      fields.set(key, value);
      listKey = null;
      continue;
    }
    fields.set(key, []);
    listKey = key;
  }

  return fields;
}

function text(fields, key) {
  const value = fields.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Список строк «а -> б» → пары. Элемент без стрелки берётся целиком: у пределов
 * без значения смысла нет, а у запрещённых записей пояснение необязательно.
 */
export function pairsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map((line) => {
    const at = line.indexOf('->');
    if (at < 0) return { from: line.trim(), to: '' };
    return { from: line.slice(0, at).trim(), to: line.slice(at + 2).trim() };
  }).filter((pair) => pair.from);
}

/** Значение-список: одиночная строка тоже считается списком из одного. */
export function listOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Регулярное выражение из файла регламента.
 *
 * Выражение пишет человек, а работает оно на каждой строке каждого модуля,
 * поэтому: длина ограничена, ошибка разбора не роняет прогон, а превращается
 * в строку отчёта. Ищем без флага `g` — состояние `lastIndex` между вызовами
 * давало бы через раз ложное «нет совпадения».
 */
export function safePattern(source, errors, where) {
  const value = String(source ?? '').trim();
  if (!value) return null;
  if (value.length > MAX_PATTERN_CHARS) {
    errors?.push(`Выражение в «${where}» длиннее ${MAX_PATTERN_CHARS} символов и не используется.`);
    return null;
  }
  try {
    return new RegExp(value, 'i');
  } catch (err) {
    errors?.push(`Выражение «${value}» в «${where}» не разобрано: ${err.message}`);
    return null;
  }
}

/** Короткое описание регламента для отчёта и журнала. */
export function policySummary(policy) {
  if (!policy) return null;
  const active = [...policy.rules.values()].filter((r) => !r.disabled);
  return {
    name: policy.name,
    version: policy.version,
    mode: policy.mode,
    prefix: policy.prefix,
    rules: active.length,
    disabled: policy.rules.size - active.length,
    unknown: policy.unknown.map((u) => u.code),
    errors: policy.errors,
  };
}
