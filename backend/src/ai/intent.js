/**
 * 自然语言 → 预约意图。
 *
 * 双通道：
 * 1) 配置了 AI_API_KEY 时优先走大模型（结构化 JSON 输出）；
 * 2) 否则/失败时走本地规则引擎（中文关键词、时间、时长、日期解析）。
 * 两条通道输出同一套意图结构，前端与推荐器无需区分。
 */
import { SPORT_OPTIONS } from '../../../shared/constants.js';
import { AI_MODES } from '../../../shared/ai-schema.js';
import { aiConfigured, chatJson } from './llm.js';
import { addDays, isDateString, pad2, toDateStr, toHM, todayString, weekdayLabel } from '../util.js';

const SPORT_ALIASES = [
  ['羽毛球', ['羽毛球', '羽球', '打羽毛球', '羽']],
  ['篮球', ['篮球', '打篮球', '篮']],
  ['游泳', ['游泳', '泳池', '游个泳', '泳']],
  ['网球', ['网球', '打网球', '网']],
  ['乒乓球', ['乒乓球', '乒乓', '乒球', '乒']],
];

const CN_MAP = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字（0-99）转数字，无法解析返回 NaN */
export function cnToNumber(input) {
  const text = String(input ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text) return Number.NaN;
  if (text === '十') return 10;
  const tenMatch = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (tenMatch) {
    const tens = tenMatch[1] ? CN_MAP[tenMatch[1]] : 1;
    const ones = tenMatch[2] ? CN_MAP[tenMatch[2]] : 0;
    return tens * 10 + ones;
  }
  if (CN_MAP[text] !== undefined) return CN_MAP[text];
  return Number.NaN;
}

function extractSport(text) {
  for (const [sport, aliases] of SPORT_ALIASES) {
    if (aliases.some((alias) => text.includes(alias))) return sport;
  }
  return null;
}

function extractDate(text, now = new Date()) {
  const today = todayString(now);
  if (/大后天/.test(text)) return addDays(today, 3);
  if (/后天/.test(text)) return addDays(today, 2);
  if (/明天|明日/.test(text)) return addDays(today, 1);
  if (/今天|今日|现在/.test(text)) return today;

  const weekdayMatch = /(下|本|这)?(?:周|星期|礼拜)([一二三四五六日天七])/.exec(text);
  if (weekdayMatch) {
    const name = weekdayMatch[2];
    const targetDow = name === '日' || name === '天' || name === '七' ? 0 : '一二三四五六'.indexOf(name) + 1;
    const todayDow = now.getDay();
    let delta = (targetDow - todayDow + 7) % 7;
    if (weekdayMatch[1] === '下') delta = delta || 7;
    return addDays(today, delta);
  }
  if (/周末/.test(text)) {
    const todayDow = now.getDay();
    const delta = todayDow === 6 ? 0 : (6 - todayDow + 7) % 7;
    return addDays(today, delta);
  }

  const full = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (full) {
    const value = `${full[1]}-${pad2(full[2])}-${pad2(full[3])}`;
    return isDateString(value) ? value : null;
  }
  const monthDay = /(\d{1,2})月(\d{1,2})[日号]/.exec(text);
  if (monthDay) {
    const value = `${now.getFullYear()}-${pad2(monthDay[1])}-${pad2(monthDay[2])}`;
    return isDateString(value) ? value : null;
  }
  const slash = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\s|$)/.exec(text);
  if (slash) {
    const value = `${now.getFullYear()}-${pad2(slash[1])}-${pad2(slash[2])}`;
    return isDateString(value) ? value : null;
  }
  return null;
}

function toMinutes(hour, minute) {
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) return null;
  const minuteValue = Number.isFinite(minute) ? minute : 0;
  if (minuteValue < 0 || minuteValue > 59) return null;
  return hour * 60 + minuteValue;
}

function applyPeriod(hour, period) {
  if (!Number.isFinite(hour)) return null;
  if (period === '下午' || period === '晚上') return hour < 12 ? hour + 12 : hour;
  if (period === '中午') return hour < 6 ? hour + 12 : hour;
  return hour;
}

