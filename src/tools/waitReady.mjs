/**
 * Ожидание готовности приложения — для пускового .cmd.
 *
 * Код возврата 0 означает, что сервер поднялся и отвечает. Пусковой файл
 * вызывает эту команду один раз и закрывает своё окно, как только она вернёт
 * успех: висящая консоль пользователю не нужна.
 *
 * Ожидание живёт здесь, а не в .cmd, потому что цикл на `for /l` крутится без
 * пауз и сжигает все попытки за доли секунды, а вставлять задержки в cmd.exe
 * нечем, кроме грязных приёмов вроде `ping -n`.
 */

import { SERVER, APP } from '../config.js';

const TIMEOUT_MS = Number(process.env.ONEC_AUDIT_WAIT_MS || 60_000);
const INTERVAL_MS = 400;

const url = `http://${SERVER.host}:${SERVER.port}/api/health`;
const deadline = Date.now() + TIMEOUT_MS;

/** Печатаем точки, чтобы пользователь видел: процесс идёт, а не завис. */
let dots = 0;

while (Date.now() < deadline) {
  if (await isReady()) {
    if (dots) process.stdout.write('\n');
    process.exit(0);
  }
  process.stdout.write('.');
  dots += 1;
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

if (dots) process.stdout.write('\n');
process.exit(1);

async function isReady() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.app === APP.name;
  } catch {
    return false;
  }
}
