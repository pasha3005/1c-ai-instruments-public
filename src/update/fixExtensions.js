/**
 * Починка расширений после обновления конфигурации.
 *
 * Самая частая причина, по которой расширение перестаёт применяться после
 * перехода на новый релиз, — вендор переименовал заимствованный метод.
 * Аннотация `&Вместо("ЗаполнитьРеквизиты")` указывает на процедуру, которой
 * в новой конфигурации больше нет, и платформа отказывается накладывать
 * расширение целиком: не работает уже не одна доработка, а всё расширение.
 *
 * Человек в этом месте открывает модуль конфигурации, находит процедуру
 * с новым именем и правит аннотацию. Здесь делается то же самое и по тем же
 * признакам — но только когда замена **однозначна**:
 *
 *  * процедуры с прежним именем в модуле действительно нет;
 *  * есть ровно одна процедура с похожим именем и тем же числом параметров;
 *  * похожесть имени выше порога.
 *
 * Всё, что не сошлось, не переписывается: испорченное расширение хуже
 * неприменённого, потому что ошибка проявится не при проверке, а у пользователя.
 *
 * Аннотация `&ИзменениеИКонтроль` здесь намеренно не чинится. Её содержимое —
 * копия исходного текста процедуры с вставками и удалениями, и восстановить
 * её после правки вендора можно только объединением внутри самой процедуры;
 * без живого расширения с такой аннотацией под рукой такой код был бы написан
 * вслепую. Такие места собираются в перечень и отдаются человеку с указанием,
 * что именно разошлось.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { splitLines, joinLines } from './diff3.js';
import { tokenize } from '../analyze/bsl/lexer.js';
import { analyzeStructure } from '../analyze/bsl/structure.js';
import { collectFiles, pathExists } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('fix-ext');

/** Аннотации, которыми расширение цепляется к методу конфигурации. */
const ANNOTATION = /&(Вместо|Вокруг|После|Перед|ИзменениеИКонтроль)\s*\(\s*"([^"]+)"\s*\)/gi;

/** Насколько похожими должны быть имена, чтобы счесть это переименованием. */
const NAME_SIMILARITY = 0.7;

/**
 * Проверяет и чинит аннотации всех расширений.
 *
 * @param {object} params
 * @param {{name: string, dir: string}[]} params.extensions выгрузки расширений
 * @param {string} params.mainDir выгрузка основной конфигурации (уже объединённая)
 * @param {boolean} [params.apply] писать ли правки в файлы
 * @returns {Promise<{fixed: object[], manual: object[], changedExtensions: string[]}>}
 */
export async function fixExtensionAnnotations({ extensions, mainDir, apply = true }) {
  const fixed = [];
  const manual = [];
  const changed = new Set();

  for (const extension of extensions) {
    const files = await collectFiles(extension.dir, '.bsl');
    for (const file of files) {
      const rel = path.relative(extension.dir, file).replace(/\\/g, '/');
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (!/&(Вместо|Вокруг|После|Перед|ИзменениеИКонтроль)/i.test(text)) continue;

      const target = await readMainModule(mainDir, rel);
      if (!target) continue;

      const patch = retargetAnnotations(text, target.names, {
        extension: extension.name, rel,
      });
      for (const item of patch.fixed) fixed.push(item);
      for (const item of patch.manual) manual.push(item);

      if (patch.changed && apply) {
        const shape = splitLines(text);
        await fs.writeFile(file, joinLines(patch.lines, shape), 'utf8');
        changed.add(extension.name);
      }
    }
  }

  log.info(`Аннотации расширений: исправлено ${fixed.length}, осталось вручную ${manual.length}`);
  return { fixed, manual, changedExtensions: [...changed] };
}

/**
 * Соответствующий модуль основной конфигурации.
 *
 * Раскладка выгрузки расширения повторяет раскладку конфигурации, поэтому
 * заимствованный объект лежит по тому же относительному пути. Разбирается
 * только он: токенизировать все 19 841 модуль ERP ради нескольких аннотаций
 * означало бы добавить к обновлению лишние минуты.
 */
