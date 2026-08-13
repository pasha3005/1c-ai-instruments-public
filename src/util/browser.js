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

/**
 * Пути к браузерам, умеющим режим отдельного окна (--app=).
 *
 * Список нарочно шире, чем «переменные окружения плюс два имени». На сервере
 * заказчика переменные `ProgramFiles` могут быть не тем, чем кажутся (сеанс
 * службы, перенаправление 32-битного процесса), а браузер — стоять не там,
 * где обычно. Проверка дешёвая — `existsSync` по готовому списку, — а цена
 * промаха высокая: не найдя ничего, программа открывалась в Internet Explorer,
 * который её интерфейс не показывает вовсе.
 */
function appWindowBrowsers() {
  const bases = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
    process.env.ProgramW6432,
    // Явные пути на случай, если переменные окружения врут или пусты.
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);

  const relative = [
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Google\\Chrome\\Application\\chrome.exe',
    'Chromium\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'Yandex\\YandexBrowser\\Application\\browser.exe',
  ];

  const candidates = [];
  for (const base of bases) {
    for (const rel of relative) candidates.push(pathJoin(base, rel));
  }
  // Дубли убираем: одни и те же пути приходят и из переменных, и из явного
  // списка, а каждый лишний путь — лишняя проверка файловой системы.
  return [...new Set(candidates)];
}

/**
 * Есть ли на машине браузер, способный показать интерфейс программы.
 *
 * Нужно не только для выбора способа открытия: если такого браузера нет,
 * пользователю надо сказать об этом прямо, а не оставлять его наедине
 * с Internet Explorer и сломанной вёрсткой.
 */
export function findAppBrowser() {
  if (process.platform !== 'win32') return null;
  return appWindowBrowsers().find((exe) => existsSync(exe)) || null;
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
 * Что сказать пользователю, когда подходящего браузера на машине нет.
 *
 * Отдельной строкой, а не внутри `openUrl`: то же самое печатает окно запуска
 * и показывает сама страница, и текст должен быть один.
 */
export const NO_BROWSER_HINT = [
  'Не найден Microsoft Edge или Google Chrome.',
  'Интерфейс программы живёт в браузере и требует современного движка:',
  'Internet Explorer его не откроет — покажет страницу без оформления,',
  'и работать в ней будет нельзя.',
  'Установите Edge или Chrome либо откройте адрес на другом компьютере.',
].join('\n');

/**
 * Открывает адрес: сначала отдельным окном, при неудаче — браузером
 * по умолчанию.
 *
 * @param {string} url
 * @param {{appWindow?: boolean, size?: string, maximized?: boolean}} [options]
 * @returns {'app'|'default'|'none'} чем открыли: отдельным окном, браузером
 *   по умолчанию или ничем (на Windows это значит, что подходящего браузера
 *   нет и открывать нечем).
 */
export function openUrl(url, { appWindow = true, size = '1280,900', maximized = false } = {}) {
  try {
    if (process.platform === 'win32') {
      if (appWindow && openAppWindow(url, { size })) return 'app';
      // `start` открывает адрес через оболочку, своим состоянием показа —
      // здесь `windowsHide` безопасен и нужен: иначе мигает консоль cmd.
      // `/max` — тот же приём, что и `windowsHide` для окна приложения,
      // только в обратную сторону: STARTUPINFO новой вкладки получает
      // SW_SHOWMAXIMIZED, а не SW_HIDE. Если у браузера уже есть открытое
      // окно, `start` просто добавит в него вкладку — размер существующего
      // окна это не меняет, и не должно: пользователь выбрал его сам.
      const args = maximized ? ['/c', 'start', '/max', '', url] : ['/c', 'start', '', url];
      spawn('cmd', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      // Браузер по умолчанию может оказаться и Internet Explorer — тогда
      // страница откроется, но работать в ней будет нельзя. Об этом говорит
      // и сама страница (проверка возможностей движка в `web/index.html`),
      // и окно запуска: `openUrl` возвращает, чем открыли.
      return findAppBrowser() ? 'default' : 'none';
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return 'default';
  } catch {
    // Не критично: пользователь откроет ссылку вручную.
    return 'none';
  }
}
