/**
 * Чтение файла 1CD — базы данных 1С в файловом варианте.
 *
 * Зачем это здесь. Хранилище конфигурации, лежащее КАТАЛОГОМ, целиком
 * читается с диска: история помещений — в `1cv8ddb.1CD`, код — в объектном
 * хранилище рядом. Платформа для этого не нужна вовсе: ни лицензии, ни
 * служебной базы, ни выгрузок `.cf` на минуты. Отсюда и модуль.
 *
 * Формат разобран опытом (17–18.08.2026) и проверен сверкой с отчётом самой
 * платформы: расхождений нет. Устройство файла:
 *
 *  * заголовок: `1CDBMSV8`, версия формата (8.3.8), число страниц, размер
 *    страницы (8192);
 *  * **объект** начинается сигнатурой `1C FD 00 00`; в заголовке — длина
 *    (uint64 по смещению 16) и список страниц (uint32 подряд с 24-го байта).
 *    Объект собирается склейкой этих страниц и обрезкой по длине;
 *  * **корневой объект** (страница 2) — «файл блобов»: он нарезан на куски
 *    по 256 байт, у каждого 6 байт заголовка (следующий кусок и длина
 *    полезных данных). В первом куске — локаль и номера кусков с описаниями
 *    таблиц;
 *  * **описание таблицы** — «скобкофайл» с полями, индексами и номерами
 *    объектов данных, индексов и блобов;
 *  * **запись** имеет постоянную длину: байт признака удаления и дальше поля
 *    по своим правилам. Числа хранятся BCD — по полубайту на цифру, первый
 *    полубайт знак; строки — UTF-16.
 */

import fs from 'node:fs/promises';
import { parseBracketFile } from '../infobaseBinding.js';

const SIGNATURE = '1CDBMSV8';
const OBJECT_SIGNATURE = 0x0000fd1c;
/** Кусок «файла блобов»: 4 байта «следующий», 2 байта длины, 250 данных. */
const BLOB_CHUNK = 256;
const BLOB_HEADER = 6;

/**
 * Открывает файл 1CD и разбирает оглавление.
 *
 * @param {string} file путь к `1cv8ddb.1CD`
 * @returns {Promise<Cd1>}
 */
export async function openCd1(file) {
  const buffer = await fs.readFile(file);
  return new Cd1(buffer);
}

export class Cd1 {
  constructor(buffer) {
    if (buffer.slice(0, 8).toString('latin1') !== SIGNATURE) {
      throw new Error('Это не файл базы 1С: нет сигнатуры 1CDBMSV8');
    }
    this.buffer = buffer;
    // Заголовок: 8 байт сигнатуры, 4 байта версии формата, число страниц,
    // ещё одно поле и размер страницы. Размер лежит по смещению 20, а не 16 —
    // ошибка на этом месте выглядит как «на странице 2 нет объекта».
    this.version = `${buffer[8]}.${buffer[9]}.${buffer[10]}`;
    this.pageCount = buffer.readUInt32LE(12);
    this.pageSize = buffer.readUInt32LE(20) || 8192;
    this.tables = new Map();
    this.#readRoot();
  }

  /** Оглавление: локаль и описания таблиц. */
  #readRoot() {
    const root = this.readObject(2);
    const head = readBlob(root, 1);
    const count = head.readUInt32LE(32);
    for (let i = 0; i < count; i += 1) {
      const descriptor = readBlob(root, head.readUInt32LE(36 + i * 4));
      // Описания таблиц лежат ОДНОБАЙТОВЫМ текстом, хотя строки в самих
      // записях — UTF-16. Прочитанные как UTF-16, они превращаются
      // в иероглифы, и таблиц как будто нет вовсе.
      const table = parseTableDescriptor(descriptor.toString('latin1'));
      if (table) this.tables.set(table.name, table);
    }
  }

  /** Собирает объект из его страниц. */
  readObject(page) {
    const at = page * this.pageSize;
    if (this.buffer.readUInt32LE(at) !== OBJECT_SIGNATURE) {
      throw new Error(`На странице ${page} нет объекта 1CD`);
    }
    const length = Number(this.buffer.readBigUInt64LE(at + 16));
    const parts = [];
    let cursor = at + 24;
    let collected = 0;
    while (collected < length) {
      const target = this.buffer.readUInt32LE(cursor);
      cursor += 4;
      // Список страниц длиннее одной страницы продолжается косвенно; в наших
      // объёмах (история хранилища) такого не встречалось, но молча отдавать
      // обрезанный объект нельзя.
      if (!target) throw new Error('Список страниц объекта оборван');
      parts.push(this.buffer.slice(target * this.pageSize, (target + 1) * this.pageSize));
      collected += this.pageSize;
    }
    return Buffer.concat(parts).slice(0, length);
  }

  /** Записи таблицы. Удалённые пропускаются. */
  rows(name) {
    const table = this.tables.get(name);
    if (!table) return [];
    // Порядок в `Files` — данные, БЛОБЫ, индекс. Именно так, а не «данные,
    // индекс, блобы»: проверено на VERSIONS, где комментарии помещений лежат
    // во втором объекте, а третий — индексный.
    const [dataPage, blobPage] = table.files;
    if (!dataPage) return [];
    const data = this.readObject(dataPage);
    const blobs = blobPage ? this.readObject(blobPage) : null;
    const size = recordSize(table.fields);
    const out = [];
    for (let at = 0; at + size <= data.length; at += size) {
      if (data[at] !== 0) continue; // признак удаления
      out.push(readRecord(table.fields, data, at + 1, blobs));
    }
    return out;
  }
}

