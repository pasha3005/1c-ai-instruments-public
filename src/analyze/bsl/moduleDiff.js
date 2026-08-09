/**
 * Построчное сравнение модуля с версией поставщика.
 *
 * Зачем. Изменённый типовой модуль — это тысячи строк вендора, в которые
 * интегратор вставил свои. Пометки-комментарии есть не всегда, и без них
 * раньше приходилось выбирать из двух плохих вариантов: проверять модуль
 * целиком (замечания к чужому коду) или не проверять вовсе (доработка
 * выпадает из аудита).
 *
 * Есть третий, точный: если исходники поставщика лежат на диске, различия
 * видны построчно. Отличия от типового кода типовым кодом не являются —
 * это и есть доработка, и проверять надо ровно её.
 *
 * Алгоритм — жадный диф Майерса (O(ND), где D — число различий). Он подходит
 * именно для этой задачи: в изменённом типовом модуле различий мало, поэтому
 * D невелико, а размер модуля почти не влияет. Перед сравнением снимаются
 * общий префикс и общий суффикс — на типовом модуле это сразу отбрасывает
 * подавляющую часть строк.
 */

/** Предел числа различий. Больше — модуль переписан, построчный диф бесполезен. */
const MAX_EDITS = 20_000;

/**
 * Строки клиентского модуля, которых нет у поставщика.
 *
 * @param {string} vendorSource текст модуля из конфигурации поставщика
 * @param {string} clientSource текст модуля из проверяемой конфигурации
 * @returns {{regions: {startLine: number, endLine: number}[], addedLines: number, exact: boolean}}
 *   `exact: false` — сравнение не сошлось в отведённых пределах, различия
 *   определены грубее (по вхождению строки в модуль поставщика).
 */
export function diffModule(vendorSource, clientSource) {
  const vendor = normalizeLines(vendorSource);
  const client = normalizeLines(clientSource);

  // Общий префикс и суффикс: у изменённого типового модуля это почти весь текст.
  let head = 0;
  const maxHead = Math.min(vendor.length, client.length);
  while (head < maxHead && vendor[head] === client[head]) head += 1;

  let tail = 0;
  while (
    tail < maxHead - head
    && vendor[vendor.length - 1 - tail] === client[client.length - 1 - tail]
  ) tail += 1;

  const vendorMid = vendor.slice(head, vendor.length - tail);
  const clientMid = client.slice(head, client.length - tail);

  if (!clientMid.length) return { regions: [], addedLines: 0, exact: true };

  const added = myersAdded(vendorMid, clientMid);
  const result = added
    ? { lines: added, exact: true }
    : { lines: fallbackAdded(vendorMid, clientMid), exact: false };

  // Возвращаем номера строк в координатах клиентского файла (с единицы).
  const lines = result.lines.map((i) => head + i + 1);
  return { regions: toRegions(lines), addedLines: lines.length, exact: result.exact };
}

/**
 * Участки изменений, расширенные на несколько строк в обе стороны.
 *
 * @param {{startLine: number, endLine: number}[]} regions
 * @param {number} padding сколько строк добавить сверху и снизу
 */
export function padRegions(regions, padding = 3) {
  if (!padding) return regions;
  return mergeRegions(regions.map((r) => ({
    startLine: Math.max(1, r.startLine - padding),
    endLine: r.endLine + padding,
  })));
}

/**
 * Текст модуля, в котором оставлены только изменённые строки, а типовые
 * заменены пустыми.
 *
 * Зачем так, а не фильтрация замечаний по номеру строки. Часть правил считает
 * по модулю целиком и выдаёт одно замечание со счётчиком, привязанное к первому
 * вхождению: «Использование устаревшего метода Сообщить() (2)» на строке 62,
 * где стоит вызов ВЕНДОРА, хотя второй вызов — наша вставка. Отфильтровать
 * такое по строке нельзя: либо в отчёт попадёт замечание к типовому коду,
 * либо потеряется замечание к доработке.
 *
 * Если же правила изначально видят только изменённые строки, вопрос снимается:
 * считают они ровно доработку. Номера строк сохраняются — пустые строки
 * занимают место типовых, — поэтому в отчёте указано настоящее место в файле.
 *
 * @param {string} source
 * @param {{startLine: number, endLine: number}[]} regions
 */
