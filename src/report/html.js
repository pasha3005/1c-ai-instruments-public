/**
 * Генератор HTML-отчёта.
 *
 * Результат — самодостаточный файл: его можно переслать заказчику, открыть
 * в любом браузере и распечатать в PDF без установки чего-либо.
 *
 * Здесь — сборка документа и разделы, не выделенные в отдельные модули.
 * Крупные части живут своими файлами: перечень замечаний — `findings.js`,
 * дерево отличий от поставщика — `vendorDiff.js`, общие кирпичики (значки,
 * сворачиваемые блоки, счёт) — `ui.js`, стили — `styles.js`.
 */

import { REPORT_STYLES } from './styles.js';
import { renderMarkdown } from './markdownToHtml.js';
import { SEVERITY_RU, CATEGORY_RU } from '../analyze/rules/context.js';
import { formatNumber } from '../analyze/dataVolume.js';
import { classifyModule } from '../parse/modules.js';
import { humanSize } from '../util/fsx.js';
import { APP } from '../config.js';
import { renderFindingsBlock, FINDINGS_SCRIPT, FINDINGS_STYLES } from './findings.js';
import { renderVendorDiff } from './vendorDiff.js';
import {
  esc, badge, riskBadge, collapsible, plural, signature,
  prettyMetadataKey, formatDate, formatDateTime, SECTION_NUM,
} from './ui.js';

/**
 * @param {object} result результат runAnalysis
 * @param {object} recommendations результат buildRecommendations
 * @returns {string} полный HTML-документ
 */
export function renderHtmlReport(result, recommendations) {
  const cfg = result.configuration;
  const title = `Аудит базы 1С — ${cfg.synonym || cfg.name || 'Конфигурация'}`;

  // Раздел «Отличия от конфигурации поставщика» появляется только тогда, когда
  // поставщик доступен, поэтому номера разделов проставляются подряд уже по
  // собранному документу — иначе в отчёте без поставщика был бы пропуск.
  // Тот же список — источник дерева содержания слева: у каждого раздела свой
  // постоянный якорь `id`, не зависящий от порядкового номера.
  const sectionDefs = [
    { id: 'sec-overview', title: 'Общая оценка состояния базы', html: renderOverallScore(result) },
    { id: 'sec-architecture', title: 'Архитектурное состояние', html: renderArchitecture(result) },
    { id: 'sec-modifications', title: 'Доработки и качество кода', html: renderModificationsAndQuality(result) },
    { id: 'sec-vendor-diff', title: 'Отличия от конфигурации поставщика', html: renderVendorDiff(result) },
    { id: 'sec-updatability', title: 'Анализ обновляемости', html: renderUpdatability(result) },
    { id: 'sec-data', title: 'Анализ данных и рисков роста', html: renderDataVolume(result) },
    { id: 'sec-security', title: 'Безопасность и права доступа', html: renderSecurity(result) },
    { id: 'sec-recommendations', title: 'Рекомендации', html: renderRecommendations(recommendations) },
    { id: 'sec-plan', title: 'План улучшений', html: renderPlan(result) },
    { id: 'sec-effort', title: 'Оценка трудозатрат', html: renderEffort(result) },
  ].filter((s) => s.html);

  // Якорь ставится точечной заменой первого вхождения, а не регэкспом по всему
  // документу: разметку раздела порождаем мы сами, и открывающий тег
  // `<section class="section">` у каждого рендер-функции ровно один.
  const sections = sectionDefs
    .map((s) => s.html.replace('<section class="section">', `<section class="section" id="${s.id}">`))
    .join('');

  return collapsibleTables(numberSections(`<!doctype html>
<html lang="ru" data-theme="${reportTheme(result)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${REPORT_STYLES}${FINDINGS_STYLES}</style>
</head>
<body>
${renderToc(sectionDefs)}
<div class="page">
${renderCover(result)}
${sections}
${renderMethodology(result)}
<footer class="report-footer">
  Отчёт сформирован автоматически системой «${esc(APP.name)}» v${esc(APP.version)}
  ${esc(formatDateTime(result.generatedAt))}.
  Оценки трудозатрат носят предварительный характер и уточняются после согласования состава работ.
  <div style="margin-top:10px">${signature()}</div>
</footer>
</div>
<script>${FINDINGS_SCRIPT}</script>
</body>
</html>`));
}

/**
 * Тема оформления отчёта. Выбирается на форме аудита; по умолчанию тёмная —
 * такая же, как у окна программы, чтобы отчёт не «вспыхивал» белым листом
 * сразу после тёмного интерфейса. Печать всегда светлая (см. styles.js).
 */
function reportTheme(result) {
  return result.input?.reportTheme === 'light' ? 'light' : 'dark';
}

/**
 * Дерево содержания слева — список разделов отчёта постоянными якорями.
 *
 * Требование пользователя буквально: «не прокручивается» — список должен
 * оставаться на месте при скролле длинного документа. Отсюда `position: fixed`
 * в стилях, а не `sticky`: `sticky` через экран-другой всё равно уезжает вверх.
 *
 * Заголовок собран без `<h3>`, чтобы точно не задеть `collapsibleTables()` —
 * та ищет ровно `<h3>` рядом с таблицей, а здесь ни того ни другого нет,
 * но лишний повод для сомнений в разметке отчёта того не стоит.
 */
function renderToc(sectionDefs) {
  const items = [...sectionDefs, { id: 'sec-methodology', title: 'Методика обследования' }];
  return `
<nav class="toc no-print" aria-label="Содержание отчёта">
  <div class="toc__title">Содержание</div>
  <ol class="toc__list">
    ${items.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join('')}
  </ol>
</nav>`;
}

function numberSections(html) {
  let n = 0;
  return html.replace(/<span class="section__num" data-num><\/span>/g, () => {
    n += 1;
    return `<span class="section__num">Раздел ${n}</span>`;
  });
}

/**
 * Делает каждую таблицу сворачиваемой: заголовок `<h3>` превращается
 * в `<summary>` с числом строк справа.
 *
 * Сделано разбором готовой разметки, а не в каждом разделе руками: таблиц
 * полтора десятка, и при добавлении новой она станет сворачиваемой сама.
 * Разбор безопасен, потому что разметку порождаем мы сами: `table-wrap`
 * никогда не содержит вложенных `<div>`.
 *
 * Ограничители обязательны В ОБЕИХ группах. Без них заголовок, за которым
 * таблицы нет (например «Критичные замечания» — там карточки), утаскивал в свой
 * `<details>` всё до ближайшей таблицы, в том числе `</section>` следующего
 * раздела. Браузер на таком закрытии перестраивает дерево, блок оказывается
 * снаружи `.page` и растягивается во всю ширину окна — ровно то, что было видно
 * в отчёте.
 *
 * Ограничитель на ТЕЛЕ заголовка не менее важен, и его не хватало. `([\s\S]*?)`
 * ленив, но при неудаче продолжения регулярное выражение откатывается и
 * расширяет захват дальше — до следующего `</h3>`, потом до следующего, пока
 * где-то за ним не найдётся таблица. Так «Ключевые метрики кода», «Замечания
 * по разработчикам», «Для руководителя» и «Как собирались данные» затягивали
 * в `<summary>` по нескольку разделов сразу: заголовки наезжали друг на друга
 * и ничего не разворачивали. Теперь тело заголовка не может пересечь `</h3>`,
 * и заголовок без таблицы просто остаётся обычным заголовком.
 *
 * Заголовок, который сворачивать не нужно, пишется как `<h3 class="plain">` —
 * такой в разбор не попадает.
 *
 * Разделы остаются раскрытыми по умолчанию: отчёт должен читаться сверху вниз
 * и печататься в PDF без ручного разворачивания.
 */
function collapsibleTables(html) {
  const stop = '<h2|<h3|<\\/section>|<details|<div class="finding';
  const pattern = new RegExp(
    `<h3>((?:(?!${stop}|<\\/h3>)[\\s\\S])*?)<\\/h3>((?:(?!${stop})[\\s\\S])*?)(<div class="table-wrap">[\\s\\S]*?<\\/div>)`,
    'g',
  );

  return html.replace(pattern, (full, heading, between, table) => {
    const rows = (table.match(/<tr>/g) || []).length - 1; // минус строка заголовка
    return collapsible(heading, `${between}${table}`, {
      count: rows > 0 ? formatNumber(rows) : null,
      extraClass: 'collapsible--table',
    });
  });
}

// --- 1. Титульный лист ------------------------------------------------------

