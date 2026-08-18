/**
 * Объектное хранилище хранилища конфигурации.
 *
 * Содержимое версий лежит рядом с `1cv8ddb.1CD` и адресуется хешем SHA-1,
 * который записан в самой базе (`HISTORY.DATAHASH`, `EXTERNALS.DATAHASH`).
 * Хранится оно двумя способами, и оба нужны: свежее — россыпью файлов,
 * слежавшееся — в паках.
 *
 * Проверено на живом хранилище 18.08.2026:
 *
 *  * **россыпь**: `data\objects\<2 первых знака хеша>\<остальные 38>`,
 *    внутри — контейнер 1С, сжатый raw deflate;
 *  * **пак**: пара файлов `data\pack\pack-<хеш>.ind` и `…​.pck`.
 *    В `.ind` заголовок 12 байт (`11223344`, версия, число записей), дальше
 *    записи по 28 байт: 20 байт хеша и смещение (uint64), отсортированные
 *    по хешу. В `.pck` по этому смещению лежит длина (uint64), а за ней —
 *    тот же сжатый контейнер.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { pathExists } from '../../util/fsx.js';
import { unpack, parseContainer, isContainer } from './container.js';

const IND_HEADER = 12;
const IND_RECORD = 28;
const HASH_BYTES = 20;

/**
 * Открывает объектное хранилище: собирает оглавление россыпи и паков.
 *
 * Оглавление паков читается сразу — файлы `.ind` маленькие (28 байт на
 * объект), а знать заранее, где что лежит, дешевле, чем искать при каждом
 * обращении.
 */
export async function openObjectStore(repositoryDir) {
  const index = new Map();

  const objectsDir = path.join(repositoryDir, 'data', 'objects');
  if (await pathExists(objectsDir)) {
    for (const prefix of await fs.readdir(objectsDir)) {
      const dir = path.join(objectsDir, prefix);
      let names = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) index.set(prefix + name, { file: path.join(dir, name) });
    }
  }

  const packDir = path.join(repositoryDir, 'data', 'pack');
  if (await pathExists(packDir)) {
    for (const name of await fs.readdir(packDir)) {
      if (!name.endsWith('.ind')) continue;
      const pack = path.join(packDir, name.replace(/\.ind$/, '.pck'));
      if (!(await pathExists(pack))) continue;
      const ind = await fs.readFile(path.join(packDir, name));
      const count = ind.readUInt32LE(8);
      for (let i = 0; i < count; i += 1) {
        const at = IND_HEADER + i * IND_RECORD;
        if (at + IND_RECORD > ind.length) break;
        const hash = ind.slice(at, at + HASH_BYTES).toString('hex');
        // Россыпь свежее пака: если объект есть и там, и там, берём файл.
        if (!index.has(hash)) {
          index.set(hash, { pack, offset: Number(ind.readBigUInt64LE(at + HASH_BYTES)) });
        }
      }
    }
  }

  return new ObjectStore(index);
}

export class ObjectStore {
  constructor(index) {
    this.index = index;
  }

  get size() {
    return this.index.size;
  }

  /** Распакованное содержимое объекта по хешу. */
  async read(hash) {
    const entry = this.index.get(String(hash || '').toLowerCase());
    if (!entry) return null;
    if (entry.file) return unpack(await fs.readFile(entry.file));
    const buffer = await fs.readFile(entry.pack);
    const length = Number(buffer.readBigUInt64LE(entry.offset));
    return unpack(buffer.slice(entry.offset + 8, entry.offset + 8 + length));
  }

  /**
   * Текст модуля по хешу — или пусто, если под этим хешем лежит не модуль.
   *
   * Модуль хранится контейнером с элементами `info` и `text`; описания
   * объектов (конфигурация, форма) — «скобкофайлом» без контейнера. Так они
   * и различаются, без догадок по содержимому.
   */
  async readModuleText(hash) {
    const body = await this.read(hash);
    if (!body || !isContainer(body)) return '';
    const text = parseContainer(body).get('text');
    return text ? text.toString('utf8').replace(/^﻿/, '') : '';
  }

  /** Описание объекта «скобкофайлом» — форма, конфигурация и прочее. */
  async readDescription(hash) {
    const body = await this.read(hash);
    if (!body || isContainer(body)) return '';
    return body.toString('utf8').replace(/^﻿/, '');
  }
}

/**
 * Модуль формы из её описания.
 *
 * У формы своего модуля-файла нет: текст лежит внутри описания формы обычной
 * строкой в кавычках (проверено 18.08.2026 — там же, где элементы формы).
 * Поэтому берём самую длинную строку, похожую на встроенный язык: короткие
 * строки описания под это условие не подходят, а несколько модулей в одной
 * форме не бывает.
 */
export function formModuleFromDescription(text) {
  const source = String(text || '');
  let best = '';
  const re = /"((?:[^"]|"")*)"/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const value = match[1].replace(/""/g, '"');
    if (value.length <= best.length) continue;
    // Без `\b`: границу слова JS считает по латинице, после кириллицы её нет
    // вовсе — условие не срабатывало никогда, и модуль формы терялся молча.
    if (!/(^|\n)\s*(&На|Процедура |Функция )/i.test(value)) continue;
    best = value;
  }
  return best;
}
