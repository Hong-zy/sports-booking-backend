/** 极简 SSE 广播：/api/stream 的实时时段状态推送 */
const clients = new Set();

export function addClient(res, filter = {}) {
  const client = { res, filter };
  clients.add(client);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  client.cleanup = () => {
    clearInterval(ping);
    clients.delete(client);
  };
  return client;
}

export function removeClient(client) {
  client?.cleanup?.();
}

export function broadcast(type, payload = {}) {
  const event = { type, ts: Date.now(), ...payload };
  const chunk = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    const { date, venueId } = client.filter;
    if (date && payload.date && date !== payload.date) continue;
    if (venueId && payload.venueId && Number(venueId) !== Number(payload.venueId)) continue;
    try {
      client.res.write(chunk);
    } catch {
      removeClient(client);
    }
  }
}

export const clientCount = () => clients.size;
