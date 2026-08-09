/**
 * Анализ объёма данных и рисков роста.
 *
 * Источники:
 *   • количество записей по объектам метаданных — из COM-сбора (comBridge);
 *   • физическая структура хранения — оттуда же;
 *   • размер файла 1Cv8.1CD — для файловых баз;
 *   • структура метаданных — для оценки «тяжести» объектов независимо от данных.
 *
 * Если живые данные недоступны, анализ выполняется по структуре: перечисляются
 * объекты, которые в принципе склонны к неограниченному росту.
 */

import { ruName } from '../parse/metadataKinds.js';
import { humanSize } from '../util/fsx.js';

/** Пороги для оценки рисков (число записей). */
const THRESHOLDS = {
  largeTable: 1_000_000,
  hugeTable: 10_000_000,
  largeRegister: 5_000_000,
  documentWithManyRecords: 500_000,
};

/**
 * @param {object} params
 * @param {object} params.live результат collectLiveData
 * @param {object} params.parsed
 * @param {Map<string,object>} params.objectIndex
 * @param {object} params.infobaseFacts
 */
export function analyzeDataVolume({ live, parsed, objectIndex, infobaseFacts }) {
  const available = Boolean(live?.available);

  const counts = available ? normalizeCounts(live.counts, objectIndex) : [];
  const totalRecords = counts.reduce((sum, c) => sum + (c.count || 0), 0);

  // Полная таблица по всем посчитанным объектам, по убыванию числа записей.
  const allCounts = [...counts].sort((a, b) => b.count - a.count);
  const topTables = allCounts.filter((c) => c.count > 0).slice(0, 30);
  const emptyObjects = allCounts.filter((c) => c.count === 0);

  const risks = available
    ? assessDataRisks(counts, parsed, objectIndex)
    : assessStructuralRisks(parsed, objectIndex);

  const failed = available ? live.counts.filter((c) => c.error) : [];

  return {
    available,
    reason: available ? null : live?.reason || 'Сбор данных из базы не выполнялся',
    databaseSizeBytes: infobaseFacts?.databaseFileBytes ?? null,
    databaseSizeHuman: infobaseFacts?.databaseFileBytes != null
      ? humanSize(infobaseFacts.databaseFileBytes)
      : null,
    totalRecords,
    countedObjects: counts.length,
    physicalTables: live?.tables?.length || 0,
    topTables,
    allCounts,
    emptyObjects,
    byKind: aggregateByKind(counts),
    insights: available
      ? buildVolumeInsights({ allCounts, emptyObjects, totalRecords, byKind: aggregateByKind(counts) })
      : [],
    risks,
    failedCounts: failed.slice(0, 50).map((f) => ({ id: f.id, error: shorten(f.error) })),
    collectionErrors: live?.errors || [],
    durationMs: live?.durationMs || 0,
  };
}

/**
 * Выводы из таблицы количества записей.
 *
 * Это ровно те наблюдения, которые опытный архитектор делает, увидев распределение
 * данных: где сосредоточен объём, сколько функциональности реально не используется,
 * какова «стоимость» одного документа в записях движений.
 */
