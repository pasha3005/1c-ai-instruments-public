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

  const out = [];
  for (const finding of findings) {
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
