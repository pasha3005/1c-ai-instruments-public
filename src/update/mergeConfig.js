/**
 * Объединение трёх выгрузок конфигурации — то же, что делает конфигуратор
 * при обновлении конфигурации на поддержке, но по файлам XML-выгрузки.
 *
 *   основная конфигурация  (ours)   ← результат пишется прямо в неё
 *   старая поставка        (base)   ← общая точка отсчёта
 *   новая поставка         (theirs) ← то, на что обновляемся
 *
 * Что здесь происходит и почему именно так.
 *
 * **Результат пишется в выгрузку основной конфигурации, на месте.** Требование
 * пользователя дословно: «все результаты объединения сохрани в файлах
 * конфигурации, которую ты выгрузил, после чего загрузи эти файлы обратно».
 * Отдельный каталог-результат означал бы второй экземпляр выгрузки — на ERP
 * это ещё несколько гигабайт, и главное: загружать в базу надо ровно то,
 * что человек мог перед этим поправить руками.
 *
 * **Дважды изменённое место сначала пробуется разобрать самостоятельно**
 * (`autoResolve.js`) и только потом объявляется конфликтом. Каждое такое
 * решение попадает в отчёт отдельным разделом — с тремя исходными версиями
 * и получившимся результатом, чтобы его можно было проверить.
 *
 * **Конфликт не ломает файл.** При нерешённом участке в файл идёт наша версия,
 * а участок целиком уходит в отчёт и в каталог «Конфликты» тремя версиями.
 * Маркеры вида «<<<<<<<» сделали бы файл незагружаемым, а загрузка —
 * обязательный следующий шаг.
 *
 * **Стороны — не обязательно каталоги.** Старая поставка чаще всего приходит
 * не файлом `.cf`, а восстановленной из самой базы (`vendorSources.js`),
 * и материализовать её на диск незачем. Поэтому все три стороны здесь —
 * «деревья»: перечень файлов и чтение по требованию.
 *
 * **Чужие файлы, оставшиеся без ссылки, безвредны.** Если объект новой поставки
 * скопирован, но не попал в состав конфигурации, платформа его при загрузке
 * просто не увидит: состав читается из Configuration.xml и XML самих объектов,
 * а не по содержимому каталога. Поэтому состав правится отдельно
 * (`patchChildObjects`), и при неудаче правки риск сводится к «объект придётся
 * добавить руками», а не к испорченной конфигурации.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { merge3, splitLines, joinLines, twoWayHunks, changedHunks } from './diff3.js';
import { autoResolve } from './autoResolve.js';
import { describeDumpPath, objectTitle, childObjectLine, ROOT_KEY } from './dumpKeys.js';
import { buildXmlOutline, describeXmlRange } from './xmlOutline.js';
import { mergeSupportTables } from './supportTable.js';
import { isParentCfPath, SUPPORT_FILE } from './parentCf.js';
import { tokenize } from '../analyze/bsl/lexer.js';
import { analyzeStructure, findRoutineAtLine } from '../analyze/bsl/structure.js';
import { ensureDir, pathExists, readText } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { throwIfCancelled, rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('merge');

/** Расширения, которые объединяются построчно. Остальное — двоичное. */
const TEXT_EXT = new Set(['.bsl', '.xml', '.txt', '.html', '.htm', '.json', '.svg', '.xsd', '.md', '.css', '.js']);

/** Карта версий выгрузки: после объединения она недействительна. */
const DUMP_INFO = 'ConfigDumpInfo.xml';

/** Сколько файлов с конфликтами сохранять подробно (код в отчёте и на диске). */
const CONFLICT_FILES_LIMIT = 300;
/**
 * Сколько файлов, разобранных самими, сохранять на диск целиком.
 *
 * Свой счётчик, а не общий с конфликтами: разобранных автоматически бывает
 * на порядок больше, и один счётчик означал бы, что нерешённые места вытеснены
 * с диска решёнными — а окно разбора без исходных версий бесполезно именно там,
 * где решение принимает человек.
 */
const RESOLVED_FILES_LIMIT = 300;
/** Сколько участков конфликта показывать по одному файлу. */
const CONFLICTS_PER_FILE = 20;
/** Сколько автоматических решений показывать по одному файлу. */
const RESOLVED_PER_FILE = 20;
/** Сколько строк показывать в одной колонке участка. */
const FRAGMENT_LINES = 200;
/**
 * Сколько файлов перечислять по одному объекту и сколько объектов — в группе.
 *
 * На обновлении реальной ERP из новой поставки приходят десятки тысяч файлов,
 * и перечислить их все значило бы отдать в интерфейс результат на десятки
 * мегабайт. Числа в итогах при этом точные — обрезается только перечень.
 */
const ELEMENTS_PER_OBJECT = 50;
const OBJECTS_PER_GROUP = 500;
/** Каталог с тремя версиями каждого конфликтного файла. */
export const CONFLICT_DIR = 'Конфликты';

/**
 * Имена файлов внутри каталога версий.
 *
 * Ими же пользуется окно разбора спорных мест (`update/mergeReview.js`):
 * читать их по одному соглашению с двух сторон надёжнее, чем перечислять
 * имена дважды.
 */
export const VERSION_FILES = {
  base: 'старая-поставка',
  theirs: 'новая-поставка',
  ours: 'основная-конфигурация',
  auto: 'результат-объединения',
};

/**
 * Дерево-каталог: перечень файлов и чтение с диска.
 * @param {string} dir
 */
export async function dirTree(dir) {
  const files = await listFiles(dir);
  return {
    dir,
    source: 'dump',
    files,
    read: (rel) => fs.readFile(path.join(dir, rel)),
  };
}

/**
 * @param {object} params
 * @param {string} params.mainDir выгрузка основной конфигурации (в неё же и пишем)
 * @param {object|null} params.baseTree СТАРАЯ поставка: `{files, read, unknown?}`
 * @param {object} params.targetTree НОВАЯ поставка
 * @param {Set<string>|null} [params.touchedObjects] ключи объектов, изменённых
 *   интегратором — нужны только когда старой поставки нет вовсе
 * @param {string} params.conflictRoot куда складывать три версии конфликтных файлов
 * @param {(done: number, total: number, rel: string) => void} [params.onProgress]
 */
