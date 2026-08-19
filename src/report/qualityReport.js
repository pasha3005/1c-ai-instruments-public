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
import {
  esc, plural, signature, collapsible, formatDate, formatDateTime, authorBadge,
} from './ui.js';
import { codeBlock, highlightBsl } from './bslHighlight.js';
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

  // Помещения идут первыми: в режиме хранилища это ответ на вопрос «что вообще
  // делали за период», и замечания читаются уже поверх него. Прямое требование
  // пользователя (12.08.2026).
  const sectionDefs = [
    fromRepo
      ? { id: 'q-commits', title: 'Помещения в хранилище за период', html: renderCommits(result) }
      : null,
    { id: 'q-findings', title: 'Качество кода: замечания', html: renderFindings(result) },
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
  <p class="cover__scope">${esc(scopeSentence(result, fromRepo))}</p>
  ${renderPolicyNote(result)}
</header>`;
}

/**
 * По какому регламенту проверяли — на титуле, рядом с областью проверки.
 *
 * Читатель отчёта обязан видеть три вещи: чей это регламент, дополняет он
 * встроенные правила или заменяет их, и какие его пункты программа проверить
 * не смогла. Последнее — прямое требование продукта: отчёт не утверждает того,
 * чего не делал.
 */
export function renderPolicyNote(result) {
  const policy = result?.policy;
  if (!policy) return '';

  const name = policy.name || 'Регламент разработки проекта';
  const version = policy.version ? ` (версия ${policy.version})` : '';
  const mode = policy.mode === 'replace'
    ? 'Проверялись только правила регламента: встроенные проверки программы отключены режимом «заменяет».'
    : 'Регламент дополняет встроенные проверки программы.';
  const disabled = policy.disabled
    ? ` Выключено регламентом правил: ${formatNumber(policy.disabled)}.`
    : '';
  const unknown = policy.unknown?.length
    ? `<p class="cover__scope"><b>Не проверено:</b> регламент требует проверок, которых в программе нет —
       ${esc(policy.unknown.join(', '))}. Эти пункты остаются за специалистом.</p>`
    : '';

  return `
  <p class="cover__scope">Проверка выполнена по регламенту «${esc(name)}»${esc(version)}:
    правил применено ${formatNumber(policy.rules || 0)}. ${esc(mode)}${esc(disabled)}</p>
  ${unknown}`;
}

/**
 * Что именно проверялось — одной фразой на титуле.
 *
 * Фраза считается по факту, а не по намерению: когда конфигурация поставщика
 * недоступна (её нет в базе и пользователь не указал файл), сравнивать не с чем
 * и проверяется вся конфигурация целиком. Писать в этом случае «проверялись
 * только доработки» нельзя — отчёт не должен утверждать того, чего не делал.
 */
function scopeSentence(result, fromRepo) {
  if (fromRepo) {
    return 'Проверялись только объекты, помещённые в хранилище за указанный период: именно они '
      + 'и есть работа разработчиков. Типовой код вендора не анализируется. '
      + codeSourceSentence(result);
  }
  if (result.codeStats?.scope?.filtered === false) {
    return 'Конфигурация поставщика недоступна — ни в самой базе, ни файлом, — поэтому отделить '
      + 'доработки от типового кода нечем и проверена вся конфигурация целиком. Часть замечаний '
      + 'относится к коду вендора: исправлять их силами интегратора не нужно.';
  }
  return 'Проверялись только доработки: типовой код вендора не анализируется — замечания к нему '
    + 'исправлять никто не будет, а отчёт они засоряют.';
}

/**
 * Откуда взят проверенный код — предложением на титуле.
 *
 * Различие не косметическое. Код из хранилища — это ровно то, что помещали;
 * код из служебной базы — то, что в ней есть на момент проверки, и если
 * разработчик не обновлён из хранилища, свежих чужих помещений там нет.
 * Умолчать об этом значило бы выдать второе за первое.
 */
export function codeSourceSentence(result) {
  if (result?.codeSource === 'repository-files') {
    return 'Код прочитан прямо из файлов хранилища, без запуска платформы: проверено ровно то, '
      + 'что в него помещено, и ровно на тех версиях, которыми помещали.';
  }
  if (result?.codeSource === 'service-base') {
    return 'Код взят из указанной служебной базы: развернуть выгрузку хранилища на этой машине '
      + 'было нечем (в клиентской установке платформы нет ibcmd, а писать в служебную базу '
      + 'программа не вправе). Показано то, что есть в базе, — она должна быть обновлена '
      + 'из хранилища.';
  }
  return 'Код взят из самих хранилищ: проверено ровно то, что в них помещено.';
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
 * История помещений за период — отдельно по каждому хранилищу.
 *
 * Нужна не как украшение: увидев замечание, читатель спрашивает «кто и когда
 * это поместил», и таблица отвечает на это без похода в конфигуратор.
 *
 * Хранилищ в проверке столько, сколько нашлось: основной конфигурации
 * и по одному на расширение. Сваливать их помещения в общий список нельзя —
 * номера версий у каждого хранилища свои, и «версия 14» в одной строке
 * с «версией 14» другого хранилища читается как одно и то же помещение.
 * Поэтому таблица строится при каждом хранилище персонально, включая те,
 * которые прочитать не удалось: молчание о хранилище выглядело бы как
 * «помещений не было».
 */
function renderCommits(result) {
  const commits = result.commits || [];
  const repositories = repositoryList(result);

  const blocks = repositories.map((repo) => {
    // Хранилище одно — помещения без имени хранилища принадлежат ему: имя
    // проставляет конвейер, и у результатов, сохранённых прежними версиями,
    // его может не быть вовсе.
    const own = commits.filter((c) => (c.repository
      ? c.repository === repo.name
      : repositories.length === 1));
    const title = `Хранилище «${esc(repo.name)}»`
      + `<span class="muted"> — ${esc(repositoryRole(repo))}</span>`;
    return collapsible(title, renderRepositoryCommits(repo, own), {
      count: repo.ok === false
        ? 'не прочитано'
        : plural(own.length, 'помещение', 'помещения', 'помещений'),
      open: repositories.length === 1 || own.length > 0,
    });
  }).join('');

  return `
  <p class="section__lead">
    За период ${esc(periodLabel(result.period))} в ${plural(repositories.length, 'хранилище', 'хранилища', 'хранилищ')}
    ${plural(commits.length, 'помещение', 'помещения', 'помещений')}.
    Автор каждого замечания взят отсюда: платформа записывает, кто поместил объект.
  </p>
  ${renderPlacementNotes(result)}
  ${renderAuthorSummary(commits)}
  ${commits.length ? COMMIT_LEGEND : ''}
  ${blocks || `
  <div class="callout callout--warn">
    Ни одного хранилища прочитать не удалось — проверять нечего.
  </div>`}`;
}

/**
 * Чего в разделе помещений нет и почему.
 *
 * Два случая, и оба надо назвать прямо, иначе пустое место в отчёте читается
 * как «правок не было»: фрагменты кода не строились (дорого либо так выбрано
 * в форме) и объекты, которых не нашлось в служебной базе.
 */
function renderPlacementNotes(result) {
  const notes = [];
  if (result.placementDiffs?.skipped) notes.push(result.placementDiffs.skipped);
  if ((result.missingObjects || []).length) {
    notes.push(`Код этих объектов не проверен — в служебной базе их нет: `
      + `${result.missingObjects.join(', ')}. Так бывает, когда объект поместили `
      + 'и потом удалили либо база не обновлена из хранилища.');
  }
  if (!notes.length) return '';
  return notes.map((text) => `
  <div class="callout callout--warn">${esc(text)}</div>`).join('');
}

/**
 * Чем оказалось хранилище — основной конфигурации или расширения.
 *
 * У сетевого адреса это по самой строке не видно вовсе, и раньше подпись
 * держалась на порядке чтения: первое прочитанное хранилище считалось основным.
 * Теперь при работе через служебную базу роль известна точно — из привязки
 * этой базы к хранилищам (`onec/infobaseBinding.js`), — и подписывается ею.
 * Имя расширения выводится, только когда оно следует однозначно: связи
 * «расширение в базе → его имя» в привязке нет, и угадывать её нельзя.
 */
export function repositoryRole(repo) {
  if (repo?.role === 'main') return 'основная конфигурация';
  if (repo?.role === 'extension') {
    return repo.boundExtension
      ? `хранилище расширения «${repo.boundExtension}»`
      : 'хранилище расширения';
  }
  return repo?.isMain ? 'основная конфигурация' : 'расширение';
}

/**
 * Легенда значков дерева помещений.
 *
 * Значки заменили подписи «добавлен / изменён / удалён» у каждого узла
 * (требование пользователя 12.08.2026), поэтому расшифровка обязана быть
 * на виду — иначе `±` придётся угадывать.
 */
const COMMIT_LEGEND = `
  <div class="tree-legend">
    <span><i class="tree-mark tree-mark--added">+</i>добавлено</span>
    <span><i class="tree-mark tree-mark--modified">±</i>изменено</span>
    <span><i class="tree-mark tree-mark--removed">−</i>удалено</span>
    <span><i class="rt-mark rt-mark--procedure">P()</i>процедура</span>
    <span><i class="rt-mark rt-mark--function">F(x)</i>функция</span>
  </div>`;

/**
 * Перечень хранилищ для отчёта.
 *
 * Берётся из результата прогона, но дополняется именами, которые встретились
 * в помещениях: у прогонов, сохранённых прежними версиями программы, состояния
 * хранилищ в результате ещё нет, и без этого дополнения отчёт по ним оказался
 * бы пустым.
 */
function repositoryList(result) {
  const known = new Map();
  for (const repo of result.repositories || []) {
    known.set(repo.name, { isMain: false, ...repo });
  }
  for (const commit of result.commits || []) {
    if (commit.repository && !known.has(commit.repository)) {
      known.set(commit.repository, { name: commit.repository, isMain: known.size === 0 });
    }
  }
  return [...known.values()];
}

/** Сводка «кто сколько поместил» — общая по всем хранилищам. */
function renderAuthorSummary(commits) {
  if (!commits.length) return '';
  const byUser = new Map();
  for (const commit of commits) {
    const key = commit.user || 'не указан';
    if (!byUser.has(key)) byUser.set(key, { commits: 0, objects: new Set() });
    const entry = byUser.get(key);
    entry.commits += 1;
    for (const object of commit.objects || []) entry.objects.add(`${commit.repository}.${object}`);
  }

  const rows = [...byUser.entries()]
    .sort((a, b) => b[1].commits - a[1].commits)
    // Фамилия — той же цветной плашкой, что и в разделе замечаний: один
    // и тот же разработчик должен узнаваться по цвету в обоих разделах.
    .map(([user, entry]) => `
      <tr>
        <td>${authorBadge(user)}</td>
        <td class="num">${formatNumber(entry.commits)}</td>
        <td class="num">${formatNumber(entry.objects.size)}</td>
      </tr>`).join('');

  return `
  <div class="table-wrap">
    <table>
      <thead><tr><th>Разработчик</th><th class="num">Помещений</th><th class="num">Объектов</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** Содержимое блока одного хранилища. */
function renderRepositoryCommits(repo, commits) {
  if (repo.ok === false) {
    return `
    <div class="callout callout--warn">
      <div class="callout__title">Хранилище не прочитано</div>
      ${esc(repo.reason || 'причина не определена')}
      ${repo.dir ? `<div class="muted" style="margin-top:6px">${esc(repo.dir)}</div>` : ''}
    </div>`;
  }
  if (!commits.length) {
    return `
    <p class="dt__note">
      За период помещений в это хранилище не было. Расширьте период,
      если ожидали увидеть здесь работу разработчиков.
    </p>`;
  }

  const rows = commits
    .slice()
    .sort((a, b) => Number(b.version) - Number(a.version))
    .slice(0, MAX_COMMITS_SHOWN)
    .map((commit) => renderCommit(commit))
    .join('');

  return `
  <div class="difftree">
    <div class="commits__head">
      <span>Версия</span><span>Разработчик</span><span>Дата</span>
      <span>Комментарий</span><span class="commits__cell--num">Объектов</span>
    </div>
    ${rows}
  </div>
  ${commits.length > MAX_COMMITS_SHOWN
    ? `<p class="muted">Показаны последние ${MAX_COMMITS_SHOWN} из ${formatNumber(commits.length)}.</p>`
    : ''}`;
}

/** Сколько помещений печатается в одном хранилище. */
const MAX_COMMITS_SHOWN = 200;

/**
 * Одно помещение: строка таблицы, которая раскрывается в перечень объектов.
 */
function renderCommit(commit) {
  const objects = [
    ...(commit.added || []).map((name) => ({ name, status: 'added' })),
    ...(commit.changed || []).map((name) => ({ name, status: 'modified' })),
    ...(commit.removed || []).map((name) => ({ name, status: 'removed' })),
  ];
  const diffs = commit.moduleDiffs || [];

  const body = objects.length
    ? objects.map((object) => renderCommitObject(
      object, diffs.filter((d) => d.object === object.name),
    )).join('')
    : '<p class="dt__note">Помещение не перечисляет объектов.</p>';

  const note = objects.length && !diffs.length
    ? `<p class="dt__note">
        Текстов правок по этому помещению нет: либо у помещённых объектов нет модулей,
        либо выгрузок версий хранилища понадобилось больше предела — тогда об этом
        сказано предупреждением в начале отчёта.
      </p>`
    : '';

  return `
  <details class="dt dt--commit">
    <summary>
      <span class="commits__row">
        <span class="commits__cell commits__cell--num">${esc(String(commit.version))}</span>
        <span class="commits__cell commits__cell--who">${commit.user ? authorBadge(commit.user) : '—'}</span>
        <span class="commits__cell">${esc(commit.date || '')}</span>
        <span class="commits__cell commits__cell--comment">${esc(commit.comment || '')}</span>
        <span class="commits__cell commits__cell--num">${formatNumber(objects.length)}</span>
      </span>
    </summary>
    <div class="dt__body">${note}${body}</div>
  </details>`;
}

const OBJECT_STATUS_RU = { added: 'добавлен', modified: 'изменён', removed: 'удалён' };
/**
 * Значки состояния — те же, что в дереве отличий от поставщика и в отчёте
 * обновления: `+` добавлено, `±` изменено, `−` удалено. Словами это раньше
 * писалось у объектов и не писалось у модулей; теперь значок стоит у каждого
 * узла дерева, а расшифровка — в легенде над таблицей.
 */
const STATUS_MARK = { added: '+', modified: '±', removed: '−' };

function statusMark(status) {
  return `<span class="tree-mark tree-mark--${status}" title="${esc(OBJECT_STATUS_RU[status] || '')}"
    >${STATUS_MARK[status] || '±'}</span>`;
}

/** Объект помещения; если есть правки модулей — раскрывается до них. */
function renderCommitObject(object, diffs) {
  const title = `
    ${statusMark(object.status)}
    <span class="dt__label">${esc(object.name)}</span>`;

  if (!diffs.length) return `<div class="dt dt--leaf">${title}</div>`;

  return `
  <details class="dt dt--object">
    <summary>${title}<span class="dt__stat">${plural(diffs.length, 'модуль', 'модуля', 'модулей')}</span></summary>
    <div class="dt__body">${diffs.map((d) => renderCommitModule(d)).join('')}</div>
  </details>`;
}

/**
 * Имя модуля внутри объекта — без повторения имени самого объекта.
 *
 * Объект уже назван строкой выше, и «Документ «Документ4»: модуль объекта»
 * повторял его в каждой строке дерева (замечание пользователя 12.08.2026).
 * У форм и команд имя нужно: их у объекта много.
 */
function moduleLabel(diff) {
  const kind = diff.moduleTypeRu || 'Модуль';
  if (diff.formName && (diff.moduleType === 'form' || diff.moduleType === 'command')) {
    return `${kind} «${diff.formName}»`;
  }
  return kind;
}

/** Модуль объекта: правки, внесённые именно этим помещением. */
function renderCommitModule(diff) {
  const stat = [
    diff.addedLines ? `+${formatNumber(diff.addedLines)}` : '',
    plural(diff.regionCount || 0, 'участок', 'участка', 'участков'),
  ].filter(Boolean).join(' · ');
  // Модуль помечается так же, как объект: добавлен целиком либо изменён.
  const title = `
    ${statusMark(diff.isNew ? 'added' : 'modified')}
    <span class="dt__label">${esc(moduleLabel(diff))}</span>`;

  const fragments = diff.fragments || [];
  if (!fragments.length) {
    return `<div class="dt dt--leaf">${title}<span class="dt__stat">${esc(stat)}</span></div>`;
  }

  const hidden = diff.hiddenBlocks
    ? `<p class="dt__note">Показаны первые ${formatNumber(fragments.length)} блоков правки,
        ещё ${formatNumber(diff.hiddenBlocks)} — в JSON-выгрузке результата проверки.</p>`
    : '';

  return `
  <details class="dt dt--module">
    <summary>${title}<span class="dt__stat">${esc(stat)}</span></summary>
    <div class="dt__body">${hidden}${renderRoutineGroups(diff)}</div>
  </details>`;
}

/**
 * Правки модуля, разложенные по процедурам и функциям.
 *
 * Читатель ищет не «строки 214–231», а «что сделали в ПередЗаписью»: имя
 * процедуры — это единица работы разработчика. Участки, не попавшие ни в одну
 * процедуру (код в теле модуля, объявления переменных), идут отдельной группой:
 * приписывать их соседней процедуре было бы неправдой.
 *
 * Блоков внутри процедуры может быть несколько — по одному на каждую внесённую
 * правку. Раньше их схлопывало в один `takeFragments`, и вторая правка
 * в процедуре в отчёт не попадала вовсе.
 */
function renderRoutineGroups(diff) {
  const groups = new Map();
  for (const fragment of diff.fragments || []) {
    const key = fragment.routine || '';
    if (!groups.has(key)) {
      groups.set(key, {
        name: fragment.routine || '',
        // Подпись целиком — имя, все параметры и «Экспорт»: по одному имени
        // процедуру в конфигураторе не найти, а экспортность определяет,
        // часть это программного интерфейса или внутренняя кухня.
        // Прямое требование пользователя (13.08.2026). У прогонов, сохранённых
        // прежними версиями, подписи нет — тогда остаётся имя.
        signature: fragment.routineSignature || fragment.routine || '',
        kind: fragment.routineKind || null,
        // Состояние процедуры — таким же значком, как у объекта и модуля
        // (требование пользователя 13.08.2026). У прогонов прежних версий
        // его нет — тогда значка не будет, выдумывать состояние нельзя.
        status: fragment.routineStatus || null,
        fragments: [],
      });
    }
    groups.get(key).fragments.push(fragment);
  }

  return [...groups.values()].map((group) => {
    const body = group.fragments.map((fragment) => renderCommitFragment(fragment)).join('');
    if (!group.name) {
      // Вне процедур — без лишнего уровня дерева: сворачивать нечего.
      return `
      <div class="dt__routine-plain">
        <div class="dt__routine-head">Вне процедур и функций — тело модуля</div>
        ${body}
      </div>`;
    }
    const lines = group.fragments.reduce((sum, f) => sum + (f.lines?.length || 0), 0);
    const stat = [
      group.fragments.length > 1
        ? plural(group.fragments.length, 'правка', 'правки', 'правок')
        : '',
      plural(lines, 'строка', 'строки', 'строк'),
    ].filter(Boolean).join(' · ');
    return `
    <details class="dt dt--routine" open>
      <summary>
        ${group.status ? statusMark(group.status) : ''}
        ${routineMark(group.kind)}
        ${routineSignatureHtml(group.signature || group.name)}
        <span class="dt__stat">${esc(stat)}</span>
      </summary>
      <div class="dt__body">${body}</div>
    </details>`;
  }).join('');
}

/**
 * Подпись процедуры — тем же шрифтом и той же подсветкой, что и код ниже
 * (прямое требование пользователя 13.08.2026).
 *
 * Это и есть код: строка объявления из модуля. Набранная шрифтом текста, она
 * читалась как заголовок раздела, а не как то, что можно найти поиском
 * в конфигураторе. Подсветка — та же `highlightBsl`, поэтому «Экспорт»
 * выделяется ключевым словом ровно так же, как в блоке кода под ним.
 */
function routineSignatureHtml(signature) {
  return `<code class="dt__label rt-sig">${highlightBsl(signature)}</code>`;
}

/**
 * Значок процедуры и функции — как в дереве метаданных конфигуратора,
 * где у процедуры «P()», а у функции «F(x)». Рисуется теми же средствами,
 * что и остальные значки отчёта: подпись в цветной плашке, без картинок,
 * чтобы отчёт оставался одним самодостаточным файлом.
 */
function routineMark(kind) {
  const known = kind === 'function' || kind === 'procedure';
  const cls = known ? kind : 'unknown';
  const label = { function: 'F(x)', procedure: 'P()', unknown: '?' }[cls];
  const title = { function: 'функция', procedure: 'процедура', unknown: 'процедура или функция' }[cls];
  return `<span class="rt-mark rt-mark--${cls}" title="${title}">${label}</span>`;
}

/**
 * Участок правки — одной колонкой.
 *
 * Двух колонок здесь не было смысла: «до помещения» пустует почти всегда —
 * предыдущая версия хранилища трогала, как правило, другие объекты, и левая
 * половина экрана уходила под надпись «этих строк здесь не было» (прямое
 * замечание пользователя, 12.08.2026). Показываем то, что помещено.
 */
function renderCommitFragment(fragment) {
  const tail = fragment.truncated
    ? `<p class="muted" style="font-size:12px">Показаны первые ${formatNumber(fragment.lines.length)} строк участка,
        ещё ${plural(fragment.truncated, 'строка', 'строки', 'строк')} — в JSON-выгрузке результата проверки.</p>`
    : '';

  // Имя процедуры здесь не повторяется: оно стоит заголовком группы выше.
  return `
    <div class="dt__fragment">
      <div class="dt__fragment-head">строки ${fragment.startLine}–${fragment.endLine}</div>
      ${codeBlock(fragment.lines.join('\n'))}
      ${tail}
    </div>`;
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
