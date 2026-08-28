/**
 * Параметры программы — то немногое, что живёт дольше одного прогона.
 *
 * Файл лежит в каталоге данных рядом с программой (`data/settings.json`),
 * а не в профиле пользователя: продукт работает копированием каталога, и,
 * перенеся его на другую машину, человек вправе увидеть тот же вид.
 *
 * Ключи проверяются по белому списку: настройки приходят из браузера, и класть
 * в файл что попало, потому что «оно всё равно наше», — прямой путь к тому,
 * что однажды в нём окажется чужое.
 */

import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { ensureDir, readJson, writeJson } from '../util/fsx.js';
import { DEFAULT_THEME, resolveTheme } from '../ui/themes.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('settings');

const FILE = path.join(DATA_DIR, 'settings.json');

/** Значения по умолчанию — ими же программа живёт, пока файла нет. */
const DEFAULTS = { theme: DEFAULT_THEME, window: null };

/** Читает параметры; испорченный или отсутствующий файл — это значения по умолчанию. */
export async function readSettings() {
  const stored = await readJson(FILE);
  return normalize(stored);
}

/**
 * Записывает изменённые параметры поверх прежних.
 *
 * @param {object} patch только те ключи, что меняются
 * @returns {Promise<object>} состояние параметров после записи
 */
export async function writeSettings(patch) {
  const stored = await readJson(FILE);
  const next = normalize({ ...stored, ...(patch || {}) });
  // Свёрнутое окно страница меряет нулями. Такой размер не годится
  // в запись, но и стирать им прежний нельзя.
  if (patch?.window !== undefined && next.window === null) {
    next.window = windowSize(stored?.window);
  }
  await ensureDir(DATA_DIR);
  await writeJson(FILE, next);
  // Размер окна меняется часто, и строка про него в журнале — шум:
  // он пишется при каждой тяге за угол.
  if (patch?.theme !== undefined) log.info(`Параметры сохранены: тема ${next.theme}`);
  return next;
}

/** Приводит прочитанное к известным значениям: тема — только из перечня тем. */
function normalize(raw) {
  return {
    ...DEFAULTS,
    theme: resolveTheme(raw?.theme).id,
    window: windowSize(raw?.window),
  };
}

/**
 * Наименьшее и наибольшее окно, которые считаются осмысленными.
 *
 * Свёрнутое окно браузер меряет нулями, а страница честно шлёт что намеряла.
 * Записать такое — значит открыть в следующий раз окно в ноль пикселей.
 */
const MIN_SIDE = 640;
const MAX_SIDE = 20000;

/**
 * Размер окна: только ширина и высота.
 *
 * Место окна НЕ хранится намеренно (требование владельца 28.08.2026:
 * «чтобы окно сохраняло свои пропорции, не местоположение»). Открывать
 * окно там, где его закрыли, браузер умеет и сам.
 *
 * @returns {{width: number, height: number}|null} null — «размера нет»
 */
function windowSize(raw) {
  const width = Math.round(Number(raw?.width));
  const height = Math.round(Number(raw?.height));
  const fits = (side) => Number.isFinite(side) && side >= MIN_SIDE && side <= MAX_SIDE;
  return fits(width) && fits(height) ? { width, height } : null;
}
