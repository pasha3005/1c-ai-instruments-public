/**
 * Раздел «Обновление конфигурации».
 *
 * Свой файл, а не ещё одна ветка в `app.js`: у обновления другой конвейер,
 * другой результат и — главное — действие, которое ПИШЕТ в информационную базу.
 * Держать его вперемешку с логикой обследования, где запись невозможна
 * в принципе, значило бы каждый раз перечитывать, какая ветка что делает.
 *
 * Общие с обследованием кирпичики (шкала этапов, секундомер, счёт, подсказка
 * по пути к базе) живут в `ui.js`.
 */

import { api, subscribeToUpdate } from './api.js';
import { openMerge } from './merge.js';
import { switchView } from './app.js';
import {
  $, $$, escapeHtml, setNote, renderStages, formatDuration, formatNumber,
  formatDateTime, createTimer, attachPathHint, openReportInBrowser, restoreInput,
} from './ui.js';

const state = {
  currentId: null,
  unsubscribe: null,
  cancelling: false,
  running: false,
  timer: null,
  /** Значения прошлого объединения подставлены — второй раз не подставляем. */
  restored: false,
  /** Сколько спорных мест ещё не разобрано. null — ещё не спрашивали. */
  left: null,
};

/** Поля формы обновления, восстанавливаемые из последнего прогона. */
const UPDATE_FIELDS = {
  infobasePath: '#uPath',
  user: '#uUser',
  platformVersion: '#uPlatform',
  vendorConfigPath: '#uVendor',
  targetConfigPath: '#uTarget',
  workDir: '#uWorkDir',
  reportTheme: '#uReportTheme',
  keepDump: '#uKeepDump',
  openResultsForm: '#uOpenResultsForm',
};

export function initUpdate() {
  state.timer = createTimer($('#uProgressTimer'));

  attachPathHint($('#uPath'), $('#uPathHint'), api.parsePath);

  $('#updateForm').addEventListener('submit', (event) => {
    event.preventDefault();
    start();
  });

  $('#uCancelBtn').addEventListener('click', () => cancel());
  $('#uOpenReport').addEventListener('click', (event) => {
    if (!state.currentId) return;
    openReportInBrowser(event.currentTarget, () => api.openUpdateReport(state.currentId),
      (message) => setSaveNote(message, true));
  });
  $('#uSaveReport').addEventListener('click', () => saveReportAs());
  $('#uReviewBtn').addEventListener('click', () => switchView('merge'));
  $('#uLoadBtn').addEventListener('click', () => loadIntoBase());
  $('#uAskYes').addEventListener('click', () => answer(true));
  $('#uAskNo').addEventListener('click', () => answer(false));

  loadHistory();
}

/** Перечитать список прошлых объединений — раздел «История» этого режима. */
export function reloadUpdateHistory() {
  loadHistory();
}

/**
 * Открыть окно разбора спорных мест для текущего прогона.
 *
 * Зовётся навигацией (`app.js`), а не кнопкой: на страницу разбора можно
 * попасть и кнопкой, и возвратом из истории, и в обоих случаях данные нужно
 * перечитать — человек мог править файлы своим редактором.
 */
export async function openUpdateReview() {
  if (!state.currentId) return;
  await openMerge(state.currentId);
  await refreshReviewState();
}

/**
 * Сколько спорных мест ждёт решения — и что от этого зависит на форме.
 *
 * Пока их не ноль, кнопки загрузки в конфигурацию нет вовсе. Неактивная кнопка
 * выглядела бы как неисправная, а сервер такую загрузку всё равно отклоняет
 * (`loadUpdateResult`): показывать её значило бы предлагать сделать то, что
 * заведомо не выйдет.
 */
