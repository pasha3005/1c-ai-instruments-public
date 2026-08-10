/**
 * Где в XML-файле выгрузки находится строка: путь до свойства.
 *
 * Зачем. Требование пользователя к обновлению — видеть, «какие объекты,
 * в КАКИХ СВОЙСТВАХ и где изменены». Объект и элемент даёт путь файла
 * (`dumpKeys.js`), но внутри одного `Catalogs/Номенклатура.xml` лежат и синоним,
 * и реквизиты, и формы, и права. Номер строки сам по себе не отвечает на вопрос
 * «что именно поменялось», а прочитать сырой XML предлагать пользователю
 * нечестно — это работа инструмента.
 *
 * Поэтому файл разбирается в дерево элементов с диапазонами строк, и по номеру
 * строки восстанавливается путь: «Свойства → Синоним», «Состав → Реквизит
 * «Договор» → Тип».
 *
 * Разбор нарочно свой и грубый, а не через `parse/xml.js`: тому нужен весь
 * документ в память со значениями, а здесь нужны только теги, их имена
 * и НОМЕРА СТРОК, которых полноценный парсер не хранит. Файлы выгрузки 1С
 * форматированы по одному тегу на строку, поэтому построчного сканирования
 * достаточно.
 */

import { kindByTag } from '../parse/metadataKinds.js';

/**
 * Теги, которые в пути не несут смысла.
 *
 * `MetaDataObject` — обёртка файла; вид и имя самого объекта в отчёте уже стоят
 * заголовком (`Справочник «Номенклатура»`), и повторять их в каждой строке
 * значит удваивать длину подписи. Теги с двоеточием — уровень ЗНАЧЕНИЯ свойства
 * (`v8:item`, `v8:content`, `v8:Type`): для «в каком свойстве» важен сам
 * `Синоним` или `Тип`, а не устройство его хранения.
 */
const SKIP_TAGS = new Set(['MetaDataObject', 'mdclass', 'Configuration', 'Form', 'Rights']);

function skipTag(tag) {
  return SKIP_TAGS.has(tag) || tag.includes(':') || Boolean(kindByTag(tag));
}

/** Русские подписи контейнеров и самых частых свойств. */
const RU = {
  Properties: 'Свойства',
  ChildObjects: 'Состав',
  Attribute: 'Реквизит',
  Dimension: 'Измерение',
  Resource: 'Ресурс',
  TabularSection: 'Табличная часть',
  Command: 'Команда',
  Template: 'Макет',
  Form: 'Форма',
  EnumValue: 'Значение перечисления',
  AccountingFlag: 'Признак учёта',
  ExtDimensionAccountingFlag: 'Признак учёта субконто',
  Recalculation: 'Перерасчёт',
  Subsystem: 'Подсистема',
  Name: 'Имя',
  Synonym: 'Синоним',
  Comment: 'Комментарий',
  Type: 'Тип',
  Version: 'Версия',
  Vendor: 'Поставщик',
  Content: 'Состав подсистемы',
  Length: 'Длина',
  Precision: 'Точность',
  Indexing: 'Индексирование',
  FillChecking: 'Проверка заполнения',
  ToolTip: 'Подсказка',
  ObjectModule: 'Модуль объекта',
  ManagerModule: 'Модуль менеджера',
  Help: 'Справочная информация',
  DefaultForm: 'Основная форма',
  InputByString: 'Ввод по строке',
  Characteristics: 'Характеристики',
  StandardAttributes: 'Стандартные реквизиты',
  Roles: 'Роли',
  Right: 'Право',
  Items: 'Элементы',
  Elements: 'Элементы',
};

/**
 * Строит дерево элементов файла.
 *
 * @param {string} text содержимое XML-файла
 * @returns {{tag: string, name: string, startLine: number, endLine: number, children: any[]}}
 */
export function buildXmlOutline(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const root = { tag: '', name: '', startLine: 1, endLine: lines.length, children: [] };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('<')) {
      // Текст свойства продолжается на следующей строке (многострочный синоним).
      continue;
    }
    tagRe.lastIndex = 0;
    let match = tagRe.exec(line);
    while (match) {
      const [, closing, tag, attrs, selfClosing] = match;
      if (tag.startsWith('?') || tag.startsWith('!')) {
        match = tagRe.exec(line);
        continue;
      }
      if (closing) {
        // Закрываем ближайший одноимённый узел: несогласованный XML не должен
        // рушить разбор — лучше приблизительный путь, чем никакого.
        for (let d = stack.length - 1; d > 0; d -= 1) {
          if (stack[d].tag === tag) {
            stack[d].endLine = i + 1;
            stack.length = d;
            break;
          }
        }
      } else if (!selfClosing) {
        const node = {
          tag,
          name: attrName(attrs),
          startLine: i + 1,
          endLine: lines.length,
          children: [],
        };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
      match = tagRe.exec(line);
    }

    // Имя объекта метаданных лежит не в атрибуте, а в <Name>Значение</Name>
    // внутри его <Properties> — подписываем им деда, чтобы в пути стояло
    // «Реквизит «Договор»», а не «Реквизит».
    const named = /<Name>([^<]+)<\/Name>/.exec(line);
    if (named) nameOwner(stack, named[1]);
  }

  return root;
}

function attrName(attrs) {
  const m = /\bname\s*=\s*"([^"]*)"/i.exec(attrs || '');
  return m ? m[1] : '';
}

/**
 * Кому принадлежит найденное <Name>: узлу, внутри которого мы находимся,
 * а если это его <Properties> — то владельцу свойств.
 */
function nameOwner(stack, value) {
  for (let d = stack.length - 1; d > 0; d -= 1) {
    const node = stack[d];
    if (node.tag === 'Properties' || node.tag === 'Name') continue;
    if (!node.name) node.name = value;
    return;
  }
}

/**
 * Путь до строки — массив подписей от корня.
 *
 * @param {ReturnType<typeof buildXmlOutline>} outline
 * @param {number} line номер строки (с единицы)
 * @returns {string[]}
 */
export function xmlPathAtLine(outline, line) {
  const path = [];
  let node = outline;
  for (;;) {
    const child = (node.children || []).find((c) => c.startLine <= line && line <= c.endLine);
    if (!child) break;
    if (!skipTag(child.tag)) path.push(label(child));
    node = child;
  }
  return path;
}

function label(node) {
  const ru = RU[node.tag] || node.tag;
  return node.name ? `${ru} «${node.name}»` : ru;
}

/**
 * Готовая подпись «в каком свойстве» для отчёта.
 *
 * Строится по участку строк, а не по одной строке: правка в XML почти всегда
 * занимает несколько строк, и путь берётся по первой значимой.
 */
export function describeXmlRange(outline, startLine, endLine = startLine) {
  const parts = xmlPathAtLine(outline, startLine);
  if (!parts.length && endLine > startLine) {
    return xmlPathAtLine(outline, endLine).join(' → ');
  }
  return parts.join(' → ');
}
