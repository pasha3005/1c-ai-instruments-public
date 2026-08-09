/**
 * Разбор выгрузки конфигурации в XML.
 *
 * Читает Configuration.xml (свойства конфигурации и состав объектов), затем
 * по каждому объекту — его собственный XML: реквизиты, табличные части, формы,
 * макеты, подчинённые объекты.
 *
 * Работа построена так, чтобы не держать в памяти всю выгрузку: для каждого
 * объекта хранится только сводка, а тексты модулей читаются отдельно
 * (см. modules.js) и тоже не кэшируются целиком.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { parseXml, child, children, childText, find, deepText } from './xml.js';
import { KINDS, kindByTag, countsTowardTotal } from './metadataKinds.js';
import { readText, pathExists } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('parse:config');

/**
 * @typedef {object} MetadataObject
 * @property {string} kind тег вида (Catalog, Document, ...)
 * @property {string} name имя объекта
 * @property {string} fullName Catalog.Товары
 * @property {string} synonym
 * @property {string} comment
 * @property {string} dir каталог объекта в выгрузке
 * @property {string} file путь к XML объекта
 * @property {number} attributeCount
 * @property {number} tabularSectionCount
 * @property {number} tabularAttributeCount
 * @property {string[]} forms
 * @property {string[]} templates
 * @property {string[]} commands
 * @property {Record<string,string>} props прочие интересные свойства
 */

/**
 * @typedef {object} ParsedConfiguration
 * @property {object} configuration свойства конфигурации
 * @property {MetadataObject[]} objects
 * @property {Record<string, number>} countsByKind
 * @property {object} totals
 */

/** Разбирает Configuration.xml и все объекты выгрузки. */
export async function parseConfigurationDump(dumpDir, { onProgress } = {}) {
  const configFile = path.join(dumpDir, 'Configuration.xml');
  if (!(await pathExists(configFile))) {
    throw new Error(`В каталоге выгрузки не найден Configuration.xml: ${dumpDir}`);
  }

  const rootNode = parseXml(await readText(configFile));
  const configNode = child(rootNode, 'Configuration');
  if (!configNode) throw new Error('Configuration.xml повреждён: нет элемента <Configuration>');

  const configuration = parseConfigurationProps(configNode);
  const childObjects = child(configNode, 'ChildObjects');

  /** @type {MetadataObject[]} */
  const objects = [];
  const declared = [];

  if (childObjects) {
    for (const node of childObjects.children) {
      const kind = kindByTag(node.local);
      const name = node.text.trim();
      if (!name) continue;
      declared.push({ kind: node.local, name, known: Boolean(kind) });
    }
  }

  let processed = 0;
  for (const item of declared) {
    processed += 1;
    if (onProgress && processed % 25 === 0) {
      onProgress(processed, declared.length, `${item.kind}.${item.name}`);
    }
    const kind = kindByTag(item.kind);
    if (!kind) {
      // Неизвестный вид (новая версия платформы) — учитываем, но не разбираем.
      objects.push(makeShallowObject(item.kind, item.name));
      continue;
    }
    const parsed = await parseObject(dumpDir, kind, item.name);
    objects.push(parsed);
  }

  const countsByKind = {};
  for (const obj of objects) {
    countsByKind[obj.kind] = (countsByKind[obj.kind] || 0) + 1;
  }

  return {
    configuration,
    objects,
    countsByKind,
    totals: buildTotals(objects, countsByKind),
  };
}

/** Свойства самой конфигурации: имя, версия, поставщик, режим совместимости. */
export function parseConfigurationProps(configNode) {
  const props = child(configNode, 'Properties');
  const get = (name, fallback = '') => childText(props, name, fallback);

  return {
    uuid: configNode.attrs.uuid || '',
    name: get('Name'),
    synonym: extractSynonym(child(props, 'Synonym')),
    comment: get('Comment'),
    version: get('Version'),
    vendor: get('Vendor'),
    namePrefix: get('NamePrefix'),
    briefInformation: extractSynonym(child(props, 'BriefInformation')),
    detailedInformation: extractSynonym(child(props, 'DetailedInformation')),
    copyright: extractSynonym(child(props, 'Copyright')),
    vendorInformationAddress: get('VendorInformationAddress'),
    configurationInformationAddress: get('ConfigurationInformationAddress'),
    updateCatalogAddress: get('UpdateCatalogAddress'),
    defaultRunMode: get('DefaultRunMode'),
    scriptVariant: get('ScriptVariant', 'Russian'),
    compatibilityMode: get('CompatibilityMode'),
    extensionCompatibilityMode: get('ConfigurationExtensionCompatibilityMode'),
    modalityUseMode: get('ModalityUseMode'),
    synchronousCallUseMode: get('SynchronousPlatformExtensionAndAddInCallUseMode'),
    interfaceCompatibilityMode: get('InterfaceCompatibilityMode'),
    dataLockControlMode: get('DataLockControlMode'),
    usePurposes: children(child(props, 'UsePurposes'), 'Value').map((n) => n.text.trim()),
    defaultLanguage: get('DefaultLanguage'),
  };
}

