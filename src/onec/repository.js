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
import { parseConnection, toClientArgs } from './connection.js';
import { listExtensions, createExtension } from './ibcmd.js';
import {
  loadCfg, dumpConfigToFiles, createInfobase, createExtensionByDesigner,
} from './designer.js';

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

/**
 * Отказ «расширение конфигурации с указанным именем не найдено».
 *
 * Отличать его от предыдущего важно: там платформа говорит «вы пришли к
 * хранилищу расширений основной конфигурацией», а здесь — «расширение,
 * которым вы пришли, в базе отсутствует». Имя расширения программа берёт
 * из профиля конфигуратора (`infobaseBinding.js`), а профиль отстаёт от базы:
 * расширение могли удалить или переименовать. Тогда пробуется следующее.
 */
export function isMissingExtension(text) {
  return /с\s+указанным\s+именем\s+не\s+найден/i.test(String(text || ''));
}

/** Файл, по которому каталог опознаётся как хранилище конфигурации. */
const MARKER = 'cfgrepo.conf';

/** Насколько глубоко искать хранилища внутри указанного каталога. */
const SEARCH_DEPTH = 2;

/**
 * Сетевой адрес хранилища: `tcp://сервер[:порт]/хранилище`, а также `http://`
 * и `https://` для доступа через веб-сервер.
 *
 * Хранилище живёт не только каталогом на диске: у сервера хранилищ
 * (`crserver`) свой адрес, и в крупных внедрениях доступ к хранилищу дают
 * только так — файловой шары к нему может не быть вовсе.
 */
const NETWORK_ADDRESS = /^(?:tcp|https?):\/\/[^\s/]+(?:\/[^\s]*)?$/i;

/** Похоже ли указанное на сетевой адрес хранилища, а не на путь к каталогу. */
export function isNetworkRepository(value) {
  return NETWORK_ADDRESS.test(String(value || '').trim());
}

/**
 * Разбирает поле «Сетевой адрес хранилища» в перечень хранилищ.
 *
 * Адресов может быть несколько — по одному на строку или через точку с запятой:
 * у основной конфигурации и у каждого расширения хранилище своё, и живут они
 * на одном сервере разными адресами. Каталог на диске программа обходит сама
 * и находит их все (`findRepositories`), а сетевой адрес перечислить нечем:
 * список хранилищ сервер не отдаёт, спросить можно только конкретное.
 *
 * Имя хранилища для отчёта — последний сегмент адреса. Совпали у разных
 * адресов — берём два последних сегмента: в таблице помещений имя хранилища
 * служит заголовком, и два одинаковых заголовка читались бы как одно
 * хранилище.
 *
 * @param {string} value
 * @returns {{name: string, dir: string}[]}
 */
