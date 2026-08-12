/**
 * Хранилище конфигурации 1С: история помещений и код из хранилища.
 *
 * Зачем. Проверять качество кода можно не только по базе, но и по хранилищу —
 * и это ценнее: хранилище знает **кто именно** что поместил. В базе авторство
 * приходится угадывать по пометкам в коде («// ++ ДРБ_Иванов»), а здесь оно
 * записано платформой.
 *
 * Что выяснено опытом на одноразовом стенде (11.08.2026, платформа 8.5.1.1150):
 *
 *  * команды хранилища работают **на любой временной базе** — привязывать её
 *    к хранилищу (`/ConfigurationRepositoryBindCfg`) не нужно. Проверено:
 *    на свежей пустой базе, никогда не связанной с хранилищем, и отчёт
 *    по истории, и выгрузка конфигурации проходят с кодом 0. Это снимает
 *    самый неприятный шаг: привязка меняет базу и требует прав;
 *  * `/ConfigurationRepositoryReport <файл>` пишет **MXL** (табличный документ)
 *    независимо от расширения файла: первые байты — `MOXCEL`. Текстовые ячейки
 *    лежат в нём как `{"#","текст"}`, и этого достаточно, чтобы прочитать
 *    историю, не разбирая формат целиком;
 *  * вид отчёта по умолчанию — по версиям, и только он даёт авторов. С ключом
 *    `-GroupByObject` отчёт становится по объектам, с `-GroupByComment` —
 *    по комментариям, и в обоих пользователь не печатается;
 *  * `/ConfigurationRepositoryDumpCfg <файл>` отдаёт конфигурацию хранилища
 *    файлом `.cf` — дальше её разворачивает `analyze/vendorConfig.js`.
 *
 * И то, что стоило отдельного дня (12.08.2026, живые хранилища пользователя):
 * **хранилищу расширений пустой базы мало — ему нужно расширение этой базы**.
 * Без ключа `-Extension` платформа отвечает «Соединение основной конфигурации
 * с хранилищем расширений конфигураций невозможно», с ключом, но без такого
 * расширения в базе — «расширение конфигурации с указанным именем не найдено».
 * Заводим пустое сами; имя своё, потому что с именем расширения в хранилище
 * платформа его не сверяет (проверено двумя разными именами на одном хранилище).
 *
 * Периода в самих командах нет (есть только диапазон версий `-NBegin`/`-NEnd`),
 * поэтому отчёт читается целиком, а по датам фильтруем сами.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { run } from '../util/proc.js';
import { TIMEOUTS } from '../config.js';
import { ensureDir, pathExists, readText, rmrf } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';
import { parseConnection } from './connection.js';
import { listExtensions, createExtension } from './ibcmd.js';
import { loadCfg, dumpConfigToFiles } from './designer.js';

const log = createLogger('repository');

/**
 * Имя расширения-заглушки в базе-контексте.
 *
 * Хранилищу расширений нужна не основная конфигурация базы, а её расширение:
 * без `-Extension` платформа отвечает «Соединение основной конфигурации
 * с хранилищем расширений конфигураций невозможно».
 *
 * Имя расширения в базе с именем расширения в хранилище **не сверяется** —
 * проверено 12.08.2026 на 8.5.1.1150: история одного и того же хранилища
 * читается и через расширение «Расширение1», и через «ЧужоеИмя», отчёты
 * совпадают до строчки. Поэтому имя берём своё и одно на все хранилища,
 * а не выясняем настоящее.
 */
export const CONTEXT_EXTENSION = 'АИ_ХранилищеРасширения';

/** Префикс имён того же расширения-заглушки: платформа требует его при создании. */
const CONTEXT_EXTENSION_PREFIX = 'АИ';

/**
 * Отказ вида «это хранилище расширений, а вы пришли основной конфигурацией».
 *
 * Разбирается по тексту, потому что код возврата у конфигуратора один и тот же
 * на все беды (см. заголовок onec-infobase-cli): 1 и молчание в stderr.
 */
export function isExtensionRepositoryRefusal(text) {
  return /хранилищ\S*\s+расширени/i.test(String(text || ''));
}

/** Файл, по которому каталог опознаётся как хранилище конфигурации. */
const MARKER = 'cfgrepo.conf';

/** Насколько глубоко искать хранилища внутри указанного каталога. */
const SEARCH_DEPTH = 2;

/**
 * Ищет хранилища конфигурации в каталоге.
 *
 * Пользователь указывает один каталог, а в нём обычно лежат и хранилище
 * основной конфигурации, и хранилища расширений — каждое своей папкой.
 * Поэтому проверяется и сам каталог, и вложенные.
 *
 * @param {string} dir
 * @returns {Promise<{name: string, dir: string}[]>}
 */
