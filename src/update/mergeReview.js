/**
 * Разбор спорных мест — данные для окна, которое повторяет окно объединения
 * конфигуратора, только в браузере.
 *
 * Зачем это отдельно от отчёта. Отчёт рассказывает, что произошло, и его
 * читают; окно разбора — рабочее место: слева дерево спорных мест, справа
 * основная конфигурация и новая поставка, внизу результат, который правят
 * и сохраняют обратно в выгрузку. Требование пользователя дословно
 * (26.08.2026): «мы полностью повторяем с тобой типовой механизм платформы
 * при обновлении на новый релиз изменённой конфигурации».
 *
 * Откуда берутся тексты. Три исходные версии каждого спорного файла и то,
 * что программа записала сама, разложены объединением по каталогу «Конфликты»
 * (`saveConflictVersions` в `mergeConfig.js`). Результат при этом читается
 * не оттуда, а из самой выгрузки: именно её потом загружают в базу, и правку,
 * сделанную мимо окна — своим редактором, — человек должен увидеть, а не
 * потерять.
 *
 * Состояние разбора (что человек уже решил) лежит рядом с прогоном, а не
 * в результате объединения: результат — снимок работы программы, и дописывать
 * в него решения человека значило бы, что перечитанный отчёт больше
 * не соответствует тому, что было в момент прогона.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { VERSION_FILES, AUTO_ACTIONS } from './mergeConfig.js';
import { changedHunks, splitLines } from './diff3.js';
import { pathExists } from '../util/fsx.js';
import { highlightBslLines, highlightXmlLines } from '../report/bslHighlight.js';

/** Действия, при которых решение остаётся за человеком. */
const MANUAL_ACTIONS = new Set([
  'conflict', 'conflict-binary', 'conflict-too-big', 'conflict-vendor-deleted',
  'conflict-both-added', 'manual-two-way', 'manual-deleted-by-us', 'failed',
]);

/** Человеческое название действия — им подписан узел дерева. */
const ACTION_RU = {
  conflict: 'дважды изменено — не разобрано',
  'conflict-binary': 'двоичный файл изменён обеими сторонами',
  'conflict-too-big': 'файл слишком велик для построчного объединения',
  'conflict-vendor-deleted': 'поставщик удалил, у вас изменено',
  'conflict-both-added': 'добавлено и вами, и поставщиком',
  'manual-two-way': 'прежнее значение поставщика неизвестно',
  'manual-deleted-by-us': 'удалено вами, изменено поставщиком',
  failed: 'файл не объединён',
  'auto-resolved': 'дважды изменено — разобрано программой',
  'auto-by-property': 'правки не пересеклись — разобрано программой',
};

/** Пустое состояние разбора. */
export function emptyReviewState() {
  return { files: {} };
}

/**
 * Плоский перечень спорных файлов прогона.
 *
 * Берутся обе группы результата: «требуют решения» и «разобрано само».
 * Объект попадает в первую группу целиком, даже если часть его файлов
 * программа разобрала сама, поэтому род определяется по ДЕЙСТВИЮ файла,
 * а не по группе объекта.
 */
export function reviewFiles(result) {
  const groups = [...(result?.merge?.manual || []), ...(result?.merge?.auto || [])];
  const seen = new Set();
  const out = [];

  for (const object of groups) {
    for (const element of object.elements || []) {
      const manual = MANUAL_ACTIONS.has(element.action);
      const auto = AUTO_ACTIONS.has(element.action) || (element.resolvedCount || 0) > 0;
      if (!manual && !auto) continue;
      if (seen.has(element.rel)) continue;
      seen.add(element.rel);
      out.push({
        rel: element.rel,
        element: element.element,
        objectKey: object.key,
        objectTitle: object.title,
        objectKind: object.kindRu || object.kind || '',
        status: manual ? 'manual' : 'auto',
        action: element.action,
        actionRu: ACTION_RU[element.action] || element.action,
        note: element.note || '',
        isModule: Boolean(element.isModule),
        versions: element.versions || null,
        conflictCount: element.conflictCount || 0,
        resolvedCount: element.resolvedCount || 0,
        places: places(element),
      });
    }
  }

  out.sort((a, b) => (a.objectTitle || '').localeCompare(b.objectTitle || '', 'ru')
    || (a.element || '').localeCompare(b.element || '', 'ru'));
  return out;
}

