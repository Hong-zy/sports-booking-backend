/**
 * AI 预约助手（右下角聊天窗）。
 *
 * 交互链路：
 * 用户说一句话 → POST /api/ai/chat（大模型或本地规则解析） → 返回可约时段候选
 * → 点「去预约」→ 调用锁定接口拿到 lockId → 点「确认预约」→ 生成预约。
 *
 * 未登录时点「去预约」会派发 app:require-login 事件，由 main.js 弹出登录框。
 */
import { AI_LIMITS, AI_MODE_LABEL, AI_QUICK_PROMPTS as QUICK_PROMPTS, describeIntent } from '/shared/ai-schema.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { escapeHtml, fmtMoney, toast } from '../ui.js';

const state = {
  open: false,
  busy: false,
  mounted: false,
  elements: {},
  pending: new Map(), // candidateKey -> { candidate, lockId }
};

function h(strings, ...values) {
  return strings.reduce((out, chunk, index) => out + chunk + (values[index] ?? ''), '');
}

function scrollToEnd() {
  const { messages } = state.elements;
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function appendNode(node) {
  const { messages } = state.elements;
  if (!messages) return;
  messages.appendChild(node);
  scrollToEnd();
}

function addUserMessage(text) {
  const node = document.createElement('div');
  node.className = 'ai-msg ai-msg--user';
  node.innerHTML = `<div class="ai-msg__bubble"></div>`;
  node.querySelector('.ai-msg__bubble').textContent = text;
  appendNode(node);
}

function addLoadingMessage() {
  const node = document.createElement('div');
  node.className = 'ai-msg ai-msg--bot';
  node.innerHTML = `<div class="ai-msg__bubble ai-msg__bubble--loading"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>`;
  appendNode(node);
  return node;
}

function candidateKey(candidate) {
  return `${candidate.courtId}-${candidate.date}-${candidate.startMin}`;
}

function addBotMessage(payload) {
  const node = document.createElement('div');
  node.className = 'ai-msg ai-msg--bot';

  const modeLabel = payload.modeLabel || AI_MODE_LABEL[payload.mode] || '本地规则';
  const tags = describeIntent(payload.intent)
    .map((item) => `<span class="ai-tag">${escapeHtml(item.label)}：${escapeHtml(item.value)}</span>`)
    .join('');

  const cards = Array.isArray(payload.candidates) && payload.candidates.length
    ? `<div class="ai-cards">${payload.candidates
        .map((candidate, index) => {
          const key = candidateKey(candidate);
          return `<div class="ai-card" data-key="${escapeHtml(key)}" data-index="${index}">
            <div class="ai-card__main">
              <strong>${escapeHtml(candidate.venueName)} · ${escapeHtml(candidate.courtName)}</strong>
              <span>${escapeHtml(candidate.date)} ${escapeHtml(candidate.startTime)}-${escapeHtml(candidate.endTime)} · ${fmtMoney(candidate.amount)}</span>
              <small>${escapeHtml(candidate.reason || '')}</small>
            </div>
            <button type="button" class="btn btn--primary btn--sm" data-action="book">去预约</button>
          </div>`;
        })
        .join('')}</div>`
    : '';

  node.innerHTML = `
    <div class="ai-msg__bubble">
      <div class="ai-msg__meta"><span class="ai-badge ai-badge--${escapeHtml(payload.mode || 'rule')}">${escapeHtml(modeLabel)}</span>${tags}</div>
      <p class="ai-msg__text"></p>
      ${cards}
    </div>`;
  node.querySelector('.ai-msg__text').textContent = payload.reply || '';
  appendNode(node);

  node.querySelectorAll('[data-action="book"]').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.ai-card');
      const index = Number(card?.dataset.index);
      const candidate = payload.candidates?.[index];
      if (candidate) startBooking(candidate, button);
    });
  });
}

function addSystemMessage(html) {
  const node = document.createElement('div');
  node.className = 'ai-msg ai-msg--system';
  node.innerHTML = html;
  appendNode(node);
  return node;
}

async function startBooking(candidate, button) {
  if (!store.isLoggedIn) {
    toast('请先登录后再预约', 'warning');
    window.dispatchEvent(new CustomEvent('app:require-login'));
    return;
  }
  button.disabled = true;
  button.textContent = '锁定中…';
  try {
    const lock = await api.bookings.lock({
      courtId: candidate.courtId,
      date: candidate.date,
      startTime: candidate.startTime,
      endTime: candidate.endTime,
    });
    state.pending.set(candidateKey(candidate), { candidate, lockId: lock.lockId });
    button.textContent = '已锁定';
    const node = addSystemMessage(`
      <div class="ai-lock">
        <div class="ai-lock__text">已锁定 ${escapeHtml(lock.venueName)} ${escapeHtml(lock.courtName)} ${escapeHtml(lock.startTime)}-${escapeHtml(lock.endTime)}，剩余 ${Math.round(lock.remainSeconds / 60)} 分钟，是否确认预约？</div>
        <div class="ai-lock__actions">
          <button type="button" class="btn btn--primary btn--sm" data-action="confirm">确认预约（¥${escapeHtml(lock.amount)}）</button>
          <button type="button" class="btn btn--ghost btn--sm" data-action="giveup">放弃</button>
        </div>
      </div>`);
    node.querySelector('[data-action="confirm"]')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = '提交中…';
      try {
        const booking = await api.bookings.create(lock.lockId);
        state.pending.delete(candidateKey(candidate));
        node.innerHTML = `<div class="ai-success">✅ 预约成功！凭证号 <strong>${escapeHtml(booking.code)}</strong>，可在「我的预约」查看或取消。</div>`;
        toast('预约成功', 'success');
      } catch (err) {
        node.innerHTML = `<div class="ai-error">预约失败：${escapeHtml(err.message || '请重试')}</div>`;
      }
    });
    node.querySelector('[data-action="giveup"]')?.addEventListener('click', () => {
      node.remove();
      button.disabled = false;
      button.textContent = '去预约';
      toast('已放弃本次锁定', 'info');
    });
  } catch (err) {
    const suggestions = err.suggestions || [];
    button.disabled = false;
    button.textContent = '去预约';
    const tips = suggestions
      .slice(0, 3)
      .map((item) => `${item.courtName} ${item.startTime}-${item.endTime}`)
      .join('，');
    addSystemMessage(`<div class="ai-error">${escapeHtml(err.message || '锁定失败')}${tips ? `<br />推荐相邻时段：${escapeHtml(tips)}` : ''}</div>`);
  }
}

