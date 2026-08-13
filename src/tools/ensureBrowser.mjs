#!/usr/bin/env node
/**
 * Проверка браузера перед запуском программы и, если его нет, установка
 * переносного Chromium рядом с ней.
 *
 * Зачем. Интерфейс — страница в браузере, и браузер ей нужен современный.
 * На терминальных серверах заказчиков сплошь и рядом стоит один Internet
 * Explorer: он не умеет ни модулей ES, ни fetch, ни переменных CSS, и
 * программа в нём выглядит сломанной. Ставить браузер на такой сервер можно
 * не всегда, а работать надо.
 *
 * Отсюда этот шаг: находим Edge или Chrome — молча идём дальше; не находим —
 * объясняем положение, спрашиваем разрешение и кладём переносной Chromium
 * в `runtime\browser\`, откуда программа берёт его сама (`util/browser.js`).
 * Ничего не устанавливается в систему, права администратора не нужны,
 * реестр не трогается: каталог можно просто удалить.
 *
 * ЗАПУСКАЕТСЯ ИЗ ФАЙЛА ЗАПУСКА, А НЕ ИЗ САМОЙ ПРОГРАММЫ. Сервер стартует
 * скрытым окном (`Start-Process -WindowStyle Hidden`) — спросить пользователя
 * оттуда невозможно, ответить ему некуда. Видимое окно ровно одно, пусковое,
 * и вопрос должен звучать в нём.
 *
 * Почему скачивает и распаковывает PowerShell, а не Node. На сервере
 * заказчика выход в интернет почти всегда через прокси, заданный в настройках
 * системы. `fetch` в Node их не читает и упрётся в таймаут, а .NET внутри
 * PowerShell берёт системный прокси сам — вместе с проверкой подлинности
 * текущим пользователем домена. Распаковка тем же `Expand-Archive`, что
 * и в сборке поставки: в проекте ноль внешних зависимостей.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { findAppBrowser, BUNDLED_BROWSER_DIR } from '../util/browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Откуда берём Chromium.
 *
 * Официальные сборки проекта Chromium: `LAST_CHANGE` отдаёт номер последней,
 * по нему собирается ссылка на архив. Это открытый исходный код и свободно
 * распространяемые сборки — в отличие от Google Chrome, чьи условия
 * использования не позволяют класть его в чужой комплект, и от Microsoft
 * Edge, у которого переносной версии не существует вовсе.
 */
const SNAPSHOTS = 'https://storage.googleapis.com/chromium-browser-snapshots/Win_x64';

/** Сколько ждать ответа при скачивании, минут. */
const DOWNLOAD_TIMEOUT_MIN = 30;

async function main() {
  if (process.platform !== 'win32') return;

  // `--force` — скачать Chromium, даже если браузер на машине есть. Нужно,
  // чтобы подготовить поставку ЗАРАНЕЕ: если известно, что у заказчика на
  // сервере один Internet Explorer, браузер кладут в каталог здесь, и там
  // уже ничего не скачивается — интернета на том сервере может не быть вовсе.
  const force = process.argv.includes('--force');

  const found = force ? null : findAppBrowser();
  if (found) {
    console.log(`        Браузер найден: ${short(found)}`);
    return;
  }

  console.log('');
  console.log('  Не найден ни Microsoft Edge, ни Google Chrome.');
  console.log('  Интерфейс программы — страница в браузере, и Internet Explorer');
  console.log('  показать её не может: не поддерживает ни модули JavaScript,');
  console.log('  ни современные стили. Программа запустится, но работать в ней');
  console.log('  будет нельзя.');
  console.log('');
  console.log('  Можно скачать переносной Chromium и положить его рядом');
  console.log('  с программой — в runtime\\browser\\. В систему он');
  console.log('  не устанавливается, права администратора не нужны, реестр');
  console.log('  не трогается: чтобы убрать, достаточно удалить эту папку.');
  console.log('');
  console.log('  Размер загрузки — около 340 МБ, на диске займёт около 800 МБ.');
  console.log('  Источник: официальные сборки проекта Chromium (Google).');
  console.log('');

  if (!(await confirm('  Скачать Chromium сейчас? [д/н]: '))) {
    console.log('');
    console.log('  Хорошо, не скачиваем. Программа запустится, но интерфейс');
    console.log('  откроется в Internet Explorer и работать не будет.');
    console.log('  Скачать можно в любой момент — просто запустите ещё раз.');
    console.log('');
    return;
  }

  try {
    await install();
  } catch (err) {
    console.log('');
    console.log(`  [ОШИБКА] Не удалось установить Chromium: ${err.message}`);
    console.log('');
    console.log('  Скорее всего, закрыт выход в интернет или мешает прокси.');
    console.log('  Тогда скачайте архив на любом другом компьютере:');
    console.log(`    ${SNAPSHOTS}/<номер>/chrome-win.zip`);
    console.log(`    (номер последней сборки — в ${SNAPSHOTS}/LAST_CHANGE)`);
    console.log('  и распакуйте его в папку:');
    console.log(`    ${BUNDLED_BROWSER_DIR}`);
    console.log('  Программа найдёт браузер там сама.');
    console.log('');
  }
}

