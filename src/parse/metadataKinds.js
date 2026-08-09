/**
 * Справочник видов объектов метаданных 1С.
 *
 * `tag`  — имя элемента внутри <ChildObjects> в Configuration.xml (единственное число);
 * `dir`  — имя каталога в иерархической выгрузке (множественное число);
 * `ru`   — русское наименование вида для отчётов;
 * `countable` — есть ли у объекта таблица данных (можно посчитать записи);
 * `group` — укрупнённая категория для статистики.
 */

/**
 * @typedef {object} MetadataKind
 * @property {string} tag
 * @property {string} dir
 * @property {string} ru
 * @property {string} ruPlural
 * @property {boolean} countable
 * @property {string} group
 */

/** @type {MetadataKind[]} */
export const KINDS = [
  // --- Прикладные объекты, хранящие данные ---
  { tag: 'Catalog', dir: 'Catalogs', ru: 'Справочник', ruPlural: 'Справочники', countable: true, group: 'data' },
  { tag: 'Document', dir: 'Documents', ru: 'Документ', ruPlural: 'Документы', countable: true, group: 'data' },
  { tag: 'InformationRegister', dir: 'InformationRegisters', ru: 'Регистр сведений', ruPlural: 'Регистры сведений', countable: true, group: 'register' },
  { tag: 'AccumulationRegister', dir: 'AccumulationRegisters', ru: 'Регистр накопления', ruPlural: 'Регистры накопления', countable: true, group: 'register' },
  { tag: 'AccountingRegister', dir: 'AccountingRegisters', ru: 'Регистр бухгалтерии', ruPlural: 'Регистры бухгалтерии', countable: true, group: 'register' },
  { tag: 'CalculationRegister', dir: 'CalculationRegisters', ru: 'Регистр расчёта', ruPlural: 'Регистры расчёта', countable: true, group: 'register' },
  { tag: 'ChartOfCharacteristicTypes', dir: 'ChartsOfCharacteristicTypes', ru: 'План видов характеристик', ruPlural: 'Планы видов характеристик', countable: true, group: 'data' },
  { tag: 'ChartOfAccounts', dir: 'ChartsOfAccounts', ru: 'План счетов', ruPlural: 'Планы счетов', countable: true, group: 'data' },
  { tag: 'ChartOfCalculationTypes', dir: 'ChartsOfCalculationTypes', ru: 'План видов расчёта', ruPlural: 'Планы видов расчёта', countable: true, group: 'data' },
  { tag: 'BusinessProcess', dir: 'BusinessProcesses', ru: 'Бизнес-процесс', ruPlural: 'Бизнес-процессы', countable: true, group: 'data' },
  { tag: 'Task', dir: 'Tasks', ru: 'Задача', ruPlural: 'Задачи', countable: true, group: 'data' },
  { tag: 'ExchangePlan', dir: 'ExchangePlans', ru: 'План обмена', ruPlural: 'Планы обмена', countable: true, group: 'exchange' },
  { tag: 'DocumentJournal', dir: 'DocumentJournals', ru: 'Журнал документов', ruPlural: 'Журналы документов', countable: false, group: 'data' },
  { tag: 'Sequence', dir: 'Sequences', ru: 'Последовательность', ruPlural: 'Последовательности', countable: false, group: 'register' },
  { tag: 'Constant', dir: 'Constants', ru: 'Константа', ruPlural: 'Константы', countable: false, group: 'data' },
  { tag: 'Enum', dir: 'Enums', ru: 'Перечисление', ruPlural: 'Перечисления', countable: false, group: 'data' },

  // --- Код и интерфейс ---
  { tag: 'CommonModule', dir: 'CommonModules', ru: 'Общий модуль', ruPlural: 'Общие модули', countable: false, group: 'code' },
  { tag: 'DataProcessor', dir: 'DataProcessors', ru: 'Обработка', ruPlural: 'Обработки', countable: false, group: 'code' },
  { tag: 'Report', dir: 'Reports', ru: 'Отчёт', ruPlural: 'Отчёты', countable: false, group: 'code' },
  { tag: 'CommonForm', dir: 'CommonForms', ru: 'Общая форма', ruPlural: 'Общие формы', countable: false, group: 'ui' },
  { tag: 'CommonCommand', dir: 'CommonCommands', ru: 'Общая команда', ruPlural: 'Общие команды', countable: false, group: 'ui' },
  { tag: 'CommandGroup', dir: 'CommandGroups', ru: 'Группа команд', ruPlural: 'Группы команд', countable: false, group: 'ui' },
  { tag: 'Subsystem', dir: 'Subsystems', ru: 'Подсистема', ruPlural: 'Подсистемы', countable: false, group: 'ui' },
  { tag: 'CommonTemplate', dir: 'CommonTemplates', ru: 'Общий макет', ruPlural: 'Общие макеты', countable: false, group: 'ui' },
  { tag: 'CommonPicture', dir: 'CommonPictures', ru: 'Общая картинка', ruPlural: 'Общие картинки', countable: false, group: 'ui' },
  { tag: 'Interface', dir: 'Interfaces', ru: 'Интерфейс', ruPlural: 'Интерфейсы', countable: false, group: 'ui' },
  { tag: 'Style', dir: 'Styles', ru: 'Стиль', ruPlural: 'Стили', countable: false, group: 'ui' },
  { tag: 'StyleItem', dir: 'StyleItems', ru: 'Элемент стиля', ruPlural: 'Элементы стиля', countable: false, group: 'ui' },
  { tag: 'Language', dir: 'Languages', ru: 'Язык', ruPlural: 'Языки', countable: false, group: 'ui' },

  // --- Права и администрирование ---
  { tag: 'Role', dir: 'Roles', ru: 'Роль', ruPlural: 'Роли', countable: false, group: 'security' },
  { tag: 'CommonAttribute', dir: 'CommonAttributes', ru: 'Общий реквизит', ruPlural: 'Общие реквизиты', countable: false, group: 'data' },
  { tag: 'DefinedType', dir: 'DefinedTypes', ru: 'Определяемый тип', ruPlural: 'Определяемые типы', countable: false, group: 'data' },
  { tag: 'SessionParameter', dir: 'SessionParameters', ru: 'Параметр сеанса', ruPlural: 'Параметры сеанса', countable: false, group: 'security' },
  { tag: 'FilterCriterion', dir: 'FilterCriteria', ru: 'Критерий отбора', ruPlural: 'Критерии отбора', countable: false, group: 'data' },
  { tag: 'FunctionalOption', dir: 'FunctionalOptions', ru: 'Функциональная опция', ruPlural: 'Функциональные опции', countable: false, group: 'ui' },
  { tag: 'FunctionalOptionsParameter', dir: 'FunctionalOptionsParameters', ru: 'Параметр функциональных опций', ruPlural: 'Параметры функциональных опций', countable: false, group: 'ui' },
  { tag: 'SettingsStorage', dir: 'SettingsStorages', ru: 'Хранилище настроек', ruPlural: 'Хранилища настроек', countable: false, group: 'code' },
  { tag: 'ScheduledJob', dir: 'ScheduledJobs', ru: 'Регламентное задание', ruPlural: 'Регламентные задания', countable: false, group: 'code' },
  { tag: 'EventSubscription', dir: 'EventSubscriptions', ru: 'Подписка на событие', ruPlural: 'Подписки на события', countable: false, group: 'code' },

  // --- Интеграция ---
  { tag: 'HTTPService', dir: 'HTTPServices', ru: 'HTTP-сервис', ruPlural: 'HTTP-сервисы', countable: false, group: 'integration' },
  { tag: 'WebService', dir: 'WebServices', ru: 'Web-сервис', ruPlural: 'Web-сервисы', countable: false, group: 'integration' },
  { tag: 'WSReference', dir: 'WSReferences', ru: 'WS-ссылка', ruPlural: 'WS-ссылки', countable: false, group: 'integration' },
  { tag: 'ExternalDataSource', dir: 'ExternalDataSources', ru: 'Внешний источник данных', ruPlural: 'Внешние источники данных', countable: false, group: 'integration' },
  { tag: 'IntegrationService', dir: 'IntegrationServices', ru: 'Сервис интеграции', ruPlural: 'Сервисы интеграции', countable: false, group: 'integration' },
  { tag: 'XDTOPackage', dir: 'XDTOPackages', ru: 'XDTO-пакет', ruPlural: 'XDTO-пакеты', countable: false, group: 'integration' },
  { tag: 'Bot', dir: 'Bots', ru: 'Бот', ruPlural: 'Боты', countable: false, group: 'integration' },
];