export function buildVolumeInsights({ allCounts, emptyObjects, totalRecords, byKind }) {
  const insights = [];
  const nonEmpty = allCounts.filter((c) => c.count > 0);
  if (!allCounts.length) return insights;

  // --- 1. Концентрация объёма ---
  const top5 = nonEmpty.slice(0, 5);
  const top5Sum = top5.reduce((s, c) => s + c.count, 0);
  if (totalRecords > 0 && top5.length) {
    const share = (top5Sum / totalRecords) * 100;
    insights.push({
      title: `Пять объектов содержат ${share.toFixed(1)}% всех записей`,
      detail:
        `Наибольший объём: ${top5.map((c) => `${c.kindRu} «${c.synonym || c.name}» — ${formatNumber(c.count)}`).join('; ')}. ` +
        (share > 70
          ? 'Объём базы определяется практически одним набором таблиц: производительность системы в целом ' +
            'зависит от того, насколько корректно построены запросы и индексы именно к ним. ' +
            'Оптимизацию имеет смысл начинать отсюда — эффект будет максимальным.'
          : 'Объём распределён относительно равномерно, узкое место не сводится к одной таблице.'),
    });
  }

  // --- 2. Неиспользуемая функциональность ---
  if (emptyObjects.length) {
    const share = (emptyObjects.length / allCounts.length) * 100;
    const byKindEmpty = new Map();
    for (const obj of emptyObjects) {
      byKindEmpty.set(obj.kindRu, (byKindEmpty.get(obj.kindRu) || 0) + 1);
    }
    const breakdown = [...byKindEmpty.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([kind, n]) => `${kind.toLowerCase()} — ${n}`)
      .join(', ');

    insights.push({
      title: `Пустых объектов: ${emptyObjects.length} из ${allCounts.length} (${share.toFixed(0)}%)`,
      detail:
        `Ни одной записи не содержат: ${breakdown}. ` +
        (share > 50
          ? 'Более половины объектов метаданных не используются. Это типично для типовых решений, ' +
            'внедрённых частично: оплачивается и сопровождается функциональность, которая не работает. ' +
            'Стоит либо ввести её в эксплуатацию, либо исключить соответствующие подсистемы из области сопровождения.'
          : 'Часть функциональности не задействована — при планировании доработок это стоит учитывать, ' +
            'чтобы не развивать неиспользуемые механизмы.'),
    });
  }

  // --- 3. Стоимость документа в записях движений ---
  const docs = byKind.find((k) => k.kind === 'Document');
  const registerKinds = ['AccumulationRegister', 'InformationRegister', 'AccountingRegister', 'CalculationRegister'];
  const registerRecords = byKind
    .filter((k) => registerKinds.includes(k.kind))
    .reduce((s, k) => s + k.records, 0);

  if (docs?.records > 0 && registerRecords > 0) {
    const ratio = registerRecords / docs.records;
    insights.push({
      title: `На один документ приходится ${ratio.toFixed(1)} записей в регистрах`,
      detail:
        `Документов: ${formatNumber(docs.records)}, записей в регистрах: ${formatNumber(registerRecords)}. ` +
        (ratio > 25
          ? 'Коэффициент высокий: проведение документа порождает много движений. Это напрямую влияет на ' +
            'время проведения и перепроведения, а также на стоимость закрытия месяца. ' +
            'Проверьте, все ли регистры действительно нужны в проведении.'
          : ratio > 8
            ? 'Коэффициент в пределах нормы для учётного решения.'
            : 'Коэффициент низкий — учёт ведётся в небольшом числе разрезов.'),
    });
  }

  // --- 4. Перекос между справочной и учётной информацией ---
  const catalogs = byKind.find((k) => k.kind === 'Catalog');
  if (catalogs?.records > 0 && docs?.records > 0 && catalogs.records > docs.records * 3) {
    insights.push({
      title: 'Справочных данных существенно больше, чем учётных',
      detail:
        `Записей в справочниках: ${formatNumber(catalogs.records)}, документов: ${formatNumber(docs.records)}. ` +
        'Такое соотношение характерно для баз с большой номенклатурой или накопленной историей контрагентов. ' +
        'Убедитесь, что в справочниках нет дублей и устаревших элементов — они замедляют подбор и отчёты.',
    });
  }

  // --- 5. Регистры сведений как скрытый источник роста ---
  const infoReg = byKind.find((k) => k.kind === 'InformationRegister');
  if (infoReg && totalRecords > 0 && infoReg.records / totalRecords > 0.4) {
    insights.push({
      title: `Регистры сведений содержат ${((infoReg.records / totalRecords) * 100).toFixed(0)}% всех записей`,
      detail:
        `Записей в регистрах сведений: ${formatNumber(infoReg.records)} в ${infoReg.objects} регистрах. ` +
        'Периодические регистры сведений растут незаметно и редко попадают в регламент обслуживания. ' +
        'Проверьте необходимость хранения полной истории и настройте очистку устаревших срезов.',
    });
  }

  // --- 6. Общая характеристика масштаба ---
  insights.push({
    title: `Общий объём данных: ${formatNumber(totalRecords)} записей в ${nonEmpty.length} объектах`,
    detail: scaleVerdict(totalRecords),
  });

  return insights;
}

function scaleVerdict(totalRecords) {
  if (totalRecords > 100_000_000) {
    return 'База очень крупная. На таких объёмах обязательны регламент обслуживания индексов и статистик, ' +
      'контроль планов запросов и, как правило, выделенный сервер СУБД.';
  }
  if (totalRecords > 10_000_000) {
    return 'База крупная. Требуются регулярное обслуживание индексов, контроль времени проведения ' +
      'и продуманная политика хранения истории.';
  }
  if (totalRecords > 1_000_000) {
    return 'База среднего размера. Проблемы производительности на таком объёме обычно вызваны не объёмом, ' +
      'а неоптимальным кодом — см. раздел проблем производительности.';
  }
  return 'База небольшая. Объём данных сам по себе не является ограничением производительности; ' +
    'узкие места, если они есть, связаны с качеством кода и запросов.';
}

/** Приводит результат COM-сбора к удобному виду и обогащает метаданными. */
function normalizeCounts(rawCounts, objectIndex) {
  const out = [];
  for (const item of rawCounts || []) {
    if (item.error || item.count === null || item.count === undefined) continue;
    const [kind, ...rest] = String(item.id).split('.');
    const name = rest.join('.');
    const meta = objectIndex.get(`${kind}.${name}`);
    out.push({
      kind,
      kindRu: ruName(kind),
      name,
      fullName: item.id,
      synonym: meta?.synonym || '',
      count: Number(item.count) || 0,
      queryMs: item.ms || 0,
      attributeCount: meta?.attributeCount || 0,
      tabularSectionCount: meta?.tabularSectionCount || 0,
    });
  }
  return out;
}

