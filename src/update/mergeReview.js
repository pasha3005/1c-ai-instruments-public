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
import { VERSION_FILES } from './mergeConfig.js';
import { pathExists } from '../util/fsx.js';

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
      const auto = element.action === 'auto-resolved' || (element.resolvedCount || 0) > 0;
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
      result: item.result?.lines || [],
      ours: item.ours?.lines || [],
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
      result: [],
      ours: item.ours?.lines || [],
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
    object.left = object.files.filter((f) => f.status === 'manual' && !f.decision).length;
  }

  const totals = {
    files: files.length,
    manual: files.filter((f) => f.status === 'manual').length,
    auto: files.filter((f) => f.status === 'auto').length,
    decided: files.filter((f) => state.files?.[f.rel]).length,
    left: files.filter((f) => f.status === 'manual' && !state.files?.[f.rel]).length,
  };

  return { objects, totals };
}

/**
 * Сколько спорных мест ещё ждут решения человека.
 *
 * Это число — застава перед записью в информационную базу: пока оно не ноль,
 * загрузка не предлагается и не выполняется (требование пользователя
 * 26.08.2026). Файл, который человек разобрал в окне или принял как есть,
 * из счёта уходит.
 */
export function unresolvedCount(result, state = emptyReviewState()) {
  return reviewFiles(result)
    .filter((f) => f.status === 'manual' && !state.files?.[f.rel]).length;
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

  return {
    ...file,
    decision: state.files?.[rel] || null,
    base,
    theirs,
    ours,
    auto,
    current,
    // Двоичный файл в окне не правится: показать его текстом нечем, а записать
    // обратно «почти то же самое» значило бы испортить макет или картинку.
    editable: current !== null && !isBinary(current),
    versionsMissing: !dir,
  };
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
