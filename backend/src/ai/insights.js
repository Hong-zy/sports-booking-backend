/**
 * 管理员「AI 经营分析」：
 * 汇总预约数据 → 大模型生成分析建议；无模型时用规则模板生成同样结构的结果。
 */
import { num, prep } from '../db.js';
import { aiConfigured, chatJson } from './llm.js';
import { AI_MODES } from '../../../shared/ai-schema.js';
import { addDays, toDateStr, nowISO } from '../util.js';

/** 汇总未来 N 天的预约/营收/利用率数据 */
export function collectInsightsData(days = 7) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 31);
  const from = toDateStr(new Date());
  const dates = Array.from({ length: safeDays }, (_, i) => addDays(from, i));
  const dateSet = new Set(dates);

  const venues = prep('SELECT * FROM venues ORDER BY id').all();
  const perVenue = venues.map((venue) => {
    const courts = prep('SELECT * FROM courts WHERE venue_id = ?').all(venue.id);
    const step = num(venue.slot_minutes) || 60;
    const capacityPerDay = Math.max(0, (num(venue.close_minute) - num(venue.open_minute)) / step) * courts.length;
    const rows = prep(`SELECT * FROM bookings WHERE venue_id = ? AND status IN ('confirmed','completed')`).all(venue.id)
      .filter((row) => dateSet.has(row.date));
    const bookedSlots = rows.reduce((sum, row) => sum + (num(row.end_min) - num(row.start_min)) / step, 0);
    const revenue = rows.reduce((sum, row) => sum + num(row.amount), 0);
    const capacity = capacityPerDay * safeDays;
    return {
      venueId: num(venue.id),
      venueName: venue.name,
      sport: venue.sport,
      status: venue.status,
      courtCount: courts.length,
      bookings: rows.length,
      revenue,
      utilization: capacity ? Number((bookedSlots / capacity).toFixed(3)) : 0,
    };
  });

  const cancelled = prep(`SELECT COUNT(*) AS c FROM bookings WHERE status = 'cancelled'`).get();
  const users = prep('SELECT COUNT(*) AS c FROM users').get();
  const totalBookings = perVenue.reduce((sum, item) => sum + item.bookings, 0);
  const totalRevenue = perVenue.reduce((sum, item) => sum + item.revenue, 0);

  const sorted = [...perVenue].sort((a, b) => b.revenue - a.revenue);
  const byUtilization = [...perVenue].sort((a, b) => b.utilization - a.utilization);

  return {
    range: { from, to: dates[dates.length - 1], days: safeDays },
    totals: {
      bookings: totalBookings,
      revenue: totalRevenue,
      cancelledBookings: num(cancelled.c),
      users: num(users.c),
      avgUtilization: perVenue.length
        ? Number((perVenue.reduce((sum, item) => sum + item.utilization, 0) / perVenue.length).toFixed(3))
        : 0,
    },
    topVenue: sorted[0] || null,
    bestUtilizationVenue: byUtilization[0] || null,
    worstUtilizationVenue: byUtilization[byUtilization.length - 1] || null,
    venues: perVenue,
  };
}

const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

/** 无大模型时的规则分析 */
export function buildRuleInsights(data) {
  const { range, totals, topVenue, bestUtilizationVenue, worstUtilizationVenue } = data;
  const summary = `未来 ${range.days} 天（${range.from} 至 ${range.to}）共有 ${totals.bookings} 笔预约，营收 ¥${totals.revenue}，平均时段利用率 ${pct(totals.avgUtilization)}；平台累计用户 ${totals.users} 人，历史取消预约 ${totals.cancelledBookings} 笔。`;

  const highlights = [];
  if (topVenue) highlights.push(`营收最高：${topVenue.venueName}（${topVenue.bookings} 笔，¥${topVenue.revenue}）`);
  if (bestUtilizationVenue) highlights.push(`利用率最高：${bestUtilizationVenue.venueName}（${pct(bestUtilizationVenue.utilization)}）`);
  if (worstUtilizationVenue) highlights.push(`利用率最低：${worstUtilizationVenue.venueName}（${pct(worstUtilizationVenue.utilization)}）`);

  const suggestions = [];
  if (worstUtilizationVenue && worstUtilizationVenue.utilization < 0.2) {
    suggestions.push(`对 ${worstUtilizationVenue.venueName} 做定向推广（如首单优惠、低价时段），提升空闲时段的利用率。`);
  }
  if (bestUtilizationVenue && bestUtilizationVenue.utilization > 0.6) {
    suggestions.push(`${bestUtilizationVenue.venueName} 需求旺盛，可考虑增加场地或高峰时段适当调价。`);
  }
  if (totals.cancelledBookings > 0) {
    suggestions.push(`存在 ${totals.cancelledBookings} 笔取消预约，建议在取消前增加提醒，或在高峰时段缩短锁定时间。`);
  }
  if (totals.bookings === 0) {
    suggestions.push('当前时间段暂无预约，建议先通过演示账号创建几笔预约后再观察趋势。');
  }
  if (!suggestions.length) {
    suggestions.push('整体运营平稳，建议继续观察利用率变化，并保持维护时段标记的及时更新。');
  }

  return { summary, highlights, suggestions };
}

const SYSTEM_PROMPT = `你是运动场馆运营分析师。根据给出的经营数据，用中文输出 JSON：
{"summary": "2-3 句总体分析", "highlights": ["3 条关键数据亮点"], "suggestions": ["2-4 条可执行的运营建议"]}
要求：只使用数据里出现的事实，不要编造数字；语言简洁、专业。`;

/**
 * @param {{days?: number}} [options]
 * @returns {Promise<object>} { summary, highlights, suggestions, data, mode, generatedAt }
 */
export async function buildInsights({ days = 7 } = {}) {
  const data = collectInsightsData(days);
  const rule = buildRuleInsights(data);
  const base = { ...rule, data, mode: AI_MODES.RULE, generatedAt: nowISO() };
  if (!aiConfigured()) return base;

  const parsed = await chatJson(SYSTEM_PROMPT, JSON.stringify(data), { maxTokens: 700 });
  if (!parsed) return base;
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : rule.summary;
  const highlights = Array.isArray(parsed.highlights) && parsed.highlights.length
    ? parsed.highlights.filter((item) => typeof item === 'string' && item.trim()).slice(0, 5)
    : rule.highlights;
  const suggestions = Array.isArray(parsed.suggestions) && parsed.suggestions.length
    ? parsed.suggestions.filter((item) => typeof item === 'string' && item.trim()).slice(0, 5)
    : rule.suggestions;
  return { summary, highlights, suggestions, data, mode: AI_MODES.LLM, generatedAt: nowISO() };
}
