/**
 * Открытие окон браузера.
 *
 * Вынесено из `main.js`, потому что окно открывает не только запуск программы:
 * готовый отчёт тоже показывается сам, и делает это сервер, а не страница.
 * Через `window.open` из страницы это не работает: окно открывается не по
 * нажатию кнопки, а по событию из потока — браузер такое блокирует
 * как всплывающее.
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ НЕЛЬЗЯ ТРОГАТЬ: у `spawn` НЕ должно быть
 * `windowsHide: true`. Этот флаг ставит в STARTUPINFO дочернего процесса
 * `SW_HIDE`, а Chromium читает оттуда начальное состояние своего окна —
 * и окно приложения создаётся невидимым. Именно из-за этого при первом
 * запуске на новой машине «командная строка мигнула и ничего не произошло»,
 * а со второго раза всё работало: ко второму запуску Edge уже был в памяти
 * (пусть и со скрытым окном), новый вызов только передавал ему команду,
 * и окно создавал уже работающий процесс — с нормальным состоянием показа.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Пути к браузерам, умеющим режим отдельного окна (--app=). */
function appWindowBrowsers() {
  const programFiles = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter(Boolean);

  const relative = [
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Google\\Chrome\\Application\\chrome.exe',
  ];

  const candidates = [];
  for (const base of programFiles) {
    for (const rel of relative) candidates.push(pathJoin(base, rel));
  }
  return candidates;
}

function pathJoin(...parts) {
  return parts.join('\\').replace(/\\+/g, '\\');
}

/**
 * Открывает адрес отдельным окном без адресной строки и вкладок.
 * @returns {boolean} удалось ли
 */
export function openAppWindow(url, { size = '1280,900' } = {}) {
  if (process.platform !== 'win32') return false;
  for (const exe of appWindowBrowsers()) {
    if (!existsSync(exe)) continue;
    try {
      spawn(exe, [`--app=${url}`, `--window-size=${size}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    } catch {
      // Пробуем следующий браузер.
    }
  }
  return false;
}

/**
 * Открывает адрес: сначала отдельным окном, при неудаче — браузером
 * по умолчанию.
 *
 * @param {string} url
 * @param {{appWindow?: boolean, size?: string}} [options]
 */
export function openUrl(url, { appWindow = true, size = '1280,900' } = {}) {
  try {
    if (process.platform === 'win32') {
      if (appWindow && openAppWindow(url, { size })) return;
      // `start` открывает адрес через оболочку, своим состоянием показа —
      // здесь `windowsHide` безопасен и нужен: иначе мигает консоль cmd.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Не критично: пользователь откроет ссылку вручную.
  }
}