function places(element) {
  const out = [];
  for (const item of element.resolved || []) {
    out.push({
      kind: 'auto',
      where: item.where || '',
      how: item.how || '',
      why: item.why || '',
      oursStartLine: item.oursStartLine || 0,
      theirsStartLine: item.theirsStartLine || 0,
      baseStartLine: item.baseStartLine || 0,
      text: {
        ours: item.ours?.lines || [],
        theirs: item.theirs?.lines || [],
        base: item.base?.lines || [],
        result: item.result?.lines || [],
      },
    });
  }
  for (const item of element.conflicts || []) {
    out.push({
      kind: 'manual',
      where: item.where || '',
      how: '',
      why: '',
      oursStartLine: item.oursStartLine || 0,
      theirsStartLine: item.theirsStartLine || 0,
      baseStartLine: item.baseStartLine || 0,
      // При нерешённом месте в выгрузке лежит наша версия — она же и результат.
      text: {
        ours: item.ours?.lines || [],
        theirs: item.theirs?.lines || [],
        base: item.base?.lines || [],
        result: item.ours?.lines || [],
      },
    });
  }
  return out.sort((a, b) => (a.oursStartLine || 0) - (b.oursStartLine || 0));
}

/**
 * Дерево для окна: объект → файл → место.
 *
 * Дерево, а не плоский список, по прямой просьбе пользователя: спорные места
 * читаются от объекта конфигурации, а не от пути внутри выгрузки.
 */
export function buildReview(result, state = emptyReviewState()) {
  const files = reviewFiles(result);
  const byObject = new Map();

  for (const file of files) {
    if (!byObject.has(file.objectKey)) {
      byObject.set(file.objectKey, {
        key: file.objectKey,
        title: file.objectTitle,
        kind: file.objectKind,
        files: [],
      });
    }
    byObject.get(file.objectKey).files.push({ ...file, decision: state.files?.[file.rel] || null });
  }

  const objects = [...byObject.values()];
  for (const object of objects) {
    object.manual = object.files.filter((f) => f.status === 'manual').length;
    object.auto = object.files.filter((f) => f.status === 'auto').length;
    object.left = object.files.filter((f) => !f.decision).length;
  }

  const totals = {
    files: files.length,
    manual: files.filter((f) => f.status === 'manual').length,
    auto: files.filter((f) => f.status === 'auto').length,
    decided: files.filter((f) => state.files?.[f.rel]).length,
    /** Всё, что ждёт человека: и нерешённое, и неподтверждённое. */
    left: files.filter((f) => !state.files?.[f.rel]).length,
    /** Из них требуют именно решения — программа их не разобрала. */
    leftManual: files.filter((f) => f.status === 'manual' && !state.files?.[f.rel]).length,
    /** А эти разобраны программой и ждут подтверждения. */
    leftAuto: files.filter((f) => f.status === 'auto' && !state.files?.[f.rel]).length,
  };

  return { objects, totals };
}

/**
 * Сколько спорных мест ещё ждут человека.
 *
 * Это число — застава перед записью в информационную базу: пока оно не ноль,
 * загрузка не предлагается и не выполняется (требование пользователя
 * 26.08.2026). Файл, который человек разобрал в окне или принял как есть,
 * из счёта уходит.
 *
 * **Считаются и места, разобранные программой.** Требование пользователя
 * 27.08.2026: «места, которые ты разобрал автоматически, нужно обязательно
 * выводить для просмотра и подтверждения». Решение программы — предположение
 * о том, чего человек хотел; пока он на него не взглянул, оно не проверено,
 * а в базу уходит именно оно. Подтвердить их можно и разом — кнопкой в окне
 * разбора, но осознанно и после того, как список показан.
 */
