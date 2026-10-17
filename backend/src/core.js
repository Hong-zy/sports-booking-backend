import { config } from './config.js';
import { prep, num } from './db.js';
import { broadcast } from './events.js';
import { HttpError, bad, forbidden, notFound } from './http.js';
import { atMinute, dayStart, daysBetween, isDate, nowISO, overlaps, plusMinutes, randomCode, toDateStr, toHM, parseHM } from './util.js';

/* ------------------------------- 序列化 ------------------------------- */

export const venueJson = (v) => ({
  id: num(v.id),
  name: v.name,
  address: v.address,
  sport: v.sport,
  openTime: toHM(num(v.open_minute)),
  closeTime: toHM(num(v.close_minute)),
  slotMinutes: num(v.slot_minutes),
  status: v.status,
});

export const courtJson = (c) => ({
  id: num(c.id),
  venueId: num(c.venue_id),
  name: c.name,
  pricePerHour: num(c.price_per_hour),
  status: c.status,
});

export const bookingJson = (b) => ({
  id: num(b.id),
  code: b.code,
  venueId: num(b.venue_id),
  courtId: num(b.court_id),
  userId: num(b.user_id),
  date: b.date,
  startMin: num(b.start_min),
  endMin: num(b.end_min),
  startTime: toHM(num(b.start_min)),
  endTime: toHM(num(b.end_min)),
  amount: num(b.amount),
  status: b.status,
  qrCode: b.qr,
  createdAt: b.created_at,
  cancelledAt: b.cancelled_at,
  cancelReason: b.cancel_reason,
});

export const userJson = (u) => ({
  id: num(u.id),
  name: u.name,
  phone: u.phone,
  email: u.email,
  role: u.role,
  points: num(u.points),
  realName: u.real_name || null,
  verified: Boolean(u.real_name && u.id_card),
  createdAt: u.created_at,
});

export const notificationJson = (n) => ({
  id: num(n.id),
  channel: n.channel,
  title: n.title,
  body: n.body,
  read: Boolean(n.read),
  createdAt: n.created_at,
});

/* -------------------------------- 查询 -------------------------------- */

export function getVenueOrThrow(id) {
  const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(id));
  if (!venue) throw notFound('场馆不存在');
  return venue;
}

export function getCourtOrThrow(id) {
  const court = prep('SELECT * FROM courts WHERE id = ?').get(Number(id));
  if (!court) throw notFound('场地不存在');
  return court;
}

export function listVenues({ sport, keyword, date } = {}) {
  const day = isDate(date) ? date : toDateStr(new Date());
  return prep('SELECT * FROM venues ORDER BY id').all()
    .filter((v) => (!sport || v.sport === sport) && (!keyword || `${v.name}${v.address}`.includes(keyword)))
    .map((v) => {
      const courts = prep('SELECT * FROM courts WHERE venue_id = ?').all(v.id);
      const summary = availabilitySummary(v, courts, day);
      return { ...venueJson(v), courtCount: courts.length, ...summary };
    });
}

export function listSports() {
  return prep('SELECT DISTINCT sport FROM venues ORDER BY sport').all().map((r) => r.sport);
}

export function venueDetail(id, date) {
  const venue = getVenueOrThrow(id);
  const day = isDate(date) ? date : toDateStr(new Date());
  const courts = prep('SELECT * FROM courts WHERE venue_id = ? ORDER BY id').all(venue.id);
  return {
    ...venueJson(venue),
    date: day,
    courts: courts.map((c) => courtJson(c)),
    slots: courts.map((c) => ({ courtId: num(c.id), courtName: c.name, slots: slotsOf(venue, c, day) })),
  };
}

/** 计算某场地某天的逐时段状态 */
export function slotsOf(venue, court, date) {
  const step = num(venue.slot_minutes);
  const busy = occupancy(court.id, date);
  const slots = [];
  for (let m = num(venue.open_minute); m + step <= num(venue.close_minute); m += step) {
    const end = m + step;
    const hit = busy
      .filter((b) => overlaps(m, end, b.startMin, b.endMin))
      .sort((a, b) => priority(b) - priority(a))[0];
    slots.push({
      startMin: m,
      endMin: end,
      startTime: toHM(m),
      endTime: toHM(end),
      status: hit ? hit.type : 'available',
      price: Math.round((step / 60) * num(court.price_per_hour)),
    });
  }
  return slots;
}

const priority = (b) => ({ closed: 4, maintenance: 3, booked: 2, locked: 1 }[b.type] || 0);

