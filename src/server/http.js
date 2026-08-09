/**
 * Минималистичный HTTP-слой без внешних зависимостей:
 * маршрутизация, отдача статики, JSON-хелперы, SSE.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { WEB_DIR } from '../config.js';
import { pathExists } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

export class Router {
  constructor() {
    /** @type {{method: string, pattern: RegExp, keys: string[], handler: Function}[]} */
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern: regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

/** Читает и разбирает JSON-тело запроса. Ограничение — 5 МБ. */
export async function readJsonBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Тело запроса слишком велико');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Некорректный JSON в теле запроса');
  }
}

/** Открывает поток Server-Sent Events. */
export function openSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* соединение закрыто */ }
  }, 20000);
  keepAlive.unref?.();

  const send = (data, event) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* клиент отключился */
    }
  };

  const close = () => {
    clearInterval(keepAlive);
    try { res.end(); } catch { /* уже закрыт */ }
  };

  req.on('close', () => clearInterval(keepAlive));
  return { send, close };
}

/** Отдаёт файл из каталога web/. Защищено от выхода за пределы каталога. */
export async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(WEB_DIR)) {
    sendError(res, 403, 'Доступ запрещён');
    return;
  }
  if (!(await pathExists(target))) {
    sendError(res, 404, 'Файл не найден');
    return;
  }
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    sendError(res, 404, 'Файл не найден');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}

/** Создаёт HTTP-сервер поверх роутера. */
export function createServer(router) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Приложение локальное; CORS открыт только для удобства отладки из браузера.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE' });
      res.end();
      return;
    }

    try {
      const route = router.match(req.method, url.pathname);
      if (route) {
        await route.handler(req, res, { params: route.params, query: url.searchParams });
        return;
      }
      if (req.method === 'GET') {
        await serveStatic(res, url.pathname);
        return;
      }
      sendError(res, 404, 'Маршрут не найден');
    } catch (err) {
      log.error(`Необработанная ошибка ${req.method} ${url.pathname}: ${err.message}`, { stack: err.stack });
      if (!res.headersSent) sendError(res, 500, err.message || 'Внутренняя ошибка сервера');
      else try { res.end(); } catch { /* поток уже закрыт */ }
    }
  });
}
