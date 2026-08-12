/**
 * Отчёт об обновлении нетиповой конфигурации.
 *
 * Главный вопрос этого отчёта один: ЧТО ОСТАЛОСЬ СДЕЛАТЬ РУКАМИ. Всё, что
 * платформа объединила бы сама, объединено и показано числами; ценность
 * документа — в перечне дважды изменённых мест, где решение может принять
 * только человек, знающий, зачем делалась доработка.
 *
 * Поэтому раздел «Требуют вашего решения» стоит первым и не обрезается, а
 * каждый его участок показан ТРЕМЯ колонками: что было в текущей поставке,
 * что стало в новой и что у вас. Требование пользователя дословно: видеть
 * изменения «по отношению к старой конфигурации поставщика и по отношению
 * новой конфигурации поставщика к старой».
 *
 * Оформление и раскладка — те же, что у отчёта об обследовании (`styles.js`,
 * `layoutScript.js`): это один продукт, и два разных вида документа в нём
 * выглядели бы как две разные программы.
 */

import { REPORT_STYLES } from './styles.js';
import { LAYOUT_SCRIPT } from './layoutScript.js';
import { codeBlock, dedent } from './bslHighlight.js';
import { esc, plural, signature, formatDate, formatDateTime } from './ui.js';
import { formatNumber } from '../analyze/dataVolume.js';
import { APP } from '../config.js';

/**
 * @param {object} result результат конвейера обновления (`pipeline/runUpdate.js`)
 * @returns {string} самодостаточный HTML-документ
 */
