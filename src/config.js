/**
 * Глобальная конфигурация приложения.
 *
 * Все пути вычисляются относительно корня проекта, чтобы приложение можно было
 * перенести на другую машину простым копированием каталога (требование
 * "работает без установки дополнительного ПО").
 */

import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const SRC_DIR = path.dirname(__filename);
export const ROOT_DIR = path.resolve(SRC_DIR, '..');

/**
 * Версия берётся из package.json — единственного места, где она хранится.
 * Её поднимает `node tools/bumpVersion.mjs` перед каждым коммитом, и дублировать
 * номер в коде нельзя: разъедется молча, а показывается он пользователю.
 */
function readVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Шаблон регламента разработки: обезличенный образец, который пользователь
 * сохраняет из формы проверки качества и правит под свой проект.
 */
export const POLICY_TEMPLATE = path.join(SRC_DIR, 'policy', 'template', 'Регламент разработки (шаблон).md');

/** Каталог со статикой веб-интерфейса. */
export const WEB_DIR = path.join(ROOT_DIR, 'web');

/** Рабочий каталог: результаты аудитов, выгрузки конфигураций, логи. */
export const DATA_DIR = process.env.ONEC_AUDIT_DATA
  ? path.resolve(process.env.ONEC_AUDIT_DATA)
  : path.join(ROOT_DIR, 'data');

export const AUDITS_DIR = path.join(DATA_DIR, 'audits');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

/**
 * Каталог для временных выгрузок конфигурации.
 * По умолчанию — внутри data/, но пользователь может задать свой на форме.
 */
export const DEFAULT_WORK_DIR = path.join(DATA_DIR, 'work');

export const SERVER = {
  host: process.env.ONEC_AUDIT_HOST || '127.0.0.1',
  /** 0 — занять свободный порт автоматически. */
  port: Number(process.env.ONEC_AUDIT_PORT || 7345),
  /** Открывать ли браузер при старте. */
  openBrowser: process.env.ONEC_AUDIT_NO_BROWSER !== '1',
  /**
   * Открывать интерфейс отдельным окном без адресной строки (Edge/Chrome --app).
   * Внешне это обычное настольное приложение. ONEC_AUDIT_NO_APP_WINDOW=1 —
   * открывать обычной вкладкой браузера.
   */
  appWindow: process.env.ONEC_AUDIT_NO_APP_WINDOW !== '1',
};

/** Стандартные каталоги установки платформы 1С:Предприятие. */
export const PLATFORM_SEARCH_PATHS = [
  'C:\\Program Files\\1cv8',
  'C:\\Program Files (x86)\\1cv8',
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, '1cv8') : null,
  process.env['ProgramFiles(x86)']
    ? path.join(process.env['ProgramFiles(x86)'], '1cv8')
    : null,
  '/opt/1cv8/x86_64',
  '/opt/1C/v8.3/x86_64',
].filter(Boolean);

/** Таймауты внешних процессов (мс). */
export const TIMEOUTS = {
  /** Выгрузка конфигурации в XML — самая долгая операция. */
  configExport: Number(process.env.ONEC_AUDIT_TIMEOUT_EXPORT || 60 * 60 * 1000),
  /** Быстрые служебные команды ibcmd. */
  quick: 3 * 60 * 1000,
  /** Сбор живых данных через COM. */
  liveData: 30 * 60 * 1000,
  /** Запрос к LLM. */
  ai: 5 * 60 * 1000,
};

/**
 * Настройки AI-модуля.
 *
 * Ключ читается из переменной окружения либо из data/settings.json.
 * Если ключа нет — продукт работает полностью автономно на детерминированном
 * движке рекомендаций (см. src/ai/advisor.js).
 */
export const AI = {
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  model: process.env.ONEC_AUDIT_AI_MODEL || 'claude-sonnet-5',
  maxTokens: 8000,
};

/** Ограничения анализатора, защищают от зависания на гигантских базах. */
export const LIMITS = {
  /** Максимальный размер модуля для построчного анализа (символов). */
  maxModuleChars: 4 * 1024 * 1024,
  /** Максимальное число находок одного правила (защита от «стены» однотипных). */
  maxFindingsPerRule: 400,
  /** Сколько объектов метаданных считать в одном пакетном запросе COUNT(*). */
  countBatchSize: 40,
  /** Порог «большой процедуры», строк. */
  bigProcedureLines: 120,
  /** Порог «очень большого модуля», строк. */
  bigModuleLines: 3000,
};

export const APP = {
  name: '1С: AI инструменты',
  version: readVersion(),
  vendor: 'Павел Плаксин, Первый БИТ (офис м. Павелецкая)',
  engine: 'локальный движок',
  tmpDir: path.join(os.tmpdir(), 'onec-audit'),
};
