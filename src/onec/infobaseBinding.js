/**
 * К каким хранилищам подключена информационная база.
 *
 * Зачем. При работе через служебную базу (терминальный сервер заказчика: нет
 * ibcmd, нет лицензии на файловые базы) пользователь указывает сетевые адреса
 * хранилищ — и по условию, поставленному им самим (18.08.2026), это **только
 * те адреса, к которым эта база уже подключена**: либо основной конфигурацией,
 * либо одним из её расширений. Значит, программа обязана это проверить и
 * назвать, чьё это хранилище, а на чужой адрес — отказать, а не идти вслепую.
 *
 * Из того же условия следует главная выгода: если база подключена к хранилищу
 * расширения, **расширение в базе уже есть**. Создавать его не нужно (а в
 * служебную базу и нельзя), и чтение такого хранилища через `-Extension`
 * остаётся чтением.
 *
 * Откуда берутся сведения — двумя файлами, без запуска платформы (проверено
 * 18.08.2026 на этой машине):
 *
 *  1. `%APPDATA%\1C\1CEStart\ibases.v8i` — список информационных баз:
 *     `Connect=File="B:\Базы\База 1";` ↔ `ID=01d107de-…`. По строке соединения
 *     находится GUID базы. Общие списки подключаются через `CommonInfoBases=`
 *     в `1CEStart.cfg`.
 *  2. `%APPDATA%\1C\1cv8\<GUID базы>\<GUID пользователя>\1cv8.pfl` —
 *     «скобкофайл», раздел `GroupDev`:
 *     `ConfigurationRepositoryURL` + `ConfigurationRepositoryUserName` —
 *     привязка ОСНОВНОЙ конфигурации; `ConfigurationExtensionRepositoryInfo` —
 *     по записи на расширение, у каждой свои `URL` и `User`.
 *
 * Чего в этих файлах НЕТ: имени расширения. Расширение обозначено своим
 * идентификатором в базе (`76c59ef7-242e-11f1-…`), и он **не совпадает**
 * с `uuid` из `Configuration.xml` этого же расширения — проверено выгрузкой
 * (`db873711-…`). Список расширений `ibcmd` идентификаторов не печатает вовсе.
 * Поэтому имя называется только там, где следует однозначно (расширение в базе
 * одно), а иначе — «одно из расширений», без выдумки. На чтение это не влияет:
 * платформа не сверяет имя расширения в базе с именем расширения в хранилище
 * (проверено 12.08.2026), поэтому контекстом годится любое существующее
 * расширение базы.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathExists, readText } from '../util/fsx.js';
import { parseConnection } from './connection.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('binding');

/** Порты по умолчанию: адрес с ними и без них — один и тот же адрес. */
const DEFAULT_PORTS = { tcp: '1542', http: '80', https: '443' };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Разбор «скобкофайла» ----------------------------------------------------

/**
 * Разбирает файл 1С в скобках (`1cv8.pfl` и родня) в дерево массивов.
 *
 * Формат простой: `{элемент,элемент,…}`, элементом бывает строка в кавычках
 * (внутренние кавычки удвоены, перевод строки допустим), вложенные скобки
 * либо голый маркер — число, GUID, `#`. Разбор посимвольный, а не регулярками:
 * структура вложенная, и регулярка ломается на первом же значении с запятой.
 *
 * @param {string} text
 * @returns {any[]} дерево из массивов и строк
 */
export function parseBracketFile(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  let i = 0;

  const skip = () => { while (i < src.length && /\s/.test(src[i])) i += 1; };

  const readString = () => {
    i += 1; // открывающая кавычка
    let out = '';
    while (i < src.length) {
      if (src[i] === '"') {
        if (src[i + 1] === '"') { out += '"'; i += 2; continue; }
        i += 1;
        return out;
      }
      out += src[i];
      i += 1;
    }
    return out;
  };

  const readToken = () => {
    let out = '';
    while (i < src.length && !/[,{}]/.test(src[i])) { out += src[i]; i += 1; }
    return out.trim();
  };

  const readNode = () => {
    skip();
    if (src[i] === '{') {
      i += 1;
      const items = [];
      for (;;) {
        skip();
        if (i >= src.length) break;
        if (src[i] === '}') { i += 1; break; }
        if (src[i] === ',') { i += 1; continue; }
        items.push(readNode());
      }
      return items;
    }
    if (src[i] === '"') return readString();
    return readToken();
  };

  const root = readNode();
  return Array.isArray(root) ? root : [root];
}

