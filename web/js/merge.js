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
  /**
   * Какие узлы дерева раскрыты.
   *
   * Хранится здесь, а не в разметке: дерево перерисовывается после каждого
   * выбора файла и каждого решения, и без явного состояния оно схлопывалось
   * прямо под рукой — щёлкнув по файлу, пользователь терял список, из которого
   * выбирал (замечено 26.08.2026).
   */
  open: new Set(),
  /** Отмеченный участок: подсветка и прокрутка колонок. */
  place: -1,
  /** Отложенная перекраска поля результата. */
  paintTimer: null,
  /** Какая группа открыта: `merge` — спорные места, `checks` — ошибки проверок. */
  group: 'merge',
};

/** Насколько большой текст ещё имеет смысл подсвечивать на лету. */
const EDITOR_HIGHLIGHT_LIMIT = 400_000;

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

  $$('#mgWork .mgw__groups .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.group = chip.dataset.group;
      state.file = null;
      state.open = new Set();
      state.touched = new Set();
      $$('#mgWork .mgw__groups .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      $('#mgEmpty').hidden = false;
      $('#mgPanes').hidden = true;
      $('#mgResultBox').hidden = true;
      loadReview();
    });
  });

  $('#mgSkip').addEventListener('click', () => decide('skip'));
  $('#mgBack').addEventListener('click', () => state.back?.());
  initEditor();

  // Колонки прокручиваются вместе — как в окне сравнения конфигуратора.
  linkScroll($('#mgOurs'), $('#mgTheirs'));

  $('#mgSave').addEventListener('click', () => decide('save'));
  $('#mgAccept').addEventListener('click', () => decide('accept'));
  $('#mgRevert').addEventListener('click', () => decide('revert'));
}

/**
 * Какую группу открыть при следующем входе в окно.
 *
 * Нужно разделу обновления: конвейер может стоять и на спорных местах,
 * и на ошибках проверок, и кнопка должна вести именно туда.
 */
export function openMergeGroup(group) {
  const next = group === 'checks' ? 'checks' : 'merge';
  if (state.group === next) return;
  state.group = next;
  state.file = null;
  state.open = new Set();
  state.touched = new Set();
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

  const t = groupData().totals;
  $('#mgWork').hidden = false;
  $('#mgLead').innerHTML = lead(t);

  const back = $('#mgBack');
  const done = t.left === 0 && t.manual > 0;
  back.classList.toggle('btn--primary', done);
  back.textContent = done ? 'Всё разобрано — вернуться к обновлению' : 'К обновлению';

  // Переключатель групп показывает, где сколько осталось: иначе неясно,
  // нужно ли вообще заглядывать во вторую вкладку.
  const counts = {
    merge: state.review?.totals?.left ?? 0,
    checks: state.review?.checks?.totals?.left ?? 0,
  };
  $$('#mgWork .mgw__groups .chip').forEach((chip) => {
    const key = chip.dataset.group;
    const base = key === 'checks' ? 'Ошибки проверок' : 'Объединение';
    chip.textContent = counts[key] ? `${base} (${formatNumber(counts[key])})` : base;
    chip.classList.toggle('is-active', key === state.group);
  });
  renderTree();

  if (state.file) await openFile(state.file.key);
}

function lead(t) {
  const checks = state.group === 'checks';
  const parts = [];
  parts.push(t.auto
    ? `<b>${checks ? 'Исправлено программой' : 'Программа объединила сама'}: ${formatNumber(t.auto)}</b>`
    : (checks ? 'Исправлять самой было нечего' : 'Объединять самой было нечего'));
  parts.push(t.left
    ? `<b style="color:var(--warn)">ждут вашего решения: ${formatNumber(t.left)}</b>`
    : `<b style="color:var(--good)">${checks ? 'неразобранных замечаний не осталось' : 'неразобранных мест не осталось'}</b>`);
  if (t.decided) parts.push(`разобрано вами: ${formatNumber(t.decided)}`);
  const tail = !checks && state.review && !state.review.dumpAlive
    ? ' · <b style="color:var(--danger)">каталог выгрузки удалён — править нечего</b>'
    : '';
  return parts.join(' · ') + tail;
}

