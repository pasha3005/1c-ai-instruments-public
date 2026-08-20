/**
 * Хранилище результатов аудитов.
 *
 * В коммерческой SaaS-версии здесь была бы PostgreSQL + S3. Для варианта
 * «запускается без установки дополнительного ПО» использована файловая
 * структура: data/audits/<id>/{meta.json, result.json, report.html, report.md}.
 *
 * Интерфейс намеренно асинхронный и минимальный, чтобы замена на СУБД
 * не потребовала изменений в вызывающем коде.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { AUDITS_DIR } from '../config.js';
import { ensureDir, readJson, writeJson, pathExists, rmrf } from '../util/fsx.js';

function auditDir(id) {
  return path.join(AUDITS_DIR, id);
}

export const FILES = {
  meta: 'meta.json',
  result: 'result.json',
  html: 'report.html',
  markdown: 'report.md',
};

/** Создаёт запись аудита в состоянии «выполняется». */
export async function createAudit(id, input) {
  const dir = await ensureDir(auditDir(id));
  const meta = {
    id,
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

/** Пароли не сохраняются на диск — только признак их наличия. */
function sanitizeInput(input) {
  const { password, ...rest } = input || {};
  return { ...rest, hasPassword: Boolean(password) };
}

export async function getMeta(id) {
  return readJson(path.join(auditDir(id), FILES.meta));
}

export async function updateMeta(id, patch) {
  const current = (await getMeta(id)) || { id };
  const next = { ...current, ...patch };
  await writeJson(path.join(auditDir(id), FILES.meta), next);
  return next;
}

/** Сохраняет полный результат анализа и краткую сводку в meta. */
export async function saveResult(id, result) {
  const dir = await ensureDir(auditDir(id));
  await writeJson(path.join(dir, FILES.result), result);
  await updateMeta(id, {
    status: 'done',
    finishedAt: new Date().toISOString(),
    // Длительность анализа показывается в интерфейсе и в истории,
    // но намеренно не попадает в отчёт для заказчика.
    durationMs: result?.durationMs ?? null,
    summary: buildSummary(result),
  });
}

export async function saveReport(id, kind, content) {
  const dir = await ensureDir(auditDir(id));
  const name = FILES[kind];
  if (!name) throw new Error(`Неизвестный вид отчёта: ${kind}`);
  await fs.writeFile(path.join(dir, name), content, 'utf8');
}

export async function readReport(id, kind) {
  const name = FILES[kind];
  if (!name) return null;
  const file = path.join(auditDir(id), name);
  if (!(await pathExists(file))) return null;
  return fs.readFile(file, 'utf8');
}

export async function getResult(id) {
  return readJson(path.join(auditDir(id), FILES.result));
}

export async function markFailed(id, error, durationMs = null) {
  await updateMeta(id, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    durationMs,
    error: error?.message || String(error),
  });
}

/**
 * Аудит остановлен пользователем. Отдельный статус, а не 'failed':
 * в истории прерванное не должно выглядеть как сбой инструмента.
 */
export async function markCancelled(id, durationMs = null, message = 'Аудит прерван пользователем') {
  await updateMeta(id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    durationMs,
    error: message,
  });
}

/** Список аудитов, новые сверху. */
export async function listAudits({ limit = 100 } = {}) {
  await ensureDir(AUDITS_DIR);
  let entries;
  try {
    entries = await fs.readdir(AUDITS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readJson(path.join(AUDITS_DIR, entry.name, FILES.meta));
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return metas.slice(0, limit);
}

export async function deleteAudit(id) {
  await rmrf(auditDir(id));
}

/** Короткая карточка для списка истории. */
function buildSummary(result) {
  const cfg = result?.configuration || {};
  return {
    configName: cfg.synonym || cfg.name || 'Конфигурация',
    configVersion: cfg.version || '',
    vendor: cfg.vendor || '',
    healthScore: result?.scores?.health ?? null,
    updatabilityScore: result?.scores?.updatability ?? null,
    objectCount: result?.metadata?.totals?.objects ?? null,
    findingsCount: result?.findings?.length ?? 0,
    criticalCount: result?.findings?.filter((f) => f.severity === 'critical').length ?? 0,
    vendorCompared: Boolean(result?.vendorComparison?.available),
    analyzedModules: result?.code?.scope?.analyzedModules ?? null,
    totalModules: result?.code?.scope?.totalModules ?? null,
    totalRecords: result?.dataVolume?.available ? result.dataVolume.totalRecords : null,
  };
}
