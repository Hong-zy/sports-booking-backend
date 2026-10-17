import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { bearer, readToken } from './auth.js';
import { db, prep } from './db.js';
import { addClient, removeClient, clientCount } from './events.js';
import { HttpError, readBody, sendError, sendJson } from './http.js';
import { createRouter } from './router.js';
import { sweep } from './core.js';
import { registerRoutes as registerAdmin } from './routes/admin.js';
import { registerRoutes as registerAuth } from './routes/auth.js';
import { registerRoutes as registerBookings } from './routes/bookings.js';
import { registerRoutes as registerVenues } from './routes/venues.js';
import { seedIfEmpty } from './seed.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const publicDir = path.join(config.root, 'public');

function buildHandler(router) {
  return async function handler(req, res) {
    const started = Date.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      // 实时时段状态推送（SSE）
      if (url.pathname === '/api/stream') {
        const client = addClient(res, {
          date: url.searchParams.get('date'),
          venueId: url.searchParams.get('venueId'),
        });
        req.on('close', () => removeClient(client));
        return undefined;
      }

      const matched = router.match(req.method, url.pathname);
      if (!matched) {
        if (url.pathname.startsWith('/api/')) throw new HttpError(404, `接口不存在: ${req.method} ${url.pathname}`);
        return serveStatic(res, url.pathname);
      }

      const ctx = {
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body: await readBody(req),
        user: null,
      };
      const payload = readToken(bearer(req));
      if (payload) ctx.user = prep('SELECT * FROM users WHERE id = ?').get(Number(payload.uid)) || null;

      const result = await matched.handler(ctx);
      if (result === undefined || res.headersSent) return undefined;
      sendJson(res, 200, result);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    } finally {
      if (process.env.HTTP_LOG !== '0') {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
    return undefined;
  };
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const body = JSON.stringify({ name: '运动场馆易约 API', docs: '见 README.md', demo: '/' });
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(body);
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  return res.end(body);
}

export function createApp({ withSweeper = true } = {}) {
  seedIfEmpty();
  const router = createRouter();
  registerAuth(router);
  registerVenues(router);
  registerBookings(router);
  registerAdmin(router);

  const server = http.createServer(buildHandler(router));
  const timer = withSweeper ? setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.error('[sweep]', err);
    }
  }, 30_000) : null;
  timer?.unref?.();

  return {
    server,
    db,
    router,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      if (timer) clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
    stats: () => ({ sseClients: clientCount() }),
  };
}