/**
 * Ищет в дереве значение, идущее сразу за строкой-подписью.
 *
 * Профиль устроен как чередование «имя настройки, её значение», а вложенность
 * у разных сборок платформы разная. Поэтому ищем не по пути, а по подписи:
 * так разбор переживает и новые разделы, и перестановку старых.
 */
function findValueAfter(node, label) {
  if (!Array.isArray(node)) return null;
  for (let i = 0; i < node.length; i += 1) {
    if (node[i] === label && i + 1 < node.length) return node[i + 1];
    const deeper = findValueAfter(node[i], label);
    if (deeper !== null) return deeper;
  }
  return null;
}

/** Значение вида `{"S","текст"}` — строка настройки. */
function stringValue(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node) && node[0] === 'S' && typeof node[1] === 'string') return node[1];
  return '';
}

/**
 * Все значения вида `{"S","текст"}` в поддереве — так достаются перечни
 * (`OpenExtensions2`). Собирать подряд все строки нельзя: в перечень попал бы
 * и сам маркер типа «S».
 */
function collectStringValues(node, out = []) {
  if (!Array.isArray(node)) return out;
  if (node.length === 2 && node[0] === 'S' && typeof node[1] === 'string') {
    if (node[1]) out.push(node[1]);
    return out;
  }
  for (const item of node) collectStringValues(item, out);
  return out;
}

/** Идентификатор расширения в записи привязки: пара `{1,<GUID>}`. */
function findExtensionId(node) {
  if (!Array.isArray(node)) return '';
  if (node.length === 2 && node[0] === '1' && typeof node[1] === 'string' && GUID.test(node[1])) {
    return node[1];
  }
  for (const item of node) {
    const found = findExtensionId(item);
    if (found) return found;
  }
  return '';
}

/** Пара `{{"S","URL"},{"S","значение"}}` в записи привязки расширения. */
function findLabelled(node, label) {
  if (!Array.isArray(node)) return '';
  if (node.length === 2 && stringValue(node[0]) === label) return stringValue(node[1]);
  for (const item of node) {
    const found = findLabelled(item, label);
    if (found) return found;
  }
  return '';
}

/**
 * Привязки к хранилищам из одного профиля пользователя.
 *
 * @returns {{main: {url: string, user: string}|null,
 *            extensions: {id: string, url: string, user: string}[]}}
 */
export function parseBindingProfile(text) {
  const tree = parseBracketFile(text);
  const url = stringValue(findValueAfter(tree, 'ConfigurationRepositoryURL'));
  const user = stringValue(findValueAfter(tree, 'ConfigurationRepositoryUserName'));
  const info = findValueAfter(tree, 'ConfigurationExtensionRepositoryInfo');

  const extensions = [];
  // Значение — `{"#",<GUID типа>,{N,запись,…}}`: в списке первым идёт число
  // записей, дальше сами записи.
  const list = Array.isArray(info) ? info.find((item) => Array.isArray(item)) : null;
  for (const entry of Array.isArray(list) ? list.slice(1) : []) {
    const extUrl = findLabelled(entry, 'URL');
    if (!extUrl) continue;
    extensions.push({ id: findExtensionId(entry), url: extUrl, user: findLabelled(entry, 'User') });
  }

  return { main: url ? { url, user } : null, extensions };
}

