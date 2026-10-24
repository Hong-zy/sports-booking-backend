/**
 * 应用入口。
 *
 * 负责：
 * - 登录态恢复与全局事件
 * - 顶部导航 / 登录注册弹窗 / 路由守卫
 * - 页面挂载与卸载
 */

import { APP_NAME, APP_VERSION, ROLE_LABEL, ROUTES } from '/shared/constants.js';
import { validateRegister } from '/shared/validate.js';
import { AUTH_EXPIRED_EVENT, api } from './api.js';
import { getCurrentRoute, navigate, startRouter } from './router.js';
import { store } from './store.js';
import {
  closeAllModals,
  confirmDialog,
  escapeHtml,
  initials,
  openModal,
  renderFormErrors,
  toast,
} from './ui.js';
import { renderAdminPage } from './pages/admin.js';
import { mountAssistant } from './pages/assistant.js';
import {
  renderMinePage,
  renderNotificationsPage,
  renderProfilePage,
  renderVenuePage,
} from './pages/user.js';

const headerEl = document.getElementById('app-header');
const appEl = document.getElementById('app');
const footerVersionEl = document.getElementById('app-version');

const PAGE_RENDERERS = {
  '/': renderVenuePage,
  '/mine': renderMinePage,
  '/notifications': renderNotificationsPage,
  '/profile': renderProfilePage,
  '/admin': renderAdminPage,
};

let currentPath = '/';
let currentRoute = ROUTES[0];
let pageCleanup = null;
let pageRenderSeq = 0;
let renderedGate = false;
let authModal = null;
let bootstrapping = true;

/* ========================================================================== */
/*                                  顶部导航                                  */
/* ========================================================================== */

function routePath(route) {
  return route.hash.replace(/^#/, '') || '/';
}

function navLink(route) {
  const active = routePath(route) === currentPath;
  const unread = route.hash === '#/notifications' ? store.unreadCount : 0;
  return `<a class="main-nav__link${active ? ' is-active' : ''}" href="${escapeHtml(
    route.hash,
  )}" data-nav-hash="${escapeHtml(route.hash)}" ${active ? 'aria-current="page"' : ''}>
    <span class="main-nav__icon" aria-hidden="true">${escapeHtml(route.icon || '')}</span>
    <span>${escapeHtml(route.label)}</span>
    ${unread ? `<span class="nav-badge" aria-label="${unread} 条未读消息">${
      unread > 99 ? '99+' : escapeHtml(unread)
    }</span>` : ''}
  </a>`;
}

function renderHeader() {
  if (!headerEl) return;
  const user = store.user;
  const visibleRoutes = ROUTES.filter((route) => !route.admin || store.isAdmin);
  const roleLabel = ROLE_LABEL[user?.role] || '';

  const userArea = store.isLoggedIn
    ? `<button type="button" class="user-chip" data-header-action="profile" title="进入个人中心">
        <span class="avatar">${escapeHtml(initials(user?.name))}</span>
        <span class="user-chip__text">
          <strong>${escapeHtml(user?.name || '已登录用户')}</strong>
          <small>${
            roleLabel ? `<span class="user-chip__role">${escapeHtml(roleLabel)} · </span>` : ''
          }积分 ${escapeHtml(user?.points ?? 0)}</small>
        </span>
      </button>
      <button type="button" class="btn btn--ghost btn--sm" data-header-action="logout">退出</button>`
    : `<button type="button" class="btn btn--ghost btn--sm" data-header-action="login">登录</button>
       <button type="button" class="btn btn--primary btn--sm" data-header-action="register">注册</button>`;

  headerEl.innerHTML = `<div class="header-inner">
    <a class="brand" href="#/" data-nav-hash="#/" aria-label="${escapeHtml(APP_NAME)} 首页">
      <span class="brand__logo" aria-hidden="true">🏟</span>
      <span class="brand__text">
        <strong>${escapeHtml(APP_NAME)}</strong>
        <small>SPORTS BOOKING</small>
      </span>
    </a>
    <nav class="main-nav" aria-label="主要导航">
      ${visibleRoutes.map(navLink).join('')}
    </nav>
    <div class="header-user">${userArea}</div>
  </div>`;
}

function routeInfoByHash(hash) {
  const normalized = String(hash || '#/');
  return getCurrentRoute(normalized.startsWith('#') ? normalized : `#${normalized}`);
}

function handleNavigation(hash) {
  const info = routeInfoByHash(hash);
  if (!info.known) {
    navigate('#/');
    return;
  }
  if (info.route.auth && !store.isLoggedIn) {
    openAuthModal('login', info.route.hash);
    return;
  }
  if (info.route.admin && !store.isAdmin) {
    toast('仅管理员可访问管理后台', 'warning');
    return;
  }
  navigate(info.route.hash);
  // 已经处在目标页（例如用户点击当前 tab）时，主动重绘以刷新数据
  if (routePath(info.route) === currentPath) {
    renderCurrentPage(true);
  }
}

headerEl?.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-nav-hash]');
  if (nav) {
    event.preventDefault();
    handleNavigation(nav.dataset.navHash);
    return;
  }
  const actionEl = event.target.closest('[data-header-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.headerAction;
  if (action === 'login') openAuthModal('login');
  if (action === 'register') openAuthModal('register');
  if (action === 'profile') {
    handleNavigation('#/profile');
  }
  if (action === 'logout') {
    logout();
  }
});

