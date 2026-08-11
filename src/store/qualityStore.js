/**
 * Хранилище прогонов проверки качества кода.
 *
 * Своё, а не общее с обследованием: у проверки качества другой состав входных
 * данных (источником может быть хранилище конфигурации, а не база) и другой
 * результат — один раздел с замечаниями вместо полного обследования. Смешав
 * их в одном списке, мы получили бы историю, где под одним именем лежат
 * несопоставимые вещи.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { DATA_DIR } from '../config.js';
import { ensureDir, readJson, writeJson, pathExists } from '../util/fsx.js';

export const QUALITY_DIR = path.join(DATA_DIR, 'quality');

export const FILES = {
  meta: 'meta.json',
  result: 'result.json',
  html: 'quality.html',
};

function runDir(id) {
  return path.join(QUALITY_DIR, id);
}

/** Пароли на диск не пишутся — только признак того, что они были заданы. */
function sanitizeInput(input) {
  const { password, repositoryPassword, ...rest } = input || {};
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasRepositoryPassword: Boolean(repositoryPassword),
  };
}

export async function createRun(id, input) {
  const dir = await ensureDir(runDir(id));
  const meta = {
    id,
    kind: 'quality',
    status: 'running',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    input: sanitizeInput(input),
    summary: null,
    error: null,
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

export async function markCancelled(id, durationMs = null, message = 'Проверка прервана пользователем') {
  await updateMeta(id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    durationMs,
    error: message,
  });
}

export async function listRuns({ limit = 50 } = {}) {
  if (!(await pathExists(QUALITY_DIR))) return [];
  const names = (await fs.readdir(QUALITY_DIR)).sort().reverse().slice(0, limit);
  const items = [];
  for (const name of names) {
    const meta = await readJson(path.join(QUALITY_DIR, name, FILES.meta));
    if (meta) items.push(meta);
  }
  return items;
}

/** Короткая сводка для истории и для интерфейса. */
function buildSummary(result) {
  const bySeverity = result?.bySeverity || {};
  return {
    source: result?.source || 'infobase',
    configName: result?.configuration?.synonym || result?.configuration?.name || '',
    configVersion: result?.configuration?.version || '',
    modules: result?.totals?.modules ?? null,
    analyzedModules: result?.totals?.analyzedModules ?? null,
    findings: result?.totals?.findings ?? 0,
    critical: bySeverity.critical ?? 0,
    high: bySeverity.high ?? 0,
    authors: result?.totals?.authors ?? 0,
    repositories: result?.repositories?.length ?? null,
    periodFrom: result?.period?.from || '',
    periodTo: result?.period?.to || '',
  };
}
