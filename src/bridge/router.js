'use strict';
// Jembatan ke API Shopee (docs/CONTRACTS.md §4 "Bridge"). Dipakai instance lokal (laptop) yang IP-nya
// tidak di-whitelist: request yang SUDAH ditandatangani dikirim ke sini, lalu diteruskan apa adanya ke host Shopee.
//   POST /bridge/shopee  header x-bridge-token, body { method, path, query, body, binary, env? }
//                        -> { status, content_type, json? | base64? }
//   GET  /bridge/ping    -> { ok: true }  (butuh token)
// Kesalahan jembatan sendiri dibalas dengan HTTP != 200 dan body { error, message } (client.js membedakannya
// dari respons Shopee lewat ada/tidaknya field `status`).
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { hostFor, toQueryValue } = require('../shopee/sign');
const { wrap } = require('../util/errors');
const log = require('../util/log').make('bridge');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const TIMEOUT_MS = 60 * 1000;
const ALLOWED_METHODS = new Set(['GET', 'POST']);
// Hanya segmen path Shopee yang wajar: tanpa '.', '..', '//', query, atau spasi (cegah traversal ke path lain di host Shopee).
const PATH_RE = /^\/api\/v2(\/[A-Za-z0-9_-]+)+$/;

const router = express.Router();

function reply(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (!a.length || !b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Token dibaca dari config saat request (bukan saat modul dimuat) supaya bisa diubah di test.
function requireBridgeToken(req, res, next) {
  const expected = config.BRIDGE_TOKEN;
  if (!expected) return reply(res, 503, 'bridge_disabled', 'Jembatan Shopee tidak aktif: BRIDGE_TOKEN belum diset di server');
  const given = req.get('x-bridge-token');
  if (!tokenMatches(given, expected)) return reply(res, 401, 'unauthorized', 'Token jembatan salah atau kosong');
  next();
}

// Tolak body yang terlalu besar lebih awal (express.json global sudah parse hingga 2 MB; batas jembatan 1 MB).
function limitBody(req, res, next) {
  const len = Number(req.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return reply(res, 413, 'payload_too_large', 'Body permintaan melebihi 1 MB');
  next();
}

function pickEnv(bodyEnv) {
  if (bodyEnv === 'live' || bodyEnv === 'test') return bodyEnv;
  try {
    const repo = require('../db/repo');
    const e = repo.getSetting('shopee.env');
    if (e === 'live' || e === 'test') return e;
  } catch (e) { log.warn('gagal membaca setting shopee.env, memakai live', e.message); }
  return 'live';
}

// Teruskan satu request ke Shopee. `host` opsional (untuk test); default sesuai env.
async function relay({ method = 'GET', path, query = {}, body, binary = false, env, host, fetchImpl } = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(m)) {
    const err = new Error('method harus GET atau POST'); err.status = 400; err.code = 'bad_request'; err.expose = true; throw err;
  }
  if (typeof path !== 'string' || !path.startsWith('/api/v2/') || !PATH_RE.test(path)) {
    const err = new Error('path harus diawali /api/v2/ dan tidak boleh memuat query'); err.status = 400; err.code = 'bad_request'; err.expose = true; throw err;
  }
  if (query !== undefined && query !== null && (typeof query !== 'object' || Array.isArray(query))) {
    const err = new Error('query harus berupa objek'); err.status = 400; err.code = 'bad_request'; err.expose = true; throw err;
  }
  const baseHost = host || hostFor(pickEnv(env));
  const url = new URL(baseHost + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, toQueryValue(v));
  }
  const headers = { Accept: 'application/json, application/pdf, */*' };
  let bodyText;
  if (m !== 'GET') {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(body === undefined || body === null ? {} : body);
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) {
      const err = new Error('Body ke Shopee melebihi 1 MB'); err.status = 413; err.code = 'payload_too_large'; err.expose = true; throw err;
    }
  }
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const t0 = Date.now();
  let res;
  try {
    res = await doFetch(url.toString(), { method: m, headers, body: bodyText, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  } catch (e) {
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    log.warn('upstream gagal', { path, ms: Date.now() - t0, error: isTimeout ? 'timeout' : e.message });
    const err = new Error(isTimeout ? 'Shopee tidak merespons dalam 60 detik' : `Gagal menghubungi Shopee: ${e.message}`);
    err.status = 502; err.code = isTimeout ? 'upstream_timeout' : 'upstream_unreachable'; err.expose = true;
    throw err;
  }
  const content_type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  log.info('relay', { method: m, path, status: res.status, bytes: buf.length, ms: Date.now() - t0 });
  const out = { status: res.status, content_type };
  const ct = content_type.toLowerCase();
  const head = buf.subarray(0, 32).toString('utf8');
  const looksJson = ct.includes('json') || (!ct.includes('pdf') && !ct.includes('octet-stream') && /^\s*[{[]/.test(head));
  if (looksJson) {
    try { out.json = JSON.parse(buf.toString('utf8')); } catch { out.base64 = buf.toString('base64'); }
  } else {
    out.base64 = buf.toString('base64');
  }
  return out;
}

router.get('/ping', requireBridgeToken, (_req, res) => res.json({ ok: true }));

router.post('/shopee', requireBridgeToken, limitBody, express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return reply(res, 400, 'bad_request', 'Body harus berupa objek JSON');
  const out = await relay({ method: b.method, path: b.path, query: b.query, body: b.body, binary: !!b.binary, env: b.env });
  res.json(out);
}));

// Error handler lokal: kesalahan jembatan dibalas { error, message } (tanpa field status).
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error('bridge error', err);
  if (err.type === 'entity.too.large') return reply(res, 413, 'payload_too_large', 'Body permintaan melebihi 1 MB');
  if (err.type === 'entity.parse.failed') return reply(res, 400, 'bad_request', 'Body bukan JSON yang valid');
  reply(res, status, err.code || 'bridge_error', err.expose || status < 500 ? err.message : 'Terjadi kesalahan pada jembatan');
});

module.exports = router;
module.exports.relay = relay;
module.exports.requireBridgeToken = requireBridgeToken;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.TIMEOUT_MS = TIMEOUT_MS;
