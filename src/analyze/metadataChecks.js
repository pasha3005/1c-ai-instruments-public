/**
 * Проверки уровня конфигурации: по перечню объектов, а не по тексту модуля.
 *
 * Правила из `rules/` видят один модуль и ничего не знают о соседях. Часть
 * требований так не проверить: обработчик подписки лежит в другом объекте,
 * а префикс доработок — свойство имени объекта, у которого модуля может
 * не быть вовсе.
 *
 * Здесь два источника замечаний:
 *
 *  * встроенная проверка подписок на события — работает всегда;
 *  * проверки регламента проекта (префикс, синоним роли, обязательные
 *    процедуры модуля менеджера) — только когда пользователь выбрал файл
 *    регламента.
 *
 * Главное правило продукта соблюдается и здесь: **типовые объекты вендора
 * не проверяются**. Берутся объекты, добавленные интегратором, и собственные
 * объекты расширений; когда сравнивать не с чем, проверяется вся конфигурация —
 * ровно как в анализе кода, и отчёт об этом говорит на титуле.
 */

import { readText } from '../util/fsx.js';
import { kindByTag } from '../parse/metadataKinds.js';
import { SEVERITY, CATEGORY } from './rules/context.js';
import { listOf, pairsOf } from '../policy/parsePolicy.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('analyze:metadata');

/**
 * @param {object} params
 * @param {object} params.parsed результат parseConfigurationDump
 * @param {object[]} params.modules перечень модулей
 * @param {object[]} params.extensions разбор расширений
 * @param {object|null} params.changeSet сравнение с поставщиком
 * @param {object|null} params.policy разобранный регламент
 * @returns {Promise<object[]>} замечания
 */
export async function runMetadataChecks({
  parsed, modules = [], extensions = [], changeSet = null, policy = null,
}) {
  const findings = [];
  const objects = parsed?.objects || [];

  /** Объект — доработка интегратора, а не типовой объект вендора. */
  const isCustom = (fullName) => (changeSet
    ? changeSet.added.has(fullName) || changeSet.modified.has(fullName)
    : true);

  await checkSubscriptions({ findings, objects, modules, isCustom });

  const rule = (code) => {
    const found = policy?.rules?.get(code);
    return found && !found.disabled ? found : null;
  };
  checkNamePrefix({ findings, objects, extensions, changeSet, policy, rule: rule('policy.name-prefix') });
  checkRoleSynonym({ findings, objects, isCustom, rule: rule('policy.role-synonym-suffix') });
  await checkManagerProcedures({
    findings, objects, modules, changeSet, rule: rule('policy.manager-procedures'),
  });

  return findings;
}

/** Заготовка замечания: колонка «где» в отчёте собирается из этих полей. */
function objectFinding(kind, name, extra) {
  const meta = kindByTag(kind);
  return {
    moduleTitle: `${meta?.ru || kind} «${name}»`,
    moduleFile: '',
    moduleType: 'metadata',
    moduleTypeRu: 'Объект метаданных',
    ownerKind: kind,
    ownerName: name,
    formName: null,
    routine: null,
    ...extra,
  };
}

// --- Встроенная проверка: подписка на событие --------------------------------

/**
 * У подписки указан обработчик, которого нет.
 *
 * Платформа проверяет обработчик только при вызове: подписка с потерянным
 * обработчиком живёт в конфигурации до первого проведения документа, а там
 * даёт ошибку у пользователя.
 */
