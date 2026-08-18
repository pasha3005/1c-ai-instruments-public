/**
 * Контейнер 1С — «файл в файле».
 *
 * В таком виде платформа хранит всё, что состоит из именованных кусков:
 * объекты в хранилище конфигурации, `.cf`, `.epf`. Устройство простое
 * и разобрано опытом на живом хранилище (18.08.2026):
 *
 *  * 16 байт заголовка: `FF FF FF 7F`, размер страницы, версия, резерв;
 *  * дальше **блоки**. У блока текстовый заголовок ровно 31 байт:
 *    `\r\n%08x %08x %08x \r\n` — длина данных, размер страницы и адрес
 *    продолжения (`7fffffff`, если продолжения нет). Так блок может быть
 *    длиннее одной страницы;
 *  * первый блок — **оглавление**: пары адресов «заголовок элемента» и
 *    «данные элемента», конец списка помечен `7fffffff`;
 *  * заголовок элемента — две отметки времени, резерв и имя в UTF-16;
 *  * данные элемента бывают сжаты (raw deflate) и бывают вложенным
 *    контейнером — поэтому распаковка пробуется, а неудача считается
 *    нормой, а не ошибкой.
 */

import zlib from 'node:zlib';

const HEADER_SIZE = 16;
const BLOCK_HEADER = 31;
const NO_NEXT = 0x7fffffff;
const BLOCK_RE = /^\r\n([0-9a-f]{8}) ([0-9a-f]{8}) ([0-9a-f]{8}) \r\n$/;

/** Похоже ли содержимое на контейнер 1С. */
export function isContainer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > HEADER_SIZE
    && buffer.readUInt32LE(0) === NO_NEXT
    && BLOCK_RE.test(buffer.slice(HEADER_SIZE, HEADER_SIZE + BLOCK_HEADER).toString('latin1'));
}

/** Читает блок по адресу, склеивая продолжения. */
function readBlock(buffer, at) {
  const match = BLOCK_RE.exec(buffer.slice(at, at + BLOCK_HEADER).toString('latin1'));
  if (!match) return null;

  const size = parseInt(match[1], 16);
  const parts = [];
  let cursor = at + BLOCK_HEADER;
  let pageSize = parseInt(match[2], 16);
  let next = parseInt(match[3], 16);
  let left = size;

  while (left > 0) {
    const take = Math.min(left, pageSize);
    parts.push(buffer.slice(cursor, cursor + take));
    left -= take;
    if (left <= 0 || next === NO_NEXT || !next) break;
    const continuation = BLOCK_RE.exec(buffer.slice(next, next + BLOCK_HEADER).toString('latin1'));
    if (!continuation) break;
    cursor = next + BLOCK_HEADER;
    pageSize = parseInt(continuation[2], 16);
    next = parseInt(continuation[3], 16);
  }
  return Buffer.concat(parts);
}

/**
 * Разбирает контейнер в карту «имя элемента → содержимое».
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function parseContainer(buffer) {
  const out = new Map();
  if (!isContainer(buffer)) return out;

  const table = readBlock(buffer, HEADER_SIZE);
  if (!table) return out;

  // Запись оглавления — ТРИ числа по 4 байта: адрес заголовка элемента, адрес
  // его данных и `7fffffff`. С шагом в 8 байт (как показалось сначала) читается
  // только первый элемент, а остальные теряются молча.
  for (let at = 0; at + 12 <= table.length; at += 12) {
    const headerAt = table.readUInt32LE(at);
    const dataAt = table.readUInt32LE(at + 4);
    if (headerAt === NO_NEXT || !headerAt) break;

    const header = readBlock(buffer, headerAt);
    if (!header) continue;
    // Две отметки времени по 8 байт и 4 байта резерва, дальше имя в UTF-16.
    const name = header.slice(20).toString('utf16le').replace(/\0+$/, '');
    const data = readBlock(buffer, dataAt) || Buffer.alloc(0);
    out.set(name, unpack(data));
  }
  return out;
}

/**
 * Распаковывает содержимое, если оно сжато.
 *
 * Сжатие здесь — raw deflate без заголовка, и отличить сжатое от несжатого
 * заранее нечем: пробуем, а неудача означает «лежит как есть».
 */
export function unpack(data) {
  if (!data || !data.length) return Buffer.alloc(0);
  try {
    return zlib.inflateRawSync(data);
  } catch {
    return data;
  }
}
