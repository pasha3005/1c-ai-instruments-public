/**
 * Стили печатного отчёта.
 *
 * Отчёт — самостоятельный HTML-файл: его отправляют заказчику по почте,
 * поэтому никаких внешних ресурсов (шрифтов, CDN) быть не должно.
 * Печать в PDF выполняется штатным средством браузера, отсюда @page и
 * правила разрыва страниц.
 *
 * ## Две темы в одном файле
 *
 * Тема выбирается на форме аудита и подставляется атрибутом
 * `<html data-theme="dark|light">`. Обе таблицы стилей лежат в одном файле:
 * отчёт должен оставаться самодостаточным, второй файл рядом с ним
 * потерялся бы при пересылке.
 *
 * Правило, которое надо соблюдать при правках: **цвет задаётся переменной,
 * а не хексом в правиле.** Иначе элемент останется светлым в тёмной теме,
 * и заметно это будет только на готовом отчёте. Все «фирменные» цвета —
 * от палитры «Первого БИТа»: малиновая маджента на графите. Красного
 * в фирменном стиле нет — с ним однажды перепутали, исправлено 09.08.2026.
 *
 * Печать всегда светлая: тёмный фон съедает картридж и плохо читается
 * на бумаге, поэтому `@media print` возвращает светлые значения даже
 * тёмной теме.
 */

/** Светлые значения палитры — они же значения по умолчанию. */
const LIGHT_VARS = `
  --ink: #14171d;
  --ink-soft: #4c5462;
  --ink-faint: #7c8494;
  --line: #e2e5ea;
  --line-soft: #eef0f4;
  --bg: #ffffff;
  --bg-soft: #f5f6f8;
  --accent: #cc0074;
  --accent-ink: #99005a;
  --accent-soft: #fdeaf3;
  --accent-line: #f6c9e0;

  --critical: #c62828;
  --high: #d75a12;
  --medium: #9a7100;
  --low: #3f7530;
  --info: #5a6472;
  --good: #23795a;

  --critical-bg: #fdeaea;  --critical-bd: #f6cfcf;
  --high-bg: #fdf0e5;      --high-bd: #f7dcc4;
  --medium-bg: #fbf4e0;    --medium-bd: #f0e3bb;
  --low-bg: #eef6e9;       --low-bd: #d7e8cd;
  --good-bg: #e8f5ef;      --good-bd: #c7e5d8;

  --warn-bg: #fdf7e8;      --warn-bd: #efe0b8;      --warn-ink: #6b5312;
  --note-bg: #fdeaf3;      --note-bd: #f6c9e0;      --note-ink: #99005a;
  --danger-bg: #fdeded;    --danger-bd: #f3cccc;    --danger-ink: #8d2020;

  --snippet-bg: #f6f7fa;
  --snippet-bd: #e7eaf0;

  --cover-from: #17191f;
  --cover-mid: #23262e;
  --cover-to: #2a2d36;
  --cover-ink: #ffffff;
  --cover-soft: #c8ccd4;
  --cover-faint: #9aa1ad;
  --cover-accent: #ff3d9e;

  --neutral-bar: #d7dce4;
  --mark-modified-ink: #8a5b00; --mark-modified-bg: #f6e7bd;
  --mark-added-ink: #14603c;    --mark-added-bg: #cbe9d8;
  --mark-removed-ink: #8d2020;  --mark-removed-bg: #f6cfcf;
  /* Процедура и функция: как в конфигураторе — красная «P()», синяя «F(x)». */
  --rt-proc-ink: #9c2b3f;  --rt-proc-bg: #fbe9ec;  --rt-proc-bd: #f0cdd4;
  --rt-func-ink: #274ea8;  --rt-func-bg: #e9eefb;  --rt-func-bd: #ccd8f4;

  /* Подсветка синтаксиса 1С — как в конфигураторе: комментарий зелёным,
     ключевые слова синим, строки нейтральным цветом текста (ink-soft). */
  --code-comment: #1e7a34;
  --code-keyword: #0033cc;
  --code-directive: #8a4b12;
  --diff-vendor-bg: #fdeded;
  --diff-client-bg: #e8f5ef;
`;

/**
 * Тёмные значения. Повторяет вид веб-интерфейса: графитовые поверхности,
 * малиновая маджента вместо красного, приглушённые заливки значков вместо
 * пастельных.
 */
