/**
 * Выбор стратегии сбора и оркестрация выгрузки конфигурации.
 *
 * Правила выбора драйвера:
 *   • файловая база + ibcmd (8.3.14+)  → ibcmd: быстро, без окон и лицензий;
 *   • серверная база                    → конфигуратор (ibcmd ходит в СУБД напрямую
 *                                         и о кластере не знает);
 *   • ibcmd упал                        → откат на конфигуратор.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import * as ibcmd from './ibcmd.js';
import * as designer from './designer.js';
import { supportsIbcmdExport } from './platform.js';
import { ensureDir, pathExists, rmrf } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';
import { rethrowIfCancelled } from '../util/cancel.js';

const log = createLogger('collector');

/**
 * @typedef {object} CollectContext
 * @property {import('./platform.js').PlatformInstall} platform
 * @property {import('./connection.js').Connection} conn
 * @property {string} workDir
 * @property {string} [user]
 * @property {string} [password]
 * @property {(text: string) => void} [onProgress]
 */

/** Выбранный способ выгрузки — попадает в отчёт как метод обследования. */
export function chooseStrategy({ platform, conn }) {
  if (conn.kind === 'file' && supportsIbcmdExport(platform)) {
    return { driver: 'ibcmd', reason: 'файловая база, доступен ibcmd' };
  }
  if (conn.kind === 'web') {
    return { driver: 'none', reason: 'веб-подключение не поддерживает выгрузку конфигурации' };
  }
  return { driver: 'designer', reason: conn.kind === 'server' ? 'серверная база' : 'ibcmd недоступен' };
}

/**
 * Гарантированно пустой каталог для выгрузки.
 *
 * `ibcmd` отказывается писать в непустой каталог: «Операция невозможна, при
 * выполнении экспорта конфигурации в XML обнаружены ошибки: Каталог … не пуст».
 * Это выстреливает при повторном аудите с тем же «Каталогом для выгрузки»:
 * ibcmd падает, включается запасной конфигуратор — в разы медленнее, а для
 * серверной базы ещё и требует монопольного доступа. Поэтому каталог всегда
 * очищается перед выгрузкой.
 */
async function freshDir(dir) {
  await rmrf(dir).catch(() => {});
  return ensureDir(dir);
}

/**
 * Выгружает основную конфигурацию в XML.
 * @param {CollectContext} ctx
 * @returns {Promise<{dir: string, driver: string}>}
 */
export async function exportConfiguration(ctx) {
  const { platform, conn, workDir, user, password, onProgress } = ctx;
  const outDir = await freshDir(path.join(workDir, 'config'));
  const strategy = chooseStrategy({ platform, conn });

  if (strategy.driver === 'none') {
    throw new Error(
      'Для веб-подключения (http/https) выгрузка конфигурации невозможна. ' +
      'Укажите путь к файловой базе или строку «сервер\\база».',
    );
  }

  if (strategy.driver === 'ibcmd') {
    try {
      await ibcmd.exportConfig({ platform, conn, outDir, user, password, onProgress });
      return { dir: outDir, driver: 'ibcmd' };
    } catch (err) {
      rethrowIfCancelled(err);
      log.warn(`ibcmd не справился (${err.message}), пробуем конфигуратор`);
      onProgress?.(`ibcmd не справился, переключаемся на конфигуратор\n`);
      await fs.rm(outDir, { recursive: true, force: true });
      await ensureDir(outDir);
    }
  }

  await designer.dumpConfigToFiles({
    platform, conn, outDir, user, password,
    logFile: path.join(workDir, 'designer-config.log'),
  });
  return { dir: outDir, driver: 'designer' };
}

/**
 * Выгружает расширения конфигурации.
 * Возвращает список каталогов вида { name, dir }.
 * Отсутствие расширений — штатная ситуация, не ошибка.
 */
