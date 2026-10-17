import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(root, 'data', 'app.db'),
  tokenSecret: process.env.TOKEN_SECRET || 'dev-secret-change-me',
  lockMinutes: Number(process.env.LOCK_MINUTES || 10),
  cancelHours: Number(process.env.CANCEL_HOURS || 2),
  bookingDaysAhead: Number(process.env.BOOKING_DAYS_AHEAD || 30),
};