/** Скачивает и распаковывает Chromium в `runtime\browser\`. */
async function install() {
  await fs.mkdir(BUNDLED_BROWSER_DIR, { recursive: true });

  console.log('');
  console.log('  Узнаём номер последней сборки…');
  const revision = (await powershell(
    `(Invoke-WebRequest -Uri '${SNAPSHOTS}/LAST_CHANGE' -UseBasicParsing).Content.Trim()`,
  )).trim();
  if (!/^\d+$/.test(revision)) {
    throw new Error(`сервер сборок ответил не номером: ${revision.slice(0, 120) || 'пусто'}`);
  }
  console.log(`  Последняя сборка: ${revision}`);

  const zip = path.join(BUNDLED_BROWSER_DIR, 'chrome-win.zip');
  await fs.rm(zip, { force: true });

  console.log('  Скачиваем… (это надолго, окно закрывать нельзя)');
  const url = `${SNAPSHOTS}/${revision}/chrome-win.zip`;
  await withProgress(zip, () => powershell(
    `Invoke-WebRequest -Uri '${url}' -OutFile '${zip}' -UseBasicParsing`,
    DOWNLOAD_TIMEOUT_MIN * 60 * 1000,
  ));

  const { size } = await fs.stat(zip);
  if (size < 50 * 1024 * 1024) {
    throw new Error(`скачано всего ${mb(size)} МБ — это не архив браузера`);
  }
  console.log(`  Скачано: ${mb(size)} МБ. Распаковываем…`);

  await powershell(
    `Expand-Archive -Path '${zip}' -DestinationPath '${BUNDLED_BROWSER_DIR}' -Force`,
    15 * 60 * 1000,
  );
  await fs.rm(zip, { force: true });

  console.log('  Настраиваем права…');
  await grantAppPackageAccess();

  // Проверяем не «команда отработала», а что браузер действительно найден
  // тем же кодом, которым его будет искать программа.
  const browser = findAppBrowser();
  if (!browser) throw new Error('архив распакован, но chrome.exe в нём не найден');

  console.log('');
  console.log(`  Готово: ${short(browser)}`);
  console.log('  Дальше программа будет открываться в нём.');
  console.log('');
}

/**
 * Выдаёт распакованному браузеру права, без которых он не работает.
 *
 * Это не украшение, а обязательный шаг — стоил отдельного разбора 13.08.2026.
 * Chromium запускает вкладки в песочнице, и её процессы обращаются к своему же
 * `chrome.exe` под сильно урезанным токеном. У файлов в `Program Files` нужные
 * для этого разрешения проставлены системой, а у распакованного из архива —
 * нет: наследуются права каталога, где архив развернули. Внешне сбой выглядит
 * ужасно понятно — окно открывается и остаётся пустым, а в журнале
 * «Sandbox cannot access executable … Отказано в доступе».
 *
 * Лечится выдачей чтения и выполнения двум встроенным группам — «все пакеты
 * приложений» и «все ограниченные пакеты приложений». Задаём их SID'ами
 * (`S-1-15-2-1`, `S-1-15-2-2`), а не именами: имена в русской Windows
 * переведены, и по ним `icacls` не находит группу. Права администратора
 * не нужны — каталог только что создан этим же пользователем.
 *
 * Проверено на живом Chromium 153: до выдачи прав — ошибка песочницы
 * и пустое окно, после — ни одной ошибки.
 */
async function grantAppPackageAccess() {
  const rights = '(OI)(CI)(RX)';
  await powershell(
    `icacls '${BUNDLED_BROWSER_DIR}' /grant '*S-1-15-2-1:${rights}' '*S-1-15-2-2:${rights}' /T /Q`,
    10 * 60 * 1000,
  );
}

/**
 * Показывает, сколько уже скачано.
 *
 * `Invoke-WebRequest` своей полосы не рисует (её приходится гасить, иначе
 * на больших файлах она сама по себе тормозит загрузку), а 340 МБ в тишине
 * выглядят как зависшая программа. Поэтому смотрим на размер файла со стороны.
 */
async function withProgress(file, work) {
  let done = false;
  const timer = setInterval(async () => {
    if (done) return;
    try {
      const { size } = await fs.stat(file);
      process.stdout.write(`\r  Скачано: ${mb(size)} МБ   `);
    } catch {
      // Файла ещё нет — соединение устанавливается.
    }
  }, 2000);
  timer.unref?.();

  try {
    await work();
  } finally {
    done = true;
    clearInterval(timer);
    process.stdout.write('\r');
  }
}

/**
 * Выполняет команду PowerShell и возвращает её вывод.
 *
 * Прокси и TLS настраиваются перед каждой командой: на серверах в домене
 * выход в интернет идёт через прокси с проверкой подлинности, а в PowerShell
 * 5.1 по умолчанию может быть выключен TLS 1.2 — без него storage.googleapis.com
 * просто обрывает соединение.
 */
function powershell(command, timeoutMs = 60_000) {
  const prelude = '$ProgressPreference = \'SilentlyContinue\'; '
    + '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; '
    + 'try { [Net.WebRequest]::DefaultWebProxy.Credentials = '
    + '[Net.CredentialCache]::DefaultNetworkCredentials } catch { }; ';

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`превышено время ожидания (${Math.round(timeoutMs / 60000)} мин)`));
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(firstLine(err) || `PowerShell завершился с кодом ${code}`));
    });
  });
}

async function confirm(question) {
  // Согласие можно дать заранее — для установки без участия человека.
  if (process.env.ONEC_AUDIT_FETCH_BROWSER === '1') {
    console.log(`${question}да (ONEC_AUDIT_FETCH_BROWSER=1)`);
    return true;
  }
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'д' || answer === 'да' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function firstLine(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(0);
}

/** Путь покороче: полный не помещается в окно и мешает читать. */
function short(file) {
  return file.startsWith(ROOT) ? path.relative(ROOT, file) : file;
}

main().catch((err) => {
  // Этот шаг не имеет права мешать запуску программы: не вышло — идём дальше.
  console.log(`  Проверка браузера не выполнена: ${err.message}`);
});
