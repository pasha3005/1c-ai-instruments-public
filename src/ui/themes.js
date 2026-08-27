/**
 * Темы оформления — один источник цвета на всю программу.
 *
 * Тем шесть: три семейства («Первый БИТ», «Индиго», «Нейтральная») в тёмном
 * и светлом виде. Выбранная тема красит И интерфейс, И отчёты, поэтому палитры
 * лежат здесь, а не в двух местах: разъехавшиеся «одинаковые» цвета —
 * обычнейший способ получить два разных продукта из одного.
 *
 * Как это устроено:
 *
 *  * `appThemeCss()` отдаёт таблицу стилей для интерфейса — блок `:root` с темой
 *    по умолчанию и по блоку `:root[data-theme="…"]` на каждую тему. Сервер
 *    отдаёт её по адресу `css/themes.css`; статикой она не лежит намеренно —
 *    иначе палитры пришлось бы держать в двух файлах;
 *  * `reportThemeCss()` — то же самое для отчётов, но набор переменных у них
 *    свой (уровни замечаний, обложка, значки процедур). Отчёт самодостаточен,
 *    и стили уходят внутрь файла;
 *  * различий между семействами ровно два: акцент и подтон поверхностей.
 *    Всё остальное — сигнальные цвета, радиусы, шрифты — общее, иначе тем
 *    стало бы шесть разных интерфейсов.
 *
 * **Подсветка кода в светлых темах — в манере конфигуратора 1С**: комментарии
 * зелёные, ключевые слова красные, строки цветом обычного текста, директивы
 * и аннотации сиреневые. Требование пользователя (27.08.2026): «светлые
 * варианты тем должны повторять оформление кода в стиле типовой 1С, а тёмные
 * варианты подсветки синтаксиса оставь как есть».
 */

/** Тема по умолчанию — та, с которой программа жила до появления выбора. */
export const DEFAULT_THEME = 'bit-dark';

/** Перечень тем в том порядке, в котором их показывают. */
export const THEMES = [
  { id: 'bit-dark', name: 'Первый БИТ тёмная', family: 'bit', mode: 'dark' },
  { id: 'bit-light', name: 'Первый БИТ светлая', family: 'bit', mode: 'light' },
  { id: 'indigo-dark', name: 'Индиго тёмная', family: 'indigo', mode: 'dark' },
  { id: 'indigo-light', name: 'Индиго светлая', family: 'indigo', mode: 'light' },
  { id: 'neutral-dark', name: 'Нейтральная тёмная', family: 'neutral', mode: 'dark' },
  { id: 'neutral-light', name: 'Нейтральная светлая', family: 'neutral', mode: 'light' },
];

/**
 * Старые значения темы отчёта.
 *
 * До появления выбора тем в прогонах хранилось `dark` либо `light`, и эти
 * прогоны никуда не делись: отчёт по ним пересобирается текущей версией
 * программы (`freshReport`), а значит значение надо понимать и сейчас.
 */
const ALIASES = { dark: 'bit-dark', light: 'bit-light' };

/** Тема по идентификатору — с поддержкой старых значений и запасным вариантом. */
export function resolveTheme(id) {
  const key = String(id || '').trim();
  const wanted = ALIASES[key] || key;
  return THEMES.find((t) => t.id === wanted) || THEMES.find((t) => t.id === DEFAULT_THEME);
}

/** Светлая ли тема — от этого зависит `color-scheme` и подсветка кода. */
export function isLight(id) {
  return resolveTheme(id).mode === 'light';
}

// --------------------------------------------------------------- Палитры

/**
 * Поверхности и текст. Отличие семейств — только подтон: у «Первого БИТа»
 * графит, у «Индиго» синева, у «Нейтральной» чистый серый.
 */