export async function findRepositories(dir) {
  const root = path.resolve(dir);
  const found = [];

  const walk = async (current, depth, name) => {
    if (await pathExists(path.join(current, MARKER))) {
      found.push({ name, dir: current });
      // Внутрь хранилища не спускаемся: там служебные каталоги.
      return;
    }
    if (depth >= SEARCH_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await walk(path.join(current, entry.name), depth + 1, entry.name);
    }
  };

  await walk(root, 0, path.basename(root));
  log.info(`Хранилищ найдено: ${found.length} (${found.map((r) => r.name).join(', ') || 'нет'})`);
  return found;
}

/**
 * Пустая файловая база — контекст для команд хранилища.
 *
 * Конфигуратору нужна какая-нибудь база, чтобы вообще запуститься, но
 * привязывать её к хранилищу не требуется (проверено). База создаётся один раз
 * на прогон и живёт в рабочем каталоге.
 *
 * @returns {Promise<string>} путь к базе
 */
export async function createContextInfobase({ platform, workDir, name = 'repo-context' }) {
  const dir = path.join(workDir, name);
  if (await pathExists(path.join(dir, '1Cv8.1CD'))) return dir;
  if (!platform.ibcmd) {
    throw new Error(
      `В платформе ${platform.version} нет ibcmd — временную базу для работы с хранилищем `
      + 'создать нечем. Выберите версию платформы 8.3.14 или новее.',
    );
  }
  await rmrf(dir).catch(() => {});
  await ensureDir(dir);
  await run(platform.ibcmd, [
    'infobase', 'create', `--db-path=${dir}`, '--create-database',
  ], { timeout: TIMEOUTS.configExport });
  log.info(`Создана временная база-контекст для хранилища: ${dir}`);
  return dir;
}

/** Аргументы доступа к хранилищу — одинаковые для всех его команд. */
function repositoryArgs({ dir, user, password }) {
  const args = [`/ConfigurationRepositoryF${dir}`];
  if (user) args.push(`/ConfigurationRepositoryN${user}`);
  if (password) args.push(`/ConfigurationRepositoryP${password}`);
  return args;
}

/** Ключ выбора расширения — общий для команд хранилища и выгрузки. */
function extensionArgs(extension) {
  return extension ? ['-Extension', extension] : [];
}

/**
 * Заводит в базе-контексте пустое расширение, через которое ведётся работа
 * с хранилищами расширений. Уже существующее — переиспользуется.
 *
 * @returns {Promise<{ok: boolean, name?: string, reason?: string}>}
 */
export async function ensureContextExtension({ platform, contextBase, name = CONTEXT_EXTENSION }) {
  if (!platform.ibcmd) {
    return {
      ok: false,
      reason: `в платформе ${platform.version} нет ibcmd — расширение в базе-контексте создать нечем`,
    };
  }
  const conn = parseConnection(contextBase);
  const existing = await listExtensions({ platform, conn });
  if (existing.includes(name)) return { ok: true, name };

  const created = await createExtension({
    platform, conn, name, prefix: CONTEXT_EXTENSION_PREFIX,
  });
  if (!created.ok) return { ok: false, reason: created.reason };
  return { ok: true, name };
}

/**
 * История помещений в хранилище.
 *
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {string} params.contextBase путь к временной базе-контексту
 * @param {string} params.dir каталог хранилища
 * @param {string} params.workDir куда писать отчёт и журнал
 * @param {string} [params.user] пользователь хранилища
 * @param {string} [params.password] его пароль
 * @returns {Promise<{ok: boolean, reason?: string, commits: object[]}>}
 */
export async function repositoryHistory({
  platform, contextBase, dir, workDir, user, password, extension = '',
}) {
  if (!platform.client) {
    return { ok: false, reason: `в платформе ${platform.version} не найден 1cv8.exe`, commits: [] };
  }

  const out = await ensureDir(path.join(workDir, 'repo'));
  const reportFile = path.join(out, `history-${safeName(dir)}.mxl`);
  const logFile = path.join(out, `history-${safeName(dir)}.log`);
  await rmrf(reportFile).catch(() => {});

  try {
    await run(platform.client, [
      'DESIGNER', `/F${contextBase}`,
      ...repositoryArgs({ dir, user, password }),
      '/ConfigurationRepositoryReport', reportFile,
      ...extensionArgs(extension),
      '/DisableStartupDialogs', '/DisableStartupMessages',
      '/Out', logFile,
    ], { timeout: TIMEOUTS.configExport, allowNonZeroExit: true });
  } catch (err) {
    rethrowIfCancelled(err);
    return { ok: false, reason: err.message, commits: [] };
  }

  if (!(await pathExists(reportFile))) {
    const text = (await readSafe(logFile)).trim();
    return {
      ok: false,
      commits: [],
      reason: text
        ? `конфигуратор не построил отчёт по истории: ${text.slice(0, 300)}`
        : 'конфигуратор не построил отчёт по истории хранилища',
    };
  }

  const commits = parseRepositoryReport(await readText(reportFile));
  log.info(`Хранилище ${dir}: помещений в истории ${commits.length}`);
  return { ok: true, commits, reportFile };
}

