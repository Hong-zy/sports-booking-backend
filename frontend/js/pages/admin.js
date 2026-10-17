/**
 * 管理后台。
 *
 * 包含 7 个子模块：场馆、场地、时段标记、预约、用户、报表、数据库。
 * 每个子 tab 独立加载数据，进入前校验 admin 角色。
 */

import {
  DB_TABLES,
  DB_TABLE_LABEL,
  DEFAULT_BUSINESS,
  ROLE,
  SLOT_MINUTES_OPTIONS,
  SPORT_OPTIONS,
} from '/shared/constants.js';
import { todayString } from '/shared/time.js';
import {
  validateAdminUserPatch,
  validateCourtInput,
  validateOverrideInput,
  validateVenueInput,
} from '/shared/validate.js';
import { api } from '../api.js';
import { store } from '../store.js';
import {
  confirmDialog,
  emptyState,
  escapeHtml,
  fmtBytes,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtPercent,
  loadingHtml,
  openModal,
  renderFormErrors,
  renderTable,
  statusBadge,
  toast,
  withBusy,
} from '../ui.js';

const ADMIN_TABS = [
  { key: 'venues', label: '场馆管理', icon: '🏟' },
  { key: 'courts', label: '场地管理', icon: '🏸' },
  { key: 'overrides', label: '时段标记', icon: '🚧' },
  { key: 'bookings', label: '预约管理', icon: '📋' },
  { key: 'users', label: '用户管理', icon: '👥' },
  { key: 'report', label: '经营报表', icon: '📊' },
  { key: 'database', label: '数据库', icon: '🗄' },
];

const errText = (err, fallback = '操作失败，请稍后重试') => err?.message || fallback;
const asArray = (value) => (Array.isArray(value) ? value : []);
const ADMIN_TODAY = () => todayString();

function adminPageHeading() {
  return `<section class="page-heading page-heading--admin">
    <div>
      <p class="eyebrow">ADMIN CONSOLE</p>
      <h1>管理后台</h1>
      <p class="page-subtitle">维护场馆与时段、处理预约、查看经营数据。</p>
    </div>
    <div class="page-heading__actions">
      <span class="admin-badge"><span class="badge__dot"></span>管理员会话</span>
    </div>
  </section>`;
}

function adminErrorBlock(message, { buttonLabel = '重新加载', attr = 'data-admin-retry' } = {}) {
  return `<div class="card">
    <div class="state-block state-block--error">
      <span class="state-block__icon" aria-hidden="true">!</span>
      <h3>加载失败</h3>
      <p>${escapeHtml(message)}</p>
      <button type="button" class="btn btn--primary" ${attr}>${escapeHtml(buttonLabel)}</button>
    </div>
  </div>`;
}

function showTabError(panel, ctx, err) {
  if (!ctx.isActive()) return;
  panel.innerHTML = adminErrorBlock(errText(err));
  panel.querySelector('[data-admin-retry]')?.addEventListener('click', () => ctx.reload());
}

function setModalErrors(body, errors) {
  const box = body.querySelector('[data-form-errors]');
  renderFormErrors(box, errors);
  if (errors.length) {
    body.querySelector('input, select, textarea')?.focus();
  }
}

function modalBody(markup) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = markup;
  return wrapper;
}

function fmtUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟 ${total % 60} 秒`;
}

function bindRowButtons(root, selector, handler) {
  root.querySelectorAll(selector).forEach((button) => {
    button.addEventListener('click', () => handler(button));
  });
}

/* ========================================================================== */
/*                                    总入口                                  */
/* ========================================================================== */

export function renderAdminPage(container) {
  // 角色守卫：非管理员直接展示无权限
  if (!store.isLoggedIn || store.user?.role !== ROLE.ADMIN) {
    container.innerHTML = `<section class="gate-card card">
      <span class="gate-card__icon" aria-hidden="true">🔒</span>
      <h1>无权访问管理后台</h1>
      <p>当前账号不是管理员，或登录状态已失效。请返回场馆预约页。</p>
      <a class="btn btn--primary" href="#/">返回场馆预约</a>
    </section>`;
    return () => {};
  }

  let destroyed = false;
  let activeTab = 'venues';
  let tabSeq = 0;

  // 支持 #/admin?tab=users 直接打开某个子 tab
  const hashQuery = String(window.location.hash).split('?')[1] || '';
  const requestedTab = new URLSearchParams(hashQuery).get('tab');
  if (ADMIN_TABS.some((tab) => tab.key === requestedTab)) activeTab = requestedTab;

  container.innerHTML = `
    ${adminPageHeading()}
    <nav class="admin-tabs" role="tablist" aria-label="管理后台功能">
      ${ADMIN_TABS.map(
        (tab) => `<button type="button" class="admin-tab" role="tab" data-admin-tab="${tab.key}"
          aria-selected="false">
          <span aria-hidden="true">${tab.icon}</span><span>${escapeHtml(tab.label)}</span>
        </button>`,
      ).join('')}
    </nav>
    <section id="admin-panel" class="admin-panel" role="tabpanel" aria-live="polite"></section>
  `;

  const panel = container.querySelector('#admin-panel');
  const tabButtons = [...container.querySelectorAll('[data-admin-tab]')];

  function syncTabButtons() {
    for (const button of tabButtons) {
      const selected = button.dataset.adminTab === activeTab;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }

  function syncHash() {
    try {
      window.history.replaceState(null, '', `#/admin?tab=${activeTab}`);
    } catch {
      /* 忽略历史记录异常 */
    }
  }

  async function switchTab(tabKey) {
    if (destroyed) return;
    if (!ADMIN_TABS.some((tab) => tab.key === tabKey)) tabKey = 'venues';
    activeTab = tabKey;
    syncTabButtons();
    syncHash();
    const seq = ++tabSeq;
    const tab = ADMIN_TABS.find((item) => item.key === tabKey);
    const ctx = {
      tab: tabKey,
      isActive: () => !destroyed && seq === tabSeq && activeTab === tabKey,
      reload: () => switchTab(tabKey),
      goTab: (next) => switchTab(next),
    };

    panel.innerHTML = loadingHtml(`正在加载${tab?.label || ''}…`);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      await TAB_RENDERERS[tabKey](panel, ctx);
    } catch (err) {
      console.error('[admin tab]', err);
      showTabError(panel, ctx, err);
    }
  }

  for (const button of tabButtons) {
    button.addEventListener('click', () => switchTab(button.dataset.adminTab));
  }

  switchTab(activeTab);

  return () => {
    destroyed = true;
    tabSeq += 1;
  };
}

/* ========================================================================== */
/*                                  场馆管理                                  */
/* ========================================================================== */

