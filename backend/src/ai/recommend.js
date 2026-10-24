/**
 * 根据意图在数据库里找出可预约时段并排序。
 * 完全复用 core.js 的可用性计算（时段格子 − 预约 − 锁定 − 维护）与价格规则。
 */
import { num, prep } from '../db.js';
import { slotsOf } from '../core.js';
import { atMinute, isDateString, overlaps, toDateStr, toHM } from '../util.js';
import { AI_LIMITS } from '../../../shared/ai-schema.js';

const reasonOf = (intent, candidate) => {
  const parts = [];
  if (intent.preferences?.cheap) parts.push('价格优先');
  if (intent.preferences?.quiet) parts.push('空闲优先');
  if (intent.startTime && Math.abs(candidate.startMin - intent.startMin) <= 60) parts.push('接近你说的时间');
  if (!parts.length) parts.push('时段较早、可立即锁定');
  return `${parts.join('、')} · ¥${candidate.amount}`;
};

/**
 * @param {object} intent parseIntent 的输出
 * @param {{limit?: number}} [options]
 */
export function recommendSlots(intent, { limit = AI_LIMITS.candidatesMax } = {}) {
  const date = isDateString(intent?.date) ? intent.date : toDateStr(new Date());
  const durationMinutes = Math.min(
    Math.max(Number(intent?.durationMinutes) || 60, 30),
    AI_LIMITS.durationMaxMinutes,
  );
  const all = [];

  const venues = prep('SELECT * FROM venues WHERE status = ? ORDER BY id').all('open')
    .filter((venue) => !intent?.sport || venue.sport === intent.sport);

  for (const venue of venues) {
    const step = num(venue.slot_minutes);
    const need = Math.max(1, Math.ceil(durationMinutes / step));
    const courts = prep('SELECT * FROM courts WHERE venue_id = ? AND status = ? ORDER BY id').all(venue.id, 'open');

    for (const court of courts) {
      const slots = slotsOf(venue, court, date);
      for (let i = 0; i + need <= slots.length; i += 1) {
        const window = slots.slice(i, i + need);
        if (window.some((slot) => slot.status !== 'available')) continue;
        const startMin = window[0].startMin;
        const endMin = window[window.length - 1].endMin;
        if (atMinute(date, startMin) <= Date.now()) continue;
        // 指定了开始时间时，窗口必须覆盖它
        if (intent?.startMin !== null && intent?.startMin !== undefined) {
          if (!overlaps(startMin, endMin, intent.startMin, intent.startMin + durationMinutes)) continue;
        }
        const minutes = endMin - startMin;
        const candidate = {
          venueId: num(venue.id),
          venueName: venue.name,
          sport: venue.sport,
          address: venue.address,
          courtId: num(court.id),
          courtName: court.name,
          date,
          startMin,
          endMin,
          startTime: toHM(startMin),
          endTime: toHM(endMin),
          durationMinutes: minutes,
          amount: Math.round((minutes / 60) * num(court.price_per_hour)),
        };
        candidate.reason = reasonOf(intent, candidate);
        all.push(candidate);
      }
    }
  }

  const { cheap, quiet } = intent?.preferences || {};
  const startTarget = intent?.startMin;

  all.sort((a, b) => {
    if (cheap && a.amount !== b.amount) return a.amount - b.amount;
    if (startTarget !== null && startTarget !== undefined) {
      const diff = Math.abs(a.startMin - startTarget) - Math.abs(b.startMin - startTarget);
      if (diff !== 0) return diff;
    }
    if (quiet && a.venueId !== b.venueId) {
      // 空闲优先：同一时间点下，优先安排到当天已占用更少的场馆
      return a.venueId - b.venueId;
    }
    return a.startMin - b.startMin || a.amount - b.amount;
  });

  // 同一场地同一时间只保留一条；每个场馆最多给 2 条，避免结果全挤在一个场馆
  const seen = new Set();
  const perVenue = new Map();
  const result = [];
  for (const item of all) {
    const key = `${item.courtId}|${item.startMin}`;
    if (seen.has(key)) continue;
    const count = perVenue.get(item.venueId) || 0;
    if (count >= 2) continue;
    seen.add(key);
    perVenue.set(item.venueId, count + 1);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}