/**
 * Синоним хранится как многоязычный элемент:
 *   <Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Товары</v8:content></v8:item></Synonym>
 */
export function extractSynonym(node) {
  if (!node) return '';
  const items = children(node, 'item');
  if (!items.length) return node.text.trim();
  // Предпочитаем русский, иначе — первый попавшийся.
  const ru = items.find((item) => childText(item, 'lang').toLowerCase().startsWith('ru'));
  const chosen = ru || items[0];
  return childText(chosen, 'content');
}

function makeShallowObject(kind, name) {
  return {
    kind,
    name,
    fullName: `${kind}.${name}`,
    synonym: '',
    comment: '',
    dir: '',
    file: '',
    attributeCount: 0,
    tabularSectionCount: 0,
    tabularAttributeCount: 0,
    forms: [],
    templates: [],
    commands: [],
    props: {},
    unknownKind: true,
  };
}

/**
 * Разбирает один объект метаданных по виду и имени.
 *
 * Нужен для сверки состава объекта с конфигурацией поставщика: разбирать ради
 * сотни изменённых объектов всю выгрузку эталона (на ERP это 14 391 объект
 * и несколько секунд) незачем.
 *
 * @param {string} dumpDir каталог XML-выгрузки
 * @param {string} tag вид объекта (Catalog, Document, …)
 * @param {string} name имя объекта
 * @returns {Promise<MetadataObject|null>} null — вид неизвестен
 */
export async function parseSingleObject(dumpDir, tag, name) {
  const kind = kindByTag(tag);
  if (!kind) return null;
  return parseObject(dumpDir, kind, name);
}

/** Разбирает XML отдельного объекта метаданных. */
async function parseObject(dumpDir, kind, name) {
  const objDir = path.join(dumpDir, kind.dir, name);
  const objFile = path.join(dumpDir, kind.dir, `${name}.xml`);

  const base = {
    kind: kind.tag,
    name,
    fullName: `${kind.tag}.${name}`,
    synonym: '',
    comment: '',
    dir: objDir,
    file: objFile,
    attributeCount: 0,
    tabularSectionCount: 0,
    tabularAttributeCount: 0,
    attributes: [],
    tabularSections: [],
    forms: [],
    templates: [],
    commands: [],
    props: {},
  };

  if (!(await pathExists(objFile))) {
    log.debug(`Файл объекта не найден: ${objFile}`);
    return base;
  }

  let node;
  try {
    node = parseXml(await readText(objFile));
  } catch (err) {
    log.warn(`Не удалось разобрать ${objFile}: ${err.message}`);
    return base;
  }

  const objNode = child(node, kind.tag);
  if (!objNode) return base;

  const props = child(objNode, 'Properties');
  base.synonym = extractSynonym(child(props, 'Synonym'));
  base.comment = childText(props, 'Comment');
  base.props = extractInterestingProps(kind.tag, props);

  const childObjects = child(objNode, 'ChildObjects');
  if (childObjects) {
    for (const c of childObjects.children) {
      switch (c.local) {
        case 'Attribute':
        case 'Dimension':
        case 'Resource':
        case 'AccountingFlag':
        case 'ExtDimensionAccountingFlag':
        case 'AddressingAttribute':
        case 'Column':
          base.attributes.push(nameOf(c));
          break;
        case 'TabularSection':
          base.tabularSections.push(nameOf(c));
          break;
        case 'Form':
          base.forms.push(nameOf(c));
          break;
        case 'Template':
          base.templates.push(nameOf(c));
          break;
        case 'Command':
          base.commands.push(nameOf(c));
          break;
        default:
          break;
      }
    }
  }

  base.attributeCount = base.attributes.length;
  base.tabularSectionCount = base.tabularSections.length;
  base.tabularAttributeCount = await countTabularAttributes(dumpDir, kind, name, base.tabularSections);

  return base;
}

