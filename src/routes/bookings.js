import { requireUser } from '../auth.js';
import { num, prep } from '../db.js';
import { cancelBooking, confirmBooking, listBookings, lockSlot } from '../core.js';
import { forbidden, notFound } from '../http.js';
import { bookingJson } from '../core.js';

export function registerRoutes(router) {
  // 选定场地+时段 -> 立即锁定 10 分钟
  router.post('/api/bookings/lock', (ctx) => lockSlot(requireUser(ctx), ctx.body));

  // 支付/确认 -> 生成正式预约
  router.post('/api/bookings', (ctx) => confirmBooking(requireUser(ctx), ctx.body.lockId));

  router.get('/api/bookings/mine', (ctx) => listBookings(requireUser(ctx), {
    status: ctx.query.get('status'),
    date: ctx.query.get('date'),
  }));

  router.get('/api/bookings/:id', (ctx) => {
    const user = requireUser(ctx);
    const booking = prep('SELECT * FROM bookings WHERE id = ?').get(Number(ctx.params.id));
    if (!booking) throw notFound('预约不存在');
    if (num(booking.user_id) !== num(user.id) && user.role !== 'admin') throw forbidden();
    const court = prep('SELECT * FROM courts WHERE id = ?').get(booking.court_id);
    const venue = prep('SELECT * FROM venues WHERE id = ?').get(booking.venue_id);
    return { ...bookingJson(booking), venueName: venue?.name || '', venueAddress: venue?.address || '', courtName: court?.name || '' };
  });

  router.post('/api/bookings/:id/cancel', (ctx) => cancelBooking(requireUser(ctx), ctx.params.id, { reason: ctx.body.reason }));
}
