/**
 * Разбор «пути к базе 1С», введённого пользователем одной строкой.
 *
 * Поддерживаются все форматы, которые встречаются на практике:
 *   1. Файловая база по пути к каталогу:      D:\Bases\Торговля
 *   2. Строка соединения файловой базы:       File="D:\Bases\Торговля";
 *   3. Серверная база «сервер\база»:           srv-1c:1541\УТ_Prod  |  srv-1c\УТ_Prod
 *   4. Строка соединения серверной базы:       Srvr="srv-1c";Ref="УТ_Prod";
 *   5. Веб-база:                               http://host/base  (только частичный анализ)
 *
 * Цель — «минимум вводных»: пользователь вставляет то, что у него есть,
 * система сама определяет тип.
 */

import path from 'node:path';
import { pathExists } from '../util/fsx.js';

/**
 * @typedef {object} Connection
 * @property {'file'|'server'|'web'} kind
 * @property {string} raw исходная строка
 * @property {string} [dbPath] каталог файловой базы
 * @property {string} [server] адрес кластера, например srv:1541
 * @property {string} [ref] имя базы в кластере
 * @property {string} [url} адрес веб-публикации
 * @property {string} display человекочитаемое представление
 */

/** @returns {Connection} */
export function parseConnection(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Не указан путь к информационной базе');

  // Форма строки соединения: File="...";  /  Srvr="...";Ref="...";
  const kv = parseConnectionString(raw);
  if (kv) {
    if (kv.file) {
      return fileConnection(kv.file, raw);
    }
    if (kv.srvr && kv.ref) {
      return {
        kind: 'server',
        raw,
        server: stripQuotes(kv.srvr),
        ref: stripQuotes(kv.ref),
        display: `${stripQuotes(kv.srvr)}\\${stripQuotes(kv.ref)}`,
      };
    }
    if (kv.ws) {
      return { kind: 'web', raw, url: stripQuotes(kv.ws), display: stripQuotes(kv.ws) };
    }
  }

  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'web', raw, url: raw, display: raw };
  }

  // Абсолютный путь Windows (C:\...) или UNC (\\server\share\...) — файловая база.
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    return fileConnection(raw, raw);
  }

  // «сервер\база» или «сервер:порт\база» — серверная база.
  const serverMatch = /^([^\\/]+)[\\/]([^\\/]+)$/.exec(raw);
  if (serverMatch) {
    const [, server, ref] = serverMatch;
    return { kind: 'server', raw, server, ref, display: `${server}\\${ref}` };
  }

  // Последний шанс — трактуем как относительный путь к каталогу базы.
  return fileConnection(raw, raw);
}

function fileConnection(dir, raw) {
  const dbPath = path.resolve(stripQuotes(dir).replace(/[\\/]+$/, ''));
  return { kind: 'file', raw, dbPath, display: dbPath };
}

/** Разбирает строку вида `Key="value";Key2="value2";`. */
function parseConnectionString(raw) {
  if (!/[A-Za-z]+\s*=/.test(raw) || !raw.includes('=')) return null;
  const result = {};
  const re = /([A-Za-z]+)\s*=\s*("(?:[^"]|"")*"|[^;]*)\s*;?/g;
  let m;
  let matched = false;
  while ((m = re.exec(raw)) !== null) {
    matched = true;
    result[m[1].toLowerCase()] = m[2].trim();
  }
  return matched ? result : null;
}

function stripQuotes(s) {
  const t = String(s || '').trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/""/g, '"');
  }
  return t;
}

/** Строка соединения для COM-соединителя (V83.COMConnector.Connect). */
export function toComConnectionString(conn, { user, password } = {}) {
  const parts = [];
  if (conn.kind === 'file') parts.push(`File="${escapeV8(conn.dbPath)}"`);
  else if (conn.kind === 'server') {
    parts.push(`Srvr="${escapeV8(conn.server)}"`);
    parts.push(`Ref="${escapeV8(conn.ref)}"`);
  } else if (conn.kind === 'web') parts.push(`ws="${escapeV8(conn.url)}"`);
  if (user) parts.push(`Usr="${escapeV8(user)}"`);
  if (password) parts.push(`Pwd="${escapeV8(password)}"`);
  return parts.join(';') + ';';
}

/** Параметр командной строки 1cv8 для указания базы (/F или /S). */
export function toClientArgs(conn) {
  if (conn.kind === 'file') return [`/F${conn.dbPath}`];
  if (conn.kind === 'server') return [`/S${conn.server}\\${conn.ref}`];
  if (conn.kind === 'web') return [`/WS${conn.url}`];
  throw new Error(`Неподдерживаемый тип соединения: ${conn.kind}`);
}

/** Внутри 1С кавычка экранируется удвоением. */
function escapeV8(value) {
  return String(value || '').replace(/"/g, '""');
}

/**
 * Проверяет, что файловая база действительно существует и доступна.
 * Для серверных баз проверка выполняется позднее — при первом обращении.
 */
export async function validateConnection(conn) {
  if (conn.kind !== 'file') return { ok: true, warnings: [] };
  const warnings = [];
  if (!(await pathExists(conn.dbPath))) {
    throw new Error(`Каталог информационной базы не найден: ${conn.dbPath}`);
  }
  const dbFile = path.join(conn.dbPath, '1Cv8.1CD');
  if (!(await pathExists(dbFile))) {
    warnings.push(
      `В каталоге ${conn.dbPath} не найден файл 1Cv8.1CD. ` +
      'Убедитесь, что указан каталог файловой базы, а не каталог публикации.',
    );
  }
  return { ok: true, warnings };
}
