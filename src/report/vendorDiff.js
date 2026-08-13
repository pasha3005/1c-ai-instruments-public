/**
 * Раздел «Отличия от конфигурации поставщика» — дерево.
 *
 * Вынесен из `html.js` отдельным модулем: это самостоятельная и самая объёмная
 * часть отчёта со своей раскладкой (вид объекта → объект → свойство/модуль →
 * строки правки), и держать её вперемешку со сборкой документа было неудобно.
 *
 * Зачем раздел нужен, когда в «Доработках» уже есть числа. Числа отвечают
 * на вопрос «насколько много», дерево — на вопрос «что именно»: какой объект
 * тронут, что в нём изменилось и какие строки дописаны в каждом модуле.
 * Пользователь 1С привык именно к такому представлению и может проверить
 * по нему состав доработок, не открывая конфигуратор.
 */

import { formatNumber } from '../analyze/dataVolume.js';
import { esc, plural, lines, SECTION_NUM } from './ui.js';
import { codeBlock } from './bslHighlight.js';

/**
 * Раздела нет вовсе, когда конфигурация поставщика недоступна: сравнивать
 * не с чем, и пустое дерево только вводило бы в заблуждение.
 */
export function renderVendorDiff(result) {
  const cmp = result.vendorComparison;
  const tree = cmp?.tree;
  if (!cmp?.available || !tree?.groups?.length) return '';

  const t = tree.totals;
  const total = (t.modified || 0) + (t.added || 0) + (t.removed || 0);

  return `
<section class="section">
  ${SECTION_NUM}
  <h2>Отличия от конфигурации поставщика</h2>
  <p class="section__lead">
    Полная картина различий между конфигурацией базы и конфигурацией поставщика:
    объекты, их свойства и реквизиты, модули и — где это удалось установить —
    сами изменённые строки. Дерево раскрывается по уровням, как отчёт
    о сравнении конфигураций в конфигураторе.
  </p>

  <div class="callout callout--plain">
    <div class="callout__title">Эталон сравнения</div>
    <b>${esc(cmp.vendorConfigName || cmp.vendorName || 'конфигурация поставщика')}</b>${cmp.vendorVersion ? `, версия <b>${esc(cmp.vendorVersion)}</b>` : ''}.
    ${esc(vendorSourceNote(cmp.source))} ${esc(vendorDepthNote(tree.depth))}
  </div>

  ${renderDiffBar(cmp)}

  <div class="tree-legend">
    <span><i class="tree-mark tree-mark--modified">±</i>изменено — есть у обоих, но отличается (в конфигураторе <span class="mono">***</span>)</span>
    <span><i class="tree-mark tree-mark--added">+</i>добавлено — есть только в базе (<span class="mono">--&gt;</span>)</span>
    <span><i class="tree-mark tree-mark--removed">−</i>удалено — есть только у поставщика (<span class="mono">&lt;--</span>)</span>
  </div>

  <div class="difftree">
    ${tree.groups.map(renderDiffKind).join('')}
  </div>

  <p class="muted wide-note" style="font-size:13px">
    В дереве ${plural(total, 'объект', 'объекта', 'объектов')}, отличающихся от поставщика:
    изменено ${formatNumber(t.modified || 0)}, добавлено ${formatNumber(t.added || 0)},
    удалено ${formatNumber(t.removed || 0)}. Совпадающие с поставщиком объекты в дерево
    не попадают — это типовой код вендора, он не анализируется.
  </p>
</section>`;
}

function vendorSourceNote(source) {
  return {
    'in-base': 'Сравнение выполнено средствами платформы прямо в базе, с конфигурацией поставщика на поддержке.',
    cf: 'Сравнение выполнено с файлом .cf конфигурации поставщика.',
    dump: 'Сравнение выполнено с XML-выгрузкой конфигурации поставщика.',
  }[source] || 'Сравнение выполнено по картам версий объектов (ConfigDumpInfo).';
}

/**
 * Насколько глубоко удалось разобрать отличия. Оговорка обязательна: без неё
 * читатель принимает отсутствие строк в дереве за отсутствие изменений в коде.
 */
function vendorDepthNote(depth) {
  return {
    sources: 'Исходники поставщика были доступны, поэтому по каждому изменённому модулю '
      + 'приведены конкретные строки, а по объектам — изменения состава реквизитов, '
      + 'табличных частей и форм.',
    report: 'Тексты модулей поставщика при сравнении в базе недоступны, но платформа '
      + 'в подробном отчёте о сравнении сама называет дописанные и изменённые строки '
      + 'каждого модуля — они и приведены. Отличия в составе реквизитов и табличных '
      + 'частей взяты оттуда же.',
    keys: 'Отличия определены по картам версий: видно, какие объекты, модули и формы '
      + 'различаются, но не видно, чем именно.',
  }[depth] || '';
}

