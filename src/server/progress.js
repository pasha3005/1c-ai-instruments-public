/**
 * Хаб прогресса выполнения аудита.
 *
 * Каждый аудит — это последовательность именованных этапов. Клиент подписывается
 * через Server-Sent Events и получает события в реальном времени; при
 * переподключении сразу получает накопленное состояние (см. snapshot()).
 */

import { EventEmitter } from 'node:events';

/** Полный список этапов конвейера — используется UI для отрисовки шкалы. */
export const STAGES = [
  { id: 'prepare', title: 'Подготовка', weight: 3 },
  { id: 'platform', title: 'Поиск платформы 1С', weight: 2 },
  { id: 'connect', title: 'Проверка доступа к базе', weight: 5 },
  { id: 'export-config', title: 'Выгрузка конфигурации', weight: 30 },
  { id: 'export-extensions', title: 'Выгрузка расширений', weight: 10 },
  { id: 'parse-metadata', title: 'Разбор метаданных', weight: 10 },
  { id: 'parse-modules', title: 'Разбор модулей кода', weight: 8 },
  { id: 'live-data', title: 'Сбор данных из базы', weight: 12 },
  { id: 'vendor', title: 'Сравнение с конфигурацией поставщика', weight: 6 },
  { id: 'analyze', title: 'Анализ качества и рисков', weight: 12 },
  { id: 'ai', title: 'AI-рекомендации', weight: 5 },
  { id: 'report', title: 'Формирование отчёта', weight: 3 },
  // Уборка — последний видимый этап, а не молчаливое послесловие. Выгрузка ERP
  // весит гигабайты, и пользователь должен видеть, что каталог освобождается,
  // и знать, что до конца этого шага аудит не завершён.
  { id: 'cleanup', title: 'Очистка каталога выгрузки', weight: 4 },
];

/**
 * Этапы обновления нетиповой конфигурации.
 *
 * **Порядок здесь обязан совпадать с порядком выполнения** в `runUpdate.js`:
 * шкала читается как последовательность, и этап, отработавший раньше стоящего
 * над ним, выглядит сбоем — так и было замечено пользователем. Новая поставка
 * идёт ПЕРЕД текущей не по недосмотру: восстановление текущей поставки из базы
 * заглядывает в новую, чтобы заполнить строки, удалённые интегратором, —
 * их текста отчёт сравнения не печатает (см. `update/vendorSources.js`).
 * Конвейер строго последователен, ничего не выполняется параллельно.
 *
 * Уборка — последний этап, и по умолчанию (флаг «Сохранить выгрузку» снят)
 * убирает только входные выгрузки (текущую и новую поставку, временные файлы
 * проверки расширений). Результат объединения и «Конфликты» удаляются вместе
 * с остальным только если он уже загружен в базу — иначе его правят руками
 * в местах, где решение за человеком, и из него же потом загружают
 * конфигурацию, иногда через день после прогона; удалить его до загрузки
 * значило бы выбросить сделанную работу.
 */
