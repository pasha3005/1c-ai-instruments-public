/**
 * Каталог известных типовых решений 1С.
 *
 * Используется для трёх задач:
 *   • определить, что перед нами типовая конфигурация, а не самописная;
 *   • подобрать префиксы имён, которые считаются «вендорскими»;
 *   • оценить порядок величины конфигурации (сколько объектов ожидается).
 *
 * Каталог намеренно вынесен в отдельный файл: его пополнение не требует
 * изменения логики анализа. Ожидаемое число объектов — ориентир, а не точное
 * значение: оно отличается между релизами.
 */

/**
 * @typedef {object} TypicalSolution
 * @property {string} id
 * @property {string} title отображаемое название
 * @property {RegExp} match сопоставление по имени/синониму конфигурации
 * @property {string[]} vendors ожидаемые значения свойства «Поставщик»
 * @property {number} [expectedObjects] ориентировочное число объектов метаданных
 * @property {string} [family] семейство решений
 * @property {boolean} [bspBased] построено на БСП
 */

/** @type {TypicalSolution[]} */
export const TYPICAL_SOLUTIONS = [
  {
    id: 'erp',
    title: '1С:ERP Управление предприятием',
    match: /\bERP\b|Управление\s+предприятием/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»', '1C'],
    expectedObjects: 9000,
    family: 'ERP',
    bspBased: true,
  },
  {
    id: 'ut',
    title: '1С:Управление торговлей',
    match: /Управление\s+торговлей/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 4500,
    family: 'Торговля',
    bspBased: true,
  },
  {
    id: 'ka',
    title: '1С:Комплексная автоматизация',
    match: /Комплексная\s+автоматизация/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 7000,
    family: 'ERP',
    bspBased: true,
  },
  {
    id: 'buh',
    title: '1С:Бухгалтерия предприятия',
    match: /Бухгалтерия\s+предприятия|Бухгалтерия\s+для/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 3000,
    family: 'Бухгалтерия',
    bspBased: true,
  },
  {
    id: 'zup',
    title: '1С:Зарплата и управление персоналом',
    match: /Зарплата\s+и\s+управление\s+персоналом|Зарплата\s+и\s+кадры/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 4000,
    family: 'ЗУП',
    bspBased: true,
  },
  {
    id: 'unf',
    title: '1С:Управление нашей фирмой',
    match: /Управление\s+нашей\s+фирмой|УНФ/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 2500,
    family: 'УНФ',
    bspBased: true,
  },
  {
    id: 'dokumentooborot',
    title: '1С:Документооборот',
    match: /Документооборот/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 3500,
    family: 'ДО',
    bspBased: true,
  },
  {
    id: 'roznica',
    title: '1С:Розница',
    match: /Розница/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 2500,
    family: 'Розница',
    bspBased: true,
  },
  {
    id: 'ukh',
    title: '1С:Управление холдингом',
    match: /Управление\s+холдингом/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 8000,
    family: 'ERP',
    bspBased: true,
  },
  {
    id: 'bgu',
    title: '1С:Бухгалтерия государственного учреждения',
    match: /государственного\s+учреждения/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 4000,
    family: 'Бюджет',
    bspBased: true,
  },
  {
    id: 'bsp',
    title: 'Библиотека стандартных подсистем (БСП)',
    match: /Библиотека\s+стандартных\s+подсистем|^БСП$/i,
    vendors: ['Фирма "1С"', 'Фирма «1С»'],
    expectedObjects: 1200,
    family: 'БСП',
    bspBased: true,
  },
];

/**
 * Определяет типовое решение по свойствам конфигурации.
 * @param {{name: string, synonym: string, vendor: string, version: string}} configuration
 */
export function detectTypicalSolution(configuration) {
  const haystack = `${configuration.synonym || ''} ${configuration.name || ''}`.trim();
  const vendorLooksLike1C = /1\s*[сc]|1C/i.test(configuration.vendor || '');

  for (const solution of TYPICAL_SOLUTIONS) {
    if (solution.match.test(haystack)) {
      return {
        matched: true,
        id: solution.id,
        title: solution.title,
        family: solution.family,
        bspBased: solution.bspBased,
        expectedObjects: solution.expectedObjects,
        vendorConfirmed: vendorLooksLike1C,
      };
    }
  }

  return {
    matched: false,
    id: null,
    title: null,
    family: null,
    bspBased: false,
    expectedObjects: null,
    vendorConfirmed: vendorLooksLike1C,
  };
}

/**
 * Признаки того, что конфигурация построена на БСП.
 * Проверяется по наличию характерных общих модулей.
 */
export function detectBspUsage(objectIndex) {
  const markers = [
    'CommonModule.ОбщегоНазначения',
    'CommonModule.ОбщегоНазначенияКлиентСервер',
    'CommonModule.СтандартныеПодсистемыСервер',
    'CommonModule.Common',
    'Subsystem.СтандартныеПодсистемы',
  ];
  const found = markers.filter((m) => objectIndex.has(m));
  return {
    detected: found.length >= 2,
    markers: found,
  };
}
