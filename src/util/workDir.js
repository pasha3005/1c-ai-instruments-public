/**
 * Работа с каталогом выгрузки для повторного запуска аудита.
 *
 * После прерывания в каталоге остаётся незавершённая выгрузка, а `ibcmd`
 * отказывается писать в непустой каталог. Поэтому повторный запуск требует
 * очистки — но каталог указывает пользователь, и удалять из него что-либо
 * без явного подтверждения нельзя: там может лежать что угодно.
 *
 * Отсюда два шага: сначала осмотр (что именно будет удалено), затем очистка
 * по отдельному запросу, уже после подтверждения на форме.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { DEFAULT_WORK_DIR } from '../config.js';
import { pathExists, rmrf, humanSize } from './fsx.js';

/** Каталоги, которые создаёт сам аудит. Всё остальное — чужое. */
const OWN_ENTRIES = new Set(['config', 'extensions', 'live', 'vendor', 'vendor-db', 'vendor-compare']);

function resolveDir(workDir) {
  const value = String(workDir || '').trim();
  if (!value) return DEFAULT_WORK_DIR;
  const resolved = path.resolve(value);
  // Защита от очевидных промахов: корень диска чистить нельзя.
  if (path.dirname(resolved) === resolved) {
    throw new Error('Нельзя использовать корень диска как каталог для выгрузки');
  }
  return resolved;
}

/**
 * Опись каталога: что там лежит и сколько это занимает.
 * @returns {Promise<{dir: string, exists: boolean, entries: object[], total: number, ownCount: number, foreignCount: number, sizeText: string}>}
 */
export async function inspectWorkDir(workDir) {
  const dir = resolveDir(workDir);

  if (!(await pathExists(dir))) {
    return { dir, exists: false, entries: [], total: 0, ownCount: 0, foreignCount: 0, sizeText: '' };
  }

  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = [];
  let bytes = 0;

  for (const entry of dirents) {
    const full = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    const size = isDir ? await dirSizeFast(full) : (await fs.stat(full)).size;
    bytes += size;
    entries.push({
      name: entry.name,
      isDir,
      own: OWN_ENTRIES.has(entry.name),
      sizeText: humanSize(size),
    });
  }

  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'ru'));

  return {
    dir,
    exists: true,
    entries,
    total: entries.length,
    ownCount: entries.filter((e) => e.own).length,
    foreignCount: entries.filter((e) => !e.own).length,
    sizeText: humanSize(bytes),
  };
}

/**
 * Удаляет только то, что создал сам аудит.
 *
 * Нужно для флага «сохранить выгрузку»: каталог указывает пользователь, и в
 * нём может лежать что угодно постороннее — стирать его целиком нельзя.
 * @returns {Promise<number>} сколько элементов удалено
 */
export async function removeOwnEntries(workDir) {
  const dir = resolveDir(workDir);
  if (!(await pathExists(dir))) return 0;

  let removed = 0;
  for (const name of await fs.readdir(dir)) {
    // Журналы конфигуратора тоже наши: designer-config.log, designer-ext.log.
    if (!OWN_ENTRIES.has(name) && !/^designer-.*\.log$/i.test(name)) continue;
    await rmrf(path.join(dir, name)).catch(() => {});
    removed += 1;
  }
  return removed;
}

/** Удаляет всё содержимое каталога, сам каталог остаётся. */
export async function clearWorkDir(workDir) {
  const dir = resolveDir(workDir);
  if (!(await pathExists(dir))) return { dir, removed: 0 };

  const dirents = await fs.readdir(dir);
  let removed = 0;
  for (const name of dirents) {
    await rmrf(path.join(dir, name));
    removed += 1;
  }
  return { dir, removed };
}

/** Размер каталога без обхода вглубь дальше разумного — только для оценки. */
async function dirSizeFast(dir, depth = 0) {
  if (depth > 6) return 0;
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await dirSizeFast(full, depth + 1);
      else total += (await fs.stat(full)).size;
    } catch {
      /* файл исчез между чтением и stat — не важно */
    }
  }
  return total;
}
