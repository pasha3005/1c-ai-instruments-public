/**
 * Хранилище конфигурации, прочитанное НАПРЯМУЮ — без платформы.
 *
 * Зачем. Когда хранилище лежит каталогом, всё, что нужно отчёту, есть в самих
 * файлах: история помещений в `1cv8ddb.1CD`, код версий — в объектном
 * хранилище рядом. Платформе тут делать нечего, а с ней уходят и все её
 * условия: лицензия, служебная база, выгрузка `.cf` на минуты. Отчёт по неделе
 * работы команды собирается за секунды.
 *
 * Что откуда берётся (проверено сверкой с отчётом самой платформы 18.08.2026 —
 * расхождений нет):
 *
 *  * `VERSIONS` — номер версии, автор (через `USERS`), дата, комментарий
 *    и версия конфигурации;
 *  * `HISTORY` — какие объекты тронуты каждой версией. «Добавлен» — это
 *    `SELFVERNUM = 1`, «удалён» — `REMOVED`, остальное «изменён»;
 *  * `OBJECTS.CLASSID` — вид объекта, `PARENTID` — его место в дереве, отсюда
 *    полные имена вида «Документ.Документ1.Форма.ФормаДокумента»;
 *  * `EXTERNALS` — данные объекта по версиям: имя записи вида
 *    `<GUID объекта>.<номер свойства>`, а `DATAHASH` указывает в объектное
 *    хранилище. `.0` — модуль объекта, `.3` — модуль менеджера (сверено
 *    с выгрузкой платформы: тексты совпадают побайтно).
 *
 * Чего здесь принципиально не может быть: **вид объекта по неизвестному
 * CLASSID**. Таблица собрана из хранилищ, которые удалось прочитать, и
 * пополняется только проверенными парами — угадывать вид значит подписать
 * чужой код чужим именем. Неопознанные объекты в дерево помещений попадают
 * (имя-то известно), но их код не разбирается, и отчёт об этом говорит.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { openCd1 } from './cd1.js';
import { openObjectStore, formModuleFromDescription } from './objects.js';
import { KINDS, ruName } from '../../parse/metadataKinds.js';
import { pathExists, ensureDir, rmrf } from '../../util/fsx.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('store');

/**
 * Виды объектов по `CLASSID`.
 *
 * Каждая строка проверена: имя объекта из `1cv8ddb.1CD` сопоставлено с полным
 * именем из отчёта платформы по тому же хранилищу. Идентификаторы записаны
 * так, как лежат в файле (порядок байтов 1С), — переворачивать их незачем.
 */
export const CLASS_KINDS = new Map([
  ['a6be4acfb237d411940f008048da11f9', 'Catalog'],
  ['2a871d0687570e4695aced74ea3a3e84', 'Document'],
  ['014213130bf6d511a3c70050bae0a776', 'InformationRegister'],
  ['0ce8950157b1d4119435004095e12fc7', 'Constant'],
  ['a0751b63e229d611a3c70050bae0a776', 'Report'],
  ['026b7309ac9c3f4eb4f7d3e9576ab948', 'Role'],
  ['ce10d59cfcabd4119434004095e12fc7', 'Language'],
  ['abbe4acfb237d411940f008048da11f9', 'Configuration'],
  ['930e88fbd74727419357a20e69c17545', 'Form'],
]);

/** Подчинённые виды: своей строки в справочнике видов у них нет. */
const SUBORDINATE_RU = new Map([['Form', 'Форма'], ['Command', 'Команда'], ['Template', 'Макет']]);

/** Каталог выгрузки по тегу вида. */
const DIR_BY_TAG = new Map(KINDS.map((kind) => [kind.tag, kind.dir]));

/** Признак каталога хранилища. */
export async function isRepositoryDir(dir) {
  return pathExists(path.join(dir, '1cv8ddb.1CD'));
}

/**
 * Открывает хранилище-каталог.
 *
 * @param {string} dir каталог хранилища
 * @returns {Promise<RepositoryStore>}
 */
export async function openRepositoryStore(dir) {
  const db = await openCd1(path.join(dir, '1cv8ddb.1CD'));
  const objects = await openObjectStore(dir);
  return new RepositoryStore(dir, db, objects);
}

