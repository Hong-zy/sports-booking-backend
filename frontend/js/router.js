/**
 * 极简 hash 路由。
 *
 * 支持的路由由 shared/constants.js 的 ROUTES 决定：
 * #/  #/mine  #/notifications  #/profile  #/admin
 * 支持在 hash 后附带查询参数，例如 #/admin?tab=users。
 */

import { ROUTES } from '/shared/constants.js';

const DEFAULT_HASH = ROUTES[0].hash;

/** @returns {string} 规范化的路径，均以 / 开头，根路径为 "/" */
export function normalizePath(path) {
  let value = String(path ?? '').trim();
  if (!value) return '/';
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value;
}

/** 解析 hash -> { path, query, raw } */
export function parseHash(hash = window.location.hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const pathPart = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const queryPart = queryIndex >= 0 ? raw.slice(queryIndex + 1) : '';
  const path = normalizePath(pathPart);
  const query = {};
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    for (const [key, value] of params.entries()) query[key] = value;
  }
  return { path, query, raw };
}

/** 根据路径找到 ROUTES 配置 */
export function routeForPath(path) {
  const normalized = normalizePath(path);
  return (
    ROUTES.find((item) => normalizePath(item.hash.replace(/^#/, '')) === normalized) || null
  );
}

/** 把任意字符串规范化为可赋值给 location.hash 的形式 */
export function normalizeHash(target) {
  let value = String(target ?? '').trim();
  if (!value) return DEFAULT_HASH;
  if (!value.startsWith('#')) value = `#${value.startsWith('/') ? '' : '/'}${value}`;
  if (value === '#') return DEFAULT_HASH;
  return value;
}

/**
 * 读取当前路由；未知路径回退到默认页。
 * @returns {{path: string, route: object, query: object, known: boolean}}
 */
export function getCurrentRoute(hash = window.location.hash) {
  const parsed = parseHash(hash);
  const route = routeForPath(parsed.path);
  if (!route) {
    return { path: '/', route: ROUTES[0], query: parsed.query, known: false };
  }
  return { path: parsed.path, route, query: parsed.query, known: true };
}

/**
 * 跳转。
 * @param {string} target 例如 '#/mine' 或 '/mine'
 * @param {{replace?: boolean}} [options]
 */
export function navigate(target, { replace = false } = {}) {
  const hash = normalizeHash(target);
  if (replace) {
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
      // replaceState 不触发 hashchange，需要时由调用方自行刷新页面
    }
    return;
  }
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

/**
 * 启动路由监听。
 * @param {(routeInfo: ReturnType<typeof getCurrentRoute> & {path: string}) => void} onChange
 * @returns {() => void} 停止监听
 */
export function startRouter(onChange) {
  const renderFromHash = () => {
    const parsed = parseHash(window.location.hash);
    const info = getCurrentRoute(window.location.hash);

    if (!info.known) {
      // 未知地址：规范化成默认页，避免刷新后仍停在错误 hash
      window.history.replaceState(null, '', DEFAULT_HASH);
      const fallback = getCurrentRoute(DEFAULT_HASH);
      onChange({ ...fallback, path: '/' });
      return;
    }

    onChange({ ...info, path: parsed.path });
  };

  const onHashChange = () => renderFromHash();

  window.addEventListener('hashchange', onHashChange);

  if (!window.location.hash) {
    window.history.replaceState(null, '', DEFAULT_HASH);
  }

  renderFromHash();

  return () => {
    window.removeEventListener('hashchange', onHashChange);
  };
}
