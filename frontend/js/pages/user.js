/**
 * 普通用户页面：
 * - 场馆预约（列表 / 场地×时段网格 / 锁定 / 模拟支付 / SSE 实时刷新）
 * - 我的预约
 * - 消息
 * - 个人中心
 */

import {
  BOOKING_STATUS,
  DEFAULT_BUSINESS,
  SLOT_STATUS,
  SLOT_STATUS_LABEL,
  SPORT_OPTIONS,
} from '/shared/constants.js';
import { addDays, isDateString, parseHM, rangeText, todayString } from '/shared/time.js';
import {
  validateLockPayload,
  validatePasswordChange,
  validateProfile,
  validateVerify,
} from '/shared/validate.js';
import { api, subscribeStream } from '../api.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import {
  debounce,
  emptyState,
  escapeHtml,
  fmtCountdown,
  fmtDate,
  fmtDateTime,
  fmtMinutes,
  fmtMoney,
  fmtPercent,
  initials,
  loadingHtml,
  openModal,
  renderFormErrors,
  renderTable,
  statusBadge,
  toast,
  withBusy,
} from '../ui.js';

/* --------------------------------- 小工具 --------------------------------- */

const errText = (err, fallback = '操作失败，请稍后重试') => err?.message || fallback;
const asArray = (value) => (Array.isArray(value) ? value : []);
const PAGE_TODAY = () => todayString();

function requestLogin(target = '#/') {
  window.dispatchEvent(new CustomEvent('app:require-login', { detail: { target } }));
}

function requestUnreadRefresh() {
  window.dispatchEvent(new Event('app:refresh-unread'));
}

function pageHeading(title, subtitle, actionsHtml = '') {
  return `<section class="page-heading">
    <div>
      <p class="eyebrow">运动场馆易约</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="page-subtitle">${escapeHtml(subtitle)}</p>
    </div>
    ${actionsHtml ? `<div class="page-heading__actions">${actionsHtml}</div>` : ''}
  </section>`;
}

function inlineErrorState(message, action = '') {
  return `<div class="state-block state-block--error">
    <span class="state-block__icon" aria-hidden="true">!</span>
    <h3>加载失败</h3>
    <p>${escapeHtml(message)}</p>
    ${action}
  </div>`;
}

/* ========================================================================== */
/*                              ① 场馆预约页                                   */
/* ========================================================================== */

const SLOT_CLASS_WHITELIST = new Set([
  'available',
  'locked',
  'booked',
  'maintenance',
  'closed',
]);

function safeSlotClass(status) {
  return SLOT_CLASS_WHITELIST.has(status) ? status : 'closed';
}

function slotShortLabel(status) {
  return (
    {
      available: '可约',
      locked: '锁定',
      booked: '已约',
      maintenance: '维护',
      closed: '关闭',
    }[status] || '不可约'
  );
}