/** 解析时间：返回 { startMin, endMin }，解析不到返回 null */
export function extractTimeRange(text) {
  const colonRange = /(\d{1,2})[:：](\d{2})\s*[-~到至]\s*(\d{1,2})[:：](\d{2})/.exec(text);
  if (colonRange) {
    const start = toMinutes(Number(colonRange[1]), Number(colonRange[2]));
    const end = toMinutes(Number(colonRange[3]), Number(colonRange[4]));
    if (start !== null && end !== null && end > start) return { startMin: start, endMin: end };
  }

  const pointRange = /(上午|早上|下午|晚上|中午)?\s*([0-9零〇一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|[0-9]{1,2}\s*分)?\s*(?:[-~到至]\s*(上午|早上|下午|晚上|中午)?\s*([0-9零〇一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|[0-9]{1,2}\s*分)?)?/.exec(text);
  if (pointRange) {
    const startHour = applyPeriod(cnToNumber(pointRange[2]), pointRange[1]);
    let startMin = toMinutes(startHour, pointRange[3]?.includes('半') ? 30 : pointRange[3] ? Number(pointRange[3].replace(/[^\d]/g, '')) : 0);
    if (startMin !== null) {
      if (pointRange[5]) {
        const endHour = applyPeriod(cnToNumber(pointRange[5]), pointRange[4] || pointRange[1]);
        const endMin = toMinutes(endHour, pointRange[6]?.includes('半') ? 30 : pointRange[6] ? Number(pointRange[6].replace(/[^\d]/g, '')) : 0);
        if (endMin !== null && endMin > startMin) return { startMin, endMin };
      }
      return { startMin, endMin: null };
    }
  }

  const colonSingle = /(\d{1,2})[:：](\d{2})/.exec(text);
  if (colonSingle) {
    const start = toMinutes(Number(colonSingle[1]), Number(colonSingle[2]));
    if (start !== null) return { startMin: start, endMin: null };
  }
  return null;
}

/** 解析时长（分钟），解析不到返回 null */
export function extractDuration(text) {
  const halfHour = /半\s*个?\s*小时/.exec(text);
  if (halfHour) return 30;
  const hourHalf = /([0-9一二两三四五六七八九十]+)\s*个?\s*半\s*小时/.exec(text);
  if (hourHalf) {
    const base = cnToNumber(hourHalf[1]);
    if (Number.isFinite(base)) return base * 60 + 30;
  }
  const hours = /([0-9]+(?:\.[0-9]+)?)\s*个?\s*小时/.exec(text);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const cnHours = /([一二两三四五六七八九十]+)\s*个?\s*小时/.exec(text);
  if (cnHours) {
    const base = cnToNumber(cnHours[1]);
    if (Number.isFinite(base)) return base * 60;
  }
  const minutes = /([0-9]+)\s*分钟/.exec(text);
  if (minutes) return Number(minutes[1]);
  return null;
}

function extractPreferences(text) {
  return {
    cheap: /便宜|实惠|性价比|省钱|低价|划算/.test(text),
    quiet: /人少|空闲|不挤|安静|空一点/.test(text),
  };
}

function defaultDate(now = new Date()) {
  return now.getHours() >= 20 ? addDays(todayString(now), 1) : todayString(now);
}

function dateLabelOf(date, now = new Date()) {
  const today = todayString(now);
  const label = `${date} ${weekdayLabel(date)}`;
  if (date === today) return `今天（${label}）`;
  if (date === addDays(today, 1)) return `明天（${label}）`;
  if (date === addDays(today, 2)) return `后天（${label}）`;
  return label;
}

/**
 * 本地规则解析（无需大模型，离线可用）。
 */
export function parseIntentRule(text, now = new Date()) {
  const raw = String(text ?? '');
  const range = extractTimeRange(raw);
  const duration = extractDuration(raw);
  const sport = extractSport(raw);
  const explicitDate = extractDate(raw, now);
  const date = explicitDate || defaultDate(now);

  let startMin = range?.startMin ?? null;
  let endMin = range?.endMin ?? null;
  let durationMinutes = duration;
  if (startMin !== null && endMin !== null) durationMinutes = endMin - startMin;
  if (!durationMinutes) durationMinutes = 60;

  return {
    sport,
    date,
    dateLabel: dateLabelOf(date, now),
    startMin,
    endMin,
    startTime: startMin !== null ? toHM(startMin) : null,
    durationMinutes,
    preferences: extractPreferences(raw),
    raw,
  };
}

const SYSTEM_PROMPT = (today) => `你是「运动场馆易约」系统的意图解析器。今天是 ${today}（${weekdayLabel(today)}）。
可选运动：${SPORT_OPTIONS.join('、')}。
把用户的一句话解析成 JSON，字段如下（解析不到填 null，不要编造）：
{
  "sport": "运动类型或 null",
  "date": "YYYY-MM-DD 或 null（相对日期要换算成具体日期）",
  "startTime": "HH:MM 或 null",
  "endTime": "HH:MM 或 null",
  "durationMinutes": 数字或 null,
  "preferences": { "cheap": 布尔, "quiet": 布尔 }
}
只输出 JSON，不要解释。`;

function normalizeLlmIntent(rule, parsed) {
  if (!parsed || typeof parsed !== 'object') return rule;
  const sport = SPORT_OPTIONS.includes(parsed.sport) ? parsed.sport : rule.sport;
  const date = isDateString(parsed.date) ? parsed.date : rule.date;
  const timeText = `${parsed.startTime ?? ''}`;
  const startMinFromLlm = /^\d{1,2}:\d{2}$/.test(timeText)
    ? Number(timeText.split(':')[0]) * 60 + Number(timeText.split(':')[1])
    : null;
  const startMin = startMinFromLlm ?? rule.startMin;
  let durationMinutes = Number(parsed.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) durationMinutes = rule.durationMinutes;
  durationMinutes = Math.min(Math.max(durationMinutes, 30), 8 * 60);
  return {
    ...rule,
    sport,
    date,
    dateLabel: dateLabelOf(date),
    startMin,
    startTime: startMin !== null ? toHM(startMin) : null,
    durationMinutes,
    preferences: {
      cheap: Boolean(parsed.preferences?.cheap) || rule.preferences.cheap,
      quiet: Boolean(parsed.preferences?.quiet) || rule.preferences.quiet,
    },
  };
}

/**
 * 解析用户输入。
 * @returns {Promise<{intent: object, parsedBy: 'llm'|'rule'}>}
 */
export async function parseIntent(text) {
  const rule = parseIntentRule(text);
  if (!aiConfigured()) return { intent: rule, parsedBy: AI_MODES.RULE };
  const parsed = await chatJson(SYSTEM_PROMPT(todayString()), text, { maxTokens: 300 });
  if (!parsed) return { intent: rule, parsedBy: AI_MODES.RULE };
  return { intent: normalizeLlmIntent(rule, parsed), parsedBy: AI_MODES.LLM };
}
