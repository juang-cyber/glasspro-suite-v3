/**
 * router — routing berbasis hash (#/path/:param?x=1).
 *
 *   router.register('#/orders/:sn', { render(container, params, ctx) {...}, destroy() {...}, title: 'Detail Order' });
 *   router.navigate('#/orders/123?tab=items');
 *   router.current();   // { path:'/orders/123', params:{sn:'123'}, query:{tab:'items'}, hash:'#/orders/123?tab=items', name:'orders' }
 *
 * Halaman = objek { render(container, params, ctx), destroy?(), title? }.
 *   - `params`  : parameter path (':sn' → params.sn)
 *   - `ctx`     : { ...ctx global (store, api, dll — diisi core/main), query, route, navigate }
 * Jika path belum terdaftar, router mencoba `import('./pages/<nama>.js')` (nama = segmen pertama,
 * '/' → 'dashboard'). Modul boleh mendaftar sendiri lewat router.register, atau cukup mengekspor
 * { render } / default { render } — router akan mendaftarkannya sebagai '/<nama>' dan '/<nama>/:id'.
 * Jika gagal → kartu "Halaman belum tersedia".
 *
 * Konfigurasi (dipanggil main.js):
 *   router.configure({ layout(route) → slotElement, ctx, guard(route) → hashRedirect|null, notFound(container, route) })
 */
const routes = [];
const listeners = new Set();
let cfg = { layout: null, ctx: {}, guard: null, notFound: null, appTitle: 'Glass Pro Suite' };
let currentRoute = null;
let currentPage = null;
let renderSeq = 0;
let started = false;
let lastPath = null;