/**
 * Пропорция «совпадает / изменено / добавлено / удалено» — одной полосой.
 *
 * Считается по элементам сравнения (объекты, модули, формы), а не по объектам
 * дерева: только так числа на полосе совпадают с таблицей сравнения в разделе
 * «Доработки и качество кода». Смешивать два счёта нельзя — «80 812 совпадает» против
 * «76 изменено» выглядело бы как ошибка на порядки.
 */
function renderDiffBar(cmp) {
  const parts = [
    ['unchanged', 'Совпадает', cmp.unchangedEntries || 0],
    ['modified', 'Изменено', cmp.modifiedEntries || 0],
    ['added', 'Добавлено', cmp.addedEntries || 0],
    ['removed', 'Удалено', cmp.removedEntries || 0],
  ].filter(([, , value]) => value > 0);

  const sum = parts.reduce((s, [, , value]) => s + value, 0) || 1;

  return `
  <div class="diffbar">
    ${parts.map(([key, , value]) => {
      // Отличий на фоне типовой конфигурации — единицы процента: без нижнего
      // предела ширины их полоски на экране просто не видно. Совпавшая часть
      // занимает остаток, поэтому сумма долей всегда сходится ровно.
      if (key === 'unchanged') return '<span class="diffbar__part diffbar__part--unchanged" style="flex:1"></span>';
      return `<span class="diffbar__part diffbar__part--${key}" style="width:${Math.max((value / sum) * 100, 1.5)}%"></span>`;
    }).join('')}
  </div>
  <div class="legend">
    ${parts.map(([key, label, value]) => `
    <span><i class="diffbar__swatch diffbar__swatch--${key}"></i>${label} — ${formatNumber(value)}</span>`).join('')}
    <span class="muted">элементов сравнения: объекты, модули и формы</span>
  </div>`;
}

/** Уровень 1: вид объекта метаданных. */
function renderDiffKind(group) {
  const counts = ['modified', 'added', 'removed']
    .filter((s) => group.counts[s])
    .map((s) => `${STATUS_RU[s]} ${formatNumber(group.counts[s])}`)
    .join(' · ');

  return `
  <details class="dt dt--kind">
    <summary>
      <span class="dt__label">${esc(group.kindRu)}</span>
      <span class="dt__stat">${esc(counts)}</span>
    </summary>
    <div class="dt__body">
      ${group.objects.map(renderDiffObject).join('')}
      ${group.truncated ? `<p class="muted" style="font-size:13px">…и ещё ${formatNumber(group.truncated)} объектов этого вида. Полный перечень — в JSON-выгрузке результата аудита.</p>` : ''}
    </div>
  </details>`;
}

const STATUS_RU = { modified: 'изменено', added: 'добавлено', removed: 'удалено' };
const STATUS_MARK = { modified: '±', added: '+', removed: '−' };

/** Уровень 2: сам объект метаданных. */
function renderDiffObject(object) {
  const children = object.children || [];
  const stat = object.diff
    ? esc(diffSummary(object.diff))
    : plural(children.length, 'отличие', 'отличия', 'отличий');
  const title = `
    <span class="tree-mark tree-mark--${object.status}">${STATUS_MARK[object.status]}</span>
    <span class="dt__label">${esc(object.kindRu)} «${esc(object.name)}»</span>
    ${object.synonym ? `<span class="dt__synonym">${esc(object.synonym)}</span>` : ''}
    <span class="dt__status dt__status--${object.status}">${STATUS_RU[object.status]}</span>`;

  // Раскрывать нечего — показываем строкой. Иначе половина дерева состоит
  // из переключателей, за которыми одна фраза.
  if (!children.length && !hasDiffBody(object.diff)) {
    return `<div class="dt dt--leaf">${title}${object.diff ? `<span class="dt__stat">${stat}</span>` : ''}</div>`;
  }

  return `
  <details class="dt dt--object">
    <summary>${title}<span class="dt__stat">${stat}</span></summary>
    <div class="dt__body">
      ${object.diff ? renderDiffModuleBody(object.diff) : ''}
      ${children.map(renderDiffChild).join('')}
    </div>
  </details>`;
}

