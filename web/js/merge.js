/**
 * Окно разбора спорных мест — повторение окна объединения конфигуратора.
 *
 * Раскладка та же, что у платформы: дерево слева, две исходные версии сверху,
 * результат снизу и правится прямо здесь. Разработчик, который обновляет
 * конфигурацию, читает такое окно не задумываясь, и придумывать своё
 * расположение значило бы заставить его учиться заново.
 *
 * Отличие от конфигуратора одно, и оно главное: дважды изменённые места,
 * которые программа разобрала сама, УЖЕ разобраны и помечены значком
 * «шестерёнка с галочкой». Человеку остаётся то, где решение может принять
 * только он, — и пока такие места есть, загрузка в информационную базу
 * не предлагается и сервером не выполняется.
 *
 * Почему подсветка кода здесь своя, а не из отчёта. Отчёт собирается
 * на сервере строкой HTML; здесь текст живёт в поле ввода, которое человек
 * правит, и раскрашивать его на лету значило бы писать редактор кода. Вместо
 * этого раскрашены только ЧИТАЕМЫЕ колонки, а поле результата остаётся
 * обычным моноширинным текстом — таким же, каким оно попадёт в файл.
 */

import { api } from './api.js';
import { $, $$, escapeHtml, formatNumber } from './ui.js';

const state = {
  updateId: null,
  /** Дерево, как его отдал сервер. */
  review: null,
  /** Открытый файл целиком: три версии, автоматический результат, текущий текст. */
  file: null,
  /** Что показывать в дереве: `all` | `manual` | `auto`. */
  filter: 'all',
  /** Какая версия в правой колонке: `theirs` (новая поставка) либо `base`. */
  side: 'theirs',
  /** Текст в поле результата на момент загрузки — по нему видно, правил ли человек. */
  loadedText: '',
  /** Куда возвращаться по кнопке «Назад к обновлению». */
  back: null,
};

export function initMerge(onBack) {
  state.back = onBack;

  $$('#mgWork .mgw__filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter;
      $$('#mgWork .mgw__filters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderTree();
    });
  });

  $$('#mgWork [data-side]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.side = chip.dataset.side;
      $$('#mgWork [data-side]').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderRight();
    });
  });

  $('#mgSave').addEventListener('click', () => decide('save'));
  $('#mgAccept').addEventListener('click', () => decide('accept'));
  $('#mgRevert').addEventListener('click', () => decide('revert'));
}

/** Открыть окно для прогона. Вызывается при переходе на страницу. */
export async function openMerge(updateId) {
  if (!updateId) return;
  const changed = state.updateId !== updateId;
  state.updateId = updateId;
  if (changed) {
    state.file = null;
    state.filter = 'all';
  }
  await loadReview();
}

/** Сколько мест ещё ждут решения. Нужно разделу обновления для кнопок. */
export function reviewLeft() {
  return state.review?.totals?.left ?? null;
}

// --------------------------------------------------------------- Дерево

async function loadReview() {
  const error = $('#mgError');
  error.hidden = true;
  try {
    state.review = await api.updateReview(state.updateId);
  } catch (err) {
    $('#mgWork').hidden = true;
    $('#mgLead').textContent = 'Спорные места не прочитаны.';
    error.hidden = false;
    error.textContent = err.message;
    return;
  }

  const t = state.review.totals;
  $('#mgWork').hidden = false;
  $('#mgLead').innerHTML = lead(t);
  renderTree();

  if (state.file) await openFile(state.file.rel);
}

function lead(t) {
  const parts = [];
  parts.push(t.auto
    ? `<b>Программа объединила сама: ${formatNumber(t.auto)}</b>`
    : 'Объединять самой было нечего');
  parts.push(t.left
    ? `<b style="color:var(--warn)">ждут вашего решения: ${formatNumber(t.left)}</b>`
    : '<b style="color:var(--good)">неразобранных мест не осталось</b>');
  if (t.decided) parts.push(`разобрано вами: ${formatNumber(t.decided)}`);
  const tail = state.review.dumpAlive
    ? ''
    : ' · <b style="color:var(--danger)">каталог выгрузки удалён — править нечего</b>';
  return parts.join(' · ') + tail;
}