async function refreshReviewState() {
  if (!state.currentId) return null;
  try {
    const review = await api.updateReview(state.currentId);
    state.left = review.totals?.left ?? 0;
    const total = (review.totals?.manual || 0) + (review.totals?.auto || 0);
    const btn = $('#uReviewBtn');
    btn.hidden = total === 0;
    btn.textContent = state.left
      ? `Разобрать спорные места (${formatNumber(state.left)})`
      : 'Спорные места';
    btn.classList.toggle('btn--primary', state.left > 0);
    return review;
  } catch {
    state.left = null;
    return null;
  }
}

/** Этапы конвейера рисуются до запуска: видно, из чего работа состоит. */
export function showUpdateStages(stages) {
  renderStages($('#uStages'), stages.map((s) => ({ ...s, status: 'pending', detail: '', note: '' })));
}

// ------------------------------------------------------------------ Запуск

function collectInput() {
  return {
    infobasePath: $('#uPath').value.trim(),
    user: $('#uUser').value.trim(),
    password: $('#uPassword').value,
    platformVersion: $('#uPlatform').value.trim(),
    vendorConfigPath: $('#uVendor').value.trim(),
    targetConfigPath: $('#uTarget').value.trim(),
    workDir: $('#uWorkDir').value.trim(),
    reportTheme: $('#uReportTheme').value,
    keepDump: $('#uKeepDump').checked,
    openResultsForm: $('#uOpenResultsForm').checked,
  };
}

async function start() {
  if (state.running) return;
  const input = collectInput();

  for (const [value, message, focus] of [
    [input.infobasePath, 'Укажите путь к информационной базе', '#uPath'],
    [input.targetConfigPath, 'Укажите целевую конфигурацию — файл .cf новой поставки', '#uTarget'],
    [input.workDir, 'Укажите каталог для выгрузки', '#uWorkDir'],
  ]) {
    if (!value) {
      setNote('#uFormNote', message, true);
      $(focus).focus();
      return;
    }
  }

  setNote('#uFormNote', '');
  setBusy(true);

  try {
    const { updateId } = await api.startUpdate(input);
    state.currentId = updateId;
    showProgressCard(updateId);
    attachStream(updateId);
  } catch (err) {
    setNote('#uFormNote', err.message, true);
    setBusy(false);
    setRunning(false);
    state.timer.stop();
  }
}

async function cancel() {
  if (!state.currentId || state.cancelling) return;
  if (!confirm('Прервать объединение? Файлы выгрузки останутся в промежуточном состоянии.')) return;

  state.cancelling = true;
  const btn = $('#uCancelBtn');
  btn.disabled = true;
  btn.textContent = 'Прерывание…';
  try {
    await api.cancelUpdate(state.currentId);
    $('#uProgressSub').textContent = 'Останавливаем выполнение…';
  } catch (err) {
    state.cancelling = false;
    btn.disabled = false;
    btn.textContent = 'Прервать';
    setNote('#uFormNote', err.message, true);
  }
}

function setBusy(busy) {
  const btn = $('#uStartBtn');
  btn.disabled = busy;
  btn.querySelector('span').textContent = busy ? 'Объединение выполняется…' : 'Запустить объединение';

  const form = $('#updateForm');
  form.classList.toggle('is-locked', busy);
  $$('input, select, button', form).forEach((el) => {
    if (el.id === 'uStartBtn') return;
    el.disabled = busy;
  });
}

function setRunning(running) {
  state.running = running;
  const cancelBtn = $('#uCancelBtn');
  cancelBtn.disabled = !running;
  cancelBtn.textContent = 'Прервать';
}

