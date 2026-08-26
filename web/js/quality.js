/**
 * Раздел «Проверка качества кода».
 *
 * Своя страница, а не флажок в обследовании: здесь другой вопрос (только код),
 * и главное — другой источник. У хранилища конфигурации нет ни пути к базе,
 * ни пользователя базы, зато есть пользователь хранилища и период помещений,
 * поэтому форма переключается целыми блоками, а не отдельными полями:
 * половина полей, не относящихся к выбранному источнику, только путала бы.
 */

import { api, subscribeToQuality } from './api.js';
import {
  $, $$, setNote, renderStages, formatDuration, formatNumber, createTimer, attachPathHint,
  escapeHtml, formatDateTime, openReportInBrowser, restoreInput,
} from './ui.js';

const state = {
  currentId: null,
  unsubscribe: null,
  running: false,
  cancelling: false,
  timer: null,
  periodApplied: { from: '', to: '' },
  // Значения прошлого прогона подставляются один раз за открытие страницы.
  restored: false,
  // Незавершённый выбор в календаре: `anchor` — первая нажатая дата, пока
  // не нажата вторая; `hover` — дата под указателем, ради предварительной
  // подсветки диапазона. Наружу это не попадает до кнопки «Применить».
  picker: { from: '', to: '', anchor: '', hover: '', year: 0, month: 0 },
};

export function initQuality() {
  state.timer = createTimer($('#qProgressTimer'));
  attachPathHint($('#qPath'), $('#qPathHint'), api.parsePath);

  $$('#qRepoKind input[name="qRepoKind"]').forEach((radio) => {
    radio.addEventListener('change', () => applyRepoKind());
  });
  $$('#qSource input[name="qSource"]').forEach((radio) => {
    radio.addEventListener('change', () => applySource(radio.value));
  });
  // Хранилище — источник по умолчанию: авторство там записано платформой,
  // а не угадывается по пометкам в коде. Отмечено оно и в разметке —
  // здесь просто показываем соответствующие поля.
  applySource(currentSource());

  initPeriodDialog();
  initPolicyField();

  $('#qualityForm').addEventListener('submit', (event) => {
    event.preventDefault();
    start();
  });
  $('#qCancelBtn').addEventListener('click', () => cancel());
  $('#qOpenReport').addEventListener('click', (event) => {
    if (!state.currentId) return;
    openReportInBrowser(event.currentTarget, () => api.openQualityReport(state.currentId),
      (message) => setNote('#qSaveNote', message, true));
  });
  $('#qSaveReport').addEventListener('click', () => saveReportAs());

  loadHistory();
}

/**
 * «Скачать отчёт…» — с вопросом, куда именно.
 *
 * Диалог сохранения показывает сервер: браузер положил бы файл в свою папку
 * загрузок под именем `report.html`, без выбора места и без внятного имени.
 * Сохранённый отчёт самодостаточен — ни одной ссылки на работающую программу
 * в нём нет, и он открывается с диска.
 */
