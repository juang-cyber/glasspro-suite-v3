'use strict';
// Client low-level Shopee: baca setting tiap panggilan, sign, pilih transport (direct | bridge | mock),
// kelola token (refresh otomatis + mutex per toko), retry pada rate limit / 5xx, dan normalisasi error.
const { buildRequest, hostFor } = require('./sign');
const { now } = require('../util/time');
const log = require('../util/log').make('shopee');

const REFRESH_MARGIN_SEC = 15 * 60; // refresh bila sisa masa berlaku < 15 menit
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // refresh_token berlaku 30 hari
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

const TOKEN_ERROR_CODES = new Set(['error_auth', 'invalid_access_token', 'invalid_acceess_token']);
const REFRESH_FATAL_CODES = new Set(['refresh_token_expired', 'shop_access_expired', 'error_auth', 'error_shop_refresh_token', 'shop_no_linked', 'shop_banned']);
const RETRYABLE_CODES = new Set(['error_rate_limit', 'error_server', 'error_network']);

// Error terstruktur dari Shopee / transport. `status` = status HTTP yang layak dikirim ke client (>= 400),
// `http_status` = status HTTP mentah dari Shopee (bisa 200 walau error).
class ShopeeError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'ShopeeError';
    this.code = code || 'shopee_error';
    this.request_id = extra.request_id || null;
    this.http_status = extra.http_status ?? null;
    this.status = extra.status || (extra.http_status >= 400 ? extra.http_status : 502);
    this.details = extra.details;
    this.expose = true;
  }
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const suffix = (code) => String(code || '').split('.').pop();

function isTokenError(json) {
  if (!json || !json.error) return false;
  const code = suffix(json.error);
  if (TOKEN_ERROR_CODES.has(code)) return true;
  if (code === 'error_permission' && /token/i.test(String(json.message || ''))) return true;
  return false;
}

