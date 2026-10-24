/**
 * frontend / backend 共用的常量定义。
 * 纯 ESM，不依赖 Node 或浏览器专有 API，两边都能直接 import。
 */

/* ------------------------------ 时段状态 ------------------------------ */

export const SLOT_STATUS = {
  AVAILABLE: 'available',
  LOCKED: 'locked',
  BOOKED: 'booked',
  MAINTENANCE: 'maintenance',
  CLOSED: 'closed',
};

export const SLOT_STATUS_LIST = Object.values(SLOT_STATUS);

export const SLOT_STATUS_LABEL = {
  available: '可约',
  locked: '锁定中',
  booked: '已预约',
  maintenance: '维护中',
  closed: '已关闭',
};

/* ------------------------------ 预约状态 ------------------------------ */

export const BOOKING_STATUS = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};

export const BOOKING_STATUS_LABEL = {
  confirmed: '已预约',
  cancelled: '已取消',
  completed: '已完成',
};

/* ------------------------ 场馆 / 场地 / 标记状态 ------------------------ */

export const VENUE_STATUS = { OPEN: 'open', PAUSED: 'paused' };

export const VENUE_STATUS_LABEL = {
  open: '开放中',
  paused: '暂停营业',
};

export const COURT_STATUS = { OPEN: 'open', CLOSED: 'closed' };

export const COURT_STATUS_LABEL = {
  open: '可用',
  closed: '停用',
};

export const OVERRIDE_STATUS = {
  MAINTENANCE: 'maintenance',
  CLOSED: 'closed',
};

export const OVERRIDE_STATUS_LABEL = {
  maintenance: '维护中',
  closed: '临时关闭',
};

/* ------------------------------- 业务默认值 ------------------------------- */

export const DEFAULT_BUSINESS = {
  lockMinutes: 10,
  cancelHours: 2,
  bookingDaysAhead: 30,
};

export const SPORT_OPTIONS = ['羽毛球', '篮球', '游泳', '网球', '乒乓球'];

export const SLOT_MINUTES_OPTIONS = [30, 45, 60, 90, 120];

export const ROLE = { USER: 'user', ADMIN: 'admin' };

export const ROLE_LABEL = { user: '普通用户', admin: '管理员' };

/* --------------------------------- 限制 --------------------------------- */

export const LIMITS = {
  passwordMin: 6,
  passwordMax: 64,
  nameMax: 40,
  addressMax: 120,
  sportMax: 20,
  noteMax: 200,
  priceMax: 100000,
  slotMinutesMin: 15,
  slotMinutesMax: 240,
  idCardMin: 6,
  pageSizeDefault: 50,
  pageSizeMax: 200,
};

/* ------------------------------ 数据库概览 ------------------------------ */

/** 允许在后台「数据库」页浏览的表（白名单，防注入） */
export const DB_TABLES = [
  'users',
  'venues',
  'courts',
  'locks',
  'bookings',
  'slot_overrides',
  'notifications',
  'ai_logs',
];

export const DB_TABLE_LABEL = {
  users: '用户',
  venues: '场馆',
  courts: '场地',
  locks: '时段锁定',
  bookings: '预约',
  slot_overrides: '维护/关闭标记',
  notifications: '站内通知',
  ai_logs: 'AI 提问日志',
};

/* ---------------------------------- API ---------------------------------- */

export const API_PREFIX = '/api';
export const SSE_PATH = '/api/stream';

/** 前端 tab 路由 */
export const ROUTES = [
  { hash: '#/', label: '场馆预约', icon: '🏟' },
  { hash: '#/mine', label: '我的预约', icon: '📋', auth: true },
  { hash: '#/notifications', label: '消息', icon: '🔔', auth: true },
  { hash: '#/profile', label: '个人中心', icon: '👤', auth: true },
  { hash: '#/admin', label: '管理后台', icon: '⚙', auth: true, admin: true },
];

export const APP_NAME = '运动场馆易约';
export const APP_VERSION = '2.0.0';
