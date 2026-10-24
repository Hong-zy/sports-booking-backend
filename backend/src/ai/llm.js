/**
 * OpenAI 兼容的大模型客户端（DeepSeek / 通义 / 智谱等均可）。
 *
 * 关键设计：
 * - 只用 Node 内置 fetch，保持项目「零第三方依赖」；
 * - 未配置 AI_API_KEY 时不报错，返回 null，由调用方走本地规则引擎兜底；
 * - 任何网络/解析异常同样返回 null，保证接口永远可用（演示时不因断网而失败）。
 */
import { config } from '../config.js';
import { AI_MODES } from '../../../shared/ai-schema.js';

export const aiConfigured = () => Boolean(config.aiApiKey);

export const aiStatus = () => ({
  enabled: aiConfigured(),
  mode: aiConfigured() ? AI_MODES.LLM : AI_MODES.RULE,
  model: aiConfigured() ? config.aiModel : null,
  baseUrl: aiConfigured() ? config.aiBaseUrl : null,
});

let lastWarnAt = 0;
function warnOnce(message) {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn('[ai]', message);
}

/**
 * 请求模型并解析 JSON 输出。
 * @param {string} system 系统提示词
 * @param {string} user 用户内容
 * @returns {Promise<object|null>} 失败返回 null（调用方兜底）
 */
export async function chatJson(system, user, { maxTokens = 800, temperature = 0.2 } = {}) {
  if (!aiConfigured()) return null;
  const url = `${String(config.aiBaseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: config.aiModel,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
    if (!res.ok) {
      warnOnce(`模型接口返回 HTTP ${res.status}，已自动降级为本地规则引擎`);
      return null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    warnOnce(`模型调用失败（${err.name === 'TimeoutError' ? '超时' : err.message}），已自动降级为本地规则引擎`);
    return null;
  }
}