function createClient({ repo, fetchImpl, retryDelays } = {}) {
  if (!repo) throw new Error('createClient butuh repo');
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const delays = retryDelays || RETRY_DELAYS_MS;
  const refreshing = new Map(); // shop_id -> Promise (mutex refresh per toko)

  // Konfigurasi dari setting (dibaca setiap panggilan supaya perubahan di Pengaturan langsung berlaku).
  function readConfig() {
    const s = repo.getSettings();
    const transport = s['shopee.transport'] || 'direct';
    const env = s['shopee.env'] || 'live';
    let partner_id = s['shopee.partner_id'];
    let partner_key = s['shopee.partner_key'];
    if (transport === 'mock') {
      if (!partner_id) partner_id = 999;
      if (!partner_key) partner_key = 'mock-partner-key';
    }
    if (!partner_id || !partner_key) {
      throw new ShopeeError('not_configured', 'Partner ID / Partner Key Shopee belum diisi di Pengaturan', { status: 400 });
    }
    return {
      transport, env, host: hostFor(env),
      partner_id: Number.isFinite(Number(partner_id)) ? Number(partner_id) : partner_id,
      partner_key,
      bridge_url: s['shopee.bridge_url'] || '',
      bridge_token: s['shopee.bridge_token'] || '',
    };
  }

  // ---------- transport ----------
  // Semua transport mengembalikan { status, content_type, json?, buffer? }.
  async function transportDirect(built) {
    const res = await doFetch(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      redirect: 'follow',
    });
    const content_type = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, content_type, buffer };
  }

  async function transportBridge(cfg, built, req) {
    if (!cfg.bridge_url) throw new ShopeeError('bridge_not_configured', 'URL jembatan Shopee belum diisi di Pengaturan', { status: 400 });
    let res;
    try {
      res = await doFetch(cfg.bridge_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-token': cfg.bridge_token || '' },
        body: JSON.stringify({ method: built.method, path: built.path, query: built.query, body: req.body ?? null, binary: !!req.binary, env: cfg.env }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS + 5000),
      });
    } catch (e) {
      throw new ShopeeError('bridge_unreachable', `Jembatan Shopee tidak bisa dihubungi: ${e.message}`, { status: 502 });
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (res.status === 401) throw new ShopeeError('bridge_unauthorized', 'Token jembatan Shopee salah atau kosong', { status: 502 });
    if (res.status !== 200 || !data) {
      throw new ShopeeError('bridge_error', `Jembatan Shopee mengembalikan HTTP ${res.status}`, { status: 502, details: data && data.message ? { message: data.message } : undefined });
    }
    if (data.error && data.status === undefined) {
      // error dari jembatan itu sendiri (bukan dari Shopee)
      throw new ShopeeError(data.error, data.message || 'Kesalahan pada jembatan Shopee', { status: 502 });
    }
    const out = { status: data.status, content_type: data.content_type || '' };
    if (data.base64) out.buffer = Buffer.from(data.base64, 'base64');
    else if (data.json !== undefined) out.json = data.json;
    else out.buffer = Buffer.alloc(0);
    return out;
  }

  async function transportMock(built, req) {
    const mock = require('./mock');
    const r = await mock.handle({ path: built.path, method: built.method, query: built.query, body: req.body, binary: !!req.binary });
    if (Buffer.isBuffer(r)) return { status: 200, content_type: 'application/pdf', buffer: r };
    if (r && typeof r === 'object' && r.__transport) return { status: r.status || 200, content_type: r.content_type || 'application/json', json: r.json, buffer: r.buffer };
    return { status: 200, content_type: 'application/json', json: r };
  }

  async function transportSend(cfg, built, req) {
    if (cfg.transport === 'mock') return transportMock(built, req);
    if (cfg.transport === 'bridge') return transportBridge(cfg, built, req);
    return transportDirect(built);
  }

  // Ubah hasil transport menjadi json atau buffer (parse bila content-type JSON / bukan binary).
  function interpret(result, binary) {
    if (result.json !== undefined) return { json: result.json, buffer: null };
    const ct = String(result.content_type || '').toLowerCase();
    const buf = result.buffer || Buffer.alloc(0);
    const looksJson = ct.includes('json') || (!ct.includes('pdf') && !ct.includes('octet-stream') && /^\s*[{[]/.test(buf.subarray(0, 32).toString('utf8')));
    if (looksJson || !binary) {
      const text = buf.toString('utf8');
      try {
        return { json: JSON.parse(text), buffer: null };
      } catch {
        if (binary) return { json: null, buffer: buf };
        throw new ShopeeError('invalid_response', `Respons Shopee bukan JSON (HTTP ${result.status})`, { http_status: result.status, details: { snippet: text.slice(0, 200) } });
      }
    }
    return { json: null, buffer: buf };
  }

  // ---------- token ----------
  function computeExpiry(expire_in) {
    const n = Number(expire_in);
    if (!Number.isFinite(n) || n <= 0) return now() + 4 * 3600 - 60;
    if (n > 1e9) return Math.floor(n) - 60; // dokumentasi kadang mengembalikan epoch absolut
    return now() + Math.floor(n) - 60;
  }

  // Refresh token satu toko (mutex: panggilan paralel untuk toko yang sama menunggu promise yang sama).
  function refreshToken(shop_id) {
    const key = String(shop_id);
    if (refreshing.has(key)) return refreshing.get(key);
    const p = (async () => {
      const shop = repo.getShop(shop_id);
      if (!shop) throw new ShopeeError('shop_not_found', `Toko ${shop_id} tidak ditemukan`, { status: 404 });
      if (!shop.refresh_token) {
        repo.updateShop(shop_id, { status: 'expired', last_error: 'refresh_token kosong, perlu otorisasi ulang' });
        throw new ShopeeError('refresh_token_missing', 'Toko belum punya refresh_token, silakan hubungkan ulang', { status: 400 });
      }
      const cfg = readConfig();
      let json;
      try {
        json = await rawCall(cfg, {
          path: '/api/v2/auth/access_token/get', method: 'POST',
          body: { refresh_token: shop.refresh_token, partner_id: cfg.partner_id, shop_id: Number(shop_id) },
          public: true,
        });
      } catch (e) {
        const code = suffix(e.code);
        const msg = `Refresh token gagal: ${e.message}`;
        if (REFRESH_FATAL_CODES.has(code)) repo.updateShop(shop_id, { status: 'expired', last_error: msg });
        else repo.updateShop(shop_id, { last_error: msg });
        throw e;
      }
      const data = json.response && json.response.access_token ? json.response : json;
      if (!data.access_token) throw new ShopeeError('invalid_response', 'Respons refresh token tidak berisi access_token', { request_id: json.request_id });
      const t = now();
      // Simpan token baru SEBELUM dipakai (refresh_token sekali pakai).
      repo.updateShop(shop_id, {
        access_token: data.access_token,
        refresh_token: data.refresh_token || shop.refresh_token,
        access_expire_at: computeExpiry(data.expire_in),
        refresh_expire_at: t + REFRESH_TOKEN_TTL_SEC,
        last_refresh_at: t,
        status: 'connected',
        last_error: null,
      });
      log.info('token diperbarui', { shop_id: Number(shop_id) });
      return repo.getShop(shop_id);
    })();
    refreshing.set(key, p);
    p.finally(() => refreshing.delete(key)).catch(() => {});
    return p;
  }

  // Pastikan token toko masih berlaku; refresh bila sisa < 15 menit atau kosong.
  async function ensureToken(shop_id) {
    if (shop_id === undefined || shop_id === null) throw new ShopeeError('shop_required', 'shop_id wajib diisi', { status: 400 });
    const shop = repo.getShop(shop_id);
    if (!shop) throw new ShopeeError('shop_not_found', `Toko ${shop_id} belum terhubung`, { status: 404 });
    if (shop.status === 'disconnected') throw new ShopeeError('shop_disconnected', `Toko ${shop_id} sudah diputus, silakan hubungkan ulang`, { status: 400 });
    const remaining = (shop.access_expire_at || 0) - now();
    if (!shop.access_token || remaining < REFRESH_MARGIN_SEC) return refreshToken(shop_id);
    return shop;
  }

  // ---------- panggilan ----------
  // Satu percobaan kirim + interpretasi (tanpa retry / refresh).
  async function attempt(cfg, req, access_token, shop_id) {
    const built = buildRequest({
      host: cfg.host, partner_id: cfg.partner_id, partner_key: cfg.partner_key,
      path: req.path, method: req.method, query: req.query, body: req.body,
      access_token, shop_id: access_token ? shop_id : undefined,
    });
    const t0 = Date.now();
    let result;
    try {
      result = await transportSend(cfg, built, req);
    } catch (e) {
      if (e instanceof ShopeeError) throw e;
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const err = new ShopeeError(isTimeout ? 'timeout' : 'network_error', isTimeout ? 'Shopee tidak merespons dalam 60 detik' : `Gagal menghubungi Shopee: ${e.message}`, { status: 502 });
      err.retryable = true;
      log.warn('gagal', { path: req.path, ms: Date.now() - t0, error: err.code, transport: cfg.transport });
      throw err;
    }
    const ms = Date.now() - t0;
    log.info('call', { path: req.path, status: result.status, ms, shop_id: shop_id ?? null, transport: cfg.transport });
    return { result, ms };
  }

  async function rawCall(cfg, req, shopOverride) {
    const isPublic = !!req.public;
    const method = String(req.method || 'GET').toUpperCase();
    const reqN = { ...req, method };
    let shop = null;
    if (!isPublic) shop = shopOverride || (await ensureToken(req.shop_id));
    const shop_id = !isPublic ? Number(req.shop_id) : undefined;
    let refreshed = false;
    let retries = 0;
    for (;;) {
      let outcome;
      try {
        outcome = await attempt(cfg, reqN, shop ? shop.access_token : undefined, shop_id);
      } catch (e) {
        if (e.retryable && retries < delays.length) {
          await sleep(delays[retries++]);
          continue;
        }
        throw e;
      }
      const { result } = outcome;
      // HTTP 429 / 5xx -> retry dengan backoff
      if ((result.status === 429 || result.status >= 500) && retries < delays.length) {
        log.warn('retry', { path: req.path, http_status: result.status, wait_ms: delays[retries] });
        await sleep(delays[retries++]);
        continue;
      }
      const { json, buffer } = interpret(result, !!req.binary);
      if (json) {
        const errCode = json.error ? String(json.error) : '';
        if (errCode) {
          const code = suffix(errCode);
          if (RETRYABLE_CODES.has(code) && retries < delays.length) {
            log.warn('retry', { path: req.path, error: errCode, wait_ms: delays[retries] });
            await sleep(delays[retries++]);
            continue;
          }
          if (!isPublic && !refreshed && isTokenError(json)) {
            refreshed = true;
            log.warn('token ditolak, coba refresh', { path: req.path, shop_id, error: errCode });
            shop = await refreshToken(shop_id);
            continue;
          }
          log.warn('shopee error', { path: req.path, error: errCode, message: json.message, request_id: json.request_id, http_status: result.status });
          throw new ShopeeError(errCode, json.message || errCode, { request_id: json.request_id, http_status: result.status });
        }
        if (req.binary) {
          throw new ShopeeError('invalid_response', 'Shopee mengembalikan JSON, bukan berkas dokumen', { request_id: json.request_id, http_status: result.status });
        }
        return json;
      }
      if (result.status >= 400) {
        throw new ShopeeError(`http_${result.status}`, `Shopee mengembalikan HTTP ${result.status}`, { http_status: result.status });
      }
      return buffer;
    }
  }

  // API utama. { path, method, query, body, shop_id, binary, public }
  async function call(req) {
    if (!req || !req.path) throw new ShopeeError('bad_request', 'path wajib diisi', { status: 400 });
    if (!req.path.startsWith('/api/v2/')) throw new ShopeeError('bad_request', 'path harus diawali /api/v2/', { status: 400 });
    const cfg = readConfig();
    return rawCall(cfg, req);
  }

  return { call, ensureToken, refreshToken, readConfig, computeExpiry, ShopeeError };
}

module.exports = { createClient, ShopeeError, isTokenError, TOKEN_ERROR_CODES, REFRESH_FATAL_CODES, RETRYABLE_CODES };
