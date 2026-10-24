/**
 * 后端 API 封装。
 *
 * 职责：
 * 1. 统一拼 /api 前缀与查询参数；
 * 2. 自动附加 Authorization: Bearer <token>；
 * 3. 把后端统一的 `{ error: { status, message, suggestions } }` 转成 ApiError；
 * 4. 401 时清空登录态并广播事件；
 * 5. 提供 SSE 订阅。
 */

import { API_PREFIX, SSE_PATH } from '/shared/constants.js';
import { store } from './store.js';

export const AUTH_EXPIRED_EVENT = 'app:auth-expired';

/** 这些接口的 401 属于业务结果（账号密码错误等），不应触发“登录已失效” */
const AUTH_FREE_PATHS = new Set(['/auth/login', '/auth/register']);

export class ApiError extends Error {
  constructor(status, message, payload = null) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.status = Number(status) || 0;
    this.payload = payload;
    this.error = payload?.error || null;
    this.suggestions = Array.isArray(payload?.error?.suggestions) ? payload.error.suggestions : [];
    this.conflicts = Array.isArray(payload?.error?.conflicts) ? payload.error.conflicts : [];
  }
}

function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 避免多个并发 401 重复弹提示 */
let lastAuthExpiredAt = 0;

function notifyAuthExpired(message) {
  const now = Date.now();
  if (now - lastAuthExpiredAt < 1000) return;
  lastAuthExpiredAt = now;
  try {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: { message } }));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path 以 / 开头，不包含 /api
 * @param {object} [options]
 * @param {object} [options.body]
 * @param {object} [options.query]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.skipAuthExpiry] 401 时不触发全局登出（登录/注册用）
 */
