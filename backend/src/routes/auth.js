import { hashPassword, requireUser, signToken, verifyPassword } from '../auth.js';
import { prep, num } from '../db.js';
import { HttpError, bad, unauthorized } from '../http.js';
import { listNotifications, markNotificationsRead, notify, userJson } from '../core.js';
import { nowISO, toDateStr } from '../util.js';
import {
  firstError,
  validatePasswordChange,
  validateProfile,
  validateRegister,
  validateVerify,
} from '../../../shared/validate.js';

const findAccount = (account) => {
  const value = String(account || '').trim();
  if (!value) return null;
  return prep('SELECT * FROM users WHERE email = ? OR phone = ?').get(value, value);
};

const failIfInvalid = (errors) => {
  const msg = firstError(errors);
  if (msg) throw bad(msg);
};

export function registerRoutes(router) {
  /* ------------------------------- 注册 / 登录 ------------------------------- */

  router.post('/api/auth/register', (ctx) => {
    const { password = '', name = '', phone = '', email = '', realName = '', idCard = '' } = ctx.body;
    failIfInvalid(validateRegister({ name, phone, email, password }));
    const account = String(phone || email || '').trim();
    if (findAccount(account)) throw new HttpError(409, '该手机号或邮箱已注册');

    const res = prep(`INSERT INTO users (name, phone, email, password_hash, real_name, id_card, role, points, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, 'user', 100, ?)`)
      .run(name || account, phone || null, email || null, hashPassword(password), realName || null, idCard || null, nowISO());
    const user = prep('SELECT * FROM users WHERE id = ?').get(Number(res.lastInsertRowid));
    notify(user.id, { title: '欢迎使用运动场馆易约', body: '完成实名认证后即可预约场地。' });
    return { token: signToken({ uid: user.id, role: user.role }), user: userJson(user) };
  });

  router.post('/api/auth/login', (ctx) => {
    const user = findAccount(ctx.body.account);
    if (!user || !verifyPassword(ctx.body.password, user.password_hash)) throw unauthorized('账号或密码错误');
    return { token: signToken({ uid: user.id, role: user.role }), user: userJson(user) };
  });

  /* --------------------------------- 个人中心 -------------------------------- */

  router.get('/api/me', (ctx) => {
    const user = requireUser(ctx);
    const total = prep('SELECT COUNT(*) AS c FROM bookings WHERE user_id = ?').get(user.id);
    const upcoming = prep(`SELECT COUNT(*) AS c FROM bookings WHERE user_id = ? AND status = 'confirmed' AND date >= ?`)
      .get(user.id, toDateStr(new Date()));
    return { ...userJson(user), stats: { totalBookings: num(total.c), upcoming: num(upcoming.c) } };
  });

  /** 修改昵称 / 手机号 / 邮箱（数据库可编辑：用户自己的资料） */
  router.patch('/api/me', (ctx) => {
    const user = requireUser(ctx);
    const { name, phone, email } = ctx.body;
    failIfInvalid(validateProfile({ name, phone, email }));

    const next = {
      name: name ?? user.name,
      phone: phone === undefined ? user.phone : (String(phone).trim() || null),
      email: email === undefined ? user.email : (String(email).trim() || null),
    };
    if (next.phone && prep('SELECT id FROM users WHERE phone = ? AND id <> ?').get(next.phone, user.id)) {
      throw new HttpError(409, '该手机号已被其他账号使用');
    }
    if (next.email && prep('SELECT id FROM users WHERE email = ? AND id <> ?').get(next.email, user.id)) {
      throw new HttpError(409, '该邮箱已被其他账号使用');
    }
    prep('UPDATE users SET name = ?, phone = ?, email = ? WHERE id = ?').run(next.name, next.phone, next.email, user.id);
    return userJson(prep('SELECT * FROM users WHERE id = ?').get(user.id));
  });

  /** 修改密码 */
  router.post('/api/me/password', (ctx) => {
    const user = requireUser(ctx);
    const { oldPassword = '', newPassword = '' } = ctx.body;
    failIfInvalid(validatePasswordChange({ oldPassword, newPassword }));
    if (!verifyPassword(oldPassword, user.password_hash)) throw bad('原密码不正确');
    prep('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    return { ok: true };
  });

  /** 实名认证 */
  router.post('/api/me/verify', (ctx) => {
    const user = requireUser(ctx);
    const { realName = '', idCard = '' } = ctx.body;
    failIfInvalid(validateVerify({ realName, idCard }));
    prep('UPDATE users SET real_name = ?, id_card = ? WHERE id = ?').run(String(realName).trim(), String(idCard).trim(), user.id);
    return userJson(prep('SELECT * FROM users WHERE id = ?').get(user.id));
  });

  /* ---------------------------------- 站内信 --------------------------------- */

  router.get('/api/notifications', (ctx) => {
    const user = requireUser(ctx);
    return listNotifications(user, ctx.query.get('unread') === '1');
  });

  router.post('/api/notifications/read', (ctx) => {
    const user = requireUser(ctx);
    return markNotificationsRead(user, ctx.body.ids);
  });
}
