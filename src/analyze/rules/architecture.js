/**
 * Правила архитектурного анализа: размер и связность кода, разделение
 * ответственности, читаемость.
 *
 * Эти находки редко «горят», но именно они определяют стоимость сопровождения
 * и попадают в оценку трудозатрат.
 */

import { TOKEN } from '../bsl/lexer.js';
import { SEVERITY, CATEGORY, snippetAt } from './context.js';
import { LIMITS } from '../../config.js';

export const id = 'architecture';

export function run(ctx) {
  detectBusinessLogicInForms(ctx);
  detectOversizedRoutines(ctx);
  detectOversizedModule(ctx);
  detectEmptyExceptionHandlers(ctx);
  detectTooManyParameters(ctx);
  detectGlobalCommonModule(ctx);
}

/**
 * Бизнес-логика в модуле формы.
 *
 * Признак: в модуле формы выполняются запросы к базе или он просто велик.
 * Такой код невозможно переиспользовать и трудно покрыть тестами, а при
 * обновлении типовой конфигурации форма — самый конфликтный объект.
 */
function detectBusinessLogicInForms(ctx) {
  const { module, queries, stats, structure } = ctx;
  if (module.moduleType !== 'form') return;

  if (queries.length > 0) {
    ctx.report({
      ruleId: 'arch.query-in-form',
      title: 'Запросы к базе данных в модуле формы',
      severity: queries.length >= 3 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
      category: CATEGORY.ARCHITECTURE,
      line: queries[0].line,
      detail:
        `В модуле формы обнаружено запросов: ${queries.length}. ` +
        'Бизнес-логика в форме не переиспользуется, дублируется между формами ' +
        'и осложняет обновление типовой конфигурации (формы конфликтуют чаще всего).',
      recommendation:
        'Перенесите работу с данными в общий модуль (серверный, повторное использование — по ситуации) ' +
        'или в модуль менеджера объекта; форма должна только отображать результат.',
    });
  }

  if (stats.codeLines > 800) {
    ctx.report({
      ruleId: 'arch.large-form-module',
      title: `Очень большой модуль формы (${stats.codeLines} строк кода)`,
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.ARCHITECTURE,
      detail:
        `Модуль формы содержит ${stats.codeLines} строк кода в ${structure.routines.length} процедурах. ` +
        'Это указывает на смешение представления и бизнес-логики.',
      recommendation:
        'Выделите вычисления и работу с данными в отдельные модули, оставив в форме только обработчики событий.',
    });
  }
}

/** Слишком длинные процедуры и высокая цикломатическая сложность. */
function detectOversizedRoutines(ctx) {
  const { structure, source } = ctx;

  for (const routine of structure.routines) {
    if (routine.lines > LIMITS.bigProcedureLines) {
      ctx.report({
        ruleId: 'arch.big-procedure',
        title: `Слишком длинная ${routine.kind === 'function' ? 'функция' : 'процедура'} «${routine.name}» (${routine.lines} строк)`,
        severity: routine.lines > LIMITS.bigProcedureLines * 3 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        category: CATEGORY.ARCHITECTURE,
        line: routine.startLine,
        detail:
          `Процедура занимает ${routine.lines} строк (порог — ${LIMITS.bigProcedureLines}). ` +
          'Такой код трудно читать, тестировать и безопасно изменять.',
        recommendation:
          'Разбейте на несколько процедур по смысловым блокам; каждая должна решать одну задачу.',
        snippet: snippetAt(source, routine.startLine),
      });
    }

    if (routine.complexity > 25) {
      ctx.report({
        ruleId: 'arch.high-complexity',
        title: `Высокая цикломатическая сложность «${routine.name}» (${routine.complexity})`,
        severity: routine.complexity > 50 ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        category: CATEGORY.ARCHITECTURE,
        line: routine.startLine,
        detail:
          `Цикломатическая сложность ${routine.complexity} (по метрике Маккейба: 1 + число точек ` +
          `принятия решения) — это число независимых путей исполнения, каждый из которых требует ` +
          `отдельного тестового случая. Складывается из: ${complexityBreakdown(routine.complexityParts)}. ` +
          'Число само по себе не ошибка в коде — это мера того, сколько разных путей исполнения ' +
          'проходит через процедуру и, значит, сколько тестов нужно, чтобы её всю покрыть.',
        recommendation:
          'Упростите ветвления: выделите условия в отдельные функции, примените ранний возврат, ' +
          'замените длинные цепочки Если на соответствие или таблицу решений. Каждый выделенный ' +
          'кусок логики снижает сложность и исходной процедуры, и общую (просто переносит её туда, ' +
          'где её проще держать в голове).',
        snippet: snippetAt(source, routine.startLine),
      });
    }

    if (routine.maxNesting >= 6) {
      ctx.report({
        ruleId: 'arch.deep-nesting',
        title: `Глубокая вложенность блоков в «${routine.name}» (${routine.maxNesting})`,
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.ARCHITECTURE,
        line: routine.startLine,
        detail: `Максимальная вложенность условий и циклов — ${routine.maxNesting} уровней.`,
        recommendation: 'Используйте ранний выход (Возврат/Продолжить) и выносите вложенные блоки в отдельные процедуры.',
        snippet: snippetAt(source, routine.startLine),
      });
    }
  }
}