export async function mergeConfigurations({
  mainDir, baseTree, targetTree, touchedObjects = null, conflictRoot, onProgress,
}) {
  const main = await dirTree(mainDir);
  const base = baseTree || { files: new Map(), read: async () => Buffer.alloc(0), unknown: new Set() };
  const mode = baseTree ? (baseTree.source === 'restored' ? 'restored' : 'three-way') : 'keys';

  const rels = [...new Set([...main.files.keys(), ...base.files.keys(), ...targetTree.files.keys()])]
    .filter((rel) => rel !== DUMP_INFO)
    .sort();

  const state = {
    mode,
    mainDir,
    conflictRoot,
    main,
    base,
    target: targetTree,
    /** Файлы, содержимое которых у поставщика неизвестно (восстановление из базы). */
    unknown: base.unknown || new Set(),
    /**
     * Свойства, которые интегратор изменил относительно поставщика: ключ
     * объекта → подписи свойств из отчёта сравнения. По ним разбирается XML,
     * прежнего состояния которого у поставщика мы не знаем.
     */
    changedProps: base.changedProps || new Map(),
    /**
     * Свойства, которые изменил САМ ПОСТАВЩИК между текущим и новым релизом, —
     * из второго сравнения (конфигурация поставщика ↔ файл новой поставки).
     * Пересечение с `changedProps` и есть настоящее «изменили оба».
     */
    vendorProps: base.vendorProps || new Map(),
    /** Было ли второе сравнение: без него о правках поставщика судить нечем. */
    aheadKnown: Boolean(base.aheadKnown),
    touchedObjects,
    objects: new Map(),
    totals: {
      files: rels.length,
      unchanged: 0,
      fromVendor: 0,
      keptOurs: 0,
      merged: 0,
      autoResolved: 0,
      conflicted: 0,
      addedByVendor: 0,
      removedByVendor: 0,
      ourOwn: 0,
      manual: 0,
      failed: 0,
    },
    /** Объекты, чей файл описания пришёл из новой поставки — их надо внести в состав. */
    childAdd: new Set(),
    /** Объекты, удалённые вслед за поставщиком, — их надо убрать из состава. */
    childRemove: new Set(),
    conflictFiles: 0,
    conflictsSkipped: 0,
    /** Сколько файлов каждого рода уже разложено по каталогу «Конфликты». */
    manualSaved: 0,
    autoSaved: 0,
    conflictIndex: [],
    notes: [],
  };

  let done = 0;
  for (const rel of rels) {
    if (done % 200 === 0) throwIfCancelled();
    try {
      await mergeOne(state, rel);
    } catch (err) {
      rethrowIfCancelled(err);
      state.totals.failed += 1;
      log.warn(`Файл ${rel} не объединён: ${err.message}`);
      record(state, rel, { action: 'failed', note: err.message });
    }
    done += 1;
    if (done % 250 === 0 || done === rels.length) onProgress?.(done, rels.length, rel);
  }

  await patchConfigurationComposition(state);
  await dropDumpInfo(state);
  await writeConflictIndex(state);

  return buildResult(state);
}

// --- Один файл ---------------------------------------------------------------

async function mergeOne(state, rel) {
  const inMain = state.main.files.has(rel);
  const inBase = state.base.files.has(rel) && !state.unknown.has(rel);
  const inTarget = state.target.files.has(rel);

  // Настройка поддержки не подчиняется общим правилам объединения: режим
  // не наследуется от поставки ни при каких условиях.
  if (rel === SUPPORT_FILE) {
    await mergeSupport(state, rel, { inMain, inTarget });
    return;
  }

  // Конфигурация поставщика, лежащая в выгрузке рядом с настройкой поддержки.
  // Она всегда наша и всегда остаётся на месте: в новой поставке такого файла
  // нет вовсе, и по общим правилам выходило «поставщик удалил» — файл стирался,
  // а загрузка потом падала с «Файл не обнаружен
  // …\Ext\ParentConfigurations\<Имя>.cf» (живой случай 27.08.2026). Читать его
  // тоже нельзя: на УНФ это 1,13 ГБ, на ERP больше.
  if (isParentCfPath(rel)) {
    if (inMain) {
      state.totals.ourOwn += 1;
      record(state, rel, {
        action: 'kept-support',
        note: 'Конфигурация поставщика из настройки поддержки: файл оставлен вашим. '
          + 'Без него платформа отказывается загружать конфигурацию из файлов.',
      });
    }
    return;
  }

  if (state.mode === 'keys') {
    await mergeByObject(state, rel, { inMain, inTarget });
    return;
  }

  // Восстановление из базы: про этот файл поставщика ничего не известно.
  if (state.unknown.has(rel)) {
    await mergeUnknown(state, rel, { inMain, inTarget });
    return;
  }

  // --- Полное трёхстороннее объединение ---

  if (inMain && inTarget && inBase) {
    const oursSameAsBase = await same(state, 'main', 'base', rel);
    const theirsSameAsBase = await same(state, 'target', 'base', rel);

    if (oursSameAsBase && theirsSameAsBase) {
      state.totals.unchanged += 1;
      return;
    }
    if (oursSameAsBase) {
      // Тронул только поставщик — ради этого обновление и делается.
      await copyFrom(state, 'target', rel);
      state.totals.fromVendor += 1;
      record(state, rel, { action: 'from-vendor' });
      return;
    }
    if (theirsSameAsBase) {
      // Тронули только мы: обновление не должно затирать доработку.
      state.totals.keptOurs += 1;
      record(state, rel, { action: 'kept-ours' });
      return;
    }
    if (await same(state, 'main', 'target', rel)) {
      state.totals.unchanged += 1;
      record(state, rel, { action: 'same-both' });
      return;
    }
    await mergeContents(state, rel);
    return;
  }

  if (inMain && inTarget && !inBase) {
    // Файла нет в старой поставке: элемент добавлен и нами, и поставщиком.
    // Объединять построчно нечего — общей точки отсчёта не существует.
    if (await same(state, 'main', 'target', rel)) {
      state.totals.unchanged += 1;
      return;
    }
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    const element = record(state, rel, {
      action: 'conflict-both-added',
      note: 'Этого элемента нет в старой поставке: он добавлен и вами, и поставщиком. '
        + 'Общей точки отсчёта нет, поэтому оставлен ваш вариант — ниже отличия от новой поставки.',
    });
    await attachTwoWay(state, rel, element);
    element.versions = await saveConflictVersions(state, rel);
    return;
  }

  if (inMain && !inTarget && inBase) {
    if (await same(state, 'main', 'base', rel)) {
      await removeFile(state, rel);
      return;
    }
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    const element = record(state, rel, {
      action: 'conflict-vendor-deleted',
      note: 'Поставщик удалил этот элемент, а у вас он изменён. Оставлен ваш вариант — '
        + 'решите, нужен ли он в новой версии.',
    });
    element.versions = await saveConflictVersions(state, rel);
    return;
  }

  if (inMain && !inTarget && !inBase) {
    state.totals.ourOwn += 1;
    return;
  }

  if (!inMain && inTarget && inBase) {
    if (await same(state, 'target', 'base', rel)) {
      // Мы этот элемент удалили, поставщик его не менял — удалённым и остаётся.
      record(state, rel, { action: 'deleted-by-us' });
      return;
    }
    state.totals.manual += 1;
    record(state, rel, {
      action: 'manual-deleted-by-us',
      note: 'Элемент удалён в вашей конфигурации, но изменён в новой поставке. '
        + 'Автоматически он не возвращён — решите, нужен ли он снова.',
    });
    return;
  }

  if (!inMain && inTarget && !inBase) {
    await copyFrom(state, 'target', rel);
    state.totals.addedByVendor += 1;
    record(state, rel, { action: 'added-by-vendor' });
    noteChildAdd(state, rel);
    return;
  }

  // Остался случай «есть только в старой поставке» — удалён обеими сторонами.
  state.totals.unchanged += 1;
}