async function logout() {
  const ok = await confirmDialog({
    title: '退出登录',
    message: '确定要退出当前账号吗？退出后仍可浏览场馆，但需登录后才能预约。',
    confirmText: '退出登录',
    danger: true,
  });
  if (!ok) return;
  closeAllModals();
  store.clearAuth();
  toast('已退出登录', 'info');
  if (currentPath !== '/') navigate('#/');
  else renderCurrentPage(true);
}

/* ========================================================================== */
/*                                 登录 / 注册                                */
/* ========================================================================== */

function formErrorsEl(form) {
  return form.querySelector('[data-form-errors]');
}

function setAuthErrors(form, errors) {
  if (!form) return;
  renderFormErrors(formErrorsEl(form), errors);
}

function readLoginForm(form) {
  return {
    account: form.elements.account.value.trim(),
    password: form.elements.password.value,
  };
}

function readRegisterForm(form) {
  return {
    name: form.elements.name.value.trim(),
    phone: form.elements.phone.value.trim(),
    email: form.elements.email.value.trim(),
    password: form.elements.password.value,
  };
}

function validateLogin(values) {
  const errors = [];
  if (!values.account) errors.push('请填写手机号或邮箱');
  if (!values.password) errors.push('请填写密码');
  return errors;
}

async function syncMeAfterLogin() {
  try {
    const me = await api.me.get();
    if (!store.isLoggedIn) return;
    const { stats, ...user } = me || {};
    store.setUser(user);
    store.setStats(stats || null);
  } catch (err) {
    if (err?.status !== 401 && err?.status !== 403) {
      console.warn('[auth] 拉取个人信息失败', err);
    }
  }
}

async function loadUnreadCount() {
  if (!store.isLoggedIn) {
    store.setUnreadCount(0);
    return;
  }
  try {
    const list = await api.notifications.list({ unread: true });
    if (store.isLoggedIn) store.setUnreadCount(Array.isArray(list) ? list.length : 0);
  } catch (err) {
    if (err?.status !== 401) console.warn('[unread] 加载未读数失败', err);
  }
}

