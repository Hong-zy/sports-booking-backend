import crypto from 'node:crypto';
import { config } from './config.js';
import { forbidden, unauthorized } from './http.js';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signToken(payload, ttlHours = 24 * 30) {
  const body = { ...payload, exp: Date.now() + ttlHours * 3_600_000 };
  const data = b64(body);
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function readToken(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) return null;
  const expect = crypto.createHmac('sha256', config.tokenSecret).update(data).digest('base64url');
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearer(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw forbidden('需要管理员权限');
  return user;
}
