#!/usr/bin/env node
/**
 * Точка входа приложения.
 *
 * Поднимает локальный HTTP-сервер и открывает браузер. Никаких внешних
 * зависимостей и установки: достаточно Node.js, который поставляется вместе
 * с дистрибутивом приложения.
 *
 * Адрес приложения постоянный (по умолчанию http://127.0.0.1:7345). Если порт
 * уже занят нашим же экземпляром — второй сервер не поднимается: открывается
 * браузер на работающем. Ключ --restart просит работающий экземпляр
 * освободиться и занимает тот же адрес — так обновлённая версия оказывается
 * по прежней ссылке, а не по новой.
 */

import { createServer } from './server/http.js';
import { buildRouter } from './server/routes.js';
import { SERVER, DATA_DIR, AUDITS_DIR, LOG_DIR, DEFAULT_WORK_DIR, APP } from './config.js';
import { ensureDir } from './util/fsx.js';
import { discoverPlatforms } from './onec/platform.js';
import { createLogger } from './util/logger.js';
import { openUrl, NO_BROWSER_HINT } from './util/browser.js';
import os from 'node:os';

const log = createLogger('main');

const args = process.argv.slice(2);
const FORCE_RESTART = args.includes('--restart') || process.env.ONEC_AUDIT_RESTART === '1';

async function main() {
  // Рабочий каталог процесса уводим из каталога приложения.
  //
  // Пусковой .cmd делает `cd` в свою папку, и она становится текущей для
  // сервера. Windows не даёт удалить каталог, который у кого-то текущий:
  // пользователь закрывал браузер, пробовал удалить AI-audit-1C и получал
  // «папка открыта в другой программе». Все пути в приложении абсолютные
  // (считаются от `import.meta.url`), поэтому смена каталога ни на что
  // не влияет — а папка перестаёт держаться процессом.
  try {
    process.chdir(os.tmpdir());
  } catch {
    // Не критично: просто останется прежнее поведение.
  }

  await Promise.all([
    ensureDir(DATA_DIR),
    ensureDir(AUDITS_DIR),
    ensureDir(LOG_DIR),
    ensureDir(DEFAULT_WORK_DIR),
  ]);

  const url = `http://${SERVER.host}:${SERVER.port}`;

  // Порт занят нами же — либо освобождаем его, либо просто открываем браузер.
  if (await isOurInstance(url)) {
    if (FORCE_RESTART) {
      console.log(`\n  Останавливаем работающий экземпляр на ${url}…`);
      await requestShutdown(url);
      await waitForPortRelease(url);
    } else {
      console.log('');
      console.log(`  ${APP.name} уже запущен: ${url}`);
      console.log('  Открываем интерфейс в браузере. Второй сервер не нужен.');
      console.log('  Чтобы перезапустить с обновлённой версией: node src/main.js --restart');
      console.log('');
      if (SERVER.openBrowser) openBrowser(url);
      return;
    }
  }

  const server = createServer(buildRouter());

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  Порт ${SERVER.port} занят другой программой.\n` +
        '  Освободите его либо задайте другой: set ONEC_AUDIT_PORT=7346\n',
      );
      process.exit(1);
    }
    log.error(`Ошибка сервера: ${err.message}`);
    process.exit(1);
  });

  server.listen(SERVER.port, SERVER.host, () => {
    // Интерфейс открываем ПЕРВЫМ делом, до всякой другой работы.
    //
    // Раньше здесь сначала выполнялся `await discoverPlatforms()` — поиск
    // установленных версий 1С, а он ходит по диску. Пусковое окно закрывается,
    // как только сервер ответит на /api/health, то есть сразу после `listen`.
    // На новой машине и после перезагрузки, когда кэш файловой системы пуст,
    // опрос платформ занимает секунды: окно консоли уже закрылось, а окна
    // приложения ещё нет — пользователь видит «мигнуло и ничего не запустилось».
    // Повторный запуск срабатывал именно поэтому: сервер к тому моменту уже
    // работал, и второй экземпляр просто открывал браузер.
    //
    // К показу интерфейса опрос платформ отношения не имеет: список версий
    // нужен форме, и она запрашивает его сама через /api/environment.
    if (SERVER.openBrowser) openBrowser(url);

    printBanner(url).catch((err) => {
      // Баннер — вспомогательный вывод. Его сбой не должен ронять приложение:
      // необработанное отклонение в колбэке listen завершало процесс целиком.
      log.warn(`Не удалось вывести сведения о запуске: ${err.message}`);
    });
  });

  const shutdown = () => {
    console.log('\n  Остановка сервера…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Сведения о запуске в консоль. Вызывается после того, как интерфейс уже
 * открыт: опрос установленных платформ 1С ходит по диску и на холодной машине
 * занимает секунды, а задерживать из-за этого показ окна нельзя.
 */
async function printBanner(url) {
  const platforms = await discoverPlatforms();

  console.log('');
  console.log(`  ${APP.name} v${APP.version}`);
  console.log(`  ${'─'.repeat(52)}`);
  const remote = networkUrls();
  console.log(`  Интерфейс:        ${remote.length ? localUrl() : url}`);
  for (const address of remote) {
    console.log(`  С другого ПК:     ${address}`);
  }
  console.log(`  Данные:           ${DATA_DIR}`);
  if (platforms.length) {
    console.log(`  Платформа 1С:     ${platforms.map((p) => p.version).join(', ')}`);
  } else {
    console.log('  Платформа 1С:     НЕ НАЙДЕНА — аудит будет недоступен');
  }
  console.log(`  ${'─'.repeat(52)}`);
  if (remote.length) {
    // Слушать сеть мало: на сервере входящие обычно закрыты брандмауэром,
    // и с рабочей станции адрес просто не откроется. Правило добавляет
    // администратор — программа не имеет на это прав и лезть туда не должна,
    // но команду обязана назвать: иначе «не открывается» выглядит как её сбой.
    console.log('  Если с другого ПК адрес не открывается, порт закрыт');
    console.log('  брандмауэром. Открыть — в командной строке администратора:');
    console.log('');
    console.log(`  netsh advfirewall firewall add rule name="1C AI instrumenty" ^`);
    console.log(`      dir=in action=allow protocol=TCP localport=${SERVER.port}`);
    console.log('');
    console.log(`  ${'─'.repeat(52)}`);
  }
  console.log('  Для остановки нажмите Ctrl+C');
  console.log('');
}

/** Адрес для браузера на этой же машине — даже когда слушаем всю сеть. */
function localUrl() {
  return `http://127.0.0.1:${SERVER.port}`;
}

