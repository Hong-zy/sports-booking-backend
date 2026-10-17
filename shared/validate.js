/**
 * frontend / backend 共用的表单校验。
 *
 * 约定：所有校验函数都是纯函数，返回「错误信息数组」（空数组 = 通过）。
 * - 后端路由把错误数组拼成 400 响应；
 * - 前端用同一套规则做即时校验，两边判定永远一致。
 */

import {
  COURT_STATUS,
  LIMITS,
  OVERRIDE_STATUS,
  ROLE,
  SLOT_MINUTES_OPTIONS,
  VENUE_STATUS,
} from './constants.js';
import { isDateString, minutesToText, parseHM } from './time.js';

const str = (v) => String(v ?? '').trim();
const isBlank = (v) => str(v).length === 0;

/** 取第一条错误，方便直接展示 */
export const firstError = (errors) => (Array.isArray(errors) && errors.length ? errors[0] : null);

/* ------------------------------- 账号相关 ------------------------------- */

export function validateRegister({ name, phone, email, password } = {}) {
  const errors = [];
  if (isBlank(phone) && isBlank(email)) errors.push('请填写手机号或邮箱');
  if (!isBlank(phone) && !/^1[3-9]\d{9}$/.test(str(phone))) errors.push('手机号格式不正确');
  if (!isBlank(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(email))) errors.push('邮箱格式不正确');
  if (str(password).length < LIMITS.passwordMin) errors.push(`密码至少 ${LIMITS.passwordMin} 位`);
  if (str(password).length > LIMITS.passwordMax) errors.push(`密码不能超过 ${LIMITS.passwordMax} 位`);
  if (str(name).length > LIMITS.nameMax) errors.push(`昵称不能超过 ${LIMITS.nameMax} 个字符`);
  return errors;
}

export function validateProfile({ name, phone, email } = {}) {
  const errors = [];
  if (!isBlank(phone) && !/^1[3-9]\d{9}$/.test(str(phone))) errors.push('手机号格式不正确');
  if (!isBlank(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(email))) errors.push('邮箱格式不正确');
  if (str(name).length > LIMITS.nameMax) errors.push(`昵称不能超过 ${LIMITS.nameMax} 个字符`);
  return errors;
}

export function validatePasswordChange({ oldPassword, newPassword } = {}) {
  const errors = [];
  if (isBlank(oldPassword)) errors.push('请填写原密码');
  if (str(newPassword).length < LIMITS.passwordMin) errors.push(`新密码至少 ${LIMITS.passwordMin} 位`);
  if (str(newPassword).length > LIMITS.passwordMax) errors.push(`新密码不能超过 ${LIMITS.passwordMax} 位`);
  if (str(oldPassword) && oldPassword === newPassword) errors.push('新密码不能与原密码相同');
  return errors;
}

export function validateVerify({ realName, idCard } = {}) {
  const errors = [];
  if (isBlank(realName)) errors.push('请填写真实姓名');
  if (str(realName).length > LIMITS.nameMax) errors.push('真实姓名过长');
  if (!/^\d{6,}$/.test(str(idCard))) errors.push('证件号至少 6 位数字');
  return errors;
}

/* ------------------------------- 场馆相关 ------------------------------- */

/**
 * @param {object} input
 * @param {{partial?: boolean}} [options] partial=true 时只校验传入的字段（PATCH 用）
 */
