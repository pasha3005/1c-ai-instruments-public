/**
 * Общие кирпичики отчёта: экранирование, значки, сворачиваемые блоки, счёт.
 *
 * Вынесены отдельно, потому что ими пользуются и сборка документа (`html.js`),
 * и раздел замечаний (`findings.js`). Пока их держал у себя `html.js`, раздел
 * замечаний импортировал их оттуда, а `html.js` — раздел из него: зависимость
 * шла в обе стороны и мешала разделить файл.
 */

import { SEVERITY_RU } from '../analyze/rules/context.js';
import { formatNumber } from '../analyze/dataVolume.js';
import { ruName } from '../parse/metadataKinds.js';
import { APP } from '../config.js';

/** Подпись автора в подвале отчёта: знак копирайта, имя и офис. */
export function signature() {
  return `<span class="author">© ${new Date().getFullYear()} ${esc(APP.vendor)}</span>`;
}

/**
 * Место, куда встанет номер раздела.
 *
 * Нумерация сквозная и проставляется по собранному документу: раздел «Отличия
 * от конфигурации поставщика» появляется не всегда, и жёсткие номера давали бы
 * пропуск, который читается как потерянная страница.
 */
export const SECTION_NUM = '<span class="section__num" data-num></span>';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function badge(severity) {
  return `<span class="badge badge--${severity}">${esc(SEVERITY_RU[severity] || severity)}</span>`;
}

export function riskBadge(risk) {
  const map = { high: ['critical', 'Высокий'], medium: ['medium', 'Средний'], low: ['good', 'Низкий'] };
  const [cls, label] = map[risk] || ['info', 'не определён'];
  return `<span class="badge badge--${cls}">${label}</span>`;
}

/**
 * Цветной значок с именем разработчика.
 *
 * Цвет закреплён за именем: один и тот же автор во всём отчёте одного цвета,
 * поэтому «чьих замечаний больше» видно, не читая подписи. Палитра выбирается
 * по остатку от суммы кодов символов — воспроизводимо и без состояния.
 *
 * Цвет приходит классом (`.badge--author-N` в styles.js), а не инлайновым
 * hex-цветом: инлайн не различает тему, и в тёмном отчёте пастельная светлая
 * плашка оставалась бы светлой на тёмном фоне.
 */
export function authorBadge(author) {
  if (!author) return '';
  return `<span class="badge badge--author badge--author-${authorPaletteIndex(author)}">${esc(author)}</span>`;
}

const AUTHOR_PALETTE_SIZE = 6;

function authorPaletteIndex(author) {
  let sum = 0;
  for (let i = 0; i < author.length; i += 1) sum += author.charCodeAt(i);
  return sum % AUTHOR_PALETTE_SIZE;
}

/**
 * Откуда взялся проверенный код. Без этой пометки читатель не отличает
 * замечание к собственному объекту интегратора от замечания к типовому
 * объекту вендора и справедливо подозревает, что проверялось всё подряд.
 */
export function originBadge(origin) {
  const label = {
    extension: 'расширение',
    added: 'добавлено интегратором',
    authored: 'авторская вставка',
    modified: 'изменённый типовой модуль',
    vendor: 'типовой код поставщика',
    full: 'поставщик не сравнивался',
  }[origin];
  return label ? `<span class="badge badge--origin">${label}</span>` : '';
}

/**
 * Сворачиваемый блок.
 *
 * **Свёрнут по умолчанию.** Отчёт по крупной базе — это тысячи замечаний;
 * раскрытый целиком он превращается в документ на сотни экранов, по которому
 * невозможно понять ни состав проблем, ни их объём. Свёрнутый умещается
 * на экран-два: видно, что и сколько, а разворачивается ровно то, что
 * разбирают. На печать в PDF это не влияет — там всё раскрыто правилом
 * `@media print`.
 *
 * @param {string} title готовая разметка заголовка
 * @param {string} body содержимое
 * @param {{count?: string|null, open?: boolean, extraClass?: string, badges?: string, id?: string}} [opts]
 */
export function collapsible(title, body, {
  count = null, open = false, extraClass = '', badges = '', id = '',
} = {}) {
  return `
  <details class="collapsible ${extraClass}"${open ? ' open' : ''}${id ? ` id="${id}"` : ''}>
    <summary>${title}${badges}${count ? `<span class="collapsible__count">${count}</span>` : ''}</summary>
    <div class="collapsible__body">${body}</div>
  </details>`;
}

/**
 * Число с существительным в правильной форме.
 *
 * Русский счёт нужен по всему отчёту: «1 замечаний» и «2 типов» в документе
 * для заказчика выглядят как небрежность.
 */
export function plural(count, one, few, many) {
  const n = Number(count) || 0;
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  const word = teen ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  return `${formatNumber(n)} ${word}`;
}

/** «1 строка», «2 строки», «5 строк» — иначе в отчёте «1 строк». */
export function lines(count) {
  return plural(count, 'строка', 'строки', 'строк');
}

/** Убирает счётчик из заголовка правила: он показывается отдельной колонкой. */
export function stripTrailingCount(title) {
  return String(title)
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/:\s*\d+\s*$/, '')
    .replace(/\s+—\s+\d+\s+.*$/, '');
}

/**
 * «Catalog.Номенклатура» → «Справочник «Номенклатура»».
 *
 * Ключи ConfigDumpInfo служебные, а пользователь видит объекты по-русски,
 * как в конфигураторе.
 */
export function prettyMetadataKey(key) {
  const dot = String(key).indexOf('.');
  if (dot === -1) return key;
  const tag = key.slice(0, dot);
  const name = key.slice(dot + 1);
  const ru = ruName(tag);
  return ru && ru !== tag ? `${ru} «${name}»` : key;
}

export function slug(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-');
}

export function shorten(text, limit = 300) {
  const s = String(text || '');
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

export function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