export class RepositoryStore {
  constructor(dir, db, objects) {
    this.dir = dir;
    this.db = db;
    this.objects = objects;

    this.users = new Map(db.rows('USERS').map((u) => [u.USERID, u.NAME]));
    this.classes = new Map(db.rows('OBJECTS').map((o) => [o.OBJID, o.CLASSID]));
    this.rootId = (db.rows('DEPOT')[0] || {}).ROOTOBJID || '';

    // Имя и место объекта в дереве: берём из самой поздней записи истории —
    // объект могли переименовать или перенести.
    this.info = new Map();
    this.rows = db.rows('HISTORY').sort((a, b) => Number(a.VERNUM) - Number(b.VERNUM));
    for (const row of this.rows) {
      if (!row.OBJNAME) continue;
      this.info.set(row.OBJID, { name: row.OBJNAME, parentId: row.PARENTID });
    }

    this.externals = db.rows('EXTERNALS')
      .map((e) => ({
        objId: e.OBJID,
        version: Number(e.VERNUM),
        name: String(e.EXTNAME || ''),
        hash: e.DATAHASH || '',
      }))
      .sort((a, b) => a.version - b.version);

    /** Виды, которых нет в таблице: отчёт обязан их назвать. */
    this.unknownClasses = new Set();
  }

  /** Вид объекта: тег справочника видов либо пусто. */
  kindOf(objId) {
    const classId = this.classes.get(objId);
    if (!classId) return '';
    const tag = CLASS_KINDS.get(classId);
    if (!tag) this.unknownClasses.add(classId);
    return tag || '';
  }

  /**
   * Полное имя объекта — как его печатает платформа:
   * «Документ.Документ1.Форма.ФормаДокумента».
   */
  fullName(objId) {
    const chain = [];
    let current = objId;
    const seen = new Set();
    while (current && current !== this.rootId && !seen.has(current)) {
      seen.add(current);
      const item = this.info.get(current);
      if (!item) break;
      const tag = this.kindOf(current);
      const kindRu = SUBORDINATE_RU.get(tag) || (tag ? platformKindName(tag) : '');
      chain.unshift(kindRu ? `${kindRu}.${item.name}` : item.name);
      current = item.parentId;
    }
    if (!chain.length) return this.info.get(objId)?.name || '';
    return chain.join('.');
  }

  /** Верхний объект дерева для этого объекта: тег вида и имя. */
  ownerOf(objId) {
    let current = objId;
    let owner = null;
    const seen = new Set();
    while (current && current !== this.rootId && !seen.has(current)) {
      seen.add(current);
      const item = this.info.get(current);
      if (!item) break;
      owner = { id: current, name: item.name, tag: this.kindOf(current) };
      current = item.parentId;
    }
    return owner;
  }

  /**
   * История помещений — в том же виде, в каком её отдаёт разбор отчёта
   * платформы, чтобы весь конвейер ниже не заметил разницы.
   */
  history() {
    const commits = [];
    for (const version of this.db.rows('VERSIONS').sort((a, b) => a.VERNUM - b.VERNUM)) {
      const added = [];
      const changed = [];
      const removed = [];
      for (const row of this.rows) {
        if (Number(row.VERNUM) !== Number(version.VERNUM)) continue;
        const name = this.fullName(row.OBJID);
        if (!name) continue;
        if (row.REMOVED) removed.push(name);
        else if (Number(row.SELFVERNUM) === 1) added.push(name);
        else changed.push(name);
      }
      const at = String(version.VERDATE || '');
      commits.push({
        version: Number(version.VERNUM),
        user: this.users.get(version.USERID) || '',
        at,
        date: at ? `${at.slice(8, 10)}.${at.slice(5, 7)}.${at.slice(0, 4)}` : '',
        comment: version.COMMENT || '',
        configVersion: version.CODE || '',
        added,
        changed,
        removed,
        objects: [...new Set([...added, ...changed])],
      });
    }
    return commits;
  }

  /**
   * Состояние данных объекта на версию: последняя запись `EXTERNALS`
   * с номером версии не больше запрошенной.
   */
  externalsAt(version, objIds) {
    const wanted = objIds ? new Set(objIds) : null;
    const latest = new Map();
    for (const item of this.externals) {
      if (item.version > version) break;
      if (wanted && !wanted.has(item.objId)) continue;
      // Пустой хеш означает «в этой версии данные не менялись», а не «данных
      // нет»: у справочника, изменённого в версии 4, запись модуля менеджера
      // пустая, а сам модуль на месте — сверено с выгрузкой платформы.
      // Поэтому пустую запись пропускаем, оставляя прежнее содержимое.
      if (!item.hash) continue;
      latest.set(`${item.objId} ${item.name}`, item);
    }
    return [...latest.values()];
  }