function renderTree() {
  const box = $('#mgTree');
  const objects = (state.review?.objects || [])
    .map((object) => ({ ...object, files: object.files.filter(matchesFilter) }))
    .filter((object) => object.files.length);

  if (!objects.length) {
    box.innerHTML = '<div class="empty">Спорных мест этого рода нет.</div>';
    return;
  }

  box.innerHTML = objects.map(renderObject).join('');

  $$('[data-rel]', box).forEach((node) => {
    node.addEventListener('click', () => openFile(node.dataset.rel));
  });
}

function matchesFilter(file) {
  if (state.filter === 'manual') return file.status === 'manual';
  if (state.filter === 'auto') return file.status === 'auto';
  return true;
}

function renderObject(object) {
  const left = object.files.filter((f) => f.status === 'manual' && !f.decision).length;
  return `
  <details class="mgt" ${left ? 'open' : ''}>
    <summary>
      <span class="mgt__title">${escapeHtml(object.title || object.key)}</span>
      <span class="mgt__stat">${object.files.length}</span>
    </summary>
    <div class="mgt__body">
      ${object.files.map(renderFile).join('')}
    </div>
  </details>`;
}

function renderFile(file) {
  const mark = fileMark(file);
  const active = state.file?.rel === file.rel ? ' is-active' : '';
  const count = file.status === 'manual'
    ? file.conflictCount || 0
    : file.resolvedCount || 0;
  return `
  <button class="mgt__file${active}" type="button" data-rel="${escapeHtml(file.rel)}">
    <i class="mgi mgi--${mark}" aria-hidden="true"></i>
    <span class="mgt__file-name">${escapeHtml(file.element || file.rel)}</span>
    ${count ? `<span class="mgt__stat">${formatNumber(count)}</span>` : ''}
  </button>`;
}

/**
 * Значок места. Три состояния, и они не пересекаются: разобрано программой,
 * разобрано человеком, ждёт решения. Значок «шестерёнка с галочкой» у первого —
 * тот же, каким помечает автоматическое решение конфигуратор.
 */
function fileMark(file) {
  if (file.status === 'auto') return 'auto';
  return file.decision ? 'done' : 'manual';
}

// ---------------------------------------------------------------- Файл

async function openFile(rel) {
  setNote('');
  try {
    state.file = await api.updateReviewFile(state.updateId, rel);
  } catch (err) {
    setNote(err.message, true);
    return;
  }

  const file = state.file;
  $('#mgEmpty').hidden = true;
  $('#mgPanes').hidden = false;
  $('#mgResultBox').hidden = false;

  $('#mgFileTitle').innerHTML = `
    <i class="mgi mgi--${fileMark(file)}" aria-hidden="true"></i>
    ${escapeHtml(file.objectTitle || '')} · ${escapeHtml(file.element || '')}`;
  $('#mgFileSub').innerHTML = `
    <span class="mono">${escapeHtml(file.rel)}</span> · ${escapeHtml(file.actionRu || '')}
    ${file.note ? ` · ${escapeHtml(file.note)}` : ''}`;

  renderPlaces(file);
  renderCode('#mgOurs', file.ours);
  renderRight();

  const text = file.current ?? '';
  const box = $('#mgResult');
  box.value = text;
  box.readOnly = !file.editable;
  state.loadedText = text;

  $('#mgResultNote').textContent = resultNote(file);
  $('#mgSave').disabled = !file.editable;
  $('#mgRevert').disabled = file.auto == null;
  renderTree();
}

function resultNote(file) {
  if (!file.editable) {
    return file.current == null
      ? 'файла нет в выгрузке — править нечего'
      : 'двоичный файл: правится только конфигуратором';
  }
  if (file.decision) {
    return file.decision.mode === 'edited' ? 'вы уже правили это место' : 'принято вами как есть';
  }
  return file.status === 'auto'
    ? 'записано программой — проверьте и подтвердите'
    : 'здесь лежит ваша версия: правку поставщика надо перенести самому';
}

function renderRight() {
  const file = state.file;
  if (!file) return;
  const isBase = state.side === 'base';
  $('#mgRightTitle').textContent = isBase ? 'Текущая поставка' : 'Новая поставка';
  renderCode('#mgTheirs', isBase ? file.base : file.theirs);
}