function renderCover(result) {
  const cfg = result.configuration;
  const ib = result.infobase || {};

  const client = result.input?.clientName;
  const vendorCmp = result.vendorComparison;

  return `
<header class="cover">
  <p class="cover__eyebrow">Технический аудит информационной базы</p>
  ${client ? `<p class="cover__client">${esc(client)}</p>` : ''}
  <h1 class="cover__title">${esc(cfg.synonym || cfg.name || 'Информационная база 1С')}</h1>
  <p class="cover__subtitle">${esc(coverSubtitle(result))}</p>
  <dl class="cover__meta">
    ${client ? `<div><dt>Организация</dt><dd>${esc(client)}</dd></div>` : ''}
    <div><dt>Версия конфигурации</dt><dd>${esc(cfg.version || 'не указана')}</dd></div>
    <div><dt>Поставщик</dt><dd>${esc(cfg.vendor || 'не указан')}</dd></div>
    <div><dt>Конфигурация поставщика</dt><dd>${esc(vendorConfigLabel(result))}</dd></div>
    <div><dt>Информационная база</dt><dd>${esc(ib.display || '—')}</dd></div>
    <div><dt>Платформа</dt><dd>${esc(result.input?.platformVersion || '—')}</dd></div>
    <div><dt>Объектов метаданных</dt><dd>${formatNumber(result.metadata.totals.objects)}</dd></div>
    <div><dt>Дата обследования</dt><dd>${esc(formatDate(result.generatedAt))}</dd></div>
  </dl>
  ${vendorCmp?.available && result.code.scope?.filtered ? `
  <p class="cover__scope">
    Анализ ограничен доработками: из ${formatNumber(result.code.scope?.totalModules || 0)} модулей
    конфигурации проверено ${formatNumber(result.code.scope?.analyzedModules || 0)} изменённых
    и добавленных. Типовой код поставщика не оценивался.
  </p>` : ''}
  ${result.code.scope?.analyzeVendorCode ? `
  <p class="cover__scope">
    По требованию заказчика проверено качество кода всей конфигурации, включая типовой:
    ${formatNumber(result.code.scope?.analyzedModules || 0)} модулей. Происхождение кода
    указано у каждого замечания.
  </p>` : ''}
</header>`;
}

/** Подпись конфигурации поставщика для титульного листа. */
function vendorConfigLabel(result) {
  const cmp = result.vendorComparison;
  if (cmp?.available) {
    const parts = [cmp.vendorConfigName || cmp.vendorName || 'конфигурация поставщика'];
    if (cmp.vendorVersion) parts.push(cmp.vendorVersion);
    return parts.join(' ');
  }
  // Свойства поставщика заполнены в самой конфигурации — значит она на поддержке.
  const cfg = result.configuration;
  if (cfg.vendor || cfg.version) {
    return `${cfg.vendor || 'поставщик не указан'}${cfg.version ? `, версия ${cfg.version}` : ''} (для сравнения не предоставлена)`;
  }
  return 'не определена';
}

function coverSubtitle(result) {
  const parts = [];
  if (result.configuration.typicalSolution?.matched) {
    parts.push(result.configuration.typicalSolution.title);
  } else {
    parts.push(result.configuration.isOnSupport ? 'Отраслевое или заказное решение' : 'Конфигурация вне поддержки');
  }
  parts.push(`общая оценка ${result.scores.health}/100`);
  return parts.join(' · ');
}

// --- 2. Общая оценка --------------------------------------------------------

