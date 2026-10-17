import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUSINESS } from '../../shared/constants.js';

/**
 * 目录约定（本文件位于 backend/src/config.js）：
 *   <repo>/backend/src/config.js
 *   <repo>/frontend/   static SPA
 *   <repo>/shared/     frontend & backend 公用模块
 *   <repo>/data/       SQLite 数据库文件
 */
const here = path.dirname(fileURLToPath(import.meta.url)); // backend/src
const root = path.dirname(path.dirname(here)); // 仓库根目录

export const config = {
  root,
  frontendDir: path.join(root, 'frontend'),
  sharedDir: path.join(root, 'shared'),
  dataDir: path.join(root, 'data'),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'app.db'),
  tokenSecret: process.env.TOKEN_SECRET || 'dev-secret-change-me',
  lockMinutes: Number(process.env.LOCK_MINUTES || DEFAULT_BUSINESS.lockMinutes),
  cancelHours: Number(process.env.CANCEL_HOURS || DEFAULT_BUSINESS.cancelHours),
  bookingDaysAhead: Number(process.env.BOOKING_DAYS_AHEAD || DEFAULT_BUSINESS.bookingDaysAhead),
};