async function send(text) {
  const message = String(text || '').trim();
  if (!message || state.busy) return;
  if (message.length > AI_LIMITS.messageMax) {
    toast(`描述请控制在 ${AI_LIMITS.messageMax} 字以内`, 'warning');
    return;
  }
  state.busy = true;
  state.elements.send.disabled = true;
  state.elements.input.value = '';
  addUserMessage(message);
  const loading = addLoadingMessage();
  try {
    const payload = await api.ai.chat(message);
    loading.remove();
    addBotMessage(payload);
  } catch (err) {
    loading.remove();
    addSystemMessage(`<div class="ai-error">${escapeHtml(err.message || 'AI 助手暂时不可用')}</div>`);
  } finally {
    state.busy = false;
    state.elements.send.disabled = false;
    state.elements.input.focus();
  }
}

function buildQuickPrompts() {
  return `<div class="ai-quick">${QUICK_PROMPTS.map(
    (prompt) => `<button type="button" class="ai-quick__item" data-prompt="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`,
  ).join('')}</div>`;
}

function open() {
  if (!state.mounted) return;
  state.open = true;
  state.elements.panel.hidden = false;
  state.elements.panel.classList.add('is-open');
  state.elements.fab.classList.add('is-hidden');
  setTimeout(() => state.elements.input?.focus(), 50);
  scrollToEnd();
}

function close() {
  state.open = false;
  state.elements.panel.hidden = true;
  state.elements.panel.classList.remove('is-open');
  state.elements.fab.classList.remove('is-hidden');
}

export function mountAssistant() {
  if (state.mounted) return;
  state.mounted = true;

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'ai-fab';
  fab.id = 'ai-fab';
  fab.setAttribute('aria-label', '打开 AI 预约助手');
  fab.innerHTML = '🤖<span>AI 预约助手</span>';

  const panel = document.createElement('section');
  panel.className = 'ai-panel';
  panel.id = 'ai-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'AI 预约助手');
  panel.innerHTML = h`
    <header class="ai-panel__head">
      <div class="ai-panel__title">
        <strong>🤖 AI 预约助手</strong>
        <small id="ai-mode-badge">正在检测 AI 能力…</small>
      </div>
      <button type="button" class="ai-panel__close" id="ai-close" aria-label="关闭">×</button>
    </header>
    <div class="ai-panel__body" id="ai-messages"></div>
    <form class="ai-panel__form" id="ai-form">
      <input type="text" id="ai-input" maxlength="${AI_LIMITS.messageMax}" placeholder="例如：明天下午帮我订 2 小时羽毛球" autocomplete="off" />
      <button type="submit" class="btn btn--primary" id="ai-send">发送</button>
    </form>`;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  state.elements = {
    fab,
    panel,
    messages: panel.querySelector('#ai-messages'),
    input: panel.querySelector('#ai-input'),
    send: panel.querySelector('#ai-send'),
    close: panel.querySelector('#ai-close'),
    modeBadge: panel.querySelector('#ai-mode-badge'),
  };

  fab.addEventListener('click', open);
  state.elements.close.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  panel.querySelector('#ai-form').addEventListener('submit', (event) => {
    event.preventDefault();
    send(state.elements.input.value);
  });
  panel.addEventListener('click', (event) => {
    const quick = event.target.closest('[data-prompt]');
    if (quick) send(quick.dataset.prompt);
  });

  // 欢迎语 + 快捷话术
  addSystemMessage(`
    <div class="ai-welcome">
      <p>你好，我是 AI 预约助手 👋<br />用一句话告诉我你想做什么运动、什么时间，我来帮你找可约时段。</p>
      ${buildQuickPrompts()}
    </div>`);

  // 读取 AI 能力状态，显示当前是「大模型」还是「本地规则」
  api.ai
    .status()
    .then((status) => {
      const label = status.enabled ? `大模型：${status.model}` : '本地规则模式 · 未配置 API Key';
      state.elements.modeBadge.textContent = label;
      state.elements.modeBadge.dataset.mode = status.mode;
      // 未配置 Key 时，把"为什么"和"怎么开"直接告诉使用者
      if (!status.enabled) {
        addSystemMessage(`
          <div class="ai-welcome">
            <p>💡 当前为<b>本地规则模式</b>（离线可用，功能完整）。<br />
            想把回复升级为大模型：在<b>项目根目录</b>放一个 <code>.env</code> 文件（可复制 <code>.env.example</code>），
            填入 <code>AI_API_KEY=sk-...</code> 后重启服务即可。</p>
          </div>`);
      }
    })
    .catch(() => {
      state.elements.modeBadge.textContent = 'AI 能力检测失败';
    });
}