function openVenueForm(venue, onSaved) {
  const isEdit = Boolean(venue);
  const sportValue = venue?.sport || '';
  const body = modalBody(`
    <form class="modal-form" novalidate>
      <div class="form-row">
        <label class="field">
          <span class="field__label">场馆名称 <em>*</em></span>
          <input class="input" name="name" maxlength="40" required value="${escapeHtml(
            venue?.name || '',
          )}" placeholder="例如：城东体育中心" />
        </label>
        <label class="field">
          <span class="field__label">运动类型 <em>*</em></span>
          <input class="input" name="sport" list="venue-sport-list" maxlength="20" required
            value="${escapeHtml(sportValue)}" placeholder="例如：羽毛球" />
          <datalist id="venue-sport-list">
            ${SPORT_OPTIONS.map((item) => `<option value="${escapeHtml(item)}"></option>`).join('')}
          </datalist>
        </label>
      </div>
      <label class="field">
        <span class="field__label">地址</span>
        <input class="input" name="address" maxlength="120" value="${escapeHtml(
          venue?.address || '',
        )}" placeholder="填写场馆详细地址" />
      </label>
      <div class="form-row">
        <label class="field">
          <span class="field__label">开放时间 <em>*</em></span>
          <input class="input" type="time" name="openTime" required value="${escapeHtml(
            venue?.openTime || '08:00',
          )}" />
        </label>
        <label class="field">
          <span class="field__label">关闭时间 <em>*</em></span>
          <input class="input" type="time" name="closeTime" required value="${escapeHtml(
            venue?.closeTime || '22:00',
          )}" />
        </label>
        <label class="field">
          <span class="field__label">每节时长</span>
          <select class="input" name="slotMinutes">
            ${SLOT_MINUTES_OPTIONS.map(
              (minutes) =>
                `<option value="${minutes}" ${
                  Number(venue?.slotMinutes) === minutes ? 'selected' : ''
                }>${minutes} 分钟</option>`,
            ).join('')}
          </select>
        </label>
      </div>
      <div class="form-errors" data-form-errors hidden></div>
    </form>
  `);

  const modal = openModal({
    title: isEdit ? '编辑场馆' : '新增场馆',
    size: 'lg',
    body,
    actions: [
      { label: '取消', variant: 'ghost' },
      {
        key: 'save',
        label: '保存场馆',
        variant: 'primary',
        onClick: async () => {
          const form = body.querySelector('form');
          const get = (name) => form.elements[name]?.value.trim() ?? '';
          const payload = {
            name: get('name'),
            address: get('address'),
            sport: get('sport'),
            openTime: get('openTime'),
            closeTime: get('closeTime'),
            slotMinutes: Number(get('slotMinutes')),
          };
          const errors = validateVenueInput(payload);
          if (errors.length) {
            setModalErrors(body, errors);
            return;
          }
          setModalErrors(body, []);
          try {
            if (isEdit) {
              await api.admin.updateVenue(venue.id, { ...payload, status: venue.status });
              toast('场馆信息已更新', 'success');
            } else {
              await api.admin.createVenue(payload);
              toast('场馆已创建', 'success');
            }
            modal.close();
            onSaved?.();
          } catch (err) {
            setModalErrors(body, [errText(err, '保存场馆失败')]);
            toast(errText(err, '保存场馆失败'), 'error');
          }
        },
      },
    ],
  });
  body.querySelector('input[name="name"]')?.focus();
  // 表单没有自己的提交按钮，按 Enter 时复用弹窗的保存按钮
  body.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    modal.buttons.save?.click();
  });
}

async function renderVenuesTab(panel, ctx) {
  async function load() {
    if (!ctx.isActive()) return;
    panel.innerHTML = loadingHtml('正在加载场馆…');
    let venues;
    try {
      venues = asArray(await api.venues.list({ date: ADMIN_TODAY() }));
    } catch (err) {
      showTabError(panel, ctx, err);
      return;
    }
    if (!ctx.isActive()) return;

    const table = renderTable({
      columns: [
        {
          label: '场馆',
          render: (row) => `<div class="cell-stack">
            <strong>${escapeHtml(row.name)}</strong>
            <span class="text-muted text-sm">${escapeHtml(row.address || '未填写地址')}</span>
          </div>`,
        },
        {
          label: '运动类型',
          render: (row) => `<span class="tag">${escapeHtml(row.sport || '—')}</span>`,
        },
        {
          label: '营业时间',
          render: (row) => `<div class="cell-stack">
            <span>${escapeHtml(row.openTime)} - ${escapeHtml(row.closeTime)}</span>
            <span class="text-muted text-sm">每节 ${escapeHtml(row.slotMinutes)} 分钟</span>
          </div>`,
        },
        {
          label: '场地数',
          align: 'center',
          render: (row) => escapeHtml(row.courtCount ?? 0),
        },
        {
          label: '可用 / 总时段',
          render: (row) => {
            const ratio = Math.max(0, Math.min(1, Number(row.utilization) || 0));
            return `<div class="mini-util">
              <div class="mini-util__text"><span>${escapeHtml(row.availableSlots ?? 0)} / ${escapeHtml(
                row.totalSlots ?? 0,
              )}</span><span>${fmtPercent(ratio)}</span></div>
              <div class="mini-util__bar"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div>
            </div>`;
          },
        },
        {
          label: '状态',
          render: (row) => statusBadge(row.status, 'venue'),
        },
        {
          label: '操作',
          align: 'right',
          render: (row) => `<div class="table-actions">
            <button type="button" class="btn btn--sm btn--ghost" data-venue-action="edit" data-id="${escapeHtml(
              row.id,
            )}">编辑</button>
            <button type="button" class="btn btn--sm btn--ghost" data-venue-action="toggle" data-id="${escapeHtml(
              row.id,
            )}">${row.status === 'open' ? '暂停' : '开放'}</button>
            <button type="button" class="btn btn--sm btn--danger-ghost" data-venue-action="delete" data-id="${escapeHtml(
              row.id,
            )}">删除</button>
          </div>`,
        },
      ],
      rows: venues,
      emptyText: '还没有场馆，点击右上角新增。',
    });

    panel.innerHTML = `<section class="card card--flush">
      <div class="card-toolbar">
        <div>
          <h2>场馆列表 <span class="count-pill">${venues.length}</span></h2>
          <p>可用时段按今天（${escapeHtml(fmtDate(ADMIN_TODAY()))}）统计。</p>
        </div>
        <div class="toolbar-actions">
          <button type="button" class="btn btn--ghost" data-admin-action="refresh">↻ 刷新</button>
          <button type="button" class="btn btn--primary" data-admin-action="create">＋ 新增场馆</button>
        </div>
      </div>
      ${table}
    </section>`;

    const rerun = () => load();

    panel.querySelector('[data-admin-action="refresh"]')?.addEventListener('click', (event) => {
      withBusy(event.currentTarget, () => load(), '刷新中…');
    });
    panel.querySelector('[data-admin-action="create"]')?.addEventListener('click', () => {
      openVenueForm(null, rerun);
    });

    bindRowButtons(panel, '[data-venue-action]', async (button) => {
      const venue = venues.find((item) => String(item.id) === button.dataset.id);
      if (!venue) return;
      const action = button.dataset.venueAction;
      if (action === 'edit') {
        openVenueForm(venue, rerun);
        return;
      }
      if (action === 'toggle') {
        const nextStatus = venue.status === 'open' ? 'paused' : 'open';
        if (nextStatus === 'paused') {
          const ok = await confirmDialog({
            title: '暂停场馆',
            message: `确定暂停「${venue.name}」吗？暂停后用户将无法预约该场馆的新时段。`,
            confirmText: '暂停营业',
            danger: true,
          });
          if (!ok) return;
        }
        try {
          await withBusy(
            button,
            () => api.admin.updateVenue(venue.id, { status: nextStatus }),
            '处理中…',
          );
          toast(nextStatus === 'open' ? '场馆已恢复开放' : '场馆已暂停营业', 'success');
          await load();
        } catch (err) {
          toast(errText(err, '状态更新失败'), 'error');
        }
        return;
      }
      if (action === 'delete') {
        const ok = await confirmDialog({
          title: '删除场馆',
          message: `确定要删除「${venue.name}」吗？场馆下的场地也会一并受影响，此操作不可恢复。`,
          confirmText: '确认删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await withBusy(button, () => api.admin.deleteVenue(venue.id), '删除中…');
          toast('场馆已删除', 'success');
          await load();
        } catch (err) {
          toast(errText(err, '删除场馆失败'), 'error');
        }
      }
    });
  }

  await load();
}

/* ========================================================================== */
/*                                  场地管理                                  */
/* ========================================================================== */

function openCourtForm({ venue, court, onSaved }) {
  const isEdit = Boolean(court);
  const body = modalBody(`
    <form class="modal-form" novalidate>
      <p class="notice notice--info">所属场馆：${escapeHtml(venue.name)}</p>
      <div class="form-row">
        <label class="field">
          <span class="field__label">场地名称 <em>*</em></span>
          <input class="input" name="name" maxlength="40" required value="${escapeHtml(
            court?.name || '',
          )}" placeholder="例如：1 号场" />
        </label>
        <label class="field">
          <span class="field__label">价格（元/小时） <em>*</em></span>
          <input class="input" name="pricePerHour" type="number" min="0" step="1" required
            value="${escapeHtml(court?.pricePerHour ?? 80)}" />
        </label>
      </div>
      <label class="field">
        <span class="field__label">状态</span>
        <select class="input" name="status">
          <option value="open" ${court?.status !== 'closed' ? 'selected' : ''}>可用</option>
          <option value="closed" ${court?.status === 'closed' ? 'selected' : ''}>停用</option>
        </select>
      </label>
      <div class="form-errors" data-form-errors hidden></div>
    </form>
  `);

  const modal = openModal({
    title: isEdit ? '编辑场地' : '新增场地',
    size: 'md',
    body,
    actions: [
      { label: '取消', variant: 'ghost' },
      {
        key: 'save',
        label: '保存场地',
        variant: 'primary',
        onClick: async () => {
          const form = body.querySelector('form');
          const payload = {
            name: form.elements.name.value.trim(),
            pricePerHour: Number(form.elements.pricePerHour.value),
            status: form.elements.status.value,
          };
          const errors = validateCourtInput(payload);
          if (errors.length) {
            setModalErrors(body, errors);
            return;
          }
          setModalErrors(body, []);
          try {
            if (isEdit) {
              await api.admin.updateCourt(court.id, payload);
              toast('场地已更新', 'success');
            } else {
              await api.admin.createCourt(venue.id, payload);
              toast('场地已创建', 'success');
            }
            modal.close();
            onSaved?.();
          } catch (err) {
            setModalErrors(body, [errText(err, '保存场地失败')]);
            toast(errText(err, '保存场地失败'), 'error');
          }
        },
      },
    ],
  });
  body.querySelector('input[name="name"]')?.focus();
  // 表单没有自己的提交按钮，按 Enter 时复用弹窗的保存按钮
  body.querySelector('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    modal.buttons.save?.click();
  });
}

