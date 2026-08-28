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
  /** Перекраска уже назначена — второй раз таймер не заводим. */
  paintPending: false,
  /** Когда последний раз получили раскраску с сервера. */
  paintAt: 0,
  /**
   * Последняя раскраска: строки исходного текста и их готовый HTML.
   *
   * По ней слой перерисовывается МГНОВЕННО на каждое нажатие: строки, которых
   * правка не коснулась, оставляют прежний цвет, и модуль не белеет целиком
   * в ожидании ответа сервера.
   */
  paint: null,
  /** Какая группа открыта: `merge` — спорные места, `checks` — ошибки проверок. */
  group: 'merge',
  /** Участки отличий открытого файла и номер того, на котором стоим. */
  hunks: [],
  hunk: -1,
  /**
   * Что выбрано у каждого участка: 'theirs' | 'ours' | 'auto'.
   *
   * Выбор живёт только пока открыт файл: сохраняется он не отдельно,
   * а вместе со всем текстом результата — по кнопке «Сохранить результат».
   */
  picked: new Map(),
  /**
   * Где сейчас лежит каждый участок в тексте результата: номера строк.
   *
   * Пересчитывается при каждой замене: участок другой длины сдвигает всё,
   * что ниже, и без пересчёта следующий выбор попал бы не в то место.
   */
  spans: new Map(),
  /**
   * Какой метод выбран: имя в нижнем регистре.
   *
   * Выбрав метод, человек видит во всех трёх окнах только его — модуль
   * менеджера на три тысячи строк листать незачем (требование владельца
   * 28.08.2026). Пусто — показан файл целиком.
   */
  routine: null,
  /** Показывать в списке ВСЕ методы модуля, а не только дважды изменённые. */
  showAll: false,
  /** Показывать в результате весь модуль, а не только выбранный метод. */
  showModule: false,
  /** Результат развёрнут на всю рабочую область: колонки сравнения убраны. */
  grown: false,
  /**
   * Полный текст результата — он и уходит в файл.
   *
   * В поле ввода лежит лишь то, что человек сейчас смотрит: при выбранном
   * методе — его строки, иначе весь текст. Правки поля переносятся сюда,
   * а сохранение и замена стороны работают только с этим текстом.
   */
  fullText: '',
  /** Какие строки полного текста показаны в поле: {start, end} с единицы. */
  viewSpan: null,
  /**
   * Границы выбранного метода в полном тексте — уже с поправкой на правки.
   *
   * Серверные границы верны только до первой замены стороны: взяв версию
   * другой длины, метод становится длиннее или короче, и показанный кусок
   * по старым границам обрезал бы его конец.
   */
  routineSpan: null,
};

/**
 * Насколько большой текст ещё имеет смысл подсвечивать на лету.
 *
 * Прежние 400 КБ оказались занижены: модуль менеджера крупного документа
 * бывает больше, и его результат оставался серым, хотя колонки рядом были
 * раскрашены (замечание пользователя 27.08.2026). Замер лексера: 900 КБ —
 * 87 мс, так что дело было не в цене работы. Порог оставлен на случай
 * по-настоящему огромного файла, где мешала бы уже передача разметки.
 */
const EDITOR_HIGHLIGHT_LIMIT = 2_000_000;

/** С какого размера подсветку просят реже: перекрашивать мегабайт на каждое нажатие незачем. */
const BIG_TEXT = 200_000;

/**
 * Как часто спрашивать раскраску у сервера, пока человек печатает.
 *
 * Это троттлинг, а не задержка «после того, как перестал набирать»: при наборе
 * запросы идут подряд каждые сто с небольшим миллисекунд, и цвет догоняет текст
 * почти мгновенно. Запрос местный (127.0.0.1) и стоит миллисекунды, а лексер
 * один на всю программу — второй, в браузере, рано или поздно разошёлся бы
 * с ним во мнении о том, что здесь ключевое слово.
 */
const PAINT_INTERVAL = 120;

