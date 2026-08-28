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

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, SERVER, APP } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('browser');

/**
 * Размер окна при самом первом запуске.
 *
 * Дальше окно открывается таким, каким его оставил пользователь: размер
 * и положение он меняет мышью, а программа их запоминает
 * (`data/settings.json`, ключ `window`). Подбирать размер под экран программа
 * не пытается — требование пользователя 28.08.2026: «по умолчанию открывай
 * окно как хочешь, но сохраняй последние пропорции».
 */
const DEFAULT_WINDOW_SIZE = '1280,900';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Скрипт, возвращающий окну запомненные размер и положение.
 *
 * Одними ключами командной строки это не делается: `--window-size`
 * и `--window-position` Chromium применяет ТОЛЬКО при создании нового окна
 * приложения. Если окно с тем же `--app=` у него уже было, он восстанавливает
 * геометрию из своего профиля, а ключи молча игнорирует — проверено
 * 28.08.2026: просили 1500×950 в позиции 100,50, получили 945×1012
 * в позиции 10,10. Поэтому размер ставится после открытия, через MoveWindow.
 */
const PLACE_SCRIPT = path.join(ROOT, 'src', 'tools', 'place-window.ps1');

/**
 * Вернуть окну запомненные размер и положение.
 *
 * Работает в фоне и молча: окно уже открыто и работает, а неудача здесь —
 * это «окно не той ширины», а не сломанная программа.
 */
function placeWindow(box) {
  if (!box || box.left === undefined) return;

  try {
    // Без `detached`: с ним PowerShell на этой машине не отрабатывает вовсе —
    // процесс запускается и молча ничего не делает (проверено 28.08.2026:
    // тот же вызов без флага возвращает «ok»). Скрипт живёт секунды, так что
    // держать его потомком сервера безопасно.
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PLACE_SCRIPT,
      '-Title', APP.name,
      '-Left', String(box.left), '-Top', String(box.top),
      '-Width', String(box.width), '-Height', String(box.height),
    ], { windowsHide: true });

    let answer = '';
    child.stdout?.on('data', (chunk) => { answer += chunk; });
    child.on('error', (err) => log.warn(`Размер окна вернуть не удалось: ${err.message}`));
    child.on('close', () => {
      const said = answer.trim();
      if (said.startsWith('ok')) {
        log.info(`Окну возвращён размер ${box.width}×${box.height} в позиции ${box.left},${box.top}`);
      } else {
        log.warn(`Размер окна вернуть не удалось: ${said || 'ответа нет'}`);
      }
    });
  } catch (err) {
    log.warn(`Не удалось вернуть окну размер: ${err.message}`);
  }
}
/** Куда класть переносной браузер, чтобы программа его нашла. */
export const BUNDLED_BROWSER_DIR = path.join(ROOT, 'runtime', 'browser');

/** Имена исполняемых файлов у сборок Chromium, которые встречаются на практике. */
const CHROMIUM_EXE = ['chrome.exe', 'msedge.exe', 'chromium.exe', 'thorium.exe', 'brave.exe'];

/**
 * Браузер, положенный рядом с программой.
 *
 * Нужен там, где на машине только Internet Explorer: интерфейс ему не по зубам,
 * а ставить браузер на сервер заказчика можно не всегда. Тогда в поставку
 * кладут переносную сборку Chromium — программа находит её сама и открывает
 * интерфейс ею, ничего не устанавливая.
 *
 * Ищем и в самом каталоге, и на уровень глубже: переносные сборки распаковывают
 * то плоско, то папкой вида `chrome-win\`.
 */