/**
 * Перечень мест внутри файла.
 *
 * У модуля их бывает десяток, и каждое — своя история: где, как разобрано
 * и почему именно так. Щелчок прокручивает обе колонки к нужной строке —
 * это и есть навигация по файлу, номера строк сами по себе не говорят ничего.
 */
function renderPlaces(file) {
  const box = $('#mgPlaces');
  const places = file.places || [];
  if (!places.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = places.map((place, index) => `
    <button class="mgp mgp--${place.kind}" type="button" data-place="${index}">
      <i class="mgi mgi--${place.kind === 'auto' ? 'auto' : 'manual'}" aria-hidden="true"></i>
      <span class="mgp__where">${escapeHtml(place.where || 'участок')}</span>
      ${place.how ? `<span class="mgp__how">${escapeHtml(place.how)}</span>` : ''}
    </button>`).join('');

  $$('[data-place]', box).forEach((btn) => {
    btn.addEventListener('click', () => {
      const place = places[Number(btn.dataset.place)];
      $$('[data-place]', box).forEach((b) => b.classList.toggle('is-active', b === btn));
      scrollCode('#mgOurs', place.oursStartLine);
      scrollCode('#mgTheirs', state.side === 'base' ? place.baseStartLine : place.theirsStartLine);
      showWhy(place);
    });
  });
}

function showWhy(place) {
  if (place.kind === 'auto' && place.why) setNote(`${place.how}: ${place.why}`);
  else setNote('');
}

// ------------------------------------------------------------- Колонки кода

/**
 * Текст с номерами строк. Ровно так же, как в отчёте: номер слева, код справа,
 * без подсветки синтаксиса — колонки читают, сравнивая строки, и раскраска
 * здесь мешала бы видеть, где они расходятся.
 */
function renderCode(selector, text) {
  const box = $(selector);
  if (text == null) {
    box.innerHTML = '<div class="empty">Этой версии нет: файл в ней отсутствовал либо не сохранён.</div>';
    return;
  }
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  box.innerHTML = `<table class="mgc"><tbody>${lines.map((line, i) => `
    <tr id="${box.id}-l${i + 1}"><td class="mgc__n">${i + 1}</td><td class="mgc__t">${escapeHtml(line) || '&nbsp;'}</td></tr>`).join('')}</tbody></table>`;
}

function scrollCode(selector, line) {
  const box = $(selector);
  if (!line) return;
  const row = document.getElementById(`${box.id}-l${line}`);
  if (!row) return;
  $$('tr.is-here', box).forEach((tr) => tr.classList.remove('is-here'));
  row.classList.add('is-here');
  box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 3);
}

// ------------------------------------------------------------- Решение

async function decide(action) {
  const file = state.file;
  if (!file) return;

  if (action === 'revert' && !confirm(
    'Вернуть вариант, записанный программой?\n\nВаши правки этого файла будут потеряны, '
    + 'а место снова станет неразобранным.',
  )) return;

  const buttons = ['#mgSave', '#mgAccept', '#mgRevert'];
  buttons.forEach((id) => { $(id).disabled = true; });
  setNote('Сохранение…');
  try {
    const body = { rel: file.rel, action };
    if (action === 'save') body.text = $('#mgResult').value;
    const answer = await api.updateReviewDecide(state.updateId, body);
    const message = action === 'revert'
      ? 'Возвращён вариант программы — место снова ждёт вашего решения.'
      : (answer.left
        ? `Сохранено. Осталось разобрать: ${formatNumber(answer.left)}.`
        : 'Сохранено. Неразобранных мест не осталось — можно загружать конфигурацию.');
    // Сообщение выставляется ПОСЛЕ перечитывания: оно перерисовывает файл
    // и само сбрасывает подпись, и «Сохранено» иначе гаснет сразу же.
    await loadReview();
    setNote(message);
  } catch (err) {
    setNote(err.message, true);
  } finally {
    buttons.forEach((id) => { $(id).disabled = false; });
    if (state.file) {
      $('#mgSave').disabled = !state.file.editable;
      $('#mgRevert').disabled = state.file.auto == null;
    }
  }
}

function setNote(text, isError = false) {
  const box = $('#mgNote');
  box.textContent = text;
  box.classList.toggle('is-error', isError);
  box.hidden = !text;
}
