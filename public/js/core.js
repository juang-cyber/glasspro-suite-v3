/**
 * core — satu titik impor untuk semua halaman Glass Pro Suite.
 *
 *   import { api, router, el, html, store, toast, modal, fmt, components, icons } from '../core.js';
 *
 * Isi:
 *   api        → api.js      (get/post/put/patch/del; 401 otomatis diarahkan ke #/login)
 *   router     → router.js   (register/navigate/current/...)
 *   el, html   → components.js (pembuat DOM + tagged template)
 *   store      → state global { user, settings, sync } + subscribe (didefinisikan di sini)
 *   toast, modal, components, icons → components.js
 *   fmt        → fmt.js
 */
import { api, ApiError } from './api.js';
import { router } from './router.js';
import { fmt } from './fmt.js';
import { el, html, toast, modal, components, icons, icon, mount, svgEl, escapeHtml, debounce, classNames, append, setAttrs } from './components.js';

// ============================================================================
// Store — state global sederhana dengan subscribe.
//   store.user / store.settings / store.sync  (get/set langsung, memicu subscriber)
//   store.get('user'), store.set({ user }), store.set('sync', status)
//   store.subscribe(fn)            → fn(state, changedKeys)   ; mengembalikan unsubscribe
//   store.subscribe('user', fn)    → fn(value, state)         ; hanya saat key itu berubah
// ============================================================================
const STORE_KEYS = ['user', 'settings', 'sync'];

function createStore(initial) {
  const state = { user: null, settings: null, sync: null, ...(initial || {}) };
  const listeners = new Set();

  function notify(keys) {
    for (const l of [...listeners]) {
      try {
        if (l.key) { if (keys.includes(l.key)) l.fn(state[l.key], state); }
        else l.fn(state, keys);
      } catch (e) { console.error('[store] listener error', e); }
    }
  }

  const store = {
    /** Objek state (baca saja; ubah lewat set()). */
    get state() { return state; },
    get(key) { return key === undefined ? state : state[key]; },
    /** set({ a: 1, b: 2 }) atau set('a', 1). Hanya key yang nilainya berubah yang memicu subscriber. */
    set(patchOrKey, value) {
      const patch = typeof patchOrKey === 'string' ? { [patchOrKey]: value } : (patchOrKey || {});
      const changed = [];
      for (const [k, v] of Object.entries(patch)) {
        if (state[k] === v) continue;
        state[k] = v;
        changed.push(k);
      }
      if (changed.length) notify(changed);
      return changed;
    },
    /** Paksa beri tahu subscriber (mis. setelah mengubah objek secara in-place). */
    touch(...keys) { notify(keys.length ? keys : Object.keys(state)); },
    subscribe(keyOrFn, maybeFn) {
      const entry = typeof keyOrFn === 'function' ? { fn: keyOrFn, key: null } : { fn: maybeFn, key: keyOrFn };
      if (typeof entry.fn !== 'function') throw new Error('store.subscribe: fungsi wajib diisi');
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    /** Hapus semua data sesi (saat logout). */
    reset() { store.set({ user: null, settings: null, sync: null }); },
    /** true jika user login dan berperan admin */
    get isAdmin() { return !!(state.user && state.user.role === 'admin'); },
  };
  for (const k of STORE_KEYS) {
    Object.defineProperty(store, k, { get: () => state[k], set: (v) => { store.set(k, v); }, enumerable: true });
  }
  return store;
}

export const store = createStore();

// ============================================================================
// Petunjuk sesi: ditandai saat login sukses, dihapus saat logout/401.
// Dipakai main.js agar tidak memanggil /api/auth/me (yang pasti 401) pada kunjungan
// pertama ke #/login — menghindari error 401 di console browser.
// ============================================================================
const SESSION_KEY = 'gps.session';
export function hasSessionHint() { try { return localStorage.getItem(SESSION_KEY) === '1'; } catch { return false; } }
/** Hapus penanda sesi (dipanggil saat sesi ternyata sudah tidak berlaku, mis. cookie kadaluarsa → /me 401). */
export function clearSessionHint() { try { localStorage.removeItem(SESSION_KEY); } catch { /* abaikan */ } }
store.subscribe('user', (u) => { try { if (u) localStorage.setItem(SESSION_KEY, '1'); else localStorage.removeItem(SESSION_KEY); } catch { /* abaikan */ } });

// ============================================================================
// Rute tujuan setelah login (disimpan di sessionStorage agar tahan reload)
// ============================================================================
const NEXT_KEY = 'gps.next';
export function rememberNext(hash) {
  try {
    const h = String(hash || '');
    if (!h || h === '#/' || h.startsWith('#/login')) sessionStorage.removeItem(NEXT_KEY);
    else sessionStorage.setItem(NEXT_KEY, h);
  } catch { /* abaikan */ }
}
export function takeNext(fallback = '#/') {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return v && v.startsWith('#/') && !v.startsWith('#/login') ? v : fallback;
  } catch { return fallback; }
}

// 401 dari API mana pun (kecuali login/me yang ditangani pemanggil) → hapus user, arahkan ke #/login.
api.onUnauthorized((_err, info) => {
  const p = (info && info.path) || '';
  clearSessionHint(); // sesi server tidak berlaku lagi → jangan panggil /me lagi saat boot berikutnya
  if (/^\/api\/auth\/(login|me|logout)\b/.test(p)) return;
  const cur = router.parseHash(location.hash);
  if (store.user) store.user = null;
  if (cur.path !== '/login') {
    rememberNext(cur.hash);
    router.navigate('#/login', { replace: true });
  }
});

// ============================================================================
// Helper kecil yang sering dipakai halaman
// ============================================================================

/** Tangani error dari API secara seragam: tampilkan toast (kecuali 401 yang sudah diarahkan). */
export function reportError(e, fallback = 'Terjadi kesalahan') {
  if (e instanceof ApiError && e.status === 401) return;
  const msg = api.errorMessage(e, fallback);
  console.error(e);
  toast.error(msg);
  return msg;
}

/** Nama tampilan user saat ini. */
export function userName(u = store.user) { return u ? (u.name || u.username || '') : ''; }

export { api, ApiError, router, fmt, el, html, toast, modal, components, icons, icon, mount, svgEl, escapeHtml, debounce, classNames, append, setAttrs };

export const core = { api, ApiError, router, fmt, el, html, store, toast, modal, components, icons, icon, mount, svgEl, escapeHtml, debounce, classNames, reportError, userName, rememberNext, takeNext, hasSessionHint, clearSessionHint };
export default core;
