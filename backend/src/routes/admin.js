import fs from 'node:fs';
import { requireAdmin } from '../auth.js';
import { cancelBooking, courtJson, listBookings, userJson, venueJson } from '../core.js';
import { db, num, prep } from '../db.js';
import { broadcast } from '../events.js';
import { clientCount } from '../events.js';
import { HttpError, bad, notFound } from '../http.js';
import { dayStart, isDate, nowISO, overlaps, parseHM, toDateStr, toHM } from '../util.js';
import { config } from '../config.js';
import { DB_TABLES } from '../../../shared/constants.js';
import {
  firstError,
  validateAdminUserPatch,
  validateCourtInput,
  validateOverrideInput,
  validateVenueInput,
} from '../../../shared/validate.js';

const need = (cond, msg) => {
  if (!cond) throw bad(msg);
};

const failIfInvalid = (errors) => {
  const msg = firstError(errors);
  if (msg) throw bad(msg);
};

const countOf = (sql, ...params) => num(prep(sql).get(...params).c);

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** 后台浏览用户表时脱敏 */
function maskUserRow(row) {
  const clone = { ...row };
  delete clone.password_hash;
  if (typeof clone.id_card === 'string' && clone.id_card.length > 10) {
    clone.id_card = `${clone.id_card.slice(0, 6)}********${clone.id_card.slice(-4)}`;
  }
  return clone;
}

