import { hashPassword, requireUser, signToken, verifyPassword } from '../auth.js';
import { prep, num } from '../db.js';
import { HttpError, bad, unauthorized } from '../http.js';
import { listNotifications, markNotificationsRead, notify, userJson } from '../core.js';
import { nowISO, toDateStr } from '../util.js';

const findAccount = (account) => {
  const value = String(account || '').trim();
  if (!value) return null;
  return prep('SELECT * FROM users WHERE email = ? OR phone = ?').get(value, value);
};

export function registerRoutes(router) {
  router.post('/api/auth/register', (ctx) => {
    const { password = '', name = '', phone = '', email = '', realName = '', idCard = '' } = ctx.body;
    const account = String(phone || email || '').trim();
    if (!account) throw bad('请填写手机号或邮箱');
    if (String(password).length < 6) throw bad('密码至少 6 位');
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

  router.get('/api/me', (ctx) => {
    const user = requireUser(ctx);
    const total = prep('SELECT COUNT(*) AS c FROM bookings WHERE user_id = ?').get(user.id);
    const upcoming = prep(`SELECT COUNT(*) AS c FROM bookings WHERE user_id = ? AND status = 'confirmed' AND date >= ?`)
      .get(user.id, toDateStr(new Date()));
    return { ...userJson(user), stats: { totalBookings: num(total.c), upcoming: num(upcoming.c) } };
  });

  // 实名认证（手机号/邮箱注册后的补充资料）
  router.post('/api/me/verify', (ctx) => {
    const user = requireUser(ctx);
    const { realName = '', idCard = '' } = ctx.body;
    if (!realName || !/^\d{6,}$/.test(String(idCard))) throw bad('请填写真实姓名与有效证件号');
    prep('UPDATE users SET real_name = ?, id_card = ? WHERE id = ?').run(realName, idCard, user.id);
    return userJson(prep('SELECT * FROM users WHERE id = ?').get(user.id));
  });

  router.get('/api/notifications', (ctx) => {
    const user = requireUser(ctx);
    return listNotifications(user, ctx.query.get('unread') === '1');
  });

  router.post('/api/notifications/read', (ctx) => {
    const user = requireUser(ctx);
    return markNotificationsRead(user, ctx.body.ids);
  });
}