function openAuthModal(initialMode = 'login', targetHash = null) {
  if (authModal) {
    authModal.close();
    authModal = null;
  }
  closeAllModals();

  let mode = initialMode === 'register' ? 'register' : 'login';

  const body = document.createElement('div');
  body.className = 'auth-dialog';
  body.innerHTML = `
    <div class="auth-tabs" role="tablist" aria-label="登录或注册">
      <button type="button" class="auth-tab" role="tab" data-auth-mode="login">登录</button>
      <button type="button" class="auth-tab" role="tab" data-auth-mode="register">注册</button>
    </div>
    <div data-auth-panel="login">
      <form id="auth-login-form" novalidate>
        <label class="field">
          <span class="field__label">手机号 / 邮箱</span>
          <input class="input" name="account" autocomplete="username" placeholder="请输入注册时使用的手机号或邮箱" />
        </label>
        <label class="field">
          <span class="field__label">密码</span>
          <input class="input" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" />
        </label>
        <div class="form-errors" data-form-errors hidden></div>
      </form>
      <p class="auth-hint">登录后可预约场地、查看预约凭证与消息通知。</p>
    </div>
    <div data-auth-panel="register" hidden>
      <form id="auth-register-form" novalidate>
        <div class="form-row">
          <label class="field">
            <span class="field__label">昵称</span>
            <input class="input" name="name" autocomplete="nickname" maxlength="40" placeholder="怎么称呼你" />
          </label>
          <label class="field">
            <span class="field__label">手机号</span>
            <input class="input" name="phone" inputmode="tel" autocomplete="tel" placeholder="手机号或邮箱至少填一项" />
          </label>
        </div>
        <label class="field">
          <span class="field__label">邮箱</span>
          <input class="input" name="email" type="email" autocomplete="email" placeholder="手机号或邮箱至少填一项" />
        </label>
        <label class="field">
          <span class="field__label">密码</span>
          <input class="input" name="password" type="password" autocomplete="new-password" placeholder="至少 6 位密码" />
        </label>
        <div class="form-errors" data-form-errors hidden></div>
      </form>
      <p class="auth-hint">注册即表示你同意使用本系统进行场馆预约与凭证管理。</p>
    </div>
  `;

  const loginForm = body.querySelector('#auth-login-form');
  const registerForm = body.querySelector('#auth-register-form');
  const tabs = [...body.querySelectorAll('[data-auth-mode]')];
  const panels = [...body.querySelectorAll('[data-auth-panel]')];

  const modal = openModal({
    title: '登录账号',
    size: 'sm',
    body,
    actions: [
      { label: '取消', variant: 'ghost' },
      {
        key: 'submit',
        label: '登录',
        variant: 'primary',
        loadingText: '请稍候…',
        onClick: async () => {
          const submittedMode = mode;
          const activeForm = submittedMode === 'login' ? loginForm : registerForm;
          setAuthErrors(loginForm, []);
          setAuthErrors(registerForm, []);
          const values =
            submittedMode === 'login' ? readLoginForm(loginForm) : readRegisterForm(registerForm);
          const errors =
            submittedMode === 'login' ? validateLogin(values) : validateRegister(values);
          if (errors.length) {
            setAuthErrors(activeForm, errors);
            toast(errors[0], 'warning');
            activeForm.querySelector('input')?.focus();
            return;
          }
          try {
            const result =
              submittedMode === 'login'
                ? await api.auth.login(values.account, values.password)
                : await api.auth.register(values);
            if (!result?.token || !result?.user) throw new Error('登录响应格式不正确');
            store.setAuth(result.token, result.user);
            authModal = null;
            modal.close();
            toast(
              submittedMode === 'login'
                ? `欢迎回来，${result.user.name || '朋友'}`
                : '注册成功，已为你登录',
              'success',
            );
            await syncMeAfterLogin();
            loadUnreadCount();

            if (targetHash) {
              const target = routeInfoByHash(targetHash);
              if (target.route.admin && !store.isAdmin) {
                toast('该账号没有管理后台权限', 'warning');
                navigate('#/');
                return;
              }
              if (target.known && routePath(target.route) !== currentPath) {
                navigate(target.route.hash);
                return;
              }
            }
            if (renderedGate) renderCurrentPage(true);
          } catch (err) {
            setAuthErrors(activeForm, [err?.message || '登录失败，请稍后重试']);
            toast(err?.message || '登录失败，请稍后重试', 'error');
          }
        },
      },
    ],
    onClose: () => {
      if (authModal === modal) authModal = null;
    },
  });
  authModal = modal;

  function switchMode(nextMode) {
    mode = nextMode === 'register' ? 'register' : 'login';
    tabs.forEach((tab) => {
      const active = tab.dataset.authMode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.authPanel !== mode;
    });
    modal.setTitle(mode === 'login' ? '登录账号' : '创建账号');
    const submit = modal.buttons.submit;
    if (submit) submit.textContent = mode === 'login' ? '登录' : '注册';
    modal.setError('');
    setAuthErrors(loginForm, []);
    setAuthErrors(registerForm, []);
    requestAnimationFrame(() => {
      const form = mode === 'login' ? loginForm : registerForm;
      form.querySelector('input')?.focus();
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchMode(tab.dataset.authMode));
  });
  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    modal.buttons.submit?.click();
  });
  registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    modal.buttons.submit?.click();
  });

  switchMode(mode);
  requestAnimationFrame(() => {
    const form = mode === 'login' ? loginForm : registerForm;
    form.querySelector('input')?.focus();
  });
}

/* ========================================================================== */
/*                                 页面挂载                                   */
/* ========================================================================== */

function gatePageFor(route) {
  const labels = {
    '/mine': '查看预约记录与凭证',
    '/notifications': '查看预约动态与系统消息',
    '/profile': '管理个人资料与实名信息',
    '/admin': '进入管理后台',
  };
  return `<section class="gate-card card">
    <span class="gate-card__icon" aria-hidden="true">🔐</span>
    <p class="eyebrow">${escapeHtml(APP_NAME)}</p>
    <h1>登录后${escapeHtml(labels[routePath(route)] || '继续使用')}</h1>
    <p>登录后即可管理预约、查看消息和个人资料。</p>
    <div class="gate-card__actions">
      <button type="button" class="btn btn--primary" data-gate-action="login">登录</button>
      <button type="button" class="btn btn--ghost" data-gate-action="register">注册新账号</button>
    </div>
  </section>`;
}

function forbiddenPage() {
  return `<section class="gate-card card">
    <span class="gate-card__icon" aria-hidden="true">🔒</span>
    <p class="eyebrow">权限不足</p>
    <h1>只有管理员可以进入</h1>
    <p>当前账号没有管理后台权限，请返回场馆预约页。</p>
    <div class="gate-card__actions">
      <a class="btn btn--primary" href="#/">返回场馆预约</a>
    </div>
  </section>`;
}

