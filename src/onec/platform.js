/**
 * Обнаружение установленных версий платформы 1С:Предприятие.
 *
 * Версия ищется в стандартных каталогах установки. Пользователь указывает
 * версию строкой вида "8.3.27.1989"; если точного совпадения нет, выбирается
 * ближайшая совместимая (тот же 8.3.x с максимальным номером сборки),
 * потому что для выгрузки конфигурации в XML это допустимо и избавляет
 * пользователя от необходимости знать точный номер сборки.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { PLATFORM_SEARCH_PATHS } from '../config.js';
import { pathExists } from '../util/fsx.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('platform');

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

/**
 * @typedef {object} PlatformInstall
 * @property {string} version полная версия, например 8.3.27.1989
 * @property {number[]} parts числовое представление версии
 * @property {string} binDir каталог bin
 * @property {string} client путь к 1cv8 (толстый клиент/конфигуратор)
 * @property {string|null} ibcmd путь к ibcmd, если есть (8.3.14+)
 * @property {boolean} hasComConnector найден ли comcntr.dll
 */

/** Возвращает все найденные установки платформы, новые — первыми. */
export async function discoverPlatforms() {
  /** @type {PlatformInstall[]} */
  const found = [];
  // Каталоги поиска пересекаются (%ProgramFiles% обычно совпадает с C:\Program Files),
  // поэтому один и тот же bin не должен попасть в результат дважды.
  const seenBinDirs = new Set();

  for (const base of PLATFORM_SEARCH_PATHS) {
    if (!(await pathExists(base))) continue;
    let entries;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(entry.name)) continue;
      const binDir = path.join(base, entry.name, 'bin');
      const key = binDir.toLowerCase();
      if (seenBinDirs.has(key)) continue;
      const client = path.join(binDir, `1cv8${EXE}`);
      if (!(await pathExists(client))) continue;
      seenBinDirs.add(key);
      const ibcmd = path.join(binDir, `ibcmd${EXE}`);
      found.push({
        version: entry.name,
        parts: entry.name.split('.').map(Number),
        binDir,
        client,
        ibcmd: (await pathExists(ibcmd)) ? ibcmd : null,
        hasComConnector: await pathExists(path.join(binDir, 'comcntr.dll')),
      });
    }
  }
  found.sort((a, b) => compareVersions(b.parts, a.parts));
  log.info(`Найдено установок платформы: ${found.length}`, found.map((f) => f.version));
  return found;
}

/**
 * Подбирает установку под запрошенную версию.
 *
 * @param {string} requested например "8.3.27.1989"; пустая строка — взять новейшую
 * @returns {Promise<{platform: PlatformInstall, exact: boolean, available: string[]}>}
 */
export async function resolvePlatform(requested) {
  const available = await discoverPlatforms();
  if (!available.length) {
    throw new Error(
      'Не найдено ни одной установленной версии платформы 1С:Предприятие. ' +
      'Проверьте, что платформа установлена в стандартный каталог (C:\\Program Files\\1cv8).',
    );
  }
  const versions = available.map((p) => p.version);

  if (!requested || !requested.trim()) {
    return { platform: available[0], exact: false, available: versions };
  }

  const wanted = requested.trim();
  const exact = available.find((p) => p.version === wanted);
  if (exact) return { platform: exact, exact: true, available: versions };

  // Ближайшая в рамках той же ветки (8.3.27.* → 8.3.27.x, иначе 8.3.*).
  const wantedParts = wanted.split('.').map(Number);
  const sameMinor = available.filter(
    (p) => p.parts[0] === wantedParts[0] && p.parts[1] === wantedParts[1] && p.parts[2] === wantedParts[2],
  );
  if (sameMinor.length) {
    return { platform: sameMinor[0], exact: false, available: versions };
  }
  const sameMajor = available.filter(
    (p) => p.parts[0] === wantedParts[0] && p.parts[1] === wantedParts[1],
  );
  if (sameMajor.length) {
    return { platform: sameMajor[0], exact: false, available: versions };
  }
  return { platform: available[0], exact: false, available: versions };
}

/**
 * ProgID COM-соединителя для версии платформы.
 *
 * 1С регистрирует класс COM-соединителя на ВЕТКУ major.minor, а не на точную
 * сборку: `V83.COMConnector` — общий для всех 8.3.x, `V85.COMConnector` —
 * для 8.5.x (версию 8.4 платформа не выпускала). Экземпляр физически связан
 * с DLL той сборки, что была установлена или отремонтирована ПОСЛЕДНЕЙ:
 * при нескольких сборках 8.3.x на машине (например, 8.3.22, 8.3.24, 8.3.27
 * одновременно) все они борются за одну и ту же запись `V83.COMConnector`,
 * и какую бы версию ни выбрал пользователь на форме, COM всегда достаёт ту,
 * что зарегистрирована сейчас, — не обязательно выбранную.
 *
 * Раньше `collect-live.ps1` использовал ProgID `V83.COMConnector` всегда,
 * независимо от выбранной платформы. На машине с новейшей 8.5.1.1150 это
 * значило, что сбор живых данных МОЛЧА шёл через драйвер 8.3.27.1989 — той
 * версии, что выгружала конфигурацию и сравнивала с поставщиком. Разные
 * версии драйвера для одной базы в одном аудите — источник перемежающихся
 * отказов подключения (TYPE_E_LIBNOTREGISTERED при внутренней маршрутизации
 * версий внутри старого коннектора). Поэтому ProgID теперь вычисляется
 * от фактически выбранной платформы и передаётся мосту явно.
 */
export function comConnectorProgId(version) {
  const parts = String(version || '').split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!major || Number.isNaN(minor)) return 'V83.COMConnector';
  return `V${major}${minor}.COMConnector`;
}

function compareVersions(a, b) {
  for (let i = 0; i < 4; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Поддерживает ли сборка команду `ibcmd infobase config export` (8.3.14+). */
export function supportsIbcmdExport(platform) {
  if (!platform?.ibcmd) return false;
  const [maj, min, rel] = platform.parts;
  if (maj > 8) return true;
  if (maj === 8 && min > 3) return true;
  return maj === 8 && min === 3 && rel >= 14;
}
