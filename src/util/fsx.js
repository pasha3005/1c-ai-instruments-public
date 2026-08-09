/** Файловые утилиты поверх node:fs/promises. */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureDirSync(dir) {
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p) {
  try {
    fsSync.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(stripBom(raw));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Чтение текстового файла с автоопределением кодировки.
 *
 * Модули 1С выгружаются в UTF-8 с BOM, но встречаются файлы в UTF-16LE
 * (например, из старых версий платформы) и в CP1251 (legacy-выгрузки).
 */
export async function readText(file) {
  const buf = await fs.readFile(file);
  return decodeBuffer(buf);
}

export function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE — переставляем байты, Node не умеет читать BE напрямую.
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const text = buf.toString('utf8');
  // U+FFFD означает, что это не UTF-8 — почти наверняка CP1251.
  if (text.includes('�')) return decodeCp1251(buf);
  return text;
}

const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмнопрстуфхцчшщъыьэюя';

export function decodeCp1251(buf) {
  let out = '';
  for (const byte of buf) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP1251_HIGH[byte - 0x80];
  }
  return out;
}

export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Рекурсивный обход каталога.
 * @param {string} dir
 * @param {(fullPath: string, entry: import('node:fs').Dirent) => void} onFile
 */
export async function walk(dir, onFile, { maxDepth = 64, depth = 0 } = {}) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile, { maxDepth, depth: depth + 1 });
    } else if (entry.isFile()) {
      await onFile(full, entry);
    }
  }
}

/** Собирает все файлы с указанным расширением. */
export async function collectFiles(dir, ext) {
  const result = [];
  const wanted = ext.toLowerCase();
  await walk(dir, (full) => {
    if (path.extname(full).toLowerCase() === wanted) result.push(full);
  });
  return result;
}

/** Суммарный размер каталога в байтах. */
export async function dirSize(dir) {
  let total = 0;
  await walk(dir, async (full) => {
    try {
      total += (await fs.stat(full)).size;
    } catch {
      /* файл мог исчезнуть — пропускаем */
    }
  });
  return total;
}

export async function rmrf(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1);
  // «1.0 ГБ» читается хуже, чем «1 ГБ» — убираем незначащий дробный ноль.
  return `${rounded.replace(/\.0$/, '')} ${units[i]}`;
}
