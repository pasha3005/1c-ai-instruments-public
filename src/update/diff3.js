/**
 * Трёхстороннее построчное объединение — то же, что делает конфигуратор 1С
 * при обновлении конфигурации, находящейся на поддержке.
 *
 * Три стороны и их роли:
 *
 *   base   — СТАРАЯ конфигурация поставщика: то, с чего начинали обе стороны;
 *   ours   — ОСНОВНАЯ конфигурация базы: правки интегратора поверх base;
 *   theirs — НОВАЯ конфигурация поставщика: правки вендора поверх той же base.
 *
 * Ровно это и означает «дважды изменённое свойство» в терминах 1С: участок,
 * который относительно старой поставки изменили и мы, и вендор. Без общей базы
 * такой участок отличить нельзя вовсе — двустороннее сравнение основной
 * конфигурации с новой поставкой показывает различие, но не говорит, кто его
 * внёс, и объединять по нему нечего.
 *
 * Правила разрешения — те же, что у платформы:
 *
 *   • изменил только вендор  → берём его правку (обновление и делается ради этого);
 *   • изменил только клиент  → оставляем нашу (иначе обновление затирало бы доработку);
 *   • изменили оба одинаково → изменение одно, берётся как есть;
 *   • изменили оба по-разному → КОНФЛИКТ: в файл пишется наша версия,
 *     а участок целиком уходит в отчёт на ручное решение.
 *
 * Почему при конфликте в файл пишется наша версия, а не маркеры вида
 * «<<<<<<<», как в системах контроля версий. Файл выгрузки должен остаться
 * загружаемым в конфигурацию: маркеры сломали бы и XML, и модуль на языке 1С,
 * а загрузить результат — обязательный следующий шаг. Наша версия — безопасный
 * выбор по той же причине, по которой платформа по умолчанию сохраняет
 * доработку: потерянная правка вендора обнаружится при следующем обновлении,
 * потерянная доработка — сломанным бизнес-процессом у клиента.
 */

import { editScript } from '../analyze/bsl/moduleDiff.js';

/**
 * Разбивает текст на строки так, чтобы обратная сборка была точной:
 * BOM и вид перевода строки запоминаются отдельно и возвращаются на место
 * при записи файла (`joinLines`). Модули 1С выгружаются в UTF-8 с BOM,
 * и потерять его нельзя — платформа читает файл по BOM.
 */
export function splitLines(text) {
  const raw = String(text ?? '');
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? raw.slice(1) : raw;
  return {
    lines: body.split(/\r?\n/),
    bom: hasBom,
    eol: body.includes('\r\n') ? '\r\n' : '\n',
  };
}

/** Обратная операция к `splitLines`. */
export function joinLines(lines, { bom = false, eol = '\r\n' } = {}) {
  return `${bom ? '﻿' : ''}${lines.join(eol)}`;
}

/**
 * Участки, которыми одна сторона отличается от базы.
 *
 * Диапазоны полуоткрытые: `[baseStart, baseEnd)` в координатах базы,
 * `[sideStart, sideEnd)` — в координатах стороны. Пустой диапазон базы
 * (`baseStart === baseEnd`) — чистая вставка, пустой диапазон стороны —
 * чистое удаление.
 *
 * @returns {{baseStart: number, baseEnd: number, sideStart: number, sideEnd: number}[]|null}
 *   null — различий больше предела дифа, объединять построчно нечем.
 */
export function changedHunks(base, side) {
  const script = editScript(base, side);
  if (!script) return null;

  const hunks = [];
  let current = null;
  let b = 0;
  let s = 0;

  for (const op of script) {
    if (op.op === 'equal') {
      current = null;
      b += 1;
      s += 1;
      continue;
    }
    if (!current) {
      current = { baseStart: b, baseEnd: b, sideStart: s, sideEnd: s };
      hunks.push(current);
    }
    if (op.op === 'insert') {
      s += 1;
      current.sideEnd = s;
    } else {
      b += 1;
      current.baseEnd = b;
    }
  }
  return hunks;
}