export const UPDATE_STAGES = [
  { id: 'prepare', title: 'Подготовка', weight: 2 },
  { id: 'platform', title: 'Поиск платформы 1С', weight: 2 },
  { id: 'connect', title: 'Проверка доступа к базе', weight: 3 },
  // Пять секунд, которые решают, каким путём идти дальше, — и потому стоят
  // раньше всего дорогого (см. vendorConfigPresence в onec/vendorCompare.js).
  { id: 'detect', title: 'Есть ли в базе доработки', weight: 2 },
  { id: 'export-main', title: 'Выгрузка основной конфигурации', weight: 16 },
  { id: 'vendor-new', title: 'Целевая конфигурация (новая поставка)', weight: 14 },
  // Второе сравнение теми же средствами платформы: конфигурация поставщика
  // из базы против файла новой поставки. Отвечает на вопрос, на который
  // первое сравнение ответить не может, — что поставщик изменил САМ.
  { id: 'vendor-ahead', title: 'Правки поставщика в новом релизе', weight: 8 },
  { id: 'vendor-old', title: 'Конфигурация поставщика (текущая поставка)', weight: 10 },
  { id: 'merge', title: 'Объединение и разбор спорных мест', weight: 18 },
  { id: 'report', title: 'Отчёт об объединении', weight: 3 },
  // Дальше начинается запись в базу, и конвейер здесь останавливается сам:
  // до ответа пользователя ни один файл в базу не уходит.
  { id: 'confirm', title: 'Подтверждение записи в базу', weight: 1 },
  // Два взаимоисключающих способа записать результат. Идёт ровно один,
  // второй помечается пропущенным: у конфигурации «на замке» обновление
  // выполняет сама платформа, доработанную ведём своим объединением.
  { id: 'update-cfg', title: 'Типовое обновление силами платформы', weight: 8 },
  { id: 'load', title: 'Загрузка объединения в конфигурацию базы', weight: 8 },
  { id: 'db-update', title: 'Обновление конфигурации базы данных', weight: 8 },
  { id: 'check', title: 'Проверка модулей и применимость расширений', weight: 7 },
  // Последний шаг: обработчики обновления. Их не выполняет ни /UpdateCfg,
  // ни /UpdateDBCfg — монопольные платформа отрабатывает при первом входе
  // в базу, отложенные запускаются фоновым заданием (см. onec/enterprise.js).
  { id: 'handlers', title: 'Обработчики обновления', weight: 10 },
  { id: 'cleanup', title: 'Очистка каталога выгрузки', weight: 3 },
];

/**
 * Этапы проверки качества кода.
 *
 * Короче обследования намеренно: здесь нужен один ответ — замечания к коду.
 * Ни живых данных, ни ролей, ни оценок трудозатрат. Этап «Источник» один для
 * обоих режимов: это либо проверка пути к базе, либо поиск хранилищ.
 */
export const QUALITY_STAGES = [
  { id: 'prepare', title: 'Подготовка', weight: 2 },
  { id: 'policy', title: 'Регламент разработки', weight: 1 },
  { id: 'platform', title: 'Поиск платформы 1С', weight: 2 },
  { id: 'source', title: 'Источник кода', weight: 4 },
  { id: 'export', title: 'Получение исходников', weight: 34 },
  { id: 'parse', title: 'Разбор метаданных и модулей', weight: 14 },
  { id: 'vendor', title: 'Сравнение с конфигурацией поставщика', weight: 10 },
  { id: 'analyze', title: 'Проверка качества кода', weight: 26 },
  { id: 'report', title: 'Формирование отчёта', weight: 4 },
  { id: 'cleanup', title: 'Очистка каталога выгрузки', weight: 3 },
];

export class AuditProgress extends EventEmitter {
  /** Ожидающий ответа вопрос: разрешается вызовом `answer()`. */
  #answer = null;

  /**
   * @param {string} auditId
   * @param {{id: string, title: string, weight: number}[]} [stages]
   *   Состав этапов. Задаётся снаружи, потому что конвейеров два — обследование
   *   и обновление, — а машинерия прогресса у них одна.
   */
  constructor(auditId, stages = STAGES) {
    super();
    this.auditId = auditId;
    this.stageList = stages;
    this.totalWeight = stages.reduce((sum, s) => sum + s.weight, 0) || 1;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.status = 'running';
    this.error = null;
    /** Прерывание аудита по кнопке «Прервать». */
    this.controller = new AbortController();
    /** Вопрос, на который ждём ответа, — попадает и в снимок состояния. */
    this.pending = null;
    /** @type {Map<string, {id, title, weight, status, detail, startedAt, finishedAt, note}>} */
    this.stages = new Map(
      stages.map((s) => [s.id, { ...s, status: 'pending', detail: '', note: '', startedAt: null, finishedAt: null }]),
    );
    this.log = [];
  }

