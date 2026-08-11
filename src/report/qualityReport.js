/**
 * Отчёт проверки качества кода — один раздел.
 *
 * Это тот же перечень замечаний, что в обследовании (`findings.js`): та же
 * группировка по критичности и по разработчикам, тот же поиск, те же фрагменты
 * кода. Отдельный документ нужен затем, что вопрос здесь один — качество кода, —
 * и остальные девять разделов обследования в нём только мешали бы.
 *
 * Второе отличие — источник. Когда код взят из **хранилища конфигурации**,
 * авторство приходит от платформы, а не из пометок в коде, и рядом с перечнем
 * появляется история помещений за период: кто, когда и с каким комментарием.
 */

import { REPORT_STYLES } from './styles.js';
import { LAYOUT_SCRIPT } from './layoutScript.js';
import { renderFindingsBlock, FINDINGS_SCRIPT, FINDINGS_STYLES } from './findings.js';
import { esc, plural, signature, formatDate, formatDateTime } from './ui.js';
import { formatNumber } from '../analyze/dataVolume.js';
import { APP } from '../config.js';

/**
 * @param {object} result результат конвейера (`pipeline/runQuality.js`)
 * @returns {string} самодостаточный HTML-документ
 */
export function renderQualityReport(result) {
  const cfg = result.configuration || {};
  const title = `Качество кода 1С — ${cfg.synonym || cfg.name || 'конфигурация'}`;
  const fromRepo = result.source === 'repository';

  const sectionDefs = [
    { id: 'q-findings', title: 'Качество кода: замечания', html: renderFindings(result) },
    fromRepo
      ? { id: 'q-commits', title: 'Помещения в хранилище за период', html: renderCommits(result) }
      : null,
  ].filter(Boolean).filter((s) => s.html);

  return `<!doctype html>
<html lang="ru" data-theme="${result.input?.reportTheme === 'light' ? 'light' : 'dark'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${REPORT_STYLES}${FINDINGS_STYLES}</style>
</head>
<body>
<div class="layout">
<nav class="nav no-print" id="reportNav" aria-label="Содержание отчёта">
  <div class="nav__brand">Содержание</div>
  <ol class="nav__list">
    ${sectionDefs.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join('')}
  </ol>
</nav>
<div class="page">
${renderCover(result)}
${sectionDefs.map((s, i) => `
<section class="section" id="${s.id}">
  <details class="sec" open>
    <summary><span class="section__num">Раздел ${i + 1}</span><h2>${esc(s.title)}</h2></summary>
    <div class="sec__body">${s.html}</div>
  </details>
</section>`).join('')}
<footer class="report-footer">
  Отчёт сформирован автоматически системой «${esc(APP.name)}» v${esc(APP.version)}
  ${esc(formatDateTime(result.generatedAt))}.
  Проверка выполнена статическим анализом кода; решение по каждому замечанию
  остаётся за специалистом.
  <div style="margin-top:10px">${signature()}</div>
</footer>
</div>
</div>
<script>${LAYOUT_SCRIPT}${FINDINGS_SCRIPT}</script>
</body>
</html>`;
}

function renderCover(result) {
  const cfg = result.configuration || {};
  const fromRepo = result.source === 'repository';
  const totals = result.totals || {};
  const bySeverity = result.bySeverity || {};

  return `
<header class="cover">
  <p class="cover__eyebrow">Проверка качества кода</p>
  <h1 class="cover__title">${esc(cfg.synonym || cfg.name || 'Конфигурация 1С')}</h1>
  <p class="cover__subtitle">${esc(fromRepo
    ? 'Источник — хранилище конфигурации: разобраны помещения за период'
    : 'Источник — информационная база: проверены доработки конфигурации')}</p>
  <dl class="cover__meta">
    ${fromRepo ? `
    <div><dt>Хранилищ</dt><dd>${formatNumber((result.repositories || []).length)}</dd></div>
    <div><dt>Период</dt><dd>${esc(periodLabel(result.period))}</dd></div>
    <div><dt>Помещений</dt><dd>${formatNumber((result.commits || []).length)}</dd></div>
    ` : `
    <div><dt>Информационная база</dt><dd>${esc(result.infobase?.display || '—')}</dd></div>
    <div><dt>Версия конфигурации</dt><dd>${esc(cfg.version || 'не указана')}</dd></div>
    `}
    <div><dt>Платформа</dt><dd>${esc(result.platformVersion || '—')}</dd></div>
    <div><dt>Модулей проверено</dt><dd>${formatNumber(totals.analyzedModules ?? totals.modules ?? 0)}</dd></div>
    <div><dt>Замечаний</dt><dd>${formatNumber(totals.findings || 0)}</dd></div>
    <div><dt>Из них критичных</dt><dd>${formatNumber(bySeverity.critical || 0)}</dd></div>
    <div><dt>Дата проверки</dt><dd>${esc(formatDate(result.generatedAt))}</dd></div>
  </dl>
  <p class="cover__scope">
    ${esc(fromRepo
    ? 'Проверялись только объекты, помещённые в хранилище за указанный период: именно они '
      + 'и есть работа разработчиков. Типовой код вендора не анализируется.'
    : 'Проверялись только доработки: типовой код вендора не анализируется — замечания к нему '
      + 'исправлять никто не будет, а отчёт они засоряют.')}
  </p>
</header>`;
}