/** Из чего складывается цикломатическая сложность — чтобы замечание не было «голым» числом. */
function complexityBreakdown(parts) {
  const items = [
    [parts.conditions, 'условий Если/ИначеЕсли', 'условие Если/ИначеЕсли'],
    [parts.loops, 'циклов', 'цикл'],
    [parts.logical, 'логических операторов И/ИЛИ в условиях', 'логический оператор И/ИЛИ в условии'],
    [parts.exceptions, 'блоков Попытка', 'блок Попытка'],
  ]
    .filter(([count]) => count > 0)
    .map(([count, many, one]) => `${count > 1 ? many : one} — ${count}`);
  return items.length ? items.join(', ') : 'базового пути выполнения';
}

function detectOversizedModule(ctx) {
  const { stats, structure, module } = ctx;
  if (module.moduleType === 'form') return; // Для форм — отдельное правило.
  if (stats.codeLines <= LIMITS.bigModuleLines) return;

  ctx.report({
    ruleId: 'arch.big-module',
    title: `Очень большой модуль (${stats.codeLines} строк кода)`,
    severity: SEVERITY.MEDIUM,
    category: CATEGORY.ARCHITECTURE,
    detail:
      `Модуль содержит ${stats.codeLines} строк кода и ${structure.routines.length} процедур ` +
      `(порог — ${LIMITS.bigModuleLines}).`,
    recommendation:
      'Разделите модуль по зонам ответственности на несколько общих модулей с понятными именами.',
  });
}

/**
 * Пустой блок Исключение — ошибка «проглатывается» без следа.
 * Одна из самых опасных практик: проблема проявится позже и в другом месте.
 */
function detectEmptyExceptionHandlers(ctx) {
  const { tokens, source } = ctx;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== TOKEN.KEYWORD || token.keyword !== 'except') continue;

    // Смотрим, что идёт до КонецПопытки.
    let j = i + 1;
    let meaningful = 0;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.type === TOKEN.KEYWORD && t.keyword === 'endtry') break;
      if (t.type !== TOKEN.COMMENT) meaningful += 1;
      j += 1;
      if (meaningful > 3) break;
    }

    if (meaningful === 0) {
      ctx.report({
        ruleId: 'arch.empty-except',
        title: 'Пустой обработчик исключения',
        severity: SEVERITY.HIGH,
        category: CATEGORY.ARCHITECTURE,
        line: token.line,
        detail:
          'Блок «Исключение» не содержит кода: ошибка подавляется без записи в журнал регистрации. ' +
          'Такие места делают диагностику инцидентов практически невозможной.',
        recommendation:
          'Запишите информацию об ошибке через ЗаписьЖурналаРегистрации() с ПодробноеПредставлениеОшибки(ИнформацияОбОшибке()) ' +
          'и либо обработайте ситуацию, либо пробросьте исключение дальше (ВызватьИсключение).',
        snippet: snippetAt(source, token.line, 1),
      });
    }
  }
}

function detectTooManyParameters(ctx) {
  for (const routine of ctx.structure.routines) {
    if (routine.params.length <= 7) continue;
    ctx.report({
      ruleId: 'arch.too-many-params',
      title: `Много параметров у «${routine.name}» (${routine.params.length})`,
      severity: SEVERITY.LOW,
      category: CATEGORY.ARCHITECTURE,
      line: routine.startLine,
      detail: `Процедура принимает ${routine.params.length} параметров, что затрудняет вызов и сопровождение.`,
      recommendation: 'Сгруппируйте связанные параметры в структуру.',
    });
  }
}

/** Глобальные общие модули замедляют старт и загрязняют пространство имён. */
function detectGlobalCommonModule(ctx) {
  const { module, configuration } = ctx;
  if (module.moduleType !== 'common' || !module.ownerName) return;

  const meta = configuration?.objectIndex?.get?.(`CommonModule.${module.ownerName}`);
  if (!meta) return;

  if (meta.props?.Global === 'true') {
    ctx.report({
      ruleId: 'arch.global-common-module',
      title: `Общий модуль «${module.ownerName}» объявлен глобальным`,
      severity: SEVERITY.LOW,
      category: CATEGORY.ARCHITECTURE,
      detail:
        'Глобальные общие модули загружаются при старте сеанса и увеличивают время запуска, ' +
        'а их экспортные методы попадают в общее пространство имён.',
      recommendation:
        'Откажитесь от признака «Глобальный»: вызывайте методы через имя модуля (стандарт разработки 1С).',
    });
  }
}