async function renderCourtsTab(panel, ctx) {
  let venues;
  try {
    venues = asArray(await api.venues.list({ date: ADMIN_TODAY() }));
  } catch (err) {
    showTabError(panel, ctx, err);
    return;
  }
  if (!ctx.isActive()) return;

  if (!venues.length) {
    panel.innerHTML = `<div class="card">${emptyState(
      '还没有场馆',
      '请先在「场馆管理」中创建场馆，再为其添加场地。',
      '🏟',
    )}
    <div class="state-actions state-actions--center">
      <button type="button" class="btn btn--primary" data-go-venues>去新增场馆</button>
    </div></div>`;
    panel.querySelector('[data-go-venues]')?.addEventListener('click', () => ctx.goTab('venues'));
    return;
  }

  let selectedVenueId = Number(venues[0].id);
  let courts = [];
  let loadSeq = 0;

  panel.innerHTML = `<section class="card">
    <div class="card-toolbar">
      <div>
        <h2>场地管理</h2>
        <p>先选择场馆，再维护该场馆下的场地与价格。</p>
      </div>
      <div class="toolbar-actions">
        <button type="button" class="btn btn--primary" data-admin-action="create-court">＋ 新增场地</button>
      </div>
    </div>
    <div class="filter-grid filter-grid--compact">
      <label class="field">
        <span class="field__label">选择场馆</span>
        <select class="input" id="court-venue-select">
          ${venues
            .map(
              (venue) =>
                `<option value="${escapeHtml(venue.id)}">${escapeHtml(venue.name)} · ${escapeHtml(
                  venue.sport,
                )}</option>`,
            )
            .join('')}
        </select>
      </label>
      <div class="filter-side">
        <span class="text-muted text-sm" id="court-venue-meta">${escapeHtml(
          `${venues[0].openTime} - ${venues[0].closeTime} · 每节 ${venues[0].slotMinutes} 分钟`,
        )}</span>
      </div>
    </div>
    <div id="court-list">${loadingHtml('正在加载场地…')}</div>
  </section>`;

  const venueSelect = panel.querySelector('#court-venue-select');
  const venueMeta = panel.querySelector('#court-venue-meta');
  const listEl = panel.querySelector('#court-list');
  const currentVenue = () => venues.find((venue) => Number(venue.id) === selectedVenueId);

  async function loadCourts() {
    const seq = ++loadSeq;
    listEl.innerHTML = loadingHtml('正在加载场地…');
    const venue = currentVenue();
    try {
      const detail = await api.venues.detail(selectedVenueId, ADMIN_TODAY());
      if (!ctx.isActive() || seq !== loadSeq) return;
      courts = asArray(detail.courts);
      const table = renderTable({
        columns: [
          {
            label: '场地',
            render: (row) => `<strong>${escapeHtml(row.name)}</strong>`,
          },
          {
            label: '价格（元/小时）',
            align: 'right',
            render: (row) => fmtMoney(row.pricePerHour),
          },
          {
            label: '状态',
            render: (row) => statusBadge(row.status, 'court'),
          },
          {
            label: '操作',
            align: 'right',
            render: (row) => `<div class="table-actions">
              <button type="button" class="btn btn--sm btn--ghost" data-court-action="edit" data-id="${escapeHtml(
                row.id,
              )}">编辑</button>
              <button type="button" class="btn btn--sm btn--ghost" data-court-action="toggle" data-id="${escapeHtml(
                row.id,
              )}">${row.status === 'open' ? '停用' : '启用'}</button>
              <button type="button" class="btn btn--sm btn--danger-ghost" data-court-action="delete" data-id="${escapeHtml(
                row.id,
              )}">删除</button>
            </div>`,
          },
        ],
        rows: courts,
        emptyText: '该场馆还没有场地，点击右上角新增。',
      });
      listEl.innerHTML = table;

      bindRowButtons(listEl, '[data-court-action]', async (button) => {
        const court = courts.find((item) => String(item.id) === button.dataset.id);
        if (!court) return;
        const action = button.dataset.courtAction;
        if (action === 'edit') {
          openCourtForm({ venue, court, onSaved: loadCourts });
          return;
        }
        if (action === 'toggle') {
          const nextStatus = court.status === 'open' ? 'closed' : 'open';
          try {
            await withBusy(
              button,
              () => api.admin.updateCourt(court.id, { status: nextStatus }),
              '处理中…',
            );
            toast(nextStatus === 'open' ? '场地已启用' : '场地已停用', 'success');
            await loadCourts();
          } catch (err) {
            toast(errText(err, '状态更新失败'), 'error');
          }
          return;
        }
        if (action === 'delete') {
          const ok = await confirmDialog({
            title: '删除场地',
            message: `确定删除「${court.name}」吗？该场地已有的预约记录不会被删除，但之后无法再预约。`,
            confirmText: '确认删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await withBusy(button, () => api.admin.deleteCourt(court.id), '删除中…');
            toast('场地已删除', 'success');
            await loadCourts();
          } catch (err) {
            toast(errText(err, '删除场地失败'), 'error');
          }
        }
      });
    } catch (err) {
      if (!ctx.isActive() || seq !== loadSeq) return;
      listEl.innerHTML = adminErrorBlock(errText(err, '场地加载失败'), {
        attr: 'data-court-retry',
      });
      listEl.querySelector('[data-court-retry]')?.addEventListener('click', loadCourts);
    }
  }

  function updateVenueMeta() {
    const venue = currentVenue();
    if (!venue || !venueMeta) return;
    venueMeta.textContent = `${venue.openTime} - ${venue.closeTime} · 每节 ${venue.slotMinutes} 分钟 · ${venue.courtCount} 片场地`;
  }

  venueSelect?.addEventListener('change', () => {
    selectedVenueId = Number(venueSelect.value);
    updateVenueMeta();
    loadCourts();
  });

  panel.querySelector('[data-admin-action="create-court"]')?.addEventListener('click', () => {
    const venue = currentVenue();
    if (!venue) {
      toast('请先选择场馆', 'warning');
      return;
    }
    openCourtForm({ venue, court: null, onSaved: loadCourts });
  });

  await loadCourts();
}

/* ========================================================================== */
/*                                  时段标记                                  */
/* ========================================================================== */

async function renderOverridesTab(panel, ctx) {
  let venues;
  try {
    venues = asArray(await api.venues.list({ date: ADMIN_TODAY() }));
  } catch (err) {
    showTabError(panel, ctx, err);
    return;
  }
  if (!ctx.isActive()) return;

  if (!venues.length) {
    panel.innerHTML = `<div class="card">${emptyState(
      '还没有场馆',
      '请先创建场馆和场地，才能设置维护/关闭时段。',
      '🚧',
    )}</div>`;
    return;
  }

  // 一次性建立“场地 -> 场馆/场地名”的查找表，列表跨场馆时也能正确显示
  const courtLookup = new Map();
  const venueCourts = new Map();
  await Promise.all(
    venues.map(async (venue) => {
      try {
        const detail = await api.venues.detail(venue.id, ADMIN_TODAY());
        const list = asArray(detail.courts);
        venueCourts.set(Number(venue.id), list);
        for (const court of list) {
          courtLookup.set(Number(court.id), {
            venueName: venue.name,
            courtName: court.name,
          });
        }
      } catch {
        venueCourts.set(Number(venue.id), []);
      }
    }),
  );
  if (!ctx.isActive()) return;

  let selectedVenueId = Number(venues[0].id);
  let listSeq = 0;

  const venueOptions = venues
    .map(
      (venue) =>
        `<option value="${escapeHtml(venue.id)}">${escapeHtml(venue.name)} · ${escapeHtml(
          venue.sport,
        )}</option>`,
    )
    .join('');

  panel.innerHTML = `<div class="content-grid content-grid--sidebar">
    <section class="card">
      <div class="card-heading">
        <div><h2>新增时段标记</h2><p>维护或临时关闭的时段将不可被预约。</p></div>
      </div>
      <form id="override-form" class="admin-form" novalidate>
        <label class="field">
          <span class="field__label">场馆</span>
          <select class="input" name="venueId">${venueOptions}</select>
        </label>
        <label class="field">
          <span class="field__label">场地 <em>*</em></span>
          <select class="input" name="courtId" disabled>
            <option value="">正在加载场地…</option>
          </select>
        </label>
        <div class="form-row">
          <label class="field">
            <span class="field__label">日期 <em>*</em></span>
            <input class="input" type="date" name="date" value="${escapeHtml(ADMIN_TODAY())}" required />
          </label>
          <label class="field">
            <span class="field__label">开始 <em>*</em></span>
            <input class="input" type="time" name="startTime" value="${escapeHtml(
              venues[0].openTime || '09:00',
            )}" required />
          </label>
          <label class="field">
            <span class="field__label">结束 <em>*</em></span>
            <input class="input" type="time" name="endTime" value="${escapeHtml(
              venues[0].closeTime || '22:00',
            )}" required />
          </label>
        </div>
        <div class="form-row">
          <label class="field">
            <span class="field__label">类型 <em>*</em></span>
            <select class="input" name="status">
              <option value="maintenance">维护中</option>
              <option value="closed">临时关闭</option>
            </select>
          </label>
          <label class="field field--grow">
            <span class="field__label">备注</span>
            <input class="input" name="note" maxlength="200" placeholder="例如：地板保养" />
          </label>
        </div>
        <div class="form-errors" data-form-errors hidden></div>
        <div class="notice notice--warning" data-override-conflict hidden></div>
        <div class="form-actions">
          <button type="submit" class="btn btn--primary">创建标记</button>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-heading">
        <div><h2>标记列表</h2><p>可按日期筛选，最多显示最近 500 条。</p></div>
      </div>
      <div class="filter-inline">
        <label class="field">
          <span class="field__label">筛选日期</span>
          <input class="input" type="date" id="override-filter-date" value="${escapeHtml(
            ADMIN_TODAY(),
          )}" />
        </label>
        <button type="button" class="btn btn--ghost" data-action="refresh-overrides">查询</button>
        <button type="button" class="btn btn--ghost" data-action="clear-override-date">全部日期</button>
      </div>
      <div id="override-list">${loadingHtml('正在加载标记…')}</div>
    </section>
  </div>`;

  const form = panel.querySelector('#override-form');
  const venueSelect = form.elements.venueId;
  const courtSelect = form.elements.courtId;
  const conflictBox = panel.querySelector('[data-override-conflict]');
  const filterDateInput = panel.querySelector('#override-filter-date');
  const listEl = panel.querySelector('#override-list');

  function fillCourts() {
    const courts = asArray(venueCourts.get(selectedVenueId));
    courtSelect.innerHTML = courts.length
      ? courts
          .map(
            (court) =>
              `<option value="${escapeHtml(court.id)}">${escapeHtml(court.name)}（${
                court.status === 'open' ? '可用' : '停用'
              }）</option>`,
          )
          .join('')
      : '<option value="">该场馆暂无场地</option>';
    courtSelect.disabled = !courts.length;
    const venue = venues.find((item) => Number(item.id) === selectedVenueId);
    if (venue) {
      form.elements.startTime.value = venue.openTime || '09:00';
      form.elements.endTime.value = venue.closeTime || '22:00';
    }
  }

  fillCourts();

  venueSelect.addEventListener('change', () => {
    selectedVenueId = Number(venueSelect.value);
    fillCourts();
  });

  function renderOverrideList(overrides) {
    if (!ctx.isActive()) return;
    if (!overrides.length) {
      listEl.innerHTML = emptyState('该日期暂无时段标记', '可通过左侧表单创建维护或临时关闭标记。', '✅');
      return;
    }
    const table = renderTable({
      columns: [
        {
          label: '日期',
          render: (row) => `<strong>${escapeHtml(fmtDate(row.date, false))}</strong>`,
        },
        {
          label: '场地',
          render: (row) => {
            const info = courtLookup.get(Number(row.courtId));
            return `<div class="cell-stack">
              <span>${escapeHtml(info?.venueName || '未知场馆')}</span>
              <span class="text-muted text-sm">${escapeHtml(
                info?.courtName || `场地 #${row.courtId}`,
              )}</span>
            </div>`;
          },
        },
        {
          label: '时间',
          render: (row) =>
            `${escapeHtml(row.startTime)} - ${escapeHtml(row.endTime)}`,
        },
        {
          label: '类型',
          render: (row) => statusBadge(row.status, 'override'),
        },
        {
          label: '备注',
          render: (row) => `<span class="text-muted">${escapeHtml(row.note || '—')}</span>`,
        },
        {
          label: '操作',
          align: 'right',
          render: (row) => `<button type="button" class="btn btn--sm btn--danger-ghost"
            data-override-delete="${escapeHtml(row.id)}">删除</button>`,
        },
      ],
      rows: overrides,
      emptyText: '暂无标记',
    });
    listEl.innerHTML = table;

    bindRowButtons(listEl, '[data-override-delete]', async (button) => {
      const id = Number(button.dataset.overrideDelete);
      const target = overrides.find((item) => Number(item.id) === id);
      const info = target ? courtLookup.get(Number(target.courtId)) : null;
      const ok = await confirmDialog({
        title: '删除时段标记',
        message: target
          ? `确定删除 ${fmtDate(target.date, false)} ${target.startTime}-${target.endTime} 在「${
              info?.courtName || `场地 #${target.courtId}`
            }」的标记吗？删除后该时段将恢复可预约。`
          : '确定删除该标记吗？',
        confirmText: '确认删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await withBusy(button, () => api.admin.deleteOverride(id), '删除中…');
        toast('标记已删除', 'success');
        await loadOverrides();
      } catch (err) {
        toast(errText(err, '删除标记失败'), 'error');
      }
    });
  }

  async function loadOverrides() {
    const seq = ++listSeq;
    listEl.innerHTML = loadingHtml('正在加载标记…');
    try {
      const date = filterDateInput.value || undefined;
      const data = await api.admin.listOverrides({ date });
      if (!ctx.isActive() || seq !== listSeq) return;
      renderOverrideList(asArray(data));
    } catch (err) {
      if (!ctx.isActive() || seq !== listSeq) return;
      listEl.innerHTML = adminErrorBlock(errText(err, '标记加载失败'), {
        attr: 'data-overrides-retry',
      });
      listEl.querySelector('[data-overrides-retry]')?.addEventListener('click', loadOverrides);
    }
  }

  panel.querySelector('[data-action="refresh-overrides"]')?.addEventListener('click', () => {
    loadOverrides();
  });
  panel.querySelector('[data-action="clear-override-date"]')?.addEventListener('click', () => {
    filterDateInput.value = '';
    loadOverrides();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = {
      courtId: Number(courtSelect.value),
      date: form.elements.date.value,
      startTime: form.elements.startTime.value,
      endTime: form.elements.endTime.value,
      status: form.elements.status.value,
      note: form.elements.note.value.trim(),
    };
    const errors = validateOverrideInput(payload);
    renderFormErrors(form.querySelector('[data-form-errors]'), errors);
    if (errors.length) {
      toast(errors[0], 'warning');
      return;
    }
    conflictBox.hidden = true;
    conflictBox.textContent = '';
    const submitButton = form.querySelector('[type="submit"]');
    withBusy(
      submitButton,
      async () => {
        try {
          const result = await api.admin.createOverride(payload);
          if (result?.hasBookingConflict) {
            conflictBox.hidden = false;
            conflictBox.textContent = `该时段已有预约${
              result.conflictBookingCode ? `（凭证号 ${result.conflictBookingCode}）` : ''
            }，请与用户确认后再处理。`;
            toast('标记已创建，但该时段已有预约，请及时处理', 'warning', { duration: 6000 });
          } else {
            toast('时段标记已创建', 'success');
          }
          form.elements.note.value = '';
          filterDateInput.value = payload.date;
          await loadOverrides();
        } catch (err) {
          renderFormErrors(form.querySelector('[data-form-errors]'), [
            errText(err, '创建标记失败'),
          ]);
          toast(errText(err, '创建标记失败'), 'error');
        }
      },
      '创建中…',
    );
  });

  await loadOverrides();
}

/* ========================================================================== */
/*                                  预约管理                                  */
/* ========================================================================== */

async function renderBookingsTab(panel, ctx) {
  panel.innerHTML = `<div class="card">
    <div class="card-toolbar">
      <div><h2>预约管理</h2><p>按日期与状态查看所有用户的预约，可强制取消。</p></div>
    </div>
    <form id="admin-booking-filter" class="filter-grid filter-grid--compact">
      <label class="field">
        <span class="field__label">日期</span>
        <input class="input" type="date" name="date" />
      </label>
      <label class="field">
        <span class="field__label">状态</span>
        <select class="input" name="status">
          <option value="">全部状态</option>
          <option value="confirmed">已预约</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
      </label>
      <div class="filter-side">
        <button type="submit" class="btn btn--primary">查询预约</button>
        <button type="button" class="btn btn--ghost" data-action="reset-filter">重置</button>
      </div>
    </form>
  </div>
  <section class="card card--flush" id="admin-booking-list">${loadingHtml('正在加载预约…')}</section>`;

  const filterForm = panel.querySelector('#admin-booking-filter');
  const listEl = panel.querySelector('#admin-booking-list');
  let bookings = [];
  let loadSeq = 0;

  function renderBookings() {
    if (!ctx.isActive()) return;
    const table = renderTable({
      columns: [
        {
          label: '场馆 / 场地',
          render: (row) => `<div class="cell-stack">
            <strong>${escapeHtml(row.venueName || '—')}</strong>
            <span class="text-muted">${escapeHtml(row.courtName || '—')}</span>
          </div>`,
        },
        {
          label: '日期时间',
          render: (row) => `<div class="cell-stack">
            <strong>${escapeHtml(fmtDate(row.date, false))}</strong>
            <span class="text-muted">${escapeHtml(row.startTime)} - ${escapeHtml(row.endTime)}</span>
          </div>`,
        },
        {
          label: '用户',
          render: (row) => `<span class="text-muted">#${escapeHtml(row.userId ?? '—')}</span>`,
        },
        {
          label: '凭证号',
          render: (row) => `<code class="inline-code">${escapeHtml(row.code || '—')}</code>`,
        },
        {
          label: '金额',
          align: 'right',
          render: (row) => fmtMoney(row.amount),
        },
        {
          label: '状态',
          render: (row) => statusBadge(row.status, 'booking'),
        },
        {
          label: '操作',
          align: 'right',
          render: (row) =>
            row.status === 'confirmed'
              ? `<button type="button" class="btn btn--sm btn--danger-ghost"
                  data-cancel-booking="${escapeHtml(row.id)}">强制取消</button>`
              : '<span class="text-muted text-sm">—</span>',
        },
      ],
      rows: bookings,
      emptyText: '没有符合条件的预约',
    });
    listEl.innerHTML = table;
    bindRowButtons(listEl, '[data-cancel-booking]', (button) => {
      const booking = bookings.find((item) => String(item.id) === button.dataset.cancelBooking);
      if (booking) openForceCancel(booking, button);
    });
  }

  async function loadBookings() {
    const seq = ++loadSeq;
    listEl.innerHTML = loadingHtml('正在加载预约…');
    const formData = new FormData(filterForm);
    const date = String(formData.get('date') || '');
    const status = String(formData.get('status') || '');
    try {
      const data = await api.admin.listBookings({ date: date || undefined, status: status || undefined });
      if (!ctx.isActive() || seq !== loadSeq) return;
      bookings = asArray(data);
      renderBookings();
    } catch (err) {
      if (!ctx.isActive() || seq !== loadSeq) return;
      listEl.innerHTML = adminErrorBlock(errText(err, '预约加载失败'), {
        attr: 'data-bookings-retry',
      });
      listEl.querySelector('[data-bookings-retry]')?.addEventListener('click', loadBookings);
    }
  }

  function openForceCancel(booking, triggerButton) {
    const body = modalBody(`
      <p class="notice notice--warning">强制取消会立即释放时段，并通知用户，操作不可撤销。</p>
      <dl class="detail-list detail-list--compact">
        <div><dt>场馆</dt><dd>${escapeHtml(booking.venueName || '—')} · ${escapeHtml(
          booking.courtName || '—',
        )}</dd></div>
        <div><dt>时间</dt><dd>${escapeHtml(fmtDate(booking.date))} ${escapeHtml(
          booking.startTime,
        )} - ${escapeHtml(booking.endTime)}</dd></div>
        <div><dt>凭证号</dt><dd><code class="inline-code">${escapeHtml(
          booking.code || '—',
        )}</code></dd></div>
      </dl>
      <label class="field">
        <span class="field__label">取消原因 <em>*</em></span>
        <textarea class="input" name="reason" rows="3" maxlength="200"
          placeholder="请填写取消原因，例如：场馆临时维修"></textarea>
      </label>
      <div class="form-errors" data-form-errors hidden></div>
    `);
    const modal = openModal({
      title: '强制取消预约',
      size: 'sm',
      body,
      actions: [
        { label: '返回', variant: 'ghost' },
        {
          label: '强制取消',
          variant: 'danger',
          onClick: async () => {
            const reason = body.querySelector('textarea[name="reason"]').value.trim();
            if (!reason) {
              setModalErrors(body, ['请填写取消原因']);
              return;
            }
            try {
              await api.admin.cancelBooking(booking.id, reason);
              toast('预约已强制取消', 'success');
              modal.close();
              loadBookings();
            } catch (err) {
              setModalErrors(body, [errText(err, '取消预约失败')]);
              toast(errText(err, '取消预约失败'), 'error');
            }
          },
        },
      ],
    });
  }

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadBookings();
  });
  panel.querySelector('[data-action="reset-filter"]')?.addEventListener('click', () => {
    filterForm.reset();
    loadBookings();
  });

  await loadBookings();
}

