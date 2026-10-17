/**
 * 后端专用工具。
 * 纯函数（时间/日期/区间判断）全部来自 shared/time.js，前后端共用同一份实现；
 * 这里只保留 Node 侧需要的东西，并提供向后兼容别名。
 */
import { isDateString } from '../../shared/time.js';

export * from '../../shared/time.js';

/** 兼容旧调用：isDate === isDateString */
export const isDate = isDateString;

export const nowISO = () => new Date().toISOString();

export const plusMinutes = (min) => new Date(Date.now() + min * 60_000).toISOString();

export function randomCode(prefix = 'SY') {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-5)}${rand}`;
}
