/** Простое структурированное логирование в консоль и в файл. */

import fsSync from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from '../config.js';
import { ensureDirSync } from './fsx.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.ONEC_AUDIT_LOG_LEVEL || 'info'] ?? LEVELS.info;

let stream = null;

function getStream() {
  if (stream) return stream;
  try {
    ensureDirSync(LOG_DIR);
    const file = path.join(LOG_DIR, `audit-${new Date().toISOString().slice(0, 10)}.log`);
    stream = fsSync.createWriteStream(file, { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

function write(level, scope, message, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${message}`;
  const suffix = extra === undefined ? '' : ` ${safeJson(extra)}`;

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(line + suffix);

  const s = getStream();
  if (s) s.write(line + suffix + '\n');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Создаёт логгер с фиксированным префиксом-областью. */
export function createLogger(scope) {
  return {
    debug: (msg, extra) => write('debug', scope, msg, extra),
    info: (msg, extra) => write('info', scope, msg, extra),
    warn: (msg, extra) => write('warn', scope, msg, extra),
    error: (msg, extra) => write('error', scope, msg, extra),
  };
}

export default createLogger('app');
