/**
 * Кто есть кто в XML-выгрузке конфигурации: по пути файла — объект метаданных
 * и его элемент.
 *
 * Объединение конфигураций идёт по файлам, а разбираться пользователю надо
 * по объектам: «Справочник «Номенклатура», модуль объекта», а не
 * «Catalogs\Номенклатура\Ext\ObjectModule.bsl». Здесь один разбор пути на весь
 * механизм обновления: и для отчёта, и для сопоставления с картой изменений
 * из ConfigDumpInfo.
 *
 * Раскладка выгрузки (иерархический формат) — та же, что разбирает
 * `parse/modules.js`, но там интересны только модули, а тут все файлы:
 * свойства объектов, формы, макеты, картинки, права ролей.
 */

import path from 'node:path';
import { kindByDir, ruName } from '../parse/metadataKinds.js';

/** Ключ корня конфигурации: у самой конфигурации вида метаданных нет. */
export const ROOT_KEY = 'Configuration';

/**
 * Модули самой конфигурации: файл выгрузки → суффикс ключа.
 *
 * Имена файлов совпадают с суффиксами, но перечень нужен явный: всё
 * остальное в `Ext/` — служебные файлы поставки, у которых ключа нет.
 */
const ROOT_MODULES = {
  'OrdinaryApplicationModule.bsl': 'OrdinaryApplicationModule',
  'ManagedApplicationModule.bsl': 'ManagedApplicationModule',
  'ApplicationModule.bsl': 'ApplicationModule',
  'SessionModule.bsl': 'SessionModule',
  'ExternalConnectionModule.bsl': 'ExternalConnectionModule',
};

/**
 * @typedef {object} DumpEntry
 * @property {string} rel путь относительно каталога выгрузки
 * @property {string} objectKey ключ объекта: «Catalog.Номенклатура» либо ROOT_KEY
 * @property {string} kind вид объекта («Catalog»), пустой у корня
 * @property {string} kindRu «Справочник»
 * @property {string} name имя объекта
 * @property {string} element русская подпись элемента объекта
 * @property {boolean} isModule модуль на встроенном языке
 * @property {boolean} isXml
 * @property {boolean} isObjectFile файл описания самого объекта («Catalogs/X.xml»)
 */

/**
 * Разбирает путь файла выгрузки.
 * @param {string} rel путь относительно корня выгрузки
 * @returns {DumpEntry}
 */
export function describeDumpPath(rel) {
  const normalized = String(rel).replace(/\\/g, '/');
  const parts = normalized.split('/');
  const base = parts[parts.length - 1];
  const ext = path.extname(base).toLowerCase();

  const entry = {
    rel: normalized,
    objectKey: ROOT_KEY,
    kind: '',
    kindRu: 'Конфигурация',
    name: '',
    element: normalized,
    isModule: ext === '.bsl',
    isXml: ext === '.xml',
    isObjectFile: false,
  };

  // Корень выгрузки: Configuration.xml, ConfigDumpInfo.xml.
  if (parts.length === 1) {
    entry.element = base === 'Configuration.xml' ? 'Свойства и состав конфигурации' : base;
    entry.isObjectFile = base === 'Configuration.xml';
    return entry;
  }

  // Корневые модули и служебные файлы конфигурации: Ext/...
  if (parts[0] === 'Ext') {
    entry.element = rootElement(parts.slice(1));
    return entry;
  }

  const kind = kindByDir(parts[0]);
  if (!kind) {
    // Неизвестный каталог верхнего уровня. Не выдумываем объект: такой файл
    // объединяется как есть, а в отчёте показывается своим путём.
    return entry;
  }

  entry.kind = kind.tag;
  entry.kindRu = kind.ru;
  entry.name = parts.length === 2 ? base.replace(/\.xml$/i, '') : parts[1];
  entry.objectKey = `${kind.tag}.${entry.name}`;

  if (parts.length === 2) {
    entry.element = 'Свойства и состав объекта';
    entry.isObjectFile = ext === '.xml';
    return entry;
  }

  entry.element = childElement(parts.slice(2));
  return entry;
}

