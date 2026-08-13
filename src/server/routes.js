/**
 * HTTP API приложения.
 *
 * Аудит запускается асинхронно: POST /api/audits возвращает идентификатор,
 * а ход выполнения клиент читает через SSE (/api/audits/:id/stream).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Router, sendJson, sendText, sendError, readJsonBody, openSse } from './http.js';
import { createProgress, getProgress, runningProgresses, STAGES, UPDATE_STAGES, QUALITY_STAGES } from './progress.js';
import { runAudit } from '../pipeline/runAudit.js';
import { runUpdate, loadUpdateResult } from '../pipeline/runUpdate.js';
import { runQuality } from '../pipeline/runQuality.js';
import * as store from '../store/auditStore.js';
import * as updateStore from '../store/updateStore.js';
import * as qualityStore from '../store/qualityStore.js';
import { newAuditId } from '../util/id.js';
import { discoverPlatforms } from '../onec/platform.js';
import { parseConnection } from '../onec/connection.js';
import { isAvailable as aiAvailable } from '../ai/client.js';
import { pickPath, dialogsAvailable, FILE_FILTERS, defaultInitialDir } from '../util/dialogs.js';
import { inspectWorkDir, clearWorkDir } from '../util/workDir.js';
import { licenseStatus, activate } from '../util/license.js';
import { renderMarkdown } from '../report/markdownToHtml.js';
import { openUrl } from '../util/browser.js';
import { APP, ROOT_DIR, SERVER } from '../config.js';
import { readText, pathExists } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('routes');

/**
 * Маршруты, доступные без ключа.
 *
 * `/api/health` — по нему запускаемый экземпляр находит уже работающий и не
 * плодит второй сервер. `/api/license` — сама форма ввода. `/api/shutdown` —
 * иначе не введя ключ нельзя было бы завершить работу, а пока процесс жив,
 * Windows не даёт удалить каталог приложения.
 */
const OPEN_PATHS = new Set(['/api/health', '/api/license', '/api/shutdown', '/api/presence']);

/**
 * Сколько окон интерфейса сейчас открыто.
 *
 * Кнопки «Завершить работу» больше нет — пользователь убрал её: закрытие окна
 * должно останавливать программу само. Отследить закрытие можно только со
 * стороны сервера: страница при закрытии успевает не всегда, а `beforeunload`
 * срабатывает и на обновлении страницы. Поэтому окно держит открытым поток
 * `/api/presence`, и обрыв этого потока — сигнал «окно закрыли».
 *
 * Перезагрузка страницы (F5) тоже рвёт поток, поэтому выход не мгновенный:
 * ждём `GRACE_MS`, и если за это время никто не подключился — завершаемся
 * вместе со всеми запущенными процессами (их снимает обработчик `exit`).
 *
 * Сторож взводится только после первого подключения: при запуске с
 * ONEC_AUDIT_NO_BROWSER=1 окна нет вовсе, и сервер не должен из-за этого
 * выключаться.
 */
const GRACE_MS = Number(process.env.ONEC_AUDIT_PRESENCE_GRACE_MS || 8000);
const presence = { clients: 0, seen: false, timer: null };

function clientAttached() {
  presence.clients += 1;
  presence.seen = true;
  if (presence.timer) {
    clearTimeout(presence.timer);
    presence.timer = null;
  }
  log.info(`Окно интерфейса подключилось (открытых окон: ${presence.clients})`);
}

