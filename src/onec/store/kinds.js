/**
 * Виды объектов хранилища по идентификатору класса — с доучиванием.
 *
 * Зачем. Читая хранилище-каталог напрямую, мы знаем идентификатор класса
 * объекта (`OBJECTS.CLASSID`), но не его вид: таблицы «идентификатор → вид»
 * платформа нигде не публикует, а угадывать нельзя — ошибка здесь подпишет
 * чужой код чужим именем.
 *
 * Поэтому таблица растёт двумя путями, и оба проверяемые:
 *
 *  1. **проверенные пары в коде** (`CLASS_KINDS`) — сверены руками
 *     с отчётом платформы по тем же хранилищам;
 *  2. **доучивание на месте**: встретился незнакомый идентификатор — программа
 *     один раз просит у платформы отчёт по этому же хранилищу. Отчёт печатает
 *     полные имена («ОбщийМодуль.Расш1_ОбщийМодуль1»), имена объектов в
 *     хранилище уникальны, и соответствие получается точным, а не угаданным.
 *     Выученное складывается в `data/store-kinds.json` и работает дальше уже
 *     без платформы.
 *
 * Если платформы нет вовсе (а хранилище-каталог читается и без неё), незнакомый
 * вид остаётся незнакомым: объект в дереве помещений будет, код — нет,
 * и отчёт назовёт идентификатор.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { DATA_DIR } from '../../config.js';
import { tagByRu } from '../../parse/metadataKinds.js';
import { pathExists, ensureDir, readText } from '../../util/fsx.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('store:kinds');

const FILE = path.join(DATA_DIR, 'store-kinds.json');

/**
 * Подчинённые виды: своей строки в справочнике видов у них нет, а в отчёте
 * платформы они называются так же, как всё остальное.
 */
const SUBORDINATE_TAGS = new Map([['Форма', 'Form'], ['Команда', 'Command'], ['Макет', 'Template']]);

/** Выученные пары: идентификатор класса → тег вида. */
export async function loadLearnedKinds() {
  if (!(await pathExists(FILE))) return new Map();
  try {
    const data = JSON.parse(await readText(FILE));
    return new Map(Object.entries(data));
  } catch (err) {
    log.warn(`Файл выученных видов не прочитан: ${err.message}`);
    return new Map();
  }
}

export async function saveLearnedKinds(pairs) {
  if (!pairs.size) return;
  await ensureDir(DATA_DIR);
  const existing = await loadLearnedKinds();
  for (const [id, tag] of pairs) existing.set(id, tag);
  await fs.writeFile(FILE, `${JSON.stringify(Object.fromEntries(existing), null, 2)}\n`, 'utf8');
  log.info(`Выучено видов объектов: ${pairs.size} (всего ${existing.size})`);
}

/**
 * Сопоставляет незнакомые идентификаторы классов с видами по отчёту платформы.
 *
 * @param {object} params
 * @param {import("./repositoryStore.js").RepositoryStore} params.store прочитанное хранилище
 * @param {Set<string>} params.unknown незнакомые идентификаторы классов
 * @param {object[]} params.commits помещения из отчёта ПЛАТФОРМЫ (полные имена)
 * @returns {Map<string,string>} что удалось выучить
 */
export function matchKindsByReport({ store, unknown, commits }) {
  const { info, classes } = store;
  // Полное имя в отчёте — цепочка пар «Вид.Имя»: «Документ.Док.Форма.Ф».
  // Сам объект — последняя пара, всё что левее — его владелец. Сопоставляем
  // по паре «полное имя владельца + имя объекта»: имена объектов уникальны
  // только внутри владельца, и одного имени для опознания мало.
  const place = (parentFull, name) => `${parentFull}|${name}`;
  const tagsByPlace = new Map();
  // Тот же вид, но с приметой — именем одного из детей объекта. Так
  // различаются одноимённые объекты разных видов: план счетов «Управленческий»
  // и регистр бухгалтерии «Управленческий» стоят на одном месте дерева,
  // и по имени их не развести, а по детям — да.
  const tagsByChild = new Map();

  const remember = (map, key, tag) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(tag);
  };

  for (const commit of commits || []) {
    for (const full of [...commit.added, ...commit.changed, ...commit.removed]) {
      const parts = String(full).split('.');
      if (parts.length < 2 || parts.length % 2) continue;
      // Полное имя — цепочка пар, и каждая пара сама по себе сведение о виде:
      // «ПланСчетов.Управленческий.Форма.ФормаСписка» говорит и про план
      // счетов, и про его форму.
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const tag = tagByRu(parts[i]) || SUBORDINATE_TAGS.get(parts[i]);
        if (!tag) continue;
        const parentFull = parts.slice(0, i).join('.');
        remember(tagsByPlace, place(parentFull, parts[i + 1]), tag);
        if (i + 3 < parts.length) {
          remember(tagsByChild, `${place(parentFull, parts[i + 1])}|${parts[i + 3]}`, tag);
        }
      }
    }
  }

  // Дети объекта — по ним и различаются одноимённые.
  const childrenOf = new Map();
  for (const [objId, item] of info) {
    if (!item.parentId) continue;
    if (!childrenOf.has(item.parentId)) childrenOf.set(item.parentId, []);
    childrenOf.get(item.parentId).push(item.name);
  }

  const learned = new Map();
  const conflicting = new Set();
  for (const [objId, item] of info) {
    const classId = classes.get(objId);
    if (!classId || !unknown.has(classId) || conflicting.has(classId)) continue;
    const parentFull = item.parentId && item.parentId !== store.rootId
      ? store.fullName(item.parentId)
      : '';
    const key = place(parentFull, item.name);

    let tags = tagsByPlace.get(key);
    if (tags && tags.size > 1) {
      // Место занято двумя видами — спрашиваем детей.
      const byChild = new Set();
      for (const child of childrenOf.get(objId) || []) {
        for (const tag of tagsByChild.get(`${key}|${child}`) || []) byChild.add(tag);
      }
      tags = byChild;
    }
    if (!tags || tags.size !== 1) continue;
    const tag = [...tags][0];
    // Один и тот же идентификатор класса, приведший к разным видам, — признак
    // ошибки сопоставления, а не двух видов сразу. Такую пару не берём вовсе.
    if (learned.has(classId) && learned.get(classId) !== tag) {
      learned.delete(classId);
      conflicting.add(classId);
      continue;
    }
    learned.set(classId, tag);
  }
  return learned;
}