export function initMerge(onBack) {
  state.back = onBack;

  $$('#mgWork .mgw__filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter;
      $$('#mgWork .mgw__filters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderTree();
    });
  });

  $$('#mgSides [data-side]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.side = chip.dataset.side;
      $$('#mgSides [data-side]').forEach((c) => c.classList.toggle('is-active', c === chip));
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

  $$('#mgWork [data-hunk]').forEach((btn) => {
    btn.addEventListener('click', () => goToHunk(Number(btn.dataset.hunk)));
  });

  // Горячие клавиши те же, что в конфигураторе: Alt+Shift+P — вверх,
  // Alt+Shift+N — вниз. Ловятся на документе, но работают только на открытой
  // странице разбора: в других разделах они ничего не значат.
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (document.querySelector('.view.is-active')?.dataset.view !== 'merge') return;
    const key = (event.code || '').replace('Key', '').toLowerCase();
    if (key !== 'p' && key !== 'n') return;
    event.preventDefault();
    goToHunk(key === 'n' ? 1 : -1);
  });

  $('#mgSkip').addEventListener('click', () => decide('skip'));
  $('#mgBack').addEventListener('click', () => state.back?.());
  initEditor();

  // Колонки прокручиваются вместе — как в окне сравнения конфигуратора.
  linkScroll($('#mgOurs'), $('#mgTheirs'));

  $('#mgSave').addEventListener('click', () => decide('save'));
  $('#mgRevert').addEventListener('click', () => decide('revert'));
  $('#mgBackError').addEventListener('click', () => state.back?.());

  // Показывать ли в списке все методы модуля. Кнопка нажимается и отжимается:
  // отжатая оставляет только дважды изменённые, как было.
  $('#mgShowAll').addEventListener('click', () => {
    state.showAll = !state.showAll;
    $('#mgShowAll').classList.toggle('is-active', state.showAll);
    renderPlaces(state.file);
  });

  // Показывать ли в результате весь модуль. Отжатая кнопка оставляет
  // в поле только выбранный метод.
  $('#mgShowModule').addEventListener('click', () => {
    state.showModule = !state.showModule;
    $('#mgShowModule').classList.toggle('is-active', state.showModule);
    applyResultView();
    renderRight();
  });

  // Разворот результата на всю рабочую область: стрелки наружу — свернуть,
  // к центру — развернуть обратно.
  $('#mgGrow').addEventListener('click', () => {
    state.grown = !state.grown;
    $('#mgGrow').classList.toggle('is-active', state.grown);
    $('#mgWork').classList.toggle('is-grown', state.grown);
  });
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
  const done = t.left === 0 && t.files > 0;
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
  // Роды мест разные, и одним числом их не назвать: одно — работа, которую
  // предстоит сделать, другое — чужое решение, которое надо просмотреть.
  if (t.leftManual) {
    parts.push(`<b style="color:var(--warn)">требуют вашего решения: ${formatNumber(t.leftManual)}</b>`);
  }
  if (t.leftAuto) {
    parts.push(`<b style="color:var(--warn)">ждут вашего подтверждения: ${formatNumber(t.leftAuto)}</b>`);
  }
  if (!t.left) {
    parts.push(`<b style="color:var(--good)">${checks ? 'неразобранных замечаний не осталось' : 'неразобранных мест не осталось'}</b>`);
  }
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