/**
 * Настройка поддержки: правила объектов остаются НАШИМИ всегда.
 *
 * Требование пользователя дословно (27.08.2026): «не изменяй режим ни для
 * конфигурации, ни для объектов метаданных». Взяв этот файл у поставки —
 * а по общим правилам объединения так и выходило, ведь мы его не меняли, —
 * программа ставит всю конфигурацию на поддержку без права правки: у вендора
 * каждый объект «не редактируется», а возможность изменения выключена.
 * Доработанные объекты после такого обновления открываются «только для
 * чтения», и вернуть режим можно лишь руками по каждому объекту.
 *
 * Из поставки берутся только сведения о релизе и записи для объектов, которых
 * у нас нет вовсе. Не вышло разобрать файл — он остаётся нашим байт в байт:
 * прежний номер релиза в «Настройке поддержки» — мелочь, испорченная настройка
 * поддержки на 86 тысяч объектов — нет.
 */
async function mergeSupport(state, rel, { inMain, inTarget }) {
  // Своей настройки поддержки нет — конфигурация на поддержке не стоит.
  // Принести её из поставки значило бы поставить конфигурацию на поддержку,
  // чего никто не просил.
  if (!inMain) {
    if (inTarget) {
      state.totals.ourOwn += 1;
      record(state, rel, {
        action: 'kept-support',
        note: 'Ваша конфигурация на поддержке не стоит, и обновление её туда не ставит: '
          + 'настройка поддержки из новой поставки не переносится.',
      });
    }
    return;
  }

  if (!inTarget) {
    state.totals.ourOwn += 1;
    return;
  }

  let merged = null;
  try {
    merged = mergeSupportTables(
      (await read(state, 'main', rel)).toString('utf8'),
      (await read(state, 'target', rel)).toString('utf8'),
    );
  } catch (err) {
    merged = { ok: false, reason: err.message };
  }

  if (!merged.ok) {
    state.totals.keptOurs += 1;
    state.notes.push(
      `Настройка поддержки оставлена вашей без изменений: ${merged.reason}. `
      + 'Правила поддержки объектов и возможность изменения не тронуты, но в «Настройке '
      + 'поддержки» останется прежний номер релиза поставщика — поправьте его в конфигураторе.',
    );
    record(state, rel, {
      action: 'kept-support',
      note: `Файл оставлен вашим целиком: ${merged.reason}.`,
    });
    return;
  }

  await writeFile(state, rel, Buffer.from(merged.text, 'utf8'));
  state.totals.keptOurs += 1;
  record(state, rel, {
    action: 'kept-support',
    note: `Правила поддержки сохранены полностью (${merged.kept} объектов), `
      + `новых объектов поставки внесено ${merged.added}, релиз поставщика — ${merged.release}. `
      + 'Возможность изменения конфигурации и режим каждого объекта не менялись.',
  });
  state.notes.push(
    `Настройка поддержки сохранена: правила ${merged.kept} объектов остались вашими, `
    + `добавлено ${merged.added} новых объектов поставки, релиз поставщика записан `
    + `как ${merged.release}.`,
  );
}

/**
 * Файл, содержимое которого у поставщика неизвестно.
 *
 * Восстановление старой поставки из базы даёт тексты изменённых модулей,
 * но не прежние значения свойств в XML: отчёт сравнения называет изменённое
 * свойство, а не то, чем оно было. Таких файлов немного (на реальной ERP —
 * десятки из десятков тысяч), и решение по ним принимается по-честному:
 * наша версия остаётся, отличия от новой поставки показываются.
 */
async function mergeUnknown(state, rel, { inMain, inTarget }) {
  if (!inMain) {
    if (inTarget) {
      state.totals.manual += 1;
      record(state, rel, {
        action: 'manual-deleted-by-us',
        note: 'Элемент удалён в вашей конфигурации и присутствует в новой поставке.',
      });
    }
    return;
  }
  if (!inTarget) {
    state.totals.ourOwn += 1;
    return;
  }
  if (await same(state, 'main', 'target', rel)) {
    state.totals.unchanged += 1;
    return;
  }

  state.totals.keptOurs += 1;

  // Отчёт сравнения НАЗЫВАЕТ свойства, которые изменил интегратор, — он просто
  // не печатает их прежние значения. Этого достаточно, чтобы разобрать файл
  // по свойствам: участок, лежащий в свойстве, которого интегратор не касался,
  // изменил один поставщик — его правку можно взять смело. Спорным остаётся
  // только участок в свойстве, названном отчётом.
  let both = [];
  if (path.extname(rel).toLowerCase() === '.xml') {
    const outcome = await resolveUnknownXml(state, rel);
    if (outcome.resolved) return;
    both = outcome.both;
  }

  state.totals.manual += 1;
  const element = record(state, rel, {
    action: 'manual-two-way',
    // Второе сравнение (поставщик ↔ новая поставка) даёт доказательство,
    // которого раньше не было: свойство названо в обоих отчётах — значит его
    // изменили и вы, и поставщик. Это настоящее «изменено дважды», и говорить
    // о нём надо именно так, а не «прежнее значение неизвестно».
    note: both.length
      ? `Это свойство изменили и вы, и поставщик: ${both.join(', ')}. Первое сравнение `
        + 'называет его среди ваших правок, второе — среди правок поставщика в новом релизе. '
        + 'Прежнего значения платформа не печатает, поэтому свести версии может только человек — '
        + 'ниже отличия от новой поставки.'
      : 'Это свойство вы изменили относительно поставщика, и в новой поставке оно тоже '
        + 'другое. Прежнее значение поставщика отчёт сравнения не печатает, поэтому объединить '
        + 'автоматически нельзя — ниже отличия от новой поставки.',
  });
  await attachTwoWay(state, rel, element);
  element.versions = await saveConflictVersions(state, rel);
}

