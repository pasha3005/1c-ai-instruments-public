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
const DEFAULTS = { theme: DEFAULT_THEME };

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
  const next = normalize({ ...(await readJson(FILE)), ...(patch || {}) });
  await ensureDir(DATA_DIR);
  await writeJson(FILE, next);
  log.info(`Параметры сохранены: тема ${next.theme}`);
  return next;
}

/** Приводит прочитанное к известным значениям: тема — только из перечня тем. */
function normalize(raw) {
  return {
    ...DEFAULTS,
    theme: resolveTheme(raw?.theme).id,
  };
}