/**
 * Адреса, по которым программа доступна с других компьютеров.
 *
 * Пусто, пока сервер слушает только 127.0.0.1 — тогда извне к нему не
 * подключиться, и печатать нечего. Сетевой режим включается явно
 * (`ONEC_AUDIT_HOST=0.0.0.0`, файл запуска `ЗАПУСТИТЬ-ПО-СЕТИ.cmd`): он нужен
 * там, где на сервере только Internet Explorer, а работать надо в нормальном
 * браузере с рабочей станции.
 */
function networkUrls() {
  if (SERVER.host !== '0.0.0.0' && SERVER.host !== '::') return [];
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      urls.push(`http://${iface.address}:${SERVER.port}`);
    }
  }
  return urls;
}

/** Отвечает ли по адресу наше приложение (а не что-то постороннее). */
async function isOurInstance(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.app === APP.name;
  } catch {
    return false;
  }
}

async function requestShutdown(url) {
  try {
    await fetch(`${url}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Onec-Audit-Control': '1' },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Экземпляр мог завершиться, не успев ответить, — это нормально.
  }
}

/** Ждёт, пока прежний экземпляр отпустит порт. */
async function waitForPortRelease(url, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    if (!(await isOurInstance(url))) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Открывает интерфейс приложения.
 *
 * Сначала режим отдельного окна (--app=): Edge и Chrome открывают страницу
 * без адресной строки, вкладок и закладок — внешне это обычное настольное
 * приложение. Ни того, ни другого устанавливать не нужно: Edge есть в любой
 * Windows. Если не вышло — открывается браузер по умолчанию.
 * Сама механика и её ловушки — в `util/browser.js`.
 */
function openBrowser(url) {
  const opened = openUrl(url, { appWindow: SERVER.appWindow });
  // Подходящего браузера на машине нет: страница, скорее всего, открылась
  // в Internet Explorer и там не работает. Молчать об этом нельзя — именно
  // так пользователь и получил «страшное оформление» на сервере заказчика
  // (13.08.2026). То же самое напишет и сама страница.
  if (opened === 'none') {
    console.log('');
    console.log(`  ${NO_BROWSER_HINT.split('\n').join('\n  ')}`);
    console.log(`  Адрес программы: ${url}`);
    console.log('');
    log.warn('Не найден браузер на движке Chromium: интерфейс может не открыться');
  }
}

main().catch((err) => {
  console.error(`Не удалось запустить приложение: ${err.message}`);
  process.exit(1);
});