const DARK_VARS = `
  --ink: #e9ecf1;
  --ink-soft: #a8b0bd;
  --ink-faint: #79818f;
  --line: #2d323d;
  --line-soft: #242832;
  --bg: #1a1d24;
  --bg-soft: #14161b;
  --accent: #f0409a;
  --accent-ink: #ff6bb8;
  --accent-soft: #2c1220;
  --accent-line: #4a1f38;

  --critical: #f0736c;
  --high: #f09a52;
  --medium: #dfb45a;
  --low: #7fbd6a;
  --info: #98a2b3;
  --good: #5cba86;

  --critical-bg: #2e1a1a;  --critical-bd: #4a2424;
  --high-bg: #2d2117;      --high-bd: #4a3521;
  --medium-bg: #2b2617;    --medium-bd: #453c21;
  --low-bg: #1c2719;       --low-bd: #2d4027;
  --good-bg: #16281f;      --good-bd: #244535;

  --warn-bg: #2a2418;      --warn-bd: #4a3f22;      --warn-ink: #e2c072;
  --note-bg: #2c1220;      --note-bd: #4a1f38;      --note-ink: #ff7ab8;
  --danger-bg: #2e1a1a;    --danger-bd: #4d2626;    --danger-ink: #f28a84;

  --snippet-bg: #12141a;
  --snippet-bd: #262b35;

  --cover-from: #101216;
  --cover-mid: #1b1e25;
  --cover-to: #22252c;
  --cover-ink: #ffffff;
  --cover-soft: #c3c8d1;
  --cover-faint: #8d95a2;
  --cover-accent: #ff3d9e;

  --neutral-bar: #39404c;
  --mark-modified-ink: #e2c072; --mark-modified-bg: #3a3120;
  --mark-added-ink: #7fd0a3;    --mark-added-bg: #1c3a2a;
  --mark-removed-ink: #f28a84;  --mark-removed-bg: #3c2020;
  --rt-proc-ink: #f0929f;  --rt-proc-bg: #33191e;  --rt-proc-bd: #542932;
  --rt-func-ink: #8fb0f5;  --rt-func-bg: #19203a;  --rt-func-bd: #2a355c;

  --code-comment: #6fc57e;
  --code-keyword: #79a6ff;
  --code-directive: #e0a868;
  --diff-vendor-bg: #2e1a1a;
  --diff-client-bg: #16281f;

  color-scheme: dark;
`;