function aggregateByKind(counts) {
  const map = new Map();
  for (const c of counts) {
    if (!map.has(c.kind)) {
      map.set(c.kind, { kind: c.kind, kindRu: c.kindRu, objects: 0, records: 0 });
    }
    const entry = map.get(c.kind);
    entry.objects += 1;
    entry.records += c.count;
  }
  return [...map.values()].sort((a, b) => b.records - a.records);
}

/** Риски, вычисленные по фактическим объёмам. */
function assessDataRisks(counts, parsed, objectIndex) {
  const risks = [];

  for (const item of counts) {
    if (item.count >= THRESHOLDS.hugeTable) {
      risks.push({
        severity: 'high',
        object: item.fullName,
        title: `${item.kindRu} «${item.synonym || item.name}»: ${formatNumber(item.count)} записей`,
        detail:
          'Таблица превышает 10 млн записей. На таком объёме критично важны корректные индексы, ' +
          'регламент свёртки и разделение итогов; операции без отбора по индексируемым полям ' +
          'будут выполняться минутами.',
        recommendation:
          'Проверьте план запросов к этому объекту, настройте регламентное обслуживание индексов ' +
          'и рассмотрите свёртку либо архивирование исторических данных.',
      });
    } else if (item.count >= THRESHOLDS.largeTable) {
      risks.push({
        severity: 'medium',
        object: item.fullName,
        title: `${item.kindRu} «${item.synonym || item.name}»: ${formatNumber(item.count)} записей`,
        detail: 'Таблица приближается к объёму, на котором проявляются проблемы производительности.',
        recommendation: 'Убедитесь, что все массовые операции используют отборы по индексируемым полям.',
      });
    }

    // Документы с большим числом записей и тяжёлой структурой.
    if (item.kind === 'Document'
      && item.count >= THRESHOLDS.documentWithManyRecords
      && item.tabularSectionCount >= 2) {
      risks.push({
        severity: 'medium',
        object: item.fullName,
        title: `Документ «${item.synonym || item.name}»: ${formatNumber(item.count)} шт. при ${item.tabularSectionCount} табличных частях`,
        detail:
          'Большое число документов со сложной структурой означает значительный объём движений ' +
          'по регистрам и высокую стоимость перепроведения.',
        recommendation:
          'Оцените необходимость перепроведения за прошлые периоды, настройте разделение итогов ' +
          'и контролируйте длительность проведения.',
      });
    }
  }

  // Перекос: один объект занимает подавляющую долю базы.
  const total = counts.reduce((s, c) => s + c.count, 0);
  if (total > 0) {
    const top = counts.slice().sort((a, b) => b.count - a.count)[0];
    if (top && top.count / total > 0.5 && top.count > 1_000_000) {
      risks.push({
        severity: 'medium',
        object: top.fullName,
        title: `Перекос объёма: «${top.synonym || top.name}» — ${Math.round((top.count / total) * 100)}% всех записей`,
        detail: 'Один объект доминирует в базе, что делает его узким местом производительности.',
        recommendation: 'Проанализируйте необходимость хранения полной истории и возможность архивирования.',
      });
    }
  }

  risks.push(...assessStructuralRisks(parsed, objectIndex, { quiet: true }));
  return dedupeRisks(risks);
}

/**
 * Риски, видимые по структуре метаданных без обращения к данным.
 * Работают всегда — в том числе когда сбор живых данных недоступен.
 */
function assessStructuralRisks(parsed, objectIndex, { quiet = false } = {}) {
  const risks = [];

  for (const obj of parsed.objects) {
    // Регистры сведений с независимым режимом записи и без периодичности
    // при большом числе измерений — типичный источник неконтролируемого роста.
    if (obj.kind === 'InformationRegister') {
      const dims = obj.attributeCount;
      if (dims >= 6) {
        risks.push({
          severity: 'low',
          object: obj.fullName,
          title: `Регистр сведений «${obj.synonym || obj.name}»: ${dims} измерений и ресурсов`,
          detail:
            'Большое число измерений увеличивает размер индексов и снижает эффективность отборов.',
          recommendation: 'Проверьте, все ли измерения действительно нужны в ключе записи.',
        });
      }
    }

    // Документы с большим числом табличных частей — тяжёлое проведение.
    if (obj.kind === 'Document' && obj.tabularSectionCount >= 4) {
      risks.push({
        severity: 'low',
        object: obj.fullName,
        title: `Документ «${obj.synonym || obj.name}»: ${obj.tabularSectionCount} табличных частей`,
        detail: 'Сложная структура документа удорожает запись, проведение и обмен данными.',
        recommendation: 'Оцените возможность вынести редко используемые части в подчинённые объекты.',
      });
    }
  }

  if (quiet) return risks.filter((r) => r.severity !== 'low').slice(0, 10);
  return risks.slice(0, 40);
}

function dedupeRisks(risks) {
  const seen = new Set();
  const out = [];
  for (const risk of risks) {
    const key = `${risk.object}|${risk.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(risk);
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)).slice(0, 60);
}

export function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function shorten(text) {
  return String(text || '').slice(0, 200);
}