/**
 * Выгружает конфигурацию хранилища в файл `.cf`.
 *
 * @returns {Promise<{ok: boolean, file?: string, reason?: string}>}
 */
export async function repositoryDumpCfg({
  platform, contextBase, dir, workDir, user, password, version = null, extension = '',
}) {
  const out = await ensureDir(path.join(workDir, 'repo'));
  const cfFile = path.join(out, `${safeName(dir)}${extension ? '.cfe' : '.cf'}`);
  const logFile = path.join(out, `dump-${safeName(dir)}.log`);
  await rmrf(cfFile).catch(() => {});

  try {
    await run(platform.client, [
      'DESIGNER', `/F${contextBase}`,
      ...repositoryArgs({ dir, user, password }),
      '/ConfigurationRepositoryDumpCfg', cfFile,
      ...(version ? ['-v', String(version)] : []),
      ...extensionArgs(extension),
      '/DisableStartupDialogs', '/DisableStartupMessages',
      '/Out', logFile,
    ], { timeout: TIMEOUTS.configExport, allowNonZeroExit: true });
  } catch (err) {
    rethrowIfCancelled(err);
    return { ok: false, reason: err.message };
  }

  if (!(await pathExists(cfFile))) {
    const text = (await readSafe(logFile)).trim();
    return {
      ok: false,
      reason: text
        ? `конфигуратор не выгрузил конфигурацию из хранилища: ${text.slice(0, 300)}`
        : 'конфигуратор не выгрузил конфигурацию из хранилища',
    };
  }
  return { ok: true, file: cfFile };
}

/**
 * Разворачивает `.cfe` расширения в XML через базу-контекст.
 *
 * Для основной конфигурации это делает `analyze/vendorConfig.js` своей временной
 * базой и ibcmd, но расширение так не развернуть: ibcmd умеет создать базу
 * из `.cf`, а `.cfe` — это расширение, живущее внутри базы под своим именем.
 * Поэтому расширение загружается в ту же заглушку базы-контекста и оттуда
 * выгружается в файлы. Проверено 12.08.2026: `/LoadCfg … -Extension` и
 * `/DumpConfigToFiles … -Extension` проходят с кодом 0, в каталоге появляется
 * обычный XML с `Configuration.xml` — тот же формат, что у основной.
 *
 * @returns {Promise<{ok: boolean, dir?: string, reason?: string}>}
 */
export async function expandExtensionCf({
  platform, contextBase, cfFile, workDir, name, extension,
}) {
  const outDir = path.join(workDir, name);
  const conn = parseConnection(contextBase);
  await rmrf(outDir).catch(() => {});
  try {
    await loadCfg({
      platform, conn, cfFile, extension,
      logFile: path.join(workDir, 'repo', `loadcfe-${safeName(name)}.log`),
    });
    await dumpConfigToFiles({
      platform, conn, outDir, extension,
      logFile: path.join(workDir, 'repo', `dumpcfe-${safeName(name)}.log`),
    });
  } catch (err) {
    rethrowIfCancelled(err);
    return { ok: false, reason: err.message };
  }
  return { ok: true, dir: outDir };
}

// --- Разбор отчёта -----------------------------------------------------------

/**
 * Подписи отчёта «по версиям хранилища» — сняты с живого отчёта платформы.
 *
 * Порядок в документе такой:
 *   Версия: / 1
 *   Пользователь: / Разработчик1
 *   Дата создания: / 11.08.2026
 *   Время создания: / 22:57:13
 *   Версия конфигурации: / <может быть пусто>
 *   Комментарий: / Создание хранилища конфигурации
 *   Добавлены: / Конфигурация / Язык.Русский
 *
 * Значение всегда идёт следующей ячейкой после подписи, а перечни объектов —
 * до следующей подписи. На этом и построен разбор: он не зависит ни от разметки
 * MXL, ни от числа колонок.
 */
const LABELS = new Map([
  ['версия:', 'version'],
  ['пользователь:', 'user'],
  ['дата создания:', 'date'],
  ['время создания:', 'time'],
  ['версия конфигурации:', 'configVersion'],
  ['комментарий:', 'comment'],
  ['добавлены:', 'added'],
  ['изменены:', 'changed'],
  ['удалены:', 'removed'],
]);