/**
 * Разбор XML объекта, прежнее состояние которого у поставщика неизвестно.
 *
 * Что известно точно: перечень свойств, которые интегратор изменил
 * относительно поставщика (отчёт `/CompareCfg` называет их поимённо —
 * «Синоним», «Реквизит «Договор»», «Табличная часть «Оплаты»»). Значит про
 * каждый участок расхождения с новой поставкой можно сказать, лежит он
 * в тронутом нами свойстве или нет:
 *
 *   не тронуто нами → расхождение внёс ОДИН поставщик → берём его версию;
 *   тронуто нами    → это наша правка, она и остаётся.
 *
 * **Дважды изменённое место называется дважды изменённым, только когда это
 * доказано.** Доказательство даёт второе сравнение — конфигурации поставщика
 * с файлом новой поставки (`compareVendorWithTarget`): оно называет свойства,
 * которые поставщик изменил САМ между релизами. Свойство названо в обоих
 * отчётах — изменили оба, и решает человек. Названо только в нашем — поставщик
 * его не трогал, наше значение и есть результат.
 *
 * Второго сравнения не было (платформа не отдала поставщика либо новая
 * поставка задана каталогом, а не файлом .cf) — доказательств правки
 * поставщика нет, и требовать решения
 * не за что: конфигуратор, у которого поставщик перед глазами, в том же месте
 * дважды изменённым считает только модуль (сверено на УНФ 3.0.13.374 →
 * 3.0.14.115, 27.08.2026). Наша версия сохраняется, а перечень таких свойств
 * идёт в отчёт — сверить их вручную можно, а гадать нельзя.
 *
 * Перечня свойств нет — разбирать нечем, и файл честно уходит человеку целиком.
 *
 * @returns {Promise<{resolved: boolean, both: string[]}>} `resolved` — файл
 *   разобран здесь; `both` — свойства, изменённые обеими сторонами
 */
async function resolveUnknownXml(state, rel) {
  const nothing = { resolved: false, both: [] };
  const objectKey = describeDumpPath(rel).objectKey;
  const labels = state.changedProps?.get(objectKey);
  if (!labels || !labels.length) return nothing;

  // Свойства этого объекта, изменённые поставщиком в новом релизе. Пересечение
  // с нашими и есть настоящее «изменено дважды».
  const vendorLabels = (state.aheadKnown && state.vendorProps?.get(objectKey)) || [];
  const both = labels.filter((label) => vendorLabels.some(
    (v) => sameLabel(v, label),
  ));
  if (both.length) return { resolved: false, both };

  const oursBuf = await read(state, 'main', rel);
  const theirsBuf = await read(state, 'target', rel);
  if (isUtf16(oursBuf) || isUtf16(theirsBuf)) return nothing;

  const oursText = oursBuf.toString('utf8');
  const theirsText = theirsBuf.toString('utf8');
  const shape = splitLines(oursText);
  const ours = shape.lines;
  const theirs = splitLines(theirsText).lines;

  const hunks = changedHunks(ours, theirs);
  if (!hunks || !hunks.length) return nothing;

  const outline = buildXmlOutline(oursText);
  const theirsOutline = buildXmlOutline(theirsText);

  const out = [];
  let cursor = 0;
  const taken = [];
  const kept = [];

  for (const hunk of hunks) {
    out.push(...ours.slice(cursor, hunk.baseStart));
    cursor = hunk.baseEnd;

    // Путь смотрим с обеих сторон: у вставки поставщика нашей стороны нет,
    // а у удаления — его. Спорным участок считается, если хоть один из путей
    // ведёт в тронутое нами свойство: ошибиться в эту сторону дешевле.
    const oursPath = describeXmlRange(outline, hunk.baseStart + 1, hunk.baseEnd || hunk.baseStart + 1);
    const theirsPath = describeXmlRange(
      theirsOutline, hunk.sideStart + 1, hunk.sideEnd || hunk.sideStart + 1,
    );
    const where = oursPath || theirsPath;
    const mine = touchesOurProperty(oursPath, labels) || touchesOurProperty(theirsPath, labels);

    if (mine) {
      // Свойство меняли мы. Правка поставщика здесь не доказана, а наша —
      // известна точно: она и остаётся.
      out.push(...ours.slice(hunk.baseStart, hunk.baseEnd));
      kept.push({ hunk, where });
    } else {
      out.push(...theirs.slice(hunk.sideStart, hunk.sideEnd));
      taken.push({ hunk, where });
    }
  }
  out.push(...ours.slice(cursor));

  if (taken.length) {
    await writeFile(state, rel, Buffer.from(joinLines(out, shape), 'utf8'));
  }

  const element = record(state, rel, {
    // Не «дважды изменено»: сюда файл попадает ровно тогда, когда ни одно
    // свойство не тронуто обеими сторонами — пересечение проверено выше
    // и оказалось пустым. Правки просто легли врозь.
    action: 'auto-by-property',
    note: kept.length
      ? (state.aheadKnown
        ? 'Часть отличий от новой поставки лежит в свойствах, которые меняли вы: там оставлена '
          + 'ваша версия. Второе сравнение — конфигурации поставщика с новой поставкой — этих '
          + 'свойств среди его правок не называет, значит спорить не о чем. Остальное взято '
          + 'из новой поставки.'
        : 'Часть отличий от новой поставки лежит в свойствах, которые меняли вы: там оставлена '
          + 'ваша версия. Прежнее значение поставщика платформа не печатает, поэтому проверить, '
          + 'менял ли эти свойства и он, нечем — сверьте вручную, если правка поставщика важна. '
          + 'Остальное взято из новой поставки.')
      : 'Ни одно отличие от новой поставки не лежит в свойствах, которые вы меняли, — '
        + 'значит их внёс один поставщик. Взяты его значения.',
  });
  element.conflictCount = 0;
  element.resolvedCount = taken.length + kept.length;
  element.conflicts = [];
  element.resolved = [
    ...kept.slice(0, RESOLVED_PER_FILE).map(({ hunk, where }) => ({
      where,
      how: 'ваша правка сохранена',
      why: state.aheadKnown
        ? 'Это свойство относительно поставщика меняли вы, а он его в новом релизе не менял: '
          + 'второе сравнение — конфигурации поставщика с новой поставкой — среди его правок '
          + 'этого свойства не называет. Оставлена ваша версия.'
        : 'Это свойство относительно поставщика меняли вы — так говорит отчёт сравнения. '
          + 'Прежнего значения поставщика он не печатает, поэтому доказать, что поставщик менял '
          + 'его тоже, нечем. Оставлена ваша версия.',
      oursStartLine: hunk.baseStart + 1,
      theirsStartLine: hunk.sideStart + 1,
      base: cut([]),
      ours: cut(ours.slice(hunk.baseStart, hunk.baseEnd)),
      theirs: cut(theirs.slice(hunk.sideStart, hunk.sideEnd)),
      result: cut(ours.slice(hunk.baseStart, hunk.baseEnd)),
    })),
    ...taken.slice(0, RESOLVED_PER_FILE).map(({ hunk, where }) => ({
      where,
      how: 'свойство менял только поставщик',
      why: 'Это свойство вы относительно поставщика не меняли — отчёт сравнения его не называет. '
        + 'Значит расхождение с новой поставкой внёс он один, и его версия принята.',
      oursStartLine: hunk.baseStart + 1,
      theirsStartLine: hunk.sideStart + 1,
      base: cut([]),
      ours: cut(ours.slice(hunk.baseStart, hunk.baseEnd)),
      theirs: cut(theirs.slice(hunk.sideStart, hunk.sideEnd)),
      result: cut(theirs.slice(hunk.sideStart, hunk.sideEnd)),
    })),
  ];

  state.totals.autoResolved += taken.length + kept.length;
  element.versions = await saveConflictVersions(state, rel, {
    kind: 'auto',
    merged: Buffer.from(joinLines(out, shape), 'utf8'),
    ours: oursBuf,
  });
  return { resolved: true, both: [] };
}