/* ========================================================================== */
/*                                  用户管理                                  */
/* ========================================================================== */

async function renderUsersTab(panel, ctx) {
  let query = '';
  let users = [];
  let loadSeq = 0;

  panel.innerHTML = `<div class="card">
    <div class="card-toolbar">
      <div><h2>用户管理</h2><p>搜索用户、调整角色与积分，或清理无关联数据的账号。</p></div>
    </div>
    <form id="admin-user-search" class="filter-inline">
      <label class="field field--grow">
        <span class="field__label">搜索用户</span>
        <span class="input-with-icon">
          <span class="input-icon" aria-hidden="true">⌕</span>
          <input class="input" name="q" type="search" placeholder="姓名、手机号或邮箱" autocomplete="off" />
        </span>
      </label>
      <button type="submit" class="btn btn--primary">搜索</button>
      <button type="button" class="btn btn--ghost" data-action="clear-user-search">清空</button>
    </form>
  </div>
  <section class="card card--flush" id="admin-user-list">${loadingHtml('正在加载用户…')}</section>`;

  const searchForm = panel.querySelector('#admin-user-search');
  const listEl = panel.querySelector('#admin-user-list');

  function renderUsers() {
    if (!ctx.isActive()) return;
    const table = renderTable({
      columns: [
        {
          label: '用户',
          render: (row) => `<div class="cell-stack">
            <strong>${escapeHtml(row.name || '—')}${
              Number(row.id) === Number(store.user?.id) ? ' <span class="tag tag--soft">我</span>' : ''
            }</strong>
            <span class="text-muted text-sm">#${escapeHtml(row.id)}</span>
          </div>`,
        },
        {
          label: '联系方式',
          render: (row) => `<div class="cell-stack">
            <span>${escapeHtml(row.phone || '未绑定手机号')}</span>
            <span class="text-muted text-sm">${escapeHtml(row.email || '未绑定邮箱')}</span>
          </div>`,
        },
        {
          label: '角色',
          render: (row) => `<select class="input input--sm" data-user-role="${escapeHtml(
            row.id,
          )}" aria-label="修改用户角色">
            <option value="user" ${row.role === 'user' ? 'selected' : ''}>普通用户</option>
            <option value="admin" ${row.role === 'admin' ? 'selected' : ''}>管理员</option>
          </select>`,
        },
        {
          label: '积分',
          render: (row) => `<div class="point-editor">
            <input class="input input--sm" type="number" min="0" max="1000000" step="1"
              value="${escapeHtml(row.points ?? 0)}" data-user-points="${escapeHtml(row.id)}"
              aria-label="用户积分" />
            <button type="button" class="btn btn--sm btn--ghost" data-save-points="${escapeHtml(
              row.id,
            )}">保存</button>
          </div>`,
        },
        {
          label: '实名',
          render: (row) =>
            row.verified
              ? '<span class="badge badge--success"><span class="badge__dot"></span>已实名</span>'
              : '<span class="badge badge--muted"><span class="badge__dot"></span>未实名</span>',
        },
        {
          label: '操作',
          align: 'right',
          render: (row) => `<button type="button" class="btn btn--sm btn--danger-ghost"
            data-delete-user="${escapeHtml(row.id)}">删除</button>`,
        },
      ],
      rows: users,
      emptyText: query ? `没有匹配「${query}」的用户` : '暂无用户',
    });
    listEl.innerHTML = `<div class="list-summary"><span>共 ${users.length} 位用户</span></div>${table}`;

    // 角色下拉：选择后立即保存
    listEl.querySelectorAll('[data-user-role]').forEach((select) => {
      select.addEventListener('change', async () => {
        const user = users.find((item) => String(item.id) === select.dataset.userRole);
        if (!user) return;
        select.disabled = true;
        try {
          const updated = await api.admin.updateUser(user.id, { role: select.value });
          if (updated && Number(updated.id) === Number(store.user?.id)) {
            store.setUser({ role: updated.role });
          }
          toast('用户角色已更新', 'success');
          await loadUsers();
        } catch (err) {
          select.value = user.role;
          toast(errText(err, '角色更新失败'), 'error');
        } finally {
          if (select.isConnected) select.disabled = false;
        }
      });
    });

    bindRowButtons(listEl, '[data-save-points]', async (button) => {
      const user = users.find((item) => String(item.id) === button.dataset.savePoints);
      if (!user) return;
      const input = button.closest('.point-editor')?.querySelector('[data-user-points]');
      const value = Number(input?.value);
      if (!input || input.value.trim() === '') {
        toast('请输入积分', 'warning');
        return;
      }
      const errors = validateAdminUserPatch({ points: value });
      if (errors.length) {
        toast(errors[0], 'warning');
        return;
      }
      try {
        const updated = await withBusy(
          button,
          () => api.admin.updateUser(user.id, { points: value }),
          '保存中…',
        );
        if (updated && Number(updated.id) === Number(store.user?.id)) {
          store.setUser(updated);
        }
        toast('积分已更新', 'success');
        await loadUsers();
      } catch (err) {
        toast(errText(err, '积分更新失败'), 'error');
      }
    });

    bindRowButtons(listEl, '[data-delete-user]', async (button) => {
      const user = users.find((item) => String(item.id) === button.dataset.deleteUser);
      if (!user) return;
      const isSelf = Number(user.id) === Number(store.user?.id);
      if (isSelf) {
        toast('不能删除当前登录的管理员账号', 'warning');
        return;
      }
      const ok = await confirmDialog({
        title: '删除用户',
        message: `确定删除用户「${user.name || user.phone || `#${user.id}`}」吗？若该用户存在预约等关联数据，后端会拒绝删除。`,
        confirmText: '确认删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await withBusy(button, () => api.admin.deleteUser(user.id), '删除中…');
        toast('用户已删除', 'success');
        await loadUsers();
      } catch (err) {
        toast(errText(err, '删除用户失败'), 'error');
      }
    });
  }

  async function loadUsers() {
    const seq = ++loadSeq;
    listEl.innerHTML = loadingHtml('正在加载用户…');
    try {
      const data = await api.admin.listUsers(query || undefined);
      if (!ctx.isActive() || seq !== loadSeq) return;
      users = asArray(data);
      renderUsers();
    } catch (err) {
      if (!ctx.isActive() || seq !== loadSeq) return;
      listEl.innerHTML = adminErrorBlock(errText(err, '用户加载失败'), {
        attr: 'data-users-retry',
      });
      listEl.querySelector('[data-users-retry]')?.addEventListener('click', loadUsers);
    }
  }

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    query = String(new FormData(searchForm).get('q') || '').trim();
    loadUsers();
  });
  panel.querySelector('[data-action="clear-user-search"]')?.addEventListener('click', () => {
    searchForm.reset();
    query = '';
    loadUsers();
  });

  await loadUsers();
}

