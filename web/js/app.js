/**
 * Клиентская логика приложения.
 *
 * Без фреймворков и сборки: приложение должно запускаться копированием каталога,
 * без npm install и без шага сборки.
 */

import { api, subscribeToAudit, keepAlive } from './api.js';
import { initUpdate, showUpdateStages, reloadUpdateHistory } from './update.js';
import { initQuality, showQualityStages } from './quality.js';
import {
  $, $$, escapeHtml, setNote, renderStages as renderStageList,
  formatDuration, formatNumber, formatDateTime, attachPathHint,
} from './ui.js';

const state = {
  environment: null,
  currentAuditId: null,
  unsubscribe: null,
  /** Момент запуска текущего аудита — для секундомера на карточке прогресса. */
  startedAt: null,
  timer: null,
  cancelling: false,
};

/** Ссылки внизу карточки прогресса: доступны только по готовому отчёту. */
const RESULT_LINKS = [
  { id: 'openReport', file: 'report.html' },
  { id: 'downloadMd', file: 'report.md' },
  { id: 'downloadJson', file: 'result' },
];

// ---------------------------------------------------------------- Навигация

/**
 * Разделы главного окна.
 *
 * Раздел — это рабочий режим, а не вкладка: у каждого своя главная страница
 * и своя история (список аудитов и список объединений — разные вещи).
 * Шапка внутри раздела повторяет его название и держит рядом только то,
 * что к нему относится.
 */
const SECTIONS = {
  audit: {
    title: 'Обследование информационной базы',
    main: 'new',
    history: 'history',
  },
  update: {
    title: 'Обновление конфигурации',
    main: 'update',
    history: 'update-history',
  },
  // У проверки качества истории нет: её результат — отчёт, который открывается
  // сразу, а держать третий список прогонов пользователь не просил.
  quality: {
    title: 'Проверка качества кода',
    main: 'quality',
    history: null,
  },
};

/** Какому разделу принадлежит страница. `about` наследует текущий раздел. */
const VIEW_SECTION = {
  new: 'audit',
  history: 'audit',
  update: 'update',
  'update-history': 'update',
  quality: 'quality',
};

/** Раздел, в котором мы находимся: нужен, чтобы «О программе» не сбрасывала шапку. */
let currentSection = null;

function initTabs() {
  $('#homeBtn').addEventListener('click', () => switchView('home'));
  $$('.mode[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.goto));
  });
  $('#navSection').addEventListener('click', () => {
    if (currentSection) switchView(SECTIONS[currentSection].main);
  });
  $('#navHistory').addEventListener('click', () => {
    if (currentSection) switchView(SECTIONS[currentSection].history);
  });
  $$('.tab[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
}

/**
 * Прокрутка каждой страницы — своя и запоминается.
 *
 * Страницы переключаются подменой класса, документ при этом один, и его
 * прокрутка общая: уходя в «Историю» и возвращаясь, пользователь оказывался
 * в начале формы, потеряв место, где заполнял. Храним позицию на уходе
 * и возвращаем на входе — по странице, а не одним значением на всех.
 */
const scrollByView = new Map();

function currentView() {
  return document.querySelector('.view.is-active')?.dataset.view || null;
}

function switchView(name) {
  const previous = currentView();
  if (previous === name) return;
  if (previous) scrollByView.set(previous, window.scrollY);

  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  if (name === 'history') loadHistory();
  if (name === 'update-history') reloadUpdateHistory();
  if (name === 'about') loadAbout();

  renderTopNav(name);

  // Без rAF: window.scrollTo сам вынуждает браузер пересчитать раскладку,
  // чтобы понять, куда можно прокрутить, — того же эффекта, что дал бы кадр
  // ожидания, но без риска не сработать, если вкладка окна в этот момент
  // в фоне: там requestAnimationFrame браузер приостанавливает вовсе.
  window.scrollTo(0, scrollByView.get(name) ?? 0);
}