const BY_TAG = new Map(KINDS.map((k) => [k.tag, k]));
const BY_DIR = new Map(KINDS.map((k) => [k.dir, k]));

export function kindByTag(tag) {
  return BY_TAG.get(tag) || null;
}

export function kindByDir(dir) {
  return BY_DIR.get(dir) || null;
}

/** Виды, для которых имеет смысл считать количество записей. */
export const COUNTABLE_TAGS = KINDS.filter((k) => k.countable).map((k) => k.tag);

/**
 * Виды объектов, формирующие «объём» конфигурации в понимании 1С-специалиста.
 * Языки, стили и картинки в общий счёт объектов не входят.
 */
const NON_COUNTED_IN_TOTAL = new Set(['Language', 'Style', 'StyleItem', 'CommonPicture']);

export function countsTowardTotal(tag) {
  return !NON_COUNTED_IN_TOTAL.has(tag);
}

/** Русское имя вида: «Справочник» → для заголовков в отчёте. */
export function ruName(tag) {
  return BY_TAG.get(tag)?.ru || tag;
}

export function ruPlural(tag) {
  return BY_TAG.get(tag)?.ruPlural || tag;
}

/**
 * Обратный поиск: «Справочник» → 'Catalog'. Нужен для разбора отчётов конфигуратора.
 *
 * Пробелы отбрасываются намеренно: в этом справочнике имена читаемые
 * («Общий модуль», «Регистр сведений»), а конфигуратор печатает имя типа
 * метаданных слитно («ОбщийМодуль», «РегистрСведений»).
 */
const normalizeRu = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();
const BY_RU = new Map(KINDS.map((k) => [normalizeRu(k.ru), k.tag]));

/**
 * Английский тег вида по русскому имени.
 * Конфигуратор печатает отчёт сравнения на языке интерфейса, а ключи
 * ConfigDumpInfo — всегда английские.
 * @returns {string|null} null — вид неизвестен
 */
export function tagByRu(ru) {
  return BY_RU.get(normalizeRu(ru)) || null;
}