  /** Отмечает этап начатым. */
  start(stageId, detail = '') {
    const stage = this.stages.get(stageId);
    if (!stage) return;
    stage.status = 'running';
    stage.detail = detail;
    stage.startedAt = Date.now();
    this.#push('stage', { stage: stageId, detail });
  }

  /** Обновляет пояснение внутри текущего этапа (например, «объект 120 из 900»). */
  update(stageId, detail) {
    const stage = this.stages.get(stageId);
    if (!stage) return;
    stage.detail = detail;
    this.#push('stage', { stage: stageId, detail });
  }

  /** Завершает этап. `note` — краткий итог, показывается в UI справа. */
  done(stageId, note = '') {
    const stage = this.stages.get(stageId);
    if (!stage) return;
    stage.status = 'done';
    stage.note = note;
    stage.detail = '';
    stage.finishedAt = Date.now();
    this.#push('stage', { stage: stageId, note });
  }

  /** Этап пропущен (например, сбор живых данных недоступен). */
  skip(stageId, note = '') {
    const stage = this.stages.get(stageId);
    if (!stage) return;
    stage.status = 'skipped';
    stage.note = note;
    stage.detail = '';
    stage.finishedAt = Date.now();
    this.#push('stage', { stage: stageId, note });
  }

  /** Этап завершён с ошибкой, но конвейер продолжает работу. */
  warn(stageId, note = '') {
    const stage = this.stages.get(stageId);
    if (!stage) return;
    stage.status = 'warning';
    stage.note = note;
    stage.detail = '';
    stage.finishedAt = Date.now();
    this.#push('stage', { stage: stageId, note });
  }