/**
 * Лежит ли участок в свойстве, которое интегратор менял.
 *
 * Сравниваются подписи: отчёт даёт «Реквизит «Договор»», путь по XML —
 * «Состав → Реквизит «Договор» → Свойства → Тип». Совпадение по вхождению
 * подписи в путь, а не по равенству: отчёт называет свойство, а путь ведёт
 * вглубь него.
 */
function touchesOurProperty(where, labels) {
  if (!where) return false;
  const lower = where.toLowerCase();
  return labels.some((label) => label && lower.includes(String(label).toLowerCase()));
}

/**
 * Одно ли это свойство в двух отчётах сравнения.
 *
 * Подписи приходят от одной и той же платформы, но сверять их как строки
 * нельзя: кавычки бывают разными, регистр и «ё» — тоже. Сравнение грубое
 * намеренно: совпали подписи вложенных свойств разных реквизитов («Тип»
 * у одного и «Тип» у другого) — место уйдёт человеку. Ошибиться в эту сторону
 * дешевле: он посмотрит и согласится, а пропущенная правка поставщика
 * потеряется молча.
 */
function sameLabel(a, b) {
  const norm = (value) => String(value || '')
    .toLowerCase().replace(/ё/g, 'е').replace(/[«»"']/g, '').replace(/\s+/g, ' ')
    .trim();
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Режим без старой поставки вовсе: решение принимается по ОБЪЕКТУ целиком.
 *
 * Остаётся запасным путём на случай, когда и файла `.cf` нет, и сравнение
 * в базе не удалось (конфигурация снята с поддержки). Гранулярность именно
 * объектная: если взять из поставки часть файлов объекта, а часть оставить
 * свою, получится объект, собранный из двух несогласованных половин.
 */
async function mergeByObject(state, rel, { inMain, inTarget }) {
  const entry = describeDumpPath(rel);
  const touched = entry.objectKey === ROOT_KEY
    || !state.touchedObjects
    || state.touchedObjects.has(entry.objectKey);

  if (!touched) {
    if (inTarget && inMain) {
      if (await same(state, 'main', 'target', rel)) {
        state.totals.unchanged += 1;
        return;
      }
      await copyFrom(state, 'target', rel);
      state.totals.fromVendor += 1;
      record(state, rel, { action: 'from-vendor' });
      return;
    }
    if (inTarget && !inMain) {
      await copyFrom(state, 'target', rel);
      state.totals.addedByVendor += 1;
      record(state, rel, { action: 'added-by-vendor' });
      noteChildAdd(state, rel);
      return;
    }
    await removeFile(state, rel);
    return;
  }

  await mergeUnknown(state, rel, { inMain, inTarget });
}

/** Построчное объединение содержимого файла. */
async function mergeContents(state, rel) {
  const ext = path.extname(rel).toLowerCase();
  const oursBuf = await read(state, 'main', rel);
  const theirsBuf = await read(state, 'target', rel);
  const baseBuf = await read(state, 'base', rel);

  // Файл не в UTF-8 (встречается UTF-16 в старых выгрузках) построчно
  // не объединяем: записать его обратно в исходной кодировке нечем, а молча
  // перекодировать файл конфигурации нельзя.
  if (!TEXT_EXT.has(ext) || [oursBuf, theirsBuf, baseBuf].some(isUtf16)) {
    // Двоичный файл (макет .mxl, картинка): объединять построчно нечего.
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    const element = record(state, rel, {
      action: 'conflict-binary',
      note: 'Двоичный файл изменён и вами, и поставщиком. Оставлен ваш — сравните вручную '
        + 'в конфигураторе, автоматическое объединение для таких файлов невозможно.',
    });
    element.versions = await saveConflictVersions(state, rel);
    return;
  }

  const oursText = oursBuf.toString('utf8');
  const theirsText = theirsBuf.toString('utf8');
  const baseText = baseBuf.toString('utf8');

  const merge = merge3(baseText, oursText, theirsText);
  if (!merge.ok) {
    state.totals.conflicted += 1;
    state.totals.keptOurs += 1;
    const element = record(state, rel, {
      action: 'conflict-too-big',
      note: `Объединить построчно не удалось: ${merge.reason}. Оставлен ваш вариант.`,
    });
    element.versions = await saveConflictVersions(state, rel);
    return;
  }

  // Дважды изменённые места сначала разбираются самостоятельно.
  const result = merge.conflicts.length
    ? autoResolve({ rel, baseText, oursText, theirsText, merge })
    : { lines: merge.lines, conflicts: [], resolved: [], changed: false };

  const shape = splitLines(oursText);
  // Буфер нужен и для записи в выгрузку, и для каталога версий: окно разбора
  // сравнивает правки человека именно с тем, что программа записала сама.
  const mergedBuf = Buffer.from(joinLines(result.lines, shape), 'utf8');
  if (merge.changed || result.changed) {
    await writeFile(state, rel, mergedBuf);
  }

  if (result.conflicts.length) {
    state.totals.conflicted += 1;
    state.totals.autoResolved += result.resolved.length;
    const element = record(state, rel, {
      action: 'conflict',
      autoFromVendor: merge.fromVendor,
    });
    await attachConflicts(state, rel, element, result, { oursText, theirsText, baseText });
    element.versions = await saveConflictVersions(state, rel, { merged: mergedBuf, ours: oursBuf });
    return;
  }

  if (result.resolved.length) {
    state.totals.autoResolved += result.resolved.length;
    state.totals.merged += 1;
    const element = record(state, rel, {
      action: 'auto-resolved',
      autoFromVendor: merge.fromVendor,
      autoKeptOurs: merge.keptOurs,
    });
    await attachConflicts(state, rel, element, result, { oursText, theirsText, baseText });
    element.versions = await saveConflictVersions(state, rel, {
      kind: 'auto', merged: mergedBuf, ours: oursBuf,
    });
    return;
  }

  if (merge.fromVendor) {
    state.totals.merged += 1;
    record(state, rel, {
      action: 'merged',
      autoFromVendor: merge.fromVendor,
      autoKeptOurs: merge.keptOurs,
    });
  } else {
    state.totals.keptOurs += 1;
    record(state, rel, { action: 'kept-ours' });
  }
}

// --- Подробности конфликтов --------------------------------------------------

/**
 * Дописывает участки в запись элемента: и нерешённые, и решённые сами.
 *
 * «Где именно» определяется по-разному в зависимости от вида файла: в XML это
 * путь до свойства («Свойства → Синоним», «Состав → Реквизит «Договор» → Тип»),
 * в модуле — имя процедуры. Номер строки в файле выгрузки сам по себе
 * пользователю не говорит ничего, а требование было увидеть, в каких свойствах
 * изменения.
 *
 * Решённые участки показываются с тем же составом колонок плюс результат:
 * пользователь просил видеть каждое автоматическое объединение и иметь
 * возможность его проверить.
 */
async function attachConflicts(state, rel, element, result, texts) {
  element.conflicts = [];
  element.resolved = [];
  element.conflictCount = result.conflicts.length;
  element.resolvedCount = result.resolved.length;

  if (state.conflictFiles >= CONFLICT_FILES_LIMIT) {
    state.conflictsSkipped += result.conflicts.length;
    return;
  }
  state.conflictFiles += 1;

  const where = placeFinder(rel, texts.oursText, texts.baseText);

  for (const conflict of result.conflicts.slice(0, CONFLICTS_PER_FILE)) {
    element.conflicts.push(fragment(conflict, where));
  }
  if (result.conflicts.length > CONFLICTS_PER_FILE) {
    element.conflictsTruncated = result.conflicts.length - CONFLICTS_PER_FILE;
  }

  for (const item of result.resolved.slice(0, RESOLVED_PER_FILE)) {
    element.resolved.push({
      ...fragment(item, where),
      how: item.how,
      why: item.why,
      result: cut(item.result || []),
    });
  }
  if (result.resolved.length > RESOLVED_PER_FILE) {
    element.resolvedTruncated = result.resolved.length - RESOLVED_PER_FILE;
  }
}

function fragment(conflict, where) {
  const place = where(conflict.oursStartLine, conflict.baseStartLine, conflict.baseEndLine) || {};
  return {
    where: place.where || '',
    routineKind: place.routineKind || '',
    routineHasParams: Boolean(place.routineHasParams),
    baseStartLine: conflict.baseStartLine,
    oursStartLine: conflict.oursStartLine,
    theirsStartLine: conflict.theirsStartLine,
    base: cut(conflict.base),
    ours: cut(conflict.ours),
    theirs: cut(conflict.theirs),
  };
}

/**
 * Строит функцию «номер строки → место в файле».
 *
 * Разбор делается один раз на файл: и лексер, и разбор XML стоят времени,
 * а участков в одном файле бывает десятки.
 */
function placeFinder(rel, oursText, baseText = '') {
  const ext = path.extname(rel).toLowerCase();

  if (ext === '.xml') {
    const outline = buildXmlOutline(baseText || oursText);
    return (oursLine, baseStart, baseEnd) => ({
      where: describeXmlRange(
        outline,
        baseText ? baseStart : oursLine,
        baseText ? baseEnd : oursLine,
      ),
    });
  }

  if (ext === '.bsl') {
    try {
      const { routines } = analyzeStructure(tokenize(oursText).tokens);
      return (oursLine) => {
        const routine = findRoutineAtLine(routines, oursLine);
        if (!routine) return { where: 'Вне процедур' };
        // Вид метода называется правильно: «Функция» у функции, «Процедура»
        // у процедуры. Значок и скобки в окне разбора рисуются по этим же
        // полям — теми же, что в отчёте о качестве кода.
        return {
          where: `${routine.kind === 'function' ? 'Функция' : 'Процедура'} «${routine.name}»`,
          routineKind: routine.kind,
          routineHasParams: (routine.params || []).length > 0,
          routineName: routine.name,
        };
      };
    } catch {
      return () => ({ where: '' });
    }
  }

  return () => ({ where: '' });
}

/** Отличия от новой поставки, когда объединять нечем. */
async function attachTwoWay(state, rel, element) {
  if (state.conflictFiles >= CONFLICT_FILES_LIMIT) {
    state.conflictsSkipped += 1;
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext)) return;
  state.conflictFiles += 1;

  const oursBuf = await read(state, 'main', rel);
  const theirsBuf = await read(state, 'target', rel);
  if (isUtf16(oursBuf) || isUtf16(theirsBuf)) return;
  const oursText = oursBuf.toString('utf8');
  const theirsText = theirsBuf.toString('utf8');
  const where = placeFinder(rel, oursText);

  const hunks = twoWayHunks(oursText, theirsText, { limit: CONFLICTS_PER_FILE });
  element.conflicts = hunks.map((hunk) => {
    const place = where(hunk.oursStartLine) || {};
    return {
      where: place.where || '',
      routineKind: place.routineKind || '',
      routineHasParams: Boolean(place.routineHasParams),
      oursStartLine: hunk.oursStartLine,
      theirsStartLine: hunk.theirsStartLine,
      base: [],
      ours: cut(hunk.ours),
      theirs: cut(hunk.theirs),
    };
  });
  element.conflictCount = element.conflicts.length;
}

function cut(lines) {
  return lines.length > FRAGMENT_LINES
    ? { lines: lines.slice(0, FRAGMENT_LINES), truncated: lines.length - FRAGMENT_LINES }
    : { lines, truncated: 0 };
}

/**
 * Три версии конфликтного файла рядом, в каталоге «Конфликты».
 *
 * Отчёт показывает участки, но править человек будет файл целиком и своим
 * инструментом сравнения. Пути внутри выгрузки длинные, а Windows ограничивает
 * путь 260 знаками, поэтому файлы раскладываются по номерам, а соответствие
 * номера и пути пишется в «список.txt».
 */
async function saveConflictVersions(state, rel, { kind = 'manual', merged = null, ours = null } = {}) {
  if (!state.conflictRoot) return null;
  const counter = kind === 'auto' ? 'autoSaved' : 'manualSaved';
  const limit = kind === 'auto' ? RESOLVED_FILES_LIMIT : CONFLICT_FILES_LIMIT;
  if (state[counter] >= limit) return null;

  const number = String(state.conflictIndex.length + 1).padStart(3, '0');
  const dir = path.join(state.conflictRoot, number);
  const ext = path.extname(rel) || '.txt';

  try {
    await ensureDir(dir);
    for (const [tree, name] of [
      ['base', VERSION_FILES.base],
      ['target', VERSION_FILES.theirs],
      ['main', VERSION_FILES.ours],
    ]) {
      if (!treeOf(state, tree).files.has(rel)) continue;
      if (tree === 'base' && state.unknown.has(rel)) continue;
      // «Основная конфигурация» — это наш файл ДО объединения. С диска его
      // читать уже нельзя: результат объединения записан туда же и раньше,
      // и в окне разбора левая колонка показывала бы не нашу версию, а итог.
      const buf = tree === 'main' && ours ? ours : await read(state, tree, rel);
      await fs.writeFile(path.join(dir, `${name}${ext}`), buf);
    }
    // Автоматический результат кладётся рядом неизменным: окно разбора
    // показывает поверх него правки человека и умеет вернуться к нему обратно.
    if (merged) await fs.writeFile(path.join(dir, `${VERSION_FILES.auto}${ext}`), merged);
    state[counter] += 1;
    state.conflictIndex.push({ number, rel, kind });
    return number;
  } catch (err) {
    log.warn(`Не удалось сохранить версии файла ${rel}: ${err.message}`);
    return null;
  }
}

async function writeConflictIndex(state) {
  if (!state.conflictRoot || !state.conflictIndex.length) return;
  const lines = [
    'Исходные версии каждого спорного файла — и тех, что решены самой программой,',
    'и тех, где решение за вами. Ими же пользуется окно «Разбор спорных мест».',
    '',
    `${VERSION_FILES.base}         — конфигурация поставщика, с которой начинали`,
    `${VERSION_FILES.theirs}          — то же место в новой поставке`,
    `${VERSION_FILES.ours}   — ваша версия до объединения`,
    `${VERSION_FILES.auto}   — что записала программа (у решённых сама)`,
    '',
    'В колонке «род»: «сам» — разобрано программой, «вам» — требует вашего решения.',
    '',
    ...state.conflictIndex.map(
      (item) => `${item.number}  ${item.kind === 'auto' ? 'сам' : 'вам'}  ${item.rel}`,
    ),
  ];
  try {
    await fs.writeFile(path.join(state.conflictRoot, 'список.txt'), `${lines.join('\r\n')}\r\n`, 'utf8');
  } catch (err) {
    log.warn(`Не удалось записать список конфликтов: ${err.message}`);
  }
}

// --- Состав конфигурации -----------------------------------------------------

function noteChildAdd(state, rel) {
  const entry = describeDumpPath(rel);
  if (entry.isObjectFile && entry.objectKey !== ROOT_KEY) state.childAdd.add(entry.objectKey);
}

/**
 * Правит список ChildObjects в Configuration.xml.
 *
 * Объект новой поставки, не внесённый в состав, платформа при загрузке
 * не увидит; объект, удалённый из каталога, но оставшийся в составе, — это
 * ошибка загрузки. В полном трёхстороннем режиме состав чаще всего сходится
 * сам (Configuration.xml объединяется построчно), но проверить дешевле,
 * чем разбираться потом с отказом загрузки. При восстановлении поставки
 * из базы Configuration.xml остаётся нашим целиком, и правка состава здесь —
 * единственный способ увидеть новые объекты поставки.
 */
async function patchConfigurationComposition(state) {
  if (!state.childAdd.size && !state.childRemove.size) return;
  const file = path.join(state.mainDir, 'Configuration.xml');
  if (!(await pathExists(file))) {
    state.notes.push('В выгрузке нет Configuration.xml — состав конфигурации не выправлен.');
    return;
  }

  try {
    const text = await readText(file);
    const patched = patchChildObjects(text, {
      add: [...state.childAdd],
      remove: [...state.childRemove],
    });
    if (patched.changed) {
      const shape = splitLines(text);
      await fs.writeFile(file, joinLines(patched.lines, shape), 'utf8');
      state.notes.push(
        `Состав конфигурации выправлен: добавлено ${patched.added}, убрано ${patched.removed} объектов.`,
      );
    }
  } catch (err) {
    state.notes.push(`Не удалось выправить состав конфигурации: ${err.message}`);
  }
}

/**
 * Вносит и убирает строки `<Вид>Имя</Вид>` внутри блока ChildObjects.
 *
 * Экспортируется ради теста: ошибка здесь ломает загрузку всей конфигурации,
 * а проявляется только на живой базе.
 */
export function patchChildObjects(text, { add = [], remove = [] }) {
  const { lines } = splitLines(text);
  const openIdx = lines.findIndex((line) => line.includes('<ChildObjects>'));
  const closeIdx = lines.findIndex((line) => line.includes('</ChildObjects>'));
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
    return { lines, changed: false, added: 0, removed: 0 };
  }

  const removeXml = new Set(remove.map((key) => childObjectLine(key)?.xml).filter(Boolean));
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (i > openIdx && i < closeIdx && removeXml.has(lines[i].trim())) {
      removed += 1;
      continue;
    }
    out.push(lines[i]);
  }

  // Границы блока могли сдвинуться после удаления — ищем заново.
  const close = out.findIndex((line) => line.includes('</ChildObjects>'));
  const indent = /^(\s*)/.exec(out[close] || '')?.[1] || '\t\t';
  let added = 0;

  for (const key of add) {
    const item = childObjectLine(key);
    if (!item) continue;
    if (out.some((line) => line.trim() === item.xml)) continue;
    // Ставим рядом с однородными объектами: конфигуратор держит состав
    // сгруппированным по видам, и вразнобой его читать неудобно.
    let at = -1;
    for (let i = 0; i < close; i += 1) {
      if (out[i].trim().startsWith(`<${item.kind}>`)) at = i;
    }
    const insertAt = at === -1 ? close : at + 1;
    const lineIndent = at === -1 ? `${indent}\t` : /^(\s*)/.exec(out[at])?.[1] || indent;
    out.splice(insertAt, 0, `${lineIndent}${item.xml}`);
    added += 1;
  }

  return { lines: out, changed: added > 0 || removed > 0, added, removed };
}

