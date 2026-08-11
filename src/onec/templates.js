/**
 * Поиск поставки конфигурации среди шаблонов обновлений 1С.
 *
 * Зачем. Конфигурацию, **снятую с поддержки**, обновить трёхсторонним
 * объединением всё равно можно — не хватает только старой поставки, а её
 * в базе нет: платформа на запрос конфигурации поставщика отвечает
 * «Конфигурация 'Конфигурация поставщика' недоступна» (проверено на демо-базе
 * УНФ 3.0.13.374 — ответ один и тот же с именем конфигурации, с чужим именем
 * и без параметра вовсе). Но старая поставка — это ровно дистрибутив того
 * релиза, который сейчас стоит в базе, и у человека, который эту конфигурацию
 * когда-нибудь обновлял, он уже лежит на диске: платформа сама раскладывает
 * шаблоны обновлений в каталоги вида
 *
 *   <шаблоны>/1c/SmallBusiness/3_0_13_374/1cv8.cf
 *   <шаблоны>/1c/SmallBusiness/3_0_13_374/1cv8.mft   ← Version=3.0.13.374
 *
 * Спрашивать у пользователя файл, который лежит на его же диске, — лишний шаг.
 * Поэтому сначала ищем сами, и только не найдя, просим указать.
 *
 * Где искать. Каталоги шаблонов перечислены в `1CEStart.cfg` строками
 * `ConfigurationTemplatesLocation=`; их может быть несколько, и путь бывает
 * любым — у пользователя этой программы, например, шаблоны лежат прямо
 * на рабочем столе. Файл в **UTF-16**, читать его как UTF-8 бесполезно.
 *
 * Чего этот модуль не делает. Он **не проверяет**, что найденный файл — та самая
 * конфигурация: без разворачивания `.cf` этого не узнать, а разворачивание
 * стоит минуты. Поэтому он возвращает кандидатов по убыванию надёжности,
 * а сверку имени и версии делает конвейер после разворачивания
 * (`pipeline/runUpdate.js`) — и при несовпадении честно отказывается.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createLogger } from '../util/logger.js';

const log = createLogger('templates');

/** Имя файла поставки внутри каталога шаблона — платформа зовёт его всегда так. */
const DELIVERY_FILE = '1cv8.cf';

/** Предел обхода: каталог шаблонов бывает и рабочим столом со всем подряд. */
const MAX_DEPTH = 4;
const MAX_DIRS = 3_000;
const TIME_BUDGET_MS = 15_000;

/** Каталоги, в которые заходить незачем: там поставок не бывает, а файлов много. */
const SKIP_DIRS = /^(node_modules|\$recycle\.bin|windows|program files( \(x86\))?|appdata|1cv8log|dist)$/i;

/**
 * Разбирает `1CEStart.cfg` и возвращает перечисленные в нём каталоги шаблонов.
 *
 * Экспортируется ради теста: формат файла — единственное, что здесь можно
 * проверить без установленной платформы.
 *
 * @param {string} text содержимое файла (уже декодированное)
 */
export function parseStartCfg(text) {
  const roots = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*ConfigurationTemplatesLocation\s*=\s*(.+?)\s*$/i.exec(line);
    if (match && match[1]) roots.push(match[1]);
  }
  return roots;
}

/**
 * Декодирует `1CEStart.cfg`: платформа пишет его в UTF-16 с BOM.
 *
 * Без этого строки читаются как «C\0:\0\\0U\0s\0e\0r\0s\0…» и ни один путь
 * не находится — а ошибки не видно, просто «шаблонов нет».
 */
