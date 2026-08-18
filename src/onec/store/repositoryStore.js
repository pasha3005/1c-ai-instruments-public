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
  ['185184bf7b328246b5c6285d2a0eb296', 'DataProcessor'],
  ['4907a8f6d75a0b40851939dc5dff2542', 'Enum'],
  ['026b7309ac9c3f4eb4f7d3e9576ab948', 'Role'],
  ['ce10d59cfcabd4119434004095e12fc7', 'Language'],
  ['abbe4acfb237d411940f008048da11f9', 'Configuration'],
  ['8089e40f2d25d611a3c70050bae0a776', 'CommonModule'],
  ['2684ee07f187d511b99c0050bae0a95d', 'CommonForm'],
  ['d943cd7da5ac2649b5491842e6a4e8cf', 'CommonPicture'],
  ['c0fc7b3e7d06d611a3c70050bae0a776', 'FilterCriterion'],
  ['4837c42438c9d0458d1401424a72b11e', 'SessionParameter'],
  ['9afaf23776b2d4119435004095e12fc7', 'Subsystem'],
  ['6adfbd393c0c2b45921cd99cfa1c2f1b', 'Interface'],
  ['af04543ef86e734cad1191bd2dfac4c8', 'Style'],
  ['66878458ea3676408800e91eb49590d7', 'StyleItem'],
  ['16a0ae3db769d44e9453127911372fe6', 'Template'],
  ['409a4db64216d611a3c70050bae0a776', 'AccumulationRegister'],
  ['d600b1309fb2ac47aec7cb8ca8a54767', 'ChartOfCalculationTypes'],
  ['59b6a18220b2944da9bd14d757b95a48', 'ChartOfCharacteristicTypes'],
  ['beea571c4973b344b1deebfeab67b47d', 'CommandGroup'],
  ['63457915ecccf641a83cec5f7b9a5bc1', 'CommonAttribute'],
  ['87511a2f0efb054b9489dc5dd6412348', 'CommonCommand'],
  ['92c7890cc316d511b96b0050bae0a95d', 'CommonTemplate'],
  ['9e0945c0b913b64f9d50fca00202971e', 'DefinedType'],
  ['75bd1246b7715c4a8cc52b0b65f9fa0d', 'DocumentJournal'],
  ['a68d824e440f5b4bb1c0a2b3cfe7bdcc', 'EventSubscription'],
  ['914a7c85f4e5ac4f86ec787626f1c108', 'ExchangePlan'],
  ['407954af68324f43a3e7e47d6d2638c3', 'FunctionalOption'],
  ['db54d5301e54624f8970a1c6dcfeb2bc', 'FunctionalOptionsParameter'],
  ['85afbd11add5914dbb24aa0eee139052', 'ScheduledJob'],
  ['97cdb44613fdaa4eaba23bddd7699218', 'SettingsStorage'],
  ['02622f10fa43b0408898acd3876daacb', 'StyleItem'],
  ['5c35633e78135349be9b1deb5fb6bec5', 'Task'],
  ['4e40d3fc2315ce489bc0ecdb822684a1', 'BusinessProcess'],
  ['887e8e235f3cb2488a3b81ebbecb20ed', 'ChartOfAccounts'],
  ['46e3a836aa9af94abdbd83be3c177977', 'DocumentNumerator'],
  ['9cc0ff0f4c8fcc47b41c8d5c5a221d79', 'HTTPService'],
  ['2e03578640771d4ea3ba5dd6e8afb78f', 'WebService'],
  ['fb9660d25d7af94daf6347d04771fa9b', 'WSReference'],
  ['98f79dcc947c164697d27aa0b7bc515e', 'XDTOPackage'],
  // Форм у платформы несколько классов — свой на каждый вид владельца.
  ['930e88fbd74727419357a20e69c17545', 'Form'],
  ['d216f8fdad1ed511b9750050bae0a95d', 'Form'],
  ['044213130bf6d511a3c70050bae0a776', 'Form'],
  ['c068b3a3e229d611a3c70050bae0a776', 'Form'],
  ['ede5b0d56d251c409c36f630cafd8a62', 'Form'],
  ['407c8600b106d611a3c70050bae0a776', 'Form'],
  ['4be5f233ce377a4aa569b648d7aa4634', 'Form'],
  ['ab09c587383d674db379aca796298578', 'Form'],
  ['10ad81ec07cad511b9a50050bae0a95d', 'Form'],
  ['0c3c53b84223b34d91a2c2b08cbf6b23', 'Form'],
  ['a8782beba6407e4bb1b36ca9966cbc94', 'Form'],
  ['449a4db64216d611a3c70050bae0a776', 'Form'],
  ['2af9f8a74b7a4b48937e42d242e64144', 'Form'],
  ['fbcb583f7241544ebe49561a579bb38b', 'Form'],
  ['85e27253db038c4f8565fe56f1aea40e', 'Form'],
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
export async function openRepositoryStore(dir, { extraKinds = null } = {}) {
  const db = await openCd1(path.join(dir, '1cv8ddb.1CD'));
  const objects = await openObjectStore(dir);
  return new RepositoryStore(dir, db, objects, extraKinds);
}