/**
 * Карта версий объектов после объединения недействительна: файлы изменились,
 * а хеши в ней остались прежними. Платформа по ней решает, какие файлы читать
 * при загрузке, поэтому устаревшая карта опаснее отсутствующей — часть правок
 * молча не загрузилась бы.
 */
async function dropDumpInfo(state) {
  const file = path.join(state.mainDir, DUMP_INFO);
  if (!(await pathExists(file))) return;
  await fs.rm(file, { force: true }).catch(() => {});
  state.notes.push(
    'ConfigDumpInfo.xml удалён из выгрузки: после объединения он не соответствует файлам, '
    + 'и платформа должна прочитать выгрузку целиком.',
  );
}

// --- Ввод-вывод --------------------------------------------------------------

async function listFiles(dir) {
  const map = new Map();
  if (!dir) return map;

  async function walk(current, prefix) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        try {
          map.set(rel, (await fs.stat(full)).size);
        } catch {
          /* файл исчез между чтением каталога и stat — пропускаем */
        }
      }
    }
  }

  await walk(dir, '');
  return map;
}

function treeOf(state, tree) {
  return state[tree];
}

async function read(state, tree, rel) {
  return treeOf(state, tree).read(rel);
}

/**
 * Одинаковы ли файлы в двух деревьях.
 *
 * Сначала сравниваются размеры: на типовой конфигурации совпадает почти всё,
 * и читать по три гигабайта, чтобы это подтвердить, незачем.
 */
