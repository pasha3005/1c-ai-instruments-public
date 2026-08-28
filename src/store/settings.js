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

/**
 * Разумные пределы размеров окна.
 *
 * Значения приходят из браузера, и «окно шириной в один пиксель» после
 * следующего запуска пришлось бы искать мышью по экрану. Верхний предел
 * с запасом на несколько мониторов.
 */
const MIN_SIDE = 640;
const MAX_SIDE = 20000;

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

  // Негодный размер прежний не затирает. Окно бывает свёрнутым, и браузер
  // тогда отдаёт нули; забыть из-за этого то, что человек настроил, значило
  // бы открыть в следующий раз окно наугад.
  if (patch?.window !== undefined && next.window === null) {
    next.window = windowBox(stored?.window);
  }

  await ensureDir(DATA_DIR);
  await writeJson(FILE, next);
  const box = next.window ? `, окно ${next.window.width}×${next.window.height}` : '';
  log.info(`Параметры сохранены: тема ${next.theme}${box}`);
  return next;
}

/** Приводит прочитанное к известным значениям: тема — только из перечня тем. */
function normalize(raw) {
  return {
    ...DEFAULTS,
    theme: resolveTheme(raw?.theme).id,
    window: windowBox(raw?.window),
  };
}

/**
 * Размер и положение окна программы — такими, какими их оставил человек.
 *
 * Программа своего мнения о размере окна не имеет: пользователь тянет рамку
 * мышью, а мы запоминаем и открываем в следующий раз так же (требование
 * 28.08.2026). Отрицательные координаты допустимы — второй монитор слева
 * от основного даёт именно их.
 */
function windowBox(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const width = Math.round(Number(raw.width));
  const height = Math.round(Number(raw.height));
  if (!inRange(width) || !inRange(height)) return null;

  const left = Math.round(Number(raw.left));
  const top = Math.round(Number(raw.top));
  const box = { width, height };
  if (Number.isFinite(left) && Number.isFinite(top)
    && Math.abs(left) < MAX_SIDE && Math.abs(top) < MAX_SIDE) {
    box.left = left;
    box.top = top;
  }
  return box;
}

function inRange(value) {
  return Number.isFinite(value) && value >= MIN_SIDE && value <= MAX_SIDE;
}