export function renderUpdateReport(result) {
  const cfg = result.configs?.main || {};
  const title = `Обновление конфигурации — ${cfg.synonym || cfg.name || 'база 1С'}`;

  const sectionDefs = (result.mode === 'typical' ? [
    { id: 'upd-typical', title: 'Типовое обновление силами платформы', html: renderTypical(result) },
    { id: 'upd-checks', title: 'Проверки после обновления', html: renderChecks(result) },
    { id: 'upd-next', title: 'Что делать дальше', html: renderNext(result) },
  ] : [
    { id: 'upd-summary', title: 'Итоги объединения', html: renderSummary(result) },
    { id: 'upd-manual', title: 'Требуют вашего решения', html: renderManual(result) },
    { id: 'upd-auto', title: 'Спорные места, разобранные автоматически', html: renderAuto(result) },
    { id: 'upd-applied', title: 'Изменения поставщика, применённые автоматически', html: renderApplied(result) },
    { id: 'upd-added', title: 'Новые объекты новой поставки', html: renderGroup(result, 'added') },
    { id: 'upd-removed', title: 'Объекты, удалённые поставщиком', html: renderGroup(result, 'removed') },
    { id: 'upd-kept', title: 'Ваши доработки, оставленные как есть', html: renderGroup(result, 'kept') },
    { id: 'upd-checks', title: 'Проверки после загрузки в базу', html: renderChecks(result) },
    { id: 'upd-next', title: 'Что делать дальше', html: renderNext(result) },
  ]).filter((s) => s.html);

  return `<!doctype html>
<html lang="ru" data-theme="${result.input?.reportTheme === 'light' ? 'light' : 'dark'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${REPORT_STYLES}${UPDATE_STYLES}</style>
</head>
<body>
<div class="layout">
${renderNav(sectionDefs)}
<div class="page">
${renderCover(result)}
${sectionDefs.map(section).join('')}
<footer class="report-footer">
  Отчёт сформирован автоматически системой «${esc(APP.name)}» v${esc(APP.version)}
  ${esc(formatDateTime(result.generatedAt))}.
  Объединение выполнено по файлам XML-выгрузки; решения по дважды изменённым местам
  остаются за специалистом.
  <div style="margin-top:10px">${signature()}</div>
</footer>
</div>
</div>
<script>${LAYOUT_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Раздел: заголовок в прилипающем summary, тело — внутри.
 *
 * Устроен так же, как в отчёте об обследовании: щелчок по заголовку сворачивает
 * раздел штатным поведением элемента details, и при прокрутке видно, где ты.
 * Номер проставляется здесь по порядку, а не заглушкой-подстановкой: разделы
 * этого отчёта известны заранее, и разбирать готовую разметку регулярками
 * (чем уже дважды рвало границы разделов в аудите) незачем.
 */
function section({ id, title, html }, index) {
  return `
<section class="section" id="${id}">
  <details class="sec" open>
    <summary><span class="section__num">Раздел ${index + 1}</span><h2>${esc(title)}</h2></summary>
    <div class="sec__body">${html}</div>
  </details>
</section>`;
}

function renderNav(sectionDefs) {
  return `
<nav class="nav no-print" id="reportNav" aria-label="Содержание отчёта">
  <div class="nav__brand">Содержание</div>
  <ol class="nav__list">
    ${sectionDefs.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join('')}
  </ol>
</nav>`;
}

// --- Титульный лист ----------------------------------------------------------

/**
 * Титульный лист типового обновления.
 *
 * Числа объединения здесь были бы ложью: объединения не было и не требовалось.
 * Свойства конфигураций тоже не показываем — они читаются из XML-выгрузки,
 * а типовой путь нарочно обходится без неё (это и есть его смысл).
 */
function renderTypicalCover(result) {
  const done = result.typical?.ok;
  return `
<header class="cover">
  <p class="cover__eyebrow">Обновление конфигурации на поддержке</p>
  <h1 class="cover__title">Типовое обновление</h1>
  <p class="cover__subtitle">Доработок в конфигурации нет — обновление выполнила платформа</p>
  <dl class="cover__meta">
    <div><dt>Файл поставки</dt><dd>${esc(fileName(result.typicalSource))}</dd></div>
    <div><dt>Информационная база</dt><dd>${esc(result.infobase?.display || '—')}</dd></div>
    <div><dt>Платформа</dt><dd>${esc(result.platformVersion || '—')}</dd></div>
    <div><dt>Обновление конфигурации</dt><dd>${done ? 'выполнено' : 'не выполнялось'}</dd></div>
    <div><dt>Конфигурация базы данных</dt><dd>${result.dbUpdated ? 'обновлена' : 'не обновлялась'}</dd></div>
    <div><dt>Дата</dt><dd>${esc(formatDate(result.generatedAt))}</dd></div>
  </dl>
  <p class="cover__scope">
    Сравнение с конфигурацией поставщика и объединение не выполнялись: в базе нет доработок,
    поэтому решений, которые следовало бы принимать, тоже нет. Обновление сделано штатной
    командой платформы — так же, как это делает конфигуратор.
  </p>
</header>`;
}

function fileName(p) {
  const text = String(p || '');
  const at = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return at === -1 ? (text || '—') : text.slice(at + 1);
}

/** Раздел типового обновления: что именно сделала платформа и что сказала. */
function renderTypical(result) {
  const t = result.typical;
  const twice = t?.twiceChanged || [];

  return `
  <p class="section__lead">
    Конфигурация стоит на поддержке, и конфигурации поставщика для сравнения в базе нет —
    так отвечает база, в которой возможность изменения не включали. Значит своих правок в ней
    нет: всё содержимое нового релиза применяется целиком, выбирать не из чего. Выгрузка в XML,
    восстановление старой поставки и трёхстороннее объединение в этом случае не нужны вовсе.
  </p>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Шаг</th><th>Итог</th></tr></thead>
      <tbody>
        <tr>
          <td>Применение поставки к основной конфигурации<br>
              <span class="mono">${esc(result.typicalSource || '')}</span></td>
          <td>${t?.ok
    ? '<b class="ok">выполнено платформой</b>'
    : `<b class="bad">не выполнено</b>${t?.reason ? ` — ${esc(t.reason)}` : ''}`}</td>
        </tr>
        <tr>
          <td>Дважды изменённые свойства по данным платформы</td>
          <td>${twice.length
    ? `<b class="warn">${formatNumber(twice.length)}</b>`
    : '<b class="ok">нет</b>'}</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${twice.length ? `
  <div class="callout callout--warn">
    <div class="callout__title">Платформа сообщила о дважды изменённых свойствах</div>
    Значит доработки в конфигурации всё-таки есть, и решения по этим местам приняты
    по правилам поддержки, а не разбором. Если эти правки важны, укажите текущую поставку
    файлом и выполните обновление объединением — тогда каждое спорное место будет показано
    тремя версиями.
    <div class="mono" style="margin-top:8px">
      ${twice.slice(0, 100).map((line) => esc(line)).join('<br>')}
      ${twice.length > 100 ? `<br>…и ещё ${formatNumber(twice.length - 100)}` : ''}
    </div>
  </div>` : ''}

  ${t?.log ? `
  <div class="callout callout--info">
    <div class="callout__title">Что ответила платформа</div>
    <div class="mono">${esc(t.log.slice(0, 2000))}</div>
  </div>` : ''}`;
}

function renderCover(result) {
  if (result.mode === 'typical') return renderTypicalCover(result);
  const cfg = result.configs?.main || {};
  const base = result.configs?.base;
  const target = result.configs?.target || {};
  const totals = result.merge?.totals || {};
  const manual = manualCount(result);

  return `
<header class="cover">
  <p class="cover__eyebrow">Обновление конфигурации</p>
  <h1 class="cover__title">${esc(cfg.synonym || cfg.name || 'Конфигурация 1С')}</h1>
  <p class="cover__subtitle">${esc(coverSubtitle(result))}</p>
  <dl class="cover__meta">
    <div><dt>Основная конфигурация</dt><dd>${esc(cfg.version || 'версия не указана')}</dd></div>
    <div><dt>Текущая поставка</dt><dd>${esc(baseLabel(result, base))}</dd></div>
    <div><dt>Новая поставка</dt><dd>${esc(target.version || 'версия не указана')}</dd></div>
    <div><dt>Поставщик</dt><dd>${esc(target.vendor || cfg.vendor || 'не указан')}</dd></div>
    <div><dt>Информационная база</dt><dd>${esc(result.infobase?.display || '—')}</dd></div>
    <div><dt>Платформа</dt><dd>${esc(result.platformVersion || '—')}</dd></div>
    <div><dt>Требует решения</dt><dd>${formatNumber(manual)}</dd></div>
    <div><dt>Дата объединения</dt><dd>${esc(formatDate(result.generatedAt))}</dd></div>
  </dl>
  <p class="cover__scope">
    Взято из новой поставки без вашего участия:
    ${plural((totals.fromVendor || 0) + (totals.merged || 0), 'файл', 'файла', 'файлов')},
    новых объектов ${formatNumber(totals.addedByVendor || 0)}.
    Ваши доработки сохранены${manual ? `, кроме ${plural(manual, 'места', 'мест', 'мест')}, где правку сделали и вы, и поставщик` : ''}.
  </p>
</header>`;
}

/**
 * Откуда взялась текущая поставка.
 *
 * Различать обязательно: «версия не указана» и «восстановлена из базы» —
 * это разная степень доверия к объединению, и читатель отчёта должен видеть,
 * с чем именно сравнивали.
 */
function baseLabel(result, base) {
  if (base?.version) return base.version;
  if (result.merge?.mode === 'restored') return 'восстановлена из самой базы';
  if (base) return 'версия не указана';
  return 'исходники не предоставлены';
}

function coverSubtitle(result) {
  const from = result.configs?.main?.version;
  const to = result.configs?.target?.version;
  if (from && to) return `Объединение с версии ${from} на версию ${to}`;
  return 'Трёхстороннее объединение конфигурации с новой поставкой';
}

// --- Итоги -------------------------------------------------------------------

function renderSummary(result) {
  const totals = result.merge?.totals || {};
  const manual = manualCount(result);
  const rows = [
    ['Всего файлов в трёх выгрузках', totals.files, 'объединялись и сверялись'],
    ['Совпадает во всех версиях', totals.unchanged, 'типовой код, которого никто не касался'],
    ['Взято из новой поставки', totals.fromVendor, 'вы этих мест не меняли'],
    ['Объединено построчно', totals.merged, 'правка поставщика легла рядом с вашей'],
    ['Спорных мест разобрано самой программой', totals.autoResolved, 'показаны с исходными версиями и результатом'],
    ['Оставлено ваше', totals.keptOurs, 'поставщик этих мест не менял'],
    ['Новых объектов поставщика', totals.addedByVendor, 'скопированы и внесены в состав'],
    ['Удалено вслед за поставщиком', totals.removedByVendor, 'вы их не меняли'],
    ['Ваши собственные файлы', totals.ourOwn, 'в поставках их нет — сохранены'],
    ['Требует вашего решения', manual, 'изменено и вами, и поставщиком'],
    ['Не удалось обработать', totals.failed, 'см. перечень ниже'],
  ].filter(([, value]) => Number(value) > 0);

  return `
  ${renderModeNote(result)}
  ${(result.warnings || []).map((text) => `
  <div class="callout callout--warn">${esc(text)}</div>`).join('')}

  ${renderBar(totals, manual)}

  <div class="table-wrap">
    <table>
      <thead><tr><th>Что</th><th style="text-align:right">Файлов</th><th>Пояснение</th></tr></thead>
      <tbody>
        ${rows.map(([label, value, note]) => `
        <tr><td>${esc(label)}</td><td style="text-align:right"><b>${formatNumber(value)}</b></td><td class="muted">${esc(note)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="callout callout--plain">
    <div class="callout__title">Где лежит результат</div>
    Объединённые файлы конфигурации: <span class="mono">${esc(result.mergedDir || '—')}</span>.
    ${result.conflictDir ? `Три версии каждого спорного файла (текущая поставка, новая поставка, ваша) —
    в каталоге <span class="mono">${esc(result.conflictDir)}</span>, соответствие номеров и путей — в файле
    <span class="mono">список.txt</span>.` : ''}
    ${result.loaded
    ? `Результат <b>загружен в основную конфигурацию базы</b>. Конфигурация базы данных
      ${result.dbUpdated ? '<b>обновлена</b>' : '<b>не обновлена</b>'}.`
    : 'В конфигурацию базы результат <b>ещё не загружен</b>.'}
  </div>

  ${(result.merge?.notes || []).length ? `
  <div class="callout callout--info">
    <div class="callout__title">Что сделано с составом выгрузки</div>
    ${result.merge.notes.map((n) => `<div>${esc(n)}</div>`).join('')}
  </div>` : ''}`;
}

/**
 * Оговорка о способе объединения.
 *
 * Без неё читатель не отличит полное трёхстороннее объединение от сокращённого
 * и будет считать, что код объединён построчно, когда этого не было.
 */
function renderModeNote(result) {
  if (result.merge?.mode === 'three-way') {
    return `
  <div class="callout callout--good">
    <div class="callout__title">Полное трёхстороннее объединение</div>
    Исходники текущей поставки были предоставлены, поэтому по каждому файлу известно, кто внёс
    каждое отличие. Правки поставщика применены автоматически, ваши сохранены, а участки,
    изменённые обеими сторонами, вынесены в раздел «Требуют вашего решения» — ровно так же,
    как это делает конфигуратор при обновлении конфигурации на поддержке.
  </div>`;
  }

  if (result.merge?.mode === 'restored') {
    const stats = result.restore || {};
    return `
  <div class="callout callout--good">
    <div class="callout__title">Полное трёхстороннее объединение, поставка восстановлена из базы</div>
    Файл .cf текущей поставки не понадобился: конфигурация поставщика хранится в самой базе,
    и платформа умеет с ней сравнивать. Всё, чего нет в перечне отличий, у поставщика ровно
    такое же, как у вас (${formatNumber(stats.sameAsOurs || 0)} файлов), а тексты изменённых
    модулей собраны из подробного отчёта сравнения
    (${formatNumber(stats.restoredModules || 0)} модулей). Дальше объединение шло как обычное
    трёхстороннее — построчно, с разбором дважды изменённых мест.
    ${stats.unknown ? `<br>Прежнее значение ${plural(stats.unknown, 'файла', 'файлов', 'файлов')}
    восстановить нельзя: отчёт сравнения называет изменённое свойство, но не печатает
    прежнее значение. Такие места оставлены вашими и показаны в разделе «Требуют вашего
    решения» отличиями от новой поставки.` : ''}
  </div>`;
  }

  return `
  <div class="callout callout--warn">
    <div class="callout__title">Сокращённый режим: текущая поставка не предоставлена</div>
    Файл .cf текущей конфигурации поставщика указан не был, поэтому исходников для построчного
    объединения нет. Сравнение выполнено средствами платформы прямо в базе: известно, какие
    объекты вы изменили. Объекты без доработок взяты из новой поставки целиком, изменённые
    оставлены вашими и перечислены ниже вместе с отличиями от новой поставки — их предстоит
    перенести вручную. Чтобы объединять код автоматически, сохраните конфигурацию поставщика
    в файл (Конфигуратор → Конфигурация → Поддержка → «Сохранить конфигурацию поставщика
    в файл») и повторите объединение.
  </div>`;
}

function renderBar(totals, manual) {
  const parts = [
    ['unchanged', 'Совпадает', totals.unchanged || 0],
    ['added', 'Взято из поставки', (totals.fromVendor || 0) + (totals.merged || 0) + (totals.addedByVendor || 0)],
    ['modified', 'Оставлено ваше', totals.keptOurs || 0],
    ['removed', 'Требует решения', manual],
  ].filter(([, , value]) => value > 0);
  const sum = parts.reduce((s, [, , value]) => s + value, 0) || 1;

  return `
  <div class="diffbar">
    ${parts.map(([key, , value]) => (key === 'unchanged'
    ? '<span class="diffbar__part diffbar__part--unchanged" style="flex:1"></span>'
    : `<span class="diffbar__part diffbar__part--${key}" style="width:${Math.max((value / sum) * 100, 1.5)}%"></span>`)).join('')}
  </div>
  <div class="legend">
    ${parts.map(([key, label, value]) => `
    <span><i class="diffbar__swatch diffbar__swatch--${key}"></i>${label} — ${formatNumber(value)}</span>`).join('')}
  </div>`;
}

// --- Требуют решения ---------------------------------------------------------

function renderManual(result) {
  const objects = result.merge?.manual || [];
  if (!objects.length) {
    return `
  <div class="callout callout--good">
    <div class="callout__title">Ручной работы не осталось</div>
    Ни одного места, изменённого одновременно вами и поставщиком, не найдено: всё объединено
    автоматически. Проверьте результат в конфигураторе и обновите конфигурацию базы данных.
  </div>`;
  }

  return `
  <p class="section__lead">
    Это места, где правку относительно текущей поставки внесли и вы, и поставщик. Автоматически
    выбрать нельзя: обе правки осмысленны. В файлы выгрузки записан ВАШ вариант — обновление
    не должно молча терять доработку, — поэтому если нужна версия поставщика, перенесите её
    руками в файл выгрузки и загрузите конфигурацию.
  </p>

  <div class="tree-legend">
    <span><i class="tree-mark tree-mark--removed">1</i>Текущая поставка — то, с чего начинали обе стороны</span>
    <span><i class="tree-mark tree-mark--added">2</i>Новая поставка — что здесь изменил поставщик</span>
    <span><i class="tree-mark tree-mark--modified">3</i>Основная конфигурация — ваша правка, она и записана в файл</span>
  </div>

  <div class="difftree">
    ${objects.map(renderManualObject).join('')}
  </div>

  ${result.merge.conflictsSkipped ? `
  <p class="muted wide-note" style="font-size:13px">
    Ещё ${plural(result.merge.conflictsSkipped, 'участок', 'участка', 'участков')} не показан текстом:
    подробности ограничены, иначе отчёт разрастается до десятков мегабайт. Полные данные —
    в JSON-выгрузке результата и в каталоге со спорными файлами.
  </p>` : ''}`;
}

function renderManualObject(object) {
  const elements = object.elements.filter((e) => MANUAL_ACTIONS.has(e.action));
  const stat = plural(
    elements.reduce((sum, e) => sum + (e.conflictCount || 1), 0),
    'участок', 'участка', 'участков',
  );

  return `
  <details class="dt dt--object">
    <summary>
      <span class="tree-mark tree-mark--modified">±</span>
      <span class="dt__label">${esc(object.title)}</span>
      <span class="dt__stat">${stat}</span>
    </summary>
    <div class="dt__body">
      ${elements.map(renderManualElement).join('')}
    </div>
  </details>`;
}

const MANUAL_ACTIONS = new Set([
  'conflict', 'conflict-binary', 'conflict-too-big', 'conflict-vendor-deleted',
  'conflict-both-added', 'manual-two-way', 'manual-deleted-by-us', 'failed',
]);

function renderManualElement(element) {
  const conflicts = element.conflicts || [];
  // Спорным бывает не весь файл: в том же файле часть правок поставщика могла
  // примениться автоматически. Не сказать об этом — значит оставить читателя
  // в уверенности, что файл не обновился вовсе.
  const applied = element.autoFromVendor
    ? `<p class="dt__note">Остальное в этом файле объединено автоматически: правок поставщика
        применено ${formatNumber(element.autoFromVendor)}.</p>`
    : '';
  const body = `
      ${element.note ? `<p class="dt__note">${esc(element.note)}</p>` : ''}
      ${applied}
      <p class="dt__note"><span class="mono">${esc(element.rel)}</span></p>
      ${conflicts.map((c) => renderConflict(c, element)).join('')}
      ${element.conflictsTruncated ? `
      <p class="muted" style="font-size:12.5px">…и ещё
        ${plural(element.conflictsTruncated, 'участок', 'участка', 'участков')} в этом файле.</p>` : ''}
      ${!conflicts.length ? `<p class="dt__note">${esc(noCodeNote(element))}</p>` : ''}`;

  return `
  <details class="dt dt--module">
    <summary>
      <span class="dt__label">${esc(element.element)}</span>
      <span class="dt__status dt__status--modified">${esc(ACTION_RU[element.action] || 'требует решения')}</span>
      ${element.conflictCount ? `<span class="dt__stat">${plural(element.conflictCount, 'участок', 'участка', 'участков')}</span>` : ''}
    </summary>
    <div class="dt__body">${body}</div>
  </details>`;
}

const ACTION_RU = {
  conflict: 'изменено дважды',
  'conflict-binary': 'двоичный файл',
  'conflict-too-big': 'объединить не удалось',
  'conflict-vendor-deleted': 'поставщик удалил',
  'conflict-both-added': 'добавлено обоими',
  'manual-two-way': 'нет точки отсчёта',
  'manual-deleted-by-us': 'удалено у вас',
  failed: 'ошибка обработки',
};

function noCodeNote(element) {
  if (element.action === 'conflict-binary') {
    return 'Файл двоичный — показать отличия текстом нечем. Три версии файла лежат в каталоге '
      + 'со спорными файлами, сравните их в конфигураторе.';
  }
  if (element.action === 'manual-deleted-by-us') {
    return 'В вашей конфигурации этого элемента нет, поэтому и показывать нечего: решение — '
      + 'нужен ли он снова.';
  }
  return 'Текст отличий в отчёт не попал: подробности ограничены по объёму. Сравните три версии '
    + 'файла в каталоге со спорными файлами.';
}

/**
 * Один участок — тремя колонками.
 *
 * Две колонки, как в отчёте об обследовании, здесь не годятся: там сравнивались
 * две версии, а тут их три, и без средней («что изменил поставщик») невозможно
 * понять, чем именно новая поставка отличается от прежней.
 */
function renderConflict(conflict, element) {
  const panes = [
    ['base', 'Текущая поставка', conflict.base, conflict.baseStartLine],
    ['target', 'Новая поставка', conflict.theirs, conflict.theirsStartLine],
    ['ours', 'Основная конфигурация', conflict.ours, conflict.oursStartLine],
  ];

  return `
    <div class="dt__fragment">
      <div class="dt__fragment-head">
        ${conflict.where ? `${esc(conflict.where)} · ` : ''}строка ${formatNumber(conflict.oursStartLine || 0)}
        в основной конфигурации
      </div>
      <div class="mg__diff">
        ${panes.map(([key, label, part, line]) => `
        <div class="dt__diff-pane mg__pane--${key}">
          <div class="dt__diff-pane-head">${label}${line ? ` · строка ${formatNumber(line)}` : ''}</div>
          ${renderPane(part, element)}
        </div>`).join('')}
      </div>
      ${tailNote(panes)}
    </div>`;
}

function renderPane(part, element) {
  const lines = part?.lines || [];
  if (!lines.length) {
    return '<div class="dt__diff-empty">здесь этих строк нет</div>';
  }
  const text = lines.join('\n');
  return element.isModule ? codeBlock(text) : `<pre class="snippet">${esc(dedent(text))}</pre>`;
}

/**
 * Оговорка об обрезке — ПОД блоком кода, а не внутри.
 * Строка «и ещё N строк» внутри кода читается как часть модуля.
 */
function tailNote(panes) {
  const cut = panes.filter(([, , part]) => part?.truncated);
  if (!cut.length) return '';
  const text = cut
    .map(([, label, part]) => `${label}: показано ${part.lines.length}, ещё ${part.truncated}`)
    .join('; ');
  return `<p class="muted" style="font-size:12px">Участок длинный и показан не целиком —
    ${esc(text)}. Полные версии файла лежат в каталоге со спорными файлами.</p>`;
}

// --- Разобрано автоматически -------------------------------------------------

/**
 * Дважды изменённые места, которые программа разобрала сама.
 *
 * Показывается каждое до одного: пользователь просил видеть все автоматические
 * объединения и иметь возможность открыть то же окно с тремя версиями, что
 * и у нерешённых мест, — плюс результат, который в файл записан. Иначе
 * «разобрано автоматически» пришлось бы принимать на веру.
 */
function renderAuto(result) {
  const objects = result.merge?.auto || [];
  if (!objects.length) return '';

  return `
  <p class="section__lead">
    Здесь правку внесли и вы, и поставщик, но решение было однозначным, и программа приняла его
    сама. Каждое место показано полностью: три исходные версии и то, что записано в файл.
    Если решение не годится — впишите нужный вариант прямо в файл выгрузки и загрузите
    конфигурацию заново.
  </p>

  <div class="tree-legend">
    <span><i class="tree-mark tree-mark--removed">1</i>Текущая поставка</span>
    <span><i class="tree-mark tree-mark--added">2</i>Новая поставка</span>
    <span><i class="tree-mark tree-mark--modified">3</i>Основная конфигурация</span>
    <span><i class="tree-mark tree-mark--result">=</i>Результат — он и записан в файл</span>
  </div>

  <div class="difftree">
    ${objects.map(renderAutoObject).join('')}
  </div>`;
}

function renderAutoObject(object) {
  const elements = object.elements.filter((e) => (e.resolved || []).length);
  const count = elements.reduce((sum, e) => sum + (e.resolvedCount || 0), 0);

  return `
  <details class="dt dt--object">
    <summary>
      <span class="tree-mark tree-mark--result">=</span>
      <span class="dt__label">${esc(object.title)}</span>
      <span class="dt__stat">${plural(count, 'участок', 'участка', 'участков')}</span>
    </summary>
    <div class="dt__body">
      ${elements.map(renderAutoElement).join('')}
    </div>
  </details>`;
}

function renderAutoElement(element) {
  return `
  <details class="dt dt--module">
    <summary>
      <span class="dt__label">${esc(element.element)}</span>
      <span class="dt__status dt__status--added">разобрано автоматически</span>
      <span class="dt__stat">${plural(element.resolvedCount || 0, 'участок', 'участка', 'участков')}</span>
    </summary>
    <div class="dt__body">
      <p class="dt__note"><span class="mono">${esc(element.rel)}</span></p>
      ${(element.resolved || []).map((item) => renderResolved(item, element)).join('')}
      ${element.resolvedTruncated ? `
      <p class="muted" style="font-size:12.5px">…и ещё
        ${plural(element.resolvedTruncated, 'участок', 'участка', 'участков')} в этом файле.</p>` : ''}
    </div>
  </details>`;
}

function renderResolved(item, element) {
  const panes = [
    ['base', 'Текущая поставка', item.base, item.baseStartLine],
    ['target', 'Новая поставка', item.theirs, item.theirsStartLine],
    ['ours', 'Основная конфигурация', item.ours, item.oursStartLine],
  ];

  return `
    <div class="dt__fragment">
      <div class="dt__fragment-head">
        ${item.where ? `${esc(item.where)} · ` : ''}строка ${formatNumber(item.oursStartLine || 0)}
        <span class="mg__how">${esc(item.how || 'разобрано')}</span>
      </div>
      <p class="dt__note">${esc(item.why || '')}</p>
      <div class="mg__diff">
        ${panes.map(([key, label, part, line]) => `
        <div class="dt__diff-pane mg__pane--${key}">
          <div class="dt__diff-pane-head">${label}${line ? ` · строка ${formatNumber(line)}` : ''}</div>
          ${renderPane(part, element)}
        </div>`).join('')}
      </div>
      <div class="mg__result">
        <div class="dt__diff-pane-head">Записано в файл</div>
        ${renderPane(item.result, element)}
      </div>
    </div>`;
}

// --- Проверки платформы ------------------------------------------------------

/**
 * Что сказала платформа после загрузки.
 *
 * Раздела нет вовсе, пока в базу ничего не писали: показывать пустые проверки
 * значило бы намекать, что они провалились.
 */
function renderChecks(result) {
  const checks = result.checks;
  if (!checks) return '';

  const config = checks.config || null;
  const extensionsSyntax = checks.extensionsSyntax || null;
  const extensions = checks.extensions || {};
  const typical = result.mode === 'typical';

  const verdict = (check) => ((check.errors || []).length
    ? `<b class="bad">замечаний: ${formatNumber(check.errors.length)}</b>`
    : '<b class="ok">ошибок не найдено</b>');

  return `
  <p class="section__lead">
    ${typical
    ? 'После обновления выполнены проверки самой платформы: обновление конфигурации базы '
      + 'данных, синтаксический контроль расширений и проверка возможности их применения. '
      + 'Саму конфигурацию не проверяли: она типовая, какой её выпустил вендор, — '
      + 'и замечания к ней были бы замечаниями к типовому решению. Всё ниже — слова '
      + 'конфигуратора, а не наши.'
    : 'После загрузки объединённой выгрузки в базу выполнены проверки самой платформы: '
      + 'обновление конфигурации базы данных, синтаксический контроль конфигурации '
      + 'и расширений, проверка возможности применения расширений. Замечания ниже — '
      + 'это слова конфигуратора, а не наши.'}
  </p>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Проверка</th><th>Итог</th></tr></thead>
      <tbody>
        <tr>
          <td>Обновление конфигурации базы данных</td>
          <td>${result.dbUpdated
    ? '<b class="ok">выполнено</b>'
    : `<b class="bad">не выполнено</b>${result.dbUpdateError ? ` — ${esc(result.dbUpdateError)}` : ''}`}</td>
        </tr>
        <tr>
          <td>Синтаксический контроль конфигурации</td>
          <td>${config ? verdict(config) : '<span class="muted">не выполнялся: конфигурация типовая</span>'}</td>
        </tr>
        ${extensionsSyntax ? `
        <tr>
          <td>Синтаксический контроль расширений</td>
          <td>${verdict(extensionsSyntax)}</td>
        </tr>` : ''}
        <tr>
          <td>Применимость расширений</td>
          <td>${extensionsVerdict(extensions)}</td>
        </tr>
        ${handlersRow(result)}
      </tbody>
    </table>
  </div>

  ${(checks.fixed || []).length ? `
  <div class="callout callout--good">
    <div class="callout__title">Что программа починила в расширениях сама</div>
    ${checks.fixed.map((item) => `<div>${esc(fixLine(item))}</div>`).join('')}
  </div>` : ''}

  ${(checks.manual || []).length ? `
  <div class="callout callout--warn">
    <div class="callout__title">Что в расширениях придётся поправить руками</div>
    ${checks.manual.map((item) => `<div>${esc(fixLine(item))}</div>`).join('')}
  </div>` : ''}

  ${renderCheckErrors('Синтаксический контроль конфигурации', config?.errors)}
  ${renderCheckErrors('Синтаксический контроль расширений', extensionsSyntax?.errors)}
  ${renderCheckErrors('Применимость расширений', extensions.errors)}`;
}

/**
 * Строка про обработчики обновления.
 *
 * Их не выполняет ни загрузка, ни обновление конфигурации базы данных:
 * монопольные платформа отрабатывает при первом входе в базу, отложенные идут
 * фоновым заданием. Читателю отчёта важно знать, дошло ли дело до них и всё ли
 * доделано, — потому что до конца отложенного обновления база работает
 * не в полном объёме.
 */
function handlersRow(result) {
  const h = result.handlers;
  if (!h) return '';

  let verdict;
  if (!h.launched) {
    verdict = `<b class="bad">1С не запущена</b>${h.error ? ` — ${esc(h.error)}` : ''}`;
  } else if (h.deferred?.finished) {
    verdict = '<b class="ok">выполнены, отложенных не осталось</b>';
  } else if (h.deferred?.ok) {
    verdict = '<b class="warn">отложенные выполнены не полностью</b>'
      + `${h.deferred.background?.state ? ` — задание: ${esc(h.deferred.background.state)}` : ''}`;
  } else if (h.deferred) {
    verdict = `<b class="bad">отложенное обновление не запущено</b> — ${esc(h.deferred.reason || '')}`;
  } else {
    verdict = `<b class="warn">монопольная часть не дождалась завершения</b>${h.error ? ` — ${esc(h.error)}` : ''}`;
  }

  const details = [
    // Подтверждение легальности — запись в базу от имени пользователя, поэтому
    // в отчёте она названа прямо, а не спрятана в успешный итог.
    legalityNote(h.legality),
    h.exclusiveSeconds != null ? `монопольные: ${formatNumber(h.exclusiveSeconds)} с` : '',
    h.deferred?.job?.name ? `задание «${h.deferred.job.name}»` : '',
    // Открытая форма — не украшение: пока отложенные обработчики идут, только
    // в ней и видно, сколько их осталось.
    formNote(h.form),
  ].filter(Boolean).join(', ');

  return `
        <tr>
          <td>Обработчики обновления${details ? `<br><span class="muted">${esc(details)}</span>` : ''}</td>
          <td>${verdict}</td>
        </tr>`;
}

/** Подтверждение легальности получения обновления — коротко, для строки отчёта. */
function legalityNote(legality) {
  if (!legality) return '';
  if (legality.confirmed) return 'легальность получения обновления подтверждена программой';
  if (legality.needed === false) return '';
  return `легальность подтвердить не удалось: ${legality.reason || 'причина неизвестна'}`;
}

/** Открылась ли форма результатов обновления — коротко, для строки отчёта. */
function formNote(form) {
  if (!form) return '';
  if (form.opened) return `открыта форма «${form.title || 'результаты обновления'}»`;
  return `форма не открыта: ${form.reason || 'причина неизвестна'}`;
}

function extensionsVerdict(extensions) {
  if (!extensions.available) {
    return `<b class="warn">не выполнялась</b>${extensions.note ? ` — ${esc(extensions.note)}` : ''}`;
  }
  return (extensions.errors || []).length
    ? `<b class="bad">замечаний: ${formatNumber(extensions.errors.length)}</b>`
    : '<b class="ok">все расширения применяются</b>';
}

function fixLine(item) {
  const where = [item.extension, item.rel].filter(Boolean).join(' · ');
  const what = item.newMethod
    ? `&${item.annotation}("${item.method}") → &${item.annotation}("${item.newMethod}")`
    : item.method
      ? `&${item.annotation}("${item.method}")`
      : '';
  return [where, what, item.reason].filter(Boolean).join(' — ');
}

function renderCheckErrors(title, errors) {
  if (!errors?.length) return '';
  return `
  <details class="dt dt--module">
    <summary>
      <span class="dt__label">${esc(title)}: сообщения конфигуратора</span>
      <span class="dt__stat">${plural(errors.length, 'сообщение', 'сообщения', 'сообщений')}</span>
    </summary>
    <div class="dt__body">
      <pre class="snippet">${esc(errors.map((e) => e.text).join('\n'))}</pre>
    </div>
  </details>`;
}

// --- Остальные разделы -------------------------------------------------------

function renderApplied(result) {
  const objects = result.merge?.applied || [];
  const totals = result.merge?.totals || {};
  if (!objects.length) return '';

  return `
  <p class="section__lead">
    Здесь изменения поставщика применены без вашего участия: этих мест доработка не касалась,
    либо правка поставщика легла рядом с вашей, не пересекаясь с ней. Это и есть смысл
    обновления — типовая часть обновилась сама.
  </p>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Объект</th><th>Что обновилось</th></tr></thead>
      <tbody>
        ${objects.map((object) => `
        <tr>
          <td>${esc(object.title)}</td>
          <td class="muted">${esc(appliedElements(object))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  ${renderTruncated(result, 'applied')}
  <p class="muted wide-note" style="font-size:13px">
    Всего файлов, взятых из новой поставки: ${formatNumber((totals.fromVendor || 0) + (totals.merged || 0))}.
  </p>`;
}

function appliedElements(object) {
  const names = object.elements
    .filter((e) => e.action === 'merged' || e.action === 'from-vendor')
    .map((e) => e.element);
  const shown = names.slice(0, 6).join(', ');
  const rest = names.length - 6;
  const tail = rest > 0 ? `, и ещё ${rest}` : '';
  const merged = object.elements.filter((e) => e.action === 'merged').length;
  const note = merged ? ` (построчно объединено: ${merged})` : '';
  return `${shown}${tail}${note}`;
}

const GROUP_TEXT = {
  added: {
    lead: 'Объектов, которых не было ни в текущей поставке, ни у вас: они пришли с новой '
      + 'поставкой, скопированы в выгрузку и внесены в состав конфигурации.',
    empty: '',
  },
  removed: {
    lead: 'Поставщик удалил эти объекты, а вы их не меняли, поэтому они удалены и у вас — '
      + 'так же, как это сделал бы конфигуратор.',
    empty: '',
  },
  kept: {
    lead: 'Ваши доработки, которых новая поставка не коснулась. Ничего делать не нужно — '
      + 'раздел нужен, чтобы видеть, что они на месте.',
    empty: '',
  },
};

function renderGroup(result, key) {
  const objects = result.merge?.[key] || [];
  if (!objects.length) return '';
  const text = GROUP_TEXT[key];

  return `
  <p class="section__lead">${esc(text.lead)}</p>
  <ul class="object-list">
    ${objects.map((object) => `<li>${esc(object.title)}</li>`).join('')}
  </ul>
  ${renderTruncated(result, key)}`;
}

function renderTruncated(result, key) {
  const rest = result.merge?.truncated?.[key] || 0;
  if (!rest) return '';
  return `<p class="muted" style="font-size:13px">
    …и ещё ${plural(rest, 'объект', 'объекта', 'объектов')}. Полный перечень — в JSON-выгрузке результата.
  </p>`;
}

// --- Что дальше --------------------------------------------------------------

function renderNext(result) {
  const manual = manualCount(result);
  const steps = [];

  if (manual) {
    steps.push(
      'Разберите места из раздела «Требуют вашего решения». В файлах выгрузки сейчас стоит ваш '
      + 'вариант; если нужна версия поставщика — впишите её в файл выгрузки '
      + `(<span class="mono">${esc(result.mergedDir || '')}</span>) или возьмите из каталога `
      + 'со спорными файлами.',
    );
  }
  if (!result.loaded && result.mode === 'typical') {
    steps.push(
      'Обновление не выполнялось: запись в базу не подтверждена. Запустите обновление заново '
      + 'и подтвердите шаг записи, либо обновите конфигурацию в конфигураторе: Конфигурация → '
      + 'Поддержка → Обновить конфигурацию. Базе нужен монопольный доступ.',
    );
  } else if (!result.loaded) {
    steps.push(
      'Загрузите объединённую выгрузку в основную конфигурацию — кнопкой «Загрузить '
      + 'в конфигурацию» на странице обновления либо в конфигураторе: Конфигурация → '
      + 'Загрузить конфигурацию из файлов. Базе нужен монопольный доступ.',
    );
  }
  if (result.loaded && !result.dbUpdated) {
    steps.push(
      'Выполните «Обновить конфигурацию базы данных» в конфигураторе: программа этот шаг '
      + 'запускала, но он не прошёл — платформа объяснила причину в разделе «Проверки '
      + 'после загрузки в базу».',
    );
  }
  if ((result.checks?.manual || []).length) {
    steps.push(
      'Поправьте расширения, перечисленные в разделе «Проверки после загрузки в базу»: '
      + 'пока хотя бы одна аннотация указывает на несуществующий метод, расширение '
      + 'не применяется целиком.',
    );
  }
  steps.push(
    'Проверьте типовые обработчики обновления: после смены версии конфигурации 1С выполняет '
    + 'их при первом запуске. Сделайте резервную копию до этого шага.',
  );
  steps.push(
    'Прогоните обследование информационной базы ещё раз: оно покажет, сколько доработок '
    + 'осталось и как изменилась обновляемость.',
  );

  return `
  <ol class="steps">
    ${steps.map((step) => `<li>${step}</li>`).join('')}
  </ol>

  <div class="callout callout--info">
    <div class="callout__title">Что программа не делает</div>
    Не запускает обработчики обновления, не снимает конфигурацию с поддержки и не меняет
    правила поддержки. Всё, что она изменила, — файлы XML-выгрузки и, если это было
    подтверждено в ходе прогона, основная конфигурация базы вместе с конфигурацией базы
    данных. Откат — из резервной копии базы, сделанной до загрузки.
  </div>`;
}

function manualCount(result) {
  const totals = result.merge?.totals || {};
  return (totals.conflicted || 0) + (totals.manual || 0);
}

/**
 * Три колонки вместо двух и нумерованные шаги.
 *
 * Всё остальное берётся из общей таблицы стилей отчёта: цвета — только
 * переменными, иначе в тёмной теме блок останется светлым.
 */
const UPDATE_STYLES = `
.mg__diff {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  align-items: start;
}
.mg__pane--base .snippet   { background: var(--bg-soft); }
.mg__pane--target .snippet { background: var(--diff-vendor-bg); }
.mg__pane--ours .snippet   { background: var(--diff-client-bg); }
@media (max-width: 1100px) {
  .mg__diff { grid-template-columns: 1fr; }
}
.steps { margin: 0 0 20px; padding-left: 22px; }
.steps li { margin-bottom: 10px; max-width: 100ch; }

/* Как именно разобрано спорное место — подпись рядом с адресом участка. */
.mg__how {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 20px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--good);
  background: var(--surface-2);
}
/* Результат, записанный в файл, — под тремя колонками, во всю ширину. */
.mg__result { margin-top: 10px; }
.mg__result .snippet { background: var(--surface-2); }
.tree-mark--result { background: var(--good); color: var(--bg); }

.ok { color: var(--good); }
.bad { color: var(--danger); }
.warn { color: var(--warn); }

@media print {
  .mg__diff { grid-template-columns: 1fr; }
}
`;
