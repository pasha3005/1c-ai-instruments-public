/**
 * Разбор расширений конфигурации.
 *
 * Ключевые для аудита факты:
 *   • назначение расширения (Исправление / Дополнение / Адаптация);
 *   • сколько объектов заимствовано из основной конфигурации (ObjectBelonging =
 *     Adopted) — именно они конфликтуют при обновлении типовой;
 *   • какие аннотации переопределения использованы в модулях:
 *       &Вместо  — полностью подменяет типовой метод (самый рискованный вариант),
 *       &Перед / &После — безопасное расширение поведения,
 *       &ИзменениеИКонтроль — контролируемое изменение тела метода.
 *
 * Соотношение &Вместо к общему числу переопределений — главный индикатор того,
 * насколько болезненным будет обновление типового решения.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { parseXml, child, children, childText, find } from './xml.js';
import { readText, pathExists, collectFiles } from '../util/fsx.js';
import { extractSynonym } from './configuration.js';
import { kindByTag } from './metadataKinds.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('parse:ext');

/** Русские названия назначений расширения. */
const PURPOSE_RU = {
  Customization: 'Адаптация',
  AddOn: 'Дополнение',
  Patch: 'Исправление (патч)',
};

/** Аннотации переопределения методов в расширениях. */
const ANNOTATIONS = [
  { re: /&Вместо\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'instead', ru: '&Вместо' },
  { re: /&Around\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'instead', ru: '&Around' },
  { re: /&Перед\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'before', ru: '&Перед' },
  { re: /&Before\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'before', ru: '&Before' },
  { re: /&После\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'after', ru: '&После' },
  { re: /&After\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'after', ru: '&After' },
  { re: /&ИзменениеИКонтроль\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'changeAndValidate', ru: '&ИзменениеИКонтроль' },
  { re: /&ChangeAndValidate\s*\(\s*"([^"]+)"\s*\)/gi, kind: 'changeAndValidate', ru: '&ChangeAndValidate' },
];

/**
 * @typedef {object} ExtensionInfo
 * @property {string} name
 * @property {string} synonym
 * @property {string} purpose
 * @property {string} purposeRu
 * @property {string} namePrefix
 * @property {string} version
 * @property {number} objectCount всего объектов в расширении
 * @property {number} adoptedCount заимствованных из основной конфигурации
 * @property {number} ownCount собственных
 * @property {string[]} adoptedObjects список заимствованных объектов
 * @property {string[]} adoptedKeys ключи заимствованных объектов («Catalog.Имя»)
 * @property {string[]} ownKeys ключи собственных объектов расширения
 * @property {object} annotations статистика аннотаций переопределения
 * @property {number} moduleCount
 * @property {number} codeLines
 * @property {string} risk 'low' | 'medium' | 'high'
 */

/**
 * @param {{name: string, dir: string}[]} extensionDirs
 * @returns {Promise<ExtensionInfo[]>}
 */
export async function parseExtensions(extensionDirs) {
  const result = [];
  for (const ext of extensionDirs) {
    try {
      result.push(await parseExtension(ext));
    } catch (err) {
      log.warn(`Не удалось разобрать расширение ${ext.name}: ${err.message}`);
      result.push({
        name: ext.name,
        synonym: '',
        purpose: '',
        purposeRu: 'не определено',
        namePrefix: '',
        version: '',
        objectCount: 0,
        adoptedCount: 0,
        ownCount: 0,
        adoptedObjects: [],
        adoptedKeys: [],
        ownKeys: [],
        annotations: emptyAnnotations(),
        moduleCount: 0,
        codeLines: 0,
        risk: 'unknown',
        parseError: err.message,
      });
    }
  }
  return result;
}

function emptyAnnotations() {
  return { instead: 0, before: 0, after: 0, changeAndValidate: 0, total: 0, insteadTargets: [] };
}