export async function exportExtensions(ctx) {
  const { platform, conn, workDir, user, password, onProgress } = ctx;
  const outDir = await freshDir(path.join(workDir, 'extensions'));
  const strategy = chooseStrategy({ platform, conn });

  /** @type {string[]} */
  let names = [];
  if (strategy.driver === 'ibcmd') {
    try {
      names = await ibcmd.listExtensions({ platform, conn, user, password });
    } catch (err) {
      rethrowIfCancelled(err);
      log.warn(`Не удалось получить список расширений: ${err.message}`);
    }
    if (!names.length) return { dir: outDir, extensions: [], names: [] };

    try {
      await ibcmd.exportAllExtensions({ platform, conn, outDir, user, password, onProgress });
      const found = await exportMissingExtensions({
        platform, conn, outDir, user, password, names, onProgress,
      });
      if (found.extensions.length) {
        return { dir: outDir, extensions: found.extensions, names, missing: found.missing };
      }
    } catch (err) {
      rethrowIfCancelled(err);
      log.warn(`ibcmd не выгрузил расширения (${err.message}), пробуем конфигуратор`);
    }
  }

  try {
    await designer.dumpConfigToFiles({
      platform, conn, outDir, allExtensions: true, user, password,
      logFile: path.join(workDir, 'designer-ext.log'),
    });
  } catch (err) {
    rethrowIfCancelled(err);
    // Конфигуратор возвращает ошибку, если расширений нет вовсе — это норма.
    log.info(`Выгрузка расширений конфигуратором: ${err.message}`);
  }
  const extensions = await discoverExtensionDirs(outDir);
  const found = new Set(extensions.map((e) => e.name.toLowerCase()));
  return {
    dir: outDir,
    extensions,
    names: names.length ? names : extensions.map((e) => e.name),
    missing: names.filter((n) => !found.has(String(n).toLowerCase())),
  };
}

/**
 * Досылает расширения, которые пакетная выгрузка потеряла.
 *
 * `ibcmd infobase config export all-extensions` на реальной ERP выгрузил три
 * расширения из четырёх: код возврата 1, ни строки пояснения, четвёртого
 * расширения просто нет в каталоге. Молча потерянное расширение — это молча
 * непроверенная доработка, худший вид ошибки для аудита: в отчёте её нет,
 * и понять, что она пропущена, неоткуда.
 *
 * Поимённый экспорт того же расширения отрабатывает штатно, поэтому
 * недостающие досылаем по одному, каждое в свой подкаталог.
 */
async function exportMissingExtensions({ platform, conn, outDir, user, password, names, onProgress }) {
  let extensions = await discoverExtensionDirs(outDir);
  const have = new Set(extensions.map((e) => e.name.toLowerCase()));
  const missing = names.filter((n) => !have.has(String(n).toLowerCase()));

  for (const name of missing) {
    log.warn(`Расширение «${name}» не попало в пакетную выгрузку — выгружаем отдельно`);
    onProgress?.(`Расширение ${name}: отдельная выгрузка`);
    try {
      await ibcmd.exportExtension({
        platform, conn, name, outDir: path.join(outDir, name), user, password, onProgress,
      });
    } catch (err) {
      rethrowIfCancelled(err);
      log.warn(`Расширение «${name}» выгрузить не удалось: ${err.message}`);
    }
  }

  if (missing.length) extensions = await discoverExtensionDirs(outDir);
  const found = new Set(extensions.map((e) => e.name.toLowerCase()));
  return {
    extensions,
    missing: names.filter((n) => !found.has(String(n).toLowerCase())),
  };
}

/**
 * Ищет выгруженные расширения: каждый подкаталог с Configuration.xml — расширение.
 * Учитывает оба варианта раскладки (ibcmd и конфигуратор кладут по-разному).
 */
async function discoverExtensionDirs(root) {
  if (!(await pathExists(root))) return [];
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (await pathExists(path.join(dir, 'Configuration.xml'))) {
      result.push({ name: entry.name, dir });
      continue;
    }
    // Некоторые версии вкладывают ещё один уровень: <root>/<Ext>/<Ext>/Configuration.xml
    let inner;
    try {
      inner = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of inner) {
      if (!sub.isDirectory()) continue;
      const subDir = path.join(dir, sub.name);
      if (await pathExists(path.join(subDir, 'Configuration.xml'))) {
        result.push({ name: entry.name, dir: subDir });
        break;
      }
    }
  }
  return result;
}

/** Дополнительные факты о базе, доступные без обращения к данным. */
export async function collectInfobaseFacts(ctx) {
  const { platform, conn, user, password } = ctx;
  const facts = { kind: conn.kind, display: conn.display };

  if (conn.kind === 'file') {
    try {
      const dbFile = path.join(conn.dbPath, '1Cv8.1CD');
      if (await pathExists(dbFile)) {
        const stat = await fs.stat(dbFile);
        facts.databaseFileBytes = stat.size;
        facts.databaseFileModified = stat.mtime.toISOString();
      }
    } catch {
      /* размер не критичен */
    }
    if (supportsIbcmdExport(platform)) {
      try {
        facts.generationId = await ibcmd.generationId({ platform, conn, user, password });
      } catch (err) {
        rethrowIfCancelled(err);
        /* необязательный факт */
      }
    }
  }
  return facts;
}
