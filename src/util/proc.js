/**
 * Запуск внешних процессов (ibcmd, 1cv8, powershell) с таймаутом и
 * корректным декодированием вывода.
 *
 * Утилиты 1С под Windows пишут в stdout в кодировке консоли (обычно CP866/CP1251),
 * а ibcmd — в UTF-8. Поэтому вывод собирается в Buffer и декодируется эвристикой
 * из fsx.decodeBuffer().
 */

import { spawn } from 'node:child_process';
import { decodeBuffer } from './fsx.js';
import { createLogger } from './logger.js';
import { currentSignal, CancelledError } from './cancel.js';

const log = createLogger('proc');

export class ProcessError extends Error {
  constructor(message, { code, stdout, stderr, command }) {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.command = command;
  }
}

/**
 * Запускает процесс и дожидается завершения.
 *
 * @param {string} file исполняемый файл
 * @param {string[]} args аргументы (передаются массивом — экранирование не требуется)
 * @param {object} [options]
 * @param {number} [options.timeout] таймаут в мс
 * @param {Record<string,string>} [options.env] дополнительные переменные окружения
 * @param {string} [options.cwd]
 * @param {boolean} [options.allowNonZeroExit] не бросать исключение при ненулевом коде
 * @param {(chunk: string) => void} [options.onStdout] потоковый обработчик вывода
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function run(file, args, options = {}) {
  const {
    timeout = 10 * 60 * 1000,
    env,
    cwd,
    allowNonZeroExit = false,
    onStdout,
  } = options;

  // Сигнал прерывания берётся из области выполнения аудита (util/cancel.js),
  // поэтому промежуточные слои не обязаны его передавать.
  const signal = options.signal ?? currentSignal();

  return new Promise((resolve, reject) => {
    const started = Date.now();
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    log.debug(`exec: ${file} ${args.map(quoteForLog).join(' ')}`);

    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(new ProcessError(`Не удалось запустить процесс: ${err.message}`, {
        code: -1,
        stdout: '',
        stderr: String(err.message),
        command: file,
      }));
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    const onAbort = () => {
      cancelled = true;
      log.debug(`отмена: снимаем процесс ${file} (pid ${child.pid})`);
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const detach = () => signal?.removeEventListener('abort', onAbort);

    child.stdout?.on('data', (chunk) => {
      outChunks.push(chunk);
      if (onStdout) onStdout(decodeBuffer(chunk));
    });
    child.stderr?.on('data', (chunk) => errChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      detach();
      if (cancelled) {
        reject(new CancelledError());
        return;
      }
      reject(new ProcessError(`Ошибка запуска: ${err.message}`, {
        code: -1,
        stdout: decodeBuffer(Buffer.concat(outChunks)),
        stderr: String(err.message),
        command: file,
      }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      detach();
      if (cancelled) {
        reject(new CancelledError());
        return;
      }
      const stdout = decodeBuffer(Buffer.concat(outChunks));
      const stderr = decodeBuffer(Buffer.concat(errChunks));
      const elapsed = Date.now() - started;
      log.debug(`exit code=${code} in ${elapsed}ms`);

      if (timedOut) {
        reject(new ProcessError(
          `Превышен таймаут выполнения (${Math.round(timeout / 1000)} с)`,
          { code: -2, stdout, stderr, command: file },
        ));
        return;
      }
      if (code !== 0 && !allowNonZeroExit) {
        // Утилиты 1С умеют падать молча: ibcmd на неудачной операции пишет
        // только «[INFO] Экспорт...» и уходит с кодом 1. Тогда в сообщение
        // попадает хотя бы последняя строка вывода — иначе диагностировать
        // нечем, а журнал приложения этого не сохраняет.
        const message =
          firstMeaningfulLine(stderr) ||
          firstMeaningfulLine(stdout) ||
          describeSilentFailure(code, stdout, stderr);
        reject(new ProcessError(message, { code, stdout, stderr, command: file }));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * Выполняет PowerShell-скрипт. Используется как мост к COM-соединителю 1С,
 * недоступному из Node напрямую.
 */
export function runPowerShell(scriptPath, args = [], options = {}) {
  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    ...args,
  ];
  return run('powershell.exe', psArgs, options);
}

/**
 * Снимает процесс вместе с потомками.
 *
 * Под Windows `child.kill()` убивает только сам процесс: конфигуратор и
 * powershell порождают дочерние, которые продолжили бы работать и держать базу.
 */
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* процесс уже завершился */
  }
}

/** Процесс упал, не сказав ничего внятного: собираем то, что есть. */
function describeSilentFailure(code, stdout, stderr) {
  const tail = [stdout, stderr]
    .join('\n')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' / ');
  return tail
    ? `процесс завершился с кодом ${code}, не сообщив причины (последний вывод: ${tail})`
    : `процесс завершился с кодом ${code} без какого-либо вывода`;
}

function firstMeaningfulLine(text) {
  if (!text) return '';
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !/^\[INFO]/i.test(s));
  return line ? line.slice(0, 500) : '';
}

function quoteForLog(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}