export function unresolvedCount(result, state = emptyReviewState()) {
  return reviewFiles(result).filter((f) => !state.files?.[f.rel]).length;
}

/** Те же места по родам: что требует решения, а что — подтверждения. */
export function unresolvedByKind(result, state = emptyReviewState()) {
  const left = reviewFiles(result).filter((f) => !state.files?.[f.rel]);
  return {
    total: left.length,
    manual: left.filter((f) => f.status === 'manual').length,
    auto: left.filter((f) => f.status === 'auto').length,
  };
}

/** Пути мест, разобранных программой и ещё не подтверждённых человеком. */
export function autoFilesToConfirm(result, state = emptyReviewState()) {
  return reviewFiles(result)
    .filter((f) => f.status === 'auto' && !state.files?.[f.rel])
    .map((f) => f.rel);
}

// --- Чтение и запись ---------------------------------------------------------

/** Путь внутри каталога, без выхода наружу: `rel` приходит из браузера. */
export function safeJoin(root, rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('Недопустимый путь файла');
  }
  const full = path.resolve(root, normalized);
  const inside = path.resolve(root);
  if (full !== inside && !full.startsWith(inside + path.sep)) {
    throw new Error('Недопустимый путь файла');
  }
  return full;
}

/** Каталог с исходными версиями файла, если объединение его сохранило. */
function versionsDir(result, file) {
  if (!result.conflictDir || !file.versions) return null;
  return path.join(result.conflictDir, String(file.versions));
}

