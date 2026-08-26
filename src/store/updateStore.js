/**
 * Хранилище прогонов обновления нетиповой конфигурации.
 *
 * Отдельно от аудитов (`store/auditStore.js`), а не общей таблицей с полем
 * «вид»: у обновления другой состав данных (три конфигурации вместо одной,
 * перечень объединённого вместо замечаний) и другая судьба — каталог выгрузки
 * с результатом объединения нужен ПОСЛЕ прогона, потому что из него потом
 * загружают конфигурацию. Смешивать это с историей обследований значило бы
 * получить два непохожих объекта под одним именем.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { DATA_DIR } from '../config.js';
import { ensureDir, readJson, writeJson, pathExists, rmrf } from '../util/fsx.js';

export const UPDATES_DIR = path.join(DATA_DIR, 'updates');

export const FILES = {
  meta: 'meta.json',
  result: 'result.json',
  html: 'update.html',
  /**
   * Что человек уже разобрал в окне спорных мест.
   *
   * Отдельным файлом от результата: результат — снимок работы программы,
   * и отчёт по нему пересобирается (`freshReport`). Решения человека приходят
   * позже, иногда через день, и подмешивать их в снимок значило бы, что
   * перечитанный отчёт больше не соответствует моменту прогона.
   */
  review: 'merge-review.json',
};

function runDir(id) {
  return path.join(UPDATES_DIR, id);
}

/** Пароль на диск не пишется — только признак того, что он был задан. */
function sanitizeInput(input) {
  const { password, ...rest } = input || {};
  return { ...rest, hasPassword: Boolean(password) };
}

export async function createRun(id, input) {
  const dir = await ensureDir(runDir(id));
  const meta = {
    id,
    kind: 'update',
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    input: sanitizeInput(input),
    summary: null,
    error: null,
    /** Загружен ли результат в конфигурацию базы и когда. */
    loadedAt: null,
    loadError: null,
  };
  await writeJson(path.join(dir, FILES.meta), meta);
  return meta;
}

export async function getMeta(id) {
  return readJson(path.join(runDir(id), FILES.meta));
}

export async function updateMeta(id, patch) {
  const current = (await getMeta(id)) || { id };
  const next = { ...current, ...patch };
  await writeJson(path.join(runDir(id), FILES.meta), next);
  return next;
}

export async function saveResult(id, result) {
  const dir = await ensureDir(runDir(id));
  await writeJson(path.join(dir, FILES.result), result);
  await updateMeta(id, {
    status: 'done',
    finishedAt: new Date().toISOString(),
    durationMs: result?.durationMs ?? null,
    summary: buildSummary(result),
  });
}

export async function getResult(id) {
  return readJson(path.join(runDir(id), FILES.result));
}

/** Состояние разбора спорных мест: `{ files: { <путь>: { mode, at } } }`. */
export async function getReviewState(id) {
  return (await readJson(path.join(runDir(id), FILES.review))) || { files: {} };
}

/**
 * Помечает файл разобранным (или снимает пометку, если `decision` пуст).
 *
 * Пометка нужна не ради статистики: пока хоть один спорный файл не разобран,
 * загрузка в информационную базу не предлагается и не выполняется.
 */
export async function setReviewDecision(id, rel, decision) {
  const dir = await ensureDir(runDir(id));
  const state = await getReviewState(id);
  const files = { ...(state.files || {}) };
  if (decision) files[rel] = { ...decision, at: new Date().toISOString() };
  else delete files[rel];
  const next = { ...state, files };
  await writeJson(path.join(dir, FILES.review), next);
  return next;
}

export async function saveReport(id, html) {
  const dir = await ensureDir(runDir(id));
  await fs.writeFile(path.join(dir, FILES.html), html, 'utf8');
}

export async function readReport(id) {
  const file = path.join(runDir(id), FILES.html);
  if (!(await pathExists(file))) return null;
  return fs.readFile(file, 'utf8');
}

export async function markFailed(id, error, durationMs = null) {
  await updateMeta(id, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    durationMs,
    error: error?.message || String(error),
  });
}

export async function markCancelled(id, durationMs = null, message = 'Объединение прервано пользователем') {
  await updateMeta(id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    durationMs,
    error: message,
  });
}

export async function listRuns({ limit = 50 } = {}) {
  await ensureDir(UPDATES_DIR);
  let entries;
  try {
    entries = await fs.readdir(UPDATES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readJson(path.join(UPDATES_DIR, entry.name, FILES.meta));
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return metas.slice(0, limit);
}

export async function deleteRun(id) {
  await rmrf(runDir(id));
}

/**
 * Короткая карточка для списка и для интерфейса.
 *
 * Главное число здесь — сколько мест требует ручного решения: именно оно
 * определяет, сколько работы осталось человеку.
 */
function buildSummary(result) {
  const merge = result?.merge || {};
  const totals = merge.totals || {};
  return {
    // Каким путём шло обновление: типовым (платформа) или объединением.
    updateMode: result?.mode === 'typical' ? 'typical' : 'merge',
    mode: merge.mode || null,
    twiceChanged: result?.typical?.twiceChanged?.length ?? null,
    mainConfig: result?.configs?.main?.name || '',
    mainVersion: result?.configs?.main?.version || '',
    targetVersion: result?.configs?.target?.version || '',
    baseVersion: result?.configs?.base?.version || '',
    files: totals.files ?? null,
    fromVendor: (totals.fromVendor ?? 0) + (totals.merged ?? 0),
    autoResolved: totals.autoResolved ?? 0,
    manualObjects: merge.manualCount ?? 0,
    conflicted: (totals.conflicted ?? 0) + (totals.manual ?? 0),
    addedByVendor: totals.addedByVendor ?? 0,
    removedByVendor: totals.removedByVendor ?? 0,
    mergedDir: result?.mergedDir || '',
    loaded: Boolean(result?.loaded),
    dbUpdated: Boolean(result?.dbUpdated),
    // Обработчики обновления: главное — дошли ли до них и всё ли доделано.
    handlersDone: result?.handlers ? result.handlers.deferredStatus === '' : null,
    // Открылась ли форма результатов обновления: если нет, человек следил за
    // отложенными обработчиками сам — это стоит помнить о прогоне.
    formOpened: result?.handlers?.form ? result.handlers.form.opened === true : null,
    // Подтверждала ли программа легальность получения обновления: это запись
    // в базу от имени пользователя, и в истории прогонов ей место.
    legalityConfirmed: result?.handlers?.legality
      ? result.handlers.legality.confirmed === true
      : null,
    checkErrors: (result?.checks?.config?.errors?.length ?? 0)
      + (result?.checks?.extensionsSyntax?.errors?.length ?? 0)
      + (result?.checks?.extensions?.errors?.length ?? 0),
  };
}
