/**
 * Конфигурация поставщика, лежащая в самой выгрузке.
 *
 * Открытие 27.08.2026, и оно снимает главное ограничение обновления. Выгружая
 * в файлы конфигурацию, которая стоит НА ПОДДЕРЖКЕ, платформа кладёт рядом
 * с настройкой поддержки готовый `.cf` конфигурации поставщика:
 *
 *     Ext/ParentConfigurations.bin                    ← правила поддержки
 *     Ext/ParentConfigurations/<Имя поставщика>.cf    ← сама поставка
 *
 * Проверено на демо-базе УНФ 3.0.13.374 (платформа 8.5.1.1150): файл весит
 * 1,13 ГБ — столько же, сколько дистрибутив релиза, — разворачивается через
 * `ibcmd` за 86 с, и внутри именно поставка: версия 3.0.13.374, ни реквизита,
 * добавленного интегратором, ни пометок разработчика в модуле.
 *
 * Что это меняет. Прежде текущую поставку приходилось ВОССТАНАВЛИВАТЬ
 * по отчёту сравнения (`vendorSources.js`): тексты изменённых модулей отчёт
 * печатает обеими сторонами, а прежние значения СВОЙСТВ — нет, и такие места
 * уходили человеку как «прежнее значение поставщика неизвестно». Здесь же
 * поставка настоящая и целиком: свойства, макеты, формы — всё. Обновление
 * становится обычным трёхсторонним объединением, а «Сохранить конфигурацию
 * поставщика в файл» руками в конфигураторе делать не нужно.
 *
 * Выгрузка основной конфигурации в конвейере идёт первым же этапом, поэтому
 * файл доступен бесплатно: он уже лежит на диске к тому моменту, когда
 * понадобился.
 *
 * **Имя файла — это имя конфигурации ПОСТАВЩИКА**, и оно записано в шапке
 * `ParentConfigurations.bin` (`supportTable.js` разбирает её). Поддержка
 * бывает цепочкой — 1С → отраслевой партнёр → клиент, — и в каталоге тогда
 * лежит несколько `.cf`. Наш непосредственный поставщик назван в шапке; если
 * файла с таким именем нет, а лежит ровно один файл, берётся он. Несколько
 * файлов и ни одного с нужным именем — не берётся ничего: угадывать поставку,
 * с которой пойдёт объединение, нельзя.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { splitFields } from './supportTable.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('parent-cf');

/** Каталог с конфигурациями поставщика внутри выгрузки. */
export const PARENT_DIR = 'Ext/ParentConfigurations';

/** Файл настройки поддержки — из его шапки берётся имя поставщика. */
export const SUPPORT_FILE = 'Ext/ParentConfigurations.bin';

/** Лежит ли файл выгрузки внутри каталога конфигураций поставщика. */
export function isParentCfPath(rel) {
  return String(rel || '').replace(/\\/g, '/').startsWith(`${PARENT_DIR}/`);
}

/**
 * Ищет `.cf` текущей поставки в выгрузке основной конфигурации.
 *
 * @param {string} mainDir каталог выгрузки основной конфигурации
 * @returns {Promise<{ok: boolean, file?: string, size?: number, name?: string,
 *   version?: string, vendor?: string, reason?: string, candidates?: string[]}>}
 */
export async function findParentCf(mainDir) {
  const dir = path.join(mainDir, ...PARENT_DIR.split('/'));

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return {
      ok: false,
      reason: 'в выгрузке нет каталога Ext\\ParentConfigurations — '
        + 'конфигурация поставщика вместе с ней не выгружена',
    };
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.cf$/i.test(entry.name))
    .map((entry) => entry.name);

  if (!files.length) {
    return { ok: false, reason: 'в каталоге Ext\\ParentConfigurations нет ни одного файла .cf' };
  }

  const support = await readSupportHeader(path.join(mainDir, ...SUPPORT_FILE.split('/')));
  const wanted = support.name ? `${support.name}.cf` : '';
  const byName = wanted
    ? files.find((name) => name.toLowerCase() === wanted.toLowerCase())
    : null;
  const chosen = byName || (files.length === 1 ? files[0] : null);

  if (!chosen) {
    return {
      ok: false,
      candidates: files,
      reason: `в каталоге Ext\\ParentConfigurations несколько файлов (${files.join(', ')}), `
        + 'и ни один не назван именем поставщика из настройки поддержки',
    };
  }

  const file = path.join(dir, chosen);
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { ok: false, reason: `файл ${chosen} не прочитан` };
  }
  if (!size) {
    return { ok: false, reason: `файл ${chosen} пуст` };
  }

  log.info(`Конфигурация поставщика найдена в выгрузке: ${chosen}, ${size} байт`);
  return {
    ok: true,
    file,
    size,
    candidates: files,
    name: support.name || path.basename(chosen, path.extname(chosen)),
    version: support.version || '',
    vendor: support.vendor || '',
  };
}

/**
 * Сведения о поставщике из шапки настройки поддержки.
 *
 * Читается только начало файла: на УНФ он весит 6,7 МБ, на ERP больше,
 * а нужны первые три строковых поля.
 */
async function readSupportHeader(file) {
  let head = '';
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }

  const fields = headerFields(head);
  if (!fields) return {};
  return {
    version: strip(fields[6]),
    vendor: strip(fields[7]),
    name: strip(fields[8]),
  };
}

/**
 * Первые десять полей «скобкофайла».
 *
 * Разбирается прочитанное начало файла, а не файл целиком: до записей о правилах
 * поддержки дело здесь не доходит, а на ERP их сотни тысяч. Последнее поле
 * отбрасывается всегда — оно оборвано на границе прочитанного куска.
 */
function headerFields(head) {
  const body = head.startsWith('﻿') ? head.slice(1) : head;
  if (!body.startsWith('{')) return null;
  const fields = splitFields(body.slice(1));
  fields.pop();
  return fields.length >= 9 ? fields : null;
}

function strip(value) {
  const text = String(value ?? '');
  return text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1).replace(/""/g, '"')
    : text;
}