export function keepOnlyRegions(source, regions) {
  const lines = String(source ?? '').split(/\r?\n/);
  const keep = new Uint8Array(lines.length + 1);
  for (const region of regions) {
    const from = Math.max(1, region.startLine);
    const to = Math.min(lines.length, region.endLine);
    for (let i = from; i <= to; i += 1) keep[i] = 1;
  }
  return lines.map((line, i) => (keep[i + 1] ? line : '')).join('\n');
}

// --- Внутреннее --------------------------------------------------------------

function normalizeLines(source) {
  return String(source ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    // Хвостовые пробелы и различия отступов не являются доработкой: выгрузка
    // одной и той же процедуры разными версиями платформы может отличаться ими.
    .map((line) => line.replace(/\s+$/, ''));
}

/**
 * Жадный диф Майерса. Возвращает индексы строк, добавленных в `client`,
 * либо null, если различий больше предела.
 */
function myersAdded(vendor, client) {
  const n = vendor.length;
  const m = client.length;
  const max = Math.min(MAX_EDITS, n + m);

  // v[k] — самая дальняя достигнутая позиция по vendor для диагонали k.
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  /** Снимки v после каждого шага — по ним восстанавливается путь. */
  const trace = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // шаг вниз — строка добавлена в client
      } else {
        x = v[k - 1 + offset] + 1; // шаг вправо — строка удалена у client
      }
      let y = x - k;
      while (x < n && y < m && vendor[x] === client[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, vendor, client, d, offset);
    }
  }
  return null;
}

/** Восстанавливает по снимкам, какие строки client были добавлены. */
function backtrack(trace, vendor, client, d, offset) {
  const added = [];
  let x = vendor.length;
  let y = client.length;

  for (let step = d; step > 0; step -= 1) {
    const v = trace[step];
    const k = x - y;
    const down = k === -step || (k !== step && v[k - 1 + offset] < v[k + 1 + offset]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
    }
    if (down) added.push(y - 1);
    x = prevX;
    y = prevY;
  }

  return added.filter((i) => i >= 0).reverse();
}

/**
 * Запасной способ, когда различий слишком много: строка считается авторской,
 * если такой строки нет в модуле поставщика вообще. Грубее дифа — не видит
 * перестановок, — но лучше, чем отказ от анализа.
 */
function fallbackAdded(vendor, client) {
  const known = new Set(vendor.map((line) => line.trim()).filter(Boolean));
  const added = [];
  for (let i = 0; i < client.length; i += 1) {
    const line = client[i].trim();
    if (line && !known.has(line)) added.push(i);
  }
  return added;
}

/**
 * Соседние и подряд идущие строки — в один участок.
 *
 * Экспортируется, потому что тем же способом собираются участки правки,
 * найденные по отчёту конфигуратора о сравнении (`codeAnalyzer`): там строки
 * тоже приходят россыпью номеров, и группировать их надо одинаково.
 */
export function toRegions(lines) {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const regions = [{ startLine: sorted[0], endLine: sorted[0] }];
  for (const line of sorted.slice(1)) {
    const last = regions[regions.length - 1];
    // Разрыв в одну-две строки не считаем границей: это одна правка.
    if (line - last.endLine <= 3) last.endLine = line;
    else regions.push({ startLine: line, endLine: line });
  }
  return regions;
}

function mergeRegions(regions) {
  if (regions.length < 2) return regions;
  const sorted = [...regions].sort((a, b) => a.startLine - b.startLine);
  const out = [sorted[0]];
  for (const region of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (region.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, region.endLine);
    else out.push(region);
  }
  return out;
}
