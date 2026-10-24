import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL DEFAULT '',
    phone         TEXT UNIQUE,
    email         TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    real_name     TEXT,
    id_card       TEXT,
    role          TEXT NOT NULL DEFAULT 'user',
    points        INTEGER NOT NULL DEFAULT 100,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS venues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    address      TEXT NOT NULL DEFAULT '',
    sport        TEXT NOT NULL,
    open_minute  INTEGER NOT NULL DEFAULT 480,
    close_minute INTEGER NOT NULL DEFAULT 1320,
    slot_minutes INTEGER NOT NULL DEFAULT 60,
    status       TEXT NOT NULL DEFAULT 'open',
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    venue_id       INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    price_per_hour INTEGER NOT NULL DEFAULT 50,
    status         TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS locks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id   INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    start_min  INTEGER NOT NULL,
    end_min    INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    venue_id      INTEGER NOT NULL REFERENCES venues(id),
    court_id      INTEGER NOT NULL REFERENCES courts(id),
    user_id       INTEGER NOT NULL REFERENCES users(id),
    date          TEXT NOT NULL,
    start_min     INTEGER NOT NULL,
    end_min       INTEGER NOT NULL,
    amount        INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'confirmed',
    qr            TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    cancelled_at  TEXT,
    cancel_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS slot_overrides (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    court_id   INTEGER NOT NULL REFERENCES courts(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    start_min  INTEGER NOT NULL,
    end_min    INTEGER NOT NULL,
    status     TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL DEFAULT 'inapp',
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- AI 助手的提问日志（记录走了大模型还是本地规则，便于后台查看与答辩演示）
  CREATE TABLE IF NOT EXISTS ai_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    question    TEXT NOT NULL,
    mode        TEXT NOT NULL DEFAULT 'rule',
    intent_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_locks_court_date   ON locks(court_id, date, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_court     ON bookings(court_id, date, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_user      ON bookings(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_overrides_court    ON slot_overrides(court_id, date);
  CREATE INDEX IF NOT EXISTS idx_ai_logs_created    ON ai_logs(created_at);
`);

const prepareCache = new Map();

/** 预编译语句（带缓存） */
export function prep(sql) {
  let stmt = prepareCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    prepareCache.set(sql, stmt);
  }
  return stmt;
}

export const num = (v) => Number(v ?? 0);