/** Normalisasi pattern/hash: '#/orders/:sn' | 'orders/:sn' | '/orders/:sn' → '/orders/:sn' */
export function normalizePath(p) {
  let s = String(p || '').trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** Urai hash lokasi → { path, query, hash, search }. */
export function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (!h) h = '/';
  const qi = h.indexOf('?');
  const rawPath = qi >= 0 ? h.slice(0, qi) : h;
  const search = qi >= 0 ? h.slice(qi) : '';
  const query = {};
  if (search) {
    for (const [k, v] of new URLSearchParams(search.slice(1))) {
      if (k in query) query[k] = [].concat(query[k], v);
      else query[k] = v;
    }
  }
  const path = normalizePath(decodeURIComponentSafe(rawPath));
  return { path, query, search, hash: '#' + path + search };
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Susun hash dari path + query: buildHash('/orders', {page:2}) → '#/orders?page=2' */
export function buildHash(path, query) {
  const p = normalizePath(path);
  if (!query || typeof query !== 'object') return '#' + p;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const qs = sp.toString();
  return '#' + p + (qs ? '?' + qs : '');
}

/** Kompilasi pattern → { pattern, segments, wildcard }. */
export function compile(pattern) {
  const p = normalizePath(pattern);
  const segments = p === '/' ? [] : p.slice(1).split('/');
  const wildcard = segments.length && segments[segments.length - 1] === '*';
  return { pattern: p, segments: wildcard ? segments.slice(0, -1) : segments, wildcard };
}

/** Cocokkan path dengan pattern terkompilasi → params | null. */
export function match(compiled, path) {
  const p = normalizePath(path);
  const segs = p === '/' ? [] : p.slice(1).split('/');
  if (!compiled.wildcard && segs.length !== compiled.segments.length) return null;
  if (compiled.wildcard && segs.length < compiled.segments.length) return null;
  const params = {};
  for (let i = 0; i < compiled.segments.length; i++) {
    const cs = compiled.segments[i];
    const s = segs[i];
    if (cs.startsWith(':')) {
      if (s === undefined || s === '') return null;
      params[cs.slice(1)] = s;
    } else if (cs !== s) return null;
  }
  if (compiled.wildcard) params.rest = segs.slice(compiled.segments.length).join('/');
  return params;
}

/** Daftarkan halaman. `page` = { render, destroy?, title? } atau fungsi render. */
export function register(pattern, page, opts = {}) {
  const pg = typeof page === 'function' ? { render: page } : page;
  if (!pg || typeof pg.render !== 'function') throw new Error(`router.register: halaman "${pattern}" harus punya render()`);
  const c = compile(pattern);
  const name = opts.name || pageNameFromPath(c.pattern);
  const existing = routes.findIndex((r) => r.pattern === c.pattern);
  const entry = { ...c, page: pg, name };
  if (existing >= 0) routes[existing] = entry; else routes.push(entry);
  // Pattern paling spesifik (tanpa param, lebih banyak segmen) dicoba lebih dulu.
  routes.sort((a, b) => score(b) - score(a));
  return entry;
}
function score(r) {
  let s = r.segments.length * 10;
  for (const seg of r.segments) if (!seg.startsWith(':')) s += 5;
  if (r.wildcard) s -= 20;
  return s;
}

/** Nama halaman dari path: '/' → 'dashboard', '/orders/1' → 'orders', '/dev/gallery' → 'gallery'. */
export function pageNameFromPath(path) {
  const p = normalizePath(path);
  if (p === '/') return 'dashboard';
  const segs = p.slice(1).split('/').filter((s) => s && !s.startsWith(':'));
  if (segs[0] === 'dev' && segs[1]) return segs[1];
  return segs[0] || 'dashboard';
}

/** Cari route terdaftar untuk path (sinkron). */
export function find(path) {
  for (const r of routes) {
    const params = match(r, path);
    if (params) return { route: r, params };
  }
  return null;
}

/** Cari route; jika belum ada, coba import dinamis ./pages/<nama>.js. */
export async function resolve(path) {
  const hit = find(path);
  if (hit) return hit;
  const name = pageNameFromPath(path);
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  let mod = null;
  try {
    mod = await import(`./pages/${name}.js`);
  } catch (e) {
    console.warn(`[router] halaman "${name}" belum tersedia:`, e && e.message);
    return null;
  }
  const again = find(path);
  if (again) return again;
  const page = (mod && (mod.page || mod.default || (typeof mod.render === 'function' ? mod : null))) || null;
  if (page && typeof page.render === 'function') {
    const base = name === 'dashboard' ? '/' : `/${name}`;
    register(base, page, { name });
    if (base !== '/') register(`${base}/:id`, page, { name });
    if (path.startsWith('/dev/')) register(`/dev/${name}`, page, { name });
    return find(path);
  }
  return null;
}

/** Route saat ini: { path, params, query, hash, name } (null sebelum start). */
export function current() { return currentRoute; }
export function params() { return currentRoute ? currentRoute.params : {}; }
export function query() { return currentRoute ? currentRoute.query : {}; }

/** Berpindah halaman. hash: '#/orders' | '/orders' | 'orders'. opts: { replace, query } */
export function navigate(hash, opts = {}) {
  const target = opts.query ? buildHash(hash, opts.query) : (String(hash || '').startsWith('#') ? hash : buildHash(hash));
  const same = location.hash === target || (!location.hash && target === '#/');
  if (opts.replace) {
    const url = location.pathname + location.search + target;
    history.replaceState(null, '', url);
    return handle();
  }
  if (same) return handle();
  location.hash = target;
  return undefined;
}

/** Ganti query route sekarang (tanpa menambah history): router.setQuery({ page: 2 }) */
export function setQuery(patch, opts = {}) {
  const cur = currentRoute || parseHash(location.hash);
  const q = { ...cur.query, ...patch };
  return navigate(buildHash(cur.path, q), { replace: opts.replace !== false });
}

/** Render ulang halaman saat ini. */
export function refresh() { return handle(); }

export function back(fallback = '#/') {
  if (history.length > 1) history.back(); else navigate(fallback);
}

/** Konfigurasi router (layout, ctx, guard, notFound, appTitle). */
export function configure(options = {}) { cfg = { ...cfg, ...options }; }

/** Listener perubahan route: fn(route). Mengembalikan fungsi unsubscribe. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Mulai: pasang listener hashchange dan render route saat ini. */
export function start() {
  if (started) return handle();
  started = true;
  window.addEventListener('hashchange', () => { handle(); });
  return handle();
}

async function handle() {
  const parsed = parseHash(location.hash);
  if (cfg.guard) {
    let redirect = null;
    try { redirect = cfg.guard(parsed); } catch (e) { console.error('[router] guard error', e); }
    if (redirect && normalizePath(parseHash(redirect).path) !== parsed.path) {
      return navigate(redirect, { replace: true });
    }
  }
  const seq = ++renderSeq;
  const resolved = await resolve(parsed.path);
  if (seq !== renderSeq) return; // sudah ada navigasi baru
  const route = { ...parsed, params: resolved ? resolved.params : {}, name: resolved ? resolved.route.name : pageNameFromPath(parsed.path), pattern: resolved ? resolved.route.pattern : null };

  if (currentPage && typeof currentPage.destroy === 'function') {
    try { currentPage.destroy(); } catch (e) { console.error('[router] destroy error', e); }
  }
  currentPage = resolved ? resolved.route.page : null;
  currentRoute = route;

  let slot = null;
  try { slot = cfg.layout ? cfg.layout(route) : null; } catch (e) { console.error('[router] layout error', e); }
  if (!slot) slot = document.getElementById('app') || document.body;
  const container = document.createElement('div');
  container.className = 'page';
  container.dataset.page = route.name;
  slot.replaceChildren(container);

  const pathChanged = lastPath !== route.path;
  lastPath = route.path;
  if (pathChanged) window.scrollTo({ top: 0 });

  for (const fn of listeners) { try { fn(route); } catch (e) { console.error('[router] listener error', e); } }

  const title = currentPage && currentPage.title;
  document.title = title ? `${typeof title === 'function' ? title(route) : title} · ${cfg.appTitle}` : cfg.appTitle;

  const ctx = { ...(cfg.ctx || {}), query: route.query, route, navigate, router: api };
  if (!currentPage) {
    if (cfg.notFound) { try { cfg.notFound(container, route); } catch (e) { console.error(e); } }
    else container.innerHTML = '<div class="card page-placeholder"><h3>Halaman belum tersedia</h3><p class="text-muted mt-2">Modul halaman ini belum dipasang.</p></div>';
    return;
  }
  try {
    await currentPage.render(container, route.params, ctx);
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error('[router] render error', e);
    renderError(container, e, route);
  }
}

function renderError(container, e, route) {
  const box = document.createElement('div');
  box.className = 'card page-error';
  const msg = (e && e.message) || 'Terjadi kesalahan';
  box.innerHTML = `<h3>Halaman gagal dimuat</h3><p class="text-muted mt-2">${escapeText(msg)}</p><pre>${escapeText((e && e.stack) || '')}</pre><div class="mt-4 row"><button type="button" class="btn btn-primary" data-act="retry">Coba lagi</button><a class="btn btn-secondary" href="#/">Ke Overview</a></div>`;
  box.querySelector('[data-act=retry]').addEventListener('click', () => handle());
  container.replaceChildren(box);
}
function escapeText(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Semua route terdaftar (debug). */
export function list() { return routes.map((r) => ({ pattern: r.pattern, name: r.name })); }

const api = {
  register, navigate, current, params, query, setQuery, refresh, back, configure, onChange, start, resolve, find, list,
  parseHash, buildHash, normalizePath, compile, match, pageNameFromPath,
};
export const router = api;
export default api;