/** Данные открытой группы: спорные места объединения либо ошибки проверок. */
function groupData() {
  const empty = { objects: [], totals: { files: 0, manual: 0, auto: 0, decided: 0, left: 0 } };
  if (state.group === 'checks') return state.review?.checks || empty;
  return state.review || empty;
}

function renderTree() {
  const box = $('#mgTree');
  const objects = (groupData().objects || [])
    .map((object) => ({ ...object, files: object.files.filter(matchesFilter) }))
    .filter((object) => object.files.length);

  if (!objects.length) {
    box.innerHTML = state.group === 'checks'
      ? '<div class="empty">Ошибок проверок этого рода нет.</div>'
      : '<div class="empty">Спорных мест этого рода нет.</div>';
    return;
  }

  // Узел с неразобранными местами раскрыт сам — но только пока пользователь
  // не решил иначе: его выбор всегда сильнее нашей догадки.
  for (const object of objects) {
    if (!state.touched?.has(object.key) && object.files.some(needsWork)) state.open.add(object.key);
    if (state.file && object.files.some((f) => fileKey(f) === state.file.key)) {
      state.open.add(object.key);
    }
  }

  box.innerHTML = objects.map(renderObject).join('');

  $$('details[data-key]', box).forEach((node) => {
    node.addEventListener('toggle', () => {
      (state.touched ||= new Set()).add(node.dataset.key);
      if (node.open) state.open.add(node.dataset.key);
      else state.open.delete(node.dataset.key);
    });
  });

  $$('[data-rel]', box).forEach((node) => {
    node.addEventListener('click', () => openFile(node.dataset.rel));
  });
}

function needsWork(file) {
  return file.status === 'manual' && !file.decision;
}

function matchesFilter(file) {
  if (state.filter === 'manual') return file.status === 'manual';
  if (state.filter === 'auto') return file.status === 'auto';
  return true;
}