async function same(state, treeA, treeB, rel) {
  const sizeA = treeOf(state, treeA).files.get(rel);
  const sizeB = treeOf(state, treeB).files.get(rel);
  if (sizeA === undefined || sizeB === undefined) return false;
  if (sizeA !== sizeB) return false;
  const [a, b] = await Promise.all([read(state, treeA, rel), read(state, treeB, rel)]);
  return a.equals(b);
}

async function copyFrom(state, tree, rel) {
  const target = path.join(state.mainDir, rel);
  await ensureDir(path.dirname(target));
  const source = treeOf(state, tree);
  if (source.dir) {
    await fs.copyFile(path.join(source.dir, rel), target);
  } else {
    await fs.writeFile(target, await source.read(rel));
  }
  state.main.files.set(rel, source.files.get(rel));
}

async function writeFile(state, rel, buffer) {
  const target = path.join(state.mainDir, rel);
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, buffer);
  state.main.files.set(rel, buffer.length);
}

async function removeFile(state, rel) {
  if (!state.main.files.has(rel)) return;
  await fs.rm(path.join(state.mainDir, rel), { force: true }).catch(() => {});
  state.main.files.delete(rel);
  state.totals.removedByVendor += 1;
  record(state, rel, { action: 'removed-by-vendor' });

  const entry = describeDumpPath(rel);
  if (entry.isObjectFile && entry.objectKey !== ROOT_KEY) state.childRemove.add(entry.objectKey);
}

