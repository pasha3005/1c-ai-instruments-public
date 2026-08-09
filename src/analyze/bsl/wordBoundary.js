/**
 * Границы слова для кириллицы.
 *
 * В JavaScript `\b` определена через `\w`, то есть через [A-Za-z0-9_].
 * Кириллические буквы в этот класс не входят, поэтому шаблон вида /\bВЫБРАТЬ\b/
 * НЕ находит слово «ВЫБРАТЬ» в начале строки: перед «В» нет перехода
 * «словесный символ → несловесный».
 *
 * Здесь собраны корректные границы на основе lookaround с явным перечислением
 * букв обоих алфавитов. Используются во всех правилах, разбирающих русские
 * ключевые слова языка запросов и встроенного языка.
 */

/** Класс символов, считающихся частью слова в 1С (латиница, кириллица, цифры, подчёркивание). */
export const WORD_CHAR = 'A-Za-zА-Яа-яЁё0-9_';

/** Граница слева: перед словом не должно быть символа слова. */
export const B = `(?<![${WORD_CHAR}])`;

/** Граница справа: после слова не должно быть символа слова. */
export const E = `(?![${WORD_CHAR}])`;

/**
 * Собирает регулярное выражение, обрамляя шаблон корректными границами слова.
 *
 * @param {string} pattern тело шаблона (без границ)
 * @param {string} [flags]
 * @returns {RegExp}
 */
export function word(pattern, flags = 'gi') {
  return new RegExp(`${B}(?:${pattern})${E}`, flags);
}

/**
 * Проверка вхождения слова без сохранения состояния регулярного выражения.
 * @param {RegExp} re
 * @param {string} text
 */
export function testWord(re, text) {
  re.lastIndex = 0;
  const found = re.test(text);
  re.lastIndex = 0;
  return found;
}

/** Число вхождений шаблона. */
export function countMatches(re, text) {
  re.lastIndex = 0;
  const matches = text.match(re);
  re.lastIndex = 0;
  return matches ? matches.length : 0;
}