/** Уровень 3: реквизит, свойство, модуль, форма. */
function renderDiffChild(child) {
  const title = `
    <span class="tree-mark tree-mark--${child.status}">${STATUS_MARK[child.status]}</span>
    <span class="dt__label">${esc(child.label)}</span>
    <span class="dt__status dt__status--${child.status}">${STATUS_RU[child.status]}</span>`;

  if (!hasDiffBody(child.diff)) {
    return `<div class="dt dt--leaf">${title}${child.diff ? `<span class="dt__stat">${esc(diffSummary(child.diff))}</span>` : ''}</div>`;
  }

  return `
  <details class="dt dt--module">
    <summary>${title}<span class="dt__stat">${esc(diffSummary(child.diff))}</span></summary>
    <div class="dt__body">${renderDiffModuleBody(child.diff)}</div>
  </details>`;
}

/**
 * Есть ли что показывать внутри узла модуля: фрагменты кода либо объяснение,
 * почему место правки установить не удалось. «Модуль добавлен целиком» внутрь
 * узла не прячем — это видно по самой строке.
 */
function hasDiffBody(diff) {
  if (!diff) return false;
  return Boolean(diff.fragments?.length) || diff.method === 'none';
}

/** Короткая подпись об отличиях модуля — справа в заголовке. */
function diffSummary(diff) {
  if (diff.method === 'diff') {
    return `${lines(diff.changedLines)} отличается${diff.exact === false ? ' (приблизительно)' : ''}`;
  }
  if (diff.method === 'compare') {
    const removed = diff.removedLines ? `, удалено ${lines(diff.removedLines)}` : '';
    return `${lines(diff.changedLines)} отличается${removed}`;
  }
  if (diff.method === 'marks') {
    const authors = (diff.authors || []).filter(Boolean);
    return `${lines(diff.changedLines)} в пометках${authors.length ? ` · ${authors.slice(0, 2).join(', ')}` : ''}`;
  }
  if (diff.method === 'added') return `${lines(diff.changedLines)}, модуль новый`;
  return 'место правки не определено';
}

/**
 * Содержимое узла модуля: чем именно он отличается.
 *
 * Фрагменты кода — самое ценное здесь: они превращают «модуль изменён»
 * в «вот что дописано». Если фрагментов нет, честно сказано почему.
 *
 * Когда правка затронула больше одной процедуры, фрагменты дополнительно
 * группируются по процедуре/функции (`codeAnalyzer` подписывает каждый
 * участок именем процедуры по номеру строки) — иначе список из десятка
 * участков подряд не отвечает на вопрос «в какой процедуре что именно».
 * При одной процедуре (или без нужных сведений о процедурах — например,
 * без бюджета фрагментов) группировка добавила бы уровень вложенности
 * без всякой пользы, поэтому список остаётся плоским.
 */
function renderDiffModuleBody(diff) {
  if (diff.method === 'none') {
    return `<p class="dt__note">
      Модуль отличается от поставщика, но ни отчёт о сравнении, ни комментарии-пометки
      не указывают, где именно правка. Какие строки дописаны, определить нечем —
      код такого модуля не проверялся.
    </p>`;
  }

  const fragments = diff.fragments || [];
  const regions = diff.regions || [];
  const regionCount = diff.regionCount ?? regions.length;
  const rest = regionCount - fragments.length;

  const note = `<p class="dt__note">
      ${esc(diffMethodNote(diff))}
      ${regionCount ? ` Участков изменений: ${formatNumber(regionCount)}.` : ''}
      ${diff.rel ? ` <span class="mono">${esc(diff.rel)}</span>` : ''}
    </p>`;
  const restNote = rest > 0
    ? `<p class="muted" style="font-size:12.5px">…и ещё ${plural(rest, 'участок', 'участка', 'участков')} изменений в этом модуле.</p>`
    : '';

  const groups = groupByRoutine(regions);
  if (groups.length <= 1 || !fragments.length) {
    return `${note}${renderFragmentList(fragments, diff.method)}${restNote}`;
  }

  const fragmentsByRoutine = groupByRoutine(fragments);
  const fragmentMap = new Map(fragmentsByRoutine.map((g) => [g.routine, g.items]));

  return `${note}
    ${groups.map((g) => {
    const own = fragmentMap.get(g.routine) || [];
    return `
    <details class="dt dt--routine">
      <summary>
        <span class="dt__label">${g.routine ? `Процедура «${esc(g.signature || g.routine)}»` : 'Вне процедур'}</span>
        <span class="dt__stat">${plural(g.items.length, 'участок', 'участка', 'участков')}</span>
      </summary>
      <div class="dt__body">${own.length ? renderFragmentList(own, diff.method) : noFragmentsNote()}</div>
    </details>`;
  }).join('')}
    ${restNote}`;
}

