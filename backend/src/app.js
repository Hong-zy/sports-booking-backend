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
import { APP_NAME, APP_VERSION } from '../../shared/constants.js';
import { registerRoutes as registerAdmin } from './routes/admin.js';
import { registerRoutes as registerAi } from './routes/ai.js';
import { registerRoutes as registerAuth } from './routes/auth.js';
import { registerRoutes as registerBookings } from './routes/bookings.js';
import { registerRoutes as registerVenues } from './routes/venues.js';
import { seedIfEmpty } from './seed.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 静态资源分区：/shared/* -> shared 目录，其余 -> frontend 目录 */
const STATIC_ROOTS = [
  { prefix: '/shared/', dir: config.sharedDir },
  { prefix: '/', dir: config.frontendDir },
];

function resolveStatic(pathname) {
  for (const { prefix, dir } of STATIC_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length);
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, decodeURIComponent(rel));
    if (!file.startsWith(dir)) return null;
    return file;
  }
  return null;
}

function serveStatic(res, pathname) {
  const file = resolveStatic(pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const body = JSON.stringify({
      name: `${APP_NAME} API`,
      version: APP_VERSION,
      frontend: '/',
      health: '/api/health',
      docs: '见 README.md',
    });
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(body);
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  return res.end(body);
}

function buildHandler(router) {
  return async function handler(req, res) {
    const started = Date.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
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

export function createApp({ withSweeper = true } = {}) {
  seedIfEmpty();
  const router = createRouter();
  registerAuth(router);
  registerVenues(router);
  registerBookings(router);
  registerAdmin(router);
  registerAi(router);

  // 公共健康检查（前端启动时可用它确认后端在线）
  router.get('/api/health', () => ({
    ok: true,
    name: APP_NAME,
    version: APP_VERSION,
    now: new Date().toISOString(),
    sseClients: clientCount(),
  }));

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