export function renderVenuePage(container) {
  let destroyed = false;
  let venues = [];
  let detailData = null;
  let currentVenueId = null;
  let selection = null; // {courtId, anchorIndex, startIndex, endIndex}
  let sseClose = null;
  let liveRefreshTimer = null;
  let lockTimer = null;
  let lockModal = null;
  let successModal = null;
  let loadListSeq = 0;
  let loadDetailSeq = 0;

  const stored = store.getSelection();
  const today = PAGE_TODAY();
  const maxDate = addDays(today, DEFAULT_BUSINESS.bookingDaysAhead);

  let sport = stored.sport || '';
  let keyword = stored.keyword || '';
  let date = isDateString(stored.date) && stored.date >= today && stored.date <= maxDate
    ? stored.date
    : today;
  let live = stored.live !== false;

  // 进入页面时恢复到上次浏览的场馆
  if (stored.venueId) currentVenueId = Number(stored.venueId) || null;

  container.innerHTML = `
    ${pageHeading(
      '找到你的运动主场',
      '实时查看场地空闲时段，选中后锁定 10 分钟，再确认预约。',
      '<button type="button" class="btn btn--ghost" data-action="refresh">↻ 刷新</button>',
    )}
    <section class="card filter-card" aria-label="场馆筛选">
      <div class="filter-grid">
        <label class="field">
          <span class="field__label">运动类型</span>
          <select class="input" id="venue-sport-filter">
            <option value="">全部运动类型</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">日期</span>
          <input class="input" type="date" id="venue-date-filter" value="${escapeHtml(date)}"
            min="${escapeHtml(today)}" max="${escapeHtml(maxDate)}" />
        </label>
        <label class="field field--grow">
          <span class="field__label">关键词</span>
          <span class="input-with-icon">
            <span class="input-icon" aria-hidden="true">⌕</span>
            <input class="input" id="venue-keyword-filter" type="search"
              placeholder="搜索场馆名称或地址" value="${escapeHtml(keyword)}" autocomplete="off" />
          </span>
        </label>
        <div class="filter-side">
          <label class="switch">
            <input type="checkbox" id="venue-live-toggle" ${live ? 'checked' : ''} />
            <span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span>
            <span>实时刷新</span>
          </label>
          <div class="realtime-indicator" data-state="idle">
            <span class="realtime-indicator__dot"></span>
            <span data-realtime-text>实时刷新已开启</span>
          </div>
        </div>
      </div>
    </section>
    <section id="venue-list-section" aria-live="polite"></section>
    <section id="venue-detail-section" class="section" hidden aria-live="polite"></section>
  `;

  const sportSelect = container.querySelector('#venue-sport-filter');
  const dateInput = container.querySelector('#venue-date-filter');
  const keywordInput = container.querySelector('#venue-keyword-filter');
  const liveToggle = container.querySelector('#venue-live-toggle');
  const listSection = container.querySelector('#venue-list-section');
  const detailSection = container.querySelector('#venue-detail-section');
  const refreshButton = container.querySelector('[data-action="refresh"]');

  /* ----------------------------- 实时状态与 SSE ----------------------------- */

  function setRealtimeState(status, text) {
    if (destroyed) return;
    const indicator = container.querySelector('.realtime-indicator');
    const textEl = container.querySelector('[data-realtime-text]');
    if (indicator) indicator.dataset.state = status;
    if (textEl) textEl.textContent = text;
  }

  function closeStream() {
    if (sseClose) {
      const close = sseClose;
      sseClose = null;
      close();
    }
  }

  function setupStream() {
    closeStream();
    if (!live) {
      setRealtimeState('off', '实时刷新已关闭');
      return;
    }
    if (!document.getElementById('venue-date-filter')) return;
    setRealtimeState('connecting', '正在连接实时状态…');
    sseClose = subscribeStream(
      {
        date: detailData?.date || date,
        venueId: currentVenueId || undefined,
      },
      {
        onStatus(status) {
          if (destroyed || !live) return;
          if (status === 'open') setRealtimeState('on', '实时状态已连接');
          else if (status === 'error') setRealtimeState('error', '实时连接中断，正在自动重连…');
          else if (status === 'closed') setRealtimeState('off', '实时刷新已关闭');
        },
        onEvent() {
          scheduleLiveRefresh();
        },
      },
    );
  }

  function scheduleLiveRefresh() {
    if (destroyed || !live) return;
    if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
    liveRefreshTimer = window.setTimeout(() => {
      liveRefreshTimer = null;
      if (destroyed || !live) return;
      if (currentVenueId) loadDetail(currentVenueId, { silent: true, preserveSelection: true });
      else loadVenues({ silent: true });
    }, 450);
  }

  /* -------------------------------- 场馆列表 -------------------------------- */

  async function loadSports() {
    let sports = [];
    try {
      sports = asArray(await api.venues.sports());
    } catch (err) {
      sports = [...SPORT_OPTIONS];
      if (!destroyed && err?.status !== 401) {
        toast('运动类型加载失败，已使用内置选项', 'warning');
      }
    }
    if (destroyed || !sportSelect) return;
    const finalSports = sports.length ? sports : SPORT_OPTIONS;
    sportSelect.innerHTML = `<option value="">全部运动类型</option>${finalSports
      .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
      .join('')}`;
    sportSelect.value = sport;
    if (sport && sportSelect.value !== sport) {
      // 缓存的筛选值已不存在，自动回退到全部
      sport = '';
      sportSelect.value = '';
      store.setSelection({ sport: '' });
    }
  }

  function renderVenueList() {
    if (destroyed) return;
    if (!venues.length) {
      listSection.innerHTML = `
        <div class="section-heading">
          <div><h2>全部场馆</h2><p>换个筛选条件试试</p></div>
        </div>
        ${emptyState('没有找到符合条件的场馆', '可以清空运动类型或关键词后再试', '🏟')}`;
      return;
    }

    const cards = venues
      .map((venue) => {
        const utilization = Math.max(0, Math.min(1, Number(venue.utilization) || 0));
        const open = Boolean(venue.open);
        return `<article class="venue-card${open ? '' : ' venue-card--closed'}" tabindex="0"
            role="button" data-venue-id="${escapeHtml(venue.id)}"
            aria-label="查看 ${escapeHtml(venue.name)} 的场地时段">
          <div class="venue-card__top">
            <span class="tag">${escapeHtml(venue.sport || '运动')}</span>
            ${statusBadge(venue.status, 'venue')}
          </div>
          <h3 class="venue-card__name">${escapeHtml(venue.name)}</h3>
          <p class="venue-card__address">📍 ${escapeHtml(venue.address || '暂无地址信息')}</p>
          <div class="venue-card__meta">
            <span>🕘 ${escapeHtml(venue.openTime || '—')} - ${escapeHtml(venue.closeTime || '—')}</span>
            <span>${escapeHtml(venue.courtCount ?? 0)} 片场地</span>
          </div>
          <div class="utilization">
            <div class="utilization__bar"><span style="width:${(utilization * 100).toFixed(1)}%"></span></div>
            <div class="utilization__text">
              <span>可用 ${escapeHtml(venue.availableSlots ?? 0)} / ${escapeHtml(venue.totalSlots ?? 0)} 个时段</span>
              <strong>已占用 ${fmtPercent(utilization)}</strong>
            </div>
          </div>
          <div class="venue-card__footer">
            <span class="${open ? 'text-success' : 'text-muted'}">${open ? '开放预约中' : '当前不可预约'}</span>
            <span class="venue-card__link">查看时段 →</span>
          </div>
        </article>`;
      })
      .join('');

    listSection.innerHTML = `
      <div class="section-heading">
        <div>
          <h2>全部场馆 <span class="count-pill">${venues.length}</span></h2>
          <p>${escapeHtml(fmtDate(date))} · 点击场馆查看场地时段</p>
        </div>
      </div>
      <div class="venue-grid">${cards}</div>`;
  }

  async function loadVenues({ silent = false } = {}) {
    const seq = ++loadListSeq;
    if (!silent) listSection.innerHTML = loadingHtml('正在加载场馆…');
    try {
      const data = await api.venues.list({ sport, keyword, date });
      if (destroyed || seq !== loadListSeq) return;
      venues = asArray(data);
      renderVenueList();
    } catch (err) {
      if (destroyed || seq !== loadListSeq) return;
      if (silent) return;
      listSection.innerHTML = `<div class="section">
        ${inlineErrorState(errText(err, '场馆加载失败'), '<button type="button" class="btn btn--primary" data-action="retry-venues">重新加载</button>')}
      </div>`;
    }
  }

  function showList({ skipListRefresh = false } = {}) {
    currentVenueId = null;
    detailData = null;
    selection = null;
    store.setSelection({
      venueId: null,
      courtId: null,
      startTime: null,
      endTime: null,
    });
    detailSection.hidden = true;
    listSection.hidden = false;
    loadListSeq += 1;
    if (skipListRefresh) return;
    // 返回列表时重新拉取可用时段，避免使用切换日期前的旧数据
    loadVenues();
  }

  async function openVenue(id) {
    const venueId = Number(id);
    if (!venueId) return;
    currentVenueId = venueId;
    detailData = null;
    selection = null;
    listSection.hidden = true;
    detailSection.hidden = false;
    store.setSelection({
      venueId,
      courtId: null,
      startTime: null,
      endTime: null,
    });
    detailSection.innerHTML = loadingHtml('正在加载场地时段…');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await loadDetail(venueId, { preserveSelection: false });
    if (!destroyed && currentVenueId === venueId) setupStream();
  }

  /* -------------------------------- 场馆详情 -------------------------------- */

  function getCurrentSlots() {
    if (!selection || !detailData) return [];
    const court = asArray(detailData.slots).find(
      (row) => Number(row.courtId) === Number(selection.courtId),
    );
    if (!court) return [];
    return asArray(court.slots).slice(selection.startIndex, selection.endIndex + 1);
  }

  function selectionPayload() {
    const slots = getCurrentSlots();
    if (!selection || !slots.length) return null;
    return {
      courtId: Number(selection.courtId),
      startTime: slots[0].startTime,
      endTime: slots[slots.length - 1].endTime,
      date: detailData.date,
      amount: slots.reduce((sum, slot) => sum + (Number(slot.price) || 0), 0),
      minutes: slots.reduce(
        (sum, slot) => sum + Math.max(0, Number(slot.endMin) - Number(slot.startMin)),
        0,
      ),
    };
  }

  function isSlotPast(slot) {
    if (!detailData) return true;
    if (detailData.date < todayString()) return true;
    if (detailData.date > todayString()) return false;
    const startMin = parseHM(slot.startTime);
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return startMin !== null && startMin <= nowMin;
  }

  function rangeIsAvailable(courtRow, startIndex, endIndex) {
    const slots = asArray(courtRow?.slots).slice(startIndex, endIndex + 1);
    if (slots.length !== endIndex - startIndex + 1) return false;
    return slots.every((slot) => slot.status === SLOT_STATUS.AVAILABLE && !isSlotPast(slot));
  }

  function syncSelectionToStore() {
    const payload = selectionPayload();
    store.setSelection({
      venueId: currentVenueId,
      date,
      courtId: payload?.courtId ?? null,
      startTime: payload?.startTime ?? null,
      endTime: payload?.endTime ?? null,
    });
  }

  function updateSelectionUI() {
    if (!detailSection || destroyed) return;
    const payload = selectionPayload();

    detailSection.querySelectorAll('.slot-cell').forEach((cell) => {
      const selected =
        Boolean(selection) &&
        Number(cell.dataset.courtId) === Number(selection.courtId) &&
        Number(cell.dataset.index) >= selection.startIndex &&
        Number(cell.dataset.index) <= selection.endIndex;
      cell.classList.toggle('is-selected', selected);
      cell.setAttribute('aria-pressed', String(selected));
    });

    const summary = detailSection.querySelector('[data-selection-summary]');
    const lockButton = detailSection.querySelector('[data-action="lock"]');
    if (summary) {
      if (!payload) {
        summary.innerHTML = '<span class="selection-empty">点击上方可约时段开始选择，再次点击可连续扩展时段</span>';
      } else {
        const court = asArray(detailData.slots).find(
          (row) => Number(row.courtId) === payload.courtId,
        );
        summary.innerHTML = `
          <span class="selection-chip">${escapeHtml(court?.courtName || '已选场地')}</span>
          <span class="selection-range">${escapeHtml(payload.startTime)} - ${escapeHtml(payload.endTime)}</span>
          <span class="selection-meta">${escapeHtml(fmtMinutes(payload.minutes))}</span>
          <strong class="selection-amount">${fmtMoney(payload.amount)}</strong>`;
      }
    }
    if (lockButton) lockButton.disabled = !payload;
  }

  function handleSlotClick(courtId, index) {
    if (!detailData) return;
    const court = asArray(detailData.slots).find(
      (row) => Number(row.courtId) === Number(courtId),
    );
    const slot = court?.slots?.[index];
    if (!court || !slot) return;
    if (slot.status !== SLOT_STATUS.AVAILABLE || isSlotPast(slot)) {
      toast('该时段当前不可预约', 'warning');
      return;
    }

    if (!selection || Number(selection.courtId) !== Number(courtId)) {
      selection = {
        courtId: Number(courtId),
        anchorIndex: index,
        startIndex: index,
        endIndex: index,
      };
    } else {
      const start = Math.min(selection.anchorIndex, index);
      const end = Math.max(selection.anchorIndex, index);
      if (!rangeIsAvailable(court, start, end)) {
        toast('所选连续区间中包含不可预约的时段，请重新选择', 'warning');
        return;
      }
      selection.startIndex = start;
      selection.endIndex = end;
    }

    hideSuggestions();
    syncSelectionToStore();
    updateSelectionUI();
  }

  function hideSuggestions() {
    const box = detailSection.querySelector('[data-suggestions]');
    if (box) box.innerHTML = '';
  }

  function renderSuggestions(error, courtId) {
    const box = detailSection.querySelector('[data-suggestions]');
    if (!box) return;
    const suggestions = asArray(error?.suggestions);
    if (!suggestions.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `<div class="suggestions">
      <div class="suggestions__head">
        <strong>该时段刚刚被占用</strong>
        <span>为你找到了相邻可约时段，可直接切换：</span>
      </div>
      <div class="suggestions__list">
        ${suggestions
          .map(
            (item) => `<button type="button" class="suggestion-btn"
              data-court-id="${escapeHtml(item.courtId)}"
              data-start-time="${escapeHtml(item.startTime)}"
              data-end-time="${escapeHtml(item.endTime)}">
              <span>${escapeHtml(item.courtName || '场地')}</span>
              <b>${escapeHtml(item.startTime)} - ${escapeHtml(item.endTime)}</b>
              <small>选择此时段</small>
            </button>`,
          )
          .join('')}
      </div>
    </div>`;
    const target = box.querySelector('.suggestion-btn');
    target?.focus({ preventScroll: true });
    // 记录原请求场地，推荐按钮只需要时段信息
    box.dataset.originalCourtId = String(courtId ?? '');
  }

  function applySuggestion(button) {
    if (!detailData) return;
    const courtId = Number(button.dataset.courtId);
    const startTime = button.dataset.startTime;
    const endTime = button.dataset.endTime;
    const row = asArray(detailData.slots).find((item) => Number(item.courtId) === courtId);
    if (!row) {
      toast('推荐场地已更新，正在为你刷新时段', 'warning');
      loadDetail(currentVenueId, { silent: true, preserveSelection: true });
      return;
    }
    const startIndex = row.slots.findIndex((slot) => slot.startTime === startTime);
    const endIndex = row.slots.findIndex((slot) => slot.endTime === endTime);
    if (startIndex < 0 || endIndex < startIndex || !rangeIsAvailable(row, startIndex, endIndex)) {
      toast('推荐时段刚刚被占用，请重新选择', 'warning');
      loadDetail(currentVenueId, { silent: true, preserveSelection: true });
      return;
    }
    selection = {
      courtId,
      anchorIndex: startIndex,
      startIndex,
      endIndex,
    };
    hideSuggestions();
    syncSelectionToStore();
    updateSelectionUI();
    detailSection.querySelector('.selection-panel')?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
    toast(`已切换为 ${startTime} - ${endTime}`, 'success');
  }

  function reconcileSelection(previous, { preserveSelection, silent }) {
    if (!previous || !preserveSelection) {
      selection = null;
      return;
    }
    const row = asArray(detailData.slots).find(
      (item) => Number(item.courtId) === Number(previous.courtId),
    );
    if (!row) {
      selection = null;
      if (!silent) toast('场地信息已变化，请重新选择时段', 'warning');
      return;
    }
    const startIndex = row.slots.findIndex((slot) => slot.startTime === previous.startTime);
    const endIndex = row.slots.findIndex((slot) => slot.endTime === previous.endTime);
    if (startIndex < 0 || endIndex < startIndex || !rangeIsAvailable(row, startIndex, endIndex)) {
      selection = null;
      toast('你选择的时段状态已变化，请重新选择', 'warning');
      return;
    }
    selection = {
      courtId: Number(row.courtId),
      anchorIndex: startIndex,
      startIndex,
      endIndex,
    };
  }

  function renderDetailView() {
    if (!detailData || destroyed) return;
    const venue = detailData;
    const courtRows = asArray(venue.slots);
    const firstSlots = asArray(courtRows[0]?.slots);
    const courtMeta = new Map(
      asArray(venue.courts).map((court) => [Number(court.id), court]),
    );
    const totalAvailable = courtRows.reduce(
      (sum, row) =>
        sum + asArray(row.slots).filter((slot) => slot.status === SLOT_STATUS.AVAILABLE && !isSlotPast(slot)).length,
      0,
    );

    const legend = ['available', 'locked', 'booked', 'maintenance', 'closed']
      .map(
        (status) => `<span class="legend__item"><span class="legend__dot legend__dot--${status}"></span>${escapeHtml(
          SLOT_STATUS_LABEL[status],
        )}</span>`,
      )
      .join('');

    const header = `<div class="detail-head">
      <button type="button" class="btn btn--ghost btn--sm" data-action="back">← 返回场馆列表</button>
      <div class="detail-head__main">
        <div class="detail-head__tags">
          <span class="tag">${escapeHtml(venue.sport || '运动')}</span>
          ${statusBadge(venue.status, 'venue')}
        </div>
        <h1>${escapeHtml(venue.name)}</h1>
        <p>📍 ${escapeHtml(venue.address || '暂无地址')}</p>
        <p class="text-muted">🕘 ${escapeHtml(venue.openTime || '—')} - ${escapeHtml(
          venue.closeTime || '—',
        )} · 每节 ${escapeHtml(venue.slotMinutes ?? '—')} 分钟 · ${escapeHtml(fmtDate(venue.date))}</p>
      </div>
      <div class="detail-head__stats">
        <span><b>${courtRows.length}</b> 片场地</span>
        <span><b>${totalAvailable}</b> 个可约时段</span>
      </div>
    </div>`;

    if (!courtRows.length) {
      detailSection.innerHTML = `${header}
        <section class="card">${emptyState('该场馆还没有场地', '管理员添加场地后即可开始预约', '🏸')}</section>`;
      updateSelectionUI();
      return;
    }

    const timeHeaders = firstSlots
      .map(
        (slot) =>
          `<th scope="col" title="${escapeHtml(slot.startTime)} - ${escapeHtml(
            slot.endTime,
          )}"><span>${escapeHtml(slot.startTime)}</span></th>`,
      )
      .join('');

    const rows = courtRows
      .map((court) => {
        const cells = asArray(court.slots)
          .map((slot, index) => {
            const status = safeSlotClass(slot.status);
            const past = isSlotPast(slot);
            const selected =
              Boolean(selection) &&
              Number(selection.courtId) === Number(court.courtId) &&
              index >= selection.startIndex &&
              index <= selection.endIndex;
            const usable = status === SLOT_STATUS.AVAILABLE && !past;
            const mainText = usable
              ? fmtMoney(slot.price)
              : past
                ? '已过'
                : slotShortLabel(status);
            const subText = usable ? '可约' : '';
            const label = `${court.courtName || '场地'} ${slot.startTime}-${slot.endTime} ${
              past ? '已过' : SLOT_STATUS_LABEL[status] || '不可约'
            }${usable ? `，价格 ${fmtMoney(slot.price)}` : ''}`;
            return `<td>
              <button type="button"
                class="slot-cell slot-cell--${status}${selected ? ' is-selected' : ''}${past ? ' is-past' : ''}"
                data-court-id="${escapeHtml(court.courtId)}"
                data-index="${index}"
                title="${escapeHtml(label)}"
                aria-label="${escapeHtml(label)}"
                aria-pressed="${selected}"
                ${usable ? '' : 'disabled'}>
                <span class="slot-cell__main">${escapeHtml(mainText)}</span>
                ${subText ? `<span class="slot-cell__sub">${subText}</span>` : ''}
              </button>
            </td>`;
          })
          .join('');

        return `<tr>
          <th scope="row" class="court-col">
            <span class="court-col__name">${escapeHtml(court.courtName || '未命名场地')}</span>
            <span class="court-col__price">${fmtMoney(
              courtMeta.get(Number(court.courtId))?.pricePerHour ??
                asArray(court.slots)[0]?.price ??
                0,
            )}/小时</span>
          </th>
          ${cells}
        </tr>`;
      })
      .join('');

    detailSection.innerHTML = `${header}
      <section class="card slot-card">
        <div class="slot-toolbar">
          <div class="legend" aria-label="时段状态颜色说明">${legend}</div>
          <p class="slot-hint">点击第一个可约时段作为起点，再点击同一场地的另一个时段即可连续选择。</p>
        </div>
        <div class="selection-panel">
          <div class="selection-summary" data-selection-summary></div>
          <button type="button" class="btn btn--primary" data-action="lock" disabled>立即锁定</button>
        </div>
        <div data-suggestions></div>
        <div class="slot-grid-wrap">
          <table class="slot-grid">
            <caption class="sr-only">${escapeHtml(venue.name)} 场地与时段可预约情况</caption>
            <thead><tr><th scope="col" class="court-col">场地 / 时间</th>${timeHeaders}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
    updateSelectionUI();
  }

  async function loadDetail(venueId, { silent = false, preserveSelection = true } = {}) {
    const id = Number(venueId);
    if (!id) return;
    const previous = preserveSelection && detailData?.id === id ? selectionPayload() : null;
    let wantedRestore = previous;
    if (!wantedRestore && preserveSelection && !detailData) {
      // 首次进入页面时，从全局状态恢复上次选择
      const saved = store.getSelection();
      if (saved.courtId && saved.startTime && saved.endTime && Number(saved.venueId) === id) {
        // 先记下时间，等数据回来后再映射成下标
        wantedRestore = {
          courtId: Number(saved.courtId),
          startTime: saved.startTime,
          endTime: saved.endTime,
        };
      }
    }

    const seq = ++loadDetailSeq;
    if (!silent) detailSection.innerHTML = loadingHtml('正在加载场地时段…');
    try {
      const data = await api.venues.detail(id, date);
      if (destroyed || seq !== loadDetailSeq || Number(currentVenueId) !== id) return;
      detailData = data;
      date = data.date || date;
      if (dateInput) dateInput.value = date;
      store.setSelection({ venueId: id, date });
      reconcileSelection(wantedRestore, { preserveSelection, silent });
      renderDetailView();
      syncSelectionToStore();
    } catch (err) {
      if (destroyed || seq !== loadDetailSeq) return;
      if (silent) {
        setRealtimeState('error', '自动刷新失败，请稍后重试');
        return;
      }
      detailSection.innerHTML = `<div class="section">
        ${inlineErrorState(
          errText(err, '场馆时段加载失败'),
          `<div class="state-actions">
            <button type="button" class="btn btn--ghost" data-action="back">返回场馆列表</button>
            <button type="button" class="btn btn--primary" data-action="retry-detail">重新加载</button>
          </div>`,
        )}
      </div>`;
    }
  }

  /* --------------------------------- 锁定流程 -------------------------------- */

  function clearLockTimer() {
    if (lockTimer) clearInterval(lockTimer);
    lockTimer = null;
  }

  function openLockModal(lock) {
    clearLockTimer();
    if (lockModal) lockModal.close();

    const lockMinutes = Number(lock.lockMinutes) || DEFAULT_BUSINESS.lockMinutes;
    const expiresAt =
      lock.expiresAt && !Number.isNaN(new Date(lock.expiresAt).getTime())
        ? new Date(lock.expiresAt).getTime()
        : Date.now() + (Number(lock.remainSeconds) || lockMinutes * 60) * 1000;
    let expired = false;
    let expireNotified = false;

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="lock-banner">
        <div>
          <span class="lock-banner__label">请尽快确认，超时后时段将自动释放</span>
          <strong class="lock-countdown" data-lock-countdown>${escapeHtml(
            fmtCountdown(Math.max(0, (expiresAt - Date.now()) / 1000)),
          )}</strong>
        </div>
        <span class="tag">锁定 ${escapeHtml(lockMinutes)} 分钟</span>
      </div>
      <dl class="detail-list">
        <div><dt>场馆</dt><dd>${escapeHtml(lock.venueName || '—')}</dd></div>
        <div><dt>场地</dt><dd>${escapeHtml(lock.courtName || '—')}</dd></div>
        <div><dt>日期</dt><dd>${escapeHtml(fmtDate(lock.date))}</dd></div>
        <div><dt>时间</dt><dd>${escapeHtml(lock.startTime)} - ${escapeHtml(lock.endTime)}</dd></div>
        <div><dt>金额</dt><dd><strong class="text-primary">${fmtMoney(lock.amount)}</strong></dd></div>
      </dl>
      <p class="notice notice--info">这是模拟支付流程，确认后会立即生成预约凭证，不会真实扣款。</p>
    `;
    const countdownEl = body.querySelector('[data-lock-countdown]');

    const modal = openModal({
      title: '确认预约信息',
      body,
      size: 'md',
      actions: [
        {
          key: 'abandon',
          label: '放弃锁定',
          variant: 'ghost',
          onClick: () => {
            modal.close();
            toast('已放弃本次锁定，所选时段将在锁定到期后释放', 'info');
            loadDetail(currentVenueId, { silent: true, preserveSelection: false });
          },
        },
        {
          key: 'confirm',
          label: '确认预约（模拟支付）',
          variant: 'primary',
          onClick: async () => {
            if (expired) {
              modal.setError('锁定已超时，请返回重新选择时段。');
              return;
            }
            try {
              const booking = await api.bookings.create(lock.lockId);
              clearLockTimer();
              modal.close();
              showBookingSuccess(booking);
              requestUnreadRefresh();
              selection = null;
              store.clearSlotSelection();
              loadDetail(currentVenueId, { silent: true, preserveSelection: false });
            } catch (err) {
              modal.setError(errText(err, '预约失败，请重新选择时段'));
              if (err?.status === 409 || err?.status === 410) {
                expired = true;
                if (countdownEl) countdownEl.textContent = '已失效';
                const confirmButton = modal.buttons.confirm;
                if (confirmButton) confirmButton.disabled = true;
              }
              toast(errText(err, '预约失败，请重新选择时段'), 'error');
            }
          },
        },
      ],
      onClose: () => {
        clearLockTimer();
        if (lockModal === modal) lockModal = null;
      },
    });
    lockModal = modal;

    function updateCountdown() {
      const remainMs = expiresAt - Date.now();
      if (remainMs <= 0) {
        if (!expired) {
          expired = true;
          if (countdownEl) countdownEl.textContent = '已超时';
          modal.setError('锁定已超时，请关闭窗口重新选择时段。');
          const confirmButton = modal.buttons.confirm;
          if (confirmButton) confirmButton.disabled = true;
          if (lockTimer) clearInterval(lockTimer);
          lockTimer = null;
          if (!expireNotified) {
            expireNotified = true;
            toast('锁定已超时，时段将自动释放', 'warning');
          }
        }
        return;
      }
      if (countdownEl) countdownEl.textContent = fmtCountdown(remainMs / 1000);
    }

    updateCountdown();
    lockTimer = window.setInterval(updateCountdown, 1000);
  }

  function showBookingSuccess(booking) {
    if (successModal) successModal.close();
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="success-hero">
        <span class="success-hero__icon" aria-hidden="true">✓</span>
        <div>
          <h3>预约成功</h3>
          <p>请按预约时间到场，向工作人员出示凭证号。</p>
        </div>
      </div>
      <div class="code-box">
        <span>预约凭证号</span>
        <strong>${escapeHtml(booking.code || '—')}</strong>
      </div>
      <dl class="detail-list">
        <div><dt>场馆</dt><dd>${escapeHtml(booking.venueName || '—')}</dd></div>
        <div><dt>场地</dt><dd>${escapeHtml(booking.courtName || '—')}</dd></div>
        <div><dt>日期</dt><dd>${escapeHtml(fmtDate(booking.date))}</dd></div>
        <div><dt>时间</dt><dd>${escapeHtml(booking.startTime)} - ${escapeHtml(booking.endTime)}</dd></div>
        <div><dt>金额</dt><dd>${fmtMoney(booking.amount)}</dd></div>
        <div><dt>状态</dt><dd>${statusBadge(booking.status || BOOKING_STATUS.CONFIRMED, 'booking')}</dd></div>
      </dl>
      <div class="qr-block">
        <span>入场二维码数据（base64url）</span>
        <code class="qr-code">${escapeHtml(booking.qrCode || '—')}</code>
      </div>
      <p class="notice notice--info">已同步至“我的预约”，可在开场前 ${escapeHtml(
        DEFAULT_BUSINESS.cancelHours,
      )} 小时之外自行取消。</p>
    `;
    successModal = openModal({
      title: '预约成功',
      size: 'md',
      body,
      actions: [
        { key: 'close', label: '继续选场', variant: 'ghost', onClick: () => successModal?.close() },
        {
          key: 'mine',
          label: '查看我的预约',
          variant: 'primary',
          onClick: () => {
            successModal?.close();
            navigate('#/mine');
          },
        },
      ],
      onClose: () => {
        successModal = null;
      },
    });
  }

  async function handleLockClick() {
    if (!store.token) {
      requestLogin('#/');
      toast('请先登录后再锁定场地', 'warning');
      return;
    }
    const payload = selectionPayload();
    if (!payload) {
      toast('请先选择可预约时段', 'warning');
      return;
    }
    const errors = validateLockPayload(payload);
    if (errors.length) {
      toast(errors[0], 'warning');
      return;
    }
    const lockButton = detailSection.querySelector('[data-action="lock"]');
    try {
      await withBusy(
        lockButton,
        async () => {
          const lock = await api.bookings.lock({
            courtId: payload.courtId,
            date: payload.date,
            startTime: payload.startTime,
            endTime: payload.endTime,
          });
          hideSuggestions();
          openLockModal(lock);
        },
        '锁定中…',
      );
    } catch (err) {
      if (err?.status === 409) {
        renderSuggestions(err, payload.courtId);
        toast(err.message || '该时段已被占用，请选择推荐时段', 'warning');
      } else {
        toast(errText(err, '锁定失败，请稍后重试'), 'error');
      }
    } finally {
      if (lockButton?.isConnected) {
        lockButton.disabled = !selectionPayload();
      }
    }
  }

  /* --------------------------------- 事件绑定 -------------------------------- */

  function onContainerClick(event) {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl && container.contains(actionEl)) {
      const action = actionEl.dataset.action;
      if (action === 'refresh') {
        if (currentVenueId) {
          withBusy(actionEl, () => loadDetail(currentVenueId, { preserveSelection: true }), '刷新中…');
        } else {
          withBusy(actionEl, () => loadVenues(), '刷新中…');
        }
        return;
      }
      if (action === 'back') {
        showList();
        setupStream();
        return;
      }
      if (action === 'retry-venues') {
        loadVenues();
        return;
      }
      if (action === 'retry-detail') {
        loadDetail(currentVenueId, { preserveSelection: true });
        return;
      }
      if (action === 'lock') {
        handleLockClick();
        return;
      }
    }

    const suggestion = event.target.closest('.suggestion-btn');
    if (suggestion && detailSection.contains(suggestion)) {
      applySuggestion(suggestion);
      return;
    }

    const slotCell = event.target.closest('.slot-cell[data-court-id]');
    if (slotCell && detailSection.contains(slotCell) && !slotCell.disabled) {
      handleSlotClick(Number(slotCell.dataset.courtId), Number(slotCell.dataset.index));
      return;
    }

    const venueCard = event.target.closest('.venue-card[data-venue-id]');
    if (venueCard && listSection.contains(venueCard)) {
      openVenue(venueCard.dataset.venueId);
    }
  }

  function onContainerKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const venueCard = event.target.closest('.venue-card[data-venue-id]');
    if (venueCard && listSection.contains(venueCard)) {
      event.preventDefault();
      openVenue(venueCard.dataset.venueId);
    }
  }

  const onSportChange = () => {
    sport = sportSelect.value;
    store.setSelection({ sport, venueId: null });
    if (currentVenueId) showList({ skipListRefresh: true });
    loadVenues();
    setupStream();
  };

  const debouncedKeyword = debounce(() => {
    if (destroyed) return;
    keyword = keywordInput.value.trim();
    store.setSelection({ keyword, venueId: null });
    if (currentVenueId) showList({ skipListRefresh: true });
    loadVenues();
    setupStream();
  }, 320);

  const onKeywordInput = () => debouncedKeyword();

  const onDateChange = () => {
    const value = dateInput.value;
    if (!isDateString(value)) {
      toast('请选择有效的日期', 'warning');
      dateInput.value = date;
      return;
    }
    if (value < today) {
      toast('不能查看过去的日期', 'warning');
      dateInput.value = date;
      return;
    }
    if (value > maxDate) {
      toast(`最多可预约未来 ${DEFAULT_BUSINESS.bookingDaysAhead} 天`, 'warning');
      dateInput.value = date;
      return;
    }
    if (value === date) return;
    date = value;
    selection = null;
    detailData = detailData ? { ...detailData, date } : null;
    store.setSelection({
      date,
      courtId: null,
      startTime: null,
      endTime: null,
    });
    if (currentVenueId) {
      loadDetail(currentVenueId, { preserveSelection: false });
      setupStream();
    } else {
      loadVenues();
      setupStream();
    }
  };

  const onLiveChange = () => {
    live = liveToggle.checked;
    store.setSelection({ live });
    setupStream();
    toast(live ? '实时刷新已开启' : '实时刷新已关闭', 'info', { duration: 1800 });
    if (live) {
      if (currentVenueId) loadDetail(currentVenueId, { silent: true, preserveSelection: true });
      else loadVenues({ silent: true });
    }
  };

  container.addEventListener('click', onContainerClick);
  container.addEventListener('keydown', onContainerKeydown);
  sportSelect?.addEventListener('change', onSportChange);
  keywordInput?.addEventListener('input', onKeywordInput);
  dateInput?.addEventListener('change', onDateChange);
  liveToggle?.addEventListener('change', onLiveChange);

  /* --------------------------------- 初始化 --------------------------------- */

  (async () => {
    listSection.innerHTML = loadingHtml('正在加载场馆…');
    await loadSports();
    if (destroyed) return;
    if (currentVenueId) {
      detailSection.hidden = false;
      listSection.hidden = true;
      await loadDetail(currentVenueId, { preserveSelection: true });
      if (!destroyed && currentVenueId && !detailData) {
        // 恢复失败时回到列表（showList 内部会发起加载）
        showList();
      }
    } else {
      await loadVenues();
    }
    if (!destroyed) {
      setupStream();
      const refresh = refreshButton;
      if (refresh) refresh.disabled = false;
    }
  })();

  return () => {
    destroyed = true;
    loadListSeq += 1;
    loadDetailSeq += 1;
    debouncedKeyword.cancel?.();
    if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
    clearLockTimer();
    closeStream();
    lockModal?.close();
    successModal?.close();
    container.removeEventListener('click', onContainerClick);
    container.removeEventListener('keydown', onContainerKeydown);
  };
}

/* ========================================================================== */
/*                               ② 我的预约                                    */
/* ========================================================================== */

export function renderMinePage(container) {
  let destroyed = false;
  let loadSeq = 0;
  let status = '';
  let filterDate = '';
  let bookings = [];

  container.innerHTML = `
    ${pageHeading('我的预约', '查看预约凭证，管理即将到来的运动安排。', '<button type="button" class="btn btn--ghost" data-action="refresh">↻ 刷新</button>')}
    <section class="card filter-card">
      <div class="filter-grid filter-grid--compact">
        <label class="field">
          <span class="field__label">预约状态</span>
          <select class="input" id="mine-status-filter">
            <option value="">全部状态</option>
            <option value="confirmed">已预约</option>
            <option value="completed">已完成</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">日期</span>
          <input class="input" type="date" id="mine-date-filter" />
        </label>
        <div class="filter-side">
          <button type="button" class="btn btn--ghost" data-action="reset">重置筛选</button>
        </div>
      </div>
    </section>
    <section id="mine-list"></section>
  `;

  const listEl = container.querySelector('#mine-list');
  const statusSelect = container.querySelector('#mine-status-filter');
  const dateInput = container.querySelector('#mine-date-filter');

  function renderList() {
    if (destroyed) return;
    if (!bookings.length) {
      listEl.innerHTML = `<div class="card">${emptyState(
        '还没有相关预约',
        status || filterDate ? '换个筛选条件看看，或去场馆预约页选一场运动。' : '去场馆预约页选择你的第一场运动吧。',
        '📋',
      )}</div>`;
      return;
    }

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
            <strong>${escapeHtml(fmtDate(row.date))}</strong>
            <span class="text-muted">${escapeHtml(row.startTime)} - ${escapeHtml(
              row.endTime,
            )}（${escapeHtml(
              fmtMinutes(
                (parseHM(row.endTime) ?? 0) - (parseHM(row.startTime) ?? 0),
              ),
            )}）</span>
          </div>`,
        },
        {
          label: '金额',
          align: 'right',
          render: (row) => `<strong>${fmtMoney(row.amount)}</strong>`,
        },
        {
          label: '凭证号',
          render: (row) => `<code class="inline-code">${escapeHtml(row.code || '—')}</code>`,
        },
        {
          label: '状态',
          render: (row) => statusBadge(row.status, 'booking'),
        },
        {
          label: '操作',
          align: 'right',
          render: (row) => `<div class="table-actions">
            <button type="button" class="btn btn--sm btn--ghost" data-booking-action="detail" data-id="${escapeHtml(
              row.id,
            )}">详情</button>
            ${
              row.status === BOOKING_STATUS.CONFIRMED
                ? `<button type="button" class="btn btn--sm btn--danger-ghost" data-booking-action="cancel" data-id="${escapeHtml(
                    row.id,
                  )}">取消</button>`
                : ''
            }
          </div>`,
        },
      ],
      rows: bookings,
      emptyText: '暂无预约',
    });
    listEl.innerHTML = `<section class="card card--flush">${table}</section>`;
  }

  async function loadBookings() {
    const seq = ++loadSeq;
    listEl.innerHTML = loadingHtml('正在加载预约记录…');
    try {
      const data = await api.bookings.mine({
        status: status || undefined,
        date: filterDate || undefined,
      });
      if (destroyed || seq !== loadSeq) return;
      bookings = asArray(data);
      renderList();
    } catch (err) {
      if (destroyed || seq !== loadSeq) return;
      listEl.innerHTML = `<div class="card">${inlineErrorState(
        errText(err, '预约记录加载失败'),
        '<button type="button" class="btn btn--primary" data-action="retry">重新加载</button>',
      )}</div>`;
    }
  }

  function openBookingDetail(booking) {
    const body = document.createElement('div');
    const duration =
      (parseHM(booking.endTime) ?? 0) - (parseHM(booking.startTime) ?? 0);
    body.innerHTML = `
      <div class="booking-detail__head">
        <div>
          <span class="eyebrow">预约凭证</span>
          <h3>${escapeHtml(booking.venueName || '—')} · ${escapeHtml(booking.courtName || '—')}</h3>
        </div>
        ${statusBadge(booking.status, 'booking')}
      </div>
      <dl class="detail-list">
        <div><dt>日期</dt><dd>${escapeHtml(fmtDate(booking.date))}</dd></div>
        <div><dt>时间</dt><dd>${escapeHtml(
          rangeText(booking.startTime, booking.endTime),
        )}</dd></div>
        <div><dt>时长</dt><dd>${escapeHtml(fmtMinutes(duration))}</dd></div>
        <div><dt>金额</dt><dd>${fmtMoney(booking.amount)}</dd></div>
        <div><dt>凭证号</dt><dd><code class="inline-code">${escapeHtml(
          booking.code || '—',
        )}</code></dd></div>
        <div><dt>创建时间</dt><dd>${escapeHtml(fmtDateTime(booking.createdAt))}</dd></div>
        ${
          booking.cancelledAt
            ? `<div><dt>取消时间</dt><dd>${escapeHtml(fmtDateTime(booking.cancelledAt))}</dd></div>`
            : ''
        }
        ${
          booking.cancelReason
            ? `<div><dt>取消原因</dt><dd>${escapeHtml(booking.cancelReason)}</dd></div>`
            : ''
        }
      </dl>
      <div class="qr-block">
        <span>入场二维码数据（base64url）</span>
        <code class="qr-code">${escapeHtml(booking.qrCode || '—')}</code>
      </div>
      <p class="notice notice--info">请按预约时间到场，向工作人员出示凭证号或二维码数据。</p>
    `;
    openModal({
      title: '预约详情',
      size: 'md',
      body,
      actions: [{ label: '关闭', variant: 'primary' }],
    });
  }

  function openCancelDialog(booking) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <p class="notice notice--warning">
        距离开场不足 ${escapeHtml(DEFAULT_BUSINESS.cancelHours)} 小时将无法自行取消，需联系场馆管理员。
        取消后费用将原路退回。
      </p>
      <div class="detail-list detail-list--compact">
        <div><dt>场馆</dt><dd>${escapeHtml(booking.venueName || '—')}</dd></div>
        <div><dt>时间</dt><dd>${escapeHtml(fmtDate(booking.date))} ${escapeHtml(
          booking.startTime,
        )} - ${escapeHtml(booking.endTime)}</dd></div>
      </div>
      <label class="field">
        <span class="field__label">取消原因（选填）</span>
        <textarea class="input" name="cancelReason" rows="3" maxlength="200"
          placeholder="例如：临时有事，无法到场"></textarea>
      </label>
      <div class="inline-error" data-cancel-error hidden></div>
    `;
    const errorBox = wrapper.querySelector('[data-cancel-error]');

    const modal = openModal({
      title: '确认取消预约',
      size: 'sm',
      body: wrapper,
      actions: [
        { label: '暂不取消', variant: 'ghost' },
        {
          key: 'confirm',
          label: '确认取消',
          variant: 'danger',
          onClick: async () => {
            const reason = wrapper.querySelector('textarea')?.value.trim() || '';
            try {
              await api.bookings.cancel(booking.id, reason);
              modal.close();
              toast('预约已取消，费用将原路退回', 'success');
              requestUnreadRefresh();
              loadBookings();
            } catch (err) {
              if (errorBox) {
                errorBox.hidden = false;
                errorBox.textContent = errText(err, '取消失败');
              }
              toast(errText(err, '取消失败'), 'error');
            }
          },
        },
      ],
    });
  }

  container.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action === 'refresh') loadBookings();
      if (action.dataset.action === 'retry') loadBookings();
      if (action.dataset.action === 'reset') {
        status = '';
        filterDate = '';
        statusSelect.value = '';
        dateInput.value = '';
        loadBookings();
      }
      return;
    }
    const rowAction = event.target.closest('[data-booking-action]');
    if (!rowAction) return;
    const booking = bookings.find((item) => String(item.id) === rowAction.dataset.id);
    if (!booking) return;
    if (rowAction.dataset.bookingAction === 'detail') openBookingDetail(booking);
    if (rowAction.dataset.bookingAction === 'cancel') openCancelDialog(booking);
  });

  statusSelect.addEventListener('change', () => {
    status = statusSelect.value;
    loadBookings();
  });
  dateInput.addEventListener('change', () => {
    filterDate = dateInput.value;
    loadBookings();
  });

  loadBookings();
  return () => {
    destroyed = true;
    loadSeq += 1;
  };
}