async function readMainModule(mainDir, rel) {
  const file = path.join(mainDir, rel);
  if (!(await pathExists(file))) return null;
  try {
    const text = await fs.readFile(file, 'utf8');
    const routines = analyzeStructure(tokenize(text).tokens).routines;
    return {
      text,
      names: new Map(routines.map((r) => [r.name.toLowerCase(), r])),
    };
  } catch {
    return null;
  }
}

/**
 * Переписывает аннотации, потерявшие цель.
 *
 * @param {string} text модуль расширения
 * @param {Map<string, object>} mainRoutines процедуры соответствующего модуля конфигурации
 */
export function retargetAnnotations(text, mainRoutines, context = {}) {
  const { lines } = splitLines(text);
  const fixed = [];
  const manual = [];
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    ANNOTATION.lastIndex = 0;
    const match = ANNOTATION.exec(lines[i]);
    if (!match) continue;

    const [, kind, name] = match;
    if (mainRoutines.has(name.toLowerCase())) continue;

    if (/^ИзменениеИКонтроль$/i.test(kind)) {
      manual.push({
        ...context,
        line: i + 1,
        annotation: kind,
        method: name,
        reason: `Процедуры «${name}» в обновлённой конфигурации нет, а «&ИзменениеИКонтроль» `
          + 'хранит копию её исходного текста — восстановить её автоматически нельзя. '
          + 'Перенесите вставки расширения в новую редакцию процедуры вручную.',
      });
      continue;
    }

    const candidate = findRenamed(name, mainRoutines, paramCount(lines, i));
    if (!candidate) {
      manual.push({
        ...context,
        line: i + 1,
        annotation: kind,
        method: name,
        reason: `Процедуры «${name}» в обновлённой конфигурации нет, и однозначной замены `
          + 'по имени и числу параметров не нашлось. Расширение не применится, пока '
          + 'аннотация указывает на несуществующий метод.',
      });
      continue;
    }

    lines[i] = lines[i].replace(match[0], `&${kind}("${candidate.name}")`);
    changed = true;
    fixed.push({
      ...context,
      line: i + 1,
      annotation: kind,
      method: name,
      newMethod: candidate.name,
      reason: `Вендор переименовал «${name}» в «${candidate.name}» — аннотация переставлена `
        + 'на новую процедуру.',
    });
  }

  return { lines, changed, fixed, manual };
}

/** Сколько параметров у процедуры расширения, объявленной под аннотацией. */
function paramCount(lines, annotationIndex) {
  for (let i = annotationIndex + 1; i < Math.min(lines.length, annotationIndex + 6); i += 1) {
    const head = /^\s*(?:Процедура|Функция|Procedure|Function)\s+[\wА-Яа-яЁё_]+\s*\(([^)]*)\)/i
      .exec(lines[i]);
    if (!head) continue;
    const body = head[1].trim();
    return body ? body.split(',').length : 0;
  }
  return -1;
}

/**
 * Ищет переименованную процедуру.
 *
 * Требуется совпадение числа параметров (если его удалось прочитать)
 * и единственный кандидат выше порога похожести: «почти подошли две» —
 * это повод показать человеку, а не выбрать наугад.
 */
function findRenamed(name, mainRoutines, params) {
  const scored = [];
  for (const routine of mainRoutines.values()) {
    if (params >= 0 && routine.params && routine.params.length !== params) continue;
    const score = similarity(name.toLowerCase(), routine.name.toLowerCase());
    if (score >= NAME_SIMILARITY) scored.push({ routine, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.05) return null;
  return scored[0].routine;
}

/**
 * Похожесть имён: доля общей части по расстоянию Левенштейна.
 *
 * Переименования в релизах 1С почти всегда уточняющие — «ЗаполнитьРеквизиты»
 * превращается в «ЗаполнитьРеквизитыОбъекта», — поэтому длинная общая
 * подстрока и есть главный признак.
 */
function similarity(a, b) {
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  const longest = Math.max(a.length, b.length) || 1;
  return 1 - distance / longest;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 40) return Math.max(a.length, b.length);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