/** Шапка раздела: название открытого режима, его история и «О программе». */
function renderTopNav(view) {
  if (view === 'home') currentSection = null;
  else if (VIEW_SECTION[view]) currentSection = VIEW_SECTION[view];

  const section = currentSection ? SECTIONS[currentSection] : null;
  const sectionBtn = $('#navSection');
  const historyBtn = $('#navHistory');

  sectionBtn.hidden = !section;
  // У раздела может не быть истории — тогда и кнопки быть не должно: иначе
  // она вела бы в никуда.
  historyBtn.hidden = !section?.history;
  // «О программе» — только на главной. Внутри раздела шапка говорит о работе,
  // которая идёт: название режима и его история. Требование пользователя.
  $$('.tab--about').forEach((t) => { t.hidden = Boolean(section); });
  if (!section) return;

  sectionBtn.textContent = section.title;
  sectionBtn.classList.toggle('is-active', view === section.main);
  historyBtn.classList.toggle('is-active', view === section.history);
  $$('.tab--about').forEach((t) => t.classList.toggle('is-active', view === 'about'));
}

// ------------------------------------------------------------- О программе

/**
 * README прямо в интерфейсе.
 *
 * Открывать файл сторонней программой нельзя: приложение должно работать
 * копированием каталога, и чем его откроют — неизвестно. Разметку готовит
 * сервер тем же преобразователем, что и отчёт; здесь остаётся вставить её
 * и запомнить, что уже загружено.
 */
let aboutLoaded = false;

async function loadAbout() {
  if (aboutLoaded) return;
  const box = $('#aboutBody');
  try {
    const { html } = await api.about();
    box.innerHTML = html;
    aboutLoaded = true;
  } catch (err) {
    box.innerHTML = `<div class="empty">Не удалось прочитать README: ${escapeHtml(err.message)}</div>`;
  }
}

// ------------------------------------------------------------- Окружение

async function loadEnvironment() {
  try {
    const env = await api.environment();
    state.environment = env;

    fillPlatformLists(env.platforms);

    // Про движок рекомендаций сказано в заголовке приложения — здесь только
    // то, что зависит от машины: какие платформы 1С установлены.
    // «Версии платформы», а не «Платформа 1С»: дальше идёт перечень через
    // запятую, и в единственном числе подпись противоречила бы содержимому.
    $('#envSummary').textContent = env.platforms.length
      ? `Версии платформы: ${env.platforms.map((p) => p.version).join(', ')}`
      : 'Платформа 1С не найдена';

    if (env.version) $('#appVersion').textContent = `версия ${env.version}`;

    if (!env.platforms.length) {
      setNote('#formNote', 'Не найдено установленных версий платформы 1С:Предприятие. Аудит невозможен.', true);
      $('#startBtn').disabled = true;
    }
    if (!env.isWindows) {
      setNote('#formNote', 'Подсчёт записей через COM доступен только под Windows.', false);
    }
    if (!env.canPickPaths) {
      $$('.btn--pick').forEach((btn) => { btn.hidden = true; });
    }

    renderStages(env.stages.map((s) => ({ ...s, status: 'pending', detail: '', note: '' })));
    if (env.updateStages?.length) showUpdateStages(env.updateStages);
    if (env.qualityStages?.length) showQualityStages(env.qualityStages);
  } catch (err) {
    $('#envSummary').textContent = `Ошибка проверки окружения: ${err.message}`;
  }
}

/**
 * Список версий платформы — обычный <select>.
 *
 * Раньше использовался <input list=datalist>: браузер фильтрует подсказки по
 * набранному тексту, поэтому после выбора версии в списке оставалась она одна.
 * Набор установленных платформ закрытый, свободный ввод не нужен.
 *
 * Список заполняется во ВСЕХ разделах разом (по атрибуту `data-platform-list`):
 * форм с выбором платформы теперь две, и вторая молча оставалась бы пустой.
 */
