/**
 * Поиск и классификация модулей кода в выгрузке конфигурации.
 *
 * Раскладка иерархической выгрузки:
 *   Ext/ManagedApplicationModule.bsl                — модуль управляемого приложения
 *   Ext/SessionModule.bsl                           — модуль сеанса
 *   CommonModules/<Имя>/Ext/Module.bsl              — общий модуль
 *   Catalogs/<Имя>/Ext/ObjectModule.bsl             — модуль объекта
 *   Catalogs/<Имя>/Ext/ManagerModule.bsl            — модуль менеджера
 *   <Вид>/<Имя>/Ext/RecordSetModule.bsl             — модуль набора записей
 *   <Вид>/<Имя>/Forms/<Форма>/Ext/Form/Module.bsl   — модуль формы
 *   <Вид>/<Имя>/Commands/<Команда>/Ext/CommandModule.bsl
 *
 * Классификация делается по пути, а не по содержимому: это устойчиво к отличиям
 * между выгрузками ibcmd и конфигуратора.
 */

import path from 'node:path';
import { collectFiles } from '../util/fsx.js';
import { kindByDir } from './metadataKinds.js';

/**
 * @typedef {object} ModuleRef
 * @property {string} file абсолютный путь
 * @property {string} rel путь относительно каталога выгрузки
 * @property {string} moduleType вид модуля
 * @property {string} moduleTypeRu
 * @property {string|null} ownerKind вид владельца (Catalog, Document, ...)
 * @property {string|null} ownerName имя владельца
 * @property {string|null} formName имя формы, если это модуль формы
 * @property {string} title человекочитаемое имя для отчёта
 */

const MODULE_TYPE_RU = {
  common: 'Общий модуль',
  object: 'Модуль объекта',
  manager: 'Модуль менеджера',
  recordset: 'Модуль набора записей',
  form: 'Модуль формы',
  command: 'Модуль команды',
  application: 'Модуль приложения',
  session: 'Модуль сеанса',
  externalConnection: 'Модуль внешнего соединения',
  valueManager: 'Модуль менеджера значения',
  other: 'Модуль',
};

/**
 * Собирает все модули выгрузки.
 * @param {string} dumpDir
 * @returns {Promise<ModuleRef[]>}
 */
/**
 * @param {string} dumpDir каталог XML-выгрузки
 * @param {string} [extensionName] имя расширения, если модули принадлежат ему.
 *   Модули расширений анализируются всегда: расширение — это доработка
 *   целиком, сравнивать его с конфигурацией поставщика бессмысленно.
 */
export async function collectModules(dumpDir, extensionName = '') {
  const files = await collectFiles(dumpDir, '.bsl');
  return files.map((file) => {
    const ref = classifyModule(dumpDir, file);
    if (extensionName) {
      ref.extensionName = extensionName;
      ref.title = `Расширение «${extensionName}»: ${ref.title}`;
    }
    return ref;
  });
}

/** @returns {ModuleRef} */
export function classifyModule(dumpDir, file) {
  const rel = path.relative(dumpDir, file);
  const parts = rel.split(/[\\/]/);
  const base = parts[parts.length - 1];

  const ref = {
    file,
    rel,
    moduleType: 'other',
    moduleTypeRu: MODULE_TYPE_RU.other,
    ownerKind: null,
    ownerName: null,
    formName: null,
    title: rel,
  };

  // Корневые модули конфигурации: Ext/<Имя>.bsl
  if (parts.length === 2 && parts[0] === 'Ext') {
    ref.moduleType = rootModuleType(base);
    ref.moduleTypeRu = MODULE_TYPE_RU[ref.moduleType] || MODULE_TYPE_RU.other;
    ref.title = ref.moduleTypeRu;
    return ref;
  }

  const kind = kindByDir(parts[0]);
  if (kind) {
    ref.ownerKind = kind.tag;
    ref.ownerName = parts[1] || null;
  }

  const formIdx = parts.indexOf('Forms');
  if (formIdx !== -1 && parts[formIdx + 1]) {
    ref.moduleType = 'form';
    ref.formName = parts[formIdx + 1];
  } else if (parts.includes('Commands')) {
    ref.moduleType = 'command';
    const cmdIdx = parts.indexOf('Commands');
    ref.formName = parts[cmdIdx + 1] || null;
  } else {
    ref.moduleType = extModuleType(base, kind?.tag);
  }

  ref.moduleTypeRu = MODULE_TYPE_RU[ref.moduleType] || MODULE_TYPE_RU.other;
  ref.title = buildTitle(ref, kind);
  return ref;
}

function rootModuleType(base) {
  const name = base.toLowerCase();
  if (name.includes('managedapplication') || name.includes('ordinaryapplication')) return 'application';
  if (name.includes('session')) return 'session';
  if (name.includes('externalconnection')) return 'externalConnection';
  return 'other';
}

function extModuleType(base, ownerKind) {
  const name = base.toLowerCase();
  if (name === 'module.bsl') return ownerKind === 'CommonModule' ? 'common' : 'other';
  if (name === 'objectmodule.bsl') return 'object';
  if (name === 'managermodule.bsl') return 'manager';
  if (name === 'recordsetmodule.bsl') return 'recordset';
  if (name === 'valuemanagermodule.bsl') return 'valueManager';
  if (name === 'commandmodule.bsl') return 'command';
  return 'other';
}

function buildTitle(ref, kind) {
  if (ref.moduleType === 'common') return `Общий модуль «${ref.ownerName}»`;
  const owner = kind ? `${kind.ru} «${ref.ownerName}»` : ref.ownerName || '';
  if (ref.moduleType === 'form') return `${owner}, форма «${ref.formName}»`;
  if (ref.moduleType === 'command') return `${owner}, команда «${ref.formName}»`;
  return `${owner}: ${ref.moduleTypeRu.toLowerCase()}`;
}

/**
 * Группировка модулей по владельцу — используется в отчёте, чтобы показывать
 * находки не «по файлам», а «по объектам метаданных».
 */
export function groupByOwner(modules) {
  const map = new Map();
  for (const m of modules) {
    const key = m.ownerKind && m.ownerName ? `${m.ownerKind}.${m.ownerName}` : '<конфигурация>';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

export { MODULE_TYPE_RU };