export class RepositoryStore {
  constructor(dir, db, objects, extraKinds = null) {
    this.dir = dir;
    this.db = db;
    this.objects = objects;

    /** Виды, выясненные на месте: дополняют таблицу, не подменяя её. */
    this.extraKinds = new Map(extraKinds || []);
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
    const tag = CLASS_KINDS.get(classId) || this.extraKinds.get(classId);
    if (!tag) this.unknownClasses.add(classId);
    return tag || '';
  }

  /**
   * Добавляет виды, выясненные на месте (`store/kinds.js`), и забывает
   * прежние жалобы: после доучивания эти идентификаторы уже не незнакомые.
   */
  learnKinds(pairs) {
    for (const [classId, tag] of pairs) {
      this.extraKinds.set(classId, tag);
      this.unknownClasses.delete(classId);
    }
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
    } else if (tag === 'Command') {
      // Команда объекта — свой каталог рядом с формами; модуль в ней один.
      text = await this.objects.readModuleText(item.hash);
      const commandName = this.info.get(item.objId)?.name || 'Команда';
      file = path.join(outDir, ownerDir, owner.name, 'Commands', commandName, 'Ext', 'CommandModule.bsl');
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
    // Пробелы И дефисы: платформа пишет вид слитно и с прописной у каждого
    // слова — «Регистр сведений» → «РегистрСведений», «HTTP-сервис» →
    // «HTTPСервис», «Бизнес-процесс» → «БизнесПроцесс». Имя с дефисом
    // платформа не принимает вовсе: «объект не существует в конфигурации».
    .split(/[\s-]+/)
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
  const known = MODULE_FILES.get(`${ownerTag} ${suffix}`);
  if (known) return known;
  return `Module${suffix}.bsl`;
}

/**
 * Какой модуль лежит под каким номером свойства.
 *
 * Номера у каждого вида свои, и выяснены сличением: тексты, добытые читателем,
 * сверены с выгрузкой той же конфигурации платформой — совпали побайтно.
 * Незнакомая пара получает нейтральное имя `ModuleN.bsl`: пусть отчёт назовёт
 * модуль просто модулем, чем соврёт про его вид.
 */
const MODULE_FILES = new Map([
  ['Catalog 0', 'ObjectModule.bsl'],
  ['Catalog 3', 'ManagerModule.bsl'],
  ['Document 0', 'ObjectModule.bsl'],
  ['Document 2', 'ManagerModule.bsl'],
  ['DocumentJournal 1', 'ManagerModule.bsl'],
  ['InformationRegister 1', 'RecordSetModule.bsl'],
  ['InformationRegister 2', 'ManagerModule.bsl'],
  ['AccumulationRegister 1', 'RecordSetModule.bsl'],
  ['AccumulationRegister 2', 'ManagerModule.bsl'],
  ['BusinessProcess 6', 'ObjectModule.bsl'],
  ['BusinessProcess 8', 'ManagerModule.bsl'],
  ['Task 6', 'ObjectModule.bsl'],
  ['Task 7', 'ManagerModule.bsl'],
  ['ChartOfAccounts 14', 'ObjectModule.bsl'],
  ['ChartOfAccounts 15', 'ManagerModule.bsl'],
  ['ChartOfCharacteristicTypes 15', 'ObjectModule.bsl'],
  ['ChartOfCharacteristicTypes 16', 'ManagerModule.bsl'],
  ['ExchangePlan 2', 'ObjectModule.bsl'],
  ['Report 2', 'ManagerModule.bsl'],
  ['SettingsStorage 8', 'ManagerModule.bsl'],
  ['CommonCommand 2', 'CommandModule.bsl'],
  ['ChartOfCalculationTypes 0', 'ObjectModule.bsl'],
  ['ChartOfCalculationTypes 3', 'ManagerModule.bsl'],
  ['ExchangePlan 3', 'ManagerModule.bsl'],
  ['Report 0', 'ObjectModule.bsl'],
  ['HTTPService 0', 'Module.bsl'],
  ['WebService 0', 'Module.bsl'],
]);