/** Имена расширений базы из профиля уровня базы (`Config/OpenExtensions2`). */
export function parseExtensionNames(text) {
  const node = findValueAfter(parseBracketFile(text), 'OpenExtensions2');
  if (!node) return [];
  // Значение — `{"#",<GUID типа>,{N,{"S","Имя"},…}}`: имена лежат строками
  // настроек, а GUID типа и число записей строками настроек не являются.
  return collectStringValues(node);
}

// --- Списки информационных баз -----------------------------------------------

/** Где лежат списки баз: свой каталог пользователя и общий. */
function startDirs() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return [path.join(appData, '1C', '1CEStart'), path.join(programData, '1C', '1CEStart')];
}

/**
 * Разбирает `ibases.v8i`: секция на базу, внутри `Connect=` и `ID=`.
 *
 * @returns {{name: string, connect: string, id: string}[]}
 */
export function parseInfobaseList(text) {
  const bases = [];
  let current = null;
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      if (current) bases.push(current);
      current = { name: section[1], connect: '', id: '' };
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'connect') current.connect = value;
    else if (key === 'id') current.id = value;
  }
  if (current) bases.push(current);
  return bases.filter((b) => b.id);
}

/** Все списки баз: свой, общий и подключённые через `CommonInfoBases`. */
async function listFiles() {
  const files = [];
  for (const dir of startDirs()) {
    const own = path.join(dir, 'ibases.v8i');
    if (await pathExists(own)) files.push(own);
    const cfg = path.join(dir, '1CEStart.cfg');
    if (!(await pathExists(cfg))) continue;
    const text = await readText(cfg).catch(() => '');
    for (const m of text.matchAll(/^\s*CommonInfoBases\s*=\s*(.+)$/gim)) {
      const file = m[1].trim();
      if (file && (await pathExists(file))) files.push(file);
    }
  }
  return [...new Set(files)];
}

/** Строка соединения → сравнимый вид: путь без регистра либо `сервер\база`. */
export function normalizeConnection(value) {
  let conn;
  try {
    conn = parseConnection(value);
  } catch {
    return '';
  }
  if (conn.kind === 'file') return `file:${conn.dbPath.replace(/[\\/]+$/, '').toLowerCase()}`;
  if (conn.kind === 'server') {
    const server = String(conn.server).replace(/:1541$/, '').toLowerCase();
    return `server:${server}\\${String(conn.ref).toLowerCase()}`;
  }
  return `web:${String(conn.url || conn.raw).toLowerCase()}`;
}

/**
 * GUID(ы) базы в списках запуска. Одна база бывает в списке дважды — тогда
 * и профилей два, и смотреть надо оба.
 */
export async function findInfobaseIds(connection) {
  const wanted = normalizeConnection(connection);
  if (!wanted) return [];
  const ids = [];
  for (const file of await listFiles()) {
    const text = await readText(file).catch(() => '');
    for (const base of parseInfobaseList(text)) {
      if (normalizeConnection(base.connect) !== wanted) continue;
      if (!ids.some((item) => item.id === base.id)) {
        ids.push({ id: base.id, name: base.name, file });
      }
    }
  }
  return ids;
}

// --- Привязки базы -----------------------------------------------------------

/** Каталог профилей конфигуратора этого пользователя Windows. */
function profilesRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '1C', '1cv8');
}

/**
 * Привязки базы к хранилищам.
 *
 * @param {string} connection строка соединения служебной базы
 * @returns {Promise<{ok: boolean, reason?: string, base?: string,
 *   main: {url: string, user: string}|null,
 *   extensions: {id: string, url: string, user: string}[],
 *   extensionNames: string[]}>}
 */