/** Перечни объектов: под этими подписями идёт список, а не одно значение. */
const LISTS = new Set(['added', 'changed', 'removed']);

/**
 * Разбирает отчёт хранилища в перечень помещений.
 *
 * @param {string} mxl содержимое файла отчёта (MXL)
 * @returns {{version: number, user: string, at: string, comment: string,
 *            added: string[], changed: string[], removed: string[]}[]}
 */
export function parseRepositoryReport(mxl) {
  const cells = extractCells(mxl);
  const commits = [];
  let current = null;
  let list = null;
  let expect = null;

  const flush = () => {
    if (current && current.version != null) commits.push(current);
  };

  for (const cell of cells) {
    const text = cell.trim();
    if (!text) continue;

    const label = LABELS.get(text.toLowerCase());
    if (label) {
      list = LISTS.has(label) ? label : null;
      expect = list ? null : label;
      // Новая версия — новая запись.
      if (label === 'version') {
        flush();
        current = { version: null, user: '', date: '', time: '', configVersion: '', comment: '', added: [], changed: [], removed: [] };
      }
      continue;
    }

    if (!current) continue;

    if (expect) {
      if (expect === 'version') current.version = Number(text) || text;
      else current[expect] = text;
      expect = null;
      continue;
    }
    if (list) current[list].push(text);
  }
  flush();

  return commits.map((c) => ({
    version: c.version,
    user: c.user,
    at: joinDateTime(c.date, c.time),
    date: c.date,
    comment: c.comment,
    configVersion: c.configVersion,
    added: c.added,
    changed: c.changed,
    removed: c.removed,
    /** Все объекты помещения — по ним findings связываются с автором. */
    objects: [...new Set([...c.added, ...c.changed])],
  }));
}

/** Текстовые ячейки MXL в порядке следования. */
function extractCells(text) {
  const out = [];
  for (const match of String(text).matchAll(/\{"#","((?:[^"]|"")*)"/g)) {
    out.push(match[1].replace(/""/g, '"'));
  }
  return out;
}

/** «11.08.2026» + «22:57:13» → ISO-строка; кривые даты не выдумываем. */
function joinDateTime(date, time) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(date || '').trim());
  if (!m) return '';
  const [, dd, mm, yyyy] = m;
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.test(String(time || '').trim()) ? time : '00:00:00';
  return `${yyyy}-${mm}-${dd}T${t}`;
}

/**
 * Отбирает помещения за период и раскладывает по авторам.
 *
 * Границы включительные и заданы датами (без времени): человек указывает
 * «с 1 по 31 августа», имея в виду весь 31-е число.
 *
 * @param {object[]} commits
 * @param {{from?: string, to?: string}} period даты в формате YYYY-MM-DD
 */
export function filterByPeriod(commits, { from = '', to = '' } = {}) {
  const start = from ? `${from}T00:00:00` : '';
  const end = to ? `${to}T23:59:59` : '';
  return commits.filter((c) => {
    if (!c.at) return !start && !end;
    if (start && c.at < start) return false;
    if (end && c.at > end) return false;
    return true;
  });
}

/**
 * Кто последним трогал каждый объект за период.
 *
 * Именно «последним»: замечание к коду относится к тому состоянию, которое
 * лежит в хранилище сейчас, а его сделал автор последнего помещения. Более
 * ранние авторы того же объекта остаются в истории объекта — она показывается
 * рядом, чтобы было видно, что правил не один человек.
 *
 * @param {object[]} commits помещения за период, в порядке отчёта
 * @returns {Map<string, {author: string, at: string, comment: string, authors: string[]}>}
 */
export function authorsByObject(commits) {
  const byObject = new Map();
  const sorted = [...commits].sort((a, b) => Number(a.version) - Number(b.version));

  for (const commit of sorted) {
    for (const object of commit.objects) {
      if (!byObject.has(object)) byObject.set(object, { author: '', at: '', comment: '', authors: [] });
      const entry = byObject.get(object);
      entry.author = commit.user || entry.author;
      entry.at = commit.at || entry.at;
      entry.comment = commit.comment || entry.comment;
      if (commit.user && !entry.authors.includes(commit.user)) entry.authors.push(commit.user);
    }
  }
  return byObject;
}

function safeName(dir) {
  return path.basename(String(dir)).replace(/[^\wа-яёА-ЯЁ-]+/g, '_').slice(0, 40) || 'repo';
}

async function readSafe(file) {
  try {
    if (!(await pathExists(file))) return '';
    return await readText(file);
  } catch {
    return '';
  }
}
