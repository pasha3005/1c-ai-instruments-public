/** Тонкая обёртка над HTTP API приложения. */

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const message = (payload && payload.error) || `Ошибка ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export const api = {
  /** Действует ли введённый ранее ключ. */
  licenseStatus: () => request('api/license'),

  /** Проверка ключа. Ключ уходит только на локальный сервер приложения. */
  activateLicense: (key) =>
    request('api/license', { method: 'POST', body: JSON.stringify({ key }) }),

  environment: () => request('api/environment'),

  /** README, уже преобразованный в разметку, — для раздела «О программе». */
  about: () => request('api/about'),

  /** Открыть готовый отчёт отдельным окном (окно открывает сервер). */
  openReport: (id) => request(`api/audits/${id}/open`, { method: 'POST' }),

  /** Спросить, куда сохранить отчёт, и сохранить его туда. */
  saveReport: (id) => request(`api/audits/${id}/save`, { method: 'POST' }),

  parsePath: (infobasePath) =>
    request('api/parse-path', { method: 'POST', body: JSON.stringify({ infobasePath }) }),

  /** Системный диалог выбора файла или каталога — показывает его сервер. */
  pickPath: (params) =>
    request('api/pick', { method: 'POST', body: JSON.stringify(params) }),

  startAudit: (input) =>
    request('api/audits', { method: 'POST', body: JSON.stringify(input) }),

  cancelAudit: (id) => request(`api/audits/${id}/cancel`, { method: 'POST' }),

  inspectWorkDir: (workDir) =>
    request('api/workdir/inspect', { method: 'POST', body: JSON.stringify({ workDir }) }),

  clearWorkDir: (workDir) =>
    request('api/workdir/clear', { method: 'POST', body: JSON.stringify({ workDir }) }),

  auditStatus: (id) => request(`api/audits/${id}/status`),

  listAudits: () => request('api/audits'),

  audit: (id) => request(`api/audits/${id}`),

  deleteAudit: (id) => request(`api/audits/${id}`, { method: 'DELETE' }),
};

/**
 * Держит сервер в курсе того, что окно интерфейса открыто.
 *
 * Кнопки «Завершить работу» больше нет: закрытие окна должно останавливать
 * программу. Сообщить об этом изнутри страницы нечем — `beforeunload`
 * не отличает закрытие от обновления, а `sendBeacon` при закрытии окна
 * доходит не всегда. Зато обрыв открытого потока сервер видит достоверно,
 * поэтому «окно живо» выражается самим фактом соединения.
 *
 * `EventSource` переподключается сам, и это здесь на руку: перезагрузка
 * страницы восстановит поток раньше, чем истечёт отсрочка на сервере.
 */
export function keepAlive() {
  const source = new EventSource('api/presence');
  // Ошибки не гасим и не логируем: браузер переподключится сам, а когда
  // сервер остановлен — переподключаться уже некуда и незачем.
  return () => source.close();
}

/**
 * Подписка на поток событий аудита.
 * @returns {() => void} функция отписки
 */
export function subscribeToAudit(auditId, handlers) {
  const source = new EventSource(`api/audits/${auditId}/stream`);

  const forward = (event) => {
    try {
      handlers.onUpdate?.(JSON.parse(event.data));
    } catch {
      /* некорректный пакет — игнорируем */
    }
  };

  for (const name of ['snapshot', 'stage', 'log']) {
    source.addEventListener(name, forward);
  }

  source.addEventListener('finish', (event) => {
    forward(event);
    handlers.onFinish?.();
    source.close();
  });

  // Прерывание пользователем — отдельное событие: это не сбой.
  source.addEventListener('cancelled', (event) => {
    forward(event);
    let payload = {};
    try {
      payload = JSON.parse(event.data);
    } catch { /* без подробностей */ }
    handlers.onCancelled?.(payload.error, payload.durationMs);
    source.close();
  });

  source.addEventListener('error', (event) => {
    // SSE шлёт error и при обрыве соединения — различаем по наличию данных.
    if (event.data) {
      try {
        const payload = JSON.parse(event.data);
        handlers.onUpdate?.(payload);
        handlers.onError?.(payload.error);
      } catch {
        handlers.onError?.('Соединение с сервером прервано');
      }
      source.close();
      return;
    }
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError?.('Соединение с сервером прервано');
    }
  });

  return () => source.close();
}