/** 某场地某天的占用区间：已预约 / 临时锁定 / 维护关闭 */
export function occupancy(courtId, date) {
  const id = Number(courtId);
  const now = nowISO();
  const out = [];
  for (const b of prep("SELECT * FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").all(id, date)) {
    out.push({ type: 'booked', startMin: num(b.start_min), endMin: num(b.end_min), userId: num(b.user_id), code: b.code });
  }
  for (const l of prep("SELECT * FROM locks WHERE court_id = ? AND date = ? AND status = 'active' AND expires_at > ?").all(id, date, now)) {
    out.push({ type: 'locked', startMin: num(l.start_min), endMin: num(l.end_min), userId: num(l.user_id), expiresAt: l.expires_at });
  }
  for (const o of prep('SELECT * FROM slot_overrides WHERE court_id = ? AND date = ?').all(id, date)) {
    out.push({ type: o.status === 'closed' ? 'closed' : 'maintenance', startMin: num(o.start_min), endMin: num(o.end_min), note: o.note });
  }
  return out;
}

function availabilitySummary(venue, courts, date) {
  let free = 0;
  let total = 0;
  for (const c of courts) {
    for (const s of slotsOf(venue, c, date)) {
      total += 1;
      if (s.status === 'available') free += 1;
    }
  }
  return {
    availableSlots: free,
    totalSlots: total,
    utilization: total ? Number((1 - free / total).toFixed(3)) : 0,
    open: venue.status === 'open' && courts.some((c) => c.status === 'open'),
  };
}

/** 按运动类型 / 日期 / 时间段筛选可用场地 */
export function searchAvailable({ sport, date, startTime, endTime }) {
  const day = isDate(date) ? date : toDateStr(new Date());
  const start = parseHM(startTime);
  const end = parseHM(endTime);
  if (start === null || end === null || start >= end) throw bad('startTime / endTime 需要是 HH:MM 且 startTime < endTime');
  const result = [];
  for (const venue of prep('SELECT * FROM venues WHERE status = ? ORDER BY id').all('open')) {
    if (sport && venue.sport !== sport) continue;
    for (const court of prep('SELECT * FROM courts WHERE venue_id = ? AND status = ?').all(venue.id, 'open')) {
      if (start < num(venue.open_minute) || end > num(venue.close_minute)) continue;
      const busy = occupancy(court.id, day);
      if (busy.some((b) => overlaps(start, end, b.startMin, b.endMin))) continue;
      result.push({
        venueId: num(venue.id),
        venueName: venue.name,
        sport: venue.sport,
        courtId: num(court.id),
        courtName: court.name,
        date: day,
        startTime: toHM(start),
        endTime: toHM(end),
        amount: Math.round(((end - start) / 60) * num(court.price_per_hour)),
      });
    }
  }
  return result;
}

/* ------------------------------- 锁定 -------------------------------- */