/**
 * Трёхстороннее объединение трёх текстов.
 *
 * @param {string} baseText старая конфигурация поставщика
 * @param {string} oursText основная конфигурация базы
 * @param {string} theirsText новая конфигурация поставщика
 * @returns {{
 *   ok: boolean, reason?: string,
 *   lines: string[],
 *   conflicts: {baseStartLine: number, baseEndLine: number,
 *               oursStartLine: number, theirsStartLine: number, mergedStartLine: number,
 *               base: string[], ours: string[], theirs: string[],
 *               placed: 'theirs', placedLines: number}[],
 *   fromVendor: number, keptOurs: number, sameBoth: number,
 *   clean: boolean, changed: boolean,
 * }}
 */
export function merge3(baseText, oursText, theirsText) {
  const base = splitLines(baseText).lines;
  const ours = splitLines(oursText).lines;
  const theirs = splitLines(theirsText).lines;

  const ourHunks = changedHunks(base, ours);
  const theirHunks = changedHunks(base, theirs);
  if (!ourHunks || !theirHunks) {
    return {
      ok: false,
      reason: 'различий слишком много для построчного объединения',
      lines: ours,
      conflicts: [],
      fromVendor: 0,
      keptOurs: 0,
      sameBoth: 0,
      clean: false,
      changed: false,
    };
  }

  // Общий список участков в порядке следования по базе. Чистые вставки идут
  // раньше замен в той же точке: так вставка не втягивается в кластер соседней
  // замены, а порядок разбора не зависит от того, чья сторона попалась первой.
  const all = [
    ...ourHunks.map((h) => ({ ...h, side: 'ours' })),
    ...theirHunks.map((h) => ({ ...h, side: 'theirs' })),
  ].sort((a, b) => a.baseStart - b.baseStart
    || (a.baseEnd - a.baseStart) - (b.baseEnd - b.baseStart)
    || (a.side === b.side ? 0 : a.side === 'ours' ? -1 : 1));

  const out = [];
  const conflicts = [];
  let fromVendor = 0;
  let keptOurs = 0;
  let sameBoth = 0;
  let cursor = 0; // позиция в базе, до которой уже собран результат
  let i = 0;

  while (i < all.length) {
    const cluster = [all[i]];
    let clusterStart = all[i].baseStart;
    let clusterEnd = all[i].baseEnd;
    i += 1;
    while (i < all.length && joinsCluster({ clusterStart, clusterEnd }, all[i])) {
      cluster.push(all[i]);
      clusterEnd = Math.max(clusterEnd, all[i].baseEnd);
      i += 1;
    }

    // Строки базы до кластера совпадают у всех трёх сторон.
    for (let b = cursor; b < clusterStart; b += 1) out.push(base[b]);

    const clusterOurs = cluster.filter((h) => h.side === 'ours');
    const clusterTheirs = cluster.filter((h) => h.side === 'theirs');
    const oursLines = sideReplacement(base, ours, clusterOurs, clusterStart, clusterEnd);
    const theirsLines = sideReplacement(base, theirs, clusterTheirs, clusterStart, clusterEnd);

    if (!clusterTheirs.length) {
      out.push(...oursLines);
      keptOurs += 1;
    } else if (!clusterOurs.length) {
      out.push(...theirsLines);
      fromVendor += 1;
    } else if (sameLines(oursLines, theirsLines)) {
      // Одна и та же правка сделана и нами, и вендором: объединять нечего.
      out.push(...oursLines);
      sameBoth += 1;
    } else {
      // Дважды изменённое место. В результат кладётся версия ПОСТАВЩИКА —
      // требование пользователя (27.08.2026): «цель-то в том, чтобы обновиться
      // на новую конфигурацию поставщика, сохранив по максимуму наши
      // доработки». Своя версия никуда не пропадает: место значится спорным,
      // прогон стоит, пока его не разберут, а в окне разбора у каждого участка
      // есть выбор, откуда брать текст.
      conflicts.push({
        baseStartLine: clusterStart + 1,
        baseEndLine: clusterEnd,
        oursStartLine: sideIndexAtBase(ourHunks, clusterStart) + 1,
        theirsStartLine: sideIndexAtBase(theirHunks, clusterStart) + 1,
        mergedStartLine: out.length + 1,
        base: base.slice(clusterStart, clusterEnd),
        ours: oursLines,
        theirs: theirsLines,
        /** Что из этого лежит в результате и сколько там строк. */
        placed: 'theirs',
        placedLines: theirsLines.length,
      });
      out.push(...theirsLines);
    }

    cursor = clusterEnd;
  }

  for (let b = cursor; b < base.length; b += 1) out.push(base[b]);

  return {
    ok: true,
    lines: out,
    conflicts,
    fromVendor,
    keptOurs,
    sameBoth,
    clean: conflicts.length === 0,
    changed: !sameLines(out, ours),
  };
}