export function findBundledIn(dir) {
  if (!existsSync(dir)) return null;

  for (const exe of CHROMIUM_EXE) {
    const direct = path.join(dir, exe);
    if (existsSync(direct)) return direct;
  }

  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const exe of CHROMIUM_EXE) {
      const nested = path.join(dir, entry.name, exe);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

function bundledBrowser() {
  return findBundledIn(BUNDLED_BROWSER_DIR);
}

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
  // Браузер из поставки — первым: его положили сюда именно затем, чтобы
  // пользоваться им, а не тем, что найдётся на машине.
  const bundled = bundledBrowser();
  if (bundled) candidates.push(bundled);

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
 * Открывает адрес обычным окном того браузера, в котором работает программа.
 *
 * Нужно для отчётов: в окне программы (`--app`) нет ни адресной строки,
 * ни вкладок, а браузер по умолчанию на машине заказчика может оказаться
 * Internet Explorer — отчёт в нём не открывается нормально.
 *
 * @returns {boolean} удалось ли
 */
export function openWindow(url, { maximized = false } = {}) {
  if (process.platform !== 'win32') return false;
  const order = browserOrder(
    browserWithAppWindow(SERVER.port) || rememberedBrowser(),
    appWindowBrowsers(),
  );
  for (const exe of order) {
    if (!existsSync(exe)) continue;
    const args = ['--new-window', url];
    if (maximized) args.unshift('--start-maximized');
    if (launch(exe, args, 'окно отчёта')) return true;
  }
  log.warn(`Отчёт открыть нечем: подходящий браузер не найден (${url})`);
  return false;
}

/**
 * Запуск браузера с присмотром.
 *
 * `spawn` не бросает исключение, когда запустить не удалось: об этом
 * приходит событие `error`, а раньше его никто не слушал — программа
 * докладывала об успехе, окна не было, и в журнале не оставалось ни строки
 * (живой случай 20.08.2026). Ранний выход с ненулевым кодом означает то же
 * самое: так ведёт себя переносной Chromium без прав «все пакеты приложений».
 *
 * @returns {boolean} удалось ли ЗАПУСТИТЬ (не «показать окно»)
 */
function launch(exe, args, what) {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      log.warn(`${what}: ${exe} не запустился — ${err.message}`);
    });
    child.on('exit', (code) => {
      if (code) log.warn(`${what}: ${exe} завершился сразу с кодом ${code} — окна нет`);
    });
    child.unref();
    log.info(`${what}: ${exe}`);
    return true;
  } catch (err) {
    log.warn(`${what}: ${exe} не запустился — ${err.message}`);
    return false;
  }
}

/**
 * Открывает адрес отдельным окном без адресной строки и вкладок.
 * @returns {boolean} удалось ли
 */
export function openAppWindow(url, { box = null } = {}) {
  if (process.platform !== 'win32') return false;
  const size = box ? `${box.width},${box.height}` : DEFAULT_WINDOW_SIZE;
  for (const exe of browserOrder(rememberedBrowser(), appWindowBrowsers())) {
    if (!existsSync(exe)) continue;
    const args = [`--app=${url}`, `--window-size=${size}`];
    // Положение задаётся, только когда его есть откуда взять: своего мнения
    // о том, где на экране должно быть окно, у программы нет.
    if (box && box.left !== undefined) args.push(`--window-position=${box.left},${box.top}`);
    if (launch(exe, args, 'окно программы')) {
      rememberAppBrowser(exe);
      // Ключи мог проигнорировать сам браузер — дожимаем через WinAPI.
      placeWindow(box);
      return true;
    }
  }
  return false;
}

/**
 * Каким браузером открыто окно программы.
 *
 * Записывается на диск, а не в память процесса: сервер переживает перезапуск,
 * а окно программы — нет, и наоборот. Живой случай 19.08.2026: окно открыл
 * экземпляр с переносным Chromium в поставке, сервер потом перезапустили
 * из другой копии — без переносного браузера, — и отчёт ушёл в Edge, хотя
 * программа работала в Chromium. Правило продукта одно: **отчёт открывается
 * тем же браузером, что и окно программы**.
 */
const BROWSER_CHOICE_FILE = path.join(DATA_DIR, 'browser.json');

