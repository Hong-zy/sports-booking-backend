/**
 * 全局状态。
 *
 * 这里只保存跨页面共享的少量状态：
 * - 登录 token / 当前用户 / 用户统计 / 未读消息数
 * - 场馆预约页当前筛选与选中的时段（离开页面再回来仍能保留）
 *
 * 页面内的临时数据（列表、表单输入、倒计时等）由各页面自己维护。
 */

import { todayString } from '/shared/time.js';

const TOKEN_KEY = 'sports-booking:token';
const USER_KEY = 'sports-booking:user';

/** localStorage 在隐私模式/被禁用时可能抛异常，统一兜底 */
function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    /* 忽略存储异常，只影响刷新后的记忆 */
  }
}

function readUser() {
  const raw = readStorage(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const state = {
  token: readStorage(TOKEN_KEY) || '',
  user: readUser(),
  stats: null,
  unreadCount: 0,
  /** 场馆预约页的选择，日期默认今天 */
  selection: {
    sport: '',
    keyword: '',
    date: todayString(),
    live: true,
    venueId: null,
    courtId: null,
    startTime: null,
    endTime: null,
  },
};

const listeners = new Set();

function notify(kind) {
  for (const listener of [...listeners]) {
    try {
      listener(state, kind);
    } catch (err) {
      console.error('[store] listener error', err);
    }
  }
}

export const store = {
  get token() {
    return state.token;
  },

  get user() {
    return state.user;
  },

  get stats() {
    return state.stats;
  },

  get unreadCount() {
    return state.unreadCount;
  },

  get isLoggedIn() {
    return Boolean(state.token);
  },

  get isAdmin() {
    return state.user?.role === 'admin';
  },

  /** 只读快照，便于调试和页面初始化 */
  getState() {
    return state;
  },

  getSelection() {
    return { ...state.selection };
  },

  setSelection(patch = {}) {
    Object.assign(state.selection, patch);
    notify('selection');
  },

  /** 切换场馆/日期时清空时段选择 */
  clearSlotSelection() {
    state.selection.courtId = null;
    state.selection.startTime = null;
    state.selection.endTime = null;
    notify('selection');
  },

  setAuth(token, user) {
    state.token = token || '';
    state.user = user || null;
    writeStorage(TOKEN_KEY, state.token || null);
    writeStorage(USER_KEY, state.user ? JSON.stringify(state.user) : null);
    notify('auth');
  },

  setUser(user) {
    if (!user) {
      state.user = null;
      writeStorage(USER_KEY, null);
      notify('user');
      return;
    }
    state.user = { ...(state.user || {}), ...user };
    writeStorage(USER_KEY, JSON.stringify(state.user));
    notify('user');
  },

  setStats(stats) {
    state.stats = stats || null;
    notify('stats');
  },

  setUnreadCount(count) {
    const next = Math.max(0, Number(count) || 0);
    if (state.unreadCount === next) return;
    state.unreadCount = next;
    notify('unread');
  },

  clearAuth() {
    state.token = '';
    state.user = null;
    state.stats = null;
    state.unreadCount = 0;
    state.selection.courtId = null;
    state.selection.startTime = null;
    state.selection.endTime = null;
    writeStorage(TOKEN_KEY, null);
    writeStorage(USER_KEY, null);
    notify('auth');
  },

  /** @returns {() => void} 取消订阅 */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