export function parseRepositoryAddresses(value) {
  const addresses = String(value || '')
    .split(/[\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const segments = (address) => address
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')
    .filter(Boolean);

  const names = addresses.map((address) => segments(address).slice(-1)[0] || address);
  return addresses.map((address, i) => {
    const own = names[i];
    const duplicated = names.filter((name) => name === own).length > 1;
    const parts = segments(address);
    return {
      name: duplicated ? parts.slice(-2).join('/') || address : own,
      dir: address,
      isNetwork: true,
    };
  });
}

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
export async function createContextInfobase({
  platform, workDir, name = 'repo-context', serviceBase = '', user = '', password = '',
}) {
  // Своя база нужна не всегда: пользователь может указать служебную —
  // и на терминальном сервере без лицензий на файловые базы это
  // единственный способ вообще запустить конфигуратор. Подробности —
  // в докблоке `serviceContext`.
  if (serviceBase) return serviceContext(serviceBase, user, password);

  const dir = path.join(workDir, name);
  if (await pathExists(path.join(dir, '1Cv8.1CD'))) return { base: dir, user: '', password: '' };

  await rmrf(dir).catch(() => {});
  await ensureDir(dir);

  // ibcmd быстрее и не требует лицензии — берём его, когда он есть. А есть он
  // не всегда: `ibcmd.exe` входит в СЕРВЕРНУЮ часть платформы, и на машине,
  // где стоит только клиент (обычное дело для терминального сервера
  // заказчика), его нет ни в какой версии. Тогда базу создаёт сам `1cv8.exe`
  // режимом CREATEINFOBASE.
  if (platform.ibcmd) {
    await run(platform.ibcmd, [
      'infobase', 'create', `--db-path=${dir}`, '--create-database',
    ], { timeout: TIMEOUTS.configExport });
  } else {
    log.info(`ibcmd в платформе ${platform.version} нет — базу создаёт 1cv8 CREATEINFOBASE`);
    await createInfobase({ platform, dir, logFile: path.join(workDir, 'repo-context.log') });
  }

  log.info(`Создана временная база-контекст для хранилища: ${dir}`);
  return { base: dir, user: '', password: '' };
}

/**
 * Служебная база, указанная пользователем, вместо временной.
 *
 * Зачем (13.08.2026, сервер заказчика). Конфигуратору нужна **лицензия**,
 * и берётся она по-разному: для СЕРВЕРНОЙ базы её выдаёт сервер 1С, а для
 * файловой нужен местный ключ защиты или программная лицензия на этой машине.
 * На терминальном сервере заказчика местных лицензий нет вовсе — люди работают
 * в серверной базе и получают лицензию с сервера. Поэтому наша временная
 * файловая база честно создавалась, а конфигуратор на ней падал:
 * «Не найдена лицензия. Не обнаружен ключ защиты программы или полученная
 * программная лицензия!» Указанная серверная база лицензию получает — и всё
 * работает.
 *
 * Отсюда же ограничение, о котором сказано в интерфейсе прямо: база
 * СЛУЖЕБНАЯ. Разворачивание конфигурации хранилища в XML идёт загрузкой
 * в базу (`/LoadCfg`), то есть её конфигурация перезаписывается. Рабочую базу
 * указывать нельзя, и решать это за пользователя мы не можем — только сказать.
 */
function serviceContext(serviceBase, user, password) {
  const conn = parseConnection(serviceBase);
  log.info(`Работа с хранилищем идёт через служебную базу: ${conn.display}`);
  return { base: serviceBase, user: user || '', password: password || '', service: true };
}

/** Аргументы запуска конфигуратора на базе-контексте — файловой или серверной. */
function contextArgs(context) {
  const { base, user, password } = normalizeContext(context);
  const args = [...toClientArgs(parseConnection(base))];
  if (user) args.push(`/N${user}`);
  if (password) args.push(`/P${password}`);
  return args;
}

/**
 * Прежде база-контекст была просто путём, теперь это `{base, user, password}`.
 * Строку тоже принимаем: так вызывают тесты и старый код, и ломать их
 * ради формы аргумента незачем.
 */
function normalizeContext(context) {
  return typeof context === 'string'
    ? { base: context, user: '', password: '' }
    : { base: context?.base || '', user: context?.user || '', password: context?.password || '' };
}

/**
 * Что проверить, если хранилище задано адресом и платформа отказала.
 *
 * Сетевой адрес прячет в себе три вещи, которых не видно в тексте отказа
 * платформы, а спросить у неё их нельзя. Пишем их прямо в сообщение: человек
 * читает его на сервере заказчика, где спросить не у кого.
 *
 * Обычной подсказкой «проверьте сеть» тут не отделаться: `tcp://` — протокол
 * самой 1С, его обслуживает `crserver`. То, что адрес не открывается ни
 * проводником, ни браузером, — не признак неисправности: они этого протокола
 * и не знают.
 */
/**
 * Отказ по лицензии — не про хранилище, и подсказка нужна совсем другая.
 *
 * Конфигуратор берёт лицензию по-разному: для СЕРВЕРНОЙ базы её выдаёт сервер
 * 1С, для файловой нужен ключ защиты или программная лицензия на этой самой
 * машине. На терминальном сервере заказчика местных лицензий нет — люди
 * работают в серверной базе и получают лицензию с сервера, — и наша временная
 * файловая база упиралась в «Не найдена лицензия». Гадать при таком ответе
 * про адрес хранилища и пароли бессмысленно: до хранилища дело не дошло.
 */
/**
 * Что дописать к отказу платформы, чтобы человеку было с чем работать.
 *
 * Лицензия отменяет все прочие советы: до хранилища дело не дошло, и говорить
 * про адреса и пароли значило бы посылать по ложному следу.
 */
export function repositoryHint(text, dir) {
  return licenseHint(text) || networkHint(dir);
}

function licenseHint(text) {
  if (!/лицензи|ключ защиты/i.test(String(text || ''))) return '';
  return '\nЭто отказ ПЛАТФОРМЫ в лицензии, а не отказ хранилища — до хранилища '
    + 'дело не дошло. Конфигуратор получает лицензию с сервера 1С только когда '
    + 'работает с серверной базой; временной файловой базе нужна лицензия '
    + 'на этой машине, а её может не быть. Укажите в форме служебную базу '
    + '1С (лучше серверную) — программа будет работать с хранилищем через неё.';
}

function networkHint(dir) {
  if (!isNetworkRepository(dir)) return '';
  return `\nАдрес передан платформе как есть: ${dir}. Проверьте три вещи: `
    + 'порт сервера хранилищ (по умолчанию 1542; если он другой, пишется в адресе — '
    + 'tcp://сервер:порт/хранилище); имя и пароль пользователя ХРАНИЛИЩА, а не базы; '
    + 'открывается ли этот же адрес конфигуратором с этой машины '
    + '(Конфигурация → Хранилище конфигурации → Открыть конфигурацию из хранилища).';
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
export async function ensureContextExtension({
  platform, contextBase, workDir = '', name = CONTEXT_EXTENSION,
}) {
  const context = normalizeContext(contextBase);
  const conn = parseConnection(context.base);

  // Без ibcmd (клиентская установка платформы) расширение заводит конфигуратор —
  // окольным путём, зато проверенным на четырёх сборках. Подробности и причина,
  // почему путь именно такой, — в `createExtensionByDesigner`.
  if (!platform.ibcmd) {
    const made = await createExtensionByDesigner({
      platform, conn, name,
      workDir: workDir || path.dirname(context.base),
      user: context.user, password: context.password,
    });
    return made.ok ? { ok: true, name } : made;
  }

  const existing = await listExtensions({
    platform, conn, user: context.user, password: context.password,
  });
  if (existing.includes(name)) return { ok: true, name };

  const created = await createExtension({
    platform, conn, name, prefix: CONTEXT_EXTENSION_PREFIX,
    user: context.user, password: context.password,
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
      'DESIGNER', ...contextArgs(contextBase),
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
      reason: (text
        ? `конфигуратор не построил отчёт по истории: ${text.slice(0, 300)}`
        : 'конфигуратор не построил отчёт по истории хранилища')
        + repositoryHint(text, dir),
    };
  }

  const commits = parseRepositoryReport(await readText(reportFile));
  log.info(`Хранилище ${dir}: помещений в истории ${commits.length}`);
  return { ok: true, commits, reportFile };
}

/**
 * Выгружает конфигурацию хранилища в файл `.cf`.
 *
 * **Номер версии входит в имя файла**, и это не украшательство. Без него все
 * версии писались в один путь, а вызывающий получал одно и то же имя: сравнение
 * версий N и N−1 (`buildPlacementDiffsByCompare`) отдавало платформе два
 * одинаковых аргумента и сравнивало файл сам с собой. Правки помещений при этом
 * выходили пустыми при полностью успешном сравнении — дефект найден 17.08.2026.
 *
 * @returns {Promise<{ok: boolean, file?: string, reason?: string}>}
 */
export async function repositoryDumpCfg({
  platform, contextBase, dir, workDir, user, password, version = null, extension = '',
}) {
  const out = await ensureDir(path.join(workDir, 'repo'));
  const suffix = version ? `-v${version}` : '';
  const cfFile = path.join(out, `${safeName(dir)}${suffix}${extension ? '.cfe' : '.cf'}`);
  const logFile = path.join(out, `dump-${safeName(dir)}${suffix}.log`);
  await rmrf(cfFile).catch(() => {});

  try {
    await run(platform.client, [
      'DESIGNER', ...contextArgs(contextBase),
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
  const context = normalizeContext(contextBase);
  const conn = parseConnection(context.base);
  const auth = { user: context.user, password: context.password };
  await rmrf(outDir).catch(() => {});
  try {
    await loadCfg({
      platform, conn, cfFile, extension, ...auth,
      logFile: path.join(workDir, 'repo', `loadcfe-${safeName(name)}.log`),
    });
    await dumpConfigToFiles({
      platform, conn, outDir, extension, ...auth,
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

/**
 * Имя файла журнала и выгрузки по расположению хранилища.
 *
 * У каталога берётся его имя, у сетевого адреса — адрес целиком без схемы:
 * `path.basename('tcp://сервер/erp/основная')` дал бы «основная», и два
 * хранилища с одинаковым последним сегментом на разных серверах писали бы
 * в один и тот же файл, затирая отчёт друг друга.
 */
function safeName(dir) {
  const value = String(dir);
  const base = isNetworkRepository(value)
    ? value.replace(/^[a-z]+:\/\//i, '')
    : path.basename(value);
  return base.replace(/[^\wа-яёА-ЯЁ-]+/g, '_').slice(0, 60) || 'repo';
}

async function readSafe(file) {
  try {
    if (!(await pathExists(file))) return '';
    return await readText(file);
  } catch {
    return '';
  }
}