export function rememberAppBrowser(exe) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(BROWSER_CHOICE_FILE, JSON.stringify({ exe, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // Не записалось — не беда: порядок поиска остаётся прежним.
  }
}

/**
 * Браузер, в котором ПРЯМО СЕЙЧАС открыто окно программы.
 *
 * Спрашиваем у Windows, а не полагаемся на память: окно и сервер живут
 * порознь. Окно мог открыть другой экземпляр программы, сервер могли
 * перезапустить, память процесса при этом пуста — а пользователь видит
 * своё окно и справедливо ждёт, что отчёт откроется в нём же.
 *
 * Ищем по командной строке: окно программы запускается ключом `--app=<адрес>`,
 * и другого процесса с таким ключом на машине нет.
 */
export function browserWithAppWindow(port) {
  if (process.platform !== 'win32') return null;
  // Отбор по ИМЕНИ процесса обязателен. Искомая подстрока «--app=http://…»
  // лежит в командной строке самого опроса, поэтому без этого условия
  // PowerShell находит СЕБЯ и отдаёт свой путь. Дальше программа честно
  // запускает powershell.exe с ключами браузера, тот молча завершается,
  // и отчёт не открывается ничем: ни окна, ни ошибки (живой случай
  // 20.08.2026). Своя строка исключается ещё и по идентификатору процесса.
  const names = BROWSER_PROCESS_NAMES.map((name) => `'${name}'`).join(',');
  const command = 'Get-CimInstance Win32_Process'
    + ` | Where-Object { $_.ProcessId -ne $PID -and @(${names}) -contains $_.Name `
    + `-and $_.CommandLine -like '*--app=http://127.0.0.1:${Number(port)}*' }`
    + ' | Select-Object -First 1 -ExpandProperty ExecutablePath';
  try {
    const found = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8', timeout: 6000, windowsHide: true,
    });
    const exe = String(found.stdout || '').trim();
    if (!exe || !existsSync(exe)) return null;
    // Вторая застава — уже в самой программе: путь обязан вести к браузеру.
    return isBrowserExecutable(exe) ? exe : null;
  } catch {
    // Не вышло спросить — работаем по запомненному и по списку.
    return null;
  }
}

/** Имена процессов браузеров на движке Chromium. */
const BROWSER_PROCESS_NAMES = [
  'msedge.exe', 'chrome.exe', 'chromium.exe', 'brave.exe', 'vivaldi.exe',
  'opera.exe', 'browser.exe', 'yandex.exe',
];

/** Путь ведёт к браузеру, а не к чему угодно, что нашлось по командной строке. */
export function isBrowserExecutable(exe) {
  const name = String(exe || '').split(/[\\/]/).pop().toLowerCase();
  return BROWSER_PROCESS_NAMES.includes(name);
}

/** Запомненный браузер, если он ещё на месте. */
export function rememberedBrowser() {
  try {
    const { exe } = JSON.parse(readFileSync(BROWSER_CHOICE_FILE, 'utf8'));
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/**
 * Порядок перебора браузеров: запомненный — первым.
 *
 * Вынесено отдельной чистой функцией ради теста: порядок здесь и есть всё
 * правило, а проверять его с настоящими браузерами на машине невозможно.
 */
export function browserOrder(remembered, candidates) {
  return [...new Set([remembered, ...candidates].filter(Boolean))];
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
  'Запустите ЗАПУСТИТЬ.cmd ещё раз: он предложит скачать переносной',
  'Chromium в runtime\\browser\\ — программа будет открываться в нём.',
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
export function openUrl(url, { appWindow = true, box = null, maximized = false } = {}) {
  try {
    if (process.platform === 'win32') {
      if (appWindow && openAppWindow(url, { box })) return 'app';
      // Отчёт открывается ТЕМ ЖЕ браузером, в котором живёт окно программы —
      // обычным окном, с адресной строкой и вкладками. Браузер по умолчанию
      // для этого не годится: им может оказаться Internet Explorer, а отчёт
      // в нём не работает.
      if (openWindow(url, { maximized })) return 'app';
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