function renderOverallScore(result) {
  const s = result.scores;
  const sev = result.code.summary.bySeverity;

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Общая оценка состояния базы</h2>
  <p class="section__lead">
    Интегральная оценка складывается из четырёх составляющих: обновляемость,
    качество кода, архитектура и состояние данных. Каждая рассчитана по прозрачной
    модели, расшифровка приведена в соответствующих разделах.
  </p>

  <div class="scores">
    ${scoreCard('Общее состояние', s.health, healthNote(s.health))}
    ${scoreCard('Обновляемость', s.updatability, result.updatability.levelRu)}
    ${scoreCard('Качество кода', s.code, plural(result.code.summary.total, 'замечание', 'замечания', 'замечаний'))}
    ${scoreCard('Архитектура', s.architecture, architectureNote(result))}
  </div>

  <h3>Распределение замечаний по критичности</h3>
  ${renderDistribution(sev, result.code.summary.total)}

  <div class="table-wrap">
  <table>
    <thead><tr><th>Показатель</th><th class="num">Значение</th><th>Комментарий</th></tr></thead>
    <tbody>
      <tr><td>Объектов метаданных</td><td class="num">${formatNumber(result.metadata.totals.objects)}</td><td>${esc(volumeComment(result))}</td></tr>
      <tr><td>Строк программного кода</td><td class="num">${formatNumber(result.code.metrics.codeLines)}</td><td>в ${formatNumber(result.code.metrics.modules)} модулях</td></tr>
      <tr><td>Процедур и функций</td><td class="num">${formatNumber(result.code.metrics.routines)}</td><td>экспортных: ${formatNumber(result.code.metrics.exportRoutines)}</td></tr>
      <tr><td>Запросов в коде</td><td class="num">${formatNumber(result.code.metrics.queries)}</td><td>анализируются на оптимальность</td></tr>
      <tr><td>Расширений конфигурации</td><td class="num">${result.extensions.count}</td><td>${esc(extensionsComment(result))}</td></tr>
      <tr><td>Ролей</td><td class="num">${result.roles.count}</td><td>с полным доступом: ${result.roles.fullAccessCount}</td></tr>
      ${result.dataVolume.available ? `<tr><td>Записей в базе</td><td class="num">${formatNumber(result.dataVolume.totalRecords)}</td><td>${esc(result.dataVolume.databaseSizeHuman || '')}</td></tr>` : ''}
    </tbody>
  </table>
  </div>
</section>`;
}

function scoreCard(label, value, note) {
  const grade = gradeClass(value);
  return `
  <div class="score ${grade}">
    <div class="score__label">${esc(label)}</div>
    <div class="score__value">${value}<small> / 100</small></div>
    <div class="score__bar"><i style="width:${Math.max(2, value)}%;background:${gradeColor(value)}"></i></div>
    <div class="score__note">${esc(note)}</div>
  </div>`;
}

function renderDistribution(bySeverity, total) {
  if (!total) {
    return '<div class="callout callout--info">Замечаний не выявлено.</div>';
  }
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  const segments = order
    .filter((k) => bySeverity[k])
    .map((k) => {
      const share = (bySeverity[k] / total) * 100;
      return `<span class="d-${k}" style="width:${share}%">${share > 7 ? bySeverity[k] : ''}</span>`;
    })
    .join('');

  const legend = order
    .filter((k) => bySeverity[k])
    .map((k) => `<span><i style="background:${severityColor(k)}"></i>${SEVERITY_RU[k]} — ${bySeverity[k]}</span>`)
    .join('');

  return `<div class="distribution">${segments}</div><div class="legend">${legend}</div>`;
}

// --- 3. Архитектурное состояние --------------------------------------------

function renderArchitecture(result) {
  const kinds = result.metadata.kindStats;
  const byType = result.code.metrics.byModuleType;
  const formShare = ((byType.form?.codeLines || 0) / Math.max(1, result.code.metrics.codeLines)) * 100;

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Архитектурное состояние</h2>
  <p class="section__lead">
    Состав метаданных и распределение кода по слоям показывают, насколько решение
    следует принятой в 1С архитектуре и во что обойдётся его дальнейшее развитие.
  </p>

  <h3>Состав объектов метаданных</h3>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Вид объекта</th><th class="num">Количество</th><th class="num">Доля</th></tr></thead>
    <tbody>
      ${kinds.slice(0, 22).map((k) => `
      <tr>
        <td>${esc(k.ru)}</td>
        <td class="num">${formatNumber(k.count)}</td>
        <td class="num">${((k.count / Math.max(1, result.metadata.totals.objects)) * 100).toFixed(1)}%</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>

  ${/* Врезка о перекосе в формы — вывод из таблицы, поэтому свёрнута вместе с ней. */ ''}
  ${collapsible('Распределение кода по видам модулей', `
  <div class="table-wrap">
  <table>
    <thead><tr><th>Вид модуля</th><th class="num">Модулей</th><th class="num">Строк кода</th><th class="num">Доля кода</th></tr></thead>
    <tbody>
      ${Object.entries(byType)
        // По убыванию числа модулей; при равенстве — по объёму кода.
        .sort((a, b) => b[1].count - a[1].count || b[1].codeLines - a[1].codeLines)
        .map(([type, data]) => `
      <tr>
        <td>${esc(moduleTypeRu(type))}</td>
        <td class="num">${formatNumber(data.count)}</td>
        <td class="num">${formatNumber(data.codeLines)}</td>
        <td class="num">${((data.codeLines / Math.max(1, result.code.metrics.codeLines)) * 100).toFixed(1)}%</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>

  ${formShare > 25 ? `
  <div class="callout callout--warn">
    <div class="callout__title">Бизнес-логика смещена в формы</div>
    В модулях форм сосредоточено ${formShare.toFixed(0)}% всего кода конфигурации.
    Это нарушает разделение слоёв: такой код нельзя переиспользовать, он дублируется
    между формами и создаёт наибольшее число конфликтов при обновлении типового решения.
  </div>` : ''}`, {
    count: formatNumber(Object.keys(byType).length),
    extraClass: 'collapsible--table',
  })}

  <h3>Наиболее «тяжёлые» объекты</h3>
  <p class="muted wide-note" style="font-size:14px">
    Отсортировано по убыванию сложности. Сложность — сводная оценка по числу
    реквизитов, табличных частей и форм: табличная часть считается за пять
    реквизитов, форма — за три. Это косвенный показатель стоимости
    сопровождения объекта.
  </p>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th>Объект</th>
      <th class="num">Сложность</th>
      <th class="num">Реквизитов</th>
      <th class="num">Таб. частей</th>
      <th class="num">Форм</th>
    </tr></thead>
    <tbody>
      ${result.metadata.heaviestObjects.slice(0, 15).map((o) => `
      <tr>
        <td>${esc(o.synonym || o.name)} <span class="muted mono">${esc(o.fullName)}</span></td>
        <td class="num"><b>${formatNumber(o.weight ?? 0)}</b></td>
        <td class="num">${o.attributeCount}</td>
        <td class="num">${o.tabularSectionCount}</td>
        <td class="num">${o.formCount}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>

  ${/* Таблицы здесь нет, поэтому разбор разметки этот заголовок не свернёт — собираем явно. */ ''}
  ${collapsible('Ключевые метрики кода', `
  <dl class="kv">
    <dt>Всего строк (с комментариями)</dt><dd>${formatNumber(result.code.metrics.totalLines)}</dd>
    <dt>Строк кода</dt><dd>${formatNumber(result.code.metrics.codeLines)}</dd>
    <dt>Строк комментариев</dt><dd>${formatNumber(result.code.metrics.commentLines)} (${commentRatio(result)}%)</dd>
    <dt>Самый большой модуль</dt><dd>${esc(result.code.metrics.maxModule.title || '—')} — ${formatNumber(result.code.metrics.maxModule.codeLines)} строк</dd>
    <dt>Самая длинная процедура</dt><dd>${esc(result.code.metrics.maxRoutine.name || '—')} — ${result.code.metrics.maxRoutine.lines} строк${result.code.metrics.maxRoutine.module ? ` (${esc(result.code.metrics.maxRoutine.module)})` : ''}</dd>
    <dt>Циклов в коде</dt><dd>${formatNumber(result.code.metrics.loops)}</dd>
  </dl>`, { extraClass: 'collapsible--table' })}
</section>`;
}

// --- 3. Доработки и качество кода -------------------------------------------

/**
 * Доработки и качество кода — один раздел.
 *
 * История укрупнения этого раздела состоит из двух шагов.
 *
 * Сначала «Технические риски» и «Проблемы производительности» были **двумя
 * разделами с одними и теми же карточками**: первый группировал по критичности,
 * второй отбирал `category === 'performance'`. Читатель дважды просматривал
 * одно и то же замечание и не понимал, чем второй перечень отличается.
 * Разрезы стали сворачиваемыми группами внутри одного раздела.
 *
 * Затем оказалось, что «Технические риски и качество кода» и «Анализ доработок»
 * тоже говорят об одном предмете. Проверяются только доработки, значит все
 * замечания — это замечания к доработкам, и разносить по разным разделам
 * «какие доработки есть» и «что с ними не так» незачем: читателю приходилось
 * листать между составом расширений и замечаниями к их коду. Требование
 * пользователя — объединить.
 *
 * Порядок внутри раздела: сначала состав доработок (сравнение с поставщиком,
 * уровень доработанности, префиксы, расширения), затем замечания к ним —
 * распространённые, по критичности, по направлениям и **сразу за ними
 * по разработчикам**: оба последних разреза отвечают на вопрос «кому это
 * чинить», и стоять они должны рядом.
 */
function renderModificationsAndQuality(result) {
  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Доработки и качество кода</h2>
  <p class="section__lead">
    Насколько решение отличается от типовой поставки, какими механизмами
    выполнены доработки — и какие замечания к их коду выявлены.
  </p>

  ${renderModificationsBody(result)}
  ${renderQualityBody(result)}
</section>`;
}

/**
 * Замечания к коду.
 *
 * Весь перечень собирает `findings.js` — там же живут фильтры и сводки.
 * Здесь остаётся только оговорка о том, что именно проверялось: без неё
 * читатель не отличает замечание к доработке от замечания к коду вендора.
 */
function renderQualityBody(result) {
  return `
  ${renderScopeNote(result)}
  ${renderFindingsBlock(result)}`;
}

/**
 * Что именно проверялось. Врезка стоит перед первым перечнем замечаний.
 *
 * Без неё читатель не может отличить замечание к доработке от замечания
 * к типовому коду вендора и по умолчанию предполагает второе — исправлять
 * такие замечания никто не будет, и доверие к отчёту теряется целиком.
 */
function renderScopeNote(result) {
  const scope = result.code.scope;

  // Пользователь сам включил проверку типового кода — предупреждение
  // обязательно: значительная часть замечаний относится к коду вендора.
  if (scope?.analyzeVendorCode) {
    return `
  <div class="callout callout--warn">
    <div class="callout__title">Проверен весь код конфигурации, включая типовой</div>
    В параметрах аудита включён флаг «Проверять качество кода в типовой конфигурации»,
    поэтому проверено ${formatNumber(scope.analyzedModules || 0)} модулей — вся конфигурация
    и все расширения.
    ${scope.vendorComparisonUsed
      ? 'Сравнение с конфигурацией поставщика выполнено, поэтому у каждого замечания указано, ' +
        'к какому коду оно относится: к расширению, к добавленному объекту, к изменённому ' +
        'типовому модулю или к типовому коду поставщика.'
      : 'Конфигурация поставщика недоступна, отделить доработки от типового кода невозможно.'}
    Замечания к типовому коду вендора исправлению силами интегратора не подлежат.
  </div>`;
  }

  if (!scope?.filtered) {
    return `
  <div class="callout callout--warn">
    <div class="callout__title">Проверен весь код конфигурации, включая типовой</div>
    Конфигурация поставщика для сравнения недоступна, поэтому отделить доработки
    от типового кода невозможно: проверено ${formatNumber(scope?.analyzedModules || 0)} модулей.
    Часть замечаний относится к коду вендора и исправлению силами интегратора не подлежит.
    Укажите конфигурацию поставщика, чтобы ограничить анализ доработками.
  </div>`;
  }

  // Случай «доработки отделены и проверка точная» — не отдельная врезка здесь,
  // а часть renderComparisonSummary() в начале раздела: там же стоит состав
  // доработок, и дублировать «что проверено» вторым блоком незачем.
  return '';
}

/**
 * Что именно проверено в коде — глубина и охват. Текст, а не отдельная
 * врезка: он входит в ту же карточку, где показан состав доработок
 * (`renderComparisonSummary`), — оба говорят об одном сравнении с поставщиком.
 */
function renderCoverageNote(scope, partial) {
  const parts = [
    `Из ${formatNumber(scope.totalModules || 0)} модулей конфигурации проверено ` +
    `${formatNumber(scope.analyzedModules || 0)}: расширения и добавленные объекты — целиком, ` +
    'изменённые типовые модули — только по тому, что отличается от поставщика.',
  ];
  if (partial.diffed) {
    parts.push(`Построчным сравнением с исходниками поставщика разобрано ${formatNumber(partial.diffed)} модулей ` +
      `(${formatNumber(partial.diffLines)} изменённых строк).`);
  }
  if (partial.fromReport) {
    parts.push('По строкам правок из отчёта платформы о сравнении с поставщиком разобрано ' +
      `${formatNumber(partial.fromReport)} модулей (${formatNumber(partial.fromReportLines)} изменённых строк).`);
  }
  if (partial.total) {
    parts.push(`Изменённых типовых модулей ${formatNumber(partial.total)}, ` +
      `из них осталось неразобранными ${formatNumber(partial.withoutMarks)}.`);
  }
  parts.push('Типовой код поставщика не оценивался.');
  return parts.join(' ');
}

/**
 * Изменённые типовые модули, в которых место правки установить не удалось.
 *
 * Различие хешей говорит, что модуль отличается от поставщика, но не говорит,
 * ГДЕ отличается, а отделить десяток авторских строк от пяти тысяч типовых
 * иначе нечем. Проверять такой модуль целиком нельзя: отчёт наполнится
 * замечаниями к коду вендора, которые никто исправлять не будет.
 *
 * Список стал коротким после того, как строки правок начали браться из
 * подробного отчёта платформы о сравнении с поставщиком: раньше сюда попадал
 * любой изменённый типовой модуль без пометок разработчика, теперь — только
 * тот, о котором сравнение не сказало ничего (например, когда платформа
 * построила лишь краткий отчёт).
 *
 * Но умолчать об остатке нельзя: непроверенный изменённый модуль — это дыра
 * в покрытии, и читатель должен знать её размер и состав поимённо.
 */
function renderUncheckedModules(partial) {
  const names = partial?.withoutMarksModules || [];
  if (!names.length) return renderKeylessModules(partial);

  const compared = partial.reportLinesAvailable || partial.diffAvailable;
  return collapsible(
    'Изменённые типовые модули, где место правки не установлено',
    `<p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
       Эти модули отличаются от конфигурации поставщика, но ${compared
    ? 'сравнение не показало по ним ни одной дописанной или изменённой строки, ' +
      'а комментариев, обрамляющих правку, в них нет'
    : 'исходников поставщика для построчного сравнения не было, ' +
      'а комментариев, обрамляющих правку, в них нет'}.
       Какие именно строки дописаны, определить нечем, поэтому код не проверялся:
       замечания относились бы к типовому коду вендора.
     </p>
     <p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
       <b>Как получить эти модули в анализ.</b> Надёжнее всего — указать в параметрах
       аудита конфигурацию поставщика файлом <span class="mono">.cf</span> или каталогом
       XML-выгрузки: тогда изменённые типовые модули разбираются построчным сравнением,
       и проверяются ровно отличия от типового кода. Второй способ — обрамлять правки
       комментариями (<span class="mono">//++ Фамилия И.О. дата</span> …
       <span class="mono">//-- Фамилия И.О.</span>).
     </p>
     <ul class="object-list">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`,
    { count: formatNumber(names.length), open: false, extraClass: 'collapsible--table' },
  ) + renderKeylessModules(partial);
}

/**
 * Корневые модули конфигурации — модуль приложения, модуль сеанса, модуль
 * внешнего соединения.
 *
 * Собственной записи в карте версий у них нет, и в отчёте о сравнении они тоже
 * не упоминаются. Значит, про них неизвестно даже того, изменялись ли они, —
 * и записывать их в «изменённые типовые модули» было бы утверждением, которое
 * нечем подтвердить. Поэтому они названы отдельно и другими словами.
 */
function renderKeylessModules(partial) {
  const names = partial?.withoutKeyModules || [];
  if (!names.length) return '';

  return collapsible(
    'Корневые модули конфигурации',
    `<p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
       У этих модулей нет собственной записи ни в карте версий конфигурации,
       ни в отчёте о сравнении с поставщиком: платформа их там не перечисляет.
       Поэтому неизвестно, изменялись ли они вообще, а проверять их целиком
       нельзя — почти наверняка это код поставщика. Если правки в них были,
       обрамите их комментариями (<span class="mono">//++ Фамилия И.О. дата</span> …
       <span class="mono">//-- Фамилия И.О.</span>) — тогда они попадут в анализ.
     </p>
     <ul class="object-list">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`,
    { count: formatNumber(names.length), open: false, extraClass: 'collapsible--table' },
  );
}

// --- Состав доработок -------------------------------------------------------

/**
 * Состав доработок: сравнение с поставщиком, уровень доработанности,
 * префиксы имён, расширения.
 *
 * Сводка «Замечания по разработчикам» отсюда убрана — она переехала вплотную
 * к разрезу «Замечания по направлениям» (см. `renderQualityBody`): оба разреза
 * про одни и те же замечания, и стоять они должны рядом.
 */
function renderModificationsBody(result) {
  const m = result.modifications;
  const ext = result.extensions;

  return `
  ${renderComparisonSummary(result)}
  ${renderExtensionObjectChanges(result)}

  ${m.prefixAnalysis.candidates.length ? `
  <h3>Префиксы имён нетиповых объектов</h3>
  <p class="muted wide-note" style="font-size:14px">
    Систематически используемые префиксы обычно соответствуют доработкам конкретного
    интегратора или проекта.
  </p>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Префикс</th><th class="num">Объектов</th><th>Виды объектов</th><th>Примеры</th></tr></thead>
    <tbody>
      ${m.prefixAnalysis.candidates.slice(0, 10).map((c) => `
      <tr>
        <td class="mono">${esc(c.prefix)}</td>
        <td class="num">${c.count}</td>
        <td>${esc(c.kinds.slice(0, 4).join(', '))}</td>
        <td class="mono" style="font-size:12px">${esc(c.samples.slice(0, 3).join(', '))}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>` : ''}

  ${/*
     * Врезка о подмене типовой логики затягивается в тот же сворачиваемый блок,
     * что и таблица расширений: разбор разметки умеет сворачивать заголовок
     * только вместе с таблицей, и врезка оставалась снаружи — отдельным
     * красным блоком без заголовка, к которому она относится.
     */ ''}
  ${renderMissingExtensions(ext)}
  ${ext.count === 0
    ? '<h3>Расширения конфигурации</h3><p class="muted">Расширения не используются.</p>'
    : collapsible('Расширения конфигурации', `
  <div class="table-wrap">
  <table>
    <thead><tr><th>Расширение</th><th>Назначение</th><th class="num">Объектов</th><th class="num">Заимствовано</th><th class="num">&Вместо</th><th>Риск</th></tr></thead>
    <tbody>
      ${ext.items.map((e) => `
      <tr>
        <td>${esc(e.synonym || e.name)}${e.version ? ` <span class="muted">${esc(e.version)}</span>` : ''}</td>
        <td>${esc(e.purposeRu)}</td>
        <td class="num">${e.objectCount}</td>
        <td class="num">${e.adoptedCount}</td>
        <td class="num">${e.annotations?.instead || 0}</td>
        <td>${riskBadge(e.risk)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>

  ${ext.impact.insteadAnnotations > 0 ? `
  <div class="callout callout--danger">
    <div class="callout__title">Подмена типовой логики: ${ext.impact.insteadAnnotations} аннотаций &Вместо</div>
    Аннотация <b>&Вместо</b> полностью заменяет типовой метод собственной реализацией.
    При обновлении типовой конфигурации исправления и доработки вендора внутри
    заменённого метода перестают применяться — без каких-либо сообщений об ошибке.
    Это скрытый источник расхождений в учёте.
    ${renderInsteadTargets(ext.items)}
  </div>` : ''}`, {
      count: formatNumber(ext.count),
      extraClass: 'collapsible--table',
    })}`;
}

/**
 * Объекты метаданных, изменённые и добавленные расширениями.
 *
 * Когда сравнение с поставщиком выполнено, эти объекты уже дописаны в общие
 * перечни изменённых и добавленных (`withExtensionChanges` в analyze/index.js),
 * и второй раз показывать их нельзя — правило отчёта. Блок нужен для другого
 * случая: конфигурации поставщика нет, общих перечней тоже, а состав доработок
 * расширениями известен точно — признак заимствования лежит в самом расширении.
 */
function renderExtensionObjectChanges(result) {
  if (result.vendorComparison?.available) return '';

  const changes = result.modifications?.extensionChanges;
  if (!changes?.total) return '';

  const list = (entries) => `
    <ul class="object-list">
      ${entries.slice(0, 400).map((e) => `<li>${esc(prettyMetadataKey(e.key))}
        <span class="src">— ${esc(e.extensions.join(', '))}</span></li>`).join('')}
    </ul>`;

  return `
  ${changes.changedCount ? collapsible(
    'Типовые объекты, изменённые расширениями',
    `<p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
       Эти типовые объекты заимствованы расширениями (<span class="mono">ObjectBelonging = Adopted</span>),
       то есть изменены. Код расширений проверен целиком: расширение и есть доработка.
     </p>${list(changes.changedObjects)}`,
    { count: formatNumber(changes.changedCount), open: false },
  ) : ''}

  ${changes.addedCount ? collapsible(
    'Объекты, добавленные расширениями',
    `<p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
       Собственные объекты расширений — их нет в основной конфигурации.
       Удалить типовой объект одним расширением нельзя, поэтому удалённых здесь не бывает.
     </p>${list(changes.addedObjects)}`,
    { count: formatNumber(changes.addedCount), open: false },
  ) : ''}`;
}

/**
 * Расширения, которые есть в базе, но исходников платформа не отдала.
 *
 * Молча потерянное расширение — это молча непроверенная доработка: в отчёте
 * её нет, и понять, что она пропущена, читателю неоткуда. Поэтому оговорка
 * стоит прямо в разделе доработок, а не в журнале выполнения.
 */
function renderMissingExtensions(ext) {
  const missing = ext.missing || [];
  if (!missing.length) return '';
  return `
  <div class="callout callout--danger">
    <div class="callout__title">Код ${missing.length === 1 ? 'расширения не проверен' : `${missing.length} расширений не проверен`}</div>
    Платформа не отдала исходники: ${missing.map((n) => `<b>${esc(n)}</b>`).join(', ')}.
    Расширение подключено к базе и работает, но его код в аудит не попал —
    замечаний по нему в отчёте нет, и отсутствие замечаний не означает,
    что их нет на самом деле.
  </div>`;
}

/**
 * Сравнение с конфигурацией поставщика — состав доработок одним блоком.
 *
 * Раньше здесь стояли раздельно: карточка «Точное сравнение» с числом
 * «добавлено» в единицах ConfigDumpInfo (объекты+модули+формы — «элементы»),
 * таблица «показатель/значение» с теми же элементами, и ниже, уже в другом
 * месте раздела, список `<dl>` «Типовое решение / На поддержке поставщика…»
 * со своим «добавлено», но уже в единицах объектов метаданных (без модулей
 * и форм). Обе цифры верные — это разный счёт одного и того же факта, —
 * но показанные раздельно и одним словом «Добавлено» они читались как
 * противоречие: «сначала 354, потом 271+126+0». Теперь счёт один блок,
 * и там, где число — про объекты, а не про элементы сравнения, это подписано
 * прямо в таблице.
 *
 * Сюда же перенесена врезка «Проверены только доработки»: она отвечала
 * на тот же вопрос («что и как проверено»), только со стороны покрытия
 * кода, а не состава объектов, и стояла в другом конце раздела.
 */
function renderComparisonSummary(result) {
  const cmp = result.vendorComparison;
  const m = result.modifications;
  const scope = result.code.scope || {};
  const partial = scope.partial || {};

  const typicalRows = `
      <tr>
        <td>Типовое решение</td>
        <td>${esc(m.typical.matched ? m.typical.title : 'не опознано')}</td>
        <td class="muted">определено по составу метаданных</td>
      </tr>
      <tr>
        <td>На поддержке поставщика</td>
        <td>${m.isOnSupport ? 'да' : '<b>нет</b>'}</td>
        <td class="muted"></td>
      </tr>
      <tr>
        <td>Признаки БСП</td>
        <td>${m.bsp.detected ? 'обнаружены' : 'не обнаружены'}</td>
        <td class="muted">${m.bsp.detected ? esc(m.bsp.markers.slice(0, 3).join(', ')) : ''}</td>
      </tr>`;

  if (!cmp?.available) {
    return `
  <div class="callout callout--warn">
    <div class="callout__title">Конфигурация поставщика для сравнения не предоставлена</div>
    ${esc(cmp?.reason || 'Путь к конфигурации поставщика не указан.')}
    Без неё состав доработок оценивается по косвенным признакам, а замечания к коду
    включают и типовой код поставщика.
    <p style="margin:10px 0 0">
      <b>Как получить:</b> Конфигуратор → Конфигурация → Поддержка →
      «Сохранить конфигурацию поставщика в файл» (.cf), затем указать путь к файлу
      в параметрах аудита.
    </p>
  </div>

  <div class="table-wrap">
  <table>
    <thead><tr><th>Показатель</th><th>Значение</th><th>Что это значит</th></tr></thead>
    <tbody>
      ${typicalRows}
      <tr>
        <td>Уровень доработок</td>
        <td>${esc(m.levelDescription)}</td>
        <td class="muted">оценка по косвенным признакам</td>
      </tr>
      <tr>
        <td>Достоверность оценки</td>
        <td>${esc(confidenceRu(m.confidence))}</td>
        <td class="muted"></td>
      </tr>
      <tr>
        <td>Затронуто объектов</td>
        <td class="num">${formatNumber(m.modifiedCount)} из ${formatNumber(result.metadata.totals.objects)} (${(m.modificationShare * 100).toFixed(1)}%)</td>
        <td class="muted"></td>
      </tr>
      <tr>
        <td>Добавлено собственных объектов</td>
        <td class="num">${formatNumber(m.addedCount)}</td>
        <td class="muted"></td>
      </tr>
    </tbody>
  </table>
  </div>

  ${m.confidence !== 'exact' ? `
  <div class="callout callout--plain">
    <div class="callout__title">О методике оценки</div>
    ${esc(m.note || '')}
  </div>` : ''}`;
  }

  // Размер эталона: при сравнении прямо в базе конфигуратор печатает только
  // различия, поэтому число элементов поставщика выводится арифметически —
  // совпавшее плюс изменённое плюс удалённое клиентом. Запасной расчёт нужен
  // и для отчётов, пересобранных из ранее сохранённых результатов.
  const vendorEntries = cmp.totalVendorEntries
    || (cmp.unchangedEntries || 0) + (cmp.modifiedEntries || 0) + (cmp.removedEntries || 0);
  return `
  <div class="callout callout--plain">
    <div class="callout__title">Проверка доработок: точное сравнение с конфигурацией поставщика</div>
    Эталон: <b>${esc(cmp.vendorConfigName || cmp.vendorName)}</b>${cmp.vendorVersion ? `, версия <b>${esc(cmp.vendorVersion)}</b>` : ''}.
    Состав доработок определён сравнением версий объектов (ConfigDumpInfo), без эвристик.
    ${esc(renderCoverageNote(scope, partial))}
  </div>

  <div class="table-wrap">
  <table>
    <thead><tr><th>Показатель</th><th class="num">Значение</th><th>Что это значит</th></tr></thead>
    <tbody>
      ${typicalRows}
      <tr>
        <td>Элементов в конфигурации поставщика</td>
        <td class="num">${formatNumber(vendorEntries)}</td>
        <td class="muted">объекты, модули и формы эталона</td>
      </tr>
      <tr>
        <td>Совпадает с поставщиком</td>
        <td class="num">${formatNumber(cmp.unchangedEntries)}</td>
        <td class="muted">не анализировалось — это типовой код вендора</td>
      </tr>
      <tr>
        <td><b>Изменено</b></td>
        <td class="num"><b>${formatNumber(cmp.modifiedEntries)}</b></td>
        <td class="muted">из них объектов: ${formatNumber(cmp.changedObjectCount)}, модулей кода: ${formatNumber(cmp.changedModuleCount)}</td>
      </tr>
      <tr>
        <td><b>Добавлено</b></td>
        <td class="num"><b>${formatNumber(cmp.addedEntries)}</b></td>
        <td class="muted">из них объектов: ${formatNumber(cmp.addedObjectCount)} — остальное модули и формы этих объектов</td>
      </tr>
      <tr>
        <td><b>Удалено относительно поставщика</b></td>
        <td class="num"><b>${formatNumber(cmp.removedEntries)}</b></td>
        <td class="muted">из них объектов метаданных: ${formatNumber(cmp.removedObjectCount ?? 0)} — код проверить нельзя, его нет</td>
      </tr>
      <tr style="border-top:2px solid var(--line)">
        <td>Затронуто объектов метаданных</td>
        <td class="num">${formatNumber(m.modifiedCount)} из ${formatNumber(result.metadata.totals.objects)} (${(m.modificationShare * 100).toFixed(1)}%)</td>
        <td class="muted">та же доработка, но в объектах, а не в элементах сравнения строками выше</td>
      </tr>
      <tr>
        <td>Проанализировано модулей</td>
        <td class="num">${formatNumber(scope.analyzedModules || 0)} из ${formatNumber(scope.totalModules || 0)}</td>
        <td class="muted">типовых модулей пропущено: ${formatNumber(scope.skippedModules || 0)}</td>
      </tr>
    </tbody>
  </table>
  </div>

  ${renderUncheckedModules(partial)}

  ${cmp.changedObjects?.length ? collapsible(
    'Изменённые объекты метаданных',
    `${extensionNote(cmp.extensionChangedCount, 'изменены расширениями')}
     ${renderObjectList(cmp.changedObjects, cmp.changedObjectCount, cmp.objectSource)}`,
    { count: formatNumber(cmp.changedObjectCount), open: false },
  ) : ''}

  ${cmp.addedObjects?.length ? collapsible(
    'Добавленные объекты метаданных',
    `${extensionNote(cmp.extensionAddedCount, 'добавлены расширениями')}
     ${renderObjectList(cmp.addedObjects, cmp.addedObjectCount, cmp.objectSource)}`,
    { count: formatNumber(cmp.addedObjectCount), open: false },
  ) : ''}

  ${cmp.removedObjects?.length ? collapsible(
    'Удалённые объекты поставщика',
    `<p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
        Объекты, которые есть в конфигурации поставщика, но отсутствуют в базе.
        Код таких объектов проверить невозможно — его нет, — однако при обновлении
        каждый из них потребует отдельного решения.
      </p>${renderObjectList(cmp.removedObjects, cmp.removedObjectCount)}`,
    { count: formatNumber(cmp.removedObjectCount), open: false },
  ) : ''}`;
}

/**
 * Приписка о том, сколько объектов в перечне пришло из расширений.
 *
 * Сравнение с поставщиком расширений не видит: оно сравнивает основную
 * конфигурацию с эталоном. Поэтому объекты, заимствованные и добавленные
 * расширениями, дописываются в те же перечни, а строка ниже объясняет,
 * откуда взялась разница с числом из отчёта конфигуратора.
 */
function extensionNote(count, what) {
  if (!count) return '';
  return `<p class="muted" style="font-size:13px;margin-bottom:10px">
    Из них <b>${formatNumber(count)}</b> ${esc(what)}: в отчёте конфигуратора о сравнении
    с поставщиком их нет — расширения в это сравнение не входят, — но это такая же
    доработка, и их код проверен наравне с остальными.
  </p>`;
}

/**
 * Перечень объектов метаданных — каждый на своей строке.
 *
 * Через запятую сплошным текстом такой список нечитаем: глазом не выхватить
 * ни отдельное имя, ни границу между объектами. Раскладка в несколько колонок
 * (см. `.object-list` в стилях) удерживает четыре сотни имён в пределах экрана.
 *
 * Ключи приходят в служебном виде «Catalog.Номенклатура» — показываем их
 * по-русски, как их видит пользователь в конфигураторе.
 */
function renderObjectList(keys, total = keys.length, sources = null) {
  const LIMIT = 400;
  const shown = keys.slice(0, LIMIT);
  const rest = total - shown.length;

  return `
      <ul class="object-list">
        ${shown.map((key) => {
    const source = sources?.[key];
    return `<li>${esc(prettyMetadataKey(key))}${source ? ` <span class="src">— ${esc(source)}</span>` : ''}</li>`;
  }).join('')}
      </ul>
      ${rest > 0 ? `<p class="muted" style="font-size:13px;margin-top:10px">…и ещё ${formatNumber(rest)}. Полный перечень — в JSON-выгрузке результата аудита.</p>` : ''}`;
}

/**
 * Заменённые аннотацией &Вместо методы — по расширениям.
 *
 * Строкой «расширение: метод» пользоваться нельзя: имя процедуры без объекта
 * ничего не говорит, а найти её в конфигураторе не по чему. Разносим по
 * колонкам — объект или модуль, процедура.
 *
 * Расширение вынесено из колонки таблицы в сворачиваемую группу: в общей
 * таблице на несколько десятков строк колонка «Расширение» повторяла одно
 * и то же значение, а вопрос «что именно подменяет вот это расширение»
 * приходилось решать глазами. Теперь каждое расширение — свой раздел
 * со счётчиком, и раскрывается ровно то, что разбирают.
 *
 * Путь модуля разбираем тем же классификатором, что и при анализе кода, чтобы
 * подпись объекта совпадала с той, что стоит в замечаниях.
 */
function renderInsteadTargets(extensions) {
  const groups = [];
  for (const ext of extensions) {
    const targets = ext.annotations?.insteadTargets || [];
    if (!targets.length) continue;
    groups.push({
      title: ext.synonym || ext.name,
      rows: targets.map((t) => ({ where: moduleTitleFromPath(t.module), method: t.target })),
    });
  }
  if (!groups.length) return '';

  const LIMIT = 60;
  groups.sort((a, b) => b.rows.length - a.rows.length);

  return `<div class="instead-groups">${groups.map((group) => {
    const shown = group.rows.slice(0, LIMIT);
    const rest = group.rows.length - shown.length;
    return collapsible(esc(group.title), `
    <div class="table-wrap" style="margin-bottom:0">
    <table class="instead-table">
      <thead><tr><th>Объект или модуль</th><th>Процедура (функция)</th></tr></thead>
      <tbody>
        ${shown.map((r) => `
        <tr>
          <td>${esc(r.where)}</td>
          <td class="mono">${esc(r.method)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
    ${rest > 0 ? `<p class="muted" style="font-size:13px;margin:8px 0 0">Показаны ${LIMIT} из ${formatNumber(group.rows.length)} заменённых методов этого расширения.</p>` : ''}`, {
      count: plural(group.rows.length, 'метод', 'метода', 'методов'),
      open: false,
      extraClass: 'collapsible--group',
    });
  }).join('')}</div>`;
}

/** «CommonModules\\Имя\\Ext\\Module.bsl» → «Общий модуль «Имя»». */
function moduleTitleFromPath(rel) {
  if (!rel) return '—';
  try {
    return classifyModule('', rel).title;
  } catch {
    return rel;
  }
}

// --- 7. Обновляемость -------------------------------------------------------

function renderUpdatability(result) {
  const u = result.updatability;

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Анализ обновляемости</h2>
  <p class="section__lead">
    Оценка того, насколько сложно будет обновить эту базу на новую версию
    типовой конфигурации. Модель штрафная: каждый фактор снимает баллы от 100.
  </p>

  <div class="scores">
    ${scoreCard('Обновляемость', u.score, u.levelRu)}
    <div class="score" style="grid-column: span 3">
      <div class="score__label">Что это означает</div>
      <p style="margin:6px 0 0;font-size:14.5px">${esc(u.updateEffort)}</p>
    </div>
  </div>

  <h3>Расшифровка оценки</h3>
  ${u.reasons.length ? `
  <div class="table-wrap">
  <table>
    <thead><tr><th class="num">Штраф</th><th>Фактор</th><th>Пояснение</th></tr></thead>
    <tbody>
      ${u.reasons.map((r) => `
      <tr>
        <td class="num"><b>−${r.points}</b></td>
        <td>${esc(r.title)}</td>
        <td class="muted">${esc(r.detail)}</td>
      </tr>`).join('')}
      <tr>
        <td class="num"><b>${u.score}</b></td>
        <td colspan="2"><b>Итоговая оценка обновляемости</b></td>
      </tr>
    </tbody>
  </table>
  </div>` : '<div class="callout callout--info">Факторов, снижающих обновляемость, не выявлено — конфигурация обновляется штатно.</div>'}
</section>`;
}

// --- 8. Данные --------------------------------------------------------------

function renderDataVolume(result) {
  const d = result.dataVolume;

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Анализ данных и рисков роста</h2>

  ${!d.available ? `
  <div class="callout callout--warn">
    <div class="callout__title">Сбор данных из базы не выполнен</div>
    ${esc(d.reason || '')}.
    Приведён анализ по структуре метаданных: объекты, склонные к неограниченному росту.
  </div>` : `
  <dl class="kv">
    <dt>Размер файла базы</dt><dd>${esc(d.databaseSizeHuman || 'не определён (серверная база)')}</dd>
    <dt>Записей всего</dt><dd>${formatNumber(d.totalRecords)}</dd>
    <dt>Объектов посчитано</dt><dd>${formatNumber(d.countedObjects)}</dd>
    <dt>Физических таблиц</dt><dd>${formatNumber(d.physicalTables)}</dd>
    <dt>Время сбора</dt><dd>${Math.round((d.durationMs || 0) / 1000)} с</dd>
  </dl>

  ${renderTopTables(d)}

  ${renderEmptyObjects(d)}
  ${renderVolumeInsights(d)}
  `}

  ${d.risks?.length ? collapsible('Риски роста данных', d.risks.slice(0, 15).map((r) => `
  <div class="finding finding--${r.severity}">
    <div class="finding__head">
      <span class="finding__title">${esc(r.title)}</span>
      ${badge(r.severity)}
    </div>
    <div class="finding__detail">${esc(r.detail)}</div>
    <div class="finding__rec"><b>Рекомендация.</b> ${esc(r.recommendation)}</div>
  </div>`).join(''), {
    count: formatNumber(d.risks.length),
    extraClass: 'collapsible--table',
  }) : ''}

  ${d.failedCounts?.length ? `
  <p class="muted" style="font-size:13px">
    Не удалось получить количество записей для ${d.failedCounts.length} объектов
    (виртуальные таблицы, объекты с разделителями или недостаточные права).
  </p>` : ''}
</section>`;
}

/**
 * Крупнейшие объекты по числу записей — с разбивкой по видам.
 *
 * Общая таблица «первые двадцать по всей базе» неинформативна: её всегда
 * занимают регистры сведений и движений, а вопрос «какой самый большой
 * справочник» остаётся без ответа. Поэтому вид объекта вынесен из колонки
 * таблицы в отдельный сворачиваемый раздел, и внутри каждого — своя сотня
 * крупнейших.
 */
function renderTopTables(d) {
  const counts = (d.allCounts?.length ? d.allCounts : d.topTables) || [];
  const nonEmpty = counts.filter((c) => c.count > 0);
  if (!nonEmpty.length) return '';

  const groups = groupCountsByKind(nonEmpty).sort((a, b) => b.records - a.records);

  return collapsible('Крупнейшие объекты по числу записей', `
  <p class="muted wide-note" style="font-size:14px">
    По каждому виду объектов — до ${TOP_PER_KIND} крупнейших, по убыванию числа записей.
    Доля считается от всех записей базы.
  </p>
  ${groups.map((g) => collapsible(
    esc(g.kindRu),
    renderCountsTable(g.items.slice(0, TOP_PER_KIND), d.totalRecords),
    {
      count: `${formatNumber(g.items.length)} об. · ${formatNumber(g.records)} зап.`,
      open: false,
      extraClass: 'collapsible--group',
    },
  )).join('')}`, {
    count: formatNumber(nonEmpty.length),
    extraClass: 'collapsible--table',
  });
}

/** Сколько объектов показывать внутри одного вида. */
const TOP_PER_KIND = 50;

function renderCountsTable(items, totalRecords) {
  return `
  <div class="table-wrap">
  <table>
    <thead><tr><th>Объект</th><th class="num">Записей</th><th class="num">Доля</th></tr></thead>
    <tbody>
      ${items.map((t) => `
      <tr>
        <td>${esc(t.synonym || t.name)} <span class="muted mono">${esc(t.fullName)}</span></td>
        <td class="num">${formatNumber(t.count)}</td>
        <td class="num">${totalRecords ? ((t.count / totalRecords) * 100).toFixed(1) : '0.0'}%</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>`;
}

function groupCountsByKind(counts) {
  const map = new Map();
  for (const c of counts) {
    if (!map.has(c.kind)) map.set(c.kind, { kind: c.kind, kindRu: c.kindRu, items: [], records: 0 });
    const entry = map.get(c.kind);
    entry.items.push(c);
    entry.records += c.count || 0;
  }
  return [...map.values()];
}

/**
 * Объекты, не содержащие ни одной записи.
 *
 * Раскладка та же, что у «Изменённых объектов метаданных»: вид объекта —
 * сворачиваемый раздел, внутри полный перечень имён по алфавиту в несколько
 * колонок. Прежний вариант — одна строка таблицы на вид с первыми
 * двадцатью пятью именами через запятую — не давал ответить на единственный
 * осмысленный здесь вопрос: используется конкретный объект или нет.
 */
function renderEmptyObjects(d) {
  const empty = d.emptyObjects || [];
  if (!empty.length) return '';

  const groups = groupCountsByKind(empty).sort((a, b) => b.items.length - a.items.length);

  return collapsible('Объекты без данных', `
  <p class="muted wide-note" style="font-size:14px">
    Эти объекты метаданных существуют в конфигурации, но не содержат ни одной записи —
    соответствующая функциональность не используется. Перечни полные,
    имена упорядочены по алфавиту.
  </p>
  ${groups.map((g) => collapsible(
    esc(g.kindRu),
    renderNameList(g.items),
    {
      count: formatNumber(g.items.length),
      open: false,
      extraClass: 'collapsible--group',
    },
  )).join('')}`, {
    count: formatNumber(empty.length),
    open: false,
    extraClass: 'collapsible--table',
  });
}

/** Перечень имён объектов в несколько колонок, по алфавиту. */
function renderNameList(items) {
  const sorted = [...items].sort((a, b) => (a.synonym || a.name).localeCompare(b.synonym || b.name, 'ru'));
  return `
      <ul class="object-list">
        ${sorted.map((o) => `<li>${esc(o.synonym || o.name)}${o.synonym && o.synonym !== o.name ? ` <span class="muted mono">${esc(o.name)}</span>` : ''}</li>`).join('')}
      </ul>`;
}

/**
 * Выводы, сделанные на основании количества записей.
 *
 * Собираются явным `collapsible`: раньше здесь стоял `<h3>`, а разбор разметки
 * умеет сворачивать только заголовок с таблицей — врезки под ним оставались
 * снаружи, и переключатель, попадая сюда от соседнего заголовка, ничего
 * не сворачивал.
 */
function renderVolumeInsights(d) {
  if (!d.insights?.length) return '';
  return collapsible('Выводы по составу данных', d.insights.map((insight) => `
  <div class="callout callout--info">
    <div class="callout__title">${esc(insight.title)}</div>
    ${esc(insight.detail)}
  </div>`).join(''), {
    count: formatNumber(d.insights.length),
    extraClass: 'collapsible--table',
  });
}

// --- 9. Безопасность --------------------------------------------------------

function renderSecurity(result) {
  const sec = result.security;
  const roles = result.roles;
  const findings = result.findings.filter((f) => f.category === 'security');

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Безопасность и права доступа</h2>

  <dl class="kv">
    <dt>Ролей в конфигурации</dt><dd>${roles.count}</dd>
    <dt>С правом администрирования</dt><dd>${roles.fullAccessCount}${roles.fullAccessNames.length ? ` (${esc(roles.fullAccessNames.slice(0, 5).join(', '))})` : ''}</dd>
    <dt>Ограничений RLS</dt><dd>${roles.totalRestrictions || 'не используются'}</dd>
    <dt>Ролей «права для новых объектов»</dt><dd>${roles.setForNewObjectsCount}</dd>
    <dt>Замечаний в коде</dt><dd>${sec.findingsCount}, из них высокой критичности: ${sec.criticalCount}</dd>
  </dl>

  ${sec.observations?.length ? collapsible('Замечания по разграничению доступа', sec.observations.map((o) => `
      <div class="finding finding--${o.severity}">
        <div class="finding__head">
          <span class="finding__title">${esc(o.title)}</span>
          ${badge(o.severity)}
        </div>
        <div class="finding__detail">${esc(o.detail)}</div>
        <div class="finding__rec"><b>Рекомендация.</b> ${esc(o.recommendation)}</div>
      </div>`).join(''), { count: formatNumber(sec.observations.length) })
    : '<div class="callout callout--info">Существенных замечаний по разграничению доступа не выявлено.</div>'}

  ${/*
     * Сами замечания по безопасности здесь не повторяются: они уже перечислены
     * в разделе «Доработки и качество кода». Раньше тут стояла их вторая копия,
     * и одно и то же замечание читатель встречал дважды. Вместо копии —
     * указание, чем отобрать их в общем перечне.
     */ ''}
  ${findings.length ? `
  <div class="callout callout--info">
    <div class="callout__title">Замечания по безопасности в коде: ${formatNumber(findings.length)}</div>
    Перечислены вместе с остальными в разделе «Доработки и качество кода» —
    выберите там направление <b>«${esc(CATEGORY_RU.security)}»</b>, чтобы
    оставить только их. Повторять их здесь значило бы показывать одно и то же
    замечание дважды.
  </div>` : ''}
</section>`;
}

// --- 10. Рекомендации -------------------------------------------------------

function renderRecommendations(recommendations) {
  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Рекомендации</h2>
  ${recommendations.aiUsed
    ? '<p class="muted" style="font-size:13.5px">Разделы подготовлены с использованием языковой модели на основе фактов, полученных при автоматическом анализе.</p>'
    : ''}
  ${recommendations.aiError
    ? `<div class="callout callout--warn">AI-обогащение недоступно (${esc(recommendations.aiError)}). Приведены рекомендации, сформированные детерминированным движком.</div>`
    : ''}

  ${/*
     * Оба блока собираются явным `collapsible`: таблиц в них нет, поэтому
     * разбор разметки их не свернёт. Раньше здесь стояли голые `<h3>`, и
     * разбор, не найдя таблицы, утаскивал в заголовок разметку следующих
     * разделов — заголовки наезжали друг на друга и не разворачивались.
     */ ''}
  ${collapsible('Для руководителя', renderMarkdown(recommendations.manager) || '<p class="muted">Рекомендации не сформированы.</p>', { extraClass: 'collapsible--table' })}
  ${collapsible('Для технического архитектора', renderMarkdown(recommendations.architect) || '<p class="muted">Рекомендации не сформированы.</p>', { extraClass: 'collapsible--table' })}
</section>`;
}

// --- 11. План улучшений -----------------------------------------------------

function renderPlan(result) {
  return `
<section class="section">
  ${SECTION_NUM}
  <h2>План улучшений</h2>
  <p class="section__lead">
    Этапы упорядочены по соотношению «эффект — затраты»: сначала снимаются
    проблемы, которые мешают работе пользователей прямо сейчас.
  </p>

  ${result.plan.map((stage) => `
  <div class="stage">
    <div class="stage__head">
      <span class="stage__title">${esc(stage.title)}</span>
      <span class="stage__meta">${stage.durationWeeks ? `≈ ${stage.durationWeeks} нед.` : ''}</span>
    </div>
    <div class="stage__goal">${esc(stage.goal)}</div>
    <ul>${stage.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
    <div class="stage__effect"><b>Ожидаемый эффект:</b> ${esc(stage.effect)}</div>
  </div>`).join('')}
</section>`;
}

// --- 12. Трудозатраты -------------------------------------------------------

function renderEffort(result) {
  const e = result.effort;

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Оценка трудозатрат</h2>
  <p class="section__lead">
    Расчёт по нормативам на устранение каждого типа замечаний с поправкой
    на сложность конфигурации (коэффициент ${e.complexityFactor}).
  </p>

  <div class="scores">
    <div class="score">
      <div class="score__label">Оптимистично</div>
      <div class="score__value">${formatNumber(e.total.optimistic)}<small> ч</small></div>
    </div>
    <div class="score">
      <div class="score__label">Базовая оценка</div>
      <div class="score__value" style="color:var(--accent)">${formatNumber(e.total.hours)}<small> ч</small></div>
      <div class="score__note">≈ ${e.total.days} рабочих дней</div>
    </div>
    <div class="score">
      <div class="score__label">Пессимистично</div>
      <div class="score__value">${formatNumber(e.total.pessimistic)}<small> ч</small></div>
    </div>
    ${e.budget ? `
    <div class="score">
      <div class="score__label">Бюджет (${formatNumber(e.budget.hourlyRate)} ₽/ч)</div>
      <div class="score__value" style="font-size:26px">${formatNumber(e.budget.base)}<small> ₽</small></div>
      <div class="score__note">${formatNumber(e.budget.optimistic)} — ${formatNumber(e.budget.pessimistic)} ₽</div>
    </div>` : ''}
  </div>

  <h3>Структура трудозатрат</h3>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Направление</th><th class="num">Замечаний</th><th class="num">Часов</th></tr></thead>
    <tbody>
      ${e.byCategory.map((c) => `
      <tr>
        <td>${esc(CATEGORY_RU[c.category] || categoryRuExtra(c.category))}</td>
        <td class="num">${c.findings}</td>
        <td class="num">${c.hours}</td>
      </tr>`).join('')}
      <tr>
        <td><b>Разработка, итого</b></td>
        <td class="num"></td>
        <td class="num"><b>${e.remediation.developmentHours}</b></td>
      </tr>
      <tr>
        <td>Анализ, тестирование, документирование, управление</td>
        <td class="num"></td>
        <td class="num">${e.remediation.overheadHours}</td>
      </tr>
      <tr>
        <td><b>${esc(e.update.scenario)}</b></td>
        <td class="num"></td>
        <td class="num"><b>${e.update.hours}</b></td>
      </tr>
      <tr style="border-top:2px solid var(--line)">
        <td><b>ИТОГО</b></td>
        <td class="num"></td>
        <td class="num"><b>${e.total.hours}</b></td>
      </tr>
    </tbody>
  </table>
  </div>

  ${e.update.components ? `
  <h4>Детализация работ по обновлению</h4>
  <ul>
    <li>Сравнение и объединение конфигураций — ${e.update.components.merge} ч</li>
    <li>Тестирование после обновления — ${e.update.components.testing} ч</li>
    <li>Адаптация расширений — ${e.update.components.extensions} ч</li>
  </ul>` : ''}
  <p class="muted">${esc(e.update.detail)}</p>

  <div class="footnote">${esc(e.breakdownNote)}</div>
</section>`;
}

// --- Методика ---------------------------------------------------------------

function renderMethodology(result) {
  // Заголовки помечены `plain`: методика короткая и читается целиком, сворачивать
  // в ней нечего. Разбор разметки такие заголовки не трогает.
  return `
<section class="section" id="sec-methodology">
  <span class="section__num">Приложение А</span>
  <h2>Методика обследования</h2>

  <h3 class="plain">Как собирались данные</h3>
  <ul>
    <li>Конфигурация выгружена в XML средствами платформы 1С (${esc(result.input?.driver || 'ibcmd/конфигуратор')}) и разобрана статически.</li>
    <li>Модули кода проанализированы лексическим анализатором встроенного языка: правила
        учитывают контекст (строки, комментарии, тела циклов и процедур).</li>
    <li>${result.dataVolume.available
      ? 'Количество записей и структура хранения получены через COM-соединение с работающей базой.'
      : 'Сбор количественных данных из базы не выполнялся — анализ данных проведён по структуре метаданных.'}</li>
    <li>Изменения в базе не вносились: все операции выполнялись в режиме чтения.</li>
  </ul>

  <h3 class="plain">Границы применимости</h3>
  <ul>
    <li>Признак «объект снят с поддержки» хранится в служебных таблицах базы и не попадает
        в XML-выгрузку, поэтому состав изменений типовых объектов оценивается
        ${result.modifications.confidence === 'exact' ? 'сравнением с эталонной выгрузкой' : 'по косвенным признакам'}.</li>
    <li>Статический анализ выявляет проблемы, видимые в исходном коде. Он не заменяет
        нагрузочное тестирование и анализ планов запросов на реальных данных.</li>
    <li>Оценка трудозатрат основана на нормативах и не учитывает специфику конкретных
        бизнес-требований заказчика.</li>
  </ul>

  <h3 class="plain">Шкала критичности</h3>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Уровень</th><th>Что означает</th></tr></thead>
    <tbody>
      <tr><td>${badge('critical')}</td><td>Проблема проявляется уже сейчас или проявится при росте данных; требует устранения в первую очередь.</td></tr>
      <tr><td>${badge('high')}</td><td>Существенный риск для производительности, безопасности или обновляемости.</td></tr>
      <tr><td>${badge('medium')}</td><td>Ухудшает сопровождаемость и повышает стоимость доработок.</td></tr>
      <tr><td>${badge('low')}</td><td>Отклонение от стандартов разработки; устраняется в плановом порядке.</td></tr>
    </tbody>
  </table>
  </div>
</section>`;
}

// --- Вспомогательные функции ------------------------------------------------

function gradeClass(score) {
  if (score >= 80) return 'grade-good';
  if (score >= 60) return 'grade-warn';
  if (score >= 35) return 'grade-bad';
  return 'grade-crit';
}

/*
 * Цвета — переменными, а не хексами: у отчёта две темы, и хекс остался бы
 * светлым на тёмном листе. Значения подставляются инлайном, потому что ширина
 * и цвет полоски считаются по числу.
 */
function gradeColor(score) {
  if (score >= 80) return 'var(--good)';
  if (score >= 60) return 'var(--medium)';
  if (score >= 35) return 'var(--high)';
  return 'var(--critical)';
}

function severityColor(severity) {
  return {
    critical: 'var(--critical)',
    high: 'var(--high)',
    medium: 'var(--medium)',
    low: 'var(--low)',
    info: 'var(--info)',
  }[severity] || 'var(--info)';
}

function healthNote(score) {
  if (score >= 85) return 'состояние хорошее';
  if (score >= 70) return 'удовлетворительное';
  if (score >= 50) return 'есть существенные проблемы';
  if (score >= 30) return 'неудовлетворительное';
  return 'критическое';
}

function architectureNote(result) {
  const dup = result.findings.filter((f) => f.ruleId === 'arch.duplicate-code').length;
  return dup ? `дублирований кода: ${dup}` : 'дублирований не выявлено';
}

function volumeComment(result) {
  const n = result.metadata.totals.objects;
  if (n > 6000) return 'очень крупное решение';
  if (n > 3000) return 'крупное решение';
  if (n > 1000) return 'среднее решение';
  if (n > 200) return 'небольшое решение';
  return 'компактная конфигурация';
}

function extensionsComment(result) {
  const i = result.extensions.impact;
  if (!result.extensions.count) return 'не используются';
  return `заимствовано типовых объектов: ${i.adoptedObjects}`;
}

function commentRatio(result) {
  const total = result.code.metrics.codeLines + result.code.metrics.commentLines;
  if (!total) return '0';
  return ((result.code.metrics.commentLines / total) * 100).toFixed(0);
}

function moduleTypeRu(type) {
  return {
    common: 'Общие модули', object: 'Модули объектов', manager: 'Модули менеджеров',
    recordset: 'Модули наборов записей', form: 'Модули форм', command: 'Модули команд',
    application: 'Модуль приложения', session: 'Модуль сеанса',
    externalConnection: 'Модуль внешнего соединения', valueManager: 'Модули менеджеров значения',
    other: 'Прочие модули',
  }[type] || type;
}

function categoryRuExtra(category) {
  return category === 'data' ? 'Работы по данным и индексам' : category;
}

function confidenceRu(confidence) {
  return {
    exact: 'точная — сравнение с эталонной выгрузкой',
    estimated: 'оценочная — по косвенным признакам',
    unknown: 'низкая — конфигурация не опознана как типовая',
  }[confidence] || 'не определена';
}

export { humanSize };
