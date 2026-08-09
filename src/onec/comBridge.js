/**
 * Сбор «живых» данных из работающей информационной базы через COM-соединитель.
 *
 * Это единственный способ получить количество записей по объектам метаданных и
 * физическую структуру хранения, не изменяя базу и не требуя монопольного доступа.
 *
 * Этап необязателен: если COM-соединитель не зарегистрирован, нет свободной
 * лицензии или база недоступна — аудит продолжается на основе статического
 * анализа конфигурации, а в отчёте появляется соответствующая оговорка.
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runPowerShell } from '../util/proc.js';
import { TIMEOUTS, LIMITS } from '../config.js';
import { ensureDir, writeJson, readJson, rmrf } from '../util/fsx.js';
import { toComConnectionString } from './connection.js';
import { comConnectorProgId } from './platform.js';
import { createLogger } from '../util/logger.js';
import { isCancelled } from '../util/cancel.js';

const log = createLogger('com');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'collect-live.ps1');

/**
 * Префиксы таблиц в языке запросов для каждого вида объекта метаданных.
 * Русский вариант используется для конфигураций со ScriptVariant = Russian,
 * английский — для English (и как запасной вариант).
 */
const QUERY_PREFIX = {
  Catalog: { ru: 'Справочник', en: 'Catalog' },
  Document: { ru: 'Документ', en: 'Document' },
  InformationRegister: { ru: 'РегистрСведений', en: 'InformationRegister' },
  AccumulationRegister: { ru: 'РегистрНакопления', en: 'AccumulationRegister' },
  AccountingRegister: { ru: 'РегистрБухгалтерии', en: 'AccountingRegister' },
  CalculationRegister: { ru: 'РегистрРасчета', en: 'CalculationRegister' },
  ChartOfCharacteristicTypes: { ru: 'ПланВидовХарактеристик', en: 'ChartOfCharacteristicTypes' },
  ChartOfAccounts: { ru: 'ПланСчетов', en: 'ChartOfAccounts' },
  ChartOfCalculationTypes: { ru: 'ПланВидовРасчета', en: 'ChartOfCalculationTypes' },
  BusinessProcess: { ru: 'БизнесПроцесс', en: 'BusinessProcess' },
  Task: { ru: 'Задача', en: 'Task' },
  ExchangePlan: { ru: 'ПланОбмена', en: 'ExchangePlan' },
};

/** Виды объектов, для которых имеет смысл считать записи. */
export const COUNTABLE_KINDS = Object.keys(QUERY_PREFIX);

/** Полное имя таблицы в языке запросов для объекта метаданных. */
export function queryTableName(kind, name, scriptVariant = 'Russian') {
  const prefixes = QUERY_PREFIX[kind];
  if (!prefixes) return null;
  const prefix = scriptVariant === 'English' ? prefixes.en : prefixes.ru;
  return `${prefix}.${name}`;
}

/**
 * Запрос подсчёта записей одного объекта (используется как откат,
 * если пакетный запрос не выполнился целиком).
 */
export function buildCountQuery(kind, name, scriptVariant = 'Russian') {
  const table = queryTableName(kind, name, scriptVariant);
  if (!table) return null;
  return `ВЫБРАТЬ "${kind}.${name}" КАК Объект, КОЛИЧЕСТВО(*) КАК Кол ИЗ ${table}`;
}

/**
 * Собирает ПАКЕТНЫЙ запрос: количество записей сразу по многим объектам
 * одного вида через ОБЪЕДИНИТЬ ВСЕ.
 *
 * Так на всю ERP уходит несколько десятков запросов вместо нескольких тысяч.
 * Проверено на платформе: конструкция «константа + КОЛИЧЕСТВО(*)» без явной
 * группировки корректна, а пустая таблица просто не возвращает строку —
 * такие объекты проставляются нулями на стороне Node.
 *
 * @param {{kind: string, name: string}[]} objects объекты ОДНОГО вида
 * @param {string} scriptVariant
 * @returns {string|null}
 */
export function buildBatchCountQuery(objects, scriptVariant = 'Russian') {
  const parts = [];
  for (const obj of objects) {
    const table = queryTableName(obj.kind, obj.name, scriptVariant);
    if (!table) continue;
    const id = `${obj.kind}.${obj.name}`;
    parts.push(
      parts.length === 0
        ? `ВЫБРАТЬ "${id}" КАК Объект, КОЛИЧЕСТВО(*) КАК Кол ИЗ ${table}`
        : `ВЫБРАТЬ "${id}", КОЛИЧЕСТВО(*) ИЗ ${table}`,
    );
  }
  if (!parts.length) return null;
  return parts.join('\nОБЪЕДИНИТЬ ВСЕ\n');
}