function nameOf(node) {
  // Имя может быть текстом элемента (ссылка) или лежать в Properties/Name.
  const text = node.text.trim();
  if (text) return text;
  const props = child(node, 'Properties');
  return childText(props, 'Name') || '';
}

/** Считает реквизиты табличных частей — важный показатель «толщины» объекта. */
async function countTabularAttributes(dumpDir, kind, objectName, sections) {
  if (!sections.length) return 0;
  let total = 0;
  for (const section of sections) {
    const file = path.join(dumpDir, kind.dir, objectName, 'TabularSections', `${section}.xml`);
    if (!(await pathExists(file))) continue;
    try {
      const node = parseXml(await readText(file));
      const ts = find(node, 'TabularSection');
      const childObjects = child(ts, 'ChildObjects');
      if (childObjects) {
        total += children(childObjects, 'Attribute').length;
      }
    } catch {
      /* повреждённый файл — пропускаем */
    }
  }
  return total;
}

/**
 * Свойства, влияющие на архитектурную оценку.
 * Например, у общего модуля важны флаги Сервер/Клиент/ВызовСервера/Привилегированный.
 */
function extractInterestingProps(tag, props) {
  if (!props) return {};
  const pick = (names) => {
    const out = {};
    for (const n of names) {
      const c = child(props, n);
      if (c) out[n] = c.text.trim();
    }
    return out;
  };

  switch (tag) {
    case 'CommonModule':
      return pick([
        'Global', 'ClientManagedApplication', 'Server', 'ExternalConnection',
        'ClientOrdinaryApplication', 'ServerCall', 'Privileged', 'ReturnValuesReuse',
      ]);
    case 'Document':
      return pick(['Posting', 'RealTimePosting', 'RegisterRecordsDeletion', 'NumberType', 'NumberLength']);
    case 'Catalog':
      return pick(['Hierarchical', 'HierarchyType', 'CodeLength', 'DescriptionLength', 'Owners', 'CodeSeries']);
    case 'InformationRegister':
      return pick(['InformationRegisterPeriodicity', 'WriteMode', 'MainFilterOnOwner', 'EnableTotalsSliceFirst', 'EnableTotalsSliceLast']);
    case 'AccumulationRegister':
      return pick(['RegisterType', 'EnableTotalsSplitting', 'AggregatesUsage']);
    case 'ScheduledJob':
      return pick(['Use', 'Predefined', 'MethodName', 'RestartCountOnFailure']);
    case 'EventSubscription':
      return pick(['Event', 'Handler']);
    case 'HTTPService':
      return pick(['RootURL', 'ReuseSessions']);
    case 'Role':
      return pick(['SetForNewObjects', 'SetForAttributesByDefault']);
    default:
      return {};
  }
}

function buildTotals(objects, countsByKind) {
  let counted = 0;
  let attributes = 0;
  let tabularSections = 0;
  let forms = 0;
  let templates = 0;
  let commands = 0;

  for (const obj of objects) {
    if (countsTowardTotal(obj.kind)) counted += 1;
    attributes += obj.attributeCount || 0;
    tabularSections += obj.tabularSectionCount || 0;
    forms += obj.forms?.length || 0;
    templates += obj.templates?.length || 0;
    commands += obj.commands?.length || 0;
  }

  return {
    objects: counted,
    objectsAll: objects.length,
    attributes,
    tabularSections,
    forms,
    templates,
    commands,
    kindsPresent: Object.keys(countsByKind).length,
  };
}

/** Полный список видов, встречающихся в выгрузке, в порядке справочника KINDS. */
export function orderedKindStats(countsByKind) {
  return KINDS
    .filter((k) => countsByKind[k.tag])
    .map((k) => ({ tag: k.tag, ru: k.ruPlural, group: k.group, count: countsByKind[k.tag] }))
    // По убыванию количества: в отчёте первым делом видно, чего в конфигурации
    // больше всего. Порядок из справочника видов здесь ничего не сообщает.
    .sort((a, b) => b.count - a.count || a.ru.localeCompare(b.ru, 'ru'));
}