export function validateVenueInput(input = {}, { partial = false } = {}) {
  const errors = [];
  const has = (k) => input[k] !== undefined && input[k] !== null;
  const need = (k) => !partial || has(k);

  if (need('name') && (isBlank(input.name) || str(input.name).length > LIMITS.nameMax)) {
    errors.push(`场馆名称必填且不超过 ${LIMITS.nameMax} 个字符`);
  }
  if (need('sport') && (isBlank(input.sport) || str(input.sport).length > LIMITS.sportMax)) {
    errors.push('请选择或填写运动类型');
  }
  if (has('address') && str(input.address).length > LIMITS.addressMax) errors.push('地址过长');

  // 开放时间：全量创建时两个都必填；partial（PATCH）时只校验传了的字段，
  // 与已存在值的交叉校验由后端在合并后完成。
  {
    const hasOpen = has('openTime');
    const hasClose = has('closeTime');
    const checkOpen = partial ? hasOpen : true;
    const checkClose = partial ? hasClose : true;
    if (checkOpen || checkClose) {
      const open = parseHM(input.openTime);
      const close = parseHM(input.closeTime);
      if (checkOpen && open === null) errors.push('开始时间需要是 HH:MM 格式');
      else if (checkClose && close === null) errors.push('结束时间需要是 HH:MM 格式');
      else if (hasOpen && hasClose && open >= close) errors.push('结束时间必须晚于开始时间');
      else if (!partial && open >= close) errors.push('结束时间必须晚于开始时间');
    }
  }

  if (need('slotMinutes')) {
    const slot = Number(input.slotMinutes);
    if (!Number.isFinite(slot) || slot < LIMITS.slotMinutesMin || slot > LIMITS.slotMinutesMax) {
      errors.push(`时段长度需在 ${LIMITS.slotMinutesMin}-${LIMITS.slotMinutesMax} 分钟之间`);
    }
  }

  if (has('status') && ![VENUE_STATUS.OPEN, VENUE_STATUS.PAUSED].includes(input.status)) {
    errors.push('场馆状态只能是 open 或 paused');
  }
  return errors;
}

export function validateCourtInput(input = {}, { partial = false } = {}) {
  const errors = [];
  const has = (k) => input[k] !== undefined && input[k] !== null;
  const need = (k) => !partial || has(k);

  if (need('name') && (isBlank(input.name) || str(input.name).length > LIMITS.nameMax)) {
    errors.push('场地名称必填且不能过长');
  }
  if (has('pricePerHour')) {
    const price = Number(input.pricePerHour);
    if (!Number.isFinite(price) || price < 0 || price > LIMITS.priceMax) errors.push('价格不合法');
  }
  if (has('status') && ![COURT_STATUS.OPEN, COURT_STATUS.CLOSED].includes(input.status)) {
    errors.push('场地状态只能是 open 或 closed');
  }
  return errors;
}

/* ------------------------- 维护 / 临时关闭标记 ------------------------- */

export function validateOverrideInput({ courtId, date, startTime, endTime, status } = {}) {
  const errors = [];
  if (!Number(courtId)) errors.push('请选择场地');
  if (!isDateString(date)) errors.push('日期需要是 YYYY-MM-DD');
  const start = parseHM(startTime);
  const end = parseHM(endTime);
  if (start === null || end === null) errors.push('时间段需要是 HH:MM 格式');
  else if (start >= end) errors.push('结束时间必须晚于开始时间');
  if (![OVERRIDE_STATUS.MAINTENANCE, OVERRIDE_STATUS.CLOSED].includes(status)) {
    errors.push('标记类型只能是维护中或临时关闭');
  }
  return errors;
}

/* ------------------------------- 预约相关 ------------------------------- */

export function validateBookingRange({ startTime, endTime } = {}) {
  const errors = [];
  const start = parseHM(startTime);
  const end = parseHM(endTime);
  if (start === null || end === null) errors.push('时间段需要是 HH:MM 格式');
  else if (start >= end) errors.push('结束时间必须晚于开始时间');
  else if ((end - start) % 30 !== 0) errors.push(`时长需为 30 分钟的整数倍（当前 ${minutesToText(end - start)}）`);
  return errors;
}

export function validateLockPayload({ courtId, date, startTime, endTime } = {}) {
  const errors = [];
  if (!Number(courtId)) errors.push('请选择场地');
  if (!isDateString(date)) errors.push('日期需要是 YYYY-MM-DD');
  errors.push(...validateBookingRange({ startTime, endTime }));
  return errors;
}

/* ------------------------------- 后台编辑 ------------------------------- */

export function validateAdminUserPatch({ role, points, name } = {}) {
  const errors = [];
  if (role !== undefined && ![ROLE.USER, ROLE.ADMIN].includes(role)) errors.push('角色只能是 user 或 admin');
  if (points !== undefined) {
    const n = Number(points);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) errors.push('积分不合法');
  }
  if (name !== undefined && str(name).length > LIMITS.nameMax) errors.push('昵称过长');
  return errors;
}

export { SLOT_MINUTES_OPTIONS };