/**
 * Разбивает объекты на пакеты: по видам, затем по размеру пакета.
 * Слишком длинный запрос платформа компилирует долго, поэтому размер ограничен.
 */
export function buildCountBatches(objects, scriptVariant = 'Russian', batchSize = LIMITS.countBatchSize) {
  /** @type {Map<string, {kind: string, name: string}[]>} */
  const byKind = new Map();
  for (const obj of objects) {
    if (!QUERY_PREFIX[obj.kind]) continue;
    if (!byKind.has(obj.kind)) byKind.set(obj.kind, []);
    byKind.get(obj.kind).push(obj);
  }

  const batches = [];
  for (const [kind, list] of byKind) {
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      const text = buildBatchCountQuery(chunk, scriptVariant);
      if (!text) continue;
      batches.push({
        id: `${kind} ${i + 1}-${i + chunk.length} из ${list.length}`,
        kind,
        text,
        objects: chunk.map((o) => `${o.kind}.${o.name}`),
        // Откат на поштучный подсчёт, если пакет упадёт целиком.
        fallback: chunk.map((o) => ({
          id: `${o.kind}.${o.name}`,
          text: buildCountQuery(o.kind, o.name, scriptVariant),
        })),
      });
    }
  }
  return batches;
}

/**
 * @param {object} params
 * @param {import('./platform.js').PlatformInstall} params.platform
 * @param {import('./connection.js').Connection} params.conn
 * @param {{kind: string, name: string}[]} params.objects объекты для подсчёта
 * @param {string} params.workDir рабочий каталог
 * @param {string} [params.scriptVariant]
 * @param {(done: number, total: number, id: string) => void} [params.onProgress]
 * @returns {Promise<{available: boolean, reason?: string, counts: object[], tables: object[], errors: string[]}>}
 */