export async function request(method, path, options = {}) {
  const { body, query, signal, skipAuthExpiry = AUTH_FREE_PATHS.has(path) } = options;
  const url = `${API_PREFIX}${path}${queryString(query)}`;
  const headers = { Accept: 'application/json' };

  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (store.token) headers.Authorization = `Bearer ${store.token}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      signal,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, '网络连接失败，请确认后端服务已启动');
  }

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const info = data?.error;
    const message =
      (info && typeof info.message === 'string' && info.message) ||
      (response.status === 404
        ? '接口不存在或服务尚未更新'
        : `请求失败（HTTP ${response.status}）`);

    if (response.status === 401) {
      const wasLoggedIn = Boolean(store.token);
      store.clearAuth();
      if (!skipAuthExpiry && wasLoggedIn) notifyAuthExpired(message);
    }
    throw new ApiError(response.status, message, data);
  }

  if (response.status === 204 || raw === '') return null;
  if (data === null) {
    throw new ApiError(response.status, '服务器返回了非 JSON 数据');
  }
  return data;
}

export const api = {
  /* --------------------------------- 账号 --------------------------------- */
  auth: {
    login(account, password) {
      return request('POST', '/auth/login', { body: { account, password }, skipAuthExpiry: true });
    },
    register(payload) {
      return request('POST', '/auth/register', { body: payload, skipAuthExpiry: true });
    },
  },

  me: {
    get() {
      return request('GET', '/me');
    },
    update(patch) {
      return request('PATCH', '/me', { body: patch });
    },
    changePassword(oldPassword, newPassword) {
      return request('POST', '/me/password', { body: { oldPassword, newPassword } });
    },
    verify(realName, idCard) {
      return request('POST', '/me/verify', { body: { realName, idCard } });
    },
  },

  /* ------------------------------- 场馆与时段 ------------------------------- */
  venues: {
    sports() {
      return request('GET', '/sports');
    },
    list({ sport, keyword, date } = {}) {
      return request('GET', '/venues', { query: { sport, keyword, date } });
    },
    detail(id, date) {
      return request('GET', `/venues/${encodeURIComponent(id)}`, { query: { date } });
    },
    availability(id, date) {
      return request('GET', `/venues/${encodeURIComponent(id)}/availability`, { query: { date } });
    },
    search({ sport, date, startTime, endTime } = {}) {
      return request('GET', '/availability', { query: { sport, date, startTime, endTime } });
    },
  },

  /* --------------------------------- 预约 --------------------------------- */
  bookings: {
    lock(payload) {
      return request('POST', '/bookings/lock', { body: payload });
    },
    create(lockId) {
      return request('POST', '/bookings', { body: { lockId } });
    },
    mine({ status, date } = {}) {
      return request('GET', '/bookings/mine', { query: { status, date } });
    },
    cancel(id, reason) {
      return request('POST', `/bookings/${encodeURIComponent(id)}/cancel`, { body: { reason } });
    },
  },

  /* --------------------------------- 消息 --------------------------------- */
  notifications: {
    list({ unread } = {}) {
      return request('GET', '/notifications', { query: unread ? { unread: '1' } : {} });
    },
    markRead(ids) {
      return request('POST', '/notifications/read', {
        body: Array.isArray(ids) && ids.length ? { ids } : {},
      });
    },
  },

  /* -------------------------------- 管理后台 -------------------------------- */
  admin: {
    createVenue(payload) {
      return request('POST', '/admin/venues', { body: payload });
    },
    updateVenue(id, payload) {
      return request('PATCH', `/admin/venues/${encodeURIComponent(id)}`, { body: payload });
    },
    deleteVenue(id) {
      return request('DELETE', `/admin/venues/${encodeURIComponent(id)}`);
    },

    createCourt(venueId, payload) {
      return request('POST', `/admin/venues/${encodeURIComponent(venueId)}/courts`, { body: payload });
    },
    updateCourt(id, payload) {
      return request('PATCH', `/admin/courts/${encodeURIComponent(id)}`, { body: payload });
    },
    deleteCourt(id) {
      return request('DELETE', `/admin/courts/${encodeURIComponent(id)}`);
    },

    createOverride(payload) {
      return request('POST', '/admin/overrides', { body: payload });
    },
    listOverrides({ date, courtId } = {}) {
      return request('GET', '/admin/overrides', { query: { date, courtId } });
    },
    deleteOverride(id) {
      return request('DELETE', `/admin/overrides/${encodeURIComponent(id)}`);
    },

    listBookings({ date, status } = {}) {
      return request('GET', '/admin/bookings', { query: { date, status } });
    },
    cancelBooking(id, reason) {
      return request('POST', `/admin/bookings/${encodeURIComponent(id)}/cancel`, { body: { reason } });
    },

    listUsers(q) {
      return request('GET', '/admin/users', { query: { q } });
    },
    updateUser(id, patch) {
      return request('PATCH', `/admin/users/${encodeURIComponent(id)}`, { body: patch });
    },
    deleteUser(id) {
      return request('DELETE', `/admin/users/${encodeURIComponent(id)}`);
    },

    report(days = 7) {
      return request('GET', '/admin/report', { query: { days } });
    },
    stats() {
      return request('GET', '/admin/stats');
    },
    table(table, { limit, offset, q } = {}) {
      return request('GET', `/admin/db/${encodeURIComponent(table)}`, { query: { limit, offset, q } });
    },
    aiInsights(days = 7) {
      return request('GET', '/admin/ai/insights', { query: { days } });
    },
  },

  /* ---------------------------------- AI ---------------------------------- */
  ai: {
    status() {
      return request('GET', '/ai/status');
    },
    chat(message) {
      return request('POST', '/ai/chat', { body: { message } });
    },
    recommend(payload) {
      return request('POST', '/ai/recommend', { body: payload });
    },
  },
};

export const SSE_EVENTS = [
  'ready',
  'slot.locked',
  'slot.released',
  'booking.created',
  'booking.cancelled',
  'slot.status',
  'venue.updated',
];

/**
 * 订阅实时状态。EventSource 自带断线重连，出错时只通知 UI 状态。
 * @param {{date?: string, venueId?: number|string}} params
 * @param {{onEvent?: (type: string, data: any) => void, onStatus?: (status: 'open'|'error'|'closed') => void}} handlers
 * @returns {() => void} 关闭订阅
 */
export function subscribeStream({ date, venueId } = {}, handlers = {}) {
  if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
    handlers.onStatus?.('error');
    return () => {};
  }

  const query = queryString({ date, venueId });
  const source = new EventSource(`${SSE_PATH}${query}`);
  let closed = false;

  source.onopen = () => {
    if (!closed) handlers.onStatus?.('open');
  };
  source.onerror = () => {
    if (!closed) handlers.onStatus?.('error');
  };

  const listener = (event) => {
    if (closed) return;
    let data = null;
    try {
      data = event.data ? JSON.parse(event.data) : null;
    } catch {
      data = event.data;
    }
    handlers.onEvent?.(event.type, data);
  };

  for (const name of SSE_EVENTS) source.addEventListener(name, listener);
  source.addEventListener('message', listener);

  return () => {
    if (closed) return;
    closed = true;
    source.close();
    handlers.onStatus?.('closed');
  };
}
