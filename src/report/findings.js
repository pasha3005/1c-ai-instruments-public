/**
 * Замечания к коду — единственный их перечень в отчёте.
 *
 * ## Почему перечень один
 *
 * Раньше замечания жили в двух документах и в трёх разрезах: основной отчёт
 * показывал выборку по критичности и по направлениям, а отдельный файл
 * `findings.html` повторял всё целиком плюс разрез по разработчикам. Одно
 * и то же замечание читатель встречал до четырёх раз и не понимал, чем один
 * перечень отличается от другого.
 *
 * Теперь перечень **один** — по критичности → тип замечания → случаи, — а всё
 * остальное сделано так, чтобы не порождать вторую копию тех же карточек:
 *
 *   * разрез по направлениям и по разработчикам — это **фильтры**, а не разделы;
 *   * сводки по типам и по разработчикам — **таблицы со счётчиками**, из них
 *     переходят в перечень, а не читают замечания второй раз.
 *
 * Требование пользователя формулировалось прямо: «убрать второй отчёт»
 * и «проверить логически, чтобы новый раздел не имел дублирующихся разделов».
 *
 * ## Пример кода в каждом случае
 *
 * У каждого случая показан фрагмент исходного текста — той самой строки,
 * к которой относится замечание. Без него читателю приходится открывать
 * конфигуратор, чтобы понять, о чём речь, и отчёт перестаёт быть
 * самодостаточным. Фрагмент проставляется в `rules/context.js` при регистрации
 * замечания, поэтому он есть у всех правил, а не только у тех, что позаботились
 * сами. В изменённом типовом модуле правила видят текст, где типовые строки
 * вычищены, — значит, в отчёт физически не может попасть код вендора.
 */

import { SEVERITY_RU, CATEGORY_RU, SEVERITY_ORDER } from '../analyze/rules/context.js';
import { formatNumber } from '../analyze/dataVolume.js';
import { ruName } from '../parse/metadataKinds.js';
import {
  esc, badge, authorBadge, originBadge, collapsible, plural, stripTrailingCount, slug, shorten,
} from './ui.js';
import { codeBlock } from './bslHighlight.js';

/**
 * Сколько случаев одного типа выводить.
 *
 * На крупных конфигурациях одно правило даёт тысячи срабатываний, и документ
 * такого размера браузер уже не открывает. Для принятия решений достаточно
 * выборки: тип проблемы и способ исправления одинаковы для всех случаев,
 * а полный машиночитаемый перечень всегда есть в JSON-выгрузке.
 */
const MAX_CASES_PER_RULE = 300;

/**
 * Перечень замечаний целиком: фильтры, сводки, случаи с кодом.
 * @param {object} result результат runAnalysis
 */
export function renderFindingsBlock(result) {
  const findings = result.findings || [];
  if (!findings.length) {
    return '<div class="callout callout--good">Замечаний не выявлено.</div>';
  }

  const byRule = groupByRule(findings);
  const byAuthor = groupByAuthor(findings);
  const bySeverity = groupBySeverity(findings);

  // Поиск, обе сводки и сам перечень — одно целое: перечень читают через
  // фильтры и сводки, а не отдельно от них, поэтому весь блок сворачивается
  // и раскрывается одним заголовком. Свёрнуто по умолчанию, как и всё здесь.
  //
  // Порядок задан пользователем: сначала сводка по типам — она отвечает
  // на вопрос «что вообще нашли», — а поиск и фильтры лежат внутри сводки
  // по разработчикам, потому что отбирают ими одно и то же: и щелчок по имени,
  // и строка поиска правят один перечень ниже. Разработчиков нет — фильтры
  // выводятся сами по себе, иначе искать было бы нечем.
  return `
  ${collapsible('Сводки и поиск по замечаниям', `
  ${renderRuleSummary(result, byRule)}
  ${renderAuthorSummary(byAuthor, findings) || renderFilters(findings)}

  <h3 class="plain">Перечень замечаний</h3>
  <p class="muted wide-note" style="font-size:13.5px">
    Уровень критичности → тип замечания → случаи. Начинать следует с критичных:
    одно исправление обычно закрывает сразу много однотипных случаев.
    У каждого случая приведён фрагмент кода, к которому относится замечание.
  </p>
  ${bySeverity.map((level) => renderSeverityLevel(level)).join('')}`)}`;
}