const SURFACES = {
  bit: {
    dark: {
      bg: '#15161b',
      surface: '#1c1d24',
      surface2: '#26272f',
      ink: '#e9ecf1',
      inkMid: '#cdd3de',
      inkSoft: '#a8b0bd',
      inkFaint: '#79818f',
      line: '#2e2f38',
      lineSoft: '#26272f',
    },
    light: {
      bg: '#f4f5f8',
      surface: '#ffffff',
      surface2: '#edeff4',
      ink: '#1a1d23',
      inkMid: '#333a45',
      inkSoft: '#4c5462',
      inkFaint: '#7c8494',
      line: '#e2e5ea',
      lineSoft: '#eef0f4',
    },
  },
  indigo: {
    dark: {
      bg: '#14161f',
      surface: '#1b1e2a',
      surface2: '#242838',
      ink: '#e8eaf3',
      inkMid: '#ccd1e2',
      inkSoft: '#a5abc2',
      inkFaint: '#767d96',
      line: '#2c3145',
      lineSoft: '#242838',
    },
    light: {
      bg: '#f4f6fb',
      surface: '#ffffff',
      surface2: '#eaeefa',
      ink: '#171a24',
      inkMid: '#313749',
      inkSoft: '#4a5266',
      inkFaint: '#79819a',
      line: '#dfe4f0',
      lineSoft: '#eaeefa',
    },
  },
  neutral: {
    dark: {
      bg: '#17181a',
      surface: '#1e1f22',
      surface2: '#27282c',
      ink: '#e9eaec',
      inkMid: '#cfd1d5',
      inkSoft: '#a9acb2',
      inkFaint: '#7a7d84',
      line: '#303236',
      lineSoft: '#27282c',
    },
    light: {
      bg: '#f5f5f6',
      surface: '#ffffff',
      surface2: '#ededee',
      ink: '#1b1c1e',
      inkMid: '#35373b',
      inkSoft: '#4e5157',
      inkFaint: '#7c7f86',
      line: '#e1e2e5',
      lineSoft: '#ededee',
    },
  },
};

/**
 * Акцент — то, чем темы различаются в первую очередь.
 *
 * У «Первого БИТа» это фирменная маджента (тот же цвет, что в квадрате знака
 * компании), у «Индиго» — сине-фиолетовый, у «Нейтральной» акцента как цвета
 * нет вовсе: его роль играет графит потемнее, и внимание держится формой,
 * а не краской.
 */
const ACCENTS = {
  bit: {
    dark: { accent: '#e5007a', hover: '#f13d97', soft: '#2c1220', line: '#4a1f38' },
    light: { accent: '#cc0074', hover: '#a8005f', soft: '#fdeaf3', line: '#f6c9e0' },
  },
  indigo: {
    dark: { accent: '#6b7bff', hover: '#8a95ff', soft: '#1a1f3d', line: '#303a66' },
    light: { accent: '#3f4fd0', hover: '#2f3cb0', soft: '#eaedfd', line: '#c9d0f7' },
  },
  neutral: {
    dark: { accent: '#8b929c', hover: '#a5abb4', soft: '#26282c', line: '#3a3d43' },
    light: { accent: '#4a4f57', hover: '#33373d', soft: '#ebecee', line: '#d3d5d9' },
  },
};

/**
 * Сигнальные цвета — общие для всех тем одного режима.
 *
 * Путать их с акцентом нельзя: акцент помечает то, на что смотрят, сигнальный
 * цвет — то, что случилось. Если акцентным станет всё, интерфейс всё время
 * выглядит аварийным.
 */
const SIGNALS = {
  dark: { good: '#4fb583', warn: '#d9a441', danger: '#e2483f' },
  light: { good: '#1f7a55', warn: '#9a7100', danger: '#b3261e' },
};

/**
 * Подсветка синтаксиса.
 *
 * Тёмная — та, что была; светлая — в манере конфигуратора 1С: зелёные
 * комментарии, красные ключевые слова, строки цветом обычного текста,
 * сиреневые директивы препроцессора и аннотации.
 */
const CODE = {
  dark: {
    comment: '#6fc57e',
    keyword: '#79a6ff',
    string: '#a8b0bd',
    directive: '#e0a868',
  },
  light: {
    comment: '#008000',
    keyword: '#b00000',
    string: '#1a1a1a',
    directive: '#7a007a',
  },
};

/**
 * Цвета отличий в окне разбора — те же три, что у конфигуратора: зелёный
 * «появилось справа», красный «пропало», синий «изменено».
 */
