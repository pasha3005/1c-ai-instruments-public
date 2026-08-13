/**
 * Общие кирпичики интерфейса: выборка узлов, экранирование, шкала этапов,
 * форматирование чисел и времени.
 *
 * Вынесены отдельно, когда в главном окне появился второй рабочий раздел —
 * «Обновление конфигурации». У него своя форма и свой прогон, но
 * шкала этапов, секундомер и русский счёт должны выглядеть и считаться
 * одинаково: два набора почти одинакового кода разошлись бы на первой же правке.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function setNote(selector, text, isError = false) {
  const el = typeof selector === 'string' ? $(selector) : selector;
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', Boolean(isError));
}

/** Шкала этапов конвейера. Разметка и классы — общие с CSS (.stage-item). */
export function renderStages(container, stages) {
  const icons = {
    pending: '', running: '', done: '✓', skipped: '–', warning: '!', failed: '✕',
  };
  container.innerHTML = stages.map((stage) => `
    <li class="stage-item is-${stage.status}">
      <span class="stage-icon">${icons[stage.status] ?? ''}</span>
      <span class="stage-body">
        <span class="stage-title">${escapeHtml(stage.title)}</span>
        ${stage.detail ? `<span class="stage-detail">${escapeHtml(stage.detail)}</span>` : ''}
        ${stage.note ? `<span class="stage-note">${escapeHtml(stage.note)}</span>` : ''}
      </span>
    </li>`).join('');
}

export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${s} с`;
  return `${s} с`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(value ?? 0);
}

/** «1 объект», «2 объекта», «5 объектов» — иначе интерфейс выглядит небрежно. */
export function plural(count, one, few, many) {
  const n = Number(count) || 0;
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  const word = teen ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  return `${formatNumber(n)} ${word}`;
}

export function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Секундомер прогона: сервер знает точную длительность, но пока прогон идёт,
 * пользователь должен видеть, что время течёт.
 */
export function createTimer(element) {
  let startedAt = null;
  let timer = null;

  return {
    start() {
      this.stop();
      startedAt = Date.now();
      element.textContent = '0 с';
      timer = setInterval(() => {
        element.textContent = formatDuration(Date.now() - startedAt);
      }, 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Показывает итог: точную длительность от сервера либо накопленную. */
    finish(durationMs) {
      this.stop();
      const ms = durationMs ?? (startedAt ? Date.now() - startedAt : null);
      if (ms != null) element.textContent = formatDuration(ms);
      return ms;
    },
  };
}

/**
 * Подсказка «что распознано в пути к базе» под полем ввода.
 *
 * Одна и та же на обеих формах: тип базы определяет сервер (`/api/parse-path`),
 * потому что разбор строки подключения живёт в одном месте — `onec/connection.js`.
 */
export function attachPathHint(input, hint, parsePath) {
  const defaultText = hint.textContent;
  let timer = null;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const value = input.value.trim();
      if (!value) {
        hint.className = 'hint';
        hint.textContent = defaultText;
        return;
      }
      try {
        const parsed = await parsePath(value);
        if (parsed.error) {
          hint.className = 'hint is-warn';
          hint.textContent = parsed.error;
          return;
        }
        const kindRu = {
          file: 'файловая база', server: 'серверная база', web: 'веб-подключение',
        }[parsed.kind];
        hint.className = 'hint is-ok';
        hint.textContent = `Распознано как ${kindRu}: ${parsed.display}`;
      } catch {
        hint.className = 'hint';
      }
    }, 350);
  });
}

/**
 * Открывает готовый отчёт в браузере по умолчанию.
 *
 * Ссылкой с `target="_blank"` этого не добиться: интерфейс сам живёт в окне
 * `--app` без адресной строки и вкладок, и отчёт открывался таким же окном —
 * без строки адреса, без «назад», без возможности отправить ссылку. Поэтому
 * окно открывает СЕРВЕР (`openUrl` с `appWindow: false`) — тем же способом,
 * которым отчёт открывается сам по завершении прогона. Прямое требование
 * пользователя (13.08.2026): открытие из интерфейса и открытие по готовности
 * должны вести себя одинаково.
 *
 * @param {HTMLElement} button кнопка, по которой нажали
 * @param {() => Promise<unknown>} request вызов соответствующего `/open`
 * @param {(message: string) => void} [onError] куда сказать о неудаче
 */
export async function openReportInBrowser(button, request, onError) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Открываем…';
  try {
    await request();
  } catch (err) {
    // Отчёт цел, не открылось только окно: сообщаем и оставляем кнопку.
    if (onError) onError(`Не удалось открыть отчёт: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