/* ========================================================================== */
/*                                  经营报表                                  */
/* ========================================================================== */

async function renderReportTab(panel, ctx) {
  let days = 7;
  let report = null;
  let loadSeq = 0;

  panel.innerHTML = `<section class="card">
    <div class="card-toolbar">
      <div><h2>经营报表</h2><p>统计周期内各场馆的预约量、时段利用率与营收。</p></div>
      <div class="segmented" role="group" aria-label="统计周期">
        ${[7, 14, 30]
          .map(
            (item) =>
              `<button type="button" class="segmented__item${
                item === 7 ? ' is-active' : ''
              }" data-report-days="${item}">${item} 天</button>`,
          )
          .join('')}
      </div>
    </div>
    <div id="report-body">${loadingHtml('正在生成报表…')}</div>
  </section>`;

  const bodyEl = panel.querySelector('#report-body');

  function renderReport() {
    if (!report || !ctx.isActive()) return;
    const venues = asArray(report.venues);
    const totalRevenue =
      Number(report.totalRevenue) ||
      venues.reduce((sum, venue) => sum + (Number(venue.revenue) || 0), 0);
    const totalBookings =
      Number(report.totalBookings) || venues.reduce((sum, venue) => sum + (Number(venue.bookings) || 0), 0);
    const avgUtilization = venues.length
      ? venues.reduce((sum, venue) => sum + (Number(venue.utilization) || 0), 0) / venues.length
      : 0;

    const rows = venues
      .map((venue) => {
        const ratio = Math.max(0, Math.min(1, Number(venue.utilization) || 0));
        return `<tr>
          <td class="cell">
            <div class="cell-stack"><strong>${escapeHtml(venue.venueName)}</strong>
              <span class="text-muted text-sm">${escapeHtml(venue.sport || '—')}</span></div>
          </td>
          <td class="cell is-center">${escapeHtml(venue.courtCount ?? 0)}</td>
          <td class="cell is-center">${escapeHtml(venue.bookings ?? 0)}</td>
          <td class="cell">
            <div class="report-util">
              <div class="report-util__bar"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div>
              <span>${fmtPercent(ratio, 1)}</span>
            </div>
          </td>
          <td class="cell is-right"><strong>${fmtMoney(venue.revenue)}</strong></td>
        </tr>`;
      })
      .join('');

    bodyEl.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><span>统计周期</span><strong>${escapeHtml(
          `${fmtDate(report.from, false)} ~ ${fmtDate(report.to, false)}`,
        )}</strong><small>共 ${escapeHtml(report.days ?? days)} 天</small></div>
        <div class="stat-card"><span>总预约数</span><strong>${escapeHtml(totalBookings)}</strong><small>含已完成预约</small></div>
        <div class="stat-card"><span>总营收</span><strong>${fmtMoney(totalRevenue)}</strong><small>按预约金额汇总</small></div>
        <div class="stat-card"><span>平均利用率</span><strong>${fmtPercent(avgUtilization, 1)}</strong><small>各场馆算术平均</small></div>
      </div>
      <div class="table-wrap">
        <table class="data-table report-table">
          <thead><tr>
            <th>场馆</th><th class="is-center">场地数</th><th class="is-center">预约数</th>
            <th>利用率</th><th class="is-right">营收</th>
          </tr></thead>
          <tbody>${
            rows ||
            `<tr><td class="table-empty" colspan="5">所选周期内暂无场馆数据</td></tr>`
          }</tbody>
          <tfoot><tr class="total-row">
            <td>合计</td>
            <td class="is-center">${venues.reduce((sum, venue) => sum + (Number(venue.courtCount) || 0), 0)}</td>
            <td class="is-center">${escapeHtml(totalBookings)}</td>
            <td>${fmtPercent(avgUtilization, 1)}</td>
            <td class="is-right"><strong>${fmtMoney(totalRevenue)}</strong></td>
          </tr></tfoot>
        </table>
      </div>
      <p class="table-note">利用率 = 已占用时段数 / 可用时段总数；营收按预约金额统计。</p>
    `;
  }

  async function loadReport() {
    const seq = ++loadSeq;
    bodyEl.innerHTML = loadingHtml('正在生成报表…');
    try {
      report = await api.admin.report(days);
      if (!ctx.isActive() || seq !== loadSeq) return;
      renderReport();
    } catch (err) {
      if (!ctx.isActive() || seq !== loadSeq) return;
      bodyEl.innerHTML = adminErrorBlock(errText(err, '报表加载失败'), {
        attr: 'data-report-retry',
      });
      bodyEl.querySelector('[data-report-retry]')?.addEventListener('click', loadReport);
    }
  }

  panel.querySelectorAll('[data-report-days]').forEach((button) => {
    button.addEventListener('click', () => {
      days = Number(button.dataset.reportDays) || 7;
      panel.querySelectorAll('[data-report-days]').forEach((item) => {
        item.classList.toggle('is-active', item === button);
      });
      loadReport();
    });
  });

  await loadReport();
}