/**
 * Поиск и фильтры.
 *
 * Разрез по направлениям был отдельным разделом с теми же карточками — теперь
 * это чипы рядом с критичностью. Так же поступили с разработчиками: их имена
 * в сводке кликабельны и просто подставляются в поиск. Возможность посмотреть
 * «что тут по производительности» или «что написал такой-то» сохранена,
 * а второй копии перечня нет.
 */
function renderFilters(findings) {
  const severities = SEVERITY_ORDER.filter((s) => countBy(findings, 'severity', s));
  const categories = [...new Set(findings.map((f) => f.category))]
    .sort((a, b) => countBy(findings, 'category', b) - countBy(findings, 'category', a));
  const authors = groupByAuthor(findings);

  return `
  <div class="filters no-print">
    <input type="search" id="findingSearch" autocomplete="off"
           placeholder="Поиск по модулю, объекту, процедуре или тексту замечания…">
    <div class="filter-chips" data-filter="severity">
      <button type="button" class="chip is-active" data-value="all">Все уровни</button>
      ${severities.map((s) => `
      <button type="button" class="chip" data-value="${esc(s)}">${esc(SEVERITY_RU[s])} — ${countBy(findings, 'severity', s)}</button>`).join('')}
    </div>
    <div class="filter-chips" data-filter="category">
      <button type="button" class="chip is-active" data-value="all">Все направления</button>
      ${categories.map((c) => `
      <button type="button" class="chip" data-value="${esc(c)}">${esc(CATEGORY_RU[c] || c)} — ${countBy(findings, 'category', c)}</button>`).join('')}
    </div>
    ${authors.length > 1 ? `
    <div class="filter-chips" data-filter="author">
      <button type="button" class="chip is-active" data-value="all">Все разработчики</button>
      ${authors.map((a) => `
      <button type="button" class="chip" data-value="${esc(authorKey(a.author))}">${esc(authorLabel(a.author))} — ${a.items.length}</button>`).join('')}
    </div>` : ''}
    <div class="filter-stat muted" id="findingStat"></div>
  </div>`;
}

/**
 * Ключ разработчика для фильтра.
 *
 * У безымянной группы ключ свой: пустая строка означала бы «все», и по
 * замечаниям без автора нельзя было бы отобрать (замечание пользователя,
 * 20.08.2026 — «Автор не установлен» не кликался).
 */
function authorKey(author) {
  return author || '__none__';
}

function authorLabel(author) {
  return author || 'Автор не установлен';
}