async function parseExtension({ name, dir }) {
  const configFile = path.join(dir, 'Configuration.xml');
  const info = {
    name,
    synonym: '',
    purpose: '',
    purposeRu: 'не определено',
    namePrefix: '',
    version: '',
    objectCount: 0,
    adoptedCount: 0,
    ownCount: 0,
    adoptedObjects: [],
    // Ключи в том же виде, что в ConfigDumpInfo («Catalog.Номенклатура»):
    // по ним объекты расширения встают в общий перечень изменённых
    // и добавленных объектов метаданных наравне с правками конфигурации.
    adoptedKeys: [],
    ownKeys: [],
    objectsByKind: {},
    annotations: emptyAnnotations(),
    moduleCount: 0,
    codeLines: 0,
    risk: 'low',
    dir,
  };

  if (await pathExists(configFile)) {
    const node = parseXml(await readText(configFile));
    const confNode = find(node, 'Configuration');
    const props = child(confNode, 'Properties');
    info.synonym = extractSynonym(child(props, 'Synonym'));
    info.namePrefix = childText(props, 'NamePrefix');
    info.version = childText(props, 'Version');
    info.purpose = childText(props, 'ConfigurationExtensionPurpose');
    info.purposeRu = PURPOSE_RU[info.purpose] || info.purpose || 'не определено';

    const childObjects = child(confNode, 'ChildObjects');
    if (childObjects) {
      for (const c of childObjects.children) {
        const objName = c.text.trim();
        if (!objName) continue;
        info.objectCount += 1;
        info.objectsByKind[c.local] = (info.objectsByKind[c.local] || 0) + 1;
      }
    }
  }

  // Заимствованные объекты определяются по свойству ObjectBelonging в XML объекта.
  await scanObjectBelonging(dir, info);

  // Аннотации переопределения — по всем модулям расширения.
  await scanAnnotations(dir, info);

  info.ownCount = Math.max(0, info.objectCount - info.adoptedCount);
  info.risk = assessRisk(info);
  return info;
}

/**
 * Проходит по XML объектов расширения и раскладывает их на два множества.
 *
 * `Adopted` — объект заимствован из основной конфигурации, то есть типовой
 * объект расширением ИЗМЕНЁН. Остальные — собственные объекты расширения,
 * то есть ДОБАВЛЕННЫЕ в конфигурацию. Удалить типовой объект расширением
 * нельзя, поэтому третьего множества здесь не бывает.
 *
 * Ключи собираются в служебном виде «Catalog.Номенклатура»: в этом же виде
 * приходят изменения из сравнения с поставщиком, и только так два перечня
 * можно объединить, не задваивая объект, тронутый и там и там.
 */
async function scanObjectBelonging(dir, info) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tag = singularFromDir(entry.name);
    const kind = kindByTag(tag) || null;
    const kindDir = path.join(dir, entry.name);
    let files;
    try {
      files = await fs.readdir(kindDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.xml')) continue;
      try {
        const node = parseXml(await readText(path.join(kindDir, file.name)));
        const belonging = findBelonging(node);
        const objName = file.name.replace(/\.xml$/i, '');
        const key = `${kind ? tag : entry.name}.${objName}`;
        if (belonging === 'Adopted') {
          info.adoptedCount += 1;
          info.adoptedObjects.push(`${kind?.ru || entry.name}: ${objName}`);
          info.adoptedKeys.push(key);
        } else {
          info.ownKeys.push(key);
        }
      } catch {
        /* повреждённый файл — пропускаем */
      }
    }
  }
}

function findBelonging(node) {
  const props = find(node, 'Properties');
  if (!props) return null;
  const value = childText(props, 'ObjectBelonging');
  return value || null;
}

/** Каталоги выгрузки — во множественном числе; приводим к тегу вида. */
function singularFromDir(dirName) {
  const map = {
    Catalogs: 'Catalog', Documents: 'Document', CommonModules: 'CommonModule',
    InformationRegisters: 'InformationRegister', AccumulationRegisters: 'AccumulationRegister',
    Reports: 'Report', DataProcessors: 'DataProcessor', Roles: 'Role', Subsystems: 'Subsystem',
    CommonForms: 'CommonForm', Enums: 'Enum', ChartsOfCharacteristicTypes: 'ChartOfCharacteristicTypes',
  };
  return map[dirName] || dirName.replace(/s$/, '');
}

/** Считает аннотации переопределения по всем .bsl расширения. */
async function scanAnnotations(dir, info) {
  const files = await collectFiles(dir, '.bsl');
  info.moduleCount = files.length;

  for (const file of files) {
    let text;
    try {
      text = await readText(file);
    } catch {
      continue;
    }
    info.codeLines += text.split('\n').length;

    for (const { re, kind } of ANNOTATIONS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        info.annotations[kind] += 1;
        info.annotations.total += 1;
        if (kind === 'instead' && info.annotations.insteadTargets.length < 50) {
          info.annotations.insteadTargets.push({
            target: m[1],
            module: path.relative(dir, file),
          });
        }
      }
    }
  }
}

/**
 * Оценка риска расширения при обновлении типовой конфигурации.
 *
 * high   — подменяет типовые методы (&Вместо) либо заимствует много объектов;
 * medium — расширяет поведение, но затрагивает типовые объекты;
 * low    — только собственные объекты, безопасные аннотации.
 */
export function assessRisk(info) {
  const instead = info.annotations?.instead || 0;
  const adopted = info.adoptedCount || 0;

  if (instead >= 5 || adopted >= 40) return 'high';
  if (instead >= 1 || adopted >= 10) return 'medium';
  if (adopted > 0) return 'medium';
  return 'low';
}

export { PURPOSE_RU };
