/**
 * Лицензионный ключ: допуск к работе приложения.
 *
 * Зачем это нужно. Репозиторий проекта сделан публичным ради одного —
 * чтобы человек без учётной записи GitHub мог открыть страницу, посмотреть
 * историю и скачать архив по ссылке. Публичность репозитория и открытость
 * продукта — разные вещи: запускать программу должны только те, кому владелец
 * дал ключ.
 *
 * ## Что этот механизм даёт
 *
 * В репозитории лежат не ключи, а их SHA-256. Восстановить ключ из хеша
 * нельзя: ключ — 256 бит случайных данных, перебор невозможен. Значит,
 * случайный посетитель GitHub, скачавший архив, запустить программу
 * не сможет: ключа у него нет и взять его неоткуда.
 *
 * Кодирование ниже — не шифр, а всего лишь способ не оставлять список хешей
 * заметным при беглом просмотре: расшифровать блоб может кто угодно, но
 * получит он те же необратимые хеши.
 *
 * ## Срок действия
 *
 * Введённый ключ действует сутки, дальше запрашивается снова. Один и тот же
 * ключ можно вводить сколько угодно раз — счётчиков и привязок к машине нет.
 * Отметка о вводе лежит в `data/license.json`, а `data/` в `.gitignore`,
 * поэтому в репозиторий она не попадает и на чужой машине не действует.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { DATA_DIR } from '../config.js';
import { ensureDir, readJson, writeJson } from './fsx.js';
import { createLogger } from './logger.js';

const log = createLogger('license');

/** Сутки — столько действует введённый ключ. */
export const LICENSE_TTL_MS = 24 * 60 * 60 * 1000;

const STATE_FILE = path.join(DATA_DIR, 'license.json');

/** Соль хеширования. Одна и та же для всех ключей, меняться не должна. */
const SALT = 'onec-audit:';

/** Ключ кодирования блоба. К стойкости отношения не имеет — см. шапку файла. */
const PEPPER = 'onec-audit-access-v1';

/**
 * Список SHA-256 действующих ключей, закодированный в одну строку.
 * Добавить ключ: посчитать `sha256('onec-audit:' + ключ)`, дописать хеш
 * в список и пересобрать блоб (см. `tools/makeLicenseBlob.mjs`).
 */
const BLOB = [
  'X1dQVx5YRlVdFUlYW1UHQBIeQlJfDVZWSwBABl1GGQJTAQZASxxCAQoNBlRPV0BcXkIZVVRVU0UV',
  'GBcFWFdXUB4ARAAIFxRZW1QDEkIYQAAKXF1bTgdHXFtDSVkGWgFLF0wXBQ1fA1FIBERXXkROWQJb',
  'B0YVSxBSWlkDBR9ZE1INEhpXBVNRFRcVRFVaVgRTTwUWVF5BTlBaAAZDF0hEU10IBFVOU0IFUENM',
  'BFJSBkIVHBJSC1oGABVRQ1UIERpYVVAARkccQANXW1QCGwVGUg9NGFVaVFQQQ0hGAw4MBwUcU0Rc',
  'UUVIBVtXUhAQTkADXw0EB0hSQ1ZcTUkDAFUAEhcfEghbW1RWH1BCU1xHGwVQUVwXRkxGBl9ZV1FO',
  'AxRQWEQaA1dXABEVSBQGXAhXAR5YRV1QEkkCAlRQRUMfQldaV1YBGVkRB1tGHAQAB1ZLEh4XBAoL',
  'BAcdVEEAXUYbVwEGURBKGEZQWlgAUB0AQ1MKEklRVwddFxEfQgRcWQdTS1FBBltGGFZbVwdKRRxH',
  'BQpaVgcfUUAFUEUaUlBXUxdBGxIEWFYBU0tXQlZbRBgDBQZUSxUURQBdDAQASVBDVVARGgRQUVFB',
  'Rh8UVA0NVVNOBRcBWkBPUFVUUhBCH0QDXAsDAExURlVcFhpZVFZXQUdJQlJdD1ZUHFlMVlBFTFdT',
  'WgRLQB9HU1kLAFtLVUxQW0YZWAYFBEMWFEUJX1xVVBwCEVZaF0tYU1VcQhFIT1UJXVMGGQBEXVhF',
  'GlUGUwMVQR9AVApaVlYYVEJSUUwYU1RXUhJLSU8FCVxXBhVTRV1cFR4ABwFTERIdTwEKXQZRTlcT',
  'Bg9HS1FaAgNBRxVOUA==',
].join('');

/** Раскодированный список хешей. Считается один раз при первом обращении. */
let hashes = null;

function knownHashes() {
  if (hashes) return hashes;
  const buf = Buffer.from(BLOB, 'base64');
  for (let i = 0; i < buf.length; i += 1) buf[i] ^= PEPPER.charCodeAt(i % PEPPER.length);
  const joined = buf.toString('utf8');
  hashes = new Set();
  for (let i = 0; i + 64 <= joined.length; i += 64) hashes.add(joined.slice(i, i + 64));
  return hashes;
}

/**
 * Подходит ли ключ. Регистр и пробелы по краям не важны: ключ длинный,
 * его копируют из письма, и лишний пробел не повод отказать.
 */
export function isValidKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (normalized.length < 16) return false;
  const hash = createHash('sha256').update(SALT + normalized).digest('hex');
  return knownHashes().has(hash);
}

/**
 * Состояние допуска: активен ли ключ и сколько ему осталось.
 * @returns {Promise<{active: boolean, expiresAt: string|null, ttlMs: number}>}
 */
export async function licenseStatus() {
  const state = await readState();
  if (!state) return { active: false, expiresAt: null, ttlMs: LICENSE_TTL_MS };

  const left = state.activatedAt + LICENSE_TTL_MS - Date.now();
  if (left <= 0) return { active: false, expiresAt: null, ttlMs: LICENSE_TTL_MS };

  return {
    active: true,
    expiresAt: new Date(state.activatedAt + LICENSE_TTL_MS).toISOString(),
    ttlMs: LICENSE_TTL_MS,
  };
}

/**
 * Проверяет ключ и, если он верный, открывает доступ на сутки.
 * @returns {Promise<{ok: boolean, reason?: string, expiresAt?: string}>}
 */
export async function activate(key) {
  if (!isValidKey(key)) {
    log.warn('Отклонён неверный лицензионный ключ');
    return { ok: false, reason: 'Ключ не подходит. Проверьте, что он скопирован целиком.' };
  }

  const activatedAt = Date.now();
  await ensureDir(DATA_DIR);
  // Хранится хеш, а не сам ключ: файл лежит на диске рядом с отчётами,
  // и оставлять в нём рабочий ключ ни к чему.
  await writeJson(STATE_FILE, {
    keyHash: createHash('sha256').update(SALT + String(key).trim().toLowerCase()).digest('hex'),
    activatedAt,
  });

  log.info('Лицензионный ключ принят, доступ открыт на сутки');
  return { ok: true, expiresAt: new Date(activatedAt + LICENSE_TTL_MS).toISOString() };
}

/**
 * Читает отметку о вводе ключа.
 *
 * Отметка отбрасывается, если ключ, которым её поставили, больше не значится
 * действующим: иначе отозванный ключ продолжал бы работать сутки после отзыва.
 */
async function readState() {
  const state = await readJson(STATE_FILE, null);
  if (!state?.activatedAt || !knownHashes().has(state.keyHash)) return null;
  return state;
}

/** Сбрасывает допуск — используется тестами и командой «сменить ключ». */
export async function reset() {
  await fs.rm(STATE_FILE, { force: true }).catch(() => {});
}