async function saveReportAs() {
  if (!state.currentId) return;
  const btn = $('#qSaveReport');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Сохранение…';
  try {
    const result = await api.saveQualityReport(state.currentId);
    setNote('#qSaveNote', result.cancelled ? '' : `Отчёт сохранён: ${result.path}`);
  } catch (err) {
    setNote('#qSaveNote', `Не удалось сохранить: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * Регламент разработки: поле файла открывается флагом.
 *
 * Флаг снимают чаще, чем меняют файл, поэтому путь при снятии не стирается:
 * следующий прогон с регламентом не потребует выбирать файл заново.
 */
function initPolicyField() {
  const flag = $('#qUsePolicy');
  const field = $('#qPolicyField');
  const apply = () => { field.hidden = !flag.checked; };
  flag.addEventListener('change', apply);
  apply();

  $('#qPolicyTemplate').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.savePolicyTemplate();
      if (!result.cancelled) setNote('#qFormNote', `Шаблон регламента сохранён: ${result.path}`);
    } catch (err) {
      setNote('#qFormNote', err.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

/**
 * Поля формы, восстанавливаемые из последнего прогона.
 *
 * Оба переключателя восстанавливаются тоже: без источника и вида хранилища
 * остальные поля оказались бы в скрытых блоках.
 */
const QUALITY_FIELDS = {
  source: 'name:qSource',
  repositoryKind: 'name:qRepoKind',
  infobasePath: '#qPath',
  user: '#qUser',
  repositoryPath: '#qRepoFolder',
  repositoryUser: '#qRepoUser',
  serviceBase: '#qServiceBase',
  serviceBaseUser: '#qServiceBaseUser',
  placementDiffs: '#qPlacementDiffs',
  vendorConfigPath: '#qVendor',
  platformVersion: '#qPlatform',
  workDir: '#qWorkDir',
  keepDump: '#qKeepDump',
  usePolicy: '#qUsePolicy',
  policyPath: '#qPolicyPath',
};

/**
 * Подставляет значения последнего прогона — один раз за открытие страницы.
 *
 * Второй раз (по кнопке обновления истории) подставлять нельзя: пользователь
 * к тому времени уже мог править поля, и затирать их было бы хуже, чем
 * не подставлять вовсе.
 */
function restoreLastInput(input) {
  if (state.restored || !input) return;
  state.restored = true;

  // Адрес хранилища и каталог приходят одним полем: раскладывает их по своим
  // местам тот же признак, что и в форме, — вид хранилища.
  const byFolder = (input.repositoryKind || 'folder') !== 'tcp';
  restoreInput({
    ...QUALITY_FIELDS,
    repositoryPath: byFolder ? '#qRepoFolder' : '#qRepoAddress',
  }, input);
  applySource(currentSource());

  if (input.periodFrom || input.periodTo) {
    $('#qFrom').value = input.periodFrom || '';
    $('#qTo').value = input.periodTo || '';
    state.periodApplied = { from: input.periodFrom || '', to: input.periodTo || '' };
    updatePeriodLabel();
  }
}

/** Перечитать список прошлых проверок — раздел «История» этого режима. */
export function reloadQualityHistory() {
  loadHistory();
}

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
// Неделя начинается с понедельника: в 1С и вообще в русской деловой практике
// воскресенье — конец недели, а не начало.
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/**
 * Период помещений — отдельное окно с календарём на три месяца.
 *
 * Как в 1С: щелчок по дате начала, щелчок по дате конца, выбранный диапазон
 * закрашивается целиком. Открыты сразу текущий месяц и два предыдущих —
 * обычный вопрос «что помещали за квартал» решается без листания. Прежние
 * два поля `input[type=date]` были формально верны и неудобны: браузерный
 * календарь раскрывался дважды и каждый раз начинался с текущего месяца.
 *
 * Поле «Период» в форме показывает уже применённый выбор и само
 * не редактируется; наружу (в `#qFrom`/`#qTo`, которые читает collectInput)
 * даты попадают только по кнопке «Применить». Поэтому «Отмена» и Esc
 * ничего не портят: незавершённый выбор живёт в `state.picker`.
 */
function initPeriodDialog() {
  const dialog = $('#qPeriodDialog');
  const months = $('#qCalMonths');

  $('#qPeriodPick').addEventListener('click', () => {
    const { from, to } = state.periodApplied;
    // Окно календаря заканчивается месяцем уже выбранной даты «по», а без
    // выбора — текущим: показывать три месяца вокруг января, когда человек
    // проверяет вчерашние помещения, было бы бессмысленно.
    const anchorDate = parseIso(to) || parseIso(from) || new Date();
    state.picker = {
      from, to, anchor: '', hover: '',
      year: anchorDate.getFullYear(), month: anchorDate.getMonth(),
    };
    renderCalendar();
    dialog.showModal();
  });

  $('#qCalPrev').addEventListener('click', () => shiftMonths(-1));
  $('#qCalNext').addEventListener('click', () => shiftMonths(1));

  months.addEventListener('click', (event) => {
    const cell = event.target.closest('.cal__day[data-date]');
    if (!cell) return;
    pickDate(cell.dataset.date);
  });

  // Предварительная подсветка: пока вторая дата не нажата, диапазон тянется
  // за указателем — видно, что именно будет выбрано, ещё до щелчка.
  months.addEventListener('mouseover', (event) => {
    if (!state.picker.anchor) return;
    const cell = event.target.closest('.cal__day[data-date]');
    if (!cell || cell.dataset.date === state.picker.hover) return;
    state.picker.hover = cell.dataset.date;
    paintCalendar();
  });
  months.addEventListener('mouseleave', () => {
    if (!state.picker.hover) return;
    state.picker.hover = '';
    paintCalendar();
  });

  $('#qPeriodReset').addEventListener('click', () => {
    state.picker = { ...state.picker, from: '', to: '', anchor: '', hover: '' };
    paintCalendar();
  });

  $('#qPeriodCancel').addEventListener('click', () => dialog.close());

  $('#qPeriodApply').addEventListener('click', () => {
    const { from, to } = selectedRange();
    state.periodApplied = { from, to };
    $('#qFrom').value = from;
    $('#qTo').value = to;
    updatePeriodLabel();
    dialog.close();
  });

  updatePeriodLabel();
}

/** Что выбрано сейчас: готовый диапазон либо тянущийся за указателем. */
function selectedRange() {
  const { from, to, anchor, hover } = state.picker;
  if (!anchor) return { from, to };
  const other = hover || anchor;
  return anchor <= other ? { from: anchor, to: other } : { from: other, to: anchor };
}

/**
 * Щелчок по дате. Первый задаёт начало, второй — конец; если второй раньше
 * первого, границы меняются местами (человек мог начать с правого края).
 * Третий щелчок начинает выбор заново — это привычное поведение календарей
 * с диапазоном, и объяснять его не приходится.
 */
function pickDate(iso) {
  const p = state.picker;
  if (!p.anchor) {
    p.anchor = iso;
    p.from = iso;
    p.to = iso;
  } else {
    p.from = iso < p.anchor ? iso : p.anchor;
    p.to = iso < p.anchor ? p.anchor : iso;
    p.anchor = '';
  }
  p.hover = '';
  paintCalendar();
}

function shiftMonths(delta) {
  const shifted = new Date(state.picker.year, state.picker.month + delta, 1);
  state.picker.year = shifted.getFullYear();
  state.picker.month = shifted.getMonth();
  renderCalendar();
}

/** Три месяца: текущий в окне — последний, слева от него два предыдущих. */
function renderCalendar() {
  const { year, month } = state.picker;
  const html = [];
  for (let back = 2; back >= 0; back -= 1) {
    const first = new Date(year, month - back, 1);
    html.push(renderMonth(first.getFullYear(), first.getMonth()));
  }
  $('#qCalMonths').innerHTML = html.join('');
  paintCalendar();
}

function renderMonth(year, month) {
  const first = new Date(year, month, 1);
  // getDay(): 0 — воскресенье. Сдвигаем к «понедельник — нулевой день».
  const shift = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();

  const cells = WEEKDAYS.map((name) => `<span class="cal__dow">${name}</span>`);
  for (let i = 0; i < shift; i += 1) cells.push('<span class="cal__day cal__day--empty"></span>');
  for (let day = 1; day <= days; day += 1) {
    const iso = isoOf(year, month, day);
    const weekend = (shift + day - 1) % 7 >= 5;
    cells.push(
      `<button type="button" class="cal__day${weekend ? ' is-weekend' : ''}" `
      + `data-date="${iso}">${day}</button>`,
    );
  }

  return `<div class="cal__month">
    <div class="cal__caption">${MONTH_NAMES[month]} ${year}</div>
    <div class="cal__grid">${cells.join('')}</div>
  </div>`;
}

/**
 * Подсветка выбора — переключением классов у уже нарисованных ячеек, а не
 * перерисовкой: подсветка меняется на каждое движение мыши, и собирать ради
 * этого три месяца заново значило бы гасить ячейку прямо под указателем.
 */
function paintCalendar() {
  const { from, to } = selectedRange();
  const today = isoOf(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  $$('#qCalMonths .cal__day[data-date]').forEach((cell) => {
    const iso = cell.dataset.date;
    const edge = Boolean(from) && (iso === from || iso === to);
    cell.classList.toggle('is-today', iso === today);
    cell.classList.toggle('is-edge', edge);
    cell.classList.toggle('is-in', Boolean(from && to) && iso > from && iso < to);
  });

  const label = from && to
    ? `${ru(from)} — ${ru(to)}`
    : 'Весь период';
  $('#qCalChosen').textContent = state.picker.anchor
    ? `${ru(from)} — укажите дату конца`
    : label;
}

function isoOf(year, month, day) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function ru(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function updatePeriodLabel() {
  const { from, to } = state.periodApplied;
  const field = $('#qPeriod');
  if (from && to) field.value = `${ru(from)} — ${ru(to)}`;
  else if (from) field.value = `с ${ru(from)}`;
  else if (to) field.value = `по ${ru(to)}`;
  else field.value = '';
}

/** Этапы рисуются до запуска: видно, из чего состоит работа. */
export function showQualityStages(stages) {
  renderStages($('#qStages'), stages.map((s) => ({ ...s, status: 'pending', detail: '', note: '' })));
}

function currentSource() {
  return $('#qSource input[name="qSource"]:checked')?.value || 'infobase';
}

function applySource(source) {
  $$('[data-source]').forEach((block) => {
    block.hidden = block.dataset.source !== source;
  });
  $('#qStartBtn').querySelector('span').textContent = source === 'repository'
    ? 'Проверить помещения в хранилище'
    : 'Проверить качество кода';
  applyRepoKind();
}

/** Каталог или сервер хранилищ: у вариантов разная работа и разные поля. */
function currentRepoKind() {
  return $('#qRepoKind input[name="qRepoKind"]:checked')?.value || 'folder';
}

/**
 * Показывает поля выбранного варианта и прячет чужие.
 *
 * Версия платформы прячется вместе с ними: хранилище-каталог читается
 * напрямую, платформа при этом не запускается ни разу — спрашивать её версию
 * значило бы спрашивать о том, что ни на что не влияет.
 */
function applyRepoKind() {
  const kind = currentRepoKind();
  const repository = currentSource() === 'repository';
  $$('[data-repo-kind]').forEach((block) => {
    block.hidden = !repository || block.dataset.repoKind !== kind;
  });
  $$('[data-needs-platform]').forEach((block) => {
    block.hidden = repository && kind === 'folder';
  });
}

function collectInput() {
  const source = currentSource();
  const repositoryKind = currentRepoKind();
  const byFolder = repositoryKind === 'folder';
  return {
    source,
    infobasePath: $('#qPath').value.trim(),
    user: $('#qUser').value.trim(),
    password: $('#qPassword').value,
    // Поле у каждого варианта своё, а конвейеру уходит одно: что именно
    // введено, он разбирает сам (`repositorySources`).
    repositoryKind,
    repositoryPath: (byFolder ? $('#qRepoFolder').value : $('#qRepoAddress').value).trim(),
    // Пользователь хранилища и служебная база нужны только платформе:
    // у каталога программа читает файлы и ни к кому не подключается.
    repositoryUser: byFolder ? '' : $('#qRepoUser').value.trim(),
    repositoryPassword: byFolder ? '' : $('#qRepoPassword').value,
    serviceBase: byFolder ? '' : $('#qServiceBase').value.trim(),
    serviceBaseUser: byFolder ? '' : $('#qServiceBaseUser').value.trim(),
    serviceBasePassword: byFolder ? '' : $('#qServiceBasePassword').value,
    periodFrom: $('#qFrom').value,
    periodTo: $('#qTo').value,
    placementDiffs: byFolder ? 'on' : $('#qPlacementDiffs').value,
    vendorConfigPath: $('#qVendor').value.trim(),
    platformVersion: byFolder ? '' : $('#qPlatform').value.trim(),
    workDir: $('#qWorkDir').value.trim(),
    keepDump: $('#qKeepDump').checked,
    // Регламент разработки проекта: флаг и путь идут отдельно, чтобы снятый
    // флаг не стирал выбранный файл.
    usePolicy: $('#qUsePolicy').checked,
    policyPath: $('#qPolicyPath').value.trim(),
  };
}

async function start() {
  if (state.running) return;
  const input = collectInput();

  const byFolder = input.repositoryKind === 'folder';
  const checks = input.source === 'repository'
    ? (byFolder
      ? [[input.repositoryPath, 'Укажите каталог с хранилищами', '#qRepoFolder']]
      : [
        [input.repositoryPath, 'Укажите адрес хранилища', '#qRepoAddress'],
        [input.repositoryUser, 'Укажите пользователя хранилища', '#qRepoUser'],
      ])
    : [[input.infobasePath, 'Укажите путь к информационной базе', '#qPath']];
  checks.push([input.workDir, 'Укажите рабочий каталог', '#qWorkDir']);
  if (input.usePolicy) {
    checks.push([input.policyPath, 'Укажите файл регламента разработки', '#qPolicyPath']);
  }

  for (const [value, message, focus] of checks) {
    if (!value) {
      setNote('#qFormNote', message, true);
      $(focus).focus();
      return;
    }
  }

  setNote('#qFormNote', '');
  setBusy(true);
  try {
    const { qualityId } = await api.startQuality(input);
    state.currentId = qualityId;
    showProgressCard(qualityId);
    attachStream(qualityId);
  } catch (err) {
    setNote('#qFormNote', err.message, true);
    setBusy(false);
    setRunning(false);
    state.timer.stop();
  }
}

async function cancel() {
  if (!state.currentId || state.cancelling) return;
  state.cancelling = true;
  const btn = $('#qCancelBtn');
  btn.disabled = true;
  btn.textContent = 'Прерывание…';
  try {
    await api.cancelQuality(state.currentId);
    $('#qProgressSub').textContent = 'Останавливаем выполнение…';
  } catch (err) {
    state.cancelling = false;
    btn.disabled = false;
    btn.textContent = 'Прервать';
    setNote('#qFormNote', err.message, true);
  }
}

function setBusy(busy) {
  const btn = $('#qStartBtn');
  btn.disabled = busy;
  const form = $('#qualityForm');
  form.classList.toggle('is-locked', busy);
  $$('input, select, button, textarea', form).forEach((el) => {
    if (el.id === 'qStartBtn') return;
    el.disabled = busy;
  });
}

function setRunning(running) {
  state.running = running;
  const btn = $('#qCancelBtn');
  btn.disabled = !running;
  btn.textContent = 'Прервать';
}

function showProgressCard(qualityId) {
  const card = $('#qProgressCard');
  card.hidden = false;
  $('#qErrorBox').hidden = true;
  $('#qRunStats').hidden = true;
  $('#qResultActions').hidden = true;
  $('#qProgressTitle').textContent = 'Идёт проверка';
  $('#qProgressSub').textContent = `Идентификатор: ${qualityId}`;
  $('#qProgressPercent').textContent = '0%';
  $('#qProgressBar').style.width = '0%';

  state.cancelling = false;
  setRunning(true);
  state.timer.start();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function attachStream(qualityId) {
  state.unsubscribe?.();
  state.unsubscribe = subscribeToQuality(qualityId, {
    onUpdate: (payload) => {
      const snapshot = payload.snapshot || payload;
      if (snapshot.stages) applySnapshot(snapshot);
    },
    onFinish: () => onFinished(qualityId),
    onCancelled: (message) => onStopped(message),
    onError: (message) => onFailed(message),
  });
}

function applySnapshot(snapshot) {
  const percent = snapshot.percent ?? 0;
  $('#qProgressPercent').textContent = `${percent}%`;
  $('#qProgressBar').style.width = `${percent}%`;
  if (snapshot.stages?.length) renderStages($('#qStages'), snapshot.stages);

  const running = snapshot.stages?.find((s) => s.status === 'running');
  if (running && !state.cancelling) {
    $('#qProgressSub').textContent = running.detail
      ? `${running.title}: ${running.detail}`
      : running.title;
  }
}

// ------------------------------------------------------------------ История

/**
 * Прошлые проверки — своим списком, как у обследования и обновления.
 *
 * Раздел долго обходился без истории: считалось, что отчёт открывается сразу
 * и хранить его незачем. На деле проверок за день делается несколько, а сравнить
 * их между собой — обычное дело, и искать прежний отчёт приходилось в каталоге
 * данных руками. Прогоны и так сохранялись все — не хватало только страницы.
 */
async function loadHistory() {
  const container = $('#qHistoryList');
  if (!container) return;
  container.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const { items } = await api.listQuality();
    restoreLastInput(items[0]?.input);
    if (!items.length) {
      container.innerHTML = '<div class="empty">Проверки качества ещё не выполнялись.</div>';
      return;
    }
    container.innerHTML = items.map(renderHistoryItem).join('');

    // Отчёт открывает сервер — в браузере по умолчанию, а не ещё одним окном
    // приложения без адресной строки.
    $$('[data-open]', container).forEach((btn) => {
      btn.addEventListener('click', () => openReportInBrowser(
        btn, () => api.openQualityReport(btn.dataset.open),
      ));
    });

    $$('[data-delete]', container).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить запись об этой проверке вместе с её отчётом?')) return;
        await api.deleteQuality(btn.dataset.delete);
        loadHistory();
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="empty">Не удалось загрузить список: ${escapeHtml(err.message)}</div>`;
  }
}

function renderHistoryItem(meta) {
  const s = meta.summary || {};
  const statusRu = {
    done: 'Выполнено', failed: 'Ошибка', running: 'Выполняется', cancelled: 'Прервано',
  }[meta.status] || meta.status;

  const fromRepo = s.source === 'repository';
  // Заголовок — то, по чему проверку узнаёшь: имя конфигурации, а пока его нет
  // (прогон не дошёл до разбора) — источник, который указывали в форме.
  const title = s.configName
    || (fromRepo
      ? (meta.input?.repositoryAddress || meta.input?.repositoryPath)
      : meta.input?.infobasePath)
    || 'Проверка качества';
  const period = [s.periodFrom, s.periodTo].filter(Boolean).join(' — ');

  return `
  <div class="hist-item">
    <div class="hist-main">
      <div class="hist-title">
        ${escapeHtml(title)}
        <span class="hist-meta">${fromRepo ? 'хранилище конфигурации' : 'информационная база'}</span>
      </div>
      <div class="hist-meta">
        <span class="status-pill is-${meta.status}">${statusRu}</span>
        · ${formatDateTime(meta.createdAt)}
        ${meta.durationMs ? ` · время: ${formatDuration(meta.durationMs)}` : ''}
        ${fromRepo && s.repositories != null ? ` · хранилищ: ${formatNumber(s.repositories)}` : ''}
        ${period ? ` · период: ${escapeHtml(period)}` : ''}
        ${s.analyzedModules != null ? ` · модулей: ${formatNumber(s.analyzedModules)}` : ''}
        ${s.authors ? ` · разработчиков: ${formatNumber(s.authors)}` : ''}
      </div>
      ${meta.error ? `<div class="hist-meta" style="color:var(--danger)">${escapeHtml(meta.error)}</div>` : ''}
    </div>

    ${meta.status === 'done' ? `
    <div class="hist-scores">
      <div class="hist-score">
        <div class="hist-score__val ${s.findings ? 'grade-warn' : 'grade-good'}">${formatNumber(s.findings || 0)}</div>
        <div class="hist-score__lbl">Замечаний</div>
      </div>
      <div class="hist-score">
        <div class="hist-score__val ${s.critical ? 'grade-bad' : 'grade-good'}">${formatNumber(s.critical || 0)}</div>
        <div class="hist-score__lbl">Критичных</div>
      </div>
    </div>` : ''}

    <div class="hist-actions">
      ${meta.status === 'done'
    ? `<button class="btn" type="button" data-open="${meta.id}">Отчёт</button>`
    : ''}
      <button class="btn btn--danger" data-delete="${meta.id}">Удалить</button>
    </div>
  </div>`;
}

async function onFinished(qualityId) {
  setBusy(false);
  setRunning(false);
  $('#qProgressTitle').textContent = 'Проверка завершена';
  $('#qProgressSub').textContent = 'Отчёт готов';
  $('#qProgressPercent').textContent = '100%';
  $('#qProgressBar').style.width = '100%';

  $('#qResultActions').hidden = false;
  await showStats(qualityId);
  // Список прошлых проверок пополнился только что — перечитываем сразу,
  // чтобы «История» не показывала вчерашнее состояние.
  loadHistory();

  // Отчёт открывается сам, как и в обследовании: за ним и запускали.
  try {
    await api.openQualityReport(qualityId);
  } catch {
    /* не открылось — ссылка рядом */
  }
}

async function showStats(qualityId) {
  const box = $('#qRunStats');
  try {
    const meta = await api.quality(qualityId);
    const s = meta.summary || {};
    const durationMs = state.timer.finish(meta.durationMs);
    const parts = [];
    if (durationMs != null) parts.push(`<b>Время:</b> ${formatDuration(durationMs)}`);
    if (s.source === 'repository') {
      parts.push(`хранилищ: ${formatNumber(s.repositories || 0)}`);
      if (s.periodFrom || s.periodTo) parts.push(`период: ${s.periodFrom || '…'} — ${s.periodTo || '…'}`);
    }
    if (s.analyzedModules != null) parts.push(`модулей проверено: ${formatNumber(s.analyzedModules)}`);
    parts.push(s.findings
      ? `<b style="color:var(--warn)">замечаний: ${formatNumber(s.findings)}</b>`
      : '<b style="color:var(--good)">замечаний нет</b>');
    if (s.critical) parts.push(`<b style="color:var(--danger)">критичных: ${formatNumber(s.critical)}</b>`);
    if (s.authors) parts.push(`разработчиков: ${formatNumber(s.authors)}`);

    box.innerHTML = parts.join(' · ');
    box.hidden = false;
  } catch {
    state.timer.finish(null);
    box.hidden = true;
  }
}

function onStopped(message) {
  setBusy(false);
  setRunning(false);
  state.cancelling = false;
  state.timer.stop();
  $('#qProgressTitle').textContent = 'Проверка прервана';
  $('#qProgressSub').textContent = message || 'Остановлено пользователем';
}

function onFailed(message) {
  setBusy(false);
  setRunning(false);
  state.timer.stop();
  $('#qProgressTitle').textContent = 'Проверка не выполнена';
  $('#qProgressSub').textContent = 'Подробности ниже';
  const box = $('#qErrorBox');
  box.textContent = message || 'Неизвестная ошибка';
  box.hidden = false;
}