/** Сводка по типам: что чаще всего и чего это стоит. */
function renderRuleSummary(result, byRule) {
  return collapsible('Сводка по типам замечаний', `
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th>Тип замечания</th><th>Направление</th><th>Критичность</th>
      <th class="num">Случаев</th>
    </tr></thead>
    <tbody>
      ${byRule.map((r) => `
      <tr>
        <td><a href="#rule-${esc(slug(r.ruleId))}">${esc(stripTrailingCount(r.title))}</a></td>
        <td>${esc(CATEGORY_RU[r.category] || r.category)}</td>
        <td>${badge(r.severity)}</td>
        <td class="num">${formatNumber(r.items.length)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>`, {
    count: plural(byRule.length, 'тип', 'типа', 'типов'),
    extraClass: 'collapsible--table',
  });
}

/**
 * Замечания по разработчикам, а вместе с ними — поиск и фильтры.
 *
 * **Сортировка — по имени**, требование пользователя: сводку читают, чтобы
 * найти в ней конкретного человека, а не чтобы узнать, у кого замечаний
 * больше — это и так видно по колонке. Безымянная группа стоит последней:
 * это не человек.
 *
 * Имя кликабельно и подставляется в поиск — так открывается перечень именно
 * его замечаний, без второй копии этого перечня в документе. Поле поиска
 * и чипы уровней и направлений стоят здесь же (требование пользователя):
 * это один и тот же отбор, и разносить его по разным блокам незачем.
 */
function renderAuthorSummary(byAuthor, findings) {
  if (!byAuthor.length) return '';

  return collapsible('Замечания по разработчикам', `
  ${renderFilters(findings)}
  <p class="muted wide-note" style="font-size:13.5px">
    Автор определяется по комментарию-маркеру, которым обрамлена правка,
    по единственной подписи в модуле или по префиксу собственного объекта
    интегратора. Пометки вендора и платформы («НЕ УТ», «Локализация»,
    конструкторы запросов) авторскими не считаются.
    Щелчок по имени отбирает в перечне ниже только его замечания.
  </p>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th>Разработчик</th>
      <th class="num">Замечаний</th>
      <th class="num">Критичных</th>
      <th class="num">Высоких</th>
      <th class="num">Модулей</th>
      <th>Чаще всего</th>
    </tr></thead>
    <tbody>
      ${byAuthor.map((a) => `
      <tr class="author-row" data-author-row="${esc(authorKey(a.author))}">
        <td><button type="button" class="author-pick" data-author="${esc(authorKey(a.author))}">${a.author
    ? authorBadge(a.author)
    : '<span class="badge badge--info">Автор не установлен</span>'}</button></td>
        <td class="num" data-cell="total"><b>${formatNumber(a.items.length)}</b></td>
        <td class="num" data-cell="critical">${countBy(a.items, 'severity', 'critical') || ''}</td>
        <td class="num" data-cell="high">${countBy(a.items, 'severity', 'high') || ''}</td>
        <td class="num" data-cell="modules">${formatNumber(a.moduleCount)}</td>
        <td class="muted" style="font-size:13px" data-cell="top">${esc(topIssues(a.items))}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>`, {
    count: plural(byAuthor.length, 'разработчик', 'разработчика', 'разработчиков'),
    extraClass: 'collapsible--table',
  });
}

/** Уровень критичности со всеми типами замечаний внутри. */
function renderSeverityLevel(level) {
  const rules = groupByRule(level.items);
  return collapsible(
    // Заголовком служит сам значок критичности: подпись рядом с ним просто
    // повторяла бы это же слово вторым цветом.
    badge(level.severity),
    rules.map(renderRuleGroup).join(''),
    {
      count: `${plural(level.items.length, 'замечание', 'замечания', 'замечаний')} · ${plural(rules.length, 'тип', 'типа', 'типов')}`,
      extraClass: 'collapsible--group',
    },
  );
}

/** Группа замечаний одного типа: как исправлять и где встречается. */
function renderRuleGroup(rule) {
  const shown = rule.items.slice(0, MAX_CASES_PER_RULE);
  const hidden = rule.items.length - shown.length;
  const recommendation = rule.items.find((f) => f.recommendation)?.recommendation;

  return collapsible(
    `<span class="group-title">${esc(stripTrailingCount(rule.title))}</span>`,
    `${recommendation ? `
    <div class="finding__rec" style="margin:0 0 14px">
      <b>Как исправлять.</b> ${esc(recommendation)}
    </div>` : ''}

    <div class="table-wrap">
    <table class="findings-table">
      <thead><tr>
        <th class="num">№</th><th>Где</th><th>Чей код</th>
        <th class="num">Строка</th><th>Что не так и как выглядит в коде</th>
      </tr></thead>
      <tbody>
        ${shown.map((f, i) => renderCase(f, i)).join('')}
      </tbody>
    </table>
    </div>

    ${hidden > 0 ? `
    <p class="muted" style="font-size:13px">
      Показаны ${formatNumber(shown.length)} случаев из ${formatNumber(rule.items.length)}.
      Проблема однотипна: способ исправления один и тот же для всех случаев.
      Полный машиночитаемый перечень — в JSON-выгрузке результата аудита.
    </p>` : ''}`,
    {
      id: `rule-${slug(rule.ruleId)}`,
      count: formatNumber(rule.items.length),
      // Пункт регламента проекта — рядом с направлением: читателю важно
      // видеть, что требование пришло из документа проекта, а не от нас.
      badges: `<span class="badge badge--info">${esc(CATEGORY_RU[rule.category] || rule.category)}</span>`
        + policyBadge(rule.items[0]),
      extraClass: 'collapsible--group',
    },
  );
}

/** Ссылка на пункт регламента проекта — у замечаний, пришедших из него. */
function policyBadge(finding) {
  if (!finding?.policyRef) return '';
  return `<span class="badge">Регламент: ${esc(finding.policyRef)}</span>`;
}

/**
 * Один случай строкой таблицы.
 *
 * Атрибуты `data-*` нужны фильтру: скрываются сами строки, а затем группы,
 * в которых не осталось ни одной видимой. Иначе после отбора остаётся частокол
 * пустых заголовков и непонятно, нашлось ли хоть что-нибудь.
 */
function renderCase(f, index) {
  return `
        <tr class="finding-row"
            data-severity="${esc(f.severity)}"
            data-category="${esc(f.category)}"
            data-author="${esc(authorKey(f.author))}"
            data-module="${esc(f.moduleFile || f.moduleTitle || '')}"
            data-rule="${esc(stripTrailingCount(f.groupTitle || f.title))}"
            data-search="${esc(searchKey(f))}">
          <td class="num muted">${index + 1}</td>
          <td>${whereCell(f)}</td>
          <td class="nowrap">${ownerCell(f)}</td>
          <td class="num">${f.line || '—'}</td>
          <td class="muted">
            ${esc(shorten(f.detail, 300))}
            ${f.snippet ? codeBlock(f.snippet) : ''}
          </td>
        </tr>`;
}

/**
 * Колонка «Чей код».
 *
 * Когда автор пришёл из хранилища конфигурации, показываем **фамилию из
 * помещения** и говорим, откуда она. Значок происхождения там не нужен и
 * вводил в заблуждение: в режиме хранилища весь разбираемый код помечается
 * «добавлено интегратором» — сведений в этом нет никаких, а вместо имени
 * помещавшего пользователь видел казённую подпись (прямое замечание
 * пользователя, 12.08.2026).
 *
 * В обследовании всё как было: там автор — догадка по пометкам в коде,
 * и происхождение модуля важнее фамилии.
 */
function ownerCell(f) {
  const fromRepository = f.authorSource === 'хранилище конфигурации';
  if (fromRepository && f.author) {
    return `${authorBadge(f.author)}<div class="muted" style="font-size:12px">помещение в хранилище</div>`;
  }
  return `${authorBadge(f.author)}${f.author ? '<br>' : ''}${originBadge(f.origin)}`;
}

/**
 * Поиск и фильтры — единственный скрипт в отчёте.
 *
 * Отчёт остаётся самодостаточным файлом: скрипт встроен, сети не требует.
 * Ввод задержан на 180 мс — без этого браузер подвисает на каждой букве,
 * когда строк десятки тысяч.
 */
export const FINDINGS_SCRIPT = `
(function () {
  var search = document.getElementById('findingSearch');
  if (!search) return;
  var stat = document.getElementById('findingStat');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.finding-row'));
  var picked = { severity: 'all', category: 'all', author: 'all' };
  var timer = null;

  function matches(row) {
    var term = (search.value || '').trim().toLowerCase();
    return (!term || row.dataset.search.indexOf(term) !== -1)
      && (picked.severity === 'all' || row.dataset.severity === picked.severity)
      && (picked.category === 'all' || row.dataset.category === picked.category)
      && (picked.author === 'all' || row.dataset.author === picked.author);
  }

  function apply() {
    var visible = [];
    rows.forEach(function (row) {
      var hit = matches(row);
      row.hidden = !hit;
      if (hit) visible.push(row);
    });

    // Группа без единой видимой строки прячется целиком, иначе после отбора
    // остаются одни заголовки.
    document.querySelectorAll('details.collapsible').forEach(function (group) {
      if (!group.querySelector('.finding-row')) return;
      group.hidden = !group.querySelector('.finding-row:not([hidden])');
    });

    updateAuthorSummary(visible);

    if (!search.value.trim() && picked.severity === 'all'
      && picked.category === 'all' && picked.author === 'all') {
      stat.textContent = '';
      return;
    }
    stat.textContent = visible.length
      ? 'Отобрано случаев: ' + visible.length.toLocaleString('ru-RU')
      : 'Ничего не найдено — измените условия отбора';
  }

  /**
   * Сводка по разработчикам считается по видимым строкам.
   *
   * Требование пользователя: когда включён фильтр, таблица под фильтрами
   * обязана показывать отобранное, а не исходные итоги — иначе цифры в ней
   * противоречат перечню под ней.
   */
  function updateAuthorSummary(visible) {
    var summary = document.querySelectorAll('[data-author-row]');
    if (!summary.length) return;

    var byAuthor = {};
    visible.forEach(function (row) {
      var key = row.dataset.author;
      var entry = byAuthor[key] || (byAuthor[key] = { total: 0, critical: 0, high: 0, modules: {}, rules: {} });
      entry.total++;
      if (row.dataset.severity === 'critical') entry.critical++;
      if (row.dataset.severity === 'high') entry.high++;
      if (row.dataset.module) entry.modules[row.dataset.module] = 1;
      var rule = row.dataset.rule || '';
      if (rule) entry.rules[rule] = (entry.rules[rule] || 0) + 1;
    });

    summary.forEach(function (tr) {
      var entry = byAuthor[tr.dataset.authorRow];
      tr.hidden = !entry;
      if (!entry) return;
      set(tr, 'total', '<b>' + entry.total.toLocaleString('ru-RU') + '</b>');
      set(tr, 'critical', entry.critical || '');
      set(tr, 'high', entry.high || '');
      set(tr, 'modules', Object.keys(entry.modules).length.toLocaleString('ru-RU'));
      set(tr, 'top', topRules(entry.rules));
    });
  }

  function set(tr, name, html) {
    var cell = tr.querySelector('[data-cell="' + name + '"]');
    if (cell) cell.innerHTML = html;
  }

  function topRules(rules) {
    var names = Object.keys(rules).sort(function (a, b) { return rules[b] - rules[a]; }).slice(0, 3);
    return names.map(function (name) {
      var box = document.createElement('span');
      box.textContent = name + ' — ' + rules[name];
      return box.innerHTML;
    }).join('; ');
  }

  /** Чип выбирается программно: и щелчком по нему, и щелчком по имени в сводке. */
  function pick(kind, value) {
    var box = document.querySelector('.filter-chips[data-filter="' + kind + '"]');
    picked[kind] = value;
    if (!box) return;
    box.querySelectorAll('.chip').forEach(function (chip) {
      chip.classList.toggle('is-active', chip.dataset.value === value);
    });
  }

  search.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(apply, 180);
  });

  document.querySelectorAll('.filter-chips').forEach(function (box) {
    var kind = box.dataset.filter;
    box.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) return;
      pick(kind, chip.dataset.value);
      apply();
    });
  });

  /**
   * Имя разработчика в сводке — это фильтр, а не текст для строки поиска.
   *
   * Перечень ниже бывает свёрнут, и раньше щелчок по имени не делал ничего
   * видимого. Теперь блок раскрывается до первой отобранной строки: уровень
   * критичности, тип замечания и всё, что над ними.
   */
  document.addEventListener('click', function (event) {
    var pickButton = event.target.closest ? event.target.closest('.author-pick') : null;
    if (!pickButton) return;
    var value = pickButton.dataset.author;
    pick('author', picked.author === value ? 'all' : value);
    apply();

    var first = document.querySelector('.finding-row:not([hidden])');
    if (!first) return;
    var node = first.parentNode;
    while (node && node !== document.body) {
      if (node.tagName === 'DETAILS') node.open = true;
      node = node.parentNode;
    }
    var group = first.closest('details');
    if (group) group.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Раскрытие блока по ссылке-якорю и подготовка к печати живут в общем
  // скрипте отчёта (layoutScript.js): они нужны всему документу, а этот
  // скрипт выходит сразу, когда замечаний нет и поля поиска в отчёте нет.
})();
`;

/** Стили фильтров и таблицы случаев. */
export const FINDINGS_STYLES = `
.filters { margin: 0 0 22px; display: flex; flex-direction: column; gap: 10px; }
.filters input[type=search] {
  width: 100%; padding: 11px 14px; font: inherit; font-size: 14.5px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink);
}
.filters input[type=search]:focus { outline: none; border-color: var(--accent); }
.filter-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.filter-stat { font-size: 13px; min-height: 18px; }
.chip {
  appearance: none; border: 1px solid var(--line); background: var(--bg);
  color: var(--ink-soft); font: inherit; font-size: 13px; padding: 5px 12px;
  border-radius: 20px; cursor: pointer;
}
.chip:hover { border-color: var(--ink-faint); }
.chip.is-active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }

.author-pick { appearance: none; border: 0; background: none; padding: 0; cursor: pointer; font: inherit; }
.author-row[hidden] { display: none; }
/* Где лежит код — приглушённой строкой над объектом: это рамка, а не сам адрес. */
.where__place { font-size: 12px; color: var(--ink-faint); margin-bottom: 2px; }

/*
 * Ширины колонок заданы явно. Иначе браузер отдаёт «Где» столько места,
 * сколько занимает самый длинный путь к модулю, и колонка с кодом — самая
 * содержательная — сжимается до нечитаемой полосы.
 */
.findings-table { table-layout: fixed; width: 100%; }
.findings-table th:nth-child(1), .findings-table td:nth-child(1) { width: 44px; }
.findings-table th:nth-child(2), .findings-table td:nth-child(2) { width: 22%; overflow-wrap: anywhere; word-break: break-word; }
.findings-table th:nth-child(3), .findings-table td:nth-child(3) { width: 120px; }
.findings-table th:nth-child(4), .findings-table td:nth-child(4) { width: 62px; }
.findings-table td { font-size: 13.5px; vertical-align: top; }
/*
 * Код в замечании оформлен ровно так же, как в дереве отличий от поставщика
 * (функция codeBlock): подсветка, снятый отступ, прокрутка вместо переноса.
 * Здесь остаётся только размер шрифта — в таблице он мельче.
 */
.findings-table .snippet { margin-top: 6px; margin-bottom: 0; font-size: 11.5px; max-height: 260px; }
.finding-row[hidden] { display: none; }
details.collapsible[hidden] { display: none; }

@media print {
  .no-print { display: none; }
  /* Замечания печатаем в альбомной ориентации: код на книжном листе
     выходит колонкой в несколько слов. */
  @page { size: A4 landscape; margin: 12mm; }
  .findings-table td { font-size: 11px; }
  .findings-table .snippet { font-size: 10px; }
}
`;

// --- Группировка ------------------------------------------------------------

function groupByRule(findings) {
  const map = new Map();
  for (const f of findings) {
    if (!map.has(f.ruleId)) {
      map.set(f.ruleId, {
        ruleId: f.ruleId,
        // Заголовок группы: общий, если правило его дало. Иначе заголовком
        // служит первый случай — а он называет конкретный объект, и подпись
        // ко всей группе получается неверной (замечание пользователя,
        // 20.08.2026): «Имя «Документ1» без префикса» над списком, где лежат
        // справочники и общие модули.
        title: f.groupTitle || f.title,
        severity: f.severity,
        category: f.category,
        items: [],
      });
    }
    map.get(f.ruleId).items.push(f);
  }

  const order = new Map(SEVERITY_ORDER.map((s, i) => [s, i]));
  return [...map.values()].sort((a, b) => {
    const diff = (order.get(a.severity) ?? 9) - (order.get(b.severity) ?? 9);
    return diff || b.items.length - a.items.length;
  });
}

function groupBySeverity(findings) {
  const map = new Map();
  for (const f of findings) {
    if (!map.has(f.severity)) map.set(f.severity, { severity: f.severity, items: [] });
    map.get(f.severity).items.push(f);
  }
  return SEVERITY_ORDER.filter((s) => map.has(s)).map((s) => map.get(s));
}

/**
 * Разработчики **по имени**; безымянная группа — последней.
 *
 * Замечание без автора — не сбой: у типового кода автора нет и быть не должно,
 * а в расширении без пометок его определить нечем. Прятать такие замечания
 * нельзя — иначе сумма по разработчикам не сойдётся с итогом.
 */
function groupByAuthor(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = f.author || '';
    if (!map.has(key)) map.set(key, { author: key, items: [], modules: new Set() });
    const entry = map.get(key);
    entry.items.push(f);
    if (f.moduleFile) entry.modules.add(f.moduleFile);
  }

  return [...map.values()]
    .map((a) => ({ ...a, moduleCount: a.modules.size }))
    .sort((a, b) => {
      if (!a.author !== !b.author) return a.author ? -1 : 1;
      return a.author.localeCompare(b.author, 'ru');
    });
}

// --- Вспомогательное --------------------------------------------------------

function countBy(items, field, value) {
  return items.filter((f) => f[field] === value).length;
}

function topIssues(items) {
  return groupByRule(items).slice(0, 3)
    .map((r) => `${stripTrailingCount(r.title)} — ${r.items.length}`)
    .join('; ');
}

function searchKey(f) {
  // Фамилии в ключе поиска НЕТ: разработчик выбирается своим фильтром, а щелчок
  // по имени больше не подставляет текст в строку поиска (требование
  // пользователя, 20.08.2026). Строка поиска ищет по коду и тексту замечания.
  return [f.moduleTitle, f.moduleFile, f.ownerName, f.routine, f.detail]
    .filter(Boolean).join(' ').toLowerCase().slice(0, 400);
}

/**
 * Колонка «Где»: вид и имя объекта → вид модуля (с именем формы/команды,
 * если это модуль формы или команды) → процедура или функция.
 *
 * Формат построчный, а не через запятую: три разных по смыслу уровня —
 * объект метаданных, конкретный модуль этого объекта, место в его коде, —
 * и слитная строка их не различает.
 *
 * Вторая строка опускается, если она повторила бы первую: для общего модуля
 * «вид.имя» и «вид модуля» — буквально одно и то же (сам модуль и есть объект).
 */
function whereCell(f) {
  const kindRu = f.ownerKind ? ruName(f.ownerKind) : null;
  const objectLine = kindRu && f.ownerName ? `${kindRu}.${f.ownerName}` : (f.moduleTypeRu || f.moduleTitle || '');
  const moduleLine = f.formName ? `${f.moduleTypeRu} «${f.formName}»` : f.moduleTypeRu;

  const parts = [objectLine, moduleLine && moduleLine !== objectLine ? moduleLine : null, f.routine]
    .filter(Boolean)
    .map((s) => esc(s));
  const place = `<div class="where__place">${esc(scopeName(f))}</div>`;
  return place + (parts.join('<br>') || esc(f.moduleTitle || ''));
}

/**
 * Где лежит код — первой строкой колонки «Где».
 *
 * Требование пользователя (20.08.2026): одноимённые объекты конфигурации
 * и расширения в перечне были неразличимы, а исправлять их надо в разных
 * местах. Помещение в хранилище к конфигурации не относится — там место
 * называет само хранилище.
 */
function scopeName(f) {
  if (f.extensionName) return `Расширение «${f.extensionName}»`;
  if (f.moduleType === 'commit') return f.moduleTitle || 'Хранилище конфигурации';
  return 'Конфигурация';
}