/** Место ждёт человека, пока он не принял решение: и нерешённое, и разобранное сама. */
function needsWork(file) {
  return !file.decision;
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
      ${objectMark(object)}
      <span class="mgt__title">${escapeHtml(object.title || object.key)}</span>
      <span class="mgt__stat">${object.files.length}</span>
    </summary>
    <div class="mgt__body">
      ${object.files.map(renderFile).join('')}
    </div>
  </details>`;
}


/**
 * Значок вида объекта метаданных.
 *
 * Буквенный, а не срисованная пиктограмма платформы: сокращение читается
 * с одного взгляда («Док», «РС», «ОМ»), не зависит от версии 1С и не тянет
 * в продукт чужую графику. Цвет — по семейству: данные, документы, регистры,
 * код, права. Вид приходит с сервера русским названием, но английский тег
 * тоже понимается: у части объектов в дереве стоит именно он.
 */
const OBJECT_MARKS = new Map([
  ['справочник', ['Спр', 'data']],
  ['документ', ['Док', 'doc']],
  ['журналдокументов', ['ЖД', 'doc']],
  ['перечисление', ['Пер', 'data']],
  ['константа', ['Кон', 'data']],
  ['планвидовхарактеристик', ['ПВХ', 'data']],
  ['плансчетов', ['ПС', 'data']],
  ['планвидоврасчета', ['ПВР', 'data']],
  ['планобмена', ['ПО', 'data']],
  ['регистрсведений', ['РС', 'reg']],
  ['регистрнакопления', ['РН', 'reg']],
  ['регистрбухгалтерии', ['РБ', 'reg']],
  ['регистррасчета', ['РР', 'reg']],
  ['последовательность', ['Псл', 'reg']],
  ['бизнеспроцесс', ['БП', 'proc']],
  ['задача', ['Зад', 'proc']],
  ['отчет', ['Отч', 'proc']],
  ['обработка', ['Обр', 'proc']],
  ['общиймодуль', ['ОМ', 'code']],
  ['общаяформа', ['ОФ', 'code']],
  ['общаякоманда', ['Ком', 'code']],
  ['общиймакет', ['Мкт', 'code']],
  ['общаякартинка', ['Крт', 'code']],
  ['подпискунасобытие', ['Пдп', 'code']],
  ['подпискинасобытия', ['Пдп', 'code']],
  ['регламентноезадание', ['РЗ', 'code']],
  ['webсервис', ['Веб', 'code']],
  ['httpсервис', ['HTTP', 'code']],
  ['пакетxdto', ['XDTO', 'code']],
  ['роль', ['Роль', 'right']],
  ['подсистема', ['Пдс', 'right']],
  ['языки', ['Язк', 'right']],
  ['язык', ['Язк', 'right']],
  ['конфигурация', ['Кфг', 'right']],
  // Виды, которых поначалу не было: без них дерево показывало объект
  // вовсе без значка (замечание владельца 28.08.2026).
  ['определяемыйтип', ['ОпТ', 'data']],
  ['функциональнаяопция', ['ФО', 'code']],
  ['параметрфункциональнойопции', ['ПФО', 'code']],
  ['критерийотбора', ['КО', 'data']],
  ['общийреквизит', ['ОбР', 'data']],
  ['параметрсеанса', ['ПрС', 'code']],
  ['хранилищенастроек', ['ХН', 'code']],
  ['группакоманд', ['ГК', 'code']],
  ['стильоформления', ['Стл', 'code']],
  ['стиль', ['Стл', 'code']],
  ['wsссылка', ['WS', 'code']],
  ['внешнийисточникданных', ['ВИД', 'data']],
  ['нумератор', ['Нум', 'doc']],
]);

/**
 * Значок для вида, которого нет в таблице.
 *
 * Прежде такой объект оставался вовсе без значка, и в дереве он выглядел
 * иначе, чем соседи. Берём первые буквы: даже приблизительное сокращение
 * лучше пустого места, а цвет у него нейтральный — «вид неизвестен».
 */
function fallbackMark(kind) {
  const words = String(kind).split(/[\s-]+/).filter(Boolean);
  if (!words.length) return '';
  const text = words.length > 1
    ? words.map((word) => word[0].toUpperCase()).join('').slice(0, 4)
    : words[0].slice(0, 3);
  return `<i class="ob-mark ob-mark--other" title="${escapeHtml(kind)}">${escapeHtml(text)}</i>`;
}

function objectMark(object) {
  const kind = String(object.kind || '').toLowerCase().replace(/[\s-]/g, '').replace(/ё/g, 'е');
  const found = OBJECT_MARKS.get(kind);
  if (!found) return object.kind ? fallbackMark(object.kind) : '';
  const [text, family] = found;
  return `<i class="ob-mark ob-mark--${family}" title="${escapeHtml(object.kind)}">${text}</i>`;
}
function renderFile(file) {
  const mark = fileMark(file);
  const active = state.file?.key === fileKey(file) ? ' is-active' : '';
  // Счёт двумя числами: сколько мест дважды изменено всего и сколько
  // из них ждёт решения человека (требование владельца 28.08.2026). Одно
  // число не отвечало на главный вопрос — много ли ещё работы.
  const total = (file.conflictCount || 0) + (file.resolvedCount || 0);
  const left = file.decision ? 0 : (file.conflictCount || 0);
  const count = total ? `${formatNumber(total)}/${formatNumber(left)}` : '';
  const hint = total
    ? `дважды изменено: ${total}, ждут вашего решения: ${left}`
    : '';
  return `
  <button class="mgt__file${active}" type="button" data-rel="${escapeHtml(fileKey(file))}">
    <i class="mgi mgi--${mark}" aria-hidden="true"></i>
    <span class="mgt__file-name">${escapeHtml(file.element || file.rel)}</span>
    ${count ? `<span class="mgt__stat" title="${escapeHtml(hint)}">${count}</span>` : ''}
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
  state.hunk = -1;
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

  const text = file.current ?? '';
  const box = $('#mgResult');
  // В поле лежит только то, что человек сейчас смотрит; целое — здесь.
  state.fullText = text;
  state.routine = null;
  state.routineSpan = null;
  state.viewSpan = null;
  box.readOnly = !file.editable;
  state.loadedText = text;
  // Раскраска прошлого файла к этому отношения не имеет: кэш обнуляется,
  // иначе строки чужого модуля попали бы в слой под новым текстом.
  state.paint = null;

  /*
   * Выбор сторон сбрасывается ДО того, как список нарисован.
   *
   * Порядок здесь не косметика: пока сброс стоял ниже, список строился
   * по выбору ПРОШЛОГО открытия, и после кнопки «Вернуть вариант программы»
   * файл возвращался к варианту программы, а выпадающие списки продолжали
   * показывать то, что человек выбрал до отката (замечание владельца
   * 28.08.2026).
   */
  state.picked = new Map();
  state.spans = new Map();
  (file.places || []).forEach((place, index) => {
    if (place.range?.result?.start) state.spans.set(index, { ...place.range.result });
  });

  // Переключатели показа нужны только там, где есть что показывать: список
  // методов бывает лишь у модулей.
  const hasRoutines = (file.routines || []).length > 0;
  $('#mgShow').hidden = !hasRoutines;
  $('#mgShowAll').classList.toggle('is-active', state.showAll);
  $('#mgShowModule').classList.toggle('is-active', state.showModule);

  renderPlaces(file);
  renderRight();
  applyResultView();

  $('#mgSave').disabled = !file.editable;
  $('#mgRevert').hidden = state.group === 'checks';
  $('#mgRevert').disabled = !file.hasAuto;
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
    : 'по умолчанию взята новая поставка — свою версию верните выбором у метода';
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
  const checks = state.group === 'checks';
  const isBase = !checks && state.side === 'base';
  const align = file.align?.[isBase ? 'base' : 'theirs'] || { left: [], right: [], marks: [], hunks: [] };
  state.hunks = align.hunks || [];

  $('#mgSides').hidden = checks;
  $('#mgOursTitle').textContent = checks
    ? (file.kind === 'extension' ? 'Расширение' : 'Модуль конфигурации')
    : 'Основная конфигурация';
  $('#mgRightTitle').textContent = checks
    ? 'Обновлённая конфигурация'
    : (isBase ? 'Текущая поставка' : 'Новая поставка');

  // Выбран метод — в обеих колонках остаётся только он. Строки отбираются
  // по строкам ЭКРАНА, общим для пары: иначе выравнивание, ради которого
  // весь этот план и считался, разъехалось бы.
  const rightSide = checks ? 'theirs' : (isBase ? 'base' : 'theirs');
  const rows = visibleRows(align, {
    left: routineRange('ours'),
    right: routineRange(rightSide),
  });

  renderCode('#mgOurs', file.ours, align.left, align.marks, rows);
  renderCode('#mgTheirs', checks ? file.theirs : (isBase ? file.base : file.theirs),
    align.right, align.marks, rows);

  if (checks && file.line) markRange('#mgOurs', { start: file.line, end: file.line });
  // Пометку участка ставим напрямую: вызвать отсюда selectPlace нельзя —
  // он сам перерисовывает колонки, и пара ушла бы в рекурсию.
  else if (state.place >= 0) markCurrentPlace();
}