async function checkSubscriptions({ findings, objects, modules, isCustom }) {
  const subscriptions = objects.filter((o) => o.kind === 'EventSubscription' && isCustom(o.fullName));
  if (!subscriptions.length) return;

  const commonModules = new Map();
  for (const module of modules) {
    if (module.moduleType === 'common' && module.ownerName) {
      commonModules.set(module.ownerName.toLowerCase(), module);
    }
  }
  /** Тексты общих модулей читаются по одному разу на модуль. */
  const sources = new Map();

  for (const subscription of subscriptions) {
    const handler = String(subscription.props?.Handler || '').trim();
    if (!handler) {
      findings.push(objectFinding('EventSubscription', subscription.name, {
        ruleId: 'std.subscription-without-handler',
        title: `У подписки «${subscription.name}» не указан обработчик`,
        severity: SEVERITY.HIGH,
        category: CATEGORY.STANDARDS,
        detail: 'Подписка без обработчика не выполняет ничего, но событие перехватывает.',
        recommendation: 'Укажите обработчик либо удалите подписку.',
      }));
      continue;
    }

    const parts = handler.split('.').filter(Boolean);
    if (parts.length < 2) continue;
    const routine = parts[parts.length - 1];
    const moduleName = parts[parts.length - 2];
    const module = commonModules.get(moduleName.toLowerCase());

    if (!module) {
      findings.push(objectFinding('EventSubscription', subscription.name, {
        ruleId: 'std.subscription-without-handler',
        title: `Обработчик подписки «${subscription.name}» не найден`,
        severity: SEVERITY.HIGH,
        category: CATEGORY.STANDARDS,
        detail:
          `Подписка ссылается на «${handler}», но общего модуля «${moduleName}» в конфигурации нет. `
          + 'При наступлении события выполнение прервётся ошибкой.',
        recommendation: 'Восстановите общий модуль с обработчиком либо исправьте ссылку в подписке.',
      }));
      continue;
    }

    if (!sources.has(module.file)) {
      try {
        sources.set(module.file, await readText(module.file));
      } catch (err) {
        log.debug(`Модуль ${module.rel} не прочитан: ${err.message}`);
        sources.set(module.file, null);
      }
    }
    const source = sources.get(module.file);
    if (source === null) continue;

    if (declaresRoutine(source, routine)) continue;

    findings.push(objectFinding('EventSubscription', subscription.name, {
      ruleId: 'std.subscription-without-handler',
      title: `Обработчик подписки «${subscription.name}» не найден`,
      severity: SEVERITY.HIGH,
      category: CATEGORY.STANDARDS,
      detail:
        `Подписка ссылается на «${handler}», но процедуры «${routine}» в общем модуле «${moduleName}» нет. `
        + 'При наступлении события выполнение прервётся ошибкой.',
      recommendation: 'Добавьте процедуру-обработчик в общий модуль либо исправьте ссылку в подписке.',
    }));
  }
}