/**
 * Присоединяется ли участок к текущему кластеру.
 *
 * Кластер — это группа взаимно пересекающихся участков, которую приходится
 * решать целиком. Соприкасающиеся (но не пересекающиеся) правки в кластер
 * НЕ объединяются: правка вендора в строках 10–12 и наша в 12–15 независимы,
 * и объявлять их конфликтом значило бы гонять пользователя вручную по местам,
 * которые платформа объединяет сама.
 *
 * Единственное исключение — две чистые вставки в одну и ту же точку базы:
 * пересечения нет, но и порядка между ними нет, а в модуле 1С «оба сразу»
 * запросто означает две копии одной процедуры. Такое считаем конфликтом.
 */
function joinsCluster(cluster, hunk) {
  if (hunk.baseStart < cluster.clusterEnd) return true;
  return hunk.baseStart === hunk.baseEnd
    && cluster.clusterStart === cluster.clusterEnd
    && hunk.baseStart === cluster.clusterStart;
}

/**
 * Как выглядит диапазон базы `[from, to)` в версии одной стороны: строки внутри
 * её участков берутся из неё, остальные совпадают с базой.
 */
function sideReplacement(base, side, hunks, from, to) {
  const out = [];
  let b = from;
  // Участки кластера уже отсортированы по базе и целиком лежат в [from, to).
  for (const hunk of hunks) {
    for (; b < hunk.baseStart; b += 1) out.push(base[b]);
    for (let s = hunk.sideStart; s < hunk.sideEnd; s += 1) out.push(side[s]);
    b = Math.max(b, hunk.baseEnd);
  }
  for (; b < to; b += 1) out.push(base[b]);
  return out;
}

/** Какой строке стороны соответствует строка базы, если она вне её правок. */
function sideIndexAtBase(hunks, baseIndex) {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.baseEnd > baseIndex) break;
    delta += (hunk.sideEnd - hunk.sideStart) - (hunk.baseEnd - hunk.baseStart);
  }
  return baseIndex + delta;
}

function sameLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Двустороннее сравнение — для режима без старой поставки.
 *
 * Объединять по нему нельзя (неизвестно, кто внёс различие), но показать
 * пользователю, чем основная конфигурация отличается от новой поставки,
 * можно и нужно: именно эти участки ему предстоит разобрать вручную.
 *
 * @returns {{oursStartLine: number, theirsStartLine: number,
 *            ours: string[], theirs: string[]}[]}
 */
export function twoWayHunks(oursText, theirsText, { limit = 200 } = {}) {
  const ours = splitLines(oursText).lines;
  const theirs = splitLines(theirsText).lines;
  const hunks = changedHunks(ours, theirs);
  if (!hunks) return [];

  return hunks.slice(0, limit).map((hunk) => ({
    oursStartLine: hunk.baseStart + 1,
    theirsStartLine: hunk.sideStart + 1,
    ours: ours.slice(hunk.baseStart, hunk.baseEnd),
    theirs: theirs.slice(hunk.sideStart, hunk.sideEnd),
  }));
}