/**
 * Переход к предыдущей или следующей правке — как стрелки в окне сравнения 1С.
 *
 * Прокручиваются ОБЕ колонки: строки в них выровнены, и участок в них один
 * и тот же. Горячие клавиши — те же, что у платформы: Alt+Shift+P и Alt+Shift+N.
 */
function goToHunk(step) {
  const hunks = state.hunks || [];
  if (!hunks.length) {
    setNote('Отличий в этом файле нет.');
    return;
  }
  const current = state.hunk ?? -1;
  const next = step > 0
    ? hunks.findIndex((h, i) => i > current)
    : [...hunks].reduce((found, h, i) => (i < current ? i : found), -1);
  const at = next === -1 ? (step > 0 ? 0 : hunks.length - 1) : next;
  state.hunk = at;

  for (const selector of ['#mgOurs', '#mgTheirs']) {
    const row = $(selector).querySelector(`tr[data-r="${hunks[at].row}"]`);
    if (row) scrollPane($(selector), row.offsetTop);
  }
  setNote(`Правка ${at + 1} из ${hunks.length}.`);
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
  const rows = placeRows(file);
  if (!rows.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <table class="mgp">
      <tbody>
        ${rows.map((row) => `
        <tr class="mgp__row mgp__row--${row.kind}"${row.place >= 0 ? ` data-place="${row.place}"` : ''}
            data-routine="${escapeHtml(row.routine || '')}">
          <td class="mgp__mark">
            ${row.kind === 'plain' ? '' : `<i class="mgi mgi--${row.kind === 'auto' ? 'auto' : 'manual'}" aria-hidden="true"></i>`}
          </td>
          <td class="mgp__where">${routineMark(row)}${escapeHtml(row.where || 'участок')}</td>
          <td class="mgp__how">${row.how ? escapeHtml(row.how) : ''}</td>
          <td class="mgp__pick">${row.place >= 0 ? sidePicker(file.places[row.place], row.place) : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  $$('.mgp__row', box).forEach((row) => {
    row.addEventListener('click', (event) => {
      // Щелчок по выпадающему списку выбирает сторону, а не участок.
      if (event.target.closest('select')) return;
      if (row.dataset.place !== undefined) selectPlace(Number(row.dataset.place));
      else selectRoutine(row.dataset.routine || '');
    });
  });
  $$('select[data-pick]', box).forEach((select) => {
    select.addEventListener('change', () => {
      const index = Number(select.dataset.pick);
      selectPlace(index);
      takeSide(index, select.value);
    });
  });

  if (state.place >= 0) highlightRow();
}

/**
 * Строки списка: дважды изменённые места и — по кнопке «Показать все» —
 * остальные методы модуля.
 *
 * Метод, у которого спорных мест нет, показывается без значка состояния
 * и без выбора стороны: выбирать там нечего, а вот открыть его, чтобы
 * посмотреть, человек вправе.
 */
function placeRows(file) {
  const places = file?.places || [];
  const rows = places.map((place, index) => ({
    place: index,
    kind: place.kind,
    where: place.where,
    how: place.how,
    routine: (place.routineName || '').toLowerCase(),
    routineKind: place.routineKind,
    routineHasParams: place.routineHasParams,
  }));

  if (!state.showAll) return rows;

  const taken = new Set(rows.map((row) => row.routine).filter(Boolean));
  for (const routine of file?.routines || []) {
    const key = routine.name.toLowerCase();
    if (taken.has(key)) continue;
    rows.push({
      place: -1,
      kind: 'plain',
      where: routine.where,
      how: '',
      routine: key,
      routineKind: routine.kind,
      routineHasParams: routine.hasParams,
    });
  }

  // Порядок — как в модуле: список читают сверху вниз вместе с кодом.
  const at = (row) => {
    const found = (file?.routines || []).findIndex((r) => r.name.toLowerCase() === row.routine);
    return found === -1 ? Number.MAX_SAFE_INTEGER : found;
  };
  return rows.sort((a, b) => at(a) - at(b));
}

/**
 * Значок вида метода — тот же, что в отчёте о качестве кода.
 *
 * «P()» у процедуры, «F(x)» у функции: скобки говорят, есть ли параметры.
 * Вид приходит с сервера из разбора модуля; не разобралось — значка нет,
 * выдумывать вид нельзя.
 */
function routineMark(place) {
  if (place.routineKind !== 'procedure' && place.routineKind !== 'function') return '';
  const letter = place.routineKind === 'function' ? 'F' : 'P';
  const inner = place.routineHasParams ? (place.routineKind === 'function' ? 'x' : '…') : '';
  return `<i class="rt-mark rt-mark--${place.routineKind}">${letter}(${inner})</i> `;
}

/**
 * Откуда брать текст участка.
 *
 * По умолчанию — из новой поставки: цель обновления в том, чтобы перейти
 * на новый релиз, сохранив доработки (требование пользователя 27.08.2026).
 * Место, которое программа разобрала сама, стоит на своём решении — его тоже
 * можно переключить, и тогда в результат ляжет выбранная сторона целиком.
 */
function sidePicker(place, index) {
  // У ошибок проверок сторон нет: там правят один файл, а не сводят две
  // версии. Выпадающий список в этой вкладке был бы бессмыслицей.
  if (state.group === 'checks') return '';
  const chosen = state.picked.get(index) || (place.kind === 'auto' ? 'auto' : 'theirs');
  const options = [
    place.kind === 'auto' ? ['auto', 'решение программы'] : null,
    ['theirs', 'взять из новой поставки'],
    ['ours', 'взять из основной конфигурации'],
  ].filter(Boolean);
  return `<select class="mgp__select" data-pick="${index}">${options.map(([value, title]) =>
    `<option value="${value}"${value === chosen ? ' selected' : ''}>${title}</option>`).join('')}</select>`;
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
  const next = (place.routineName || '').toLowerCase() || null;
  if (next !== state.routine) state.routineSpan = null;
  state.routine = next;
  highlightRow();

  // Показ ограничивается выбранным методом — во всех трёх окнах сразу.
  renderRight();
  applyResultView();

  markCurrentPlace();
  selectInResult(place.range?.result);
  showWhy(place);
}

/** Отметить текущий участок в обеих колонках. */
function markCurrentPlace() {
  const place = state.file?.places?.[state.place];
  if (!place) return;
  markRange('#mgOurs', place.range?.ours);
  markRange('#mgTheirs', state.side === 'base' ? place.range?.base : place.range?.theirs);
}

/** Выбрать метод, у которого спорных мест нет: показать его во всех окнах. */
function selectRoutine(name) {
  if (!name) return;
  state.place = -1;
  if (name !== state.routine) state.routineSpan = null;
  state.routine = name;
  highlightRow();
  renderRight();
  applyResultView();
  setNote('');
}

/** Отметить в списке выбранную строку. */
function highlightRow() {
  $$('#mgPlaces .mgp__row').forEach((row) => {
    const isPlace = row.dataset.place !== undefined && Number(row.dataset.place) === state.place;
    const isRoutine = state.place === -1 && row.dataset.routine
      && row.dataset.routine === state.routine;
    row.classList.toggle('is-active', Boolean(isPlace || isRoutine));
  });
}

/** Границы выбранного метода в одной из версий; ничего не выбрано — null. */
function routineRange(side) {
  if (!state.routine) return null;
  const found = (state.file?.routines || [])
    .find((routine) => routine.name.toLowerCase() === state.routine);
  return found?.ranges?.[side] || null;
}

function showWhy(place) {
  if (place.kind === 'auto' && place.why) setNote(`${place.how}: ${place.why}`);
  else setNote('');
}

// ------------------------------------------------------------- Колонки кода

/**
 * Текст с номерами строк, подсветкой синтаксиса и выравниванием.
 *
 * Строки приходят с сервера уже раскрашенными — тем же лексером и теми же
 * классами, что в отчёте о качестве кода (`highlightBslLines`). Держать
 * второй лексер 1С в браузере ради этого было бы расточительством, а видеть
 * код по-разному в двух местах одной программы — небрежностью.
 *
 * Раскладка (`plan`) говорит, какая строка файла стоит в какой строке экрана;
 * ноль означает подпорку — в этой версии строки нет. Благодаря ей общий код
 * обеих версий лежит на одном уровне, как в окне сравнения конфигуратора.
 * Строка экрана и строка файла с этого места — разные вещи, поэтому у ряда
 * два опознавателя: `-r<строка экрана>` для прокрутки вместе и `-l<строка
 * файла>` для перехода к участку.
 */
/**
 * Какие строки экрана показывать, когда выбран метод.
 *
 * Строка экрана берётся, если В ЛЮБОЙ из двух версий она принадлежит методу:
 * метод, добавленный поставщиком, в нашей версии не существует вовсе, и его
 * строки иначе пропали бы вместе с подпорками. Ни одного метода не выбрано —
 * ограничения нет, и возвращается null: рисуем всё, как раньше.
 *
 * @returns {number[]|null} номера строк экрана
 */
function visibleRows(align, limits) {
  if (!limits.left && !limits.right) return null;
  const left = align.left || [];
  const right = align.right || [];
  const count = Math.max(left.length, right.length);
  const inside = (line, range) => Boolean(line && range && line >= range.start && line <= range.end);

  const rows = [];
  for (let row = 0; row < count; row += 1) {
    if (inside(left[row], limits.left) || inside(right[row], limits.right)) rows.push(row);
  }
  return rows;
}

function renderCode(selector, side, plan = null, marks = null, only = null) {
  const box = $(selector);
  if (side == null) {
    box.innerHTML = '<div class="empty">Этой версии нет: текущая поставка не нашлась '
      + 'ни в выгрузке (Ext\\ParentConfigurations), ни на форме, а прежнее значение свойства '
      + 'платформа в отчёте сравнения не печатает.</div>';
    return;
  }
  if (side.binary) {
    box.innerHTML = '<div class="empty">Двоичный файл — показать его текстом нечем.</div>';
    return;
  }

  const all = plan && plan.length ? plan : side.lines.map((_, i) => i + 1);
  const kinds = marks || [];
  // Показ ограничен выбранным методом: строки экрана те же, что и в соседней
  // колонке, поэтому пара остаётся выровненной.
  const rows = only ? only.map((row) => all[row]) : all;
  const rowIndex = only || all.map((_, row) => row);
  if (only && !only.length) {
    box.innerHTML = '<div class="empty">В этой версии выбранного метода нет.</div>';
    return;
  }
  box.innerHTML = `<table class="mgc"><tbody>${rows.map((line, at) => {
    const row = rowIndex[at];
    const kind = line ? (kinds[row] || '') : 'pad';
    const id = line ? ` id="${box.id}-l${line}"` : '';
    return `<tr data-r="${row}"${id}${kind ? ` class="d-${kind}"` : ''}>`
      + `<td class="mgc__n">${line || ''}</td>`
      + `<td class="mgc__t">${line ? (side.lines[line - 1] || '&nbsp;') : '&nbsp;'}</td></tr>`;
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
  // Номера участка — в координатах ПОЛНОГО текста, а в поле лежит кусок:
  // сдвигаем на его начало.
  const shift = (state.viewSpan?.start || 1) - 1;
  const start = range.start - shift;
  const end = (range.end || range.start) - shift;
  if (start < 1) return;
  const lines = box.value.split('\n');
  let from = 0;
  for (let i = 0; i < start - 1 && i < lines.length; i += 1) from += lines[i].length + 1;
  let to = from;
  for (let i = start - 1; i < end && i < lines.length; i += 1) {
    to += lines[i].length + 1;
  }
  try {
    box.setSelectionRange(from, Math.max(from, to - 1));
  } catch {
    /* поле может быть скрыто — выделять нечего */
  }
  const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 19;
  scrollPane(box, (start - 1) * lineHeight);
}

/**
 * Заменить участок в результате версией выбранной стороны.
 *
 * Меняется ровно один участок — тот, у которого переключили список; остальной
 * текст остаётся как есть, включая правки, сделанные руками. Участки заданы
 * номерами строк, поэтому после замены границы всех, что ниже, сдвигаются
 * на разницу длин: иначе следующий выбор попал бы не туда.
 */
function takeSide(index, side) {
  const place = state.file?.places?.[index];
  const span = state.spans.get(index);
  if (!place || !span) return;

  const lines = linesOf(side, place);
  if (!lines) return;

  const all = state.fullText.split('\n');
  const before = span.end - span.start + 1;
  all.splice(span.start - 1, before, ...lines);
  state.fullText = all.join('\n');

  const shift = lines.length - before;
  state.spans.set(index, { start: span.start, end: span.start + lines.length - 1 });
  if (shift) {
    for (const [key, other] of state.spans) {
      if (key === index || other.start <= span.start) continue;
      state.spans.set(key, { start: other.start + shift, end: other.end + shift });
    }
  }
  state.picked.set(index, side);
  // Метод стал другой длины — его конец едет вместе с текстом.
  if (shift && state.routineSpan
    && span.start >= state.routineSpan.start && span.start <= state.routineSpan.end) {
    state.routineSpan.end += shift;
  }

  applyResultView();
  selectPlace(index);
  setNote(side === 'ours'
    ? 'Участок взят из основной конфигурации. Нажмите «Сохранить результат», чтобы записать.'
    : (side === 'auto'
      ? 'Возвращено решение программы. Нажмите «Сохранить результат», чтобы записать.'
      : 'Участок взят из новой поставки. Нажмите «Сохранить результат», чтобы записать.'));
}

/** Текст одной стороны участка: то, что подставляется в результат. */
function linesOf(side, place) {
  if (side === 'ours') return place.text?.ours || null;
  if (side === 'theirs') return place.text?.theirs || null;
  return place.text?.result || null;
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

  const nums = $('#mgResultNums');
  const sync = () => {
    layer.scrollTop = box.scrollTop;
    layer.scrollLeft = box.scrollLeft;
    nums.scrollTop = box.scrollTop;
  };
  box.addEventListener('scroll', sync);
  box.addEventListener('focus', () => $('#mgEditor').classList.add('is-focused'));
  box.addEventListener('blur', () => {
    $('#mgEditor').classList.remove('is-focused');
    repaintEditor();
  });
  box.addEventListener('input', () => {
    takeEditorText();
    paintFromCache();
    renderLineNumbers();
    sync();
    schedulePaint();
  });

  /*
   * Tab здесь — отступ, а не переход к следующему полю.
   *
   * Это редактор кода: в конфигураторе Tab сдвигает строку, и человек,
   * правящий модуль, набирает его не думая. Браузер по умолчанию уводит
   * фокус, и вместо отступа правка обрывалась.
   *
   * Выделено несколько строк — сдвигается блок целиком, Shift+Tab возвращает
   * назад: так же ведут себя все редакторы. Выход с клавиатуры остаётся —
   * Escape уводит фокус, иначе поле стало бы ловушкой для тех, кто работает
   * без мыши.
   */
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { box.blur(); return; }
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
    if (box.readOnly) return;
    event.preventDefault();
    shiftSelection(box, event.shiftKey);
  });
}

/** Отступ по Tab: либо знак табуляции, либо сдвиг выделенных строк. */
function shiftSelection(box, back) {
  const value = box.value;
  const from = box.selectionStart;
  const to = box.selectionEnd;
  const multi = value.slice(from, to).includes('\n');

  if (!multi && !back) {
    box.value = value.slice(0, from) + '\t' + value.slice(to);
    box.selectionStart = box.selectionEnd = from + 1;
  } else {
    const start = value.lastIndexOf('\n', from - 1) + 1;
    const end = value.indexOf('\n', to) === -1 ? value.length : value.indexOf('\n', to);
    const block = value.slice(start, end).split('\n');
    let firstShift = 0;
    let total = 0;
    const shifted = block.map((line, at) => {
      if (!back) {
        total += 1;
        if (at === 0) firstShift = 1;
        return '\t' + line;
      }
      const cut = line.startsWith('\t') ? 1 : (line.startsWith('    ') ? 4 : 0);
      total -= cut;
      if (at === 0) firstShift = -cut;
      return line.slice(cut);
    });
    box.value = value.slice(0, start) + shifted.join('\n') + value.slice(end);
    box.selectionStart = Math.max(start, from + firstShift);
    box.selectionEnd = Math.max(box.selectionStart, to + total);
  }

  takeEditorText();
  paintFromCache();
  renderLineNumbers();
  schedulePaint();
}

/**
 * Перекрасить слой немедленно, своими силами, до ответа сервера.
 *
 * Прежде на каждое нажатие слой заменялся голым текстом — и весь модуль на
 * полсекунды белел, а потом раскрашивался обратно (замечено пользователем
 * 27.08.2026). Здесь вместо этого берётся прошлая раскраска: сравниваем старые
 * строки с новыми с начала и с конца, и всё, чего правка не коснулась,
 * остаётся цветным. Меняется обычно одна строка.
 *
 * Единственное, что делается для неё своими силами, — комментарий: строка,
 * у которой первый непробельный знак это «//», в 1С комментарий до конца
 * строки, чем бы дальше её ни дописывали. Разбором это не назвать, лексером
 * тем более, а дописанное в комментарий зеленеет сразу, не дожидаясь ответа.
 */
function paintFromCache() {
  const box = $('#mgResult');
  const layer = $('#mgResultHl');
  const cache = state.paint;
  const next = box.value.split('\n');

  if (!cache || cache.src.length !== cache.html.length) {
    layer.textContent = box.value;
    return;
  }

  const old = cache.src;
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head
    && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;

  const dirty = next.slice(head, next.length - tail).map(paintLine);
  layer.innerHTML = [
    ...cache.html.slice(0, head),
    ...dirty,
    ...cache.html.slice(old.length - tail),
  ].join('\n');
}

/** Строка, которую сервер ещё не видел: комментарий — цветом, остальное — как есть. */
function paintLine(line) {
  const html = escapeHtml(line);
  return /^\s*\/\//.test(line) ? `<span class="tok-comment">${html}</span>` : html;
}

/**
 * Назначить запрос раскраски — не чаще, чем раз в `PAINT_INTERVAL`.
 *
 * Пока запрос назначен, повторные нажатия его не переносят: иначе при быстром
 * наборе раскраска не приходила бы вовсе, пока человек не остановится.
 */
function schedulePaint() {
  if (state.paintPending) return;
  state.paintPending = true;
  const size = $('#mgResult').value.length;
  const interval = size > BIG_TEXT ? PAINT_INTERVAL * 4 : PAINT_INTERVAL;
  const wait = Math.max(0, interval - (Date.now() - state.paintAt));
  clearTimeout(state.paintTimer);
  state.paintTimer = setTimeout(() => {
    state.paintPending = false;
    repaintEditor();
  }, wait);
}

/**
 * Номера строк результата.
 *
 * Считаются по тексту поля, но начинаются с той строки файла, с которой
 * начинается показанный кусок: при выбранном методе в поле лежит только он,
 * и нумерация с единицы врала бы о том, где этот код в модуле.
 */
function renderLineNumbers() {
  const box = $('#mgResult');
  const nums = $('#mgResultNums');
  if (!box || !nums) return;
  const first = state.viewSpan?.start || 1;
  const count = box.value.split('\n').length;
  const out = [];
  for (let n = 0; n < count; n += 1) out.push(first + n);
  nums.textContent = out.join('\n');
}

/**
 * Заполнить поле тем, что человек должен видеть: метод либо весь текст.
 *
 * Полный текст всё это время лежит в `state.fullText` — именно он уходит
 * в файл. Поле показывает кусок, а границы куска запоминаются, чтобы правку
 * вернуть на её место в целом тексте.
 */
function applyResultView() {
  const box = $('#mgResult');
  const lines = state.fullText.split('\n');
  // Границы берутся из состояния, а не у сервера напрямую: серверные верны
  // лишь до первой правки, а метод, у которого взяли версию другой длины,
  // по ним обрезался бы посреди кода.
  const span = state.showModule ? null : currentRoutineSpan();

  if (span && span.start && span.end && span.end <= lines.length) {
    state.viewSpan = { start: span.start, end: span.end };
    box.value = lines.slice(span.start - 1, span.end).join('\n');
  } else {
    state.viewSpan = null;
    box.value = state.fullText;
  }

  // Раскраска прежнего куска к новому отношения не имеет.
  state.paint = null;
  $('#mgResultHl').textContent = box.value;
  renderLineNumbers();
  repaintEditor();
  updateViewNote();
}

/**
 * Границы выбранного метода в полном тексте.
 *
 * Считаются один раз на выбор метода, дальше живут вместе с правками:
 * замена стороны и набор с клавиатуры сдвигают конец.
 */
function currentRoutineSpan() {
  if (!state.routine) return null;
  if (!state.routineSpan) {
    const found = routineRange('result');
    state.routineSpan = found ? { ...found } : null;
  }
  return state.routineSpan;
}

/** Подпись у поля: показан весь файл или один метод. */
function updateViewNote() {
  const note = $('#mgResultNote');
  if (!note || !state.file) return;
  const base = resultNote(state.file);
  note.textContent = state.viewSpan
    ? `${base} · показан только выбранный метод`
    : base;
}

/**
 * Перенести правку из поля в полный текст.
 *
 * Поле — окно в текст, а не сам текст: при выбранном методе в нём лежат
 * только его строки. Правка возвращается ровно на то место, откуда взята,
 * а границы окна сдвигаются на разницу длин.
 */
function takeEditorText() {
  const box = $('#mgResult');
  const span = state.viewSpan;
  if (!span) {
    state.fullText = box.value;
    return;
  }
  const lines = state.fullText.split('\n');
  const shown = box.value.split('\n');
  lines.splice(span.start - 1, span.end - span.start + 1, ...shown);
  state.fullText = lines.join('\n');
  state.viewSpan = { start: span.start, end: span.start + shown.length - 1 };
  // Показан метод — значит правили именно его, и его границы теперь такие же.
  if (state.routineSpan) state.routineSpan = { ...state.viewSpan };
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
    state.paint = { src: text.split('\n'), html: lines };
    state.paintAt = Date.now();
    // За время запроса человек мог набрать ещё. Выбрасывать ответ нельзя —
    // он всё равно свежее того, что лежит в слое: строки, до которых правка
    // не дошла, из него и берутся.
    if (box.value !== text) {
      paintFromCache();
      return;
    }
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

  const buttons = ['#mgSave', '#mgRevert', '#mgSkip'];
  buttons.forEach((id) => { $(id).disabled = true; });
  setNote('Сохранение…');
  try {
    const body = state.group === 'checks'
      ? { check: file.id, action }
      : { rel: file.rel, action };
    // В файл уходит ПОЛНЫЙ текст, а не показанный кусок: при выбранном
    // методе в поле лежат только его строки.
    if (action === 'save') body.text = state.fullText;
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