/** Подпись элемента для файлов из корневого каталога Ext. */
function rootElement(tail) {
  const name = tail.join('/');
  const known = {
    'ManagedApplicationModule.bsl': 'Модуль управляемого приложения',
    'OrdinaryApplicationModule.bsl': 'Модуль обычного приложения',
    'SessionModule.bsl': 'Модуль сеанса',
    'ExternalConnectionModule.bsl': 'Модуль внешнего соединения',
    'CommandInterface.xml': 'Командный интерфейс',
    'MainSectionCommandInterface.xml': 'Командный интерфейс основного раздела',
    'Help.xml': 'Справочная информация',
  }[name];
  return known || `Конфигурация: ${name}`;
}

/**
 * Подпись элемента внутри объекта по «хвосту» пути.
 *
 * Формы, макеты и команды называются по имени: правка в форме «ФормаЭлемента»
 * и правка в форме «ФормаСписка» — разные вещи, и в отчёте они должны стоять
 * отдельными строками.
 */
function childElement(tail) {
  const [first, second] = tail;

  if (first === 'Forms' && second) return `Форма «${second}»${suffixFor(tail.slice(2))}`;
  if (first === 'Templates' && second) return `Макет «${second}»`;
  if (first === 'Commands' && second) return `Команда «${second}»${suffixFor(tail.slice(2))}`;
  if (first === 'Recalculations' && second) return `Перерасчёт «${second}»`;
  if (first === 'Aggregates' && second) return `Агрегат «${second}»`;

  if (first === 'Ext') {
    const name = tail.slice(1).join('/');
    const known = {
      'Module.bsl': 'Модуль',
      'ObjectModule.bsl': 'Модуль объекта',
      'ManagerModule.bsl': 'Модуль менеджера',
      'RecordSetModule.bsl': 'Модуль набора записей',
      'ValueManagerModule.bsl': 'Модуль менеджера значения',
      'CommandModule.bsl': 'Модуль команды',
      'Form.xml': 'Форма',
      'Form/Module.bsl': 'Модуль формы',
      'Rights.xml': 'Права роли',
      'Predefined.xml': 'Предопределённые элементы',
      'Template.xml': 'Макет',
      'Help.xml': 'Справочная информация',
    }[name];
    if (known) return known;
    if (name.startsWith('Picture/')) return 'Картинка';
    if (name.startsWith('Help/')) return 'Справочная информация';
    if (name.startsWith('Template.')) return 'Макет';
    return name;
  }

  return tail.join('/');
}

/** «Ext/Form/Module.bsl» внутри формы или команды — это её модуль. */
function suffixFor(tail) {
  const name = tail.join('/');
  if (!name) return '';
  if (/Module\.bsl$/i.test(name)) return ', модуль';
  if (/Form\.xml$/i.test(name)) return ', элементы формы';
  if (/Help/i.test(name)) return ', справка';
  return `, ${name}`;
}

/**
 * Ключ файла выгрузки в терминах ConfigDumpInfo и отчёта сравнения.
 *
 * Отчёт `/CompareCfg` перечисляет отличия ключами вида `Catalog.Номенклатура`,
 * `Catalog.Номенклатура.ObjectModule`, `Catalog.X.Form.ФормаЭлемента.Form`.
 * Чтобы понять, отличается ли КОНКРЕТНЫЙ файл выгрузки от конфигурации
 * поставщика, нужен обратный перевод: путь файла → тот же ключ.
 *
 * На этом стоит восстановление старой поставки из базы: файл, которого нет
 * в перечне отличий, у поставщика ровно такой же, как у нас, — значит его
 * содержимое известно точно.
 *
 * Модули САМОЙ конфигурации (`Ext/OrdinaryApplicationModule.bsl`) ключ тоже
 * имеют: отчёт сравнения печатает их свойствами корневого узла («Модуль
 * обычного приложения - Изменено»), и без обратного перевода такой файл
 * считался неизвестным и объявлялся спорным, хотя менял его один поставщик.
 * Служебные файлы поставки (`ParentConfigurations.bin`,
 * `MobileClientSignature.bin`) ключа не имеют и иметь не могут: их пишет
 * платформа, руками их не правят.
 *
 * @returns {string|null} null — файл не сопоставляется ни с одним ключом
 *   (служебные файлы поставки): о таких судить по отчёту нельзя.
 */