export async function readInfobaseBindings(connection) {
  const empty = { main: null, extensions: [], extensionNames: [] };
  const ids = await findInfobaseIds(connection);
  if (!ids.length) {
    return {
      ...empty,
      ok: false,
      reason: 'этой базы нет в списке информационных баз 1С у текущего пользователя Windows',
    };
  }

  const root = profilesRoot();
  const result = {
    ...empty, ok: true, base: ids[0].name, extensions: [], extensionNames: [],
  };
  let found = false;

  for (const { id } of ids) {
    const baseDir = path.join(root, id);
    if (!(await pathExists(baseDir))) continue;

    const baseProfile = path.join(baseDir, '1cv8.pfl');
    if (await pathExists(baseProfile)) {
      for (const name of parseExtensionNames(await readText(baseProfile).catch(() => ''))) {
        if (!result.extensionNames.includes(name)) result.extensionNames.push(name);
      }
    }

    let entries = [];
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(baseDir, entry.name, '1cv8.pfl');
      if (!(await pathExists(file))) continue;
      const profile = parseBindingProfile(await readText(file).catch(() => ''));
      if (!profile.main && !profile.extensions.length) continue;
      found = true;
      if (profile.main && !result.main) result.main = profile.main;
      for (const ext of profile.extensions) {
        if (!result.extensions.some((known) => known.url === ext.url && known.id === ext.id)) {
          result.extensions.push(ext);
        }
      }
    }
  }

  if (!found) {
    return {
      ...empty,
      ok: false,
      base: ids[0].name,
      reason: 'база есть в списке, но её конфигуратор ни разу не подключался к хранилищу '
        + 'под этим пользователем Windows — в профиле нет ни одной привязки',
    };
  }

  log.info(`Привязки базы «${result.base}»: основная ${result.main?.url || 'нет'}, `
    + `расширений ${result.extensions.length}`);
  return result;
}

// --- Сверка адресов ----------------------------------------------------------

/**
 * Приводит адрес хранилища к сравнимому виду.
 *
 * Один и тот же адрес пишут по-разному: платформа хранит каталог как
 * `file://C:/Путь`, пользователь вводит `C:\Путь`; порт 1542 у `tcp://`
 * подразумевается и пишется не всегда; хвостовая косая не значит ничего.
 */
export function normalizeRepoRef(value) {
  let v = String(value || '').trim().replace(/[\\/]+$/, '');
  if (!v) return '';
  if (/^file:\/\//i.test(v)) v = v.slice('file://'.length);

  const network = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/i.exec(v);
  if (network) {
    const scheme = network[1].toLowerCase();
    let host = network[2].toLowerCase();
    const port = DEFAULT_PORTS[scheme];
    if (port) host = host.replace(new RegExp(`:${port}$`), '');
    const tail = (network[3] || '').replace(/\/+$/, '').toLowerCase();
    return `net:${scheme}://${host}${tail}`;
  }

  return `path:${v.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()}`;
}

/**
 * Чьё это хранилище с точки зрения базы.
 *
 * @returns {{kind: 'main'|'extension', user: string, id?: string,
 *            extensionName?: string, ambiguous?: boolean}|null}
 */
export function matchRepository(address, bindings) {
  const wanted = normalizeRepoRef(address);
  if (!wanted || !bindings) return null;

  if (bindings.main && normalizeRepoRef(bindings.main.url) === wanted) {
    return { kind: 'main', user: bindings.main.user || '' };
  }

  const hits = (bindings.extensions || []).filter((e) => normalizeRepoRef(e.url) === wanted);
  if (!hits.length) return null;

  // Имя расширения выводится только тогда, когда следует однозначно:
  // расширение в базе одно. Связи «идентификатор расширения → имя» нет ни
  // в профиле, ни у ibcmd (см. заголовок), а угадывать по порядку записей —
  // значит подписать работу не тем именем.
  const names = bindings.extensionNames || [];
  return {
    kind: 'extension',
    user: hits[0].user || '',
    id: hits[0].id || '',
    extensionName: names.length === 1 ? names[0] : '',
    ambiguous: hits.length > 1,
  };
}

/** Перечень привязок для сообщения об ошибке: человеку надо видеть, что есть. */
export function describeBindings(bindings) {
  const lines = [];
  if (bindings?.main?.url) lines.push(`основная конфигурация — ${bindings.main.url}`);
  for (const ext of bindings?.extensions || []) lines.push(`расширение — ${ext.url}`);
  return [...new Set(lines)];
}