export function lockSlot(user, payload = {}) {
  const { courtId, date } = payload;
  const startMin = parseHM(payload.startTime);
  const endMin = parseHM(payload.endTime);
  if (!courtId) throw bad('缺少 courtId');
  if (!isDate(date)) throw bad('date 需要是 YYYY-MM-DD');
  if (startMin === null || endMin === null || startMin >= endMin) throw bad('startTime / endTime 不合法');

  const court = getCourtOrThrow(courtId);
  const venue = getVenueOrThrow(court.venue_id);
  if (court.status !== 'open' || venue.status !== 'open') throw new HttpError(409, '该场地当前不可预约');

  const offset = daysBetween(toDateStr(new Date()), date);
  if (offset < 0) throw bad('不能预约过去的日期');
  if (offset > config.bookingDaysAhead) throw bad(`最多只能提前 ${config.bookingDaysAhead} 天预约`);

  const step = num(venue.slot_minutes);
  const aligned = (startMin - num(venue.open_minute)) % step === 0 && (endMin - num(venue.open_minute)) % step === 0;
  if (!aligned) throw bad(`时段需要按 ${step} 分钟对齐`);
  if (startMin < num(venue.open_minute) || endMin > num(venue.close_minute)) {
    throw bad(`该场馆开放时间为 ${toHM(num(venue.open_minute))}-${toHM(num(venue.close_minute))}`);
  }
  if (atMinute(date, startMin) <= Date.now()) throw bad('该时段已过，请选择更晚的时间');

  const busy = occupancy(court.id, date).filter((b) => overlaps(startMin, endMin, b.startMin, b.endMin));
  if (busy.length) {
    throw new HttpError(409, '该时段已被占用，已为你推荐相邻可约时段', {
      conflicts: busy.map((b) => ({ type: b.type, startTime: toHM(b.startMin), endTime: toHM(b.endMin) })),
      suggestions: suggestSlots(venue, court, date, startMin, endMin),
    });
  }

  const now = nowISO();
  const expiresAt = plusMinutes(config.lockMinutes);
  const res = prep(`INSERT INTO locks (court_id, user_id, date, start_min, end_min, status, created_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(court.id, user.id, date, startMin, endMin, now, expiresAt);
  const lockId = Number(res.lastInsertRowid);

  broadcast('slot.locked', { date, venueId: num(venue.id), courtId: num(court.id), startMin, endMin, lockId });

  return {
    lockId,
    courtId: num(court.id),
    venueId: num(venue.id),
    venueName: venue.name,
    courtName: court.name,
    date,
    startTime: toHM(startMin),
    endTime: toHM(endMin),
    amount: Math.round(((endMin - startMin) / 60) * num(court.price_per_hour)),
    lockMinutes: config.lockMinutes,
    expiresAt,
    remainSeconds: config.lockMinutes * 60,
  };
}

function suggestSlots(venue, court, date, startMin, endMin, limit = 3) {
  const want = endMin - startMin;
  const out = [];
  const courts = [court, ...prep('SELECT * FROM courts WHERE venue_id = ? AND id <> ? AND status = ? ORDER BY id').all(venue.id, court.id, 'open')];
  for (const c of courts) {
    const busy = occupancy(c.id, date);
    for (let m = num(venue.open_minute); m + want <= num(venue.close_minute); m += num(venue.slot_minutes)) {
      if (m < startMin && m + want > startMin) continue; // 跳过与请求时段重叠的窗口
      if (atMinute(date, m) <= Date.now()) continue;
      if (busy.some((b) => overlaps(m, m + want, b.startMin, b.endMin))) continue;
      out.push({ courtId: num(c.id), courtName: c.name, startTime: toHM(m), endTime: toHM(m + want), startMin: m, endMin: m + want });
      if (out.length >= limit) return out;
      break; // 每片场地只给最近的可用窗口
    }
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------- 预约 -------------------------------- */

export function confirmBooking(user, lockId) {
  const lock = prep('SELECT * FROM locks WHERE id = ?').get(Number(lockId));
  if (!lock) throw notFound('锁定记录不存在，请重新选择时段');
  if (num(lock.user_id) !== num(user.id)) throw forbidden('不能使用他人的锁定');
  if (lock.status !== 'active') throw new HttpError(409, '锁定已失效，请重新选择时段');
  if (lock.expires_at <= nowISO()) {
    prep("UPDATE locks SET status = 'expired' WHERE id = ?").run(lock.id);
    throw new HttpError(410, '锁定已超时，请重新选择时段');
  }

  const court = getCourtOrThrow(lock.court_id);
  const venue = getVenueOrThrow(court.venue_id);
  const busy = occupancy(court.id, lock.date)
    .filter((b) => b.type !== 'locked' && overlaps(num(lock.start_min), num(lock.end_min), b.startMin, b.endMin));
  if (busy.length) {
    prep("UPDATE locks SET status = 'released' WHERE id = ?").run(lock.id);
    throw new HttpError(409, '该时段已被他人预约', { conflicts: busy.map((b) => ({ type: b.type, startTime: toHM(b.startMin), endTime: toHM(b.endMin) })) });
  }

  const amount = Math.round(((num(lock.end_min) - num(lock.start_min)) / 60) * num(court.price_per_hour));
  const code = randomCode();
  const qr = Buffer.from(JSON.stringify({ code, court: court.name, date: lock.date, from: toHM(num(lock.start_min)), to: toHM(num(lock.end_min)) })).toString('base64url');
  const res = prep(`INSERT INTO bookings (code, venue_id, court_id, user_id, date, start_min, end_min, amount, status, qr, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`)
    .run(code, venue.id, court.id, user.id, lock.date, num(lock.start_min), num(lock.end_min), amount, qr, nowISO());
  prep("UPDATE locks SET status = 'consumed' WHERE id = ?").run(lock.id);

  const booking = prep('SELECT * FROM bookings WHERE id = ?').get(Number(res.lastInsertRowid));
  notify(user.id, {
    title: '预约成功',
    body: `${venue.name} ${court.name} ${lock.date} ${toHM(num(lock.start_min))}-${toHM(num(lock.end_min))}，凭证号 ${code}`,
  });
  broadcast('booking.created', { date: lock.date, venueId: num(venue.id), courtId: num(court.id), startMin: num(lock.start_min), endMin: num(lock.end_min) });
  return { ...bookingJson(booking), venueName: venue.name, courtName: court.name };
}

export function listBookings(user, { status, date, scope = 'mine' } = {}) {
  const rows = scope === 'all' && user.role === 'admin'
    ? prep('SELECT * FROM bookings ORDER BY date DESC, start_min DESC LIMIT 500').all()
    : prep('SELECT * FROM bookings WHERE user_id = ? ORDER BY date DESC, start_min DESC LIMIT 200').all(user.id);
  return rows
    .filter((b) => (!status || b.status === status) && (!date || b.date === date))
    .map((b) => {
      const court = prep('SELECT * FROM courts WHERE id = ?').get(b.court_id) || {};
      const venue = prep('SELECT * FROM venues WHERE id = ?').get(b.venue_id) || {};
      return { ...bookingJson(b), venueName: venue.name || '', courtName: court.name || '' };
    });
}

export function cancelBooking(user, bookingId, { reason = '', byAdmin = false } = {}) {
  const booking = prep('SELECT * FROM bookings WHERE id = ?').get(Number(bookingId));
  if (!booking) throw notFound('预约不存在');
  if (!byAdmin && num(booking.user_id) !== num(user.id)) throw forbidden('只能取消自己的预约');
  if (booking.status !== 'confirmed') throw new HttpError(409, '该预约当前状态不可取消');

  const startAt = atMinute(booking.date, num(booking.start_min));
  const hoursLeft = (startAt - Date.now()) / 3_600_000;
  if (!byAdmin && hoursLeft < config.cancelHours) {
    throw new HttpError(409, `距离开场不足 ${config.cancelHours} 小时，无法自行取消，请联系场馆管理员`);
  }

  prep(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?`)
    .run(nowISO(), byAdmin ? (reason || '管理员取消') : (reason || '用户取消'), booking.id);
  if (byAdmin) prep('UPDATE users SET points = points + 2 WHERE id = ?').run(booking.user_id);

  const venue = prep('SELECT * FROM venues WHERE id = ?').get(booking.venue_id);
  const court = prep('SELECT * FROM courts WHERE id = ?').get(booking.court_id);
  notify(booking.user_id, {
    title: byAdmin ? '预约已被场馆取消' : '预约已取消',
    body: `${venue?.name || ''} ${court?.name || ''} ${booking.date} ${toHM(num(booking.start_min))}-${toHM(num(booking.end_min))} 已取消${reason ? `（${reason}）` : ''}，费用将原路退回。`,
  });
  broadcast('booking.cancelled', {
    date: booking.date,
    venueId: num(booking.venue_id),
    courtId: num(booking.court_id),
    startMin: num(booking.start_min),
    endMin: num(booking.end_min),
  });
  return bookingJson(prep('SELECT * FROM bookings WHERE id = ?').get(booking.id));
}

/* ------------------------------ 通知/任务 ------------------------------ */

export function notify(userId, { title, body = '', email = null, sms = null }) {
  prep('INSERT INTO notifications (user_id, channel, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(userId, 'inapp', title, body, nowISO());
  if (email) console.log(`[email:模拟] -> ${email} | ${title} | ${body}`);
  else console.log(`[站内信] user=${userId} | ${title}`);
  if (sms) console.log(`[sms:模拟] -> ${sms} | ${title}`);
}

export function listNotifications(user, onlyUnread = false) {
  const rows = prep(`SELECT * FROM notifications WHERE user_id = ? ${onlyUnread ? 'AND read = 0' : ''} ORDER BY id DESC LIMIT 100`).all(user.id);
  return rows.map(notificationJson);
}

export function markNotificationsRead(user, ids = null) {
  if (Array.isArray(ids) && ids.length) {
    const stmt = prep('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?');
    for (const id of ids) stmt.run(user.id, Number(id));
  } else {
    prep('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user.id);
  }
  return { ok: true };
}

/** 定时任务：过期锁定回收、已结束预约标记完成 */
export function sweep() {
  const now = nowISO();
  const expired = prep("SELECT * FROM locks WHERE status = 'active' AND expires_at <= ?").all(now);
  if (expired.length) {
    prep("UPDATE locks SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").run(now);
    for (const l of expired) {
      broadcast('slot.released', { date: l.date, courtId: num(l.court_id), startMin: num(l.start_min), endMin: num(l.end_min), reason: 'lock-expired' });
    }
  }
  const finished = prep("SELECT * FROM bookings WHERE status = 'confirmed'").all()
    .filter((b) => atMinute(b.date, num(b.end_min)) < Date.now());
  for (const b of finished) {
    prep("UPDATE bookings SET status = 'completed' WHERE id = ?").run(b.id);
    prep('UPDATE users SET points = points + 1 WHERE id = ?').run(b.user_id);
  }
  return { expired: expired.length, completed: finished.length };
}

export { dayStart, toDateStr };
