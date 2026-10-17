/**
 * 通用 UI 组件与格式化工具。
 *
 * 所有拼接 HTML 的地方都要求调用方使用 escapeHtml 处理用户数据；
 * renderTable 会对普通字段自动转义，只有显式的 render 回调返回值会被当作可信 HTML。
 */

import {
  BOOKING_STATUS_LABEL,
  COURT_STATUS_LABEL,
  OVERRIDE_STATUS_LABEL,
  ROLE_LABEL,
  SLOT_STATUS_LABEL,
  VENUE_STATUS_LABEL,
} from '/shared/constants.js';
import { isDateString, minutesToText, weekdayLabel } from '/shared/time.js';

/* --------------------------------- 转义与格式化 -------------------------------- */

/** HTML 转义：文本节点和属性值都适用 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 金额：整数不显示小数，其余最多两位 */
export function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '¥0';
  return `¥${n.toLocaleString('zh-CN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 比率（0~1）-> 百分比文本 */
export function fmtPercent(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0%';
  return `${(n * 100).toFixed(digits)}%`;
}

/** "2026-10-17" -> "2026-10-17 周六" */
export function fmtDate(value, withWeekday = true) {
  if (!value) return '—';
  const text = String(value).slice(0, 10);
  if (!isDateString(text)) return String(value);
  return withWeekday ? `${text} ${weekdayLabel(text)}` : text;
}

/** ISO 时间 -> 本地 "YYYY-MM-DD HH:mm" */
export function fmtDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 分钟数 -> "1.5 小时" */
export function fmtMinutes(minutes) {
  return minutesToText(Number(minutes) || 0);
}

/** 秒数 -> "09:59" */
export function fmtCountdown(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 字节数 -> 人类可读大小 */
export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

/** 名字取前两个字作为头像文字 */
export function initials(name) {
  const text = String(name ?? '').trim();
  if (!text) return '游';
  return Array.from(text).slice(0, 2).join('');
}

/** 简单的防抖 */
export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/* ---------------------------------- 状态徽章 --------------------------------- */

const BADGE_LABELS = {
  booking: BOOKING_STATUS_LABEL,
  slot: SLOT_STATUS_LABEL,
  venue: VENUE_STATUS_LABEL,
  court: COURT_STATUS_LABEL,
  override: OVERRIDE_STATUS_LABEL,
  role: ROLE_LABEL,
};

const BADGE_TONES = {
  booking: { confirmed: 'success', cancelled: 'danger', completed: 'neutral' },
  slot: {
    available: 'success',
    locked: 'warning',
    booked: 'muted',
    maintenance: 'danger',
    closed: 'neutral',
  },
  venue: { open: 'success', paused: 'warning' },
  court: { open: 'success', closed: 'neutral' },
  override: { maintenance: 'warning', closed: 'danger' },
  role: { user: 'neutral', admin: 'accent' },
};

/**
 * @param {string} status
 * @param {'booking'|'slot'|'venue'|'court'|'override'|'role'} [kind]
 */
export function statusBadge(status, kind = 'booking') {
  const key = String(status ?? '');
  const label = BADGE_LABELS[kind]?.[key] ?? (key || '—');
  const tone = BADGE_TONES[kind]?.[key] ?? 'neutral';
  return `<span class="badge badge--${tone}"><span class="badge__dot"></span>${escapeHtml(label)}</span>`;
}

/* ----------------------------------- Toast -------------------------------- */

const TOAST_ICONS = { success: '✓', error: '✕', warning: '!', info: 'i' };

function toastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    root.setAttribute('aria-live', 'polite');
    document.body.appendChild(root);
  }
  return root;
}

function removeToast(node) {
  if (!node || !node.isConnected) return;
  node.classList.remove('is-visible');
  window.setTimeout(() => node.remove(), 220);
}

/**
 * 统一提示，不使用浏览器 alert。
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 */
export function toast(message, type = 'info', options = {}) {
  if (typeof document === 'undefined') return;
  const safeType = Object.hasOwn(TOAST_ICONS, type) ? type : 'info';
  const root = toastRoot();
  const item = document.createElement('div');
  item.className = `toast toast--${safeType}`;
  item.setAttribute('role', safeType === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'toast__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = TOAST_ICONS[safeType];

  const text = document.createElement('span');
  text.className = 'toast__message';
  text.textContent = String(message ?? '');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast__close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', () => removeToast(item));

  item.append(icon, text, close);
  root.appendChild(item);

  // 最多保留 5 条，避免刷屏
  const items = [...root.querySelectorAll('.toast')];
  if (items.length > 5) items.slice(0, items.length - 5).forEach(removeToast);

  requestAnimationFrame(() => item.classList.add('is-visible'));

  const defaultDuration = safeType === 'error' ? 5200 : safeType === 'success' ? 2600 : 3600;
  const duration = Number(options.duration) > 0 ? Number(options.duration) : defaultDuration;
  window.setTimeout(() => removeToast(item), duration);
}

/* ----------------------------------- Modal -------------------------------- */

const modalStack = [];

function syncModalScroll() {
  document.body.classList.toggle('modal-open', modalStack.length > 0);
}

function focusFirst(overlay) {
  const target =
    overlay.querySelector('[autofocus]') ||
    overlay.querySelector(
      '.modal__body input:not([disabled]):not([type="hidden"]), .modal__body select:not([disabled]), .modal__body textarea:not([disabled])',
    ) ||
    overlay.querySelector('.modal__footer .btn--primary, .modal__footer .btn--danger') ||
    overlay.querySelector('.modal__close:not([hidden])');
  target?.focus?.();
}

function actionButtonClass(variant) {
  const allowed = new Set(['primary', 'danger', 'ghost']);
  return `btn ${allowed.has(variant) ? `btn--${variant}` : 'btn--secondary'}`;
}

/**
 * 打开一个自绘 Modal。
 *
 * body 接受 Node 或字符串（字符串调用方必须自行保证 HTML 安全）。
 * actions[].onClick 返回 Promise 时按钮会自动进入 loading 态；
 * 抛出的异常会 toast，并保留 Modal。
 *
 * @param {{
 *   title?: string,
 *   body?: string|Node,
 *   actions?: Array<{key?: string,label: string,variant?: string,loadingText?: string,disabled?: boolean,onClick?: Function}>,
 *   size?: 'sm'|'md'|'lg'|'xl',
 *   closable?: boolean,
 *   onClose?: Function,
 * }} options
 */
export function openModal(options = {}) {
  const {
    title = '提示',
    body = '',
    actions = [],
    size = 'md',
    closable = true,
    onClose,
  } = options;

  let closed = false;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const safeSize = ['sm', 'md', 'lg', 'xl'].includes(size) ? size : 'md';
  const titleId = `modal-title-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  overlay.innerHTML = `
    <div class="modal modal--${safeSize}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal__header">
        <h2 class="modal__title" id="${titleId}"></h2>
        <button type="button" class="modal__close" aria-label="关闭弹窗">×</button>
      </div>
      <div class="modal__error" role="alert" hidden></div>
      <div class="modal__body"></div>
      <div class="modal__footer"></div>
    </div>
  `;

  const panel = overlay.querySelector('.modal');
  const titleEl = overlay.querySelector('.modal__title');
  const bodyEl = overlay.querySelector('.modal__body');
  const footerEl = overlay.querySelector('.modal__footer');
  const errorEl = overlay.querySelector('.modal__error');
  const closeBtn = overlay.querySelector('.modal__close');

  titleEl.textContent = title;
  if (body instanceof Node) bodyEl.appendChild(body);
  else bodyEl.innerHTML = body;

  closeBtn.hidden = !closable;

  const buttons = Object.create(null);
  const modal = {
    root: overlay,
    panel,
    body: bodyEl,
    footer: footerEl,
    titleEl,
    buttons,
    close,
    setTitle(nextTitle) {
      titleEl.textContent = String(nextTitle ?? '');
    },
    setError(message) {
      if (!message) {
        errorEl.hidden = true;
        errorEl.textContent = '';
        return;
      }
      errorEl.hidden = false;
      errorEl.textContent = String(message);
    },
  };

  for (const [index, action] of actions.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = actionButtonClass(action.variant);
    button.textContent = action.label;
    if (action.key) {
      button.dataset.modalAction = action.key;
      buttons[action.key] = button;
    }
    button.disabled = Boolean(action.disabled);

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      // 未提供业务回调的按钮（如“取消”“关闭”）默认只关闭弹窗
      if (typeof action.onClick !== 'function') {
        close();
        return;
      }
      const original = button.textContent;
      let busy = false;
      try {
        const result = action.onClick?.(modal);
        if (result && typeof result.then === 'function') {
          busy = true;
          button.disabled = true;
          button.classList.add('is-loading');
          button.innerHTML = '<span class="spinner spinner--sm" aria-hidden="true"></span>处理中…';
          await result;
        }
      } catch (err) {
        console.error('[modal action]', err);
        if (err?.name !== 'AbortError') {
          modal.setError(err?.message || '操作失败，请稍后重试');
          toast(err?.message || '操作失败，请稍后重试', 'error');
        }
      } finally {
        if (busy && button.isConnected) {
          button.disabled = false;
          button.classList.remove('is-loading');
          button.textContent = original;
        }
      }
    });

    footerEl.appendChild(button);
    // 兜底：未提供 key 时也保留索引访问能力
    if (!action.key) buttons[`action${index}`] = button;
  }

  if (!actions.length) footerEl.remove();

  function close() {
    if (closed) return;
    closed = true;
    overlay.classList.remove('is-open');
    document.removeEventListener('keydown', onKeydown);
    window.setTimeout(() => overlay.remove(), 160);
    const stackIndex = modalStack.findIndex((item) => item.overlay === overlay);
    if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
    syncModalScroll();
    onClose?.();
  }

  const onKeydown = (event) => {
    if (event.key !== 'Escape' || !closable) return;
    const top = modalStack[modalStack.length - 1];
    if (top?.overlay === overlay) {
      event.preventDefault();
      close();
    }
  };

  const previouslyFocused = document.activeElement;

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && closable) close();
  });
  document.addEventListener('keydown', onKeydown);

  const root = document.getElementById('modal-root') || document.body;
  root.appendChild(overlay);
  modalStack.push({ overlay, close });
  syncModalScroll();
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    focusFirst(overlay);
  });

  // 关闭后把焦点还给触发元素（仅当没有其他 Modal 打开）
  if (!closable) closeBtn.hidden = true;
  const observer = new MutationObserver(() => {
    if (!overlay.isConnected) {
      observer.disconnect();
      if (!modalStack.length && previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus?.();
      }
    }
  });
  observer.observe(document.body, { childList: true });

  // 避免调用方在 onClose 中同步抛错影响清理
  return modal;
}

