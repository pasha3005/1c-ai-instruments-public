/**
 * Реестр эталонных выгрузок типовых конфигураций.
 *
 * Позволяет перейти от оценки доработок «по косвенным признакам» к точному
 * сравнению. Эталон — это слепок перечня объектов (и, если доступно, хешей
 * из ConfigDumpInfo) чистой типовой конфигурации конкретной версии.
 *
 * Эталон готовится один раз на релиз типового решения и переиспользуется для
 * всех клиентов франчайзи, у которых стоит эта версия.
 *
 * Файлы: data/baselines/<id>.json
 *   {
 *     "id": "ut-11.5.14.123",
 *     "title": "1С:Управление торговлей 11.5.14.123",
 *     "configName": "УправлениеТорговлей",
 *     "version": "11.5.14.123",
 *     "objects": ["Catalog.Номенклатура", ...],
 *     "hashes": { "Catalog.Номенклатура": "<configVersion>", ... }
 *   }
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { DATA_DIR } from '../config.js';
import { ensureDir, readJson, writeJson, pathExists, readText } from '../util/fsx.js';
import { parseXml, children } from '../parse/xml.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('baselines');

export const BASELINES_DIR = path.join(DATA_DIR, 'baselines');

/** Список зарегистрированных эталонов. */
export async function listBaselines() {
  await ensureDir(BASELINES_DIR);
  let files;
  try {
    files = await fs.readdir(BASELINES_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const data = await readJson(path.join(BASELINES_DIR, file));
    if (!data) continue;
    out.push({
      id: data.id,
      title: data.title,
      configName: data.configName,
      version: data.version,
      objectCount: data.objects?.length || 0,
      hasHashes: Boolean(data.hashes && Object.keys(data.hashes).length),
    });
  }
  return out;
}

/**
 * Подбирает эталон под разобранную конфигурацию.
 * Сначала ищется точное совпадение имени и версии, затем — только имени.
 */
export async function findBaselineFor(configuration) {
  await ensureDir(BASELINES_DIR);
  let files;
  try {
    files = await fs.readdir(BASELINES_DIR);
  } catch {
    return null;
  }

  const candidates = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const data = await readJson(path.join(BASELINES_DIR, file));
    if (!data?.objects?.length) continue;
    candidates.push(data);
  }
  if (!candidates.length) return null;

  const name = (configuration.name || '').toLowerCase();
  const version = (configuration.version || '').trim();

  const exact = candidates.find(
    (c) => (c.configName || '').toLowerCase() === name && (c.version || '').trim() === version,
  );
  if (exact) {
    log.info(`Найден эталон с точным совпадением версии: ${exact.title}`);
    return exact;
  }

  const sameName = candidates.filter((c) => (c.configName || '').toLowerCase() === name);
  if (sameName.length) {
    log.info(`Найден эталон той же конфигурации, но другой версии: ${sameName[0].title}`);
    return { ...sameName[0], versionMismatch: true };
  }
  return null;
}

/**
 * Создаёт эталон из каталога выгрузки чистой типовой конфигурации.
 * @param {string} dumpDir
 * @param {{id?: string, title?: string}} [meta]
 */
export async function createBaselineFromDump(dumpDir, meta = {}) {
  const { parseConfigurationDump } = await import('../parse/configuration.js');
  const parsed = await parseConfigurationDump(dumpDir);

  const configName = parsed.configuration.name;
  const version = parsed.configuration.version;
  const id = meta.id || slug(`${configName}-${version || 'unknown'}`);
  const title = meta.title
    || `${parsed.configuration.synonym || configName}${version ? ` ${version}` : ''}`;

  const hashes = await readConfigDumpInfo(path.join(dumpDir, 'ConfigDumpInfo.xml'));

  const baseline = {
    id,
    title,
    configName,
    version,
    createdAt: new Date().toISOString(),
    objects: parsed.objects.map((o) => o.fullName),
    hashes,
  };

  await writeJson(path.join(BASELINES_DIR, `${id}.json`), baseline);
  log.info(`Создан эталон ${id}: ${baseline.objects.length} объектов`);
  return baseline;
}

/**
 * Читает ConfigDumpInfo.xml — карту версий объектов.
 * Формат: <ConfigVersions><Metadata name="..." id="..." configVersion="..."/></ConfigVersions>
 */
export async function readConfigDumpInfo(file) {
  if (!(await pathExists(file))) return {};
  try {
    const node = parseXml(await readText(file));
    const versionsNode = node?.local === 'ConfigVersions' ? node : findConfigVersions(node);
    if (!versionsNode) return {};
    const map = {};
    for (const item of children(versionsNode, 'Metadata')) {
      const name = item.attrs.name;
      const version = item.attrs.configVersion || item.attrs.id;
      if (name && version) map[name] = version;
    }
    return map;
  } catch (err) {
    log.warn(`Не удалось прочитать ConfigDumpInfo: ${err.message}`);
    return {};
  }
}

function findConfigVersions(node) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.local === 'ConfigVersions') return c;
    const deep = findConfigVersions(c);
    if (deep) return deep;
  }
  return null;
}

export async function deleteBaseline(id) {
  await fs.rm(path.join(BASELINES_DIR, `${sanitizeId(id)}.json`), { force: true });
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'baseline';
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zа-яё0-9._-]/gi, '');
}
