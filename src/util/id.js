import crypto from 'node:crypto';

/** Идентификатор аудита: сортируемый по времени + случайный хвост. */
export function newAuditId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

export function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Нормализованный хеш кода: без комментариев, отступов и регистра. */
export function codeFingerprint(text) {
  const normalized = text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return sha1(normalized);
}
