/**
 * AI 能力的前后端公用定义。
 * 前端用它渲染快捷话术、意图标签与模式徽章，后端用它做长度限制与文案。
 */

export const AI_MODES = {
  LLM: 'llm', // 真实大模型（配置了 AI_API_KEY）
  RULE: 'rule', // 本地规则引擎兜底（未配置 key 或模型调用失败）
};

export const AI_MODE_LABEL = {
  llm: '大模型',
  rule: '本地规则',
};

export const AI_LIMITS = {
  messageMax: 200,
  candidatesMax: 5,
  durationMaxMinutes: 8 * 60,
};

/** 聊天窗里的快捷话术 */
export const AI_QUICK_PROMPTS = [
  '明天下午帮我订 2 小时羽毛球',
  '推荐人少的篮球场',
  '这周六上午游泳 1 小时',
  '帮我找最便宜的网球时段',
];

export const AI_INTENT_LABELS = {
  sport: '运动',
  date: '日期',
  startTime: '开始',
  durationMinutes: '时长',
  cheap: '偏好',
  quiet: '偏好',
};

/** 分钟数 -> "1.5 小时" */
export function durationText(minutes) {
  const n = Number(minutes) || 0;
  if (!n) return '';
  if (n % 60 === 0) return `${n / 60} 小时`;
  return n < 60 ? `${n} 分钟` : `${(n / 60).toFixed(1)} 小时`;
}

/**
 * 把意图对象转成前端可渲染的标签数组（自动跳过空值）。
 * @returns {{key: string, label: string, value: string}[]}
 */
export function describeIntent(intent) {
  if (!intent || typeof intent !== 'object') return [];
  const out = [];
  if (intent.sport) out.push({ key: 'sport', label: '运动', value: String(intent.sport) });
  if (intent.date) out.push({ key: 'date', label: '日期', value: String(intent.date) });
  if (intent.startTime) {
    out.push({ key: 'startTime', label: '开始', value: String(intent.startTime) });
  }
  if (intent.durationMinutes) {
    out.push({ key: 'duration', label: '时长', value: durationText(intent.durationMinutes) });
  }
  const prefs = [];
  if (intent.preferences?.cheap) prefs.push('价格优先');
  if (intent.preferences?.quiet) prefs.push('空闲优先');
  if (prefs.length) out.push({ key: 'pref', label: '偏好', value: prefs.join('、') });
  return out;
}