/** В тексте модуля объявлена процедура или функция с таким именем. */
function declaresRoutine(source, name) {
  if (!source) return false;
  return new RegExp(
    `(?:Процедура|Функция|Procedure|Function)\\s+${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'i',
  ).test(source);
}

// --- Проверки регламента ------------------------------------------------------

/** Замечание регламента: уровень и ссылка на пункт берутся из файла. */
function policyFinding(rule, kind, name, extra) {
  return objectFinding(kind, name, {
    ruleId: rule.code,
    policyCode: rule.code,
    policyRef: rule.section || null,
    severity: rule.severity || SEVERITY.MEDIUM,
    category: CATEGORY.POLICY,
    ...extra,
    recommendation: extra.recommendation || rule.text
      || 'Приведите имя объекта в соответствие с регламентом разработки проекта.',
  });
}

/**
 * Префикс доработок в именах объектов.
 *
 * Проверяются только объекты, добавленные интегратором, и собственные объекты
 * расширений: у типового объекта вендора префикса проекта нет и быть не может.
 * Реквизиты и предопределённые элементы не проверяются — по регламентам они
 * наследуют префикс объекта, а какой реквизит типового объекта добавлен
 * интегратором, из перечня объектов не видно.
 */
function checkNamePrefix({ findings, objects, extensions, changeSet, policy, rule }) {
  if (!rule) return;
  const prefix = String(rule.params['префикс'] || policy?.prefix || '').trim();
  if (!prefix) return;

  const scopes = listOf(rule.params['проверять']).map((s) => s.toLowerCase());
  const wantAdded = !scopes.length || scopes.some((s) => s.includes('добавленн'));
  const wantExtensions = !scopes.length || scopes.some((s) => s.includes('расширен'));
  const skip = new Set(listOf(rule.params['не проверять виды']).map((s) => s.toLowerCase()));
  const lower = prefix.toLowerCase();

  const seen = new Set();
  const check = (kind, name, where, extensionName = null) => {
    const key = `${kind}.${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const meta = kindByTag(kind);
    if (skip.has(String(meta?.ru || kind).toLowerCase())) return;
    if (String(name).toLowerCase().startsWith(lower)) return;

    findings.push(policyFinding(rule, kind, name, {
      title: `Имя «${name}» без префикса «${prefix}»`,
      // В группе лежат объекты разных видов: имя первого из них было бы
      // подписью ко всем (замечание пользователя, 20.08.2026).
      groupTitle: `Объект метаданных без префикса «${prefix}»`,
      extensionName,
      detail:
        `${meta?.ru || kind} «${name}» ${where} и по регламенту проекта должен именоваться `
        + `с префиксом «${prefix}». По префиксу доработку видно в дереве конфигурации и в обновлении.`,
    }));
  };

  if (wantAdded && changeSet) {
    const index = new Map(objects.map((o) => [o.fullName, o]));
    for (const key of changeSet.added) {
      const object = index.get(key);
      if (!object) continue; // Ключ модуля или подчинённого элемента, а не объекта.
      check(object.kind, object.name, 'добавлен интегратором');
    }
  }

  if (!wantExtensions) return;
  for (const extension of extensions || []) {
    for (const key of extension.ownKeys || []) {
      const at = key.indexOf('.');
      if (at < 0) continue;
      check(key.slice(0, at), key.slice(at + 1),
        `является собственным объектом расширения «${extension.name}»`, extension.name);
    }
  }
}

/** Признак проекта в синониме роли: по нему роль видно в списке прав. */
function checkRoleSynonym({ findings, objects, isCustom, rule }) {
  if (!rule) return;
  const suffix = String(rule.params['суффикс синонима роли'] || '').trim();
  if (!suffix) return;

  for (const object of objects) {
    if (object.kind !== 'Role' || !isCustom(object.fullName)) continue;
    const synonym = String(object.synonym || '').trim();
    if (synonym.toLowerCase().endsWith(suffix.toLowerCase())) continue;

    findings.push(policyFinding(rule, object.kind, object.name, {
      title: `Синоним роли «${object.name}» без признака проекта`,
      groupTitle: `Синоним роли без признака проекта «${suffix}»`,
      detail:
        `Синоним «${synonym || 'не задан'}» не оканчивается на «${suffix}». В списке прав проектную роль `
        + 'не отличить от типовой.',
      recommendation: `Допишите в конец синонима «${suffix}».`,
    }));
  }
}

/**
 * Обязательные процедуры модуля менеджера у добавленных объектов.
 *
 * Регламенты требуют подключать новый документ к стандартным механизмам —
 * печати прежде всего, — а подключение это видно в модуле менеджера:
 * команды печати регистрирует процедура, объявленная в нём. Какому виду
 * объекта какая процедура нужна, перечисляет сам регламент.
 *
 * Проверяются ТОЛЬКО объекты, добавленные интегратором. Без сравнения
 * с поставщиком добавленные объекты неизвестны, и правило молчит: иначе
 * на типовой конфигурации замечание получил бы каждый документ вендора.
 */
async function checkManagerProcedures({ findings, objects, modules, changeSet, rule }) {
  if (!rule || !changeSet) return;

  const wanted = new Map();
  for (const pair of pairsOf(rule.params['обязательные процедуры'])) {
    const kind = pair.from.trim().toLowerCase();
    const names = pair.to.split(',').map((s) => s.trim()).filter(Boolean);
    if (!kind || !names.length) continue;
    wanted.set(kind, [...(wanted.get(kind) || []), ...names]);
  }
  if (!wanted.size) return;

  const managers = new Map();
  for (const module of modules) {
    if (module.moduleType !== 'manager' || !module.ownerKind || !module.ownerName) continue;
    managers.set(`${module.ownerKind}.${module.ownerName}`, module);
  }

  const index = new Map(objects.map((o) => [o.fullName, o]));
  const sources = new Map();

  for (const key of changeSet.added) {
    const object = index.get(key);
    if (!object) continue; // Ключ модуля или подчинённого элемента, а не объекта.
    const meta = kindByTag(object.kind);
    const names = wanted.get(String(meta?.ru || object.kind).toLowerCase());
    if (!names?.length) continue;

    const module = managers.get(object.fullName);
    let source = '';
    if (module) {
      if (!sources.has(module.file)) {
        try {
          sources.set(module.file, await readText(module.file));
        } catch (err) {
          log.debug(`Модуль менеджера ${module.rel} не прочитан: ${err.message}`);
          sources.set(module.file, null);
        }
      }
      source = sources.get(module.file);
      if (source === null) continue; // Модуль есть, но не прочитан: обвинять не в чем.
    }

    const missing = names.filter((name) => !declaresRoutine(source, name));
    if (!missing.length) continue;

    findings.push(policyFinding(rule, object.kind, object.name, {
      title: `${meta?.ru || object.kind} «${object.name}»: нет процедур ${missing.join(', ')}`,
      groupTitle: 'Объект не подключён к стандартным механизмам',
      detail:
        `Регламент требует у добавленного объекта этого вида процедуры модуля менеджера: ${names.join(', ')}. `
        + `${module ? `В модуле менеджера не найдены: ${missing.join(', ')}.` : 'Модуля менеджера у объекта нет вовсе.'} `
        + 'Без них объект не подключён к стандартным механизмам и ведёт себя не так, как остальные.',
      recommendation: `Добавьте в модуль менеджера процедуры: ${missing.join(', ')}.`,
    }));
  }
}
