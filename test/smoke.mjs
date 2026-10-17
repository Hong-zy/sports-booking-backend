/**
 * 端到端冒烟测试：注册/登录 -> 查场馆 -> 查可用时段 -> 锁定 -> 冲突提示 -> 确认预约
 *                -> 我的预约 -> 取消规则 -> 管理后台（维护标记/报表/强制取消/通知）
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.HTTP_LOG = '0';

const { createApp } = await import('../src/app.js');
const { toDateStr } = await import('../src/util.js');

const app = createApp({ withSweeper: false });
const address = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${address.port}`;

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, `FAIL: ${name}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const tomorrow = () => toDateStr(new Date(Date.now() + 86_400_000));

try {
  console.log('\n[1] 账号与权限');
  const login = await api('POST', '/api/auth/login', { body: { account: '13800000000', password: 'demo123456' } });
  ok('演示用户登录', login.status === 200 && login.data.token);
  const demo = login.data.token;

  const adminLogin = await api('POST', '/api/auth/login', { body: { account: 'admin@yueqiu.local', password: 'admin123456' } });
  ok('管理员登录', adminLogin.status === 200);
  const admin = adminLogin.data.token;

  const badLogin = await api('POST', '/api/auth/login', { body: { account: '13800000000', password: 'wrong' } });
  ok('错误密码被拒绝', badLogin.status === 401);

  const reg = await api('POST', '/api/auth/register', { body: { name: '新用户', phone: '13700000001', password: 'abc123456' } });
  ok('手机号注册成功', reg.status === 200 && reg.data.user.points === 100);
  const dup = await api('POST', '/api/auth/register', { body: { name: '重复', phone: '13700000001', password: 'abc123456' } });
  ok('重复注册被拒绝', dup.status === 409);

  const me = await api('GET', '/api/me', { token: reg.data.token });
  ok('个人中心返回积分', me.data.points === 100 && me.data.stats);
  const verify = await api('POST', '/api/me/verify', { token: reg.data.token, body: { realName: '测试用户', idCard: '110101200001011234' } });
  ok('实名认证成功', verify.data.verified === true);
  ok('未登录访问被拒绝', (await api('GET', '/api/bookings/mine')).status === 401);
  ok('普通用户访问后台被拒绝', (await api('GET', '/api/admin/report', { token: demo })).status === 403);

  console.log('\n[2] 场馆与实时可用性');
  const venues = await api('GET', '/api/venues');
  ok('场馆列表', venues.status === 200 && venues.data.length >= 5);
  ok('场馆带可用时段统计', venues.data[0].availableSlots > 0 && typeof venues.data[0].utilization === 'number');
  const sports = await api('GET', '/api/sports');
  ok('运动类型筛选数据', sports.data.includes('羽毛球') && sports.data.includes('游泳'));

  const day = tomorrow();
  const availability = await api('GET', `/api/venues/${venues.data[0].id}/availability?date=${day}`);
  ok('场馆时段轴', availability.status === 200 && availability.data.courts[0].slots.length > 0);
  const court = availability.data.courts[0].courtId;
  const slot = availability.data.courts[0].slots.find((s) => s.status === 'available');
  ok('存在可预约时段', Boolean(slot));

  const search = await api('GET', `/api/availability?sport=羽毛球&date=${day}&startTime=${slot.startTime}&endTime=${slot.endTime}`);
  ok('按运动类型+时间段筛选', search.status === 200 && search.data.some((r) => r.courtId === court));

  console.log('\n[3] 先到先得锁定与预约');
  const lock = await api('POST', '/api/bookings/lock', { token: demo, body: { courtId: court, date: day, startTime: slot.startTime, endTime: slot.endTime } });
  ok('锁定成功 10 分钟', lock.status === 200 && lock.data.remainSeconds === 600 && lock.data.lockId);

  const conflict = await api('POST', '/api/bookings/lock', { token: reg.data.token, body: { courtId: court, date: day, startTime: slot.startTime, endTime: slot.endTime } });
  ok('并发抢占返回 409 冲突', conflict.status === 409);
  ok('冲突时推荐相邻可用时段', Array.isArray(conflict.data.error.suggestions));

  const locked = await api('GET', `/api/venues/${venues.data[0].id}/availability?date=${day}`);
  const lockedSlot = locked.data.courts.find((c) => c.courtId === court).slots.find((s) => s.startTime === slot.startTime);
  ok('时段状态变为已锁定', lockedSlot.status === 'locked');

  const booking = await api('POST', '/api/bookings', { token: demo, body: { lockId: lock.data.lockId } });
  ok('确认预约成功并生成凭证', booking.status === 200 && booking.data.code && booking.data.qrCode);
  const again = await api('POST', '/api/bookings', { token: demo, body: { lockId: lock.data.lockId } });
  ok('锁定不可重复使用', again.status === 409);

  const mine = await api('GET', '/api/bookings/mine', { token: demo });
  ok('我的预约列表', mine.data.some((b) => b.id === booking.data.id));
  const notices = await api('GET', '/api/notifications', { token: demo });
  ok('预约成功站内通知', notices.data.some((n) => n.title === '预约成功'));

  console.log('\n[4] 取消规则');
  const cancelled = await api('POST', `/api/bookings/${booking.data.id}/cancel`, { token: demo, body: { reason: '临时有事' } });
  ok('提前取消成功并释放时段', cancelled.status === 200 && cancelled.data.status === 'cancelled');
  const freed = await api('GET', `/api/venues/${venues.data[0].id}/availability?date=${day}`);
  const freedSlot = freed.data.courts.find((c) => c.courtId === court).slots.find((s) => s.startTime === slot.startTime);
  ok('取消后时段回到可预约', freedSlot.status === 'available');

  const twice = await api('POST', `/api/bookings/${booking.data.id}/cancel`, { token: demo });
  ok('重复取消被拒绝', twice.status === 409);
  const otherCancel = await api('POST', `/api/bookings/${booking.data.id}/cancel`, { token: reg.data.token });
  ok('不能取消他人预约', otherCancel.status === 403);

  console.log('\n[5] 管理后台');
  const created = await api('POST', '/api/admin/venues', { token: admin, body: { name: '测试场馆', address: '测试路 1 号', sport: '羽毛球', openTime: '08:00', closeTime: '20:00', slotMinutes: 60 } });
  ok('管理员创建场馆', created.status === 200 && created.data.openTime === '08:00');
  const newCourt = await api('POST', `/api/admin/venues/${created.data.id}/courts`, { token: admin, body: { name: 'A 场', pricePerHour: 50 } });
  ok('管理员新增场地', newCourt.status === 200);
  const patched = await api('PATCH', `/api/admin/venues/${created.data.id}`, { token: admin, body: { closeTime: '21:00' } });
  ok('管理员调整开放时间', patched.data.closeTime === '21:00');

  const override = await api('POST', '/api/admin/overrides', { token: admin, body: { courtId: newCourt.data.id, date: day, startTime: '09:00', endTime: '10:00', status: 'maintenance', note: '设备检修' } });
  ok('标记维护时段', override.status === 200);
  const afterOverride = await api('GET', `/api/venues/${created.data.id}/availability?date=${day}`);
  ok('维护时段对用户不可约', afterOverride.data.courts[0].slots.find((s) => s.startTime === '09:00').status === 'maintenance');
  const removed = await api('DELETE', `/api/admin/overrides/${override.data.id}`, { token: admin });
  ok('取消维护标记', removed.status === 200);

  const lock3 = await api('POST', '/api/bookings/lock', { token: reg.data.token, body: { courtId: newCourt.data.id, date: day, startTime: '14:00', endTime: '15:00' } });
  const booking3 = await api('POST', '/api/bookings', { token: reg.data.token, body: { lockId: lock3.data.lockId } });
  const adminCancel = await api('POST', `/api/admin/bookings/${booking3.data.id}/cancel`, { token: admin, body: { reason: '场馆维修' } });
  ok('管理员强制取消预约', adminCancel.status === 200 && adminCancel.data.status === 'cancelled');
  const compensated = await api('GET', '/api/me', { token: reg.data.token });
  ok('被强制取消的用户获得积分补偿', compensated.data.points >= 102);
  const cancelNotice = await api('GET', '/api/notifications', { token: reg.data.token });
  ok('强制取消通知用户', cancelNotice.data.some((n) => n.title === '预约已被场馆取消'));

  const blockedByAdmin = await api('POST', '/api/admin/overrides', { token: admin, body: { courtId: newCourt.data.id, date: day, startTime: '16:00', endTime: '17:00', status: 'closed' } });
  ok('管理员可临时关闭时段', blockedByAdmin.status === 200 && blockedByAdmin.data.status === 'closed');

  const report = await api('GET', '/api/admin/report?days=7', { token: admin });
  ok('未来 7 天预约报表', report.status === 200 && report.data.venues.length >= 5 && report.data.venues.every((v) => v.byDate.length === 7));
  ok('报表含利用率与营收', typeof report.data.venues[0].utilization === 'number' && typeof report.data.totalRevenue === 'number');
  const adminBookings = await api('GET', `/api/admin/bookings?date=${day}`, { token: admin });
  ok('管理员预约总览', Array.isArray(adminBookings.data));

  console.log('\n[6] 实时推送 (SSE)');
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/stream?date=${day}`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (eventName) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`event: ${eventName}`)) return true;
    }
    return false;
  };
  ok('SSE 连接建立', await readUntil('ready'));
  const lock2 = await api('POST', '/api/bookings/lock', { token: reg.data.token, body: { courtId: newCourt.data.id, date: day, startTime: '10:00', endTime: '11:00' } });
  ok('SSE 收到锁定推送', lock2.status === 200 && (await readUntil('slot.locked')));
  controller.abort();

  console.log('\n[7] 并发抢占（先到先得，不超卖）');
  const venueDetail = await api('GET', `/api/venues/${venues.data[1].id}?date=${day}`);
  const raceCourt = venueDetail.data.courts[0].id;
  const raceSlot = venueDetail.data.slots[0].slots.find((s) => s.status === 'available');
  const attempts = await Promise.all(Array.from({ length: 12 }, () => api('POST', '/api/bookings/lock', {
    token: demo,
    body: { courtId: raceCourt, date: day, startTime: raceSlot.startTime, endTime: raceSlot.endTime },
  })));
  const wins = attempts.filter((r) => r.status === 200).length;
  const conflicts409 = attempts.filter((r) => r.status === 409).length;
  ok(`12 个并发请求中仅 1 个锁定成功（成功 ${wins} / 冲突 ${conflicts409}）`, wins === 1 && conflicts409 === 11);

  console.log('\n[8] 2 小时取消规则');
  const soon = new Date(Date.now() + 30 * 60_000);
  const soonMin = Math.floor((soon.getHours() * 60 + soon.getMinutes()) / 60) * 60;
  const inserted = app.db.prepare(`INSERT INTO bookings (code, venue_id, court_id, user_id, date, start_min, end_min, amount, status, qr, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, 50, 'confirmed', 'TEST', ?)`)
    .run('SOONTEST', venueDetail.data.id, raceCourt, 2, toDateStr(soon), soonMin, soonMin + 60, new Date().toISOString());
  const soonCancel = await api('POST', `/api/bookings/${Number(inserted.lastInsertRowid)}/cancel`, { token: demo });
  ok('距开场不足 2 小时不能自助取消', soonCancel.status === 409);
  const adminSoonCancel = await api('POST', `/api/admin/bookings/${Number(inserted.lastInsertRowid)}/cancel`, { token: admin, body: { reason: '特殊情况' } });
  ok('管理员可代为取消临场预约', adminSoonCancel.status === 200);

  console.log(`\n全部通过：${passed} 项\n`);
} catch (err) {
  console.error('\n测试失败：', err.message);
  process.exitCode = 1;
} finally {
  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