export function decodeCfg(buffer) {
  if (buffer.length >= 2) {
    const [a, b] = buffer;
    if (a === 0xff && b === 0xfe) return buffer.subarray(2).toString('utf16le');
    if (a === 0xfe && b === 0xff) return buffer.swap16().subarray(2).toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** Где платформа держит `1CEStart.cfg` — пользовательский и общий. */
function startCfgFiles() {
  const files = [];
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const common = process.env.ALLUSERSPROFILE || process.env.PROGRAMDATA;
  files.push(path.join(appData, '1C', '1CEStart', '1CEStart.cfg'));
  if (common) files.push(path.join(common, '1C', '1CEStart', '1CEStart.cfg'));
  return files;
}

/**
 * Каталоги шаблонов обновлений: из `1CEStart.cfg` плюс каталог по умолчанию.
 *
 * @returns {Promise<string[]>}
 */
export async function templateRoots() {
  const roots = [];
  for (const file of startCfgFiles()) {
    try {
      roots.push(...parseStartCfg(decodeCfg(await fs.readFile(file))));
    } catch {
      /* файла нет — обычное дело, платформа создаёт его при первом запуске */
    }
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  roots.push(path.join(appData, '1C', '1cv8', 'tmplts'));

  const unique = [];
  const seen = new Set();
  for (const root of roots) {
    const full = path.resolve(root);
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if ((await fs.stat(full)).isDirectory()) unique.push(full);
    } catch {
      /* каталог из настроек может уже не существовать */
    }
  }
  return unique;
}

/** «3.0.13.374» → «3.0.13.374», «3_0_13_374» → «3.0.13.374». */
function normalizeVersion(text) {
  return String(text || '').trim().replace(/[_\s]+/g, '.');
}

/**
 * Ищет поставку указанной версии в каталогах шаблонов обновлений.
 *
 * Кандидаты — по убыванию надёжности:
 *   1. `1cv8.cf` рядом с манифестом `.mft`, в котором стоит нужная версия;
 *   2. `1cv8.cf` в каталоге, названном версией (`3_0_13_374`);
 *   3. любой `*.cf`, в имени которого стоит нужная версия
 *      (`УНФ_3_0_13_374.cf` — так их держат руками).
 *
 * @param {object} params
 * @param {string} params.version версия, которая стоит в базе сейчас
 * @param {string[]} [params.roots] каталоги поиска (по умолчанию — из настроек)
 * @param {(text: string) => void} [params.onProgress]
 * @returns {Promise<{candidates: {file: string, why: string, rank: number}[], roots: string[]}>}
 */
export async function findVendorRelease({ version, roots = null, onProgress }) {
  const wanted = normalizeVersion(version);
  const searchIn = roots || (await templateRoots());
  if (!wanted) return { candidates: [], roots: searchIn };

  const candidates = [];
  const deadline = Date.now() + TIME_BUDGET_MS;
  let dirs = 0;

  for (const root of searchIn) {
    onProgress?.(`Поиск поставки ${wanted} в ${root}`);
    await walk(root, 0);
  }

  candidates.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
  if (candidates.length) {
    log.info(`Поставка ${wanted} найдена среди шаблонов: ${candidates[0].file}`);
  } else {
    log.info(`Поставка ${wanted} среди шаблонов не найдена (каталогов просмотрено ${dirs})`);
  }
  return { candidates, roots: searchIn };

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || dirs >= MAX_DIRS || Date.now() > deadline) return;
    dirs += 1;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const manifestHasVersion = await manifestMatches(dir, files, wanted);
    const dirIsVersion = normalizeVersion(path.basename(dir)) === wanted;

    for (const name of files) {
      if (!/\.cf$/i.test(name)) continue;
      const file = path.join(dir, name);
      if (name.toLowerCase() === DELIVERY_FILE && manifestHasVersion) {
        candidates.push({ file, rank: 1, why: `манифест шаблона указывает версию ${wanted}` });
      } else if (name.toLowerCase() === DELIVERY_FILE && dirIsVersion) {
        candidates.push({ file, rank: 2, why: `каталог шаблона назван версией ${wanted}` });
      } else if (normalizeVersion(name.replace(/\.cf$/i, '')).includes(wanted)) {
        candidates.push({ file, rank: 3, why: `версия ${wanted} стоит в имени файла` });
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.test(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }
}

/**
 * Стоит ли нужная версия в манифесте шаблона.
 *
 * Манифест `.mft` бывает в разных кодировках, но версия в нём — цифры и точки,
 * то есть однобайтовая латиница в любой из них. Поэтому читаем как UTF-8
 * и ищем только версию: испорченная кириллица в остальных строках не мешает.
 */
async function manifestMatches(dir, files, wanted) {
  for (const name of files) {
    if (!/\.mft$/i.test(name)) continue;
    try {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      const match = /^\s*Version\s*=\s*([0-9._]+)\s*$/im.exec(text);
      if (match && normalizeVersion(match[1]) === wanted) return true;
    } catch {
      /* нечитаемый манифест — не повод отказываться от каталога */
    }
  }
  return false;
}