  /**
   * Останавливает конвейер и ждёт ответа пользователя.
   *
   * Нужно ровно один раз за весь продукт — перед записью в информационную базу.
   * Флажок на форме таким согласием не считается: между заполнением формы
   * и этим моментом проходят десятки минут, за которые человек успевает уйти,
   * а к решению «писать в базу» он должен вернуться, уже увидев, что
   * получилось при объединении.
   *
   * Ожидание снимается прерыванием: закрытое окно останавливает программу,
   * и висеть в ожидании ответа, которого некому дать, конвейеру незачем.
   *
   * @param {string} stageId этап, на котором стоим
   * @param {object} question что показать пользователю
   * @returns {Promise<object>} ответ: `{ ok: boolean, ...}`
   */
  ask(stageId, question) {
    const stage = this.stages.get(stageId);
    if (stage) {
      stage.status = 'waiting';
      stage.detail = question?.title || 'Ожидается ответ';
      stage.startedAt = stage.startedAt || Date.now();
    }
    this.pending = { stage: stageId, question, askedAt: Date.now() };
    this.#push('ask', { stage: stageId, question });

    return new Promise((resolve, reject) => {
      const finish = (value) => {
        this.pending = null;
        this.controller.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => {
        this.pending = null;
        reject(new Error('Прервано пользователем'));
      };
      this.#answer = finish;
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (this.controller.signal.aborted) onAbort();
    });
  }

  /** Ответ пользователя на заданный вопрос. */
  answer(value) {
    if (!this.pending || !this.#answer) return false;
    const resolve = this.#answer;
    this.#answer = null;
    const stage = this.stages.get(this.pending.stage);
    if (stage) stage.detail = '';
    this.#push('answered', { stage: this.pending.stage });
    resolve(value);
    return true;
  }

  /** Сообщение в текстовый журнал выполнения. */
  message(text, level = 'info') {
    this.log.push({ ts: Date.now(), level, text });
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
    this.#push('log', { level, text });
  }

  /** Сигнал прерывания для конвейера и внешних процессов. */
  get signal() {
    return this.controller.signal;
  }

  /**
   * Просьба прервать аудит. Сам конвейер завершится чуть позже — когда снятый
   * внешний процесс отдаст управление; тогда будет вызван cancelled().
   */
  requestCancel() {
    if (this.status !== 'running' || this.controller.signal.aborted) return false;
    this.message('Получена команда прерывания, останавливаем выполнение…', 'warn');
    this.controller.abort();
    return true;
  }

  get cancelRequested() {
    return this.controller.signal.aborted;
  }

  finish(result) {
    this.status = 'done';
    this.finishedAt = Date.now();
    this.#push('finish', { result });
  }

  /** Аудит остановлен пользователем: это не ошибка. */
  cancelled(message = 'Аудит прерван пользователем') {
    this.status = 'cancelled';
    this.error = message;
    this.finishedAt = Date.now();
    for (const stage of this.stages.values()) {
      if (stage.status === 'running' || stage.status === 'waiting') {
        stage.status = 'skipped';
        stage.detail = '';
        stage.note = 'прервано';
      }
    }
    this.#push('cancelled', { error: message, durationMs: this.durationMs() });
  }

  /** Длительность выполнения: у завершённого — итоговая, у текущего — накопленная. */
  durationMs() {
    return (this.finishedAt ?? Date.now()) - this.startedAt;
  }

  fail(error) {
    this.status = 'failed';
    this.error = error?.message || String(error);
    this.finishedAt = Date.now();
    for (const stage of this.stages.values()) {
      if (stage.status === 'running' || stage.status === 'waiting') {
        stage.status = 'failed';
        stage.note = this.error;
      }
    }
    this.#push('error', { error: this.error });
  }

  /** Доля выполнения 0..100, взвешенная по трудоёмкости этапов. */
  percent() {
    let acc = 0;
    for (const stage of this.stages.values()) {
      if (stage.status === 'done' || stage.status === 'skipped' || stage.status === 'warning') {
        acc += stage.weight;
      } else if (stage.status === 'running' || stage.status === 'waiting') {
        acc += stage.weight * 0.4;
      }
    }
    return Math.min(100, Math.round((acc / this.totalWeight) * 100));
  }

  snapshot() {
    return {
      auditId: this.auditId,
      status: this.status,
      error: this.error,
      percent: this.percent(),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs(),
      cancelRequested: this.cancelRequested,
      // Переподключившийся клиент должен снова увидеть вопрос, иначе конвейер
      // будет молча стоять в ожидании ответа, которого никто не даёт.
      pending: this.pending,
      stages: [...this.stages.values()],
      log: this.log.slice(-200),
    };
  }

  #push(type, payload) {
    this.emit('event', { type, ...payload, percent: this.percent(), ts: Date.now() });
  }
}

/** Реестр активных и недавно завершённых прогрессов. */
const registry = new Map();

export function createProgress(auditId, stages = STAGES) {
  const progress = new AuditProgress(auditId, stages);
  // Неограниченное число подписчиков: SSE-клиентов может быть несколько.
  progress.setMaxListeners(0);
  registry.set(auditId, progress);
  // Держим завершённые прогрессы час — чтобы UI успел дочитать состояние.
  progress.on('event', (ev) => {
    if (ev.type === 'finish' || ev.type === 'error' || ev.type === 'cancelled') {
      setTimeout(() => registry.delete(auditId), 60 * 60 * 1000).unref?.();
    }
  });
  return progress;
}

export function getProgress(auditId) {
  return registry.get(auditId) || null;
}

/**
 * Выполняющиеся прямо сейчас аудиты.
 *
 * Нужны при остановке программы: закрытие окна должно снимать и внешние
 * процессы платформы. Просто выйти из Node мало — `ibcmd`, конфигуратор
 * и powershell переживут родителя и продолжат держать базу. Поэтому им
 * сначала запрашивается прерывание, а оно уже снимает процессы с потомками.
 */
export function runningProgresses() {
  return [...registry.values()].filter((p) => p.status === 'running');
}
