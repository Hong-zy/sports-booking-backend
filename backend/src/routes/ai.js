import { requireAdmin } from '../auth.js';
import { num, prep } from '../db.js';
import { HttpError, bad } from '../http.js';
import { isDateString, nowISO, parseHM } from '../util.js';
import { AI_LIMITS, AI_MODE_LABEL, AI_MODES, AI_QUICK_PROMPTS } from '../../../shared/ai-schema.js';
import { parseIntent } from '../ai/intent.js';
import { recommendSlots } from '../ai/recommend.js';
import { buildChatReply } from '../ai/chat.js';
import { aiStatus } from '../ai/llm.js';
import { buildInsights } from '../ai/insights.js';

export function registerRoutes(router) {
  /* ---------------------------- AI 能力状态 ---------------------------- */
  router.get('/api/ai/status', () => ({
    ...aiStatus(),
    hints: AI_QUICK_PROMPTS,
    limits: AI_LIMITS,
  }));

  /* ------------------------- AI 预约助手（对话） ------------------------- */
  router.post('/api/ai/chat', async (ctx) => {
    const message = String(ctx.body?.message ?? '').trim();
    if (!message) throw bad('请描述你的预约需求，例如：明天下午帮我订 2 小时羽毛球');
    if (message.length > AI_LIMITS.messageMax) {
      throw new HttpError(400, `描述请控制在 ${AI_LIMITS.messageMax} 字以内`);
    }

    const { intent, parsedBy } = await parseIntent(message);
    const candidates = recommendSlots(intent, { limit: AI_LIMITS.candidatesMax });
    const mode = parsedBy === AI_MODES.LLM ? AI_MODES.LLM : AI_MODES.RULE;
    const reply = await buildChatReply(intent, candidates, { mode });

    // 记录 AI 使用日志（后台数据库页可查看，也是 AI 能力的运行证据）
    try {
      prep('INSERT INTO ai_logs (user_id, question, mode, intent_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(ctx.user ? num(ctx.user.id) : null, message, mode, JSON.stringify(intent), nowISO());
    } catch (err) {
      console.warn('[ai] 写日志失败:', err.message);
    }

    return { reply, parsedBy, mode, modeLabel: AI_MODE_LABEL[mode], intent, candidates };
  });

  /* ------------------------- AI 结构化推荐（表单） ------------------------- */
  router.post('/api/ai/recommend', (ctx) => {
    const body = ctx.body || {};
    const startMin = parseHM(body.startTime);
    const intent = {
      sport: body.sport || null,
      date: isDateString(body.date) ? body.date : null,
      startMin,
      startTime: startMin !== null ? body.startTime : null,
      durationMinutes: Number(body.durationMinutes) || 60,
      preferences: { cheap: Boolean(body.cheap), quiet: Boolean(body.quiet) },
    };
    return {
      intent,
      candidates: recommendSlots(intent, { limit: AI_LIMITS.candidatesMax }),
      mode: aiStatus().mode,
    };
  });

  /* --------------------------- AI 经营分析 --------------------------- */
  router.get('/api/admin/ai/insights', async (ctx) => {
    requireAdmin(ctx);
    const days = Math.min(Math.max(Number(ctx.query.get('days')) || 7, 1), 31);
    return buildInsights({ days });
  });
}