function clientDetached() {
  presence.clients = Math.max(0, presence.clients - 1);
  // Считаем открытые окна вслух. Иначе на вопрос «почему программа
  // не завершилась, я же закрыл окно» ответить нечем: держать её может
  // ЛЮБАЯ вкладка с этим адресом — забытая в другом окне браузера, во второй
  // рабочей области, в предпросмотре редактора. Сервер их не различает
  // и различать не должен, но в журнале должно быть видно, что окно не одно.
  log.info(`Окно интерфейса отключилось (осталось открытых: ${presence.clients})`);
  if (presence.clients > 0 || !presence.seen) return;
  if (presence.timer) clearTimeout(presence.timer);

  // Пока идёт аудит, отсрочка длиннее. Обрыв потока — не всегда закрытое окно:
  // браузер может выгрузить неактивную вкладку из памяти, и тогда соединение
  // пропадает, хотя окно у пользователя открыто. Восемь секунд хватает на
  // перезагрузку страницы, но не на такой случай, а оборвать четырёхминутный
  // аудит по ошибке — потеря куда дороже минуты лишней работы сервера.
  const grace = runningProgresses().length ? GRACE_MS * 8 : GRACE_MS;

  presence.timer = setTimeout(() => {
    if (presence.clients > 0) return;
    log.info('Окно приложения закрыто — останавливаем работу');
    stopEverything();
  }, grace);
  presence.timer.unref?.();
}

/**
 * Полная остановка: сначала прерываем аудиты, потом выходим.
 *
 * Выйти сразу нельзя: внешние процессы платформы (`ibcmd`, конфигуратор,
 * powershell) переживают родителя и продолжают держать базу. Прерывание
 * снимает их вместе с потомками (`util/proc.js`), поэтому даём ему секунду —
 * ровно столько, сколько на практике занимает снятие `ibcmd`.
 */
export function stopEverything(delayMs = 1000) {
  const running = runningProgresses();
  for (const progress of running) {
    try {
      progress.requestCancel();
    } catch {
      // Прогресс мог завершиться между выборкой и вызовом.
    }
  }
  const wait = running.length ? delayMs : 200;
  setTimeout(() => process.exit(0), wait).unref?.();
}

/**
 * Ключ проверяется НА СЕРВЕРЕ, а не в интерфейсе: иначе достаточно было бы
 * обратиться к API напрямую, минуя форму.
 *
 * Проверка вешается одной точкой — подменой `match`, а не обёрткой вокруг
 * каждого обработчика. Так её нельзя забыть у нового маршрута: чтобы маршрут
 * стал открытым, его надо назвать в `OPEN_PATHS` явно.
 *
 * Статика под проверку не попадает — она отдаётся мимо роутера. Иначе форму
 * ввода ключа неоткуда было бы загрузить.
 */
function guardRouter(router) {
  const match = router.match.bind(router);
  router.match = (method, pathname) => {
    const found = match(method, pathname);
    if (!found || OPEN_PATHS.has(pathname)) return found;
    return {
      ...found,
      handler: async (req, res, ctx) => {
        if (!(await licenseStatus()).active) {
          sendError(res, 403, 'Требуется лицензионный ключ', { licenseRequired: true });
          return undefined;
        }
        return found.handler(req, res, ctx);
      },
    };
  };
  return router;
}

/**
 * Сидит ли пользователь за этой же машиной.
 *
 * От этого зависит, кто открывает отчёт. Пока программа работает на компьютере
 * пользователя, окно открывает сервер — иначе браузер счёл бы его всплывающим
 * и заблокировал. Но в сетевом режиме (`ЗАПУСТИТЬ-ПО-СЕТИ.cmd`) программа
 * работает на сервере, а человек сидит за другим компьютером: открывать окно
 * НА СЕРВЕРЕ там бессмысленно вдвойне — пользователь его не увидит, а на
 * сервере может не быть браузера, способного показать отчёт.
 */
export function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Открывает отчёт тем способом, который годится в текущем режиме работы.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} relative адрес отчёта относительно корня приложения
 * @returns {{ok: boolean, remote?: boolean, url?: string}} `remote` — сервер
 *   окно не открывал, это должна сделать сама страница по щелчку пользователя.
 */
function openReportFor(req, relative) {
  if (!isLocalRequest(req)) return { ok: false, remote: true, url: relative };
  openUrl(`http://${SERVER.host === '0.0.0.0' ? '127.0.0.1' : SERVER.host}:${SERVER.port}/${relative}`, {
    appWindow: false,
    maximized: true,
  });
  return { ok: true };
}