function renderGate(html) {
  renderedGate = true;
  appEl.innerHTML = html;
  appEl.querySelectorAll('[data-gate-action]').forEach((button) => {
    button.addEventListener('click', () => {
      openAuthModal(button.dataset.gateAction === 'register' ? 'register' : 'login', currentRoute.hash);
    });
  });
}

function renderCurrentPage(force = false) {
  if (!appEl) return;
  const info = getCurrentRoute();
  currentPath = info.path;
  currentRoute = info.route;

  // 同步顶部导航的激活状态
  renderHeader();
  pageRenderSeq += 1;
  const seq = pageRenderSeq;

  if (pageCleanup) {
    try {
      pageCleanup();
    } catch (err) {
      console.error('[page cleanup]', err);
    }
    pageCleanup = null;
  }
  closeAllModals();

  document.title = `${info.route.label} · ${APP_NAME}`;

  if (info.route.auth && !store.isLoggedIn) {
    renderGate(gatePageFor(info.route));
    return;
  }
  if (info.route.admin && !store.isAdmin) {
    renderedGate = false;
    appEl.innerHTML = forbiddenPage();
    return;
  }

  renderedGate = false;
  const renderer = PAGE_RENDERERS[info.path];
  if (!renderer) {
    appEl.innerHTML = forbiddenPage();
    return;
  }

  try {
    const cleanup = renderer(appEl);
    if (typeof cleanup === 'function') pageCleanup = cleanup;
    if (seq !== pageRenderSeq) {
      // 渲染过程中发生了新的路由切换，新页面已接管
      if (typeof cleanup === 'function') cleanup();
      return;
    }
  } catch (err) {
    console.error('[page render]', err);
    appEl.innerHTML = `<div class="card">${gatePageFor(info.route)}</div>`;
    toast('页面加载失败，请刷新重试', 'error');
    return;
  }

  window.scrollTo({ top: 0, behavior: force ? 'auto' : 'smooth' });
}

/* ========================================================================== */
/*                                  启动流程                                  */
/* ========================================================================== */

async function bootstrap() {
  mountAssistant();
  renderHeader();
  let sessionExpiredOnBoot = false;

  // 先校验 token，再拉未读数，避免两个并发 401 争抢清理登录态
  if (store.isLoggedIn) {
    try {
      const me = await api.me.get();
      const { stats, ...user } = me || {};
      store.setUser(user);
      store.setStats(stats || null);
    } catch (err) {
      if (err?.status === 401) sessionExpiredOnBoot = true;
      else {
        console.warn('[bootstrap] 登录态校验失败', err);
        toast('登录信息刷新失败，将使用本地缓存的登录状态', 'warning');
      }
    }
  }

  bootstrapping = false;
  startRouter((info) => {
    currentPath = info.path;
    currentRoute = info.route;
    renderCurrentPage();
  });
  loadUnreadCount();
  if (footerVersionEl) footerVersionEl.textContent = APP_VERSION;

  if (sessionExpiredOnBoot) {
    toast('登录状态已失效，请重新登录', 'warning');
    openAuthModal('login', currentRoute?.auth ? currentRoute.hash : null);
  }
}

/* 全局事件 */
store.subscribe((_state, kind) => {
  if (kind === 'selection') return;
  renderHeader();
});

window.addEventListener('app:require-login', (event) => {
  if (store.isLoggedIn) return;
  const target = event?.detail?.target || null;
  openAuthModal('login', target);
});

window.addEventListener('app:refresh-unread', () => {
  loadUnreadCount();
});

window.addEventListener(AUTH_EXPIRED_EVENT, (event) => {
  // api.js 在抛出 401 前已经清空 token
  if (bootstrapping) return;
  closeAllModals();
  renderHeader();
  renderCurrentPage(true);
  toast(event?.detail?.message || '登录状态已失效，请重新登录', 'warning');
  if (!store.isLoggedIn) openAuthModal('login', currentRoute?.auth ? currentRoute.hash : null);
});

// 网络离线提示（可选增强，不影响主流程）
window.addEventListener('offline', () => toast('网络已断开，请检查连接', 'warning'));

// AI 助手在未登录时点「去预约」会请求打开登录框
window.addEventListener('app:require-login', () => {
  openAuthModal('login', null);
});

bootstrap().catch((err) => {
  console.error('[bootstrap]', err);
  bootstrapping = false;
  if (appEl) {
    appEl.innerHTML = `<section class="gate-card card">
      <h1>应用启动失败</h1>
      <p>${escapeHtml(err?.message || '请刷新页面重试')}</p>
      <button type="button" class="btn btn--primary" id="boot-reload">刷新页面</button>
    </section>`;
    appEl.querySelector('#boot-reload')?.addEventListener('click', () => window.location.reload());
  }
});