async function readVersion(dir, name, ext) {
  if (!dir) return null;
  const file = path.join(dir, `${name}${ext}`);
  if (!(await pathExists(file))) return null;
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Всё, что нужно окну по одному файлу: три исходные версии, автоматический
 * результат и то, что лежит в выгрузке сейчас.
 */
export async function readReviewFile(result, state, rel) {
  const file = reviewFiles(result).find((f) => f.rel === rel);
  if (!file) throw new Error('Этот файл не значится среди спорных мест прогона');

  const ext = path.extname(rel) || '.txt';
  const dir = versionsDir(result, file);
  const [base, theirs, ours, auto] = await Promise.all([
    readVersion(dir, VERSION_FILES.base, ext),
    readVersion(dir, VERSION_FILES.theirs, ext),
    readVersion(dir, VERSION_FILES.ours, ext),
    readVersion(dir, VERSION_FILES.auto, ext),
  ]);

  let current = null;
  try {
    const full = safeJoin(result.mergedDir, rel);
    current = (await pathExists(full)) ? await fs.readFile(full, 'utf8') : null;
  } catch {
    current = null;
  }

  // Каждое место ищется в тексте ПО СОДЕРЖИМОМУ, а не по номеру строки.
  // Номер участка задан в координатах объединения — своих у каждой стороны, —
  // и подсветить по нему значило бы показать в левой колонке одну строку,
  // а в правой другую. Живой случай 26.08.2026: слева подсвечивался
  // «#КонецОбласти», справа — настоящая правка.
  const places = (file.places || []).map((place) => ({
    ...place,
    range: {
      ours: locate(ours, place.text.ours, place.oursStartLine),
      theirs: locate(theirs, place.text.theirs, place.theirsStartLine),
      base: locate(base, place.text.base, place.baseStartLine),
      result: locate(current, place.text.result, place.oursStartLine),
    },
    // Сами строки участка окну не нужны: он показывает файлы целиком.
    text: undefined,
  }));

  // Раскладка и цвета считаются на паре, которую человек видит рядом: слева
  // всегда наша версия, справа — та, на которую он переключил правую колонку.
  const vsTheirs = alignSides(ours, theirs);
  const vsBase = alignSides(ours, base);

  return {
    ...file,
    places,
    decision: state.files?.[rel] || null,
    // Читаемые колонки уходят уже подсвеченными: раскрашивать их в браузере
    // значило бы держать там второй лексер 1С.
    base: renderSide(base, ext),
    theirs: renderSide(theirs, ext),
    ours: renderSide(ours, ext),
    // Раскладка своя у каждой пары: переключив правую колонку на текущую
    // поставку, человек ждёт выравнивания и отличий именно от неё.
    align: { theirs: vsTheirs, base: vsBase },
    // Автоматический результат целиком не отдаётся — возврат к нему делает
    // сервер. Окну достаточно знать, есть ли к чему возвращаться.
    hasAuto: auto != null,
    current,
    // Двоичный файл в окне не правится: показать его текстом нечем, а записать
    // обратно «почти то же самое» значило бы испортить макет или картинку.
    editable: current !== null && !isBinary(current),
    versionsMissing: !dir,
  };
}

/**
 * Автоматический результат объединения одного файла — тот, что программа
 * записала сама. Нужен кнопке «Вернуть вариант программы»; окну целиком
 * не отдаётся, чтобы не гонять по сети ещё одну копию модуля.
 */
export async function readAutoResult(result, rel) {
  const file = reviewFiles(result).find((f) => f.rel === rel);
  if (!file) throw new Error('Этот файл не значится среди спорных мест прогона');
  return readVersion(versionsDir(result, file), VERSION_FILES.auto, path.extname(rel) || '.txt');
}

/** Насколько большой файл ещё имеет смысл подсвечивать. */
const HIGHLIGHT_LIMIT = 2_000_000;

/**
 * Одна читаемая колонка: подсвеченные строки либо честное «версии нет».
 *
 * Подсветка та же, что в отчёте о качестве кода, — на том же лексере
 * (`highlightBslLines`). Требование пользователя 26.08.2026: код всегда
 * оформляется одинаково, где бы он ни показывался.
 */
function renderSide(text, ext) {
  if (text == null) return null;
  if (isBinary(text)) return { lines: [], binary: true };
  return { lines: highlightLines(text, ext) };
}

/** Подсветка по виду файла. Слишком большой файл отдаётся без раскраски. */
export function highlightLines(text, ext) {
  const plain = () => String(text).replace(/\r\n?/g, '\n').split('\n').map(escapeHtml);
  if (String(text).length > HIGHLIGHT_LIMIT) return plain();
  if (ext === '.bsl') return highlightBslLines(text);
  if (/^\.(xml|xsd|html?|svg)$/i.test(ext)) return highlightXmlLines(text);
  return plain();
}

/**
 * Раскладка двух версий строка в строку — как в окне сравнения конфигуратора.
 *
 * Там, где у одной стороны строк больше, у другой встают пустые строки-подпорки,
 * и общий код обеих версий оказывается на одном уровне. Без этого достаточно
 * одной процедуры, добавленной поставщиком выше по модулю, чтобы весь
 * остальной код в колонках разъехался, и сравнивать построчно стало нельзя.
 *
 * Возвращаются НОМЕРА строк, а не сам текст: строки уже подсвечены и уходят
 * отдельно, а гонять их по сети во второй раз ради выравнивания незачем.
 * Ноль означает подпорку — в этой версии строки нет.
 *
 * @returns {{left: number[], right: number[], marks: string[],
 *            hunks: {row: number, kind: string}[]}}
 */
export function alignSides(leftText, rightText) {
  const empty = { left: [], right: [], marks: [], hunks: [] };
  if (leftText == null || rightText == null) return empty;

  const left = splitLines(leftText).lines;
  const right = splitLines(rightText).lines;
  const hunks = changedHunks(left, right) || [];

  const rows = { left: [], right: [], marks: [], hunks: [] };
  let l = 0;
  let r = 0;

  const same = (count) => {
    for (let i = 0; i < count; i += 1) {
      rows.left.push(l + i + 1);
      rows.right.push(r + i + 1);
      rows.marks.push('');
    }
    l += count;
    r += count;
  };

  for (const hunk of hunks) {
    same(hunk.baseStart - l);

    const removed = hunk.baseEnd - hunk.baseStart;
    const added = hunk.sideEnd - hunk.sideStart;
    const both = removed > 0 && added > 0;
    rows.hunks.push({ row: rows.marks.length, kind: both ? 'chg' : added ? 'add' : 'del' });

    // Строк в участке столько, сколько их у длинной стороны; короткая
    // добирается подпорками.
    for (let i = 0; i < Math.max(removed, added); i += 1) {
      const hasLeft = i < removed;
      const hasRight = i < added;
      rows.left.push(hasLeft ? hunk.baseStart + i + 1 : 0);
      rows.right.push(hasRight ? hunk.sideStart + i + 1 : 0);
      rows.marks.push(both ? 'chg' : hasRight ? 'add' : 'del');
    }
    l = hunk.baseEnd;
    r = hunk.sideEnd;
  }
  same(Math.max(left.length - l, right.length - r));

  return rows;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Где в тексте лежит участок — поиск по строкам, а не по номеру.
 *
 * Сравниваются обрезанные строки: отступ у сторон бывает разный, а участок
 * от этого другим не становится. Из нескольких совпадений берётся ближайшее
 * к подсказке — номеру строки из объединения: у повторяющихся строк
 * («КонецПроцедуры», пустая) совпадений много, и ближайшее почти всегда то.
 *
 * @returns {{start: number, end: number}|null} строки 1-based, обе включительно
 */
export function locate(text, fragment, hintLine = 0) {
  if (text == null) return null;
  const needle = (fragment || [])
    .map((l) => String(l).trim())
    .filter((l, i, a) => !(i === a.length - 1 && !l));
  if (!needle.length) return hintLine ? { start: hintLine, end: hintLine, empty: true } : null;

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  let best = null;
  for (let i = 0; i + needle.length <= lines.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (lines[i + j] !== needle[j]) { hit = false; break; }
    }
    if (!hit) continue;
    const start = i + 1;
    const distance = Math.abs(start - (hintLine || start));
    if (!best || distance < best.distance) best = { start, end: i + needle.length, distance };
    if (distance === 0) break;
  }
  return best ? { start: best.start, end: best.end } : null;
}

/** Нулевой байт в тексте означает, что файл не текстовый. */
function isBinary(text) {
  return text.indexOf(String.fromCharCode(0)) !== -1;
}

/**
 * Записывает решение человека в выгрузку.
 *
 * Пишется ровно то, что он видел в нижнем окне: никакой доводки, никаких
 * маркеров конфликта. Перевод строк приводится к тому, что был в файле, —
 * иначе вся выгрузка после правки одного модуля выглядит переписанной.
 */
export async function writeReviewFile(result, rel, text) {
  const file = reviewFiles(result).find((f) => f.rel === rel);
  if (!file) throw new Error('Этот файл не значится среди спорных мест прогона');
  const full = safeJoin(result.mergedDir, rel);
  if (!(await pathExists(path.dirname(full)))) {
    throw new Error('Каталог выгрузки больше не существует — выполните объединение заново');
  }

  let eol = '\r\n';
  try {
    const before = await fs.readFile(full, 'utf8');
    eol = before.includes('\r\n') ? '\r\n' : '\n';
  } catch {
    /* файла может не быть — тогда пишем в принятом для выгрузки виде */
  }
  const normalized = String(text).replace(/\r\n?/g, '\n').split('\n').join(eol);
  await fs.writeFile(full, normalized, 'utf8');
  return { rel, bytes: Buffer.byteLength(normalized, 'utf8') };
}