export function registerRoutes(router) {
  /* ----------------------------- 场馆与场地配置 ----------------------------- */

  router.post('/api/admin/venues', (ctx) => {
    requireAdmin(ctx);
    const { name = '', address = '', sport = '', openTime = '08:00', closeTime = '22:00', slotMinutes = 60 } = ctx.body;
    failIfInvalid(validateVenueInput({ name, address, sport, openTime, closeTime, slotMinutes }));
    const res = prep(`INSERT INTO venues (name, address, sport, open_minute, close_minute, slot_minutes, status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(String(name).trim(), String(address).trim(), String(sport).trim(), parseHM(openTime), parseHM(closeTime), Number(slotMinutes), nowISO());
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(res.lastInsertRowid));
    broadcast('venue.updated', { venueId: num(venue.id) });
    return venueJson(venue);
  });

  router.patch('/api/admin/venues/:id', (ctx) => {
    requireAdmin(ctx);
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(ctx.params.id));
    if (!venue) throw notFound('场馆不存在');
    failIfInvalid(validateVenueInput(ctx.body, { partial: true }));
    const patch = {
      name: ctx.body.name ?? venue.name,
      address: ctx.body.address ?? venue.address,
      sport: ctx.body.sport ?? venue.sport,
      open_minute: ctx.body.openTime !== undefined ? parseHM(ctx.body.openTime) : num(venue.open_minute),
      close_minute: ctx.body.closeTime !== undefined ? parseHM(ctx.body.closeTime) : num(venue.close_minute),
      slot_minutes: ctx.body.slotMinutes !== undefined ? Number(ctx.body.slotMinutes) : num(venue.slot_minutes),
      status: ctx.body.status ?? venue.status,
    };
    // 合并后的最终值再做一次交叉校验（partial 更新时单侧字段无法在公用校验器里判断）
    need(patch.open_minute !== null && patch.close_minute !== null, '开放时间需要是 HH:MM 格式');
    need(patch.open_minute < patch.close_minute, '结束时间必须晚于开始时间');
    need(patch.slot_minutes >= 15 && patch.slot_minutes <= 240, '时段长度需在 15-240 分钟之间');
    prep(`UPDATE venues SET name = ?, address = ?, sport = ?, open_minute = ?, close_minute = ?, slot_minutes = ?, status = ? WHERE id = ?`)
      .run(patch.name, patch.address, patch.sport, patch.open_minute, patch.close_minute, patch.slot_minutes, patch.status, venue.id);
    broadcast('venue.updated', { venueId: num(venue.id) });
    return venueJson(prep('SELECT * FROM venues WHERE id = ?').get(venue.id));
  });

  /** 删除场馆：存在预约记录时拒绝（改为暂停营业），无预约时连同场地一起删除 */
  router.del('/api/admin/venues/:id', (ctx) => {
    requireAdmin(ctx);
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(ctx.params.id));
    if (!venue) throw notFound('场馆不存在');
    const bookings = countOf("SELECT COUNT(*) AS c FROM bookings WHERE venue_id = ? AND status IN ('confirmed','completed')", venue.id);
    if (bookings > 0) {
      throw new HttpError(409, `该场馆已有 ${bookings} 条有效预约记录，不能删除；可改为「暂停营业」`);
    }
    prep('DELETE FROM bookings WHERE venue_id = ?').run(venue.id); // 已取消的历史预约一并清理
    prep('DELETE FROM venues WHERE id = ?').run(venue.id); // courts / locks / overrides 级联删除
    broadcast('venue.updated', { venueId: num(venue.id) });
    return { ok: true, deletedVenueId: num(venue.id) };
  });

  router.post('/api/admin/venues/:id/courts', (ctx) => {
    requireAdmin(ctx);
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(ctx.params.id));
    if (!venue) throw notFound('场馆不存在');
    failIfInvalid(validateCourtInput(ctx.body));
    const res = prep('INSERT INTO courts (venue_id, name, price_per_hour, status) VALUES (?, ?, ?, ?)')
      .run(venue.id, String(ctx.body.name).trim(), Number(ctx.body.pricePerHour) || 0, ctx.body.status || 'open');
    broadcast('venue.updated', { venueId: num(venue.id) });
    return courtJson(prep('SELECT * FROM courts WHERE id = ?').get(Number(res.lastInsertRowid)));
  });

  router.patch('/api/admin/courts/:id', (ctx) => {
    requireAdmin(ctx);
    const court = prep('SELECT * FROM courts WHERE id = ?').get(Number(ctx.params.id));
    if (!court) throw notFound('场地不存在');
    failIfInvalid(validateCourtInput(ctx.body, { partial: true }));
    const price = ctx.body.pricePerHour !== undefined ? Number(ctx.body.pricePerHour) : num(court.price_per_hour);
    prep('UPDATE courts SET name = ?, price_per_hour = ?, status = ? WHERE id = ?')
      .run(ctx.body.name ?? court.name, Math.round(price), ctx.body.status ?? court.status, court.id);
    broadcast('venue.updated', { venueId: num(court.venue_id) });
    return courtJson(prep('SELECT * FROM courts WHERE id = ?').get(court.id));
  });

  /** 删除场地：有预约/锁定/标记时拒绝，保证数据一致 */
  router.del('/api/admin/courts/:id', (ctx) => {
    requireAdmin(ctx);
    const court = prep('SELECT * FROM courts WHERE id = ?').get(Number(ctx.params.id));
    if (!court) throw notFound('场地不存在');
    const refs = {
      bookings: countOf("SELECT COUNT(*) AS c FROM bookings WHERE court_id = ? AND status IN ('confirmed','completed')", court.id),
      locks: countOf("SELECT COUNT(*) AS c FROM locks WHERE court_id = ? AND status = 'active'", court.id),
      overrides: countOf('SELECT COUNT(*) AS c FROM slot_overrides WHERE court_id = ?', court.id),
    };
    const totalRefs = refs.bookings + refs.locks + refs.overrides;
    if (totalRefs > 0) {
      throw new HttpError(409, `该场地有 ${refs.bookings} 条预约 / ${refs.locks} 个锁定 / ${refs.overrides} 个时段标记，不能删除`);
    }
    prep('DELETE FROM bookings WHERE court_id = ?').run(court.id);
    prep('DELETE FROM courts WHERE id = ?').run(court.id);
    broadcast('venue.updated', { venueId: num(court.venue_id) });
    return { ok: true, deletedCourtId: num(court.id) };
  });

  /* -------------------------- 维护中 / 临时关闭 标记 -------------------------- */

  router.post('/api/admin/overrides', (ctx) => {
    requireAdmin(ctx);
    const { courtId, date, status = 'maintenance', note = '' } = ctx.body;
    const startMin = parseHM(ctx.body.startTime);
    const endMin = parseHM(ctx.body.endTime);
    failIfInvalid(validateOverrideInput({ courtId, date, startTime: ctx.body.startTime, endTime: ctx.body.endTime, status }));
    const court = prep('SELECT * FROM courts WHERE id = ?').get(Number(courtId));
    if (!court) throw notFound('场地不存在');

    const conflict = prep("SELECT * FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").all(court.id, date)
      .find((b) => overlaps(startMin, endMin, num(b.start_min), num(b.end_min)));
    const res = prep(`INSERT INTO slot_overrides (court_id, date, start_min, end_min, status, note, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(court.id, date, startMin, endMin, status, String(note).slice(0, 200), nowISO());
    broadcast('slot.status', { date, venueId: num(court.venue_id), courtId: num(court.id), startMin, endMin, status });
    return {
      id: Number(res.lastInsertRowid),
      courtId: num(court.id),
      courtName: court.name,
      date,
      startTime: toHM(startMin),
      endTime: toHM(endMin),
      status,
      note,
      hasBookingConflict: Boolean(conflict),
      conflictBookingCode: conflict?.code || null,
    };
  });

  router.get('/api/admin/overrides', (ctx) => {
    requireAdmin(ctx);
    const date = ctx.query.get('date');
    const courtId = ctx.query.get('courtId');
    return prep('SELECT * FROM slot_overrides ORDER BY date DESC, start_min LIMIT 500').all()
      .filter((o) => (!date || o.date === date) && (!courtId || num(o.court_id) === Number(courtId)))
      .map((o) => {
        const court = prep('SELECT * FROM courts WHERE id = ?').get(o.court_id);
        const venue = court ? prep('SELECT * FROM venues WHERE id = ?').get(court.venue_id) : null;
        return {
          id: num(o.id),
          courtId: num(o.court_id),
          courtName: court?.name || '',
          venueId: court ? num(court.venue_id) : null,
          venueName: venue?.name || '',
          date: o.date,
          startTime: toHM(num(o.start_min)),
          endTime: toHM(num(o.end_min)),
          status: o.status,
          note: o.note,
        };
      });
  });

  router.del('/api/admin/overrides/:id', (ctx) => {
    requireAdmin(ctx);
    const row = prep('SELECT * FROM slot_overrides WHERE id = ?').get(Number(ctx.params.id));
    if (!row) throw notFound('标记不存在');
    prep('DELETE FROM slot_overrides WHERE id = ?').run(row.id);
    const court = prep('SELECT * FROM courts WHERE id = ?').get(row.court_id);
    broadcast('slot.status', {
      date: row.date,
      venueId: court ? num(court.venue_id) : null,
      courtId: num(row.court_id),
      startMin: num(row.start_min),
      endMin: num(row.end_min),
      status: 'available',
    });
    return { ok: true };
  });

  /* ------------------------------- 预约管理 ------------------------------- */

  router.get('/api/admin/bookings', (ctx) => {
    const admin = requireAdmin(ctx);
    return listBookings(admin, { status: ctx.query.get('status'), date: ctx.query.get('date'), scope: 'all' });
  });

  router.post('/api/admin/bookings/:id/cancel', (ctx) => {
    const admin = requireAdmin(ctx);
    return cancelBooking(admin, ctx.params.id, { reason: ctx.body.reason || '场馆原因取消', byAdmin: true });
  });

  /* ------------------------------- 用户管理 ------------------------------- */

  router.get('/api/admin/users', (ctx) => {
    requireAdmin(ctx);
    const q = ctx.query.get('q');
    return prep('SELECT * FROM users ORDER BY id LIMIT 500').all()
      .filter((u) => !q || `${u.name}${u.phone}${u.email}`.includes(q))
      .map((u) => ({
        id: num(u.id),
        name: u.name,
        phone: u.phone,
        email: u.email,
        role: u.role,
        points: num(u.points),
        verified: Boolean(u.real_name && u.id_card),
        createdAt: u.created_at,
      }));
  });

  /** 修改用户角色 / 积分 / 昵称 */
  router.patch('/api/admin/users/:id', (ctx) => {
    const admin = requireAdmin(ctx);
    const target = prep('SELECT * FROM users WHERE id = ?').get(Number(ctx.params.id));
    if (!target) throw notFound('用户不存在');
    failIfInvalid(validateAdminUserPatch(ctx.body));

    const nextRole = ctx.body.role ?? target.role;
    if (target.role === 'admin' && nextRole !== 'admin') {
      const admins = countOf("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
      if (admins <= 1) throw new HttpError(409, '系统至少需要保留一名管理员，不能降级最后一个管理员');
    }
    if (num(target.id) === num(admin.id) && nextRole !== 'admin') {
      throw new HttpError(409, '不能取消当前登录账号的管理员身份');
    }
    prep('UPDATE users SET name = ?, role = ?, points = ? WHERE id = ?')
      .run(ctx.body.name ?? target.name, nextRole, ctx.body.points !== undefined ? Math.round(Number(ctx.body.points)) : num(target.points), target.id);
    return userJson(prep('SELECT * FROM users WHERE id = ?').get(target.id));
  });

  /** 删除用户：有预约记录时拒绝，避免破坏历史数据 */
  router.del('/api/admin/users/:id', (ctx) => {
    const admin = requireAdmin(ctx);
    const target = prep('SELECT * FROM users WHERE id = ?').get(Number(ctx.params.id));
    if (!target) throw notFound('用户不存在');
    if (num(target.id) === num(admin.id)) throw new HttpError(409, '不能删除当前登录的账号');
    if (target.role === 'admin') {
      const admins = countOf("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
      if (admins <= 1) throw new HttpError(409, '不能删除最后一名管理员');
    }
    const bookings = countOf('SELECT COUNT(*) AS c FROM bookings WHERE user_id = ?', target.id);
    if (bookings > 0) throw new HttpError(409, `该用户有 ${bookings} 条预约记录，不能删除（可保留账号）`);
    prep('DELETE FROM users WHERE id = ?').run(target.id); // locks / notifications 级联删除
    return { ok: true, deletedUserId: num(target.id) };
  });

  /* -------------------------- 报表：未来 N 天预约总览 -------------------------- */

  router.get('/api/admin/report', (ctx) => {
    requireAdmin(ctx);
    const days = Math.min(Math.max(Number(ctx.query.get('days')) || 7, 1), 31);
    const from = ctx.query.get('from') && isDate(ctx.query.get('from')) ? ctx.query.get('from') : toDateStr(new Date());
    const dates = Array.from({ length: days }, (_, i) => toDateStr(new Date(dayStart(from).getTime() + i * 86_400_000)));
    const venues = prep('SELECT * FROM venues ORDER BY id').all();

    const perVenue = venues.map((v) => {
      const courts = prep('SELECT * FROM courts WHERE venue_id = ?').all(v.id);
      const step = num(v.slot_minutes);
      const dailySlots = ((num(v.close_minute) - num(v.open_minute)) / step) * courts.length;
      let bookedSlots = 0;
      let revenue = 0;
      const byDate = dates.map((date) => {
        const rows = prep(`SELECT b.*, c.price_per_hour FROM bookings b JOIN courts c ON c.id = b.court_id
                           WHERE b.venue_id = ? AND b.date = ? AND b.status IN ('confirmed','completed')`).all(v.id, date);
        const slots = rows.reduce((sum, b) => sum + (num(b.end_min) - num(b.start_min)) / step, 0);
        const amount = rows.reduce((sum, b) => sum + num(b.amount), 0);
        bookedSlots += slots;
        revenue += amount;
        return {
          date,
          bookings: rows.length,
          bookedSlots: slots,
          capacitySlots: dailySlots,
          utilization: dailySlots ? Number((slots / dailySlots).toFixed(3)) : 0,
          revenue: amount,
        };
      });
      return {
        venueId: num(v.id),
        venueName: v.name,
        sport: v.sport,
        courtCount: courts.length,
        bookings: byDate.reduce((s, d) => s + d.bookings, 0),
        revenue,
        utilization: dailySlots * days ? Number((bookedSlots / (dailySlots * days)).toFixed(3)) : 0,
        byDate,
      };
    });

    return {
      from,
      to: dates[dates.length - 1],
      days,
      generatedAt: nowISO(),
      totalBookings: perVenue.reduce((s, v) => s + v.bookings, 0),
      totalRevenue: perVenue.reduce((s, v) => s + v.revenue, 0),
      venues: perVenue,
    };
  });

  /* --------------------------- 数据库概览 / 浏览 --------------------------- */

  /** 数据库概览：文件、各表行数、运行时信息 */
  router.get('/api/admin/stats', (ctx) => {
    requireAdmin(ctx);
    const tables = {};
    for (const table of DB_TABLES) {
      tables[table] = countOf(`SELECT COUNT(*) AS c FROM ${table}`);
    }
    return {
      dbPath: config.dbPath,
      dbSizeBytes: fileSize(config.dbPath) + fileSize(`${config.dbPath}-wal`) + fileSize(`${config.dbPath}-shm`),
      tables,
      uptimeSeconds: Math.round(process.uptime()),
      sseClients: clientCount(),
      serverTime: nowISO(),
      nodeVersion: process.version,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      config: {
        port: config.port,
        lockMinutes: config.lockMinutes,
        cancelHours: config.cancelHours,
        bookingDaysAhead: config.bookingDaysAhead,
      },
    };
  });

  /** 只读浏览数据表（表名白名单） */
  router.get('/api/admin/db/:table', (ctx) => {
    requireAdmin(ctx);
    const table = ctx.params.table;
    if (!DB_TABLES.includes(table)) throw bad('不支持浏览该表');

    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 50, 1), 200);
    const offset = Math.max(Number(ctx.query.get('offset')) || 0, 0);
    const q = String(ctx.query.get('q') || '').trim();

    let columns = [];
    try {
      columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    } catch {
      columns = Object.keys(db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() || {});
    }

    const where = q ? ` WHERE ${columns.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ')}` : '';
    const params = q ? columns.map(() => `%${q}%`) : [];
    const total = num(db.prepare(`SELECT COUNT(*) AS c FROM ${table}${where}`).get(...params)?.c);
    const orderCol = columns.includes('id') ? 'id' : columns[0];
    const rows = db.prepare(`SELECT * FROM ${table}${where} ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((row) => (table === 'users' ? maskUserRow(row) : row));

    return { table, columns, rows, total, limit, offset };
  });

  router.get('/api/admin/health', (ctx) => {
    requireAdmin(ctx);
    return { ok: true, now: nowISO(), uptimeSeconds: Math.round(process.uptime()) };
  });
}