/** Описание таблицы из «скобкофайла». */
export function parseTableDescriptor(text) {
  const tree = parseBracketFile(text);
  if (!Array.isArray(tree) || typeof tree[0] !== 'string') return null;

  const section = (label) => tree.find((item) => Array.isArray(item) && item[0] === label);
  const fieldsNode = section('Fields');
  const filesNode = section('Files');

  const fields = (fieldsNode || []).slice(1).map((node) => ({
    name: node[0],
    type: node[1],
    nullable: node[2] === '1',
    length: Number(node[3]) || 0,
    precision: Number(node[4]) || 0,
  }));

  return {
    name: tree[0],
    fields,
    files: (filesNode || []).slice(1).map((value) => Number(value) || 0),
  };
}

/** Длина одного поля в записи. */
function fieldSize(field) {
  const extra = field.nullable ? 1 : 0;
  switch (field.type) {
    case 'B': return extra + field.length;
    case 'L': return extra + 1;
    case 'N': return extra + Math.floor(field.length / 2) + 1;
    case 'NC': return extra + field.length * 2;
    case 'NVC': return extra + 2 + field.length * 2;
    case 'RV': return extra + 16;
    case 'DT': return extra + 7;
    // Текст и двоичные данные лежат в объекте блобов, в записи — ссылка
    // (номер куска и длина). Тип I — такая же ссылка, а не число: без этого
    // запись HISTORY короче настоящей на 8 байт и разъезжается целиком.
    case 'NT': case 'T': case 'I': case 'IT': return extra + 8;
    default: return extra + field.length;
  }
}

export function recordSize(fields) {
  return 1 + fields.reduce((sum, field) => sum + fieldSize(field), 0);
}

function readRecord(fields, data, start, blobs) {
  const row = {};
  let at = start;
  for (const field of fields) {
    const size = fieldSize(field);
    let value = null;
    const from = at + (field.nullable ? 1 : 0);
    const known = !field.nullable || data[at] !== 0;
    if (known) {
      switch (field.type) {
        case 'B':
          value = data.slice(from, from + field.length).toString('hex');
          break;
        case 'L':
          value = data[from] !== 0;
          break;
        case 'N':
          value = readNumeric(data.slice(from, at + size), field.length, field.precision);
          break;
        case 'NC':
          value = data.slice(from, from + field.length * 2).toString('utf16le').replace(/\0+$/, '').trimEnd();
          break;
        case 'NVC': {
          const chars = data.readUInt16LE(from);
          value = data.slice(from + 2, from + 2 + chars * 2).toString('utf16le');
          break;
        }
        case 'DT':
          value = readDate(data.slice(from, from + 7));
          break;
        case 'NT': case 'T': case 'I': case 'IT': {
          const index = data.readUInt32LE(from);
          const length = data.readUInt32LE(from + 4);
          value = blobs && length ? readBlob(blobs, index).slice(0, length) : Buffer.alloc(0);
          if (field.type === 'NT') value = value.toString('utf16le');
          break;
        }
        default:
          value = data.slice(from, at + size).toString('hex');
      }
    }
    row[field.name] = value;
    at += size;
  }
  return row;
}

/**
 * Число в BCD: по полубайту на цифру.
 *
 * Первый полубайт — знак (1 — плюс), дальше цифры, в конце может стоять
 * выравнивающий полубайт. Без этого правила `VERNUM` первой версии читался
 * как −10 вместо 1 — на этом однажды и попались.
 */
export function readNumeric(raw, length, precision) {
  const nibbles = [];
  for (const byte of raw) {
    nibbles.push(byte >> 4, byte & 0x0f);
  }
  const sign = nibbles[0] === 0 ? -1 : 1;
  const digits = nibbles.slice(1, 1 + length);
  const text = digits.join('');
  const value = Number(text || '0');
  if (!precision) return sign * value;
  return sign * (value / 10 ** precision);
}

/** Дата в BCD: ГГГГММДДЧЧММСС. */
export function readDate(raw) {
  const nibbles = [];
  for (const byte of raw) nibbles.push(byte >> 4, byte & 0x0f);
  const digits = nibbles.join('');
  const year = Number(digits.slice(0, 4));
  if (!year) return '';
  const pick = (from, to) => digits.slice(from, to);
  return `${digits.slice(0, 4)}-${pick(4, 6)}-${pick(6, 8)}T${pick(8, 10)}:${pick(10, 12)}:${pick(12, 14)}`;
}

/** Склеивает цепочку кусков «файла блобов», начиная с указанного. */
export function readBlob(buffer, start) {
  const parts = [];
  let index = start;
  const seen = new Set();
  while (index && !seen.has(index)) {
    seen.add(index);
    const at = index * BLOB_CHUNK;
    if (at + BLOB_HEADER > buffer.length) break;
    const next = buffer.readUInt32LE(at);
    const length = buffer.readUInt16LE(at + 4) || (BLOB_CHUNK - BLOB_HEADER);
    parts.push(buffer.slice(at + BLOB_HEADER, at + BLOB_HEADER + length));
    index = next;
  }
  return Buffer.concat(parts);
}