export const REPORT_STYLES = `
:root {
${LIGHT_VARS}
  --radius: 10px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: "SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace;
  color-scheme: light;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink);
  background: var(--bg-soft);
  -webkit-font-smoothing: antialiased;
}

/*
 * --- Раскладка: меню слева, отчёт справа, во всю ширину экрана ---
 *
 * Отчёт занимает всё окно, а не лист фиксированной ширины: на широком мониторе
 * колонка в 1080px оставляла по трети экрана пустыми с каждой стороны, а
 * таблицы сравнения и двухпанельный код в неё не влезали. Читаемость длинных
 * абзацев при этом не страдает — её держит max-width у самого текста (см.
 * правило для p ниже), а не ширина всего документа.
 *
 * Меню — колонка грида, а не position: fixed: фиксированный элемент выпадает
 * из потока, и под него приходится вручную подбирать отступ содержимому,
 * который разъезжается при любой смене ширины. Здесь ширину держит сам грид,
 * а «не прокручивается» делает position: sticky внутри колонки.
 */
.layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  align-items: start;
}

.page {
  max-width: none;
  min-width: 0;
  margin: 0;
  padding: 0 0 80px;
  background: var(--bg);
}

/* Плавная прокрутка к разделу по щелчку в меню. */
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }

/* --- Титульный лист --- */
.cover {
  padding: 72px 64px 56px;
  background-color: var(--cover-mid);
  background-image: linear-gradient(150deg, var(--cover-from) 0%, var(--cover-mid) 58%, var(--cover-to) 100%);
  color: var(--cover-ink);
  position: relative;
}
/* Малиновая черта под шапкой — единственный «фирменный» приём титульного листа. */
.cover::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 4px;
  background: linear-gradient(90deg, var(--accent) 0%, var(--cover-accent) 100%);
}
.cover__eyebrow {
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--cover-accent);
  margin: 0 0 18px;
  font-weight: 620;
}
.cover__title {
  font-size: 40px;
  line-height: 1.15;
  font-weight: 680;
  margin: 0 0 10px;
  letter-spacing: -.02em;
}
.cover__client {
  font-size: 15px;
  font-weight: 600;
  color: var(--cover-soft);
  margin: 0 0 10px;
  letter-spacing: .01em;
}
.cover__subtitle {
  font-size: 19px;
  color: var(--cover-soft);
  margin: 0 0 40px;
  font-weight: 400;
}
.cover__scope {
  margin: 26px 0 0;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.14);
  border-left: 3px solid var(--cover-accent);
  font-size: 13.5px;
  color: var(--cover-soft);
  max-width: none;
}

/* --- Сворачиваемые разделы с замечаниями --- */
details.collapsible { margin: 0 0 18px; }
details.collapsible > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-soft);
  font-size: 15px;
  font-weight: 620;
  user-select: none;
}
details.collapsible > summary::-webkit-details-marker { display: none; }
details.collapsible > summary::before {
  content: '▸';
  color: var(--accent);
  font-size: 12px;
  transition: transform .15s;
}
details.collapsible[open] > summary::before { content: '▾'; }
details.collapsible > summary:hover { border-color: var(--accent); }
details.collapsible .collapsible__count {
  margin-left: auto;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}
details.collapsible > .collapsible__body { padding: 16px 2px 4px; }
/*
 * Ничто внутри сворачиваемого блока не должно раздвигать лист: длинные пути
 * к модулям и широкие таблицы прокручиваются внутри себя, а не тянут страницу.
 */
details.collapsible { min-width: 0; max-width: 100%; }
details.collapsible > .collapsible__body { min-width: 0; overflow-wrap: anywhere; }

/* Вложенный уровень: вид замечания внутри категории. */
details.collapsible--group { margin: 0 0 10px; }
details.collapsible--group > summary {
  padding: 8px 12px;
  font-size: 14.5px;
  font-weight: 600;
  background: var(--bg);
}
details.collapsible--group > summary:hover { background: var(--bg-soft); }
details.collapsible--group > .collapsible__body { padding: 12px 0 2px 14px; border-left: 2px solid var(--line); margin-left: 5px; }
.group-title { overflow-wrap: anywhere; }

/*
 * Перечни объектов метаданных: по объекту на строку, в несколько колонок.
 * Сплошной текст через запятую нечитаем, а колонка в четыре сотни строк
 * растягивает документ на несколько экранов.
 */
.object-list {
  columns: 3 260px;
  column-gap: 28px;
  list-style: none;
  padding: 0;
  margin: 0;
  max-width: none;
  font-size: 13.5px;
}
.object-list li {
  break-inside: avoid;
  padding: 3px 0;
  margin: 0;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--line-soft);
  overflow-wrap: anywhere;
}
/* Приписка «чем изменён» — например «расширение «ПРО_Дополнения»». */
.object-list .src { color: var(--ink-faint); font-size: 12px; }

/* Таблица заменённых аннотацией &Вместо методов. */
.instead-table { background: var(--bg); border-radius: 6px; }
.instead-table td { font-size: 13px; }
/* Группы расширений внутри врезки о подмене типовой логики. */
.instead-groups details.collapsible--group > summary { background: var(--bg); }

/*
 * --- Дерево отличий от конфигурации поставщика ---
 *
 * Раскладка повторяет отчёт о сравнении конфигураций из конфигуратора:
 * вид объекта → объект → свойство, реквизит или модуль → строки правки.
 * Вложенность показана направляющей слева, а не отступом на каждом уровне:
 * при четырёх уровнях отступ съедал бы половину ширины листа.
 */
.difftree { margin: 0 0 22px; }
.dt { margin: 0; }
.dt > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: 6px;
  user-select: none;
}
.dt > summary::-webkit-details-marker { display: none; }
.dt > summary::before { content: '▸'; color: var(--ink-faint); font-size: 11px; }
.dt[open] > summary::before { content: '▾'; }
.dt > summary:hover { background: var(--bg-soft); }
.dt > .dt__body {
  margin-left: 14px;
  padding-left: 12px;
  border-left: 1px solid var(--line);
}
.dt--kind {
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-bottom: 10px;
  background: var(--bg);
}
.dt--kind > summary {
  background: var(--bg-soft);
  font-weight: 640;
  font-size: 15px;
  padding: 10px 14px;
}
.dt--kind > .dt__body { margin: 8px 14px 12px; padding-left: 10px; }
.dt--leaf {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 5px 10px 5px 22px;
  font-size: 13.5px;
}
.dt__label { font-weight: 560; overflow-wrap: anywhere; }
.dt--leaf .dt__label { font-weight: 400; color: var(--ink-soft); }
.dt__synonym { color: var(--ink-faint); font-size: 13px; }
.dt__stat {
  margin-left: auto;
  font-size: 12.5px;
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dt__status {
  font-size: 11px;
  letter-spacing: .03em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 20px;
  border: 1px solid transparent;
}
.dt__status--modified { color: var(--medium); background: var(--medium-bg); border-color: var(--medium-bd); }
.dt__status--added    { color: var(--good);   background: var(--good-bg);   border-color: var(--good-bd); }
.dt__status--removed  { color: var(--critical); background: var(--critical-bg); border-color: var(--critical-bd); }
/* Знак вида отличия — те же три состояния, что в отчёте конфигуратора. */
.tree-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-style: normal;
  font-weight: 700;
  font-size: 12px;
  line-height: 1;
  flex-shrink: 0;
}
.tree-mark--modified { color: var(--mark-modified-ink); background: var(--mark-modified-bg); }
.tree-mark--added    { color: var(--mark-added-ink);    background: var(--mark-added-bg); }
.tree-mark--removed  { color: var(--mark-removed-ink);  background: var(--mark-removed-bg); }
/*
 * Значок процедуры и функции — как в дереве конфигуратора, где у процедуры
 * «P()», а у функции «F(x)». Подпись, а не картинка: отчёт остаётся одним
 * файлом без внешних ресурсов, а прочитать значок можно и без легенды.
 */
.rt-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 16px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid transparent;
  font-family: var(--mono);
  font-style: normal;
  font-weight: 700;
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0;
  flex-shrink: 0;
}
.rt-mark--procedure { color: var(--rt-proc-ink); background: var(--rt-proc-bg); border-color: var(--rt-proc-bd); }
.rt-mark--function  { color: var(--rt-func-ink); background: var(--rt-func-bg); border-color: var(--rt-func-bd); }
.rt-mark--unknown   { color: var(--ink-faint);   background: var(--bg-soft);    border-color: var(--line); }
/*
 * Подпись процедуры — это код, и выглядеть она обязана как код: тот же
 * моноширинный шрифт и та же подсветка, что в блоке ниже (требование
 * пользователя 13.08.2026). Жирности здесь нет — её несёт только ключевое
 * слово через .tok-keyword, ровно как внутри фрагмента.
 */
.rt-sig {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 400;
  color: var(--ink);
}
/*
 * Объекты и модули внутри помещения — спокойнее, чем в дереве отличий
 * от поставщика. Там объект — единица разбора, и его выделяют; здесь единицей
 * служит само помещение, а список объектов под ним читают бегло. Полужирный
 * яркий шрифт превращал раскрытую версию в стену заголовков (замечание
 * пользователя 13.08.2026).
 */
.dt--commit .dt__label { font-weight: 400; color: var(--ink-soft); }
.dt--commit .rt-sig { color: var(--ink); }

/* Уровень процедуры в дереве помещений: мельче объекта, но со своим отступом. */
.dt--routine > summary { padding-left: 26px; }
.dt--routine > .dt__body { padding-left: 26px; }
.dt__routine-plain { padding: 4px 0 4px 26px; }
.dt__routine-head {
  font-size: 12px;
  color: var(--ink-faint);
  margin-bottom: 4px;
}
.tree-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  font-size: 13px;
  color: var(--ink-soft);
  margin: 0 0 18px;
}
.tree-legend span { display: flex; align-items: center; gap: 7px; }
/*
 * Помещения хранилища — таблица, у которой каждая строка раскрывается.
 *
 * Обычная таблица тут не годится: у строки должно быть содержимое (перечень
 * помещённых объектов и правки в модулях), а строка таблицы не раскрывается
 * без скриптов. Поэтому строки сделаны сеткой внутри summary — колонки
 * выстроены так же, как в таблице, а раскрытие даёт сам details.
 */
.commits__head,
.dt--commit > summary > .commits__row {
  display: grid;
  grid-template-columns: 62px 1fr 132px 2fr 96px;
  gap: 12px;
  align-items: baseline;
  flex: 1;
  min-width: 0;
}
/*
 * Ширина значка раскрытия задана явно, иначе шапка не встанет над колонками:
 * ширина глифа зависит от шрифта, и подбирать под неё отступ шапки на глаз
 * значит промахиваться на каждой второй машине.
 */
.dt--commit > summary::before { width: 12px; }
.commits__head {
  padding: 6px 10px 6px 30px;
  font-size: 12px;
  letter-spacing: .03em;
  text-transform: uppercase;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.dt--commit { border-bottom: 1px solid var(--line); }
.dt--commit > summary { align-items: baseline; }
.commits__cell { overflow-wrap: anywhere; font-size: 13.5px; }
.commits__cell--num { font-variant-numeric: tabular-nums; text-align: right; }
.commits__cell--who { font-weight: 560; }
.commits__cell--comment { color: var(--ink-soft); }
@media (max-width: 900px) {
  .commits__head { display: none; }
  .dt--commit > summary > .commits__row { grid-template-columns: 1fr; gap: 2px; }
  .commits__cell--num { text-align: left; }
}
.dt__note { font-size: 13px; color: var(--ink-soft); margin: 6px 0 8px; max-width: none; }
.dt__fragment { margin: 0 0 14px; }
.dt__fragment-head { font-size: 12px; color: var(--ink-faint); margin-bottom: 3px; }
.dt__fragment .snippet { margin: 0; }

/*
 * Двустороннее сравнение — как отчёт о сравнении конфигураций в самом 1С:
 * слева код поставщика, справа код клиента, для одного и того же участка.
 * На печати и на узком экране колонки складываются друг под друга: сравнивать
 * построчно тогда уже не выйдет, но это лучше горизонтальной прокрутки.
 */
.dt__diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 0 0 14px;
}
.dt__diff-pane { min-width: 0; }
.dt__diff-pane-head {
  font-size: 11.5px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 4px;
}
.dt__diff-pane .snippet { margin: 0; }
.dt__diff-pane--vendor .snippet { background: var(--diff-vendor-bg); }
.dt__diff-pane--client .snippet { background: var(--diff-client-bg); }
/* Участок — чистая вставка: у поставщика показывать нечего, а не пустой блок. */
.dt__diff-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 48px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  color: var(--ink-faint);
  font-size: 12.5px;
  padding: 10px;
}
@media (max-width: 760px) {
  .dt__diff { grid-template-columns: 1fr; }
}

/* Подсветка синтаксиса 1С внутри фрагментов кода. */
.tok-comment { color: var(--code-comment); }
.tok-keyword { color: var(--code-keyword); font-weight: 620; }
.tok-string { color: var(--ink-soft); }
.tok-directive { color: var(--code-directive); }

/* Пропорция «совпадает / изменено / добавлено / удалено». */
.diffbar {
  display: flex;
  height: 26px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--line);
  margin-bottom: 10px;
}
.diffbar__part--unchanged { background: var(--neutral-bar); }
.diffbar__part--modified  { background: var(--medium); }
.diffbar__part--added     { background: var(--good); }
.diffbar__part--removed   { background: var(--critical); }
.diffbar__swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.diffbar__swatch--unchanged { background: var(--neutral-bar); }
.diffbar__swatch--modified  { background: var(--medium); }
.diffbar__swatch--added     { background: var(--good); }
.diffbar__swatch--removed   { background: var(--critical); }

/*
 * Таблицы. Заголовок таблицы и есть переключатель — отдельной рамки не рисуем,
 * иначе отчёт превращается в частокол из вложенных панелей.
 */
details.collapsible--table { margin: 0 0 22px; }
details.collapsible--table > summary {
  border: none;
  background: transparent;
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  font-size: 16px;
  font-weight: 640;
  letter-spacing: -.01em;
}
details.collapsible--table > summary:hover {
  border-color: var(--accent);
  color: var(--accent);
}
details.collapsible--table > .collapsible__body { padding: 12px 0 0; }
/* Свёрнутая таблица не должна выглядеть обрубленной. */
details.collapsible--table:not([open]) > summary { color: var(--ink-soft); }

/* Раздел целиком: заголовок h2 внутри summary. */
details.collapsible--section > summary {
  border: none;
  background: transparent;
  padding: 0;
  border-radius: 0;
}
details.collapsible--section > summary h2 { margin: 0; }
details.collapsible--section > .collapsible__body { padding: 4px 0 0; }

@media print {
  details.collapsible > summary::before, .dt > summary::before { display: none; }
  details.collapsible > .collapsible__body { padding-top: 10px; }
  /* В PDF всё должно быть раскрыто, независимо от того, как смотрели на экране. */
  details.collapsible > .collapsible__body { display: block !important; }
  .dt > .dt__body { display: block !important; }
}
.cover__meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 22px 32px;
  padding-top: 28px;
  border-top: 1px solid rgba(255,255,255,.16);
}
.cover__meta dt {
  font-size: 11.5px;
  letter-spacing: .07em;
  text-transform: uppercase;
  color: var(--cover-faint);
  margin: 0 0 5px;
}
.cover__meta dd {
  margin: 0;
  font-size: 15px;
  color: var(--cover-ink);
  font-weight: 500;
  word-break: break-word;
}

/* --- Секции --- */
.section {
  padding: 44px 64px;
  border-top: 1px solid var(--line-soft);
  /* Содержимое раздела не должно расширять лист — широкое прокручивается само. */
  min-width: 0;
  overflow-wrap: break-word;
}
.section:first-of-type { border-top: none; }
.section__num {
  display: inline-block;
  font-size: 12px;
  font-weight: 660;
  letter-spacing: .09em;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  padding: 4px 10px;
  border-radius: 20px;
  margin-bottom: 14px;
}
h2 {
  font-size: 26px;
  line-height: 1.25;
  font-weight: 660;
  margin: 0 0 8px;
  letter-spacing: -.015em;
}
h3 {
  font-size: 17px;
  font-weight: 640;
  margin: 30px 0 12px;
}
h4 {
  font-size: 15px;
  font-weight: 640;
  margin: 22px 0 8px;
}
/*
 * Заголовок, который намеренно не сворачивается (методика обследования).
 * Оформлен как свёрнутый — той же чертой и тем же кеглем, — чтобы раздел
 * не выпадал из общего ритма, но без переключателя и без отступа тела.
 */
h3.plain {
  font-size: 16px;
  font-weight: 640;
  letter-spacing: -.01em;
  padding: 6px 0;
  margin: 30px 0 14px;
  border-bottom: 1px solid var(--line);
}
h3.plain + ul, h3.plain + p, h3.plain + .table-wrap { margin-top: 0; }
.section__lead {
  color: var(--ink-soft);
  font-size: 15.5px;
  margin: 0 0 26px;
  max-width: 74ch;
}
p { margin: 0 0 14px; max-width: 82ch; }
ul, ol { margin: 0 0 16px; padding-left: 22px; max-width: 82ch; }
li { margin-bottom: 7px; }
/*
 * Ссылки — не маджентой: акцент в отчёте помечает только то, на что нужно
 * смотреть (номера разделов, ход сравнения), а гиперссылок в тексте много
 * (переходы к типу замечания в сводках), и маджентой на каждой они бы
 * обесценили акцент. Серый/светлый, с подчёркиванием — обычная ссылка.
 */
a { color: var(--ink-soft); text-decoration: underline; text-decoration-color: var(--line); }
a:hover { color: var(--ink); }

/* --- Оценки --- */
.scores {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
  gap: 14px;
  margin: 0 0 30px;
}
.score {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px 20px;
  background: var(--bg);
}
.score__label {
  font-size: 12px;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 8px;
}
.score__value {
  font-size: 34px;
  font-weight: 680;
  line-height: 1;
  letter-spacing: -.02em;
}
.score__value small { font-size: 15px; font-weight: 500; color: var(--ink-faint); }
.score__note { font-size: 13px; color: var(--ink-soft); margin-top: 7px; }
.score__bar {
  height: 5px;
  border-radius: 3px;
  background: var(--line-soft);
  margin-top: 12px;
  overflow: hidden;
}
.score__bar i { display: block; height: 100%; border-radius: 3px; }

.grade-good  .score__value, .grade-good  { color: var(--good); }
.grade-warn  .score__value { color: var(--medium); }
.grade-bad   .score__value { color: var(--high); }
.grade-crit  .score__value { color: var(--critical); }

/* --- Таблицы --- */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  margin: 0 0 22px;
}
th {
  text-align: left;
  font-weight: 620;
  font-size: 12px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--ink-faint);
  padding: 9px 12px;
  border-bottom: 2px solid var(--line);
  white-space: nowrap;
}
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
}
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; margin-bottom: 22px; }

/* --- Значки критичности --- */
.badge {
  display: inline-block;
  font-size: 11.5px;
  font-weight: 620;
  padding: 2px 8px;
  border-radius: 20px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.badge--critical { color: var(--critical); background: var(--critical-bg); border-color: var(--critical-bd); }
.badge--high     { color: var(--high);     background: var(--high-bg);     border-color: var(--high-bd); }
.badge--medium   { color: var(--medium);   background: var(--medium-bg);   border-color: var(--medium-bd); }
.badge--low      { color: var(--low);      background: var(--low-bg);      border-color: var(--low-bd); }
.badge--info     { color: var(--ink-soft); background: var(--bg-soft);     border-color: var(--line); }
.badge--good     { color: var(--good);     background: var(--good-bg);     border-color: var(--good-bd); }
/*
 * Имя разработчика — цвет закреплён за конкретным именем через номер палитры
 * (см. authorBadge() в ui.js), а не инлайновым hex-цветом: инлайновый цвет
 * не отличает тему и в тёмном отчёте оставлял бы светлую пастельную плашку
 * поверх тёмного фона.
 */
.badge--author   { font-weight: 640; }
.badge--author-0 { color: #5b3fa8; background: #f1ecfb; border-color: #ded2f6; }
.badge--author-1 { color: #0f6f7a; background: #e6f5f6; border-color: #c6e6e9; }
.badge--author-2 { color: #8a4b12; background: #fbf0e4; border-color: #f0dcc3; }
.badge--author-3 { color: #1f5fd0; background: #eaf1fd; border-color: #cddff8; }
.badge--author-4 { color: #8d2060; background: #fbeaf3; border-color: #f2cede; }
.badge--author-5 { color: #3d6b1f; background: #eef6e8; border-color: #d6e7c9; }
:root[data-theme="dark"] .badge--author-0 { color: #b79eea; background: #251c3a; border-color: #3c2d5c; }
:root[data-theme="dark"] .badge--author-1 { color: #5fcdd6; background: #122a2d; border-color: #1f4448; }
:root[data-theme="dark"] .badge--author-2 { color: #e0a868; background: #2c2113; border-color: #4a3520; }
:root[data-theme="dark"] .badge--author-3 { color: #7fabf2; background: #17233c; border-color: #26395c; }
:root[data-theme="dark"] .badge--author-4 { color: #e090c0; background: #33192c; border-color: #532642; }
:root[data-theme="dark"] .badge--author-5 { color: #93cf74; background: #1c2917; border-color: #2d4127; }
/* Откуда код: расширение, добавленный объект, авторская вставка. */
.badge--origin   { color: var(--ink-faint); background: transparent; border-color: var(--line); font-weight: 500; }

/* --- Карточки находок --- */
.finding {
  border: 1px solid var(--line);
  border-left: 3px solid var(--line);
  border-radius: 8px;
  padding: 16px 18px;
  margin-bottom: 12px;
  background: var(--bg);
  break-inside: avoid;
}
.finding--critical { border-left-color: var(--critical); }
.finding--high     { border-left-color: var(--high); }
.finding--medium   { border-left-color: var(--medium); }
.finding--low      { border-left-color: var(--low); }
.finding__head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  margin-bottom: 7px;
}
.finding__title { font-weight: 620; font-size: 15px; }
.finding__where {
  font-size: 12.5px;
  color: var(--ink-faint);
  font-family: var(--mono);
  margin-bottom: 8px;
  word-break: break-all;
}
.finding__detail { color: var(--ink-soft); font-size: 14px; margin-bottom: 8px; }
.finding__rec {
  font-size: 14px;
  padding: 10px 12px;
  background: var(--bg-soft);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  color: var(--ink-soft);
}
.finding__rec b { font-weight: 620; color: var(--ink); }
/*
 * Блок кода. Строки НЕ переносятся (white-space: pre): перенос сбивает
 * выравнивание запроса и не даёт сравнивать две колонки построчно. Вместо
 * переноса — прокрутка, и по ширине, и по высоте: высота ограничена, чтобы
 * фрагмент в полсотни строк не растягивал страницу. Требование пользователя.
 */
pre.snippet {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  background: var(--snippet-bg);
  border: 1px solid var(--snippet-bd);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 0 0 10px;
  white-space: pre;
  word-break: normal;
  overflow: auto;
  max-height: 420px;
  overscroll-behavior: contain;
  color: var(--ink);
}

/* --- Врезки --- */
.callout {
  border-radius: 8px;
  padding: 14px 18px;
  margin: 0 0 20px;
  font-size: 14.5px;
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--ink-soft);
}
.callout--warn { background: var(--warn-bg); border-color: var(--warn-bd); color: var(--warn-ink); }
.callout--info { background: var(--note-bg); border-color: var(--note-bd); color: var(--note-ink); }
.callout--danger { background: var(--danger-bg); border-color: var(--danger-bd); color: var(--danger-ink); }
/* Хорошая новость («замечаний не выявлено») — сигнальным зелёным, не акцентом. */
.callout--good { background: var(--good-bg); border-color: var(--good-bd); color: var(--good); }
.callout__title { font-weight: 640; margin-bottom: 5px; color: inherit; }
/*
 * Нейтральное описание факта — не предупреждение и не важная врезка, а то же,
 * что «Как исправлять» у замечания: подсказка на спокойном фоне. Раньше такие
 * блоки («Эталон сравнения», «Выполнено точное сравнение с поставщиком»)
 * рисовались как callout--info, то есть на розовой/маджентовой подложке —
 * акцент, который здесь ни на что не указывает, только выдыхается на факты.
 */
.callout--plain { background: var(--bg-soft); border: none; border-left: 3px solid var(--accent); border-radius: 6px; color: var(--ink-soft); }
.callout--plain .callout__title { color: var(--ink); }

/* --- Шкала распределения --- */
.distribution { display: flex; height: 30px; border-radius: 6px; overflow: hidden; margin-bottom: 10px; border: 1px solid var(--line); }
.distribution span { display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 620; color: #fff; }
.distribution .d-critical { background: var(--critical); }
.distribution .d-high     { background: var(--high); }
.distribution .d-medium   { background: var(--medium); }
.distribution .d-low      { background: var(--low); }
.distribution .d-info     { background: var(--info); }
.legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--ink-soft); margin-bottom: 22px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }

/* --- Этапы плана --- */
.stage {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px 22px;
  margin-bottom: 14px;
  break-inside: avoid;
}
.stage__head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
.stage__title { font-size: 16.5px; font-weight: 640; }
.stage__meta { font-size: 13px; color: var(--ink-faint); white-space: nowrap; }
.stage__goal { color: var(--ink-soft); font-size: 14px; margin-bottom: 12px; }
.stage__effect { font-size: 13.5px; color: var(--good); margin-top: 10px; }

/* --- Сноски и колонтитул --- */
.footnote { font-size: 13px; color: var(--ink-faint); margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.report-footer {
  padding: 28px 64px 40px;
  color: var(--ink-faint);
  font-size: 12.5px;
  border-top: 3px solid var(--accent);
  background: var(--bg-soft);
}
.report-footer .author { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-soft); }

.kv { display: grid; grid-template-columns: minmax(180px, max-content) 1fr; gap: 8px 22px; font-size: 14.5px; margin-bottom: 22px; }
.kv dt { color: var(--ink-faint); }
.kv dd { margin: 0; font-weight: 500; }

.muted { color: var(--ink-faint); }
/*
 * Пояснительные врезки-лиды перед таблицей или перечнем (например, «Автор
 * определяется по комментарию-маркеру…»). Обычный абзац намеренно узкий —
 * 82 символа читаются легче, — но у короткой пояснительной строки над широкой
 * таблицей это, наоборот, выглядит обрубленным: текст жмётся к левому краю,
 * а справа пустует место шириной в половину листа.
 */
.wide-note { max-width: none; }
.mono { font-family: var(--mono); font-size: 13px; }
.nowrap { white-space: nowrap; }

/* --- Тёмная тема --- */
:root[data-theme="dark"] {
${DARK_VARS}
}

/* --- Печать: всегда светлая --- */
@page { size: A4; margin: 14mm 12mm; }
@media print {
  :root, :root[data-theme="dark"] {
${LIGHT_VARS}
    color-scheme: light;
  }
  body { background: #fff; font-size: 10.5pt; }
  .page { box-shadow: none; max-width: none; }
  /* На бумаге меню бессмысленно: ссылки не нажать, а место занимает. */
  .layout { display: block; }
  .nav { display: none; }
  .cover { padding: 40px 0; break-after: page; }
  .section { padding: 22px 0; break-inside: auto; }
  .section > h2 { break-after: avoid; }
  /* Прилипающий заголовок в PDF наезжал бы на текст на каждой странице. */
  .sec > summary { position: static; break-after: avoid; }
  .sec > summary::after { display: none; }
  .sec__body { display: block !important; }
  .finding, .stage, .score, table { break-inside: avoid; }
  /* Двухпанельный код на книжном листе даёт две нечитаемые колонки. */
  .dt__diff { grid-template-columns: 1fr; }
  /* Прокрутки на бумаге нет: длинную строку переносим, высоту не ограничиваем,
     иначе на листе останется видна только первая треть фрагмента. */
  pre.snippet { white-space: pre-wrap; word-break: break-word; max-height: none; overflow: visible; }
  thead { display: table-header-group; }
  .no-print { display: none !important; }
  a { color: inherit; text-decoration: none; }
}

/*
 * --- Меню слева: содержание отчёта ---
 *
 * position: sticky внутри своей колонки грида: меню стоит на месте при
 * прокрутке отчёта («не прокручивается» по требованию пользователя), но, в
 * отличие от position: fixed, остаётся в потоке — ширину ему задаёт грид,
 * и содержимому не нужен подобранный вручную отступ слева.
 *
 * Своя внутренняя прокрутка нужна: с подпунктами разделов список длиннее
 * экрана, а до «Методики» в конце добраться надо.
 */
.nav {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 22px 14px 30px 22px;
  border-right: 1px solid var(--line);
  background: var(--bg-soft);
  font-size: 13.5px;
}
.nav__brand {
  font-size: 11px;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--ink-faint);
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.nav__list, .nav__sub { list-style: none; margin: 0; padding: 0; max-width: none; }
.nav__list > li { margin: 0 0 1px; }
.nav__list > li > a {
  display: block;
  padding: 7px 10px 7px 12px;
  border-radius: 7px;
  border-left: 2px solid transparent;
  color: var(--ink-soft);
  text-decoration: none;
  line-height: 1.35;
}
.nav__list > li > a:hover { background: var(--bg); color: var(--ink); }
/*
 * Активный раздел подсвечивается при прокрутке (scrollspy в скрипте отчёта).
 * Акцент здесь на месте: это ровно то, «на что смотрят» — где читатель
 * находится в документе прямо сейчас.
 */
.nav__list > li > a.is-current {
  background: var(--accent-soft);
  border-left-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 620;
}
/* Подпункты — блоки внутри раздела; добавляются скриптом по факту разметки. */
.nav__sub { margin: 2px 0 8px; }
.nav__sub li { margin: 0; }
.nav__sub a {
  display: block;
  padding: 4px 8px 4px 26px;
  border-radius: 6px;
  color: var(--ink-faint);
  text-decoration: none;
  font-size: 12.5px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav__sub a:hover { background: var(--bg); color: var(--ink-soft); }
.nav__sub a.is-current { color: var(--accent-ink); font-weight: 600; }

/*
 * --- Раздел: сворачиваемый, с прилипающим заголовком ---
 *
 * Заголовок раздела — элемент summary с position: sticky, поэтому при прокрутке
 * он остаётся у верхнего края: видно, в каком разделе читатель находится,
 * и по этому же заголовку раздел сворачивается одним щелчком (штатное
 * поведение элемента details, без скрипта).
 *
 * z-index выше, чем у содержимого, но ниже меню: заголовок должен
 * перекрывать наезжающие снизу таблицы, а меню — перекрывать заголовок.
 */
.sec { margin: 0; }
.sec > summary {
  position: sticky;
  top: 0;
  z-index: 3;
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 0 14px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  user-select: none;
}
.sec > summary::-webkit-details-marker { display: none; }
.sec > summary h2 { margin: 0; }
.sec > summary .section__num { margin: 0; flex-shrink: 0; }
/* Указатель состояния — справа, чтобы не разрывать пару «номер + заголовок». */
.sec > summary::after {
  content: '▾';
  margin-left: auto;
  flex-shrink: 0;
  color: var(--ink-faint);
  font-size: 13px;
}
.sec:not([open]) > summary::after { content: '▸'; }
.sec:not([open]) > summary { margin-bottom: 0; opacity: .75; }
.sec > summary:hover { border-color: var(--accent); }
.sec > summary:hover h2 { color: var(--accent); }
.sec__body { padding-top: 4px; }

/*
 * Прокрутка к якорю не должна прятать цель под прилипшим заголовком раздела:
 * scroll-margin-top отодвигает точку остановки на его высоту.
 */
.section, .sec__body > details.collapsible, .sec__body > h3 { scroll-margin-top: 84px; }

@media (max-width: 1100px) {
  /* Меню в узком окне только съедало бы место под содержимое. */
  .layout { grid-template-columns: minmax(0, 1fr); }
  .nav { display: none; }
}

@media (max-width: 760px) {
  .cover { padding: 44px 22px 36px; }
  .cover__title { font-size: 29px; }
  .section { padding: 32px 22px; }
  .report-footer { padding: 24px 22px 32px; }
  .kv { grid-template-columns: 1fr; gap: 2px 0; }
  .kv dd { margin-bottom: 10px; }
}
`;