export async function collectLiveData({
  platform, conn, objects, workDir, user, password, scriptVariant = 'Russian', onProgress,
}) {
  if (process.platform !== 'win32') {
    return unavailable('Сбор данных через COM доступен только под Windows');
  }
  if (!platform.hasComConnector) {
    return unavailable(`В каталоге ${platform.binDir} не найден comcntr.dll`);
  }

  const dir = await ensureDir(path.join(workDir, 'live'));
  const inputFile = path.join(dir, 'input.json');
  const outputFile = path.join(dir, 'output.json');

  const batches = buildCountBatches(objects, scriptVariant);
  const requested = batches.flatMap((b) => b.objects);

  // ProgID соединителя вычисляется из выбранной платформы (см. platform.js):
  // общий для всей ветки 8.3.x ProgID указывает на DLL последней установленной
  // или отремонтированной сборки этой ветки, а не обязательно на выбранную.
  const progId = comConnectorProgId(platform.version);

  await writeJson(inputFile, {
    binDir: platform.binDir,
    progId,
    connectionString: toComConnectionString(conn, { user, password }),
    budgetSeconds: Math.floor(TIMEOUTS.liveData / 1000) - 60,
    batches,
  });

  log.info(`Сбор живых данных: ${requested.length} объектов в ${batches.length} пакетных запросах (${progId})`);

  try {
    await runPowerShell(SCRIPT, ['-InputFile', inputFile, '-OutputFile', outputFile], {
      timeout: TIMEOUTS.liveData,
      allowNonZeroExit: true,
      onStdout: (chunk) => {
        if (!onProgress) return;
        for (const line of chunk.split(/\r?\n/)) {
          const m = /^PROGRESS\|(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
          if (m) onProgress(Number(m[1]), Number(m[2]), m[3]);
        }
      },
    });
  } catch (err) {
    // Прерывание аудита — не сбой моста: пробрасываем, иначе конвейер пойдёт дальше.
    if (isCancelled(err)) throw err;
    log.warn(`PowerShell-мост завершился с ошибкой: ${err.message}`);
  }

  const output = await readJson(outputFile);
  await rmrf(inputFile).catch(() => {});

  if (!output) {
    return unavailable('PowerShell-мост не вернул результат (см. журнал приложения)');
  }

  // Общий для целой ветки версий ProgID мог фактически указывать не на ту
  // сборку, что выбрана на форме, — мост сверяет это сам (см. collect-live.ps1)
  // и сообщает о расхождении независимо от того, удалось подключиться или нет.
  const mismatch = describeConnectorMismatch(output, platform, progId);

  if (!output.ok) {
    return unavailable(explainComError(output.error, platform, mismatch));
  }

  if (mismatch) {
    log.warn(mismatch);
  }

  // Пакетный запрос не возвращает строку для пустой таблицы, поэтому объекты,
  // которых нет в ответе, — это объекты с нулём записей, а не потерянные.
  const returned = new Map();
  for (const item of output.counts || []) {
    returned.set(item.id, item);
  }
  const counts = requested.map((id) => returned.get(id) || { id, count: 0, error: null });

  return {
    available: true,
    counts,
    tables: output.tables || [],
    errors: output.errors || [],
    durationMs: output.durationMs || 0,
    batchCount: batches.length,
    // Показывается в ходе выполнения, даже если подключение удалось: расхождение
    // версии драйвера — это не сбой, но пользователь должен о нём знать.
    warning: mismatch,
  };
}

/**
 * Сравнивает DLL, которую реально загрузил ProgID, с той, что лежит в bin
 * выбранной платформы.
 *
 * Несовпадение означает: на машине несколько сборок одной ветки (например,
 * 8.3.22, 8.3.24, 8.3.27), и COM использует ту, что зарегистрирована сейчас, —
 * не обязательно ту, что выбрана на форме. Само по себе это не обязательно
 * приводит к отказу — обычно сборки внутри одной ветки совместимы, — но
 * объясняет происхождение странных отказов подключения, если они всё же
 * случаются: рабочая часть конвейера (выгрузка, сравнение с поставщиком) идёт
 * через одну версию платформы, а сбор живых данных — через другую.
 */
function describeConnectorMismatch(output, platform, progId) {
  if (!output?.connectorDll || !platform?.binDir) return null;
  const expected = `${platform.binDir}\\comcntr.dll`.toLowerCase();
  const actual = String(output.connectorDll).toLowerCase();
  if (actual === expected) return null;
  return (
    `ProgID ${progId} зарегистрирован не на выбранную версию платформы: `
    + `фактически используется «${output.connectorDll}» вместо «${expected}». `
    + 'На машине, видимо, несколько сборок этой ветки платформы, и COM использует ту, ' +
    'что была установлена или отремонтирована последней.'
  );
}

function unavailable(reason) {
  log.warn(`Сбор живых данных недоступен: ${reason}`);
  return { available: false, reason, counts: [], tables: [], errors: [] };
}

/**
 * Человеческое объяснение отказа COM-подключения.
 *
 * Сам мост написан на PowerShell и только латиницей (кириллица в .ps1 без BOM
 * ломается — задокументированные грабли проекта), поэтому наружу он отдаёт
 * текст ошибки как есть, от платформы: «Ne udalos podklyuchitsya…: Library not
 * registered. (Исключение из HRESULT: 0x8002801D)». Пользователю такое читать
 * нечем: непонятно ни что случилось, ни что делать.
 *
 * Переводим здесь, в Node, и добавляем причину и способ устранения. Исходный
 * текст сохраняем в скобках — по нему ищут в интернете и в поддержке 1С.
 *
 * @param {string} raw текст ошибки от моста
 * @param {import('./platform.js').PlatformInstall} [platform]
 * @param {string|null} [mismatch] расхождение версии драйвера, если оно
 *   обнаружено (см. `describeConnectorMismatch`) — при отказе подключения
 *   это куда вероятнее объясняет причину, чем «не зарегистрирован», особенно
 *   если пользователь проверил регистрацию и она на месте.
 */
export function explainComError(raw, platform = null, mismatch = null) {
  const text = String(raw || '').trim();
  if (!text) return 'Не удалось подключиться к базе через COM: платформа не сообщила причину';

  const dll = platform?.binDir ? `${platform.binDir}\\comcntr.dll` : 'comcntr.dll';
  const register = `Зарегистрируйте его командой от имени администратора: regsvr32 "${dll}"`;

  for (const { match, title, detail } of COM_ERRORS) {
    if (!match.test(text)) continue;
    // Библиотека класса зарегистрирована, но не та, что в выбранной версии
    // платформы, — «зарегистрируйте comcntr.dll» здесь только собьёт с толку:
    // он и так зарегистрирован, просто не тот файл.
    if (mismatch && (match.source.includes('TYPE_E_LIBNOTREGISTERED') || match.source.includes('REGDB_E_CLASSNOTREG'))) {
      return `COM-соединитель зарегистрирован не на ту сборку платформы. ${mismatch} ` +
        'Совпадающие внутри одной ветки версии (например, разные сборки 8.3.x) обычно ' +
        'совместимы — установите или отремонтируйте именно выбранную сборку последней, ' +
        `чтобы её регистрация не перекрывалась другой. (${text})`;
    }
    return `${title}. ${typeof detail === 'function' ? detail({ register, dll, platform }) : detail} (${text})`;
  }

  return `Не удалось подключиться к базе через COM: ${text}`;
}

/**
 * Разбор кодов COM. Коды HRESULT надёжнее текста: он приходит на языке
 * системы, а на серверах это нередко английский.
 */
const COM_ERRORS = [
  {
    // TYPE_E_LIBNOTREGISTERED
    match: /0x8002801D|TYPE_E_LIBNOTREGISTERED|Library not registered|Библиотека не зарегистрирована/i,
    title: 'COM-соединитель 1С не зарегистрирован в системе',
    detail: ({ register, platform }) =>
      'Платформа установлена, но её библиотека COM-соединителя (comcntr.dll) не числится '
      + `в реестре Windows для класса ${comConnectorProgId(platform?.version)}. ${register}. `
      + 'Разрядность важна: 64-разрядному приложению нужен 64-разрядный comcntr.dll. '
      + 'Если вы уверены, что регистрировали именно эту сборку, — на машине могло позже '
      + 'установиться или отремонтироваться другая сборка той же ветки версий и перекрыть '
      + 'регистрацию собой: класс общий на всю ветку major.minor, а не на точный номер сборки. '
      + 'Без подсчёта записей аудит выполнится — не будет только раздела о данных.',
  },
  {
    // REGDB_E_CLASSNOTREG
    match: /0x80040154|REGDB_E_CLASSNOTREG|Class not registered|Класс не зарегистрирован/i,
    title: 'Класс V83.COMConnector не зарегистрирован',
    detail: ({ register }) =>
      'Windows не знает такого COM-класса: соединитель не зарегистрирован либо зарегистрирован '
      + `в другой разрядности. ${register}.`,
  },
  {
    // TYPE_E_CANTLOADLIBRARY
    match: /0x80029C4A|TYPE_E_CANTLOADLIBRARY|Не удалось загрузить библиотеку/i,
    title: 'Библиотеку COM-соединителя не удалось загрузить',
    detail: ({ platform }) =>
      'Обычно это значит, что рядом с comcntr.dll не оказалось остальных библиотек платформы: '
      + `каталог ${platform?.binDir || 'bin'} должен быть доступен процессу. `
      + 'Реже — несовпадение разрядности платформы и приложения.',
  },
  {
    match: /Идентификация пользователя не выполнена|Invalid user name or password|неверн\w* парол/i,
    title: 'База не приняла имя пользователя или пароль',
    detail: 'Укажите пользователя 1С с правом администрирования и его пароль в параметрах аудита.',
  },
  {
    match: /монопольн|exclusive mode|заблокирован\w* соединени/i,
    title: 'База занята в монопольном режиме',
    detail: 'Подключиться к ней нельзя, пока открыт конфигуратор или выполняется обновление. '
      + 'Закройте монопольный сеанс и повторите аудит.',
  },
  {
    match: /Файл базы данных.*(не найден|поврежд)|Не обнаружен файл|1Cv8\.1CD/i,
    title: 'Файл информационной базы недоступен',
    detail: 'Проверьте путь к базе и права на каталог: процессу нужен доступ на чтение.',
  },
];

/** Быстрая проверка доступности COM-соединителя без обращения к базе. */
export async function probeComConnector(platform) {
  if (process.platform !== 'win32') return { ok: false, reason: 'не Windows' };
  if (!platform?.hasComConnector) return { ok: false, reason: 'comcntr.dll не найден' };
  return { ok: true };
}

/** Каталог для временных файлов моста, если рабочий каталог не задан. */
export function defaultBridgeDir() {
  return path.join(os.tmpdir(), 'onec-audit-com');
}