export function buildRouter() {
  const router = new Router();

  // --- Служебное ---

  router.get('/api/health', (req, res) => {
    sendJson(res, 200, { ok: true, app: APP.name, version: APP.version });
  });

  /**
   * Признак того, что окно интерфейса открыто.
   *
   * Поток держится всё время, пока страница жива; его обрыв означает, что окно
   * закрыли, и программа останавливается сама — отдельной кнопки выхода больше
   * нет. Данные по потоку не идут: важен сам факт соединения.
   */
  router.get('/api/presence', (req, res) => {
    const sse = openSse(req, res);
    clientAttached();
    sse.send({ ok: true }, 'hello');
    req.on('close', () => clientDetached());
  });

  // --- Лицензионный ключ ---

  router.get('/api/license', async (req, res) => {
    sendJson(res, 200, await licenseStatus());
  });

  router.post('/api/license', async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }
    const result = await activate(body.key);
    if (!result.ok) {
      sendError(res, 403, result.reason);
      return;
    }
    sendJson(res, 200, { ok: true, active: true, expiresAt: result.expiresAt });
  });

  /** Сведения об окружении: версии платформы, доступность AI. */
  router.get('/api/environment', async (req, res) => {
    const platforms = await discoverPlatforms();
    sendJson(res, 200, {
      app: APP.name,
      version: APP.version,
      platforms: platforms.map((p) => ({
        version: p.version,
        hasIbcmd: Boolean(p.ibcmd),
        hasComConnector: p.hasComConnector,
      })),
      recommendedPlatform: platforms[0]?.version || null,
      aiConfigured: await aiAvailable(),
      stages: STAGES,
      // Второй конвейер — обновление нетиповой конфигурации. Состав этапов
      // приходит отсюда же: интерфейс рисует шкалу до запуска, чтобы было
      // видно, из чего работа состоит.
      updateStages: UPDATE_STAGES,
      qualityStages: QUALITY_STAGES,
      isWindows: process.platform === 'win32',
      canPickPaths: dialogsAvailable(),
    });
  });

  /**
   * Системный диалог выбора файла или каталога.
   * Браузер не может отдать форме полный путь, а сервер работает на той же
   * машине — поэтому диалог показывает он.
   */
  router.post('/api/pick', async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    const mode = body.mode === 'file' ? 'file' : 'folder';
    try {
      const picked = await pickPath({
        mode,
        title: String(body.title || '').slice(0, 200),
        filter: FILE_FILTERS[body.filter] || (mode === 'file' ? FILE_FILTERS.any : ''),
        initial: defaultInitialDir(body.initial),
      });
      sendJson(res, 200, { path: picked, cancelled: picked === '' });
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  /**
   * README — для раздела «О программе».
   *
   * Отдаётся уже разметкой: разбирать Markdown в браузере нечем, а тянуть ради
   * этого библиотеку нельзя — у продукта ноль зависимостей. Тот же
   * преобразователь используется в отчёте.
   */
  router.get('/api/about', async (req, res) => {
    const file = path.join(ROOT_DIR, 'README.md');
    if (!(await pathExists(file))) {
      sendError(res, 404, 'Файл README.md не найден рядом с программой');
      return;
    }
    sendJson(res, 200, {
      html: renderMarkdown(await readText(file)),
      version: APP.version,
      vendor: APP.vendor,
    });
  });

  /** Разбор пути к базе — используется формой для подсказки типа базы. */
  router.post('/api/parse-path', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const conn = parseConnection(body.infobasePath);
      sendJson(res, 200, { kind: conn.kind, display: conn.display });
    } catch (err) {
      sendJson(res, 200, { error: err.message });
    }
  });

  // --- Аудиты ---

  router.post('/api/audits', async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    if (!body.infobasePath || !String(body.infobasePath).trim()) {
      sendError(res, 400, 'Не указан путь к информационной базе');
      return;
    }

    // Каталог выгрузки обязателен. Раньше при пустом значении выгрузка уходила
    // во временный каталог, и проверить, убралось ли за аудитом, было негде —
    // а на ERP это семь гигабайт. Пусть пользователь всегда называет место сам.
    if (!body.workDir || !String(body.workDir).trim()) {
      sendError(res, 400, 'Не указан каталог для выгрузки конфигурации');
      return;
    }

    const auditId = newAuditId();
    const input = {
      infobasePath: String(body.infobasePath).trim(),
      platformVersion: String(body.platformVersion || '').trim(),
      vendorConfigPath: String(body.vendorConfigPath || '').trim(),
      workDir: String(body.workDir || '').trim(),
      user: String(body.user || '').trim(),
      password: typeof body.password === 'string' ? body.password : '',
      clientName: String(body.clientName || '').trim(),
      hourlyRate: Number(body.hourlyRate) || 0,
      collectLiveData: body.collectLiveData !== false,
      keepDump: body.keepDump === true,
      // Тема отчёта. По умолчанию тёмная — как окно программы.
      reportTheme: body.reportTheme === 'light' ? 'light' : 'dark',
      // Каталог выгрузки задаётся всегда — см. проверку ниже.
    };

    await store.createAudit(auditId, input);
    const progress = createProgress(auditId);

    // Аудит выполняется в фоне; ошибки уже отражены в progress и meta.
    runAudit({ auditId, input, progress }).catch((err) => {
      log.warn(`Фоновый аудит ${auditId} завершился ошибкой: ${err.message}`);
    });

    sendJson(res, 202, { auditId });
  });

  /** Поток событий выполнения. */
  router.get('/api/audits/:id/stream', (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress) {
      sendError(res, 404, 'Аудит не найден или уже выгружен из памяти');
      return;
    }

    const sse = openSse(req, res);
    sse.send(progress.snapshot(), 'snapshot');

    const onEvent = (event) => {
      sse.send({ ...event, snapshot: progress.snapshot() }, event.type);
      if (event.type === 'finish' || event.type === 'error' || event.type === 'cancelled') {
        setTimeout(() => sse.close(), 250).unref?.();
      }
    };

    progress.on('event', onEvent);
    req.on('close', () => progress.off('event', onEvent));
  });

  /** Прерывание выполняющегося аудита по кнопке «Прервать». */
  router.post('/api/audits/:id/cancel', (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress) {
      sendError(res, 404, 'Аудит не найден: возможно, он уже завершён');
      return;
    }
    if (progress.status !== 'running') {
      sendError(res, 409, 'Аудит уже завершён');
      return;
    }
    progress.requestCancel();
    log.info(`Запрошено прерывание аудита ${params.id}`);
    sendJson(res, 202, { ok: true });
  });

  /**
   * Что лежит в каталоге выгрузки — чтобы предупредить перед очисткой
   * при повторном запуске после прерывания.
   */
  router.post('/api/workdir/inspect', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await inspectWorkDir(body.workDir));
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  /** Очистка каталога выгрузки. Вызывается только после подтверждения на форме. */
  router.post('/api/workdir/clear', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const result = await clearWorkDir(body.workDir);
      log.info(`Каталог выгрузки очищен: ${result.dir} (удалено элементов: ${result.removed})`);
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  /** Текущее состояние (для клиентов без SSE и при перезагрузке страницы). */
  router.get('/api/audits/:id/status', async (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (progress) {
      sendJson(res, 200, progress.snapshot());
      return;
    }
    const meta = await store.getMeta(params.id);
    if (!meta) {
      sendError(res, 404, 'Аудит не найден');
      return;
    }
    sendJson(res, 200, {
      auditId: meta.id,
      status: meta.status,
      error: meta.error,
      durationMs: meta.durationMs ?? null,
      percent: meta.status === 'done' ? 100 : 0,
      stages: [],
      log: [],
      restored: true,
    });
  });

  router.get('/api/audits', async (req, res, { query }) => {
    const limit = Number(query.get('limit')) || 100;
    sendJson(res, 200, { items: await store.listAudits({ limit }) });
  });

  router.get('/api/audits/:id', async (req, res, { params }) => {
    const meta = await store.getMeta(params.id);
    if (!meta) {
      sendError(res, 404, 'Аудит не найден');
      return;
    }
    sendJson(res, 200, meta);
  });

  /** Полный результат анализа в JSON — для интеграций и повторной обработки. */
  router.get('/api/audits/:id/result', async (req, res, { params }) => {
    const result = await store.getResult(params.id);
    if (!result) {
      sendError(res, 404, 'Результат ещё не готов');
      return;
    }
    sendJson(res, 200, result);
  });

  router.get('/api/audits/:id/report.html', async (req, res, { params }) => {
    const html = await store.readReport(params.id, 'html');
    if (!html) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    sendText(res, 200, html, 'text/html; charset=utf-8');
  });

  router.get('/api/audits/:id/report.md', async (req, res, { params }) => {
    const md = await store.readReport(params.id, 'markdown');
    if (!md) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${params.id}.md"`,
    });
    res.end(md);
  });

  /**
   * Открыть готовый отчёт.
   *
   * Делает это сервер, а не страница. `window.open` из обработчика события
   * SSE браузер считает всплывающим окном и блокирует: нажатия кнопки не было,
   * отчёт открывается сам по завершении аудита.
   *
   * В отличие от окна самой программы — не режимом приложения (`--app=`,
   * без адресной строки), а обычной вкладкой браузера по умолчанию,
   * развёрнутой на весь экран: отчёт — документ для чтения и печати,
   * а не рабочий экран программы, и адресная строка (плюс «Печать»,
   * «Найти на странице» из меню браузера) здесь только помогает.
   */
  router.post('/api/audits/:id/open', async (req, res, { params }) => {
    if (!(await store.readReport(params.id, 'html'))) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    sendJson(res, 200, openReportFor(req, `api/audits/${params.id}/report.html`));
  });

  /**
   * Сохранить отчёт куда укажет пользователь.
   *
   * Через `<a download>` браузер положил бы файл в свою папку загрузок
   * с именем вида `report.html`, и выбора места не было бы вовсе. Диалог
   * показывает сервер — он работает на этой же машине, — а имя файла
   * складывается из организации, конфигурации и даты, чтобы десяток отчётов
   * в одной папке различались без открытия.
   */
  router.post('/api/audits/:id/save', async (req, res, { params }) => {
    const html = await store.readReport(params.id, 'html');
    if (!html) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    if (!dialogsAvailable()) {
      sendError(res, 400, 'Диалог сохранения доступен только под Windows');
      return;
    }

    const meta = await store.getMeta(params.id);
    try {
      const target = await pickPath({
        mode: 'save',
        title: 'Куда сохранить отчёт об обследовании',
        filter: FILE_FILTERS.html,
        fileName: reportFileName(meta),
        initial: downloadsDir(),
      });
      if (!target) {
        sendJson(res, 200, { cancelled: true });
        return;
      }
      const file = /\.html?$/i.test(target) ? target : `${target}.html`;
      await fs.writeFile(file, html, 'utf8');
      log.info(`Отчёт ${params.id} сохранён: ${file}`);
      sendJson(res, 200, { cancelled: false, path: file });
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });

  router.delete('/api/audits/:id', async (req, res, { params }) => {
    await store.deleteAudit(params.id);
    sendJson(res, 200, { ok: true });
  });

  // --- Обновление конфигурации ---

  /**
   * Запуск объединения.
   *
   * Отдельный маршрут, а не флаг у аудита: обследование ничего не меняет,
   * а обновление правит файлы выгрузки и по просьбе — конфигурацию базы.
   * Смешивать это в одном маршруте значило бы, что случайный флаг в запросе
   * ведёт к записи в базу.
   */
  router.post('/api/updates', async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    for (const [field, message] of [
      ['infobasePath', 'Не указан путь к информационной базе'],
      ['targetConfigPath', 'Не указана целевая конфигурация (файл .cf новой поставки)'],
      ['workDir', 'Не указан каталог для выгрузки'],
    ]) {
      if (!body[field] || !String(body[field]).trim()) {
        sendError(res, 400, message);
        return;
      }
    }

    const updateId = newAuditId();
    const input = {
      infobasePath: String(body.infobasePath).trim(),
      platformVersion: String(body.platformVersion || '').trim(),
      vendorConfigPath: String(body.vendorConfigPath || '').trim(),
      targetConfigPath: String(body.targetConfigPath).trim(),
      workDir: String(body.workDir).trim(),
      user: String(body.user || '').trim(),
      password: typeof body.password === 'string' ? body.password : '',
      reportTheme: body.reportTheme === 'light' ? 'light' : 'dark',
      // По умолчанию сняты: не сохранять выгрузку и не открывать базу ради формы.
      keepDump: body.keepDump === true,
      openResultsForm: body.openResultsForm === true,
    };

    await updateStore.createRun(updateId, input);
    const progress = createProgress(updateId, UPDATE_STAGES);

    runUpdate({ updateId, input, progress }).catch((err) => {
      log.warn(`Обновление ${updateId} завершилось ошибкой: ${err.message}`);
    });

    sendJson(res, 202, { updateId });
  });

  router.get('/api/updates', async (req, res, { query }) => {
    const limit = Number(query.get('limit')) || 50;
    sendJson(res, 200, { items: await updateStore.listRuns({ limit }) });
  });

  router.get('/api/updates/:id', async (req, res, { params }) => {
    const meta = await updateStore.getMeta(params.id);
    if (!meta) {
      sendError(res, 404, 'Прогон объединения не найден');
      return;
    }
    sendJson(res, 200, meta);
  });

  router.get('/api/updates/:id/stream', (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress) {
      sendError(res, 404, 'Объединение не найдено или уже выгружено из памяти');
      return;
    }

    const sse = openSse(req, res);
    sse.send(progress.snapshot(), 'snapshot');

    const onEvent = (event) => {
      sse.send({ ...event, snapshot: progress.snapshot() }, event.type);
      if (event.type === 'finish' || event.type === 'error' || event.type === 'cancelled') {
        setTimeout(() => sse.close(), 250).unref?.();
      }
    };
    progress.on('event', onEvent);
    req.on('close', () => progress.off('event', onEvent));
  });

  router.post('/api/updates/:id/cancel', (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress) {
      sendError(res, 404, 'Объединение не найдено: возможно, оно уже завершено');
      return;
    }
    if (progress.status !== 'running') {
      sendError(res, 409, 'Объединение уже завершено');
      return;
    }
    progress.requestCancel();
    log.info(`Запрошено прерывание объединения ${params.id}`);
    sendJson(res, 202, { ok: true });
  });

  /**
   * Ответ на вопрос, заданный конвейером.
   *
   * Конвейер обновления доходит до записи в базу и останавливается сам,
   * дожидаясь решения человека. Ответ приходит сюда и разрешает ожидание;
   * пароль передаётся не здесь — он остался в памяти прогона с момента запуска.
   */
  router.post('/api/updates/:id/answer', async (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress || !progress.pending) {
      sendError(res, 404, 'Прогон ничего не спрашивает: возможно, он уже завершён');
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const accepted = progress.answer({ ok: body.ok === true });
    if (!accepted) {
      sendError(res, 409, 'Ответ уже принят');
      return;
    }
    log.info(`Обновление ${params.id}: ответ пользователя — ${body.ok === true ? 'записывать' : 'не записывать'}`);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/updates/:id/result', async (req, res, { params }) => {
    const result = await updateStore.getResult(params.id);
    if (!result) {
      sendError(res, 404, 'Результат ещё не готов');
      return;
    }
    sendJson(res, 200, result);
  });

  router.get('/api/updates/:id/report.html', async (req, res, { params }) => {
    const html = await updateStore.readReport(params.id);
    if (!html) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    sendText(res, 200, html, 'text/html; charset=utf-8');
  });

  router.post('/api/updates/:id/open', async (req, res, { params }) => {
    if (!(await updateStore.readReport(params.id))) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    sendJson(res, 200, openReportFor(req, `api/updates/${params.id}/report.html`));
  });

  /**
   * Загрузка объединённой выгрузки в основную конфигурацию базы.
   *
   * Отдельным действием и после явного подтверждения на форме: между
   * объединением и загрузкой человек правит спорные места в файлах, и это
   * основной порядок работы, а не исключение. Пароль в результате не хранится,
   * поэтому приходит заново.
   */
  router.post('/api/updates/:id/load', async (req, res, { params }) => {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    try {
      const loaded = await loadUpdateResult({
        updateId: params.id,
        user: String(body.user || '').trim(),
        password: typeof body.password === 'string' ? body.password : '',
        // Обновление конфигурации базы данных идёт следом за загрузкой:
        // без него конфигурация базы остаётся прежней, и обновление выглядит
        // выполненным, не будучи им.
        updateDb: body.updateDb !== false,
      });
      sendJson(res, 200, { ok: true, ...loaded });
    } catch (err) {
      log.warn(`Загрузка объединения ${params.id} не удалась: ${err.message}`);
      sendError(res, 400, err.message);
    }
  });

  router.delete('/api/updates/:id', async (req, res, { params }) => {
    await updateStore.deleteRun(params.id);
    sendJson(res, 200, { ok: true });
  });

  // --- Проверка качества кода ---

  /**
   * Запуск проверки качества.
   *
   * Источник — база или хранилище конфигурации, и обязательные поля у них
   * разные: базе нужен путь к базе, хранилищу — каталог хранилищ. Проверяем
   * ровно то, что нужно выбранному источнику, иначе форма требовала бы
   * заполнить лишнее.
   */
  router.post('/api/quality', async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, err.message);
      return;
    }

    const source = body.source === 'repository' ? 'repository' : 'infobase';
    // Хранилище лежит либо каталогом на диске, либо на сервере хранилищ —
    // тогда вместо пути указывается адрес вида tcp://сервер/хранилище.
    const repositoryKind = body.repositoryKind === 'address' ? 'address' : 'path';
    const required = [];
    if (source === 'repository') {
      required.push(repositoryKind === 'address'
        ? ['repositoryAddress', 'Не указан сетевой адрес хранилища конфигурации']
        : ['repositoryPath', 'Не указан каталог с хранилищами конфигурации']);
    } else {
      required.push(['infobasePath', 'Не указан путь к информационной базе']);
    }
    required.push(['workDir', 'Не указан рабочий каталог']);

    for (const [field, message] of required) {
      if (!body[field] || !String(body[field]).trim()) {
        sendError(res, 400, message);
        return;
      }
    }

    const qualityId = newAuditId();
    const input = {
      source,
      infobasePath: String(body.infobasePath || '').trim(),
      repositoryKind,
      repositoryPath: String(body.repositoryPath || '').trim(),
      repositoryAddress: String(body.repositoryAddress || '').trim(),
      repositoryUser: String(body.repositoryUser || '').trim(),
      repositoryPassword: typeof body.repositoryPassword === 'string' ? body.repositoryPassword : '',
      periodFrom: String(body.periodFrom || '').trim(),
      periodTo: String(body.periodTo || '').trim(),
      platformVersion: String(body.platformVersion || '').trim(),
      vendorConfigPath: String(body.vendorConfigPath || '').trim(),
      workDir: String(body.workDir).trim(),
      user: String(body.user || '').trim(),
      password: typeof body.password === 'string' ? body.password : '',
      keepDump: body.keepDump === true,
      reportTheme: body.reportTheme === 'light' ? 'light' : 'dark',
    };

    await qualityStore.createRun(qualityId, input);
    const progress = createProgress(qualityId, QUALITY_STAGES);

    runQuality({ qualityId, input, progress }).catch((err) => {
      log.warn(`Проверка качества ${qualityId} завершилась ошибкой: ${err.message}`);
    });

    sendJson(res, 202, { qualityId });
  });

  router.get('/api/quality', async (req, res, { query }) => {
    const limit = Number(query.get('limit')) || 50;
    sendJson(res, 200, { items: await qualityStore.listRuns({ limit }) });
  });

  router.get('/api/quality/:id', async (req, res, { params }) => {
    const meta = await qualityStore.getMeta(params.id);
    if (!meta) {
      sendError(res, 404, 'Прогон проверки не найден');
      return;
    }
    sendJson(res, 200, meta);
  });

  router.get('/api/quality/:id/stream', (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress) {
      sendError(res, 404, 'Проверка не найдена или уже выгружена из памяти');
      return;
    }
    const sse = openSse(req, res);
    sse.send(progress.snapshot(), 'snapshot');
    const onEvent = (event) => {
      sse.send({ ...event, snapshot: progress.snapshot() }, event.type);
      if (event.type === 'finish' || event.type === 'error' || event.type === 'cancelled') {
        setTimeout(() => sse.close(), 250).unref?.();
      }
    };
    progress.on('event', onEvent);
    req.on('close', () => progress.off('event', onEvent));
  });

  router.post('/api/quality/:id/cancel', (req, res, { params }) => {
    const progress = getProgress(params.id);
    if (!progress || progress.status !== 'running') {
      sendError(res, 404, 'Проверка не найдена: возможно, она уже завершена');
      return;
    }
    progress.requestCancel();
    sendJson(res, 202, { ok: true });
  });

  router.get('/api/quality/:id/report.html', async (req, res, { params }) => {
    const html = await qualityStore.readReport(params.id);
    if (!html) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    sendText(res, 200, html, 'text/html; charset=utf-8');
  });

  router.post('/api/quality/:id/open', async (req, res, { params }) => {
    if (!(await qualityStore.readReport(params.id))) {
      sendError(res, 404, 'Отчёт ещё не сформирован');
      return;
    }
    sendJson(res, 200, openReportFor(req, `api/quality/${params.id}/report.html`));
  });

  router.delete('/api/quality/:id', async (req, res, { params }) => {
    await qualityStore.deleteRun(params.id);
    sendJson(res, 200, { ok: true });
  });

  // --- Управление приложением ---

  /**
   * Остановка сервера. Нужна, чтобы новая версия занимала тот же адрес:
   * `node src/main.js --restart` просит работающий экземпляр освободить порт.
   *
   * Заголовок обязателен намеренно: он вызывает предварительный CORS-запрос,
   * поэтому произвольная веб-страница не сможет остановить приложение.
   */
  router.post('/api/shutdown', (req, res) => {
    if (req.headers['x-onec-audit-control'] !== '1') {
      sendError(res, 403, 'Требуется заголовок X-Onec-Audit-Control');
      return;
    }
    sendJson(res, 200, { ok: true });
    log.info('Получена команда остановки, завершаем работу');
    stopEverything(200);
  });

  return guardRouter(router);
}

/**
 * Имя файла отчёта: «Обследование — Организация — Конфигурация — дата.html».
 *
 * Понятное имя важнее короткого: отчёты складывают в одну папку по нескольким
 * заказчикам, и `report(3).html` там не различить. Запрещённые в именах файлов
 * знаки заменяются, длина ограничена — Windows не примет путь длиннее 255.
 */
export function reportFileName(meta) {
  const summary = meta?.summary || {};
  const parts = ['Обследование'];
  if (meta?.input?.clientName) parts.push(meta.input.clientName);
  if (summary.configName) parts.push(summary.configName);
  if (summary.configVersion) parts.push(summary.configVersion);
  parts.push(dateStamp(meta?.finishedAt || meta?.createdAt));

  const name = parts
    .map((p) => String(p).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' — ');

  return `${name.slice(0, 150)}.html`;
}

function dateStamp(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Куда предложить сохранить: папка «Загрузки», если она есть. */
function downloadsDir() {
  const candidate = path.join(os.homedir(), 'Downloads');
  return defaultInitialDir(candidate);
}
