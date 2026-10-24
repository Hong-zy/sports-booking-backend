import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUSINESS } from '../../shared/constants.js';

/**
 * 目录约定（本文件位于 backend/src/config.js）：
 *   <repo>/backend/src/config.js
 *   <repo>/frontend/   static SPA
 *   <repo>/shared/     frontend & backend 公用模块
 *   <repo>/data/       SQLite 数据库文件
 *   <repo>/.env        本地环境变量（已 gitignore，不上传仓库）
 */
const here = path.dirname(fileURLToPath(import.meta.url)); // backend/src
const root = path.dirname(path.dirname(here)); // 仓库根目录

/**
 * 读取仓库根目录的 .env（极简实现，零依赖）。
 * 规则：已存在的环境变量优先（便于平台注入覆盖），支持 # 注释与引号。
 */
function loadDotEnv(file) {
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[env] 读取 .env 失败：', err.message);
  }
}

loadDotEnv(path.join(root, '.env'));

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

  /* ------------------------------ AI 能力 ------------------------------ */
  // 配置了 key 就走真实大模型；不配置时自动降级为本地规则引擎（离线可用）
  aiApiKey: process.env.AI_API_KEY || '',
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1',
  aiModel: process.env.AI_MODEL || 'deepseek-chat',
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 15000),
};