function showProgressCard(updateId) {
  const card = $('#uProgressCard');
  card.hidden = false;
  $('#uErrorBox').hidden = true;
  $('#uRunStats').hidden = true;
  $('#uResultActions').hidden = true;
  $('#uSaveNote').hidden = true;
  $('#uAsk').hidden = true;
  $('#uProgressTitle').textContent = 'Выполняется объединение';
  $('#uProgressSub').textContent = `Идентификатор: ${updateId}`;
  $('#uProgressPercent').textContent = '0%';
  $('#uProgressBar').style.width = '0%';

  state.cancelling = false;
  setRunning(true);
  state.timer.start();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ------------------------------------------------------------- Поток событий

function attachStream(updateId) {
  state.unsubscribe?.();
  state.unsubscribe = subscribeToUpdate(updateId, {
    onUpdate: (payload) => {
      const snapshot = payload.snapshot || payload;
      if (snapshot.stages) applySnapshot(snapshot);
    },
    onAsk: (payload) => showAsk(payload.question),
    onAnswered: () => hideAsk(),
    onFinish: () => onFinished(updateId),
    onCancelled: (message, durationMs) => onCancelled(message, durationMs),
    onError: (message) => onFailed(message),
  });
}

function applySnapshot(snapshot) {
  const percent = snapshot.percent ?? 0;
  $('#uProgressPercent').textContent = `${percent}%`;
  $('#uProgressBar').style.width = `${percent}%`;
  if (snapshot.stages?.length) renderStages($('#uStages'), snapshot.stages);

  // Снимок состояния приходит и при переподключении: если конвейер стоит
  // с вопросом, вопрос надо показать заново — иначе он будет ждать вечно.
  if (snapshot.pending?.question) showAsk(snapshot.pending.question);

  const running = snapshot.stages?.find((s) => s.status === 'running');
  if (running && !state.cancelling) {
    $('#uProgressSub').textContent = running.detail
      ? `${running.title}: ${running.detail}`
      : running.title;
  }
}

// ------------------------------------------- Вопрос перед записью в базу

/**
 * Конвейер дошёл до записи в базу и ждёт решения.
 *
 * Спрашивается здесь, а не флажком на форме: между запуском и этим моментом
 * проходит всё объединение, и решение принимается уже зная, сколько мест
 * потребовало вмешательства.
 */
function showAsk(question) {
  $('#uAskTitle').textContent = question?.title || 'Загрузить результат в информационную базу?';
  $('#uAskText').textContent = [question?.text, question?.infobase ? `База: ${question.infobase}` : '']
    .filter(Boolean).join(' ');
  $('#uAsk').hidden = false;
  $('#uAskYes').disabled = false;
  $('#uAskNo').disabled = false;
  $('#uAsk').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideAsk() {
  $('#uAsk').hidden = true;
}

async function answer(ok) {
  if (!state.currentId) return;
  if (ok && !confirm(
    'Записать результат объединения в информационную базу?\n\n'
    + 'Будет загружена ОСНОВНАЯ конфигурация и выполнено обновление конфигурации базы данных —\n'
    + 'это реструктуризация таблиц, платформа может предупредить о потере данных.\n'
    + 'Базе нужен монопольный доступ: закройте все сеансы 1С.\n\n'
    + 'Резервная копия базы должна быть сделана заранее. Продолжить?',
  )) return;

  $('#uAskYes').disabled = true;
  $('#uAskNo').disabled = true;
  try {
    await api.answerUpdate(state.currentId, ok);
    hideAsk();
  } catch (err) {
    setSaveNote(`Не удалось передать ответ: ${err.message}`, true);
    $('#uAskYes').disabled = false;
    $('#uAskNo').disabled = false;
  }
}

async function onFinished(updateId) {
  setBusy(false);
  setRunning(false);
  state.currentId = updateId;
  $('#uProgressTitle').textContent = 'Объединение завершено';
  $('#uProgressSub').textContent = 'Отчёт готов';
  $('#uProgressPercent').textContent = '100%';
  $('#uProgressBar').style.width = '100%';

  $('#uDownloadJson').href = `api/updates/${updateId}/result`;
  $('#uResultActions').hidden = false;

  try {
    await api.openUpdateReport(updateId);
  } catch (err) {
    setSaveNote(`Отчёт готов, но окно не открылось: ${err.message}. Нажмите «Открыть отчёт».`, true);
  }

  await showStats(updateId);
  loadHistory();
}

/**
 * Итоги прогона строкой.
 *
 * Главное число — сколько мест требует решения: от него зависит, что человек
 * делает дальше, и оно же определяет вид кнопки загрузки.
 */
async function showStats(updateId) {
  const box = $('#uRunStats');
  try {
    const meta = await api.update(updateId);
    const s = meta.summary || {};
    const durationMs = state.timer.finish(meta.durationMs);
    const parts = [];
    if (durationMs != null) parts.push(`<b>Время:</b> ${formatDuration(durationMs)}`);

    // Типовое обновление: числа объединения к нему не относятся, показывать
    // «файлов сверено: 0» и «ручной работы не осталось» было бы бессмыслицей.
    if (s.updateMode === 'typical') {
      parts.push('<b>доработок нет</b> — обновление выполнила платформа');
      if (s.twiceChanged) {
        parts.push(`<b style="color:var(--warn)">дважды изменённых свойств: ${formatNumber(s.twiceChanged)}</b>`);
      }
      if (s.dbUpdated) parts.push('<b style="color:var(--good)">конфигурация базы данных обновлена</b>');
      if (s.checkErrors) parts.push(`<b style="color:var(--warn)">замечаний платформы: ${formatNumber(s.checkErrors)}</b>`);
      box.innerHTML = parts.join(' · ');
      box.hidden = false;
      $('#uLoadBtn').hidden = true;
      $('#uReviewBtn').hidden = true;
      setSaveNote('Обновление выполнено штатной командой платформы: объединять было нечего.');
      return;
    }
    // Спорные места решают, показывать ли загрузку: неразобранное объединение
    // загружать нельзя, и сервер это тоже проверяет.
    await refreshReviewState();
    $('#uLoadBtn').hidden = state.left > 0;

    if (s.files != null) parts.push(`файлов сверено: ${formatNumber(s.files)}`);
    if (s.fromVendor != null) parts.push(`взято из новой поставки: ${formatNumber(s.fromVendor)}`);
    if (s.autoResolved) parts.push(`спорных мест разобрано само: ${formatNumber(s.autoResolved)}`);
    if (s.addedByVendor) parts.push(`новых объектов: ${formatNumber(s.addedByVendor)}`);
    if (s.removedByVendor) parts.push(`удалено: ${formatNumber(s.removedByVendor)}`);
    parts.push(s.conflicted
      ? `<b style="color:var(--warn)">требует решения: ${formatNumber(s.conflicted)}</b>`
      : '<b style="color:var(--good)">ручной работы не осталось</b>');
    if (s.mode === 'restored') parts.push('поставка восстановлена из базы');
    if (s.mode === 'keys') parts.push('сокращённый режим: без текущей поставки');
    if (s.dbUpdated) parts.push('<b style="color:var(--good)">конфигурация базы данных обновлена</b>');
    if (s.checkErrors) parts.push(`<b style="color:var(--warn)">замечаний платформы: ${formatNumber(s.checkErrors)}</b>`);

    box.innerHTML = parts.join(' · ');
    box.hidden = false;

    const loadBtn = $('#uLoadBtn');
    loadBtn.textContent = s.loaded ? 'Загрузить в конфигурацию заново' : 'Загрузить в конфигурацию';
    if (state.left > 0) {
      setSaveNote(
        `Запись в информационную базу не предлагается: спорных мест, требующих решения, ${formatNumber(state.left)}. `
        + 'Откройте «Разобрать спорные места» — там видно, что программа объединила сама, '
        + 'а что осталось вам, и там же правится и сохраняется результат.',
        true,
      );
    } else if (s.loaded) {
      setSaveNote('Результат уже загружен в основную конфигурацию базы.');
    }
  } catch {
    state.timer.finish(null);
    box.hidden = true;
  }
}

function onCancelled(message, durationMs) {
  setBusy(false);
  setRunning(false);
  state.cancelling = false;
  const ms = state.timer.finish(durationMs);

  $('#uProgressTitle').textContent = 'Объединение прервано';
  $('#uProgressSub').textContent = ms != null
    ? `Остановлено пользователем через ${formatDuration(ms)}`
    : 'Остановлено пользователем';
  $('#uResultActions').hidden = true;

  const box = $('#uErrorBox');
  box.hidden = false;
  box.textContent = `${message || 'Объединение прервано пользователем'} `
    + 'Файлы выгрузки остались в промежуточном состоянии — в конфигурацию их загружать нельзя, '
    + 'запустите объединение заново.';
  state.currentId = null;
}

function onFailed(message) {
  setBusy(false);
  setRunning(false);
  state.cancelling = false;
  state.timer.finish(null);

  $('#uProgressTitle').textContent = 'Объединение не выполнено';
  $('#uProgressSub').textContent = 'См. описание ошибки ниже';
  $('#uResultActions').hidden = true;

  const box = $('#uErrorBox');
  box.hidden = false;
  box.textContent = message || 'Неизвестная ошибка';
  state.currentId = null;
}

// ------------------------------------------------- Загрузка в конфигурацию

/**
 * Загрузка объединённой выгрузки в основную конфигурацию базы.
 *
 * Отдельной кнопкой, потому что это основной порядок работы: сначала человек
 * разбирает дважды изменённые места прямо в файлах выгрузки, и только потом
 * загружает результат — иногда не в тот же день. Подтверждение обязательно:
 * это единственное действие продукта, меняющее информационную базу.
 */
async function loadIntoBase() {
  if (!state.currentId) return;
  if (!confirm(
    'Загрузить объединённую выгрузку в ОСНОВНУЮ конфигурацию базы?\n\n'
    + 'Следом будет выполнено обновление конфигурации базы данных — это реструктуризация\n'
    + 'таблиц, платформа может предупредить о потере данных.\n'
    + 'Базе понадобится монопольный доступ: закройте все сеансы 1С.\n\n'
    + 'Резервная копия базы должна быть сделана заранее. Продолжить?',
  )) return;

  const btn = $('#uLoadBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Загрузка…';
  setSaveNote('Конфигуратор загружает файлы, это может занять несколько минут…');
  try {
    const result = await api.loadUpdate(state.currentId, {
      user: $('#uUser').value.trim(),
      password: $('#uPassword').value,
    });
    setSaveNote(
      `Загружено в основную конфигурацию ${formatDateTime(result.loadedAt)}. `
      + (result.dbUpdated
        ? 'Конфигурация базы данных обновлена.'
        : `Конфигурация базы данных НЕ обновлена${result.dbUpdateError ? `: ${result.dbUpdateError}` : ''}.`),
      !result.dbUpdated,
    );
    loadHistory();
  } catch (err) {
    setSaveNote(`Загрузить не удалось: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * «Скачать отчёт…» — с вопросом, куда именно.
 *
 * Диалог сохранения показывает сервер: браузер положил бы файл в свою папку
 * загрузок под именем `report.html`. Сохранённый отчёт самодостаточен —
 * ни одной ссылки на работающую программу в нём нет.
 */
async function saveReportAs() {
  if (!state.currentId) return;
  const btn = $('#uSaveReport');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Сохранение…';
  try {
    const result = await api.saveUpdateReport(state.currentId);
    setSaveNote(result.cancelled ? '' : `Отчёт сохранён: ${result.path}`);
  } catch (err) {
    setSaveNote(`Не удалось сохранить: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function setSaveNote(text, isError = false) {
  const box = $('#uSaveNote');
  box.textContent = text;
  box.classList.toggle('is-error', isError);
  box.hidden = !text;
}

// ------------------------------------------------------------------ История

async function loadHistory() {
  const container = $('#uHistoryList');
  container.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const { items } = await api.listUpdates();
    if (!state.restored && items[0]?.input) {
      state.restored = true;
      restoreInput(UPDATE_FIELDS, items[0].input);
    }
    if (!items.length) {
      container.innerHTML = '<div class="empty">Объединения ещё не выполнялись.</div>';
      return;
    }
    container.innerHTML = items.map(renderHistoryItem).join('');

    // Отчёт открывает сервер — в браузере по умолчанию, а не ещё одним окном
    // приложения без адресной строки.
    $$('[data-open]', container).forEach((btn) => {
      btn.addEventListener('click', () => openReportInBrowser(
        btn, () => api.openUpdateReport(btn.dataset.open),
      ));
    });

    // Разбор спорных мест доступен и из истории: объединение делают в один
    // день, а разбирают спорные места нередко в другой.
    $$('[data-review]', container).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.currentId = btn.dataset.review;
        switchView('merge');
      });
    });

    $$('[data-delete]', container).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить запись об этом объединении? Файлы выгрузки останутся на диске.')) return;
        await api.deleteUpdate(btn.dataset.delete);
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

  const versions = [s.baseVersion, s.targetVersion].filter(Boolean).join(' → ');

  return `
  <div class="hist-item">
    <div class="hist-main">
      <div class="hist-title">
        ${escapeHtml(s.mainConfig || meta.input?.infobasePath || 'Объединение')}
        ${versions ? `<span class="hist-meta">${escapeHtml(versions)}</span>` : ''}
      </div>
      <div class="hist-meta">
        <span class="status-pill is-${meta.status}">${statusRu}</span>
        · ${formatDateTime(meta.createdAt)}
        ${meta.durationMs ? ` · время: ${formatDuration(meta.durationMs)}` : ''}
        ${s.updateMode === 'typical' ? ' · типовое обновление платформой' : ''}
        ${s.updateMode !== 'typical' && s.files != null ? ` · файлов: ${formatNumber(s.files)}` : ''}
        ${s.updateMode !== 'typical' && s.conflicted != null ? ` · требует решения: ${formatNumber(s.conflicted)}` : ''}
        ${s.mode === 'restored' ? ' · поставка восстановлена из базы' : ''}
        ${s.mode === 'keys' ? ' · сокращённый режим' : ''}
        ${s.dbUpdated ? ' · <b>база данных обновлена</b>' : ''}
        ${meta.loadedAt ? ' · <b>загружено в конфигурацию</b>' : ''}
      </div>
      ${meta.error ? `<div class="hist-meta" style="color:var(--danger)">${escapeHtml(meta.error)}</div>` : ''}
      ${meta.loadError ? `<div class="hist-meta" style="color:var(--danger)">Загрузка: ${escapeHtml(meta.loadError)}</div>` : ''}
      ${s.mergedDir ? `<div class="hist-meta"><span class="mono">${escapeHtml(s.mergedDir)}</span></div>` : ''}
    </div>

    ${meta.status === 'done' && s.updateMode !== 'typical' ? `
    <div class="hist-scores">
      <div class="hist-score">
        <div class="hist-score__val ${s.conflicted ? 'grade-warn' : 'grade-good'}">${formatNumber(s.conflicted || 0)}</div>
        <div class="hist-score__lbl">Решить руками</div>
      </div>
      <div class="hist-score">
        <div class="hist-score__val">${formatNumber(s.fromVendor || 0)}</div>
        <div class="hist-score__lbl">Из поставки</div>
      </div>
    </div>` : ''}

    <div class="hist-actions">
      ${meta.status === 'done'
    ? `<button class="btn" type="button" data-open="${meta.id}">Отчёт</button>`
    : ''}
      ${meta.status === 'done' && s.updateMode !== 'typical'
    ? `<button class="btn${s.conflicted ? ' btn--primary' : ''}" type="button" data-review="${meta.id}">Спорные места</button>`
    : ''}
      <button class="btn btn--danger" data-delete="${meta.id}">Удалить</button>
    </div>
  </div>`;
}