/** UTF-16 с BOM: такие файлы построчно не объединяются (см. mergeContents). */
function isUtf16(buffer) {
  if (buffer.length < 2) return false;
  const [a, b] = buffer;
  return (a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff);
}

// --- Сборка результата -------------------------------------------------------

/** Заносит файл в дерево объектов результата и возвращает запись элемента. */
function record(state, rel, data) {
  const entry = describeDumpPath(rel);
  if (!state.objects.has(entry.objectKey)) {
    state.objects.set(entry.objectKey, {
      key: entry.objectKey,
      title: objectTitle(entry.objectKey),
      kind: entry.kind,
      kindRu: entry.kindRu,
      name: entry.name,
      elements: [],
      elementsTruncated: 0,
    });
  }
  const object = state.objects.get(entry.objectKey);
  const element = {
    rel,
    element: entry.element,
    isModule: entry.isModule,
    /** Номер каталога в «Конфликты» с исходными версиями; null — не сохранены. */
    versions: null,
    conflicts: [],
    conflictCount: 0,
    resolved: [],
    resolvedCount: 0,
    ...data,
  };
  // Перечень файлов по объекту ограничен, а вот участки, требующие решения,
  // не теряются никогда: они и есть смысл всей операции.
  if (object.elements.length >= ELEMENTS_PER_OBJECT
    && !CONFLICT_ACTIONS.has(element.action) && !AUTO_ACTIONS.has(element.action)) {
    object.elementsTruncated += 1;
    return element;
  }
  object.elements.push(element);
  return element;
}

/**
 * Действия, при которых файл разобрала сама программа.
 *
 * Их два, и это разные вещи. 'auto-resolved' — участок, который правили ОБЕ
 * стороны, сведён трёхсторонним объединением. 'auto-by-property' — правки
 * сторон в файл легли врозь: наши свойства остались нашими, остальное взято
 * из новой поставки, и дважды изменённого в файле нет вовсе. Называть второе
 * «дважды изменено» — неправда, на что и указал пользователь 27.08.2026.
 */
export const AUTO_ACTIONS = new Set(['auto-resolved', 'auto-by-property']);

/** Группы результата в том порядке, в котором их читают. */
const CONFLICT_ACTIONS = new Set([
  'conflict', 'conflict-binary', 'conflict-too-big', 'conflict-vendor-deleted',
  'conflict-both-added', 'manual-two-way', 'manual-deleted-by-us', 'failed',
]);

function buildResult(state) {
  const objects = [...state.objects.values()];
  for (const object of objects) {
    object.elements.sort((a, b) => a.element.localeCompare(b.element, 'ru'));
    object.status = objectStatus(object);
  }

  const groups = {};
  const truncated = {};
  for (const status of ['manual', 'auto', 'applied', 'added', 'removed', 'kept']) {
    const all = objects
      .filter((o) => o.status === status)
      .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    // Перечень «что решить руками» и «что решено само» не обрезается: первое —
    // работа, которую всё равно придётся сделать, второе — решения, которые
    // пользователь просил показывать все до одного.
    const limit = status === 'manual' || status === 'auto' ? all.length : OBJECTS_PER_GROUP;
    groups[status] = all.slice(0, limit);
    truncated[status] = Math.max(0, all.length - limit);
    groups[`${status}Count`] = all.length;
  }

  return {
    mode: state.mode,
    totals: state.totals,
    /** Главное: что предстоит решить руками. */
    manual: groups.manual,
    manualCount: groups.manualCount,
    /** Что программа решила сама — с показом до и после. */
    auto: groups.auto,
    autoCount: groups.autoCount,
    applied: groups.applied,
    appliedCount: groups.appliedCount,
    added: groups.added,
    addedCount: groups.addedCount,
    removed: groups.removed,
    removedCount: groups.removedCount,
    kept: groups.kept,
    keptCount: groups.keptCount,
    truncated,
    conflictFiles: state.conflictFiles,
    conflictsSkipped: state.conflictsSkipped,
    conflictIndex: state.conflictIndex,
    notes: state.notes,
  };
}

function objectStatus(object) {
  if (object.elements.some((e) => CONFLICT_ACTIONS.has(e.action))) return 'manual';
  if (object.elements.some((e) => AUTO_ACTIONS.has(e.action))) return 'auto';
  if (object.elements.some((e) => e.action === 'merged' || e.action === 'from-vendor')) return 'applied';
  if (object.elements.every((e) => e.action === 'added-by-vendor')) return 'added';
  if (object.elements.every((e) => e.action === 'removed-by-vendor')) return 'removed';
  return 'kept';
}
