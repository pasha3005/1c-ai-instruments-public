/**
 * Раздел «Обновление нетиповой конфигурации».
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
import {
  $, $$, escapeHtml, setNote, renderStages, formatDuration, formatNumber,
  formatDateTime, createTimer, attachPathHint,
} from './ui.js';

const state = {
  currentId: null,
  unsubscribe: null,
  cancelling: false,
  running: false,
  timer: null,
};

export function initUpdate() {
  state.timer = createTimer($('#uProgressTimer'));

  attachPathHint($('#uPath'), $('#uPathHint'), api.parsePath);

  $('#updateForm').addEventListener('submit', (event) => {
    event.preventDefault();
    start();
  });

  $('#uCancelBtn').addEventListener('click', () => cancel());
  $('#uLoadBtn').addEventListener('click', () => loadIntoBase());

  loadHistory();
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
    loadBack: $('#uLoadBack').checked,
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

  // Запись в базу — только по осознанному согласию, и галочка на форме
  // достаточным согласием не считается: спрашиваем прямо перед запуском.
  if (input.loadBack && !confirm(
    'Результат объединения будет сразу загружен в ОСНОВНУЮ конфигурацию базы\n'
    + `${input.infobasePath}\n\n`
    + 'Базе понадобится монопольный доступ. Конфигурация базы данных при этом НЕ обновляется —\n'
    + 'это делается вручную в конфигураторе.\n\n'
    + 'Сделайте резервную копию, если её ещё нет. Продолжить?',
  )) return;

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

  const running = snapshot.stages?.find((s) => s.status === 'running');
  if (running && !state.cancelling) {
    $('#uProgressSub').textContent = running.detail
      ? `${running.title}: ${running.detail}`
      : running.title;
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

  $('#uOpenReport').href = `api/updates/${updateId}/report.html`;
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
    if (s.files != null) parts.push(`файлов сверено: ${formatNumber(s.files)}`);
    if (s.fromVendor != null) parts.push(`взято из новой поставки: ${formatNumber(s.fromVendor)}`);
    if (s.addedByVendor) parts.push(`новых объектов: ${formatNumber(s.addedByVendor)}`);
    if (s.removedByVendor) parts.push(`удалено: ${formatNumber(s.removedByVendor)}`);
    parts.push(s.conflicted
      ? `<b style="color:var(--warn)">требует решения: ${formatNumber(s.conflicted)}</b>`
      : '<b style="color:var(--good)">ручной работы не осталось</b>');
    if (s.mode === 'keys') parts.push('сокращённый режим: без текущей поставки');

    box.innerHTML = parts.join(' · ');
    box.hidden = false;

    const loadBtn = $('#uLoadBtn');
    loadBtn.textContent = s.loaded ? 'Загрузить в конфигурацию заново' : 'Загрузить в конфигурацию';
    if (s.loaded) setSaveNote('Результат уже загружен в основную конфигурацию базы.');
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
    + 'Базе понадобится монопольный доступ: закройте все сеансы 1С.\n'
    + 'Конфигурация базы данных не обновляется — это делается вручную в конфигураторе,\n'
    + 'чтобы вы увидели предупреждения платформы о реструктуризации.\n\n'
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
      + 'Осталось открыть конфигуратор и выполнить «Обновить конфигурацию базы данных».',
    );
    loadHistory();
  } catch (err) {
    setSaveNote(`Загрузить не удалось: ${err.message}`, true);
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
    if (!items.length) {
      container.innerHTML = '<div class="empty">Объединения ещё не выполнялись.</div>';
      return;
    }
    container.innerHTML = items.map(renderHistoryItem).join('');

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
        ${s.files != null ? ` · файлов: ${formatNumber(s.files)}` : ''}
        ${s.conflicted != null ? ` · требует решения: ${formatNumber(s.conflicted)}` : ''}
        ${s.mode === 'keys' ? ' · сокращённый режим' : ''}
        ${meta.loadedAt ? ' · <b>загружено в конфигурацию</b>' : ''}
      </div>
      ${meta.error ? `<div class="hist-meta" style="color:var(--danger)">${escapeHtml(meta.error)}</div>` : ''}
      ${meta.loadError ? `<div class="hist-meta" style="color:var(--danger)">Загрузка: ${escapeHtml(meta.loadError)}</div>` : ''}
      ${s.mergedDir ? `<div class="hist-meta"><span class="mono">${escapeHtml(s.mergedDir)}</span></div>` : ''}
    </div>

    ${meta.status === 'done' ? `
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
    ? `<a class="btn" href="api/updates/${meta.id}/report.html" target="_blank" rel="noopener">Отчёт</a>`
    : ''}
      <button class="btn btn--danger" data-delete="${meta.id}">Удалить</button>
    </div>
  </div>`;
}
