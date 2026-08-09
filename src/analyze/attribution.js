/**
 * Кто написал замечание.
 *
 * Вынесено из `codeAnalyzer.js` отдельным модулем: это самостоятельная задача
 * со своей цепочкой правил и своими граблями, а движок анализа занят другим —
 * обходом модулей и прогоном правил.
 *
 * Пометки ищутся **в каждом проверяемом модуле**, а не только в изменённых
 * типовых: `//++ инт_и_Иванов` стоят в основном в собственных модулях
 * интегратора и в расширениях. Пока их искали только в типовых, ни одно
 * замечание по доработкам не получало имени.
 */

import { regionAtLine, UNKNOWN_AUTHOR } from './bsl/authorship.js';
import { shouldAnalyzeModule, isAddedModule } from './vendorConfig.js';
import { SEVERITY } from './rules/context.js';

/**
 * Автор конкретного замечания.
 *
 * Порядок: пометка, в которую попала строка → автор модуля (когда во всём
 * модуле фигурирует один человек) → «автор не определён» для изменённого
 * типового модуля. У типового кода вендора автора нет и быть не должно.
 */
export function pickAuthor(regions, line, moduleAuthor, origin) {
  const region = regionAtLine(regions, line);
  if (region && region.author !== UNKNOWN_AUTHOR) return region.author;
  if (moduleAuthor) return moduleAuthor;
  if (region) return UNKNOWN_AUTHOR;
  return origin === 'modified' ? UNKNOWN_AUTHOR : null;
}

/**
 * Автор модуля целиком: имя, если во всех пометках модуля фигурирует один
 * человек. В собственном модуле интегратора пометки расставлены не вокруг
 * чужого кода, а внутри своего, поэтому такой вывод корректен — и именно он
 * даёт имя замечаниям, оказавшимся между вставками.
 *
 * Несколько имён — не угадываем: подписан будет только тот код, что попал
 * в конкретную вставку.
 */
export function soleAuthor(regions) {
  const names = new Set(regions.map((r) => r.author).filter((a) => a && a !== UNKNOWN_AUTHOR));
  return names.size === 1 ? [...names][0] : null;
}

/**
 * Сливает записи об одном и том же человеке.
 *
 * Один разработчик подписывается по-разному: в одних пометках «инт_и_Иванов»
 * (с префиксом проекта), в других «Иванов И.И.». Без слияния в сводке две
 * строки на одного человека, и непонятно, чьих замечаний больше.
 *
 * Сливаем только в очевидную сторону: запись «<префикс>_Фамилия» уходит
 * в запись «Фамилия И.О.», если такая есть. Обратное не делаем — фамилия
 * с инициалами точнее.
 */
function mergeSameAuthors(byAuthor) {
  /** «фамилия и.о.» → ключ записи. */
  const bySurname = new Map();
  for (const key of byAuthor.keys()) {
    const surname = /^([а-яёa-z]+)\s+[а-яёa-z]\./.exec(key);
    if (surname) bySurname.set(surname[1], key);
  }
  if (!bySurname.size) return byAuthor;

  for (const [key, entry] of [...byAuthor.entries()]) {
    const tail = key.includes('_') ? key.slice(key.lastIndexOf('_') + 1) : null;
    const target = tail && bySurname.get(tail);
    if (!target || target === key) continue;

    const into = byAuthor.get(target);
    into.total += entry.total;
    into.critical += entry.critical;
    into.high += entry.high;
    for (const m of entry.modules) into.modules.add(m);
    for (const [title, n] of entry.topRules) {
      into.topRules.set(title, (into.topRules.get(title) || 0) + n);
    }
    byAuthor.delete(key);
  }
  return byAuthor;
}

/**
 * Префикс доработки в имени самого объекта: «ДРБ_ЭлектронныйАрхив» → «ДРБ_».
 *
 * Это не фамилия, а метка проекта или интегратора, но именно она отвечает
 * на вопрос «чья это доработка» там, где комментариев с подписью нет вовсе —
 * а у собственных объектов интегратора их обычно и не бывает: подписывать
 * нечего, объект его целиком.
 *
 * Префиксы берутся не из головы, а из `analyzeNamePrefixes`: это те, что
 * систематически встречаются в именах нетиповых объектов этой конфигурации.
 */