export function dumpInfoKey(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  if (parts.length < 2) return null;
  if (parts[0] === 'Ext') {
    const suffix = ROOT_MODULES[parts.slice(1).join('/')];
    return suffix ? `${ROOT_KEY}.${suffix}` : null;
  }

  const kind = kindByDir(parts[0]);
  if (!kind) return null;

  // Catalogs/Номенклатура.xml — сам объект.
  if (parts.length === 2) return `${kind.tag}.${parts[1].replace(/\.xml$/i, '')}`;

  const key = [kind.tag, parts[1]];
  const tail = parts.slice(2);

  if (tail[0] === 'Forms' && tail[1]) {
    // И описание формы, и её модуль — один ключ: конфигуратор считает форму
    // единым элементом и отдельного хеша для модуля формы не хранит.
    return [...key, 'Form', tail[1].replace(/\.xml$/i, ''), 'Form'].join('.');
  }
  if (tail[0] === 'Commands' && tail[1]) {
    const name = tail[1].replace(/\.xml$/i, '');
    const isModule = tail.some((p) => /^CommandModule\.bsl$/i.test(p));
    return [...key, 'Command', name, ...(isModule ? ['CommandModule'] : [])].join('.');
  }
  if (tail[0] === 'Templates' && tail[1]) {
    return [...key, 'Template', tail[1].replace(/\.xml$/i, '')].join('.');
  }
  if (tail[0] === 'Recalculations' && tail[1]) {
    return [...key, 'Recalculation', tail[1].replace(/\.xml$/i, '')].join('.');
  }

  if (tail[0] === 'Ext') {
    const name = tail.slice(1).join('/');
    const suffix = {
      'Module.bsl': kind.tag === 'CommonModule' ? '' : 'Module',
      'ObjectModule.bsl': 'ObjectModule',
      'ManagerModule.bsl': 'ManagerModule',
      'RecordSetModule.bsl': 'RecordSetModule',
      'ValueManagerModule.bsl': 'ValueManagerModule',
      'CommandModule.bsl': 'CommandModule',
    }[name];
    if (suffix === '') return key.join('.');
    if (suffix) return [...key, suffix].join('.');
    // Права роли, предопределённые, картинки: своего ключа нет, судим по объекту.
    return key.join('.');
  }

  return key.join('.');
}

/**
 * Ключи объектов, которые интегратор изменил или добавил относительно
 * поставщика.
 *
 * Нужно в режиме без старой поставки: там о правках известно только из карты
 * изменений (`changeSet`), где ключи бывают и объектные («Catalog.X»),
 * и модульные («Catalog.X.ObjectModule»). Для объединения важен объект целиком,
 * поэтому ключи сворачиваются до «Вид.Имя».
 *
 * @param {{modified: Set<string>, added: Set<string>}} changeSet
 * @returns {Set<string>}
 */
export function touchedObjectKeys(changeSet) {
  const keys = new Set();
  if (!changeSet) return keys;
  for (const set of [changeSet.modified, changeSet.added]) {
    for (const key of set || []) {
      const parts = String(key).split('.');
      if (parts.length >= 2) keys.add(`${parts[0]}.${parts[1]}`);
      else keys.add(String(key));
    }
  }
  return keys;
}

/** Русское имя объекта для отчёта: «Справочник «Номенклатура»». */
export function objectTitle(objectKey) {
  if (!objectKey || objectKey === ROOT_KEY) return 'Конфигурация';
  const dot = objectKey.indexOf('.');
  if (dot === -1) return objectKey;
  const kind = objectKey.slice(0, dot);
  const name = objectKey.slice(dot + 1);
  const ru = ruName(kind);
  return ru && ru !== kind ? `${ru} «${name}»` : objectKey;
}

/**
 * Строка `<Вид>Имя</Вид>` внутри ChildObjects конфигурации.
 *
 * Состав конфигурации хранится списком таких строк в Configuration.xml, и при
 * обновлении его приходится править отдельно: новый объект поставщика,
 * не внесённый в состав, платформа при загрузке просто не увидит.
 */
export function childObjectLine(objectKey) {
  const dot = String(objectKey).indexOf('.');
  if (dot === -1) return null;
  const kind = objectKey.slice(0, dot);
  const name = objectKey.slice(dot + 1);
  if (!kind || !name) return null;
  return { kind, name, xml: `<${kind}>${name}</${kind}>` };
}
