/**
 * Системные диалоги выбора файла и каталога.
 *
 * Браузер не отдаёт странице полный путь к выбранному файлу — <input type=file>
 * возвращает только имя. Но сервер работает на той же машине, что и браузер
 * (интерфейс слушает 127.0.0.1), поэтому диалог показывается средствами
 * Windows из процесса приложения, а форма получает готовый путь.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from './proc.js';
import { readText, ensureDir, pathExists } from './fsx.js';
import { APP } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('dialogs');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'pick-path.ps1');

/** Готовые фильтры для диалогов выбора и сохранения. */
export const FILE_FILTERS = {
  cf: 'Конфигурация поставщика (*.cf)|*.cf|Все файлы (*.*)|*.*',
  html: 'Веб-страница (*.html)|*.html|Все файлы (*.*)|*.*',
  any: 'Все файлы (*.*)|*.*',
};

export function dialogsAvailable() {
  return process.platform === 'win32';
}

/**
 * Показывает системный диалог и возвращает выбранный путь.
 *
 * @param {object} params
 * @param {'file'|'folder'|'save'} params.mode
 * @param {string} [params.title] заголовок окна
 * @param {string} [params.filter] фильтр файлов в формате WinForms
 * @param {string} [params.initial] начальный каталог
 * @param {string} [params.fileName] имя файла по умолчанию (для режима save)
 * @returns {Promise<string>} путь либо пустая строка, если пользователь отказался
 */
export async function pickPath({
  mode = 'folder', title = '', filter = '', initial = '', fileName = '',
} = {}) {
  if (!dialogsAvailable()) {
    throw new Error('Системный диалог выбора доступен только под Windows — введите путь вручную');
  }

  await ensureDir(APP.tmpDir);
  const outputFile = path.join(APP.tmpDir, `pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

  const args = [
    '-NoProfile',
    '-STA', // WinForms-диалоги требуют однопоточной модели.
    '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Mode', ['file', 'save'].includes(mode) ? mode : 'folder',
    '-OutputFile', outputFile,
  ];
  if (title) args.push('-Title', title);
  if (filter) args.push('-Filter', filter);
  if (initial) args.push('-Initial', initial);
  if (fileName) args.push('-FileName', fileName);

  try {
    // Диалог открыт ровно столько, сколько нужно пользователю: полчаса с запасом.
    await run('powershell.exe', args, { timeout: 30 * 60 * 1000, allowNonZeroExit: true });
    if (!(await pathExists(outputFile))) return '';
    const picked = (await readText(outputFile)).trim();
    return picked;
  } catch (err) {
    log.warn(`Диалог выбора не отработал: ${err.message}`);
    throw new Error(`Не удалось открыть диалог выбора: ${err.message}`);
  } finally {
    await fs.rm(outputFile, { force: true }).catch(() => {});
  }
}

/** Каталог по умолчанию для диалога, если поле пустое. */
export function defaultInitialDir(hint) {
  const value = String(hint || '').trim();
  if (value) return value;
  return os.homedir();
}