/* ========================================================================== */
/*                                  ③ 消息                                    */
/* ========================================================================== */

const CHANNEL_LABEL = { inapp: '站内信', sms: '短信', email: '邮件' };

export function renderNotificationsPage(container) {
  let destroyed = false;
  let loadSeq = 0;
  let notifications = [];

  container.innerHTML = `
    ${pageHeading(
      '消息中心',
      '预约成功、取消与系统提醒都会出现在这里。',
      `<button type="button" class="btn btn--ghost" data-action="refresh">↻ 刷新</button>
       <button type="button" class="btn btn--primary" data-action="read-all">全部已读</button>`,
    )}
    <section id="notification-list" aria-live="polite"></section>
  `;

  const listEl = container.querySelector('#notification-list');

  function renderNotifications() {
    if (destroyed) return;
    if (!notifications.length) {
      listEl.innerHTML = `<div class="card">${emptyState(
        '暂无消息',
        '预约和取消等动态会通过站内信通知你。',
        '🔔',
      )}</div>`;
      return;
    }
    const unread = notifications.filter((item) => !item.read).length;
    listEl.innerHTML = `
      <div class="section-heading section-heading--tight">
        <h2>全部消息 <span class="count-pill">${notifications.length}</span></h2>
        <p>${unread ? `${unread} 条未读` : '全部已读'}</p>
      </div>
      <ul class="notification-list">
        ${notifications
          .map(
            (item) => `<li class="notification${item.read ? '' : ' is-unread'}" data-notification-id="${escapeHtml(
              item.id,
            )}">
              <span class="notification__dot" aria-hidden="true"></span>
              <div class="notification__main">
                <div class="notification__head">
                  <span class="tag tag--soft">${escapeHtml(
                    CHANNEL_LABEL[item.channel] || item.channel || '系统通知',
                  )}</span>
                  <span class="notification__time">${escapeHtml(fmtDateTime(item.createdAt))}</span>
                </div>
                <h3>${escapeHtml(item.title || '通知')}</h3>
                <p>${escapeHtml(item.body || '')}</p>
              </div>
              <div class="notification__actions">
                ${
                  item.read
                    ? '<span class="text-muted text-sm">已读</span>'
                    : `<button type="button" class="btn btn--sm btn--ghost" data-action="read-one" data-id="${escapeHtml(
                        item.id,
                      )}">标为已读</button>`
                }
              </div>
            </li>`,
          )
          .join('')}
      </ul>`;
  }

  async function loadNotifications() {
    const seq = ++loadSeq;
    listEl.innerHTML = loadingHtml('正在加载消息…');
    try {
      const data = await api.notifications.list();
      if (destroyed || seq !== loadSeq) return;
      notifications = asArray(data);
      renderNotifications();
      store.setUnreadCount(notifications.filter((item) => !item.read).length);
    } catch (err) {
      if (destroyed || seq !== loadSeq) return;
      listEl.innerHTML = `<div class="card">${inlineErrorState(
        errText(err, '消息加载失败'),
        '<button type="button" class="btn btn--primary" data-action="retry">重新加载</button>',
      )}</div>`;
    }
  }

  async function markRead(ids, button) {
    try {
      await withBusy(button, () => api.notifications.markRead(ids), '处理中…');
      if (Array.isArray(ids) && ids.length) toast('已标为已读', 'success');
      else toast('全部消息已标为已读', 'success');
      await loadNotifications();
    } catch (err) {
      toast(errText(err, '操作失败'), 'error');
    }
  }

  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'refresh' || action === 'retry') loadNotifications();
    if (action === 'read-all') {
      if (!notifications.some((item) => !item.read)) {
        toast('没有未读消息', 'info');
        return;
      }
      markRead(undefined, button);
    }
    if (action === 'read-one') {
      markRead([Number(button.dataset.id)], button);
    }
  });

  loadNotifications();
  return () => {
    destroyed = true;
    loadSeq += 1;
  };
}