const DIFF = {
  dark: { add: '#4fb583', del: '#cf4a52', chg: '#4a7fd4', addInk: '#7fd0a3', delInk: '#ef8b91', chgInk: '#79a6ff' },
  light: { add: '#1f7a55', del: '#c0392f', chg: '#2f5fbf', addInk: '#1f7a55', delInk: '#a52f27', chgInk: '#2a55ad' },
};

// ------------------------------------------------------- Переменные интерфейса

/** Набор переменных интерфейса для одной темы. */
export function appVars(id) {
  const theme = resolveTheme(id);
  const s = SURFACES[theme.family][theme.mode];
  const a = ACCENTS[theme.family][theme.mode];
  const sig = SIGNALS[theme.mode];
  const code = CODE[theme.mode];
  const diff = DIFF[theme.mode];

  return {
    'color-scheme': theme.mode,
    '--bg': s.bg,
    '--surface': s.surface,
    '--surface-2': s.surface2,
    '--ink': s.ink,
    '--ink-mid': s.inkMid,
    '--ink-soft': s.inkSoft,
    '--ink-faint': s.inkFaint,
    '--line': s.line,
    '--line-soft': s.lineSoft,
    '--accent': a.accent,
    '--accent-hover': a.hover,
    '--accent-soft': a.soft,
    '--accent-line': a.line,
    '--good': sig.good,
    '--warn': sig.warn,
    '--danger': sig.danger,
    '--code-comment': code.comment,
    '--code-keyword': code.keyword,
    '--code-string': code.string,
    '--code-directive': code.directive,
    '--diff-add': diff.add,
    '--diff-del': diff.del,
    '--diff-chg': diff.chg,
    '--diff-add-ink': diff.addInk,
    '--diff-del-ink': diff.delInk,
    '--diff-chg-ink': diff.chgInk,
    /** Обложка карточек и заставка главной: тёмная всегда, но своего подтона. */
    '--hero-from': theme.mode === 'dark' ? s.bg : s.surface2,
    '--hero-mid': theme.mode === 'dark' ? s.surface : s.surface,
    '--hero-to': a.soft,
    /** Текст на акцентной плашке: контраст к --accent, а не к фону страницы. */
    '--on-accent': '#ffffff',
    /*
     * Текст на сигнальной плашке. В тёмной теме сигнальные цвета светлые,
     * и надпись на них должна быть тёмной; в светлой наоборот — цвета
     * насыщенные и тёмные, надпись белая.
     */
    '--on-signal': theme.mode === 'dark' ? '#101913' : '#ffffff',
  };
}

/** Таблица стилей с переменными всех тем — её отдаёт сервер интерфейсу. */
export function appThemeCss() {
  const blocks = THEMES.map((theme) => `:root[data-theme="${theme.id}"] {\n${varsText(appVars(theme.id))}\n}`);
  return `/*
 * Палитры тем. Файл собирается программой из src/ui/themes.js — править его
 * руками негде: он не лежит на диске. Один источник цвета на интерфейс
 * и на отчёты (см. тот же модуль).
 */
:root {
${varsText(appVars(DEFAULT_THEME))}
}

${blocks.join('\n\n')}
`;
}

// --------------------------------------------------------- Переменные отчёта

/**
 * Переменные, которые есть только у отчёта: уровни замечаний, обложка, значки
 * процедур, заливки сравнения. От семейства они не зависят — зависят от режима.
 */
