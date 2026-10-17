import { requireAdmin } from '../auth.js';
import { cancelBooking, courtJson, listBookings, venueJson } from '../core.js';
import { num, prep } from '../db.js';
import { broadcast } from '../events.js';
import { bad, notFound } from '../http.js';
import { dayStart, isDate, nowISO, overlaps, parseHM, toDateStr, toHM } from '../util.js';

const need = (cond, msg) => {
  if (!cond) throw bad(msg);
};

export function registerRoutes(router) {
  /* ----------------------------- 场馆与场地配置 ----------------------------- */

  router.post('/api/admin/venues', (ctx) => {
    requireAdmin(ctx);
    const { name = '', address = '', sport = '', openTime = '08:00', closeTime = '22:00', slotMinutes = 60 } = ctx.body;
    const open = parseHM(openTime);
    const close = parseHM(closeTime);
    need(name && sport, 'name / sport 必填');
    need(open !== null && close !== null && open < close, '开放时间不合法');
    const res = prep(`INSERT INTO venues (name, address, sport, open_minute, close_minute, slot_minutes, status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(name, address, sport, open, close, Number(slotMinutes) || 60, nowISO());
    return venueJson(prep('SELECT * FROM venues WHERE id = ?').get(Number(res.lastInsertRowid)));
  });

  router.patch('/api/admin/venues/:id', (ctx) => {
    requireAdmin(ctx);
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(ctx.params.id));
    if (!venue) throw notFound('场馆不存在');
    const patch = {
      name: ctx.body.name ?? venue.name,
      address: ctx.body.address ?? venue.address,
      sport: ctx.body.sport ?? venue.sport,
      open_minute: parseHM(ctx.body.openTime) ?? num(venue.open_minute),
      close_minute: parseHM(ctx.body.closeTime) ?? num(venue.close_minute),
      slot_minutes: Number(ctx.body.slotMinutes) || num(venue.slot_minutes),
      status: ctx.body.status ?? venue.status,
    };
    need(patch.open_minute < patch.close_minute, '开放时间不合法');
    prep(`UPDATE venues SET name = ?, address = ?, sport = ?, open_minute = ?, close_minute = ?, slot_minutes = ?, status = ? WHERE id = ?`)
      .run(patch.name, patch.address, patch.sport, patch.open_minute, patch.close_minute, patch.slot_minutes, patch.status, venue.id);
    broadcast('venue.updated', { venueId: num(venue.id) });
    return venueJson(prep('SELECT * FROM venues WHERE id = ?').get(venue.id));
  });

  router.post('/api/admin/venues/:id/courts', (ctx) => {
    requireAdmin(ctx);
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(Number(ctx.params.id));
    if (!venue) throw notFound('场馆不存在');
    need(ctx.body.name, 'name 必填');
    const res = prep('INSERT INTO courts (venue_id, name, price_per_hour, status) VALUES (?, ?, ?, ?)')
      .run(venue.id, ctx.body.name, Number(ctx.body.pricePerHour) || 0, ctx.body.status || 'open');
    broadcast('venue.updated', { venueId: num(venue.id) });
    return courtJson(prep('SELECT * FROM courts WHERE id = ?').get(Number(res.lastInsertRowid)));
  });

  router.patch('/api/admin/courts/:id', (ctx) => {
    requireAdmin(ctx);
    const court = prep('SELECT * FROM courts WHERE id = ?').get(Number(ctx.params.id));
    if (!court) throw notFound('场地不存在');
    prep('UPDATE courts SET name = ?, price_per_hour = ?, status = ? WHERE id = ?')
      .run(ctx.body.name ?? court.name, ctx.body.pricePerHour ?? num(court.price_per_hour), ctx.body.status ?? court.status, court.id);
    broadcast('venue.updated', { venueId: num(court.venue_id) });
    return courtJson(prep('SELECT * FROM courts WHERE id = ?').get(court.id));
  });

  /* -------------------------- 维护中 / 临时关闭 标记 -------------------------- */

  router.post('/api/admin/overrides', (ctx) => {
    requireAdmin(ctx);
    const { courtId, date, status = 'maintenance', note = '' } = ctx.body;
    const startMin = parseHM(ctx.body.startTime);
    const endMin = parseHM(ctx.body.endTime);
    const court = prep('SELECT * FROM courts WHERE id = ?').get(Number(courtId));
    if (!court) throw notFound('场地不存在');
    need(isDate(date), 'date 需要是 YYYY-MM-DD');
    need(startMin !== null && endMin !== null && startMin < endMin, '时间段不合法');
    need(['maintenance', 'closed'].includes(status), "status 只能是 maintenance 或 closed");

    const conflict = prep("SELECT * FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").all(court.id, date)
      .find((b) => overlaps(startMin, endMin, num(b.start_min), num(b.end_min)));
    const res = prep(`INSERT INTO slot_overrides (court_id, date, start_min, end_min, status, note, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(court.id, date, startMin, endMin, status, note, nowISO());
    broadcast('slot.status', { date, venueId: num(court.venue_id), courtId: num(court.id), startMin, endMin, status });
    return {
      id: Number(res.lastInsertRowid),
      courtId: num(court.id),
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
      .map((o) => ({
        id: num(o.id),
        courtId: num(o.court_id),
        date: o.date,
        startTime: toHM(num(o.start_min)),
        endTime: toHM(num(o.end_min)),
        status: o.status,
        note: o.note,
      }));
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

  router.get('/api/admin/users', (ctx) => {
    requireAdmin(ctx);
    const q = ctx.query.get('q');
    return prep('SELECT * FROM users ORDER BY id LIMIT 200').all()
      .filter((u) => !q || `${u.name}${u.phone}${u.email}`.includes(q))
      .map((u) => ({ id: num(u.id), name: u.name, phone: u.phone, email: u.email, role: u.role, points: num(u.points), verified: Boolean(u.real_name && u.id_card) }));
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
        return { date, bookings: rows.length, bookedSlots: slots, capacitySlots: dailySlots, utilization: dailySlots ? Number((slots / dailySlots).toFixed(3)) : 0, revenue: amount };
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

  router.get('/api/admin/health', (ctx) => {
    requireAdmin(ctx);
    return { ok: true, now: nowISO(), uptimeSeconds: Math.round(process.uptime()) };
  });
}
