export const pad = (n) => String(n).padStart(2, '0');

/** 分钟数 -> "HH:MM" */
export const toHM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** "HH:MM" -> 分钟数，非法返回 null */
export function parseHM(value) {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (h > 24 || mi > 59 || h * 60 + mi > 1440) return null;
  return h * 60 + mi;
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayStart(s).getTime());

export function dayStart(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 某天某分钟对应的本地时间戳 */
export const atMinute = (date, min) => dayStart(date).getTime() + min * 60_000;

export const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

export const nowISO = () => new Date().toISOString();

export const plusMinutes = (min) => new Date(Date.now() + min * 60_000).toISOString();

export const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86_400_000);

export function randomCode(prefix = 'SY') {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-5)}${rand}`;
}
