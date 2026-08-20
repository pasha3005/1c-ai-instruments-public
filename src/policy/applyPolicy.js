/**
 * Применение регламента к готовым замечаниям.
 *
 * Проверки самого регламента выполняют правила (`analyze/rules/policy.js`
 * и `analyze/metadataChecks.js`) — они и уровень берут из файла. Здесь
 * решается второе: что регламент делает со **встроенными** правилами движка.
 *
 *  * `выключено: да` — замечания этого правила из отчёта убираются;
 *  * `уровень: высокий` — уровень переставляется на проектный;
 *  * `режим: заменяет` — в отчёте остаётся только то, что перечислено
 *    в регламенте. Это осознанно строгий режим: заказчик получает документ
 *    ровно по своим требованиям, а всё, о чём регламент молчит, исчезает.
 *
 * Функция чистая: на вход список замечаний, на выход новый список.
 */

/**
 * @param {object[]} findings замечания движка
 * @param {object|null} policy разобранный регламент
 * @returns {object[]}
 */
export function applyPolicy(findings, policy) {
  if (!policy || !policy.rules?.size) return findings;

  const covered = coveredByPolicy(findings, policy);

  const out = [];
  for (const finding of findings) {
    // Регламент уже сказал об этой строке то же самое: два замечания об одном
    // и том же методе в одном месте — это дубль, и читатель отчёта не понимает,
    // какое из них исправлять (замечание пользователя, 20.08.2026). Побеждает
    // правило регламента: у требования проекта есть пункт, на который можно
    // сослаться перед разработчиком.
    if (!finding.policyCode
      && OVERRIDDEN_BY_METHODS.has(finding.ruleId)
      && covered.has(placeKey(finding))) continue;
    // Замечание самого регламента: уровень и ссылка на пункт у него уже свои.
    if (finding.policyCode) { out.push(finding); continue; }

    const rule = policy.rules.get(finding.ruleId);
    if (rule?.disabled) continue;
    if (!rule && policy.mode === 'replace') continue;
    if (!rule) { out.push(finding); continue; }

    out.push({
      ...finding,
      severity: rule.severity || finding.severity,
      // Ссылка на пункт регламента: читатель отчёта должен видеть, что
      // требование пришло из документа проекта, а не придумано программой.
      policyRef: rule.section || null,
    });
  }
  return out;
}

/**
 * Встроенные правила, которые перекрываются перечнем запрещённых методов.
 *
 * Регламент и движок нередко запрещают одно и то же: `ТекущаяДата()`,
 * `Сообщить()`, модальные окна. Когда оба сработали на ОДНОЙ строке ОДНОГО
 * модуля, в отчёт идёт замечание регламента — с уровнем проекта и ссылкой
 * на пункт, — а встроенное убирается как дубль.
 *
 * Ключ — модуль и строка, а не текст: совпадение места и есть признак того,
 * что речь об одном и том же коде.
 */
const OVERRIDDEN_BY_METHODS = new Set([
  'std.deprecated-current-date',
  'std.deprecated-message',
  'std.deprecated-sync-call',
]);

function coveredByPolicy(findings, policy) {
  const rule = policy.rules.get('policy.forbidden-methods');
  if (!rule || rule.disabled) return new Set();

  const places = new Set();
  for (const finding of findings) {
    if (finding.policyCode !== 'policy.forbidden-methods') continue;
    places.add(placeKey(finding));
  }
  return places;
}

function placeKey(finding) {
  return `${finding.moduleFile || finding.moduleTitle || ''}:${finding.line || 0}`;
}
