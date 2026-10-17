/**
 * frontend / backend 共用的时间工具。
 * 约定：时间统一用「某天的第几分钟」（0 - 1440）表示，展示层再转成 HH:MM。
 */

export const pad2 = (n) => String(n).padStart(2, '0');

/** 分钟数 -> "HH:MM" */
export const toHM = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

/** "HH:MM" / "H:MM" / "HH" -> 分钟数；非法返回 null */
export function parseHM(value) {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (h > 24 || mi > 59 || h * 60 + mi > 1440) return null;
  return h * 60 + mi;
}

/** 分钟数 -> "1.5 小时" / "60 分钟" */
export function minutesToText(min) {
  const n = Number(min) || 0;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return n < 60 ? `${n} 分钟` : `${(n / 60).toFixed(1)} 小时`;
}

/** 日期字符串是否合法（YYYY-MM-DD 且真实存在） */
export function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** 本地时区的 YYYY-MM-DD */
export function todayString(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地日期 0 点 */
export function dayStart(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export const toDateStr = (d) => todayString(d);

/** 某天某分钟对应的本地时间戳 */
export const atMinute = (date, min) => dayStart(date).getTime() + min * 60_000;

export const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

export const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86_400_000);

/** 在日期上加减天数，返回 YYYY-MM-DD */
export function addDays(date, delta) {
  return toDateStr(new Date(dayStart(date).getTime() + delta * 86_400_000));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "2026-09-12" -> "周六" */
export const weekdayLabel = (date) => WEEKDAYS[dayStart(date).getDay()];

/** 生成一个可读的时间范围文本：09:00 - 11:00（2 小时） */
export const rangeText = (startTime, endTime) => {
  const s = parseHM(startTime);
  const e = parseHM(endTime);
  if (s === null || e === null || e <= s) return `${startTime} - ${endTime}`;
  return `${toHM(s)} - ${toHM(e)}（${minutesToText(e - s)}）`;
};
