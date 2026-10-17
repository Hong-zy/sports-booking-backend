import { listSports, listVenues, searchAvailable, venueDetail } from '../core.js';

export function registerRoutes(router) {
  router.get('/api/sports', () => listSports());

  router.get('/api/venues', (ctx) => listVenues({
    sport: ctx.query.get('sport'),
    keyword: ctx.query.get('keyword'),
    date: ctx.query.get('date'),
  }));

  router.get('/api/venues/:id', (ctx) => venueDetail(ctx.params.id, ctx.query.get('date')));

  router.get('/api/venues/:id/availability', (ctx) => {
    const detail = venueDetail(ctx.params.id, ctx.query.get('date'));
    return { date: detail.date, venue: { id: detail.id, name: detail.name, openTime: detail.openTime, closeTime: detail.closeTime, slotMinutes: detail.slotMinutes }, courts: detail.slots };
  });

  router.get('/api/availability', (ctx) => searchAvailable({
    sport: ctx.query.get('sport'),
    date: ctx.query.get('date'),
    startTime: ctx.query.get('startTime'),
    endTime: ctx.query.get('endTime'),
  }));
}