  /**
   * Раскладывает код версии по каталогу — в той же раскладке, что даёт
   * выгрузка платформы. Так весь разбор ниже (`collectModules`,
   * `parseConfigurationDump`) работает без единой поправки.
   *
   * @param {object} params
   * @param {number} params.version номер версии хранилища
   * @param {string} params.outDir куда положить
   * @param {string[]} [params.objects] полные имена объектов (пусто — все)
   * @returns {Promise<{dir: string, modules: number, skipped: string[]}>}
   */
  async materialize({ version, outDir, objects = null }) {
    await rmrf(outDir).catch(() => {});
    await ensureDir(outDir);

    const wantedNames = objects && objects.length ? new Set(objects.map(topLevel)) : null;
    const objIds = [];
    for (const [objId] of this.info) {
      const owner = this.ownerOf(objId);
      if (!owner) continue;
      if (wantedNames) {
        const ownerName = this.fullName(owner.id);
        if (!wantedNames.has(ownerName)) continue;
      }
      objIds.push(objId);
    }

    const skipped = [];
    let modules = 0;
    for (const item of this.externalsAt(version, objIds)) {
      const written = await this.#writeModule(item, outDir);
      if (written) modules += 1;
      else if (written === false) skipped.push(this.fullName(item.objId));
    }
    log.info(`Версия ${version} хранилища «${path.basename(this.dir)}»: модулей ${modules}`);
    return { dir: outDir, modules, skipped: [...new Set(skipped)] };
  }

  /**
   * Пишет один модуль. Возвращает true (записан), false (вид неизвестен)
   * либо null (это не модуль — описание объекта, макет и прочее).
   */
  async #writeModule(item, outDir) {
    const owner = this.ownerOf(item.objId);
    if (!owner) return null;
    const ownerDir = DIR_BY_TAG.get(owner.tag);
    if (!ownerDir) return false;

    const tag = this.kindOf(item.objId);
    const suffix = item.name.split('.').pop();

    let text = '';
    let file = '';
    if (tag === 'Form') {
      // У формы своего модуля нет: он лежит строкой внутри описания формы.
      text = formModuleFromDescription(await this.objects.readDescription(item.hash));
      const formName = this.info.get(item.objId)?.name || 'Форма';
      file = path.join(outDir, ownerDir, owner.name, 'Forms', formName, 'Ext', 'Form', 'Module.bsl');
    } else {
      text = await this.objects.readModuleText(item.hash);
      file = path.join(outDir, ownerDir, owner.name, 'Ext', moduleFileName(owner.tag, suffix));
    }
    if (!text.trim()) return null;

    await ensureDir(path.dirname(file));
    await fs.writeFile(file, text, 'utf8');

    // Рядом с модулем нужен XML объекта: по нему разбор выгрузки узнаёт
    // о самом объекте. Полного описания у нас нет и не требуется — нужны
    // вид и имя.
    const objectXml = path.join(outDir, ownerDir, `${owner.name}.xml`);
    if (!(await pathExists(objectXml))) {
      await fs.writeFile(objectXml,
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        + `<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core">\n`
        + `  <${owner.tag} uuid="">\n    <Properties>\n      <Name>${owner.name}</Name>\n`
        + '    </Properties>\n'
        + `  </${owner.tag}>\n</MetaDataObject>\n`, 'utf8');
    }
    return true;
  }
}

/**
 * Имя вида так, как его печатает платформа: слитно и с прописной у каждого
 * слова — «Регистр сведений» → «РегистрСведений». Простое склеивание давало
 * «Регистрсведений», и отчёт расходился с отчётом конфигуратора на глаз.
 */
export function platformKindName(tag) {
  return ruName(tag)
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ''))
    .join('')
    // «Отчёт» у нас, «Отчет» у платформы: имена объектов в отчёте должны
    // читаться одинаково, каким бы путём они ни получены.
    .replace(/ё/g, 'е');
}

/** «Документ.Док.Форма.Ф» → «Документ.Док». */
function topLevel(name) {
  const parts = String(name || '').split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : String(name || '');
}

/**
 * Имя файла модуля по номеру свойства.
 *
 * Проверено сверкой с выгрузкой платформы: `.0` — модуль объекта, `.3` —
 * модуль менеджера. Прочие номера встречаются у видов, которых в проверенных
 * хранилищах не было, поэтому им даётся нейтральное имя: пусть отчёт назовёт
 * модуль просто модулем, чем соврёт про его вид.
 */
export function moduleFileName(ownerTag, suffix) {
  if (ownerTag === 'CommonModule') return 'Module.bsl';
  if (suffix === '0') return 'ObjectModule.bsl';
  if (suffix === '3') return 'ManagerModule.bsl';
  return `Module${suffix}.bsl`;
}