/**
 * 自绘确认框，不使用 window.confirm。
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = '请确认',
  message = '确定要执行此操作吗？',
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let modal = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal?.close();
      resolve(value);
    };

    const messageEl = document.createElement('p');
    messageEl.className = 'confirm-message';
    messageEl.textContent = message;

    modal = openModal({
      title,
      size: 'sm',
      body: messageEl,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
      actions: [
        { key: 'cancel', label: cancelText, variant: 'ghost', onClick: () => finish(false) },
        {
          key: 'ok',
          label: confirmText,
          variant: danger ? 'danger' : 'primary',
          onClick: () => finish(true),
        },
      ],
    });
  });
}

/** 关闭全部弹窗（例如登录态失效时清理现场） */
export function closeAllModals() {
  for (const { close } of [...modalStack].reverse()) close();
}

/* ---------------------------------- 渲染块 --------------------------------- */

export function loadingHtml(text = '加载中…') {
  return `<div class="state-block"><span class="spinner" aria-hidden="true"></span><p>${escapeHtml(
    text,
  )}</p></div>`;
}

export function emptyState(title, description = '', icon = '🗓') {
  return `<div class="state-block state-block--empty">
    <span class="state-block__icon" aria-hidden="true">${escapeHtml(icon)}</span>
    <h3>${escapeHtml(title)}</h3>
    ${description ? `<p>${escapeHtml(description)}</p>` : ''}
  </div>`;
}