function renderObject(object) {
  return `
  <details class="mgt" data-key="${escapeHtml(object.key)}" ${state.open.has(object.key) ? 'open' : ''}>
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
  const active = state.file?.key === fileKey(file) ? ' is-active' : '';
  const count = file.status === 'manual'
    ? file.conflictCount || 0
    : file.resolvedCount || 0;
  return `
  <button class="mgt__file${active}" type="button" data-rel="${escapeHtml(fileKey(file))}">
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

/** Чем адресуется место: спорное — путём файла, ошибка проверки — своим кодом. */
function fileKey(file) {
  return state.group === 'checks' ? file.id : file.rel;
}

// ---------------------------------------------------------------- Файл

/**
 * Открыть место: спорное — по пути файла, ошибку проверки — по опознавателю.
 *
 * Дальше всё одинаково, потому что и работа одинакова: увидеть две версии
 * и написать нужную. Различаются подписи колонок и набор кнопок под ними.
 */
async function openFile(key) {
  setNote('');
  try {
    state.file = state.group === 'checks'
      ? await api.updateReviewCheck(state.updateId, key)
      : await api.updateReviewFile(state.updateId, key);
  } catch (err) {
    setNote(err.message, true);
    return;
  }

  const file = state.file;
  file.key = key;
  state.place = -1;
  $('#mgEmpty').hidden = true;
  $('#mgPanes').hidden = false;
  $('#mgResultBox').hidden = false;

  $('#mgFileTitle').innerHTML = `
    <i class="mgi mgi--${fileMark(file)}" aria-hidden="true"></i>
    ${escapeHtml(file.objectTitle || file.title || '')} · ${escapeHtml(file.element || '')}`;
  $('#mgFileSub').innerHTML = state.group === 'checks'
    ? `${file.rel ? `<span class="mono">${escapeHtml(file.rel)}</span> · ` : ''}`
      + `${escapeHtml(file.reason || file.why || '')}`
    : `<span class="mono">${escapeHtml(file.rel)}</span> · ${escapeHtml(file.actionRu || '')}`
      + `${file.note ? ` · ${escapeHtml(file.note)}` : ''}`;

  renderPlaces(file);
  renderRight();

  const text = file.current ?? '';
  const box = $('#mgResult');
  box.value = text;
  box.readOnly = !file.editable;
  state.loadedText = text;
  $('#mgResultHl').textContent = text;
  repaintEditor();

  $('#mgResultNote').textContent = resultNote(file);
  $('#mgSave').disabled = !file.editable;
  $('#mgRevert').hidden = state.group === 'checks';
  $('#mgRevert').disabled = !file.hasAuto;
  $('#mgAccept').hidden = state.group === 'checks';
  $('#mgSkip').hidden = state.group !== 'checks' || file.status !== 'manual';
  renderTree();

  // Первое место открывается сразу: файл открывают ради него, а искать
  // правку глазами в модуле на три тысячи строк — не работа человека.
  if ((file.places || []).length) selectPlace(0);
  else if (file.line) markRange('#mgOurs', { start: file.line, end: file.line });
}

function resultNote(file) {
  if (state.group === 'checks') {
    if (!file.editable) {
      return 'файл этого места не найден — исправьте в конфигураторе либо пропустите';
    }
    if (file.decision) {
      return { edited: 'вы уже правили это место', skipped: 'пропущено вами' }[file.decision.mode]
        || 'принято вами';
    }
    return file.status === 'auto'
      ? 'исправлено программой — проверьте'
      : 'исправьте здесь либо пометьте замечание пропущенным';
  }
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

/**
 * Правая колонка и цвета отличий в обеих.
 *
 * Левая колонка перерисовывается вместе с правой: цвет отличия — свойство
 * ПАРЫ, а не файла. Переключив правую на текущую поставку, человек ждёт
 * увидеть отличия именно от неё.
 */
function renderRight() {
  const file = state.file;
  if (!file) return;

  // У ошибки проверки слева то, что правим (расширение либо модуль базы),
  // справа — код обновлённой конфигурации, ради которого всё и затевалось.
  if (state.group === 'checks') {
    $('#mgOursTitle').textContent = file.kind === 'extension' ? 'Расширение' : 'Модуль конфигурации';
    $('#mgRightTitle').textContent = 'Обновлённая конфигурация';
    $('#mgSides').hidden = true;
    renderCode('#mgOurs', file.ours);
    renderCode('#mgTheirs', file.theirs);
    if (file.line) markRange('#mgOurs', { start: file.line, end: file.line });
    return;
  }

  $('#mgSides').hidden = false;
  const isBase = state.side === 'base';
  $('#mgOursTitle').textContent = 'Основная конфигурация';
  $('#mgRightTitle').textContent = isBase ? 'Текущая поставка' : 'Новая поставка';
  renderCode('#mgOurs', file.ours, isBase ? file.oursMarksBase : file.ours?.marks);
  renderCode('#mgTheirs', isBase ? file.base : file.theirs);
  if (state.place >= 0) selectPlace(state.place);
}

/**
 * Перечень мест внутри файла.
 *
 * У модуля их бывает десяток, и каждое — своя история: где, как разобрано
 * и почему именно так. Щелчок ведёт ко всем трём окнам сразу: обе колонки
 * встают на нужный участок, а в результате объединения то же место
 * выделяется — искать его там глазами не нужно.
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
    btn.addEventListener('click', () => selectPlace(Number(btn.dataset.place)));
  });
}

/**
 * Отметить участок во всех трёх окнах.
 *
 * Участок ищется ПО СОДЕРЖИМОМУ (сервер, `locate`), а не по номеру строки:
 * номера у сторон свои, и подсветка по ним показывала в левой колонке одну
 * строку, а в правой — другую.
 */
function selectPlace(index) {
  const place = state.file?.places?.[index];
  if (!place) return;
  state.place = index;
  $$('#mgPlaces [data-place]').forEach((b) => {
    b.classList.toggle('is-active', Number(b.dataset.place) === index);
  });

  markRange('#mgOurs', place.range?.ours);
  markRange('#mgTheirs', state.side === 'base' ? place.range?.base : place.range?.theirs);
  selectInResult(place.range?.result);
  showWhy(place);
}

function showWhy(place) {
  if (place.kind === 'auto' && place.why) setNote(`${place.how}: ${place.why}`);
  else setNote('');
}

// ------------------------------------------------------------- Колонки кода

/**
 * Текст с номерами строк и подсветкой синтаксиса.
 *
 * Строки приходят с сервера уже раскрашенными — тем же лексером и теми же
 * классами, что в отчёте о качестве кода (`highlightBslLines`). Держать
 * второй лексер 1С в браузере ради этого было бы расточительством, а видеть
 * код по-разному в двух местах одной программы — небрежностью.
 */
function renderCode(selector, side, marks = null) {
  const box = $(selector);
  if (side == null) {
    box.innerHTML = '<div class="empty">Этой версии нет: '
      + 'платформа не печатает прежнее значение поставщика, а файл .cf не указан.</div>';
    return;
  }
  if (side.binary) {
    box.innerHTML = '<div class="empty">Двоичный файл — показать его текстом нечем.</div>';
    return;
  }
  const kinds = marks || side.marks || [];
  box.innerHTML = `<table class="mgc"><tbody>${side.lines.map((html, i) => {
    const kind = kinds[i] ? ` class="d-${kinds[i]}"` : '';
    return `<tr id="${box.id}-l${i + 1}"${kind}><td class="mgc__n">${i + 1}</td>`
      + `<td class="mgc__t">${html || '&nbsp;'}</td></tr>`;
  }).join('')}</tbody></table>`;
}

/** Подсветить участок целиком и прокрутить к нему. */
function markRange(selector, range) {
  const box = $(selector);
  $$('tr.is-here', box).forEach((tr) => tr.classList.remove('is-here'));
  if (!range?.start) return;
  const first = document.getElementById(`${box.id}-l${range.start}`);
  for (let line = range.start; line <= (range.end || range.start); line += 1) {
    document.getElementById(`${box.id}-l${line}`)?.classList.add('is-here');
  }
  if (first) scrollPane(box, first.offsetTop);
}

/**
 * То же место в результате объединения.
 *
 * Результат лежит в поле ввода — раскрасить в нём строку нечем, поэтому
 * участок ВЫДЕЛЯЕТСЯ, как это делает любой редактор при переходе к найденному.
 */
function selectInResult(range) {
  const box = $('#mgResult');
  if (!range?.start) return;
  const lines = box.value.split('\n');
  let from = 0;
  for (let i = 0; i < range.start - 1 && i < lines.length; i += 1) from += lines[i].length + 1;
  let to = from;
  for (let i = range.start - 1; i < (range.end || range.start) && i < lines.length; i += 1) {
    to += lines[i].length + 1;
  }
  try {
    box.setSelectionRange(from, Math.max(from, to - 1));
  } catch {
    /* поле может быть скрыто — выделять нечего */
  }
  const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 19;
  scrollPane(box, (range.start - 1) * lineHeight);
}

/** Прокрутка так, чтобы участок оказался в верхней трети окна. */
function scrollPane(box, offsetTop) {
  box.scrollTop = Math.max(0, offsetTop - box.clientHeight / 3);
}

/**
 * Одновременная прокрутка двух колонок — как в окне сравнения 1С.
 *
 * Синхронизируется и по вертикали, и по горизонтали: в колонках лежит один
 * и тот же код в двух версиях, и разъехавшиеся окна сравнивать невозможно.
 * Флаг нужен, чтобы прокрутка, наведённая нами, не вызвала обратную —
 * иначе колонки начинают дёргать друг друга.
 */
function linkScroll(a, b) {
  let busy = false;
  const tie = (from, to) => from.addEventListener('scroll', () => {
    if (busy) return;
    busy = true;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    // Флаг снимается следующим кадром: событие прокрутки приходит асинхронно.
    requestAnimationFrame(() => { busy = false; });
  });
  tie(a, b);
  tie(b, a);
}

// ------------------------------------------------------------- Поле результата

/**
 * Подсветка того, что человек правит.
 *
 * Раскрасить текст внутри `textarea` нечем, поэтому под ним лежит слой
 * с тем же текстом, уже подсвеченным, а сам ввод прозрачен — приём известный
 * и единственный, который не превращает поле в самодельный редактор.
 *
 * Красит ТОТ ЖЕ лексер, что и всё остальное, — на сервере (`/api/highlight`).
 * Второй лексер 1С в браузере рано или поздно разошёлся бы с первым во мнении
 * о том, что здесь ключевое слово. Запрос идёт с задержкой после того, как
 * человек перестал набирать, а не на каждое нажатие; пока ответа нет, слой
 * показывает прежнюю раскраску — текст под кареткой от этого не прыгает.
 */
function initEditor() {
  const box = $('#mgResult');
  const layer = $('#mgResultHl');

  const sync = () => {
    layer.scrollTop = box.scrollTop;
    layer.scrollLeft = box.scrollLeft;
  };
  box.addEventListener('scroll', sync);
  box.addEventListener('focus', () => $('#mgEditor').classList.add('is-focused'));
  box.addEventListener('blur', () => {
    $('#mgEditor').classList.remove('is-focused');
    repaintEditor();
  });
  box.addEventListener('input', () => {
    // Пока подсветка не пришла, слой должен хотя бы совпадать по числу строк:
    // иначе прокрутка слоя и поля разъезжаются на глазах.
    layer.textContent = box.value;
    sync();
    clearTimeout(state.paintTimer);
    state.paintTimer = setTimeout(repaintEditor, 350);
  });
}

/** Перекрасить слой под полем ввода. */
async function repaintEditor() {
  const box = $('#mgResult');
  const layer = $('#mgResultHl');
  const text = box.value;
  const ext = extOf(state.file?.rel || '');

  if (!state.file?.editable || text.length > EDITOR_HIGHLIGHT_LIMIT) {
    $('#mgEditor').classList.add('is-plain');
    return;
  }
  $('#mgEditor').classList.remove('is-plain');

  try {
    const { lines } = await api.highlight(text, ext);
    // За время запроса человек мог набрать ещё — тогда раскраска устарела
    // и ставить её нельзя: слой разъедется с текстом.
    if (box.value !== text) return;
    layer.innerHTML = lines.join('\n');
  } catch {
    layer.textContent = text;
  }
  layer.scrollTop = box.scrollTop;
  layer.scrollLeft = box.scrollLeft;
}

function extOf(rel) {
  const dot = String(rel).lastIndexOf('.');
  return dot === -1 ? '' : String(rel).slice(dot).toLowerCase();
}

// ------------------------------------------------------------- Решение

async function decide(action) {
  const file = state.file;
  if (!file) return;

  if (action === 'skip' && !confirm(
    'Пометить это замечание пропущенным?\n\n'
    + 'Оно останется в отчёте, но обновление продолжится, не дожидаясь его исправления.\n'
    + 'Так поступают с замечаниями, которые есть и в чистой типовой конфигурации.',
  )) return;

  if (action === 'revert' && !confirm(
    'Вернуть вариант, записанный программой?\n\nВаши правки этого файла будут потеряны, '
    + 'а место снова станет неразобранным.',
  )) return;

  const buttons = ['#mgSave', '#mgAccept', '#mgRevert', '#mgSkip'];
  buttons.forEach((id) => { $(id).disabled = true; });
  setNote('Сохранение…');
  try {
    const body = state.group === 'checks'
      ? { check: file.id, action }
      : { rel: file.rel, action };
    if (action === 'save') body.text = $('#mgResult').value;
    const answer = await api.updateReviewDecide(state.updateId, body);
    const done = state.group === 'checks'
      ? 'Разобранных ошибок не осталось — можно продолжать обновление.'
      : 'Неразобранных мест не осталось — можно загружать конфигурацию.';
    const message = action === 'revert'
      ? 'Возвращён вариант программы — место снова ждёт вашего решения.'
      : action === 'skip'
        ? `Замечание помечено пропущенным. Осталось разобрать: ${formatNumber(answer.left || 0)}.`
        : (answer.left
          ? `Сохранено. Осталось разобрать: ${formatNumber(answer.left)}.`
          : `Сохранено. ${done}`);
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
      $('#mgRevert').disabled = !state.file.hasAuto;
    }
  }
}

function setNote(text, isError = false) {
  const box = $('#mgNote');
  box.textContent = text;
  box.classList.toggle('is-error', isError);
  box.hidden = !text;
}
