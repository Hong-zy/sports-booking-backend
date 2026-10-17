export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    del: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      const segs = pathname.split('/').filter(Boolean);
      for (const r of routes) {
        if (r.method !== method || r.parts.length !== segs.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < r.parts.length; i += 1) {
          const part = r.parts[i];
          if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segs[i]);
          else if (part !== segs[i]) {
            ok = false;
            break;
          }
        }
        if (ok) return { handler: r.handler, params };
      }
      return null;
    },
  };
}
