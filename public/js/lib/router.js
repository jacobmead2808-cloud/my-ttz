// History-API router. Pages are async functions (ctx) => { el, cleanup?, title? }.
const routes = [];
let current = null;
let renderFn = null;
let token = 0;

export function route(pattern, loader, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\/@:([a-zA-Z]+)/, '') + '/?$');
  routes.push({ pattern, re, keys, loader, opts });
}

export function routeRegex(re, keys, loader, opts = {}) {
  routes.push({ pattern: String(re), re, keys, loader, opts });
}

export function onRender(fn) { renderFn = fn; }

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search && !replace) return resolve();
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  return resolve();
}

export function currentPath() { return location.pathname; }

export async function resolve() {
  const my = ++token;
  const path = decodeURI(location.pathname);
  let match = null;
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      match = { r, params };
      break;
    }
  }
  if (current && current.cleanup) { try { current.cleanup(); } catch (e) { console.error(e); } }
  current = null;
  const ctx = { params: match ? match.params : {}, query: new URLSearchParams(location.search), path };
  const r = match ? match.r : routes.find((x) => x.opts.notFound);
  if (renderFn) await renderFn(r, ctx, () => my === token, (page) => { if (my === token) current = page; else if (page && page.cleanup) page.cleanup(); });
}

/** Intercept same-origin link clicks for client-side navigation. */
export function startRouter() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
  window.addEventListener('popstate', resolve);
  return resolve();
}
