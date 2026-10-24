/**
 * 生成聊天回复：大模型可用时让模型组织语言，否则用模板（保证离线可演示）。
 */
import { AI_MODES, describeIntent } from '../../../shared/ai-schema.js';
import { chatJson } from './llm.js';

function tagsOf(intent) {
  return describeIntent(intent).map((item) => `${item.label}：${item.value}`).join('，');
}

export function buildRuleReply(intent, candidates) {
  const tags = tagsOf(intent);
  const dateLabel = intent?.dateLabel || intent?.date || '';
  if (!candidates.length) {
    return `我在${dateLabel}没找到符合「${tags || '你的需求'}」的空闲时段。可以换个日期、缩短时长，或者换一种运动类型再试试～`;
  }
  const first = candidates[0];
  const lines = [
    `按「${tags}」帮你找到 ${candidates.length} 个可约时段。`,
    `最推荐：${first.venueName} ${first.courtName}，${first.startTime}-${first.endTime}，¥${first.amount}。`,
    '点下面的卡片可以直接锁定（锁定保留 10 分钟）。',
  ];
  return lines.join('');
}

const SYSTEM_PROMPT = `你是「运动场馆易约」的预约助手。根据用户的意图和系统实时查到的候选时段，用中文写 1-2 句简洁友好的回复。
要求：只能使用候选中出现的场馆、场地、时间、价格；不要编造不存在的信息；若有候选，提醒用户可点卡片一键锁定。
只输出 JSON：{"reply": "..."}`;

/**
 * @param {object} intent
 * @param {object[]} candidates
 * @param {{mode: 'llm'|'rule'}} options
 * @returns {Promise<string>}
 */
export async function buildChatReply(intent, candidates, { mode } = {}) {
  const fallback = buildRuleReply(intent, candidates);
  if (mode !== AI_MODES.LLM) return fallback;
  const parsed = await chatJson(
    SYSTEM_PROMPT,
    JSON.stringify({ intent: { ...intent, raw: undefined }, candidates }),
    { maxTokens: 300, temperature: 0.3 },
  );
  const reply = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
  return reply || fallback;
}
