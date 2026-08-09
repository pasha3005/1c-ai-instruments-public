/**
 * Разбор ролей и прав доступа.
 *
 * Права лежат отдельно от описания роли:
 *   Roles/<Имя>.xml            — свойства роли
 *   Roles/<Имя>/Ext/Rights.xml — собственно права по объектам
 *
 * Для аудита безопасности важны: полнота прав (кто может «Администрирование»),
 * наличие ролей с правом «Интерактивное удаление», роли без ограничений RLS,
 * и признак setForNewObjects — роль, автоматически получающая права на всё новое.
 */

import path from 'node:path';
import { parseXml, child, children, childText, find } from './xml.js';
import { readText, pathExists } from '../util/fsx.js';
import { extractSynonym } from './configuration.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('parse:roles');

/** Права, критичные с точки зрения безопасности. */
export const DANGEROUS_RIGHTS = new Set([
  'Administration',
  'DataAdministration',
  'UpdateDataBaseConfiguration',
  'ExclusiveMode',
  'ActiveUsers',
  'RegisterLog',
  'ThinClient',
  'WebClient',
  'ExternalConnection',
  'Automation',
  'InteractiveOpenExtDataProcessors',
  'InteractiveOpenExtReports',
  'AllFunctionsMode',
  'MainWindowModeNormal',
  'SaveUserData',
  'ConfigurationExtensionsAdministration',
]);

/** Русские названия прав для отчёта. */
const RIGHT_RU = {
  Administration: 'Администрирование',
  DataAdministration: 'Администрирование данных',
  UpdateDataBaseConfiguration: 'Обновление конфигурации базы данных',
  ExclusiveMode: 'Монопольный режим',
  ActiveUsers: 'Активные пользователи',
  RegisterLog: 'Журнал регистрации',
  ExternalConnection: 'Внешнее соединение',
  Automation: 'Automation',
  InteractiveOpenExtDataProcessors: 'Интерактивное открытие внешних обработок',
  InteractiveOpenExtReports: 'Интерактивное открытие внешних отчётов',
  AllFunctionsMode: 'Режим «Все функции»',
  ConfigurationExtensionsAdministration: 'Администрирование расширений конфигурации',
  InteractiveDelete: 'Интерактивное удаление',
  InteractiveDeletePredefinedData: 'Интерактивное удаление предопределённых данных',
  Read: 'Чтение',
  Insert: 'Добавление',
  Update: 'Изменение',
  Delete: 'Удаление',
};

/**
 * @typedef {object} RoleInfo
 * @property {string} name
 * @property {string} synonym
 * @property {boolean} setForNewObjects
 * @property {boolean} setForAttributesByDefault
 * @property {number} objectCount число объектов с назначенными правами
 * @property {number} rightCount общее число выданных прав
 * @property {string[]} dangerousRights
 * @property {number} restrictionCount число ограничений доступа на уровне записей (RLS)
 * @property {boolean} hasInteractiveDelete
 */

/**
 * @param {string} dumpDir
 * @param {string[]} roleNames
 * @returns {Promise<RoleInfo[]>}
 */
export async function parseRoles(dumpDir, roleNames) {
  const roles = [];
  for (const name of roleNames) {
    try {
      roles.push(await parseRole(dumpDir, name));
    } catch (err) {
      log.warn(`Не удалось разобрать роль ${name}: ${err.message}`);
      roles.push(emptyRole(name));
    }
  }
  return roles;
}

function emptyRole(name) {
  return {
    name,
    synonym: '',
    setForNewObjects: false,
    setForAttributesByDefault: false,
    objectCount: 0,
    rightCount: 0,
    dangerousRights: [],
    restrictionCount: 0,
    hasInteractiveDelete: false,
    hasFullAccess: false,
  };
}

async function parseRole(dumpDir, name) {
  const role = emptyRole(name);

  const descFile = path.join(dumpDir, 'Roles', `${name}.xml`);
  if (await pathExists(descFile)) {
    const node = parseXml(await readText(descFile));
    const roleNode = find(node, 'Role');
    const props = child(roleNode, 'Properties');
    role.synonym = extractSynonym(child(props, 'Synonym'));
    role.setForNewObjects = childText(props, 'SetForNewObjects') === 'true';
    role.setForAttributesByDefault = childText(props, 'SetForAttributesByDefault') === 'true';
  }

  const rightsFile = path.join(dumpDir, 'Roles', name, 'Ext', 'Rights.xml');
  if (!(await pathExists(rightsFile))) return role;

  const rightsNode = parseXml(await readText(rightsFile));
  const root = rightsNode?.local === 'Rights' ? rightsNode : find(rightsNode, 'Rights');
  if (!root) return role;

  const dangerous = new Set();
  let rightCount = 0;
  let restrictionCount = 0;
  let hasInteractiveDelete = false;

  const objectNodes = children(root, 'object');
  for (const objectNode of objectNodes) {
    const objName = childText(objectNode, 'name');
    for (const rightNode of children(objectNode, 'right')) {
      const rightName = childText(rightNode, 'name');
      const value = childText(rightNode, 'value');
      if (value !== 'true') continue;
      rightCount += 1;
      if (DANGEROUS_RIGHTS.has(rightName)) dangerous.add(rightName);
      if (rightName === 'InteractiveDelete' || rightName === 'InteractiveDeletePredefinedData') {
        hasInteractiveDelete = true;
      }
      // Ограничения доступа к данным (RLS) лежат внутри права.
      restrictionCount += children(rightNode, 'restrictionByCondition').length;
    }
    if (objName === 'Configuration' || objName?.startsWith('Configuration.')) {
      // Права уровня конфигурации уже учтены выше.
    }
  }

  role.objectCount = objectNodes.length;
  role.rightCount = rightCount;
  role.dangerousRights = [...dangerous];
  role.restrictionCount = restrictionCount;
  role.hasInteractiveDelete = hasInteractiveDelete;
  role.hasFullAccess = dangerous.has('Administration') || dangerous.has('DataAdministration');
  return role;
}

export function ruRight(name) {
  return RIGHT_RU[name] || name;
}
