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
  escapeHtml, formatDateTime, openReportInBrowser,
} from './ui.js';

const state = {
  currentId: null,
  unsubscribe: null,
  running: false,
  cancelling: false,
  timer: null,
  periodApplied: { from: '', to: '' },
};

export function initQuality() {
  state.timer = createTimer($('#qProgressTimer'));
  attachPathHint($('#qPath'), $('#qPathHint'), api.parsePath);

  $$('#qSource input[name="qSource"]').forEach((radio) => {
    radio.addEventListener('change', () => applySource(radio.value));
  });
  // Хранилище — источник по умолчанию: авторство там записано платформой,
  // а не угадывается по пометкам в коде. Отмечено оно и в разметке —
  // здесь просто показываем соответствующие поля.
  applySource(currentSource());

  // Второй, вложенный выбор: хранилище лежит каталогом на диске либо
  // на сервере хранилищ, доступном по адресу.
  $$('#qRepoKind input[name="qRepoKind"]').forEach((radio) => {
    radio.addEventListener('change', () => applyRepoKind(radio.value));
  });
  applyRepoKind(currentRepoKind());

  // Адрес, вставленный в поле каталога, переключает вид сам. Живой случай
  // 13.08.2026: на сервере заказчика `tcp://сервер/erp25/хранилище` попал
  // в «Каталог с хранилищами» — переключатель остался на «Каталог на диске»,
  // и программа пошла искать в этом «каталоге» файл cfgrepo.conf. Заметить
  // второй переключатель мешает то, что он вложен в первый и виден не сразу.
  // Событие `change`, а не `input`: по `input` переключение сработало бы
  // на середине набора («tcp://» уже похоже на адрес), поле каталога тут же
  // спряталось бы, и человек дописывал бы адрес в невидимое поле.
  $('#qRepo').addEventListener('change', () => {
    const value = $('#qRepo').value.trim();
    if (!/^(?:tcp|https?):\/\//i.test(value)) return;
    $('#qRepoAddress').value = value;
    $('#qRepo').value = '';
    $('#qRepoKind input[value="address"]').checked = true;
    applyRepoKind('address');
    setNote('#qFormNote', 'Это сетевой адрес — переключил на «Сетевой адрес».', false);
  });

  initPeriodDialog();

  $('#qualityForm').addEventListener('submit', (event) => {
    event.preventDefault();
    start();
  });
  $('#qCancelBtn').addEventListener('click', () => cancel());
  $('#qOpenReport').addEventListener('click', (event) => {
    if (!state.currentId) return;
    openReportInBrowser(event.currentTarget, () => api.openQualityReport(state.currentId),
      (message) => setNote('#qFormNote', message, true));
  });

  loadHistory();
}

/** Перечитать список прошлых проверок — раздел «История» этого режима. */
export function reloadQualityHistory() {
  loadHistory();
}

/**
 * Период помещений — отдельное окно вместо двух дат прямо в форме.
 *
 * Поле «Период» показывает уже применённый выбор и само не редактируется;
 * даты меняются только внутри диалога и попадают наружу по кнопке
 * «Применить». Так «Отмена» и закрытие по Esc гарантированно ничего
 * не портят: `#qFrom`/`#qTo` — это и есть значения, которые читает
 * collectInput(), поэтому при отмене их нужно вернуть к последним
 * применённым, а не оставить недосохранённый ввод.
 */
function initPeriodDialog() {
  const dialog = $('#qPeriodDialog');

  $('#qPeriodPick').addEventListener('click', () => {
    $('#qFrom').value = state.periodApplied.from;
    $('#qTo').value = state.periodApplied.to;
    dialog.showModal();
  });

  $('#qPeriodReset').addEventListener('click', () => {
    $('#qFrom').value = '';
    $('#qTo').value = '';
  });

  // Откат несохранённого ввода делается явно в каждом пути закрытия, а не
  // через событие `close` диалога: в проверке живьём оно не сработало после
  // программного `close()` — значения из диалога утекали наружу молча.
  const revert = () => {
    $('#qFrom').value = state.periodApplied.from;
    $('#qTo').value = state.periodApplied.to;
  };

  $('#qPeriodCancel').addEventListener('click', () => {
    revert();
    dialog.close();
  });

  $('#qPeriodApply').addEventListener('click', () => {
    state.periodApplied = { from: $('#qFrom').value, to: $('#qTo').value };
    updatePeriodLabel();
    dialog.close();
  });

  // Esc — тот же «отказ», что кнопка «Отмена»: событие `cancel` (в отличие
  // от `close`) в проверке сработало надёжно.
  dialog.addEventListener('cancel', revert);

  updatePeriodLabel();
}

function updatePeriodLabel() {
  const { from, to } = state.periodApplied;
  const ru = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
  };
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
}

function currentRepoKind() {
  return $('#qRepoKind input[name="qRepoKind"]:checked')?.value || 'path';
}

/** Каталог на диске или сетевой адрес — показываем поля выбранного варианта. */
function applyRepoKind(kind) {
  $$('[data-repo-kind]').forEach((block) => {
    block.hidden = block.dataset.repoKind !== kind;
  });
}

function collectInput() {
  return {
    source: currentSource(),
    infobasePath: $('#qPath').value.trim(),
    user: $('#qUser').value.trim(),
    password: $('#qPassword').value,
    repositoryKind: currentRepoKind(),
    repositoryPath: $('#qRepo').value.trim(),
    repositoryAddress: $('#qRepoAddress').value.trim(),
    repositoryUser: $('#qRepoUser').value.trim(),
    repositoryPassword: $('#qRepoPassword').value,
    periodFrom: $('#qFrom').value,
    periodTo: $('#qTo').value,
    vendorConfigPath: $('#qVendor').value.trim(),
    platformVersion: $('#qPlatform').value.trim(),
    workDir: $('#qWorkDir').value.trim(),
    keepDump: $('#qKeepDump').checked,
  };
}

async function start() {
  if (state.running) return;
  const input = collectInput();

  const checks = input.source === 'repository'
    ? [
      input.repositoryKind === 'address'
        ? [input.repositoryAddress, 'Укажите сетевой адрес хранилища', '#qRepoAddress']
        : [input.repositoryPath, 'Укажите каталог с хранилищами конфигурации', '#qRepo'],
      [input.repositoryUser, 'Укажите пользователя хранилища', '#qRepoUser'],
    ]
    : [[input.infobasePath, 'Укажите путь к информационной базе', '#qPath']];
  checks.push([input.workDir, 'Укажите рабочий каталог', '#qWorkDir']);

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