function renderFindings(result) {
  const warnings = (result.warnings || []).map((text) => `
  <div class="callout callout--warn">${esc(text)}</div>`).join('');

  return `
  ${warnings}
  <p class="section__lead">
    ${result.source === 'repository'
    ? 'Авторство здесь взято из хранилища конфигурации: платформа записывает, кто поместил '
      + 'каждый объект, — угадывать по пометкам в коде не нужно. Группировка по разработчикам '
      + 'ниже построена на этих записях.'
    : 'Авторство определяется по пометкам в коде и по префиксам объектов: в информационной базе '
      + 'других сведений о том, кто внёс правку, нет.'}
  </p>
  ${renderFindingsBlock(result)}`;
}

/**
 * История помещений за период.
 *
 * Нужна не как украшение: увидев замечание, читатель спрашивает «кто и когда
 * это поместил», и таблица отвечает на это без похода в конфигуратор.
 */
function renderCommits(result) {
  const commits = result.commits || [];
  if (!commits.length) {
    return `
    <div class="callout callout--warn">
      За указанный период помещений в хранилище нет — проверять нечего.
      Расширьте период или проверьте, то ли хранилище указано.
    </div>`;
  }

  const byUser = new Map();
  for (const commit of commits) {
    const key = commit.user || 'не указан';
    if (!byUser.has(key)) byUser.set(key, { commits: 0, objects: new Set() });
    const entry = byUser.get(key);
    entry.commits += 1;
    for (const object of commit.objects || []) entry.objects.add(object);
  }

  const rows = [...byUser.entries()]
    .sort((a, b) => b[1].commits - a[1].commits)
    .map(([user, entry]) => `
      <tr>
        <td>${esc(user)}</td>
        <td class="num">${formatNumber(entry.commits)}</td>
        <td class="num">${formatNumber(entry.objects.size)}</td>
      </tr>`).join('');

  const list = commits
    .slice()
    .sort((a, b) => Number(b.version) - Number(a.version))
    .slice(0, 200)
    .map((commit) => `
      <tr>
        <td class="num">${esc(String(commit.version))}</td>
        <td>${esc(commit.repository || '')}</td>
        <td>${esc(commit.user || '—')}</td>
        <td>${esc(commit.date || '')}</td>
        <td>${esc(commit.comment || '')}</td>
        <td class="num">${formatNumber((commit.objects || []).length)}</td>
      </tr>`).join('');

  return `
  <p class="section__lead">
    За период ${esc(periodLabel(result.period))} в ${plural((result.repositories || []).length, 'хранилище', 'хранилища', 'хранилищ')}
    ${plural(commits.length, 'помещение', 'помещения', 'помещений')}.
  </p>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Разработчик</th><th class="num">Помещений</th><th class="num">Объектов</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <h3 class="plain">Помещения</h3>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th class="num">Версия</th><th>Хранилище</th><th>Разработчик</th>
        <th>Дата</th><th>Комментарий</th><th class="num">Объектов</th>
      </tr></thead>
      <tbody>${list}</tbody>
    </table>
  </div>
  ${commits.length > 200 ? `<p class="muted">Показаны последние 200 из ${formatNumber(commits.length)}.</p>` : ''}`;
}

function periodLabel(period) {
  const from = period?.from;
  const to = period?.to;
  if (from && to) return `${ru(from)} — ${ru(to)}`;
  if (from) return `с ${ru(from)}`;
  if (to) return `по ${ru(to)}`;
  return 'без ограничения';
}

/** «2026-08-01» → «01.08.2026»: в отчёте даты русские. */
function ru(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}
