/**
 * Прерывание длительных операций.
 *
 * Прервать аудит означает остановить не только цикл в Node, но и запущенные
 * внешние процессы: выгрузка конфигурации ibcmd на ERP идёт минутами, а сбор
 * данных через COM — десятками минут. Протаскивать AbortSignal параметром через
 * все слои (collector → ibcmd → proc) потребовало бы менять сигнатуры десятка
 * функций, поэтому используется AsyncLocalStorage: конвейер выполняется внутри
 * области, а util/proc.js достаёт сигнал из текущего контекста сам.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const CANCEL_MESSAGE = 'Аудит прерван пользователем';

export class CancelledError extends Error {
  constructor(message = CANCEL_MESSAGE) {
    super(message);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

/** Отличает штатное прерывание от настоящей ошибки. */
export function isCancelled(err) {
  return Boolean(err && (err.cancelled === true || err.name === 'CancelledError'));
}

const storage = new AsyncLocalStorage();

/**
 * Выполняет функцию в области, привязанной к сигналу прерывания.
 * @template T
 * @param {AbortSignal|null} signal
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runCancellable(signal, fn) {
  if (!signal) return fn();
  return storage.run({ signal }, fn);
}

/** Сигнал текущей области либо null, если вызов вне аудита. */
export function currentSignal() {
  return storage.getStore()?.signal || null;
}

/** Прерывает выполнение, если пользователь нажал «Прервать». */
export function throwIfCancelled() {
  if (currentSignal()?.aborted) throw new CancelledError();
}

/**
 * Пропускает дальше ошибку прерывания.
 *
 * Конвейер намеренно отказоустойчив: почти каждый шаг обёрнут в catch, который
 * гасит сбой и переходит к запасному способу (не смог ibcmd — работает
 * конфигуратор). Прерывание проходить через такие catch не должно, иначе после
 * нажатия «Прервать» вместо остановки запустится следующий внешний процесс.
 * Вызывать первой строкой в каждом гасящем catch.
 */
export function rethrowIfCancelled(err) {
  if (isCancelled(err)) throw err;
}