const REPORT_EXTRA = {
  light: `
  --critical: #c62828;
  --high: #d75a12;
  --medium: #9a7100;
  --low: #3f7530;
  --info: #5a6472;

  --critical-bg: #fdeaea;  --critical-bd: #f6cfcf;
  --high-bg: #fdf0e5;      --high-bd: #f7dcc4;
  --medium-bg: #fbf4e0;    --medium-bd: #f0e3bb;
  --low-bg: #eef6e9;       --low-bd: #d7e8cd;
  --good-bg: #e8f5ef;      --good-bd: #c7e5d8;

  --warn-bg: #fdf7e8;      --warn-bd: #efe0b8;      --warn-ink: #6b5312;
  --danger-bg: #fdeded;    --danger-bd: #f3cccc;    --danger-ink: #8d2020;

  --neutral-bar: #d7dce4;
  --mark-modified-ink: #8a5b00; --mark-modified-bg: #f6e7bd;
  --mark-added-ink: #14603c;    --mark-added-bg: #cbe9d8;
  --mark-removed-ink: #8d2020;  --mark-removed-bg: #f6cfcf;
  --rt-proc-ink: #9c2b3f;  --rt-proc-bg: #fbe9ec;  --rt-proc-bd: #f0cdd4;
  --rt-func-ink: #274ea8;  --rt-func-bg: #e9eefb;  --rt-func-bd: #ccd8f4;
  --diff-vendor-bg: #fdeded;
  --diff-client-bg: #e8f5ef;`,
  dark: `
  --critical: #f0736c;
  --high: #f09a52;
  --medium: #dfb45a;
  --low: #7fbd6a;
  --info: #98a2b3;

  --critical-bg: #2e1a1a;  --critical-bd: #4a2424;
  --high-bg: #2d2117;      --high-bd: #4a3521;
  --medium-bg: #2b2617;    --medium-bd: #453c21;
  --low-bg: #1c2719;       --low-bd: #2d4027;
  --good-bg: #16281f;      --good-bd: #244535;

  --warn-bg: #2a2418;      --warn-bd: #4a3f22;      --warn-ink: #e2c072;
  --danger-bg: #2e1a1a;    --danger-bd: #4d2626;    --danger-ink: #f28a84;

  --neutral-bar: #39404c;
  --mark-modified-ink: #e2c072; --mark-modified-bg: #3a3120;
  --mark-added-ink: #7fd0a3;    --mark-added-bg: #1c3a2a;
  --mark-removed-ink: #f28a84;  --mark-removed-bg: #3c2020;
  --rt-proc-ink: #f0929f;  --rt-proc-bg: #33191e;  --rt-proc-bd: #542932;
  --rt-func-ink: #8fb0f5;  --rt-func-bg: #19203a;  --rt-func-bd: #2a355c;
  --diff-vendor-bg: #2e1a1a;
  --diff-client-bg: #16281f;`,
};

/** Набор переменных отчёта для одной темы. */
export function reportVars(id) {
  const theme = resolveTheme(id);
  const s = SURFACES[theme.family][theme.mode];
  const a = ACCENTS[theme.family][theme.mode];
  const sig = SIGNALS[theme.mode];
  const code = CODE[theme.mode];
  const dark = theme.mode === 'dark';

  const own = {
    '--ink': s.ink,
    '--ink-soft': s.inkSoft,
    '--ink-faint': s.inkFaint,
    '--line': s.line,
    '--line-soft': s.lineSoft,
    '--bg': dark ? s.surface : '#ffffff',
    '--bg-soft': s.bg,
    '--accent': a.accent,
    '--accent-ink': a.hover,
    '--accent-soft': a.soft,
    '--accent-line': a.line,
    '--good': sig.good,
    '--snippet-bg': dark ? s.bg : '#f6f7fa',
    '--snippet-bd': dark ? s.line : '#e7eaf0',
    // Обложка тёмная в любой теме: это титульный лист, и он у отчёта один.
    '--cover-from': SURFACES[theme.family].dark.bg,
    '--cover-mid': SURFACES[theme.family].dark.surface,
    '--cover-to': SURFACES[theme.family].dark.surface2,
    '--cover-ink': '#ffffff',
    '--cover-soft': '#c8ccd4',
    '--cover-faint': '#9aa1ad',
    '--cover-accent': ACCENTS[theme.family].dark.hover,
    '--code-comment': code.comment,
    '--code-keyword': code.keyword,
    '--code-string': code.string,
    '--code-directive': code.directive,
    'color-scheme': theme.mode,
  };

  return `${varsText(own)}\n${REPORT_EXTRA[theme.mode]}`;
}

/** Блоки тем для таблицы стилей отчёта. */
export function reportThemeCss() {
  return THEMES.map((theme) => `:root[data-theme="${theme.id}"] {\n${reportVars(theme.id)}\n}`).join('\n\n');
}

function varsText(vars) {
  return Object.entries(vars).map(([key, value]) => `  ${key}: ${value};`).join('\n');
}