/** 把校验错误渲染进一个容器（会覆盖原有内容） */
export function renderFormErrors(container, errors = []) {
  if (!container) return;
  const list = Array.isArray(errors) ? errors.filter(Boolean) : errors ? [String(errors)] : [];
  if (!list.length) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = `<ul class="form-errors">${list
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')}</ul>`;
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[对象]';
    }
  }
  return String(value);
}

/**
 * 通用表格渲染（返回 HTML 字符串）。
 *
 * columns: [{ key?, label, render?, className?, align? }]
 * - 未提供 render 时，字段会自动转义；
 * - render(row, index) 返回可信 HTML，调用方必须自行 escapeHtml 用户数据。
 */
export function renderTable({ columns = [], rows = [], emptyText = '暂无数据' } = {}) {
  const head = columns
    .map((column) => {
      const align = ['left', 'center', 'right'].includes(column.align) ? ` is-${column.align}` : '';
      const className = column.className ? ` class="${escapeHtml(column.className)}"` : '';
      return `<th${className}><span class="th-inner${align}">${escapeHtml(column.label)}</span></th>`;
    })
    .join('');

  const body = rows.length
    ? rows
        .map((row, rowIndex) => {
          const cells = columns
            .map((column) => {
              let content;
              if (typeof column.render === 'function') {
                content = column.render(row, rowIndex);
              } else {
                content = escapeHtml(displayValue(row?.[column.key]));
              }
              const align = ['left', 'center', 'right'].includes(column.align)
                ? ` is-${column.align}`
                : '';
              const className = column.className ? ` ${column.className}` : '';
              return `<td class="cell${align}${className}">${content ?? ''}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('')
    : `<tr><td class="table-empty" colspan="${Math.max(columns.length, 1)}">${escapeHtml(
        emptyText,
      )}</td></tr>`;

  return `<div class="table-wrap"><table class="data-table">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/** 按钮 loading（会恢复原有内容与 disabled 状态） */
export async function withBusy(button, task, loadingText = '处理中…') {
  if (!button) return task();
  const originalHtml = button.innerHTML;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add('is-loading');
  button.innerHTML = `<span class="spinner spinner--sm" aria-hidden="true"></span>${escapeHtml(
    loadingText,
  )}`;
  try {
    return await task();
  } finally {
    if (button.isConnected) {
      button.disabled = wasDisabled;
      button.classList.remove('is-loading');
      button.innerHTML = originalHtml;
    }
  }
}