export function prefixAuthor(module, prefixes) {
  const name = String(module.ownerName || '');
  if (!name) return null;
  const lower = name.toLowerCase();
  return prefixes.find((p) => p && lower.startsWith(String(p).toLowerCase())) || null;
}

/**
 * Происхождение кода, к которому относится замечание.
 *
 * Нужно, чтобы в отчёте было видно: типовой код вендора не проверялся. Без этой
 * пометки читатель не отличает замечание к собственному объекту интегратора от
 * замечания к типовому объекту 1С — и небезосновательно подозревает второе.
 *
 *   extension — модуль расширения, доработка целиком;
 *   added     — объект или модуль, которого нет у поставщика;
 *   authored  — вставка в типовом модуле, помеченная комментарием разработчика
 *               (проставляется в keepAuthoredFindings вместе с автором);
 *   modified  — модуль отличается от поставщика, но пометок в нём нет;
 *   vendor    — типовой код поставщика (только при явно включённой проверке);
 *   full      — конфигурация поставщика недоступна, проверялось всё подряд.
 */
export function originOf(module, changeSet) {
  if (!changeSet) return 'full';
  if (module.extensionName) return 'extension';
  if (isAddedModule(module, changeSet)) return 'added';
  if (shouldAnalyzeModule(module, changeSet)) return 'modified';
  return 'vendor';
}

/**
 * Сводка замечаний по разработчикам — видно, чьи правки требуют внимания.
 * Замечания без автора (расширения, добавленные модули, анализ без поставщика)
 * в разбивку не попадают: приписывать их некому.
 */
export function groupByAuthor(findings) {
  const byAuthor = new Map();

  for (const finding of findings) {
    if (!finding.author) continue;
    // Ключ без учёта регистра: «инт_» и «Бит_» — один и тот же разработчик,
    // а в сводке они расходились на две строки.
    const key = finding.author.toLowerCase();
    if (!byAuthor.has(key)) {
      byAuthor.set(key, {
        author: finding.author,
        total: 0,
        critical: 0,
        high: 0,
        modules: new Set(),
        topRules: new Map(),
      });
    }
    const entry = byAuthor.get(key);
    entry.total += 1;
    if (finding.severity === SEVERITY.CRITICAL) entry.critical += 1;
    if (finding.severity === SEVERITY.HIGH) entry.high += 1;
    entry.modules.add(finding.moduleTitle);
    entry.topRules.set(finding.title, (entry.topRules.get(finding.title) || 0) + 1);
  }

  return [...mergeSameAuthors(byAuthor).values()]
    .map((e) => ({
      author: e.author,
      total: e.total,
      critical: e.critical,
      high: e.high,
      moduleCount: e.modules.size,
      topIssues: [...e.topRules.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([title, count]) => ({ title, count })),
    }))
    .sort((a, b) => b.critical - a.critical || b.high - a.high || b.total - a.total);
}

/**
 * Подписывает замечания к доработке в изменённом типовом модуле.
 *
 * Фильтровать здесь уже нечего: правила видели только изменённые строки.
 * Автор берётся из пометки-комментария, если строка попала внутрь неё;
 * пометки нет — «автор не определён»: доработка налицо, подписать её некому.
 */
export function signChangedFindings(moduleFindings, authoredRegions) {
  return moduleFindings.map((finding) => {
    const authored = regionAtLine(authoredRegions, finding.line);
    return {
      ...finding,
      author: authored?.author || UNKNOWN_AUTHOR,
      authorMarker: authored?.marker,
      insideAuthoredRegion: Boolean(authored),
      origin: 'modified',
    };
  });
}

export function keepAuthoredFindings(moduleFindings, regions, partial) {
  const kept = [];
  for (const finding of moduleFindings) {
    const region = regionAtLine(regions, finding.line);
    if (!region) {
      partial.droppedFindings += 1;
      continue;
    }
    kept.push({
      ...finding,
      author: region.author,
      authorMarker: region.marker,
      insideAuthoredRegion: true,
      origin: 'authored',
    });
  }
  return kept;
}