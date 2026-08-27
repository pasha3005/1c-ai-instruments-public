/**
 * Правила поддержки: `Ext/ParentConfigurations.bin`.
 *
 * Вопреки имени, это не «список родительских конфигураций», а вся настройка
 * поддержки целиком. Разобрано на выгрузке демо-базы УНФ (6,7 МБ, 86 629
 * объектов) — «скобкофайл» 1С в UTF-8 с BOM, поля через запятую:
 *
 *     {6,1,1,<guid>,1,<guid>,"3.0.14.115","Фирма ""1С""","УправлениеНебольшойФирмой",86629,
 *      1,0,<guid объекта>,<guid объекта>,     ← правило поддержки объекта
 *      1,0,<guid>,<guid>,
 *      …всего 86 629 записей по четыре поля…
 *      0,0,0,1,0,0,0,1,0,1,0,1,1,1,1}         ← флаги самой конфигурации
 *
 * Первое число записи — правило объекта («не редактируется», «редактируется
 * с сохранением поддержки», «снято с поддержки»), хвост — флаги конфигурации,
 * среди которых и «возможность изменения».
 *
 * **Отсюда правило: этот файл всегда НАШ.** У поставки он свой — там каждый
 * объект «не редактируется», а возможность изменения выключена, потому что
 * так выглядит конфигурация у самого вендора. Скопировав его при объединении,
 * программа ставит на поддержку без права правки всю конфигурацию, включая
 * доработанные объекты. Живой случай 27.08.2026: после обновления модуль
 * доработанного документа открылся «[Только для чтения]».
 *
 * Из поставки берётся ровно две вещи, и обе — не режим:
 *
 *  * **сведения о релизе** (версия, поставщик, имя): после обновления
 *    конфигурация стоит на новом релизе, и «Настройка поддержки» должна
 *    говорить именно это, иначе конфигуратор предложит то же обновление снова;
 *  * **записи для НОВЫХ объектов поставщика** — тех, чьих идентификаторов
 *    в нашей таблице нет. Без них объект новой поставки оказался бы вне
 *    поддержки вовсе.
 *
 * Правило каждого нашего объекта и флаги конфигурации остаются нетронутыми,
 * и это проверяется на собранном тексте (`verify`): не сошлось — файл
 * остаётся нашим байт в байт. Испортить 6,7 МБ настройки поддержки молча
 * куда хуже, чем оставить в ней прежний номер релиза.
 */

/** Сколько полей в шапке до перечня записей. */
const HEADER_FIELDS = 10;

/** Сколько полей в одной записи: правило, флаг и пара идентификаторов. */
const RECORD_FIELDS = 4;

/** Позиции шапки, которые описывают релиз поставщика. */
const RELEASE_FIELDS = [6, 7, 8];

/**
 * Разбирает файл на шапку, записи и хвост.
 *
 * @returns {{ok: boolean, reason?: string, bom?: boolean, header?: string[],
 *            records?: string[][], tail?: string[]}}
 */
export function parseSupportTable(text) {
  const raw = String(text ?? '');
  const bom = raw.startsWith('﻿');
  const body = (bom ? raw.slice(1) : raw).trim();

  if (!body.startsWith('{') || !body.endsWith('}')) {
    return { ok: false, reason: 'файл не начинается и не кончается фигурной скобкой' };
  }

  const fields = splitFields(body.slice(1, -1));
  if (fields.length < HEADER_FIELDS) return { ok: false, reason: 'шапка короче ожидаемой' };

  const count = Number(fields[HEADER_FIELDS - 1]);
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, reason: 'в шапке нет числа объектов' };
  }

  const end = HEADER_FIELDS + count * RECORD_FIELDS;
  if (end > fields.length) {
    return { ok: false, reason: `объявлено ${count} записей, а полей на них не хватает` };
  }

  const records = [];
  for (let i = HEADER_FIELDS; i < end; i += RECORD_FIELDS) {
    records.push(fields.slice(i, i + RECORD_FIELDS));
  }

  return {
    ok: true,
    bom,
    header: fields.slice(0, HEADER_FIELDS),
    records,
    tail: fields.slice(end),
  };
}

/**
 * Наши правила поддержки плюс сведения о новом релизе и новые объекты поставки.
 *
 * @returns {{ok: boolean, text?: string, added?: number, kept?: number,
 *            release?: string, reason?: string}}
 */
export function mergeSupportTables(oursText, theirsText) {
  const ours = parseSupportTable(oursText);
  if (!ours.ok) return { ok: false, reason: `наш файл поддержки не разобран: ${ours.reason}` };

  const theirs = parseSupportTable(theirsText);
  if (!theirs.ok) return { ok: false, reason: `файл поддержки поставки не разобран: ${theirs.reason}` };

  const known = new Set(ours.records.map(keyOf));
  const added = theirs.records.filter((record) => !known.has(keyOf(record)));

  const header = ours.header.slice();
  for (const at of RELEASE_FIELDS) header[at] = theirs.header[at];
  const records = [...ours.records, ...added];
  header[HEADER_FIELDS - 1] = String(records.length);

  const text = (ours.bom ? '﻿' : '')
    + `{${[...header, ...records.flat(), ...ours.tail].join(',')}}`;

  const check = verify(text, ours, records.length);
  if (!check.ok) return { ok: false, reason: check.reason };

  return {
    ok: true,
    text,
    added: added.length,
    kept: ours.records.length,
    release: strip(theirs.header[6]),
  };
}

/**
 * Проверка собранного текста: правила наших объектов и флаги конфигурации
 * обязаны остаться прежними. Без неё ошибка в разборе прошла бы незамеченной
 * до самой загрузки в базу.
 */
function verify(text, ours, expected) {
  const back = parseSupportTable(text);
  if (!back.ok) return { ok: false, reason: `собранный файл не читается обратно: ${back.reason}` };
  if (back.records.length !== expected) {
    return { ok: false, reason: 'в собранном файле не то число записей' };
  }
  if (back.tail.join(',') !== ours.tail.join(',')) {
    return { ok: false, reason: 'флаги конфигурации изменились — так нельзя' };
  }

  const rules = new Map(back.records.map((record) => [keyOf(record), record.slice(0, 2).join(',')]));
  for (const record of ours.records) {
    if (rules.get(keyOf(record)) !== record.slice(0, 2).join(',')) {
      return { ok: false, reason: 'правило поддержки объекта изменилось — так нельзя' };
    }
  }
  return { ok: true };
}

function keyOf(record) {
  return `${record[2]}|${record[3]}`;
}

function strip(value) {
  const text = String(value ?? '');
  return text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1).replace(/""/g, '"')
    : text;
}

/**
 * Делит содержимое скобок на поля.
 *
 * Запятая внутри строки в кавычках полем не считается, а удвоенная кавычка
 * внутри строки — это одна кавычка (`"Фирма ""1С"""`). Поля возвращаются
 * в исходном виде, вместе с кавычками: файл потом собирается обратно, и любая
 * «нормализация» здесь означала бы изменение файла.
 */
export function splitFields(body) {
  const fields = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      current += ch;
      if (ch === '"') {
        if (body[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      current += ch;
      continue;
    }
    if (ch === ',') {
      fields.push(current);
      current = '';
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    current += ch;
  }
  fields.push(current);
  return fields;
}