/* ========================================================================== */
/*                                ④ 个人中心                                   */
/* ========================================================================== */

function attachLiveValidation(form, getErrors) {
  const errorBox = form.querySelector('[data-form-errors]');
  const validate = () => {
    const errors = getErrors();
    renderFormErrors(errorBox, errors);
    return errors;
  };
  form.addEventListener('input', validate);
  form.addEventListener('change', validate);
  return validate;
}

export function renderProfilePage(container) {
  let destroyed = false;
  let loadSeq = 0;

  container.innerHTML = loadingHtml('正在加载个人信息…');

  async function loadProfile() {
    const seq = ++loadSeq;
    try {
      const data = await api.me.get();
      if (destroyed || seq !== loadSeq) return;
      const { stats, ...user } = data || {};
      store.setUser(user);
      store.setStats(stats || null);
      renderProfile(user, stats || {});
    } catch (err) {
      if (destroyed || seq !== loadSeq) return;
      container.innerHTML = `${pageHeading('个人中心', '管理你的资料、密码与实名认证。')}
        <div class="card">${inlineErrorState(
          errText(err, '个人信息加载失败'),
          '<button type="button" class="btn btn--primary" data-action="retry-profile">重新加载</button>',
        )}</div>`;
    }
  }

  function renderProfile(user, stats) {
    if (destroyed) return;
    container.innerHTML = `
      ${pageHeading('个人中心', '管理你的资料、密码与实名认证。')}
      <section class="profile-hero card">
        <div class="avatar avatar--lg">${escapeHtml(initials(user.name))}</div>
        <div class="profile-hero__main">
          <div class="profile-hero__name">
            <h2>${escapeHtml(user.name || '未命名用户')}</h2>
            ${statusBadge(user.role, 'role')}
            ${
              user.verified
                ? '<span class="badge badge--success"><span class="badge__dot"></span>已实名</span>'
                : '<span class="badge badge--muted"><span class="badge__dot"></span>未实名</span>'
            }
          </div>
          <p class="text-muted">${escapeHtml(user.phone || user.email || '未绑定联系方式')}</p>
          <p class="text-muted text-sm">注册于 ${escapeHtml(fmtDateTime(user.createdAt))}</p>
        </div>
        <div class="profile-stats">
          <div><strong>${escapeHtml(user.points ?? 0)}</strong><span>积分</span></div>
          <div><strong>${escapeHtml(stats.totalBookings ?? 0)}</strong><span>总预约</span></div>
          <div><strong>${escapeHtml(stats.upcoming ?? 0)}</strong><span>待进行</span></div>
        </div>
      </section>

      <div class="profile-grid">
        <section class="card">
          <div class="card-heading">
            <div><h2>基本资料</h2><p>修改昵称与联系方式。</p></div>
          </div>
          <form id="profile-form" novalidate>
            <label class="field">
              <span class="field__label">昵称</span>
              <input class="input" name="name" maxlength="40" value="${escapeHtml(user.name || '')}" autocomplete="nickname" />
            </label>
            <div class="form-row">
              <label class="field">
                <span class="field__label">手机号</span>
                <input class="input" name="phone" inputmode="tel" value="${escapeHtml(
                  user.phone || '',
                )}" placeholder="选填" autocomplete="tel" />
              </label>
              <label class="field">
                <span class="field__label">邮箱</span>
                <input class="input" name="email" type="email" value="${escapeHtml(
                  user.email || '',
                )}" placeholder="选填" autocomplete="email" />
              </label>
            </div>
            <div class="form-errors" data-form-errors hidden></div>
            <div class="form-actions">
              <button type="submit" class="btn btn--primary">保存资料</button>
            </div>
          </form>
        </section>

        <section class="card">
          <div class="card-heading">
            <div><h2>修改密码</h2><p>建议使用至少 6 位的复杂密码。</p></div>
          </div>
          <form id="password-form" novalidate>
            <label class="field">
              <span class="field__label">当前密码</span>
              <input class="input" name="oldPassword" type="password" autocomplete="current-password" />
            </label>
            <div class="form-row">
              <label class="field">
                <span class="field__label">新密码</span>
                <input class="input" name="newPassword" type="password" autocomplete="new-password" />
              </label>
              <label class="field">
                <span class="field__label">确认新密码</span>
                <input class="input" name="confirmPassword" type="password" autocomplete="new-password" />
              </label>
            </div>
            <div class="form-errors" data-form-errors hidden></div>
            <div class="form-actions">
              <button type="submit" class="btn btn--primary">修改密码</button>
            </div>
          </form>
        </section>

        <section class="card">
          <div class="card-heading">
            <div><h2>实名认证</h2><p>实名信息仅用于预约入场核验。</p></div>
            ${user.verified ? '<span class="badge badge--success"><span class="badge__dot"></span>已实名</span>' : ''}
          </div>
          ${
            user.verified
              ? `<div class="verified-info">
                  <p>✓ 已完成实名认证</p>
                  <p class="text-muted">真实姓名：${escapeHtml(user.realName || '—')}</p>
                </div>`
              : '<p class="notice notice--warning">尚未实名，请填写真实姓名与证件号完成认证。</p>'
          }
          <form id="verify-form" novalidate>
            <div class="form-row">
              <label class="field">
                <span class="field__label">真实姓名</span>
                <input class="input" name="realName" maxlength="40" value="${escapeHtml(
                  user.realName || '',
                )}" autocomplete="name" />
              </label>
              <label class="field">
                <span class="field__label">身份证件号</span>
                <input class="input" name="idCard" inputmode="numeric" maxlength="30" placeholder="至少 6 位数字" />
              </label>
            </div>
            <div class="form-errors" data-form-errors hidden></div>
            <div class="form-actions">
              <button type="submit" class="btn btn--primary">${user.verified ? '更新实名信息' : '提交认证'}</button>
            </div>
          </form>
        </section>
      </div>
    `;

    const profileForm = container.querySelector('#profile-form');
    const passwordForm = container.querySelector('#password-form');
    const verifyForm = container.querySelector('#verify-form');

    const profileValues = () => ({
      name: profileForm.elements.name.value.trim(),
      phone: profileForm.elements.phone.value.trim(),
      email: profileForm.elements.email.value.trim(),
    });
    const passwordValues = () => ({
      oldPassword: passwordForm.elements.oldPassword.value,
      newPassword: passwordForm.elements.newPassword.value,
      confirmPassword: passwordForm.elements.confirmPassword.value,
    });
    const verifyValues = () => ({
      realName: verifyForm.elements.realName.value.trim(),
      idCard: verifyForm.elements.idCard.value.trim(),
    });

    const validateBasic = attachLiveValidation(profileForm, () => validateProfile(profileValues()));
    const validatePassword = attachLiveValidation(passwordForm, () => {
      const values = passwordValues();
      const errors = validatePasswordChange(values);
      if (!values.confirmPassword) errors.push('请再次输入新密码');
      else if (values.confirmPassword !== values.newPassword) errors.push('两次输入的新密码不一致');
      return errors;
    });
    const validateVerification = attachLiveValidation(verifyForm, () => validateVerify(verifyValues()));

    profileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const errors = validateBasic();
      if (errors.length) {
        toast(errors[0], 'warning');
        return;
      }
      const submitButton = profileForm.querySelector('[type="submit"]');
      withBusy(
        submitButton,
        async () => {
          try {
            const payload = profileValues();
            const updated = await api.me.update(payload);
            store.setUser(updated);
            toast('资料已更新', 'success');
            await loadProfile();
          } catch (err) {
            renderFormErrors(profileForm.querySelector('[data-form-errors]'), [
              errText(err, '资料保存失败'),
            ]);
            toast(errText(err, '资料保存失败'), 'error');
          }
        },
        '保存中…',
      );
    });

    passwordForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const errors = validatePassword();
      if (errors.length) {
        toast(errors[0], 'warning');
        return;
      }
      const submitButton = passwordForm.querySelector('[type="submit"]');
      withBusy(
        submitButton,
        async () => {
          try {
            const values = passwordValues();
            await api.me.changePassword(values.oldPassword, values.newPassword);
            passwordForm.reset();
            renderFormErrors(passwordForm.querySelector('[data-form-errors]'), []);
            toast('密码已修改', 'success');
          } catch (err) {
            renderFormErrors(passwordForm.querySelector('[data-form-errors]'), [
              errText(err, '密码修改失败'),
            ]);
            toast(errText(err, '密码修改失败'), 'error');
          }
        },
        '提交中…',
      );
    });

    verifyForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const errors = validateVerification();
      if (errors.length) {
        toast(errors[0], 'warning');
        return;
      }
      const submitButton = verifyForm.querySelector('[type="submit"]');
      withBusy(
        submitButton,
        async () => {
          try {
            const values = verifyValues();
            const updated = await api.me.verify(values.realName, values.idCard);
            store.setUser(updated);
            toast('实名认证已提交', 'success');
            await loadProfile();
          } catch (err) {
            renderFormErrors(verifyForm.querySelector('[data-form-errors]'), [
              errText(err, '实名认证失败'),
            ]);
            toast(errText(err, '实名认证失败'), 'error');
          }
        },
        '提交中…',
      );
    });
  }

  container.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="retry-profile"]')) loadProfile();
  });

  loadProfile();
  return () => {
    destroyed = true;
    loadSeq += 1;
  };
}