function fillPlatformLists(platforms) {
  const options = ['<option value="">Новейшая установленная</option>'];
  platforms.forEach((p, index) => {
    const suffix = index === 0 ? ' — новейшая' : '';
    options.push(`<option value="${escapeHtml(p.version)}">${escapeHtml(p.version)}${suffix}</option>`);
  });
  $$('select[data-platform-list]').forEach((select) => {
    select.innerHTML = options.join('');
  });
}

// ------------------------------------------------- Выбор файла и каталога

/**
 * Диалог выбора показывает сервер: браузер отдаёт странице только имя файла,
 * а конвейеру нужен полный путь. Сервер работает на этой же машине.
 */
function initPickers() {
  $$('.btn--pick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = $(`#${btn.dataset.target}`);
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Выбор…';
      try {
        const { path } = await api.pickPath({
          mode: btn.dataset.pick,
          title: btn.dataset.title || '',
          filter: btn.dataset.filter || '',
          initial: target.value.trim(),
        });
        if (path) {
          target.value = path;
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (err) {
        setNote('#formNote', err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });
}

// ------------------------------------------------------------ Запуск аудита

function initForm() {
  $('#auditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.currentAuditId && state.timer) return;

    const input = {
      infobasePath: $('#infobasePath').value.trim(),
      platformVersion: $('#platformVersion').value.trim(),
      vendorConfigPath: $('#vendorConfigPath').value.trim(),
      clientName: $('#clientName').value.trim(),
      user: $('#user').value.trim(),
      password: $('#password').value,
      workDir: $('#workDir').value.trim(),
      hourlyRate: Number($('#hourlyRate').value) || 0,
      reportTheme: $('#reportTheme').value,
      collectLiveData: $('#collectLiveData').checked,
      keepDump: $('#keepDump').checked,
      analyzeVendorCode: $('#analyzeVendorCode').checked,
    };

    if (!input.infobasePath) {
      setNote('#formNote', 'Укажите путь к информационной базе', true);
      return;
    }
    // Каталог выгрузки обязателен намеренно: во временном каталоге невозможно
    // проверить, убралось ли за аудитом, а выгрузка ERP — это гигабайты.
    if (!input.workDir) {
      setNote('#formNote', 'Укажите каталог для выгрузки конфигурации', true);
      $('#workDir').focus();
      return;
    }

    setNote('#formNote', '');
    setBusy(true);

    try {
      const { auditId } = await api.startAudit(input);
      state.currentAuditId = auditId;
      showProgressCard(auditId);
      attachStream(auditId);
    } catch (err) {
      setNote('#formNote', err.message, true);
      setBusy(false);
      stopTimer();
      setResultActionsEnabled(false);
      setRunning(false);
    }
  });

  $('#cancelBtn').addEventListener('click', async () => {
    if (!state.currentAuditId || state.cancelling) return;
    if (!confirm('Прервать выполняющийся аудит? Отчёт сформирован не будет.')) return;

    state.cancelling = true;
    const btn = $('#cancelBtn');
    btn.disabled = true;
    btn.textContent = 'Прерывание…';
    try {
      await api.cancelAudit(state.currentAuditId);
      $('#progressSub').textContent = 'Останавливаем выполнение…';
    } catch (err) {
      state.cancelling = false;
      btn.disabled = false;
      btn.textContent = 'Прервать';
      setNote('#formNote', err.message, true);
    }
  });

  $('#restartBtn').addEventListener('click', () => restartAudit());

  $('#printReport').addEventListener('click', () => {
    if (!state.currentAuditId) return;
    const win = window.open(`api/audits/${state.currentAuditId}/report.html`, '_blank');
    if (win) win.addEventListener('load', () => win.print());
  });

  $('#saveReport').addEventListener('click', () => saveReportAs());
}

/**
 * «Скачать отчёт…» — с вопросом, куда именно.
 *
 * Диалог сохранения показывает сервер: браузер положил бы файл в свою папку
 * загрузок под именем `report.html`, без выбора места и без внятного имени.
 * Имя составляет сервер — по организации, конфигурации и дате.
 */
async function saveReportAs() {
  if (!state.currentAuditId) return;
  const btn = $('#saveReport');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Сохранение…';
  try {
    const result = await api.saveReport(state.currentAuditId);
    setSaveNote(result.cancelled ? '' : `Отчёт сохранён: ${result.path}`);
  } catch (err) {
    setSaveNote(`Не удалось сохранить: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function setSaveNote(text, isError = false) {
  const box = $('#saveNote');
  box.textContent = text;
  box.classList.toggle('is-error', isError);
  box.hidden = !text;
}

function setBusy(busy) {
  const btn = $('#startBtn');
  btn.disabled = busy;
  btn.querySelector('span').textContent = busy ? 'Аудит выполняется…' : 'Запустить аудит';
  setFormEnabled(!busy);
}

/**
 * Блокировка формы на время аудита — требование пользователя.
 *
 * Правка полей во время выполнения ни на что уже не влияла: конвейер получил
 * параметры при старте. Но выглядело это так, будто влияет, и после аудита
 * в форме оказывалось не то, чем он запускался. Блокируется всё, что задаёт
 * запуск: поля, списки, флажки и кнопки выбора пути.
 */
function setFormEnabled(enabled) {
  const form = $('#auditForm');
  form.classList.toggle('is-locked', !enabled);
  $$('input, select, button', form).forEach((el) => {
    // Кнопка запуска гасится отдельно (setBusy): у неё своя подпись.
    if (el.id === 'startBtn') return;
    el.disabled = !enabled;
  });
}

/**
 * Повторный запуск после прерывания.
 *
 * Каталог выгрузки обязательно очищается: `ibcmd` не пишет в непустой каталог,
 * а после прерывания там лежит незавершённая выгрузка. Но каталог задаёт
 * пользователь, и удалять из него что-либо молча нельзя — сначала показываем,
 * что именно исчезнет, и особо предупреждаем о посторонних файлах.
 */
async function restartAudit() {
  const workDir = $('#workDir').value.trim();

  let info;
  try {
    info = await api.inspectWorkDir(workDir);
  } catch (err) {
    setNote('#formNote', err.message, true);
    return;
  }

  if (info.exists && info.total > 0) {
    const lines = info.entries.slice(0, 12)
      .map((e) => `  ${e.isDir ? '[папка]' : '[файл] '} ${e.name} — ${e.sizeText}${e.own ? '' : '   ← не создано аудитом'}`)
      .join('\n');

    const tail = info.total > 12 ? `\n  …и ещё ${info.total - 12}` : '';
    const warning = info.foreignCount > 0
      ? `\n\nВНИМАНИЕ: ${info.foreignCount} из ${info.total} элементов аудит не создавал. Они тоже будут удалены.`
      : '';

    const ok = confirm(
      `Повторный запуск удалит ВСЁ содержимое каталога:\n${info.dir}\n\n` +
      `Будет удалено ${info.total} элементов, всего ${info.sizeText}:\n${lines}${tail}` +
      `${warning}\n\nПродолжить?`,
    );
    if (!ok) return;

    try {
      setNote('#formNote', 'Очистка каталога выгрузки…');
      const cleared = await api.clearWorkDir(workDir);
      setNote('#formNote', `Каталог очищен: удалено элементов ${cleared.removed}`);
    } catch (err) {
      setNote('#formNote', `Не удалось очистить каталог: ${err.message}`, true);
      return;
    }
  }

  $('#restartBtn').hidden = true;
  $('#auditForm').requestSubmit();
}

/**
 * Ссылки на результат.
 *
 * Пока отчёта нет, строка не показывается вовсе. Раньше кнопки висели
 * неактивными с самого начала — выглядело как сломанный интерфейс,
 * и было непонятно, ждать их или нет.
 */
function setResultActionsEnabled(enabled, auditId = null) {
  const box = $('#resultActions');
  box.hidden = !enabled;
  setSaveNote('');
  if (!enabled) return;

  for (const link of RESULT_LINKS) {
    $(`#${link.id}`).href = `api/audits/${auditId}/${link.file}`;
  }
}

/**
 * Кнопки управления прогоном.
 *
 * Во время выполнения доступно только «Прервать»: «Запустить заново» в этот
 * момент означало второй аудит поверх первого — с тем же каталогом выгрузки,
 * куда `ibcmd` не пишет.
 */
function setRunning(running) {
  const cancel = $('#cancelBtn');
  cancel.disabled = !running;
  cancel.textContent = 'Прервать';
  $('#restartBtn').hidden = running;
}

function showProgressCard(auditId) {
  const card = $('#progressCard');
  card.hidden = false;
  $('#errorBox').hidden = true;
  $('#runStats').hidden = true;
  $('#progressTitle').textContent = 'Выполняется аудит';
  $('#progressSub').textContent = `Идентификатор: ${auditId}`;
  $('#progressPercent').textContent = '0%';
  $('#progressBar').style.width = '0%';

  setResultActionsEnabled(false);
  state.cancelling = false;
  setRunning(true);

  startTimer();
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ------------------------------------------------------------- Секундомер

function startTimer() {
  stopTimer();
  state.startedAt = Date.now();
  $('#progressTimer').textContent = '0 с';
  $('#progressTimer').hidden = false;
  state.timer = setInterval(() => {
    $('#progressTimer').textContent = formatDuration(Date.now() - state.startedAt);
  }, 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Показывает итоговую длительность: сервер знает её точно. */
function showFinalDuration(durationMs) {
  stopTimer();
  const ms = durationMs ?? (state.startedAt ? Date.now() - state.startedAt : null);
  if (ms != null) $('#progressTimer').textContent = formatDuration(ms);
  return ms;
}

// --------------------------------------------------------------- Поток событий

function attachStream(auditId) {
  state.unsubscribe?.();
  state.unsubscribe = subscribeToAudit(auditId, {
    onUpdate: (payload) => {
      const snapshot = payload.snapshot || payload;
      if (snapshot.stages) applySnapshot(snapshot);
    },
    onFinish: () => onAuditFinished(auditId),
    onCancelled: (message, durationMs) => onAuditCancelled(message, durationMs),
    onError: (message) => onAuditFailed(message),
  });
}

function applySnapshot(snapshot) {
  const percent = snapshot.percent ?? 0;
  $('#progressPercent').textContent = `${percent}%`;
  $('#progressBar').style.width = `${percent}%`;

  if (snapshot.stages?.length) renderStages(snapshot.stages);

  const running = snapshot.stages?.find((s) => s.status === 'running');
  if (running && !state.cancelling) {
    $('#progressSub').textContent = running.detail
      ? `${running.title}: ${running.detail}`
      : running.title;
  }
}

function renderStages(stages) {
  renderStageList($('#stages'), stages);
}

async function onAuditFinished(auditId) {
  setBusy(false);
  state.currentAuditId = auditId;
  $('#progressTitle').textContent = 'Аудит завершён';
  $('#progressSub').textContent = 'Отчёт готов';
  $('#progressPercent').textContent = '100%';
  $('#progressBar').style.width = '100%';

  setRunning(false);
  setResultActionsEnabled(true, auditId);

  // Отчёт открывается сам — ради него всё и запускалось.
  //
  // Открывает его сервер, а не страница: `window.open` здесь вызывается
  // не по нажатию кнопки, а по событию из потока, и браузер блокирует такое
  // окно как всплывающее. Сбой открытия аудит не портит — кнопка «Открыть
  // отчёт» рядом, поэтому просто пишем причину в строку состояния.
  try {
    await api.openReport(auditId);
  } catch (err) {
    setSaveNote(`Отчёт готов, но окно не открылось: ${err.message}. Нажмите «Открыть отчёт».`, true);
  }

  await showRunStats(auditId);
}

/**
 * Итоги прогона: длительность анализа и объём проверенного.
 * В отчёт для заказчика эти сведения намеренно не попадают — это внутренняя
 * характеристика работы инструмента.
 */
async function showRunStats(auditId) {
  const box = $('#runStats');
  try {
    const meta = await api.audit(auditId);
    const s = meta.summary || {};
    const parts = [];

    const durationMs = showFinalDuration(meta.durationMs);
    if (durationMs != null) parts.push(`<b>Время анализа:</b> ${formatDuration(durationMs)}`);
    if (s.objectCount) parts.push(`объектов метаданных: ${formatNumber(s.objectCount)}`);
    if (s.analyzedModules != null && s.totalModules != null) {
      parts.push(s.vendorCompared
        ? `проверено модулей: ${formatNumber(s.analyzedModules)} из ${formatNumber(s.totalModules)} (только доработки)`
        : `проверено модулей: ${formatNumber(s.analyzedModules)}`);
    }
    if (s.findingsCount != null) parts.push(`замечаний: ${formatNumber(s.findingsCount)}`);
    if (s.totalRecords != null) parts.push(`записей в базе: ${formatNumber(s.totalRecords)}`);

    box.innerHTML = parts.join(' · ');
    box.hidden = parts.length === 0;
  } catch {
    showFinalDuration(null);
    box.hidden = true;
  }
}

function onAuditCancelled(message, durationMs) {
  setBusy(false);
  state.cancelling = false;
  const ms = showFinalDuration(durationMs);

  $('#progressTitle').textContent = 'Аудит прерван';
  $('#progressSub').textContent = ms != null
    ? `Остановлено пользователем через ${formatDuration(ms)}`
    : 'Остановлено пользователем';

  // Прерывание состоялось — только теперь появляется «Запустить заново».
  setRunning(false);
  setResultActionsEnabled(false);

  const box = $('#errorBox');
  box.hidden = false;
  box.textContent = message || 'Аудит прерван пользователем';
  state.currentAuditId = null;
}

function onAuditFailed(message) {
  setBusy(false);
  state.cancelling = false;
  const ms = showFinalDuration(null);
  state.currentAuditId = null;

  $('#progressTitle').textContent = 'Аудит не завершён';
  $('#progressSub').textContent = ms != null
    ? `Остановлено на ${formatDuration(ms)}. См. описание ошибки ниже`
    : 'См. описание ошибки ниже';

  // После сбоя перезапуск так же требует чистого каталога.
  setRunning(false);
  setResultActionsEnabled(false);

  const box = $('#errorBox');
  box.hidden = false;
  box.textContent = message || 'Неизвестная ошибка';
}

// --------------------------------------------------------------- История

async function loadHistory() {
  const container = $('#historyList');
  container.innerHTML = '<div class="empty">Загрузка…</div>';

  try {
    const { items } = await api.listAudits();
    if (!items.length) {
      container.innerHTML = '<div class="empty">Аудиты ещё не выполнялись.</div>';
      return;
    }

    container.innerHTML = items.map(renderHistoryItem).join('');

    $$('[data-delete]', container).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить этот аудит вместе с отчётом?')) return;
        await api.deleteAudit(btn.dataset.delete);
        loadHistory();
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="empty">Не удалось загрузить историю: ${escapeHtml(err.message)}</div>`;
  }
}

function renderHistoryItem(meta) {
  const s = meta.summary;
  const statusRu = {
    done: 'Завершён', failed: 'Ошибка', running: 'Выполняется', cancelled: 'Прерван',
  }[meta.status] || meta.status;

  return `
  <div class="hist-item">
    <div class="hist-main">
      <div class="hist-title">
        ${escapeHtml(s?.configName || meta.input?.infobasePath || 'Аудит')}
        ${s?.configVersion ? `<span class="hist-meta">${escapeHtml(s.configVersion)}</span>` : ''}
      </div>
      <div class="hist-meta">
        <span class="status-pill is-${meta.status}">${statusRu}</span>
        ${meta.input?.clientName ? ` · ${escapeHtml(meta.input.clientName)}` : ''}
        · ${formatDateTime(meta.createdAt)}
        ${meta.durationMs ? ` · <b>время анализа: ${formatDuration(meta.durationMs)}</b>` : ''}
        ${s?.objectCount ? ` · объектов: ${formatNumber(s.objectCount)}` : ''}
        ${s?.findingsCount != null ? ` · замечаний: ${formatNumber(s.findingsCount)}` : ''}
        ${s?.vendorCompared ? ' · <b>сравнение с поставщиком</b>' : ''}
      </div>
      ${meta.error ? `<div class="hist-meta" style="color:var(--danger)">${escapeHtml(meta.error)}</div>` : ''}
    </div>

    ${s ? `
    <div class="hist-scores">
      <div class="hist-score">
        <div class="hist-score__val ${gradeClass(s.healthScore)}">${s.healthScore ?? '—'}</div>
        <div class="hist-score__lbl">Состояние</div>
      </div>
      <div class="hist-score">
        <div class="hist-score__val ${gradeClass(s.updatabilityScore)}">${s.updatabilityScore ?? '—'}</div>
        <div class="hist-score__lbl">Обновляемость</div>
      </div>
      <div class="hist-score">
        <div class="hist-score__val">${s.effortHours ?? '—'}</div>
        <div class="hist-score__lbl">Часов</div>
      </div>
    </div>` : ''}

    <div class="hist-actions">
      ${meta.status === 'done'
    ? `<a class="btn" href="api/audits/${meta.id}/report.html" target="_blank" rel="noopener">Отчёт</a>`
    : ''}
      <button class="btn btn--danger" data-delete="${meta.id}">Удалить</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------ Утилиты

/** Цвет оценки: 80+ хорошо, 60+ терпимо, 35+ плохо, ниже — критично. */
function gradeClass(score) {
  if (score == null) return '';
  if (score >= 80) return 'grade-good';
  if (score >= 60) return 'grade-warn';
  if (score >= 35) return 'grade-bad';
  return 'grade-crit';
}

// -------------------------------------------------------- Лицензионный ключ

/**
 * Ворота при открытии окна.
 *
 * Без действующего ключа сервер отвечает 403 на любой запрос к API, поэтому
 * остальную инициализацию начинать бессмысленно: форма аудита под замком
 * выглядела бы работающей, а первая же кнопка отдавала бы ошибку.
 */
async function requireLicense() {
  const gate = $('#licenseGate');
  const form = $('#licenseForm');
  const input = $('#licenseKey');
  const error = $('#licenseError');
  const submit = $('#licenseSubmit');

  try {
    if ((await api.licenseStatus()).active) return true;
  } catch {
    // Сервер не ответил — покажем форму: хуже от этого не будет.
  }

  gate.hidden = false;
  input.focus();

  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key) return;

      submit.disabled = true;
      error.hidden = true;
      try {
        await api.activateLicense(key);
        gate.hidden = true;
        resolve(true);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        input.select();
      } finally {
        submit.disabled = false;
      }
    });
  });
}

// --------------------------------------------------------------- Старт

// Поток «окно открыто» поднимается ДО ключа: закрытие окна должно
// останавливать программу и тогда, когда ключ ещё не введён. Иначе брошенное
// окно с формой ключа оставляло бы висеть работающий сервер, а вместе с ним —
// каталог приложения, который Windows не даёт удалить.
keepAlive();

$('#appCopyright').textContent = `© ${new Date().getFullYear()}`;

requireLicense().then(() => {
  initTabs();
  renderTopNav('home');
  initForm();
  attachPathHint($('#infobasePath'), $('#pathHint'), api.parsePath);
  initPickers();
  // Второй рабочий раздел главного окна. Инициализируется здесь же, после
  // ключа: без действующего ключа сервер отвечает 403 на любой запрос,
  // и его форма выглядела бы работающей, но не работала.
  initUpdate();
  initQuality();
  loadEnvironment();
});