/**
 * Процедура изменена, но текста правки в отчёте нет.
 *
 * Так бывает, когда правки затронули больше процедур, чем отведено фрагментов
 * (`FRAGMENTS_PER_MODULE` в `codeAnalyzer`): исходники внутри результата аудита
 * весят много, и предел необходим. Раньше в этом случае группа раскрывалась
 * ПУСТОЙ — выглядело как «процедура не раскрывается», и пользователь сообщил
 * об этом как о поломке. Молчать нельзя: пустой блок читается как отсутствие
 * отличий, а отличия есть — не показан их текст.
 */
function noFragmentsNote() {
  return `<p class="dt__note">
    Отличия в этой процедуре есть, но их текст в отчёт не попал: на модуль
    отводится ограниченное число фрагментов кода, иначе файл отчёта разрастается
    на десятки мегабайт. Полные данные — в JSON-выгрузке результата аудита.
  </p>`;
}

/**
 * Группирует участки/фрагменты по имени процедуры, сохраняя порядок первого
 * появления.
 *
 * В заголовке группы показывается подпись целиком — имя, все параметры
 * и «Экспорт» (`routineSignature`), а группируется всё равно по имени:
 * подпись может не сохраниться у прогонов, сделанных прежними версиями,
 * и тогда группа осталась бы без заголовка.
 */
function groupByRoutine(items) {
  const order = [];
  const map = new Map();
  const signatures = new Map();
  for (const item of items) {
    const key = item.routine || null;
    if (!map.has(key)) { map.set(key, []); order.push(key); }
    map.get(key).push(item);
    if (item.routineSignature && !signatures.has(key)) signatures.set(key, item.routineSignature);
  }
  return order.map((routine) => ({
    routine, signature: signatures.get(routine) || null, items: map.get(routine),
  }));
}

/**
 * Один фрагмент — двумя колонками, как отчёт о сравнении конфигураций в 1С:
 * слева конфигурация поставщика на этом же месте, справа основная
 * конфигурация. Колонки названы так же, как их называет сам конфигуратор:
 * «Поставщик» и «Клиент» пользователь прочитал как чужие термины.
 * Код подсвечен по синтаксису языка (`bslHighlight.js`).
 *
 * Пустая левая колонка означает разное в зависимости от способа сравнения:
 * при построчном дифе или разборе отчёта платформы (`diff`/`compare`) это
 * достоверно означает «у поставщика здесь ничего не было — чистая вставка».
 * При разборе по пометкам разработчика (`marks`) сравнения не было вовсе,
 * и это не то же самое: код поставщика просто неизвестен, а не отсутствует.
 */
function renderFragmentList(fragments, method) {
  return fragments.map((fragment) => renderFragment(fragment, method)).join('');
}

function renderFragment(fragment, method) {
  const vendorLines = fragment.vendorLines || [];
  const vendorPane = vendorLines.length
    ? codeBlock(vendorLines.join('\n'))
    : `<div class="dt__diff-empty">${esc(emptyVendorPaneNote(method))}</div>`;

  // Обрезка — только на участках в сотни строк. Дописывать «…и ещё N строк»
  // внутрь кода нельзя: пользователь читает блок как код и такую строку
  // принимает за часть модуля. Поэтому оговорка стоит ПОД блоком.
  const tail = fragment.truncated
    ? `<p class="muted" style="font-size:12px">Показаны первые ${formatNumber(fragment.lines.length)} строк участка,
        ещё ${plural(fragment.truncated, 'строка', 'строки', 'строк')} — в JSON-выгрузке результата аудита.</p>`
    : '';

  return `
    <div class="dt__fragment">
      <div class="dt__fragment-head">строки ${fragment.startLine}–${fragment.endLine}</div>
      <div class="dt__diff">
        <div class="dt__diff-pane dt__diff-pane--vendor">
          <div class="dt__diff-pane-head">Конфигурация поставщика</div>
          ${vendorPane}
        </div>
        <div class="dt__diff-pane dt__diff-pane--client">
          <div class="dt__diff-pane-head">Основная конфигурация</div>
          ${codeBlock(fragment.lines.join('\n'))}
        </div>
      </div>
      ${tail}
    </div>`;
}

function emptyVendorPaneNote(method) {
  return method === 'marks'
    ? 'Сравнение с поставщиком не выполнялось — кода поставщика здесь не знаем'
    : 'У поставщика здесь ничего не было — строки добавлены';
}

function diffMethodNote(diff) {
  return {
    diff: 'Отличия установлены построчным сравнением с модулем поставщика.',
    compare: 'Строки правок взяты из подробного отчёта платформы о сравнении с конфигурацией поставщика.',
    marks: 'Отличия установлены по комментариям-пометкам разработчика: сравнение мест правки не показало.',
    added: 'Модуль добавлен интегратором — у поставщика его нет.',
  }[diff.method] || '';
}

