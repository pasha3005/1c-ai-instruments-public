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
import { statSync } from 'node:fs';
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
  md: 'Регламент разработки (*.md)|*.md|Все файлы (*.*)|*.*',
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

/**
 * С какого каталога открыть диалог.
 *
 * Правило простое и одинаковое во всех разделах: в поле уже что-то выбрано —
 * открываемся там, где это лежит; поле пустое — на рабочем столе. Домашний
 * каталог, который был здесь раньше, показывал `AppData`, `Загрузки`
 * и прочее, чего в диалоге выбора базы или выгрузки не ищут никогда.
 *
 * Значение из поля бывает и не путём вовсе — строкой соединения
 * (`Srvr="сервер";Ref="база";`) или адресом хранилища (`tcp://…`). Тогда
 * ничего не находится, и это правильный случай: открываемся на рабочем столе.
 */
export function defaultInitialDir(hint) {
  return existingDirOf(hint) || desktopDir();
}

/**
 * Ближайший существующий каталог для указанного пути.
 *
 * Файл — его каталог; несуществующий путь — первый существующий родитель
 * (человек мог набрать имя новой папки руками). Так диалог всё равно
 * открывается рядом с тем местом, о котором идёт речь.
 */
function existingDirOf(hint) {
  const raw = String(hint || '').trim();
  // Файловая база записывается строкой соединения — путь в ней внутри кавычек.
  const inQuotes = /File\s*=\s*"([^"]+)"/i.exec(raw);
  let current = (inQuotes ? inQuotes[1] : raw).trim().replace(/^"+|"+$/g, '');
  // Только полный путь: у относительного «родителем» окажется рабочий каталог
  // программы, и диалог открылся бы в её собственной папке.
  if (!current || !path.isAbsolute(current)) return '';

  for (let depth = 0; depth < 40 && current; depth += 1) {
    try {
      if (statSync(current).isDirectory()) return current;
      return path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return '';
      current = parent;
    }
  }
  return '';
}

/**
 * Рабочий стол пользователя.
 *
 * С OneDrive рабочий стол переезжает в его каталог, и `%USERPROFILE%\\Desktop`
 * там пуст либо отсутствует вовсе — поэтому проверяем оба места.
 */
function desktopDir() {
  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Рабочий стол'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : '',
    process.env.OneDriveCommercial ? path.join(process.env.OneDriveCommercial, 'Desktop') : '',
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch { /* следующий */ }
  }
  return os.homedir();
}