/* ========================================================================== */
/*                                   数据库                                   */
/* ========================================================================== */

function dbCellText(value) {
  if (value === null) return 'NULL';
  if (value === undefined) return '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[对象]';
    }
  }
  return String(value);
}

async function renderDatabaseTab(panel, ctx) {
  let stats;
  try {
    stats = await api.admin.stats();
  } catch (err) {
    showTabError(panel, ctx, err);
    return;
  }
  if (!ctx.isActive()) return;

  const config = { ...DEFAULT_BUSINESS, ...(stats?.config || {}) };
  const tableCounts = stats?.tables || {};
  const tableRows = DB_TABLES.map(
    (table) => `<tr>
      <td class="cell"><code class="inline-code">${escapeHtml(table)}</code></td>
      <td class="cell">${escapeHtml(DB_TABLE_LABEL[table] || table)}</td>
      <td class="cell is-right">${escapeHtml(tableCounts[table] ?? 0)}</td>
    </tr>`,
  ).join('');

  panel.innerHTML = `
    <section class="card">
      <div class="card-toolbar">
        <div><h2>运行状态</h2><p>来自后端 <code>/api/admin/stats</code> 的实时快照。</p></div>
        <div class="toolbar-actions">
          <button type="button" class="btn btn--ghost" data-admin-action="reload-db">↻ 刷新</button>
        </div>
      </div>
      <div class="stat-grid stat-grid--four">
        <div class="stat-card stat-card--wide">
          <span>数据库路径</span>
          <strong class="mono break-all">${escapeHtml(stats?.dbPath || '—')}</strong>
          <small>文件大小：${escapeHtml(fmtBytes(stats?.dbSizeBytes))}</small>
        </div>
        <div class="stat-card"><span>运行时长</span><strong>${escapeHtml(
          fmtUptime(stats?.uptimeSeconds),
        )}</strong><small>服务器时间：${escapeHtml(fmtDateTime(stats?.serverTime))}</small></div>
        <div class="stat-card"><span>SSE 连接数</span><strong>${escapeHtml(
          stats?.sseClients ?? 0,
        )}</strong><small>Node.js ${escapeHtml(stats?.nodeVersion || '—')}</small></div>
        <div class="stat-card"><span>业务配置</span><strong class="stat-card__small">锁定 ${escapeHtml(
          config.lockMinutes,
        )} 分钟</strong><small>开场前 ${escapeHtml(config.cancelHours)} 小时可取消 · 可预约未来 ${escapeHtml(
          config.bookingDaysAhead,
        )} 天</small></div>
      </div>
      <div class="db-table-grid">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>数据表</th><th>说明</th><th class="is-right">行数</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-toolbar">
        <div><h2>数据浏览</h2><p>仅允许浏览白名单内的数据表，支持关键词与分页。</p></div>
      </div>
      <form id="db-browse-form" class="filter-grid">
        <label class="field">
          <span class="field__label">数据表</span>
          <select class="input" name="table">
            ${DB_TABLES.map(
              (table) =>
                `<option value="${escapeHtml(table)}">${escapeHtml(
                  DB_TABLE_LABEL[table] || table,
                )}（${escapeHtml(table)}）</option>`,
            ).join('')}
          </select>
        </label>
        <label class="field field--grow">
          <span class="field__label">关键词</span>
          <input class="input" name="q" type="search" placeholder="在当前表中搜索" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field__label">每页条数</span>
          <select class="input" name="limit">
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
        <div class="filter-side">
          <button type="submit" class="btn btn--primary">查询</button>
        </div>
      </form>
      <div id="db-table-container">${loadingHtml('正在读取数据…')}</div>
      <div class="pager">
        <button type="button" class="btn btn--sm btn--ghost" data-db-page="prev" disabled>上一页</button>
        <span class="pager__info" data-db-range>—</span>
        <button type="button" class="btn btn--sm btn--ghost" data-db-page="next" disabled>下一页</button>
      </div>
    </section>
  `;

  const browseForm = panel.querySelector('#db-browse-form');
  const container = panel.querySelector('#db-table-container');
  const rangeEl = panel.querySelector('[data-db-range]');
  const prevButton = panel.querySelector('[data-db-page="prev"]');
  const nextButton = panel.querySelector('[data-db-page="next"]');
  let state = {
    table: 'users',
    q: '',
    limit: 20,
    offset: 0,
    total: 0,
    rows: [],
  };
  let loadSeq = 0;

  async function loadRows() {
    const seq = ++loadSeq;
    container.innerHTML = loadingHtml('正在读取数据…');
    try {
      const data = await api.admin.table(state.table, {
        limit: state.limit,
        offset: state.offset,
        q: state.q || undefined,
      });
      if (!ctx.isActive() || seq !== loadSeq) return;
      state.total = Number(data?.total) || 0;
      state.rows = asArray(data?.rows);
      const columns = asArray(data?.columns).map((column) => String(column));
      if (!columns.length) {
        container.innerHTML = emptyState('没有可展示的列', '该表可能为空。', '🗄');
        if (rangeEl) rangeEl.textContent = '共 0 条';
        prevButton.disabled = true;
        nextButton.disabled = true;
        return;
      }
      const table = renderTable({
        columns: columns.map((column) => ({
          label: column,
          render: (row) => {
            const text = dbCellText(row?.[column]);
            const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
            return `<span class="db-cell" title="${escapeHtml(
              text.length > 400 ? `${text.slice(0, 400)}…` : text,
            )}">${escapeHtml(preview)}</span>`;
          },
        })),
        rows: state.rows,
        emptyText: state.q ? '没有匹配关键词的记录' : '当前表暂无记录',
      });
      container.innerHTML = `<div class="list-summary"><span>${escapeHtml(
        DB_TABLE_LABEL[state.table] || state.table,
      )} · ${escapeHtml(state.table)}</span><span>${state.rows.length} 条 / 共 ${state.total} 条</span></div>${table}`;
      const start = state.total ? Math.min(state.offset + 1, state.total) : 0;
      const end = Math.min(state.offset + state.rows.length, state.total);
      if (rangeEl) rangeEl.textContent = `${start} - ${end} / 共 ${state.total} 条`;
      prevButton.disabled = state.offset <= 0;
      nextButton.disabled = state.offset + state.rows.length >= state.total;
    } catch (err) {
      if (!ctx.isActive() || seq !== loadSeq) return;
      container.innerHTML = adminErrorBlock(errText(err, '数据读取失败'), {
        attr: 'data-db-retry',
      });
      container.querySelector('[data-db-retry]')?.addEventListener('click', loadRows);
      if (rangeEl) rangeEl.textContent = '读取失败';
    }
  }

  browseForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(browseForm);
    const nextTable = String(formData.get('table') || 'users');
    if (!DB_TABLES.includes(nextTable)) return;
    state.table = nextTable;
    state.q = String(formData.get('q') || '').trim();
    state.limit = Number(formData.get('limit')) || 20;
    state.offset = 0;
    loadRows();
  });

  prevButton.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadRows();
  });
  nextButton.addEventListener('click', () => {
    if (state.offset + state.rows.length >= state.total) return;
    state.offset += state.limit;
    loadRows();
  });

  panel.querySelector('[data-admin-action="reload-db"]')?.addEventListener('click', () => {
    ctx.reload();
  });

  await loadRows();
}

/* 子 tab 渲染器注册表 */
const TAB_RENDERERS = {
  venues: renderVenuesTab,
  courts: renderCourtsTab,
  overrides: renderOverridesTab,
  bookings: renderBookingsTab,
  users: renderUsersTab,
  report: renderReportTab,
  database: renderDatabaseTab,
};
