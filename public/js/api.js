/**
 * api — pembungkus fetch JSON ke backend (credentials same-origin).
 *
 *   const data = await api.get('/api/orders', { query: { page: 2, q: 'abc' } });
 *   await api.post('/api/sync/now');
 *   await api.patch(`/api/orders/${sn}/overrides`, { excluded: true });
 *   await api.del(`/api/settings/users/${id}`);
 *
 * Gagal → throw ApiError { status, code, message, details }.
 *   - status 0  / code 'network'  : server tidak bisa dihubungi
 *   - status 401 / code 'unauthorized' : handler onUnauthorized dipanggil (core.js mengarahkan ke #/login)
 *   - status 404 : code 'not_found' (modul backend mungkin belum ada — tangani di halaman)
 * Semua pesan sudah Bahasa Indonesia (dari server; fallback disediakan di sini).
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || 'Terjadi kesalahan');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'error';
    this.details = details;
  }
  /** true jika endpoint belum tersedia (404) */
  get isNotFound() { return this.status === 404; }
  get isUnauthorized() { return this.status === 401; }
  get isNetwork() { return this.status === 0; }
}

const FALLBACK_MESSAGE = {
  0: 'Tidak dapat terhubung ke server. Periksa koneksi Anda.',
  400: 'Permintaan tidak valid',
  401: 'Silakan login terlebih dahulu',
  403: 'Anda tidak memiliki akses untuk tindakan ini',
  404: 'Endpoint tidak ditemukan',
  409: 'Terjadi konflik. Coba muat ulang halaman.',
  429: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.',
  500: 'Terjadi kesalahan pada server',
  502: 'Server tidak merespons (bad gateway)',
  503: 'Layanan sedang tidak tersedia',
};

let unauthorizedHandler = null;
let baseUrl = '';

/** Daftarkan handler yang dipanggil setiap ada respons 401 (dipasang oleh core.js). */
export function onUnauthorized(fn) { unauthorizedHandler = typeof fn === 'function' ? fn : null; }
/** Prefix URL (kosong = origin yang sama). */
export function setBaseUrl(u) { baseUrl = String(u || '').replace(/\/$/, ''); }

/** Susun query string dari objek; nilai null/undefined/'' dilewati, array → diulang. */
export function buildQuery(q) {
  if (!q || typeof q !== 'object') return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => { if (x !== null && x !== undefined && x !== '') sp.append(k, String(x)); });
    else if (typeof v === 'boolean') sp.set(k, v ? '1' : '0');
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Gabungkan path + query (query boleh objek). */
export function withQuery(path, query) {
  const qs = buildQuery(query);
  if (!qs) return path;
  return path + (path.includes('?') ? '&' + qs.slice(1) : qs);
}

async function parseBody(res) {
  const ct = res.headers.get('content-type') || '';
  if (res.status === 204) return null;
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { return null; }
  }
  try {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
  } catch { return null; }
}

/**
 * Permintaan umum.
 * @param {string} method
 * @param {string} path  mis. '/api/orders'
 * @param {object} [opts] { body, query, headers, signal, raw:false (true → kembalikan Response mentah), timeout (ms) }
 */
export async function request(method, path, opts = {}) {
  const { body, query, headers, signal, raw = false, timeout } = opts;
  const url = baseUrl + withQuery(path, query);
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(headers || {}) } };
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) init.body = body;
    else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  }
  let ctrl = null; let timer = null;
  if (timeout && typeof AbortController !== 'undefined') {
    ctrl = new AbortController();
    init.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeout);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  } else if (signal) init.signal = signal;

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new ApiError(0, 'aborted', 'Permintaan dibatalkan');
    throw new ApiError(0, 'network', FALLBACK_MESSAGE[0]);
  }
  if (timer) clearTimeout(timer);
  if (raw) return res;

  const data = await parseBody(res);
  if (!res.ok) {
    const code = (data && (data.error || data.code)) || (res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : `http_${res.status}`);
    const message = (data && data.message) || FALLBACK_MESSAGE[res.status] || `Permintaan gagal (${res.status})`;
    const err = new ApiError(res.status, code, message, data ? data.details : undefined);
    if (res.status === 401 && unauthorizedHandler) {
      try { unauthorizedHandler(err, { path, method }); } catch { /* abaikan */ }
    }
    throw err;
  }
  return data;
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, body, opts) => request('POST', path, { ...(opts || {}), body });
export const put = (path, body, opts) => request('PUT', path, { ...(opts || {}), body });
export const patch = (path, body, opts) => request('PATCH', path, { ...(opts || {}), body });
export const del = (path, body, opts) => request('DELETE', path, { ...(opts || {}), body });

/**
 * Coba GET; jika endpoint belum ada (404) atau jaringan gagal → kembalikan `fallback` tanpa throw.
 * Berguna saat modul backend lain belum dipasang.
 */
export async function tryGet(path, fallback = null, opts) {
  try { return await get(path, opts); } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 0 || e.status === 503)) return fallback;
    throw e;
  }
}

/** URL absolut untuk link unduhan (mis. PDF) — untuk <a href> / window.open. */
export function url(path, query) { return baseUrl + withQuery(path, query); }

/** Ambil pesan error yang ramah dari error apa pun. */
export function errorMessage(e, fallback = 'Terjadi kesalahan') {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  return fallback;
}

export const api = { request, get, post, put, patch, del, delete: del, tryGet, url, withQuery, buildQuery, onUnauthorized, setBaseUrl, errorMessage, ApiError };
export default api;
