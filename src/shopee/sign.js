'use strict';
// Penandatanganan request Shopee Open Platform v2 (lihat docs/research/research_shopee-auth-orders.md §1).
// Base string: partner_id + path + timestamp (+ access_token + shop_id untuk API toko),
// HMAC-SHA256 dengan partner_key sebagai string UTF-8, hasil hex huruf kecil (64 karakter).
const crypto = require('crypto');

const HOSTS = {
  live: 'https://partner.shopeemobile.com',
  test: 'https://openplatform.sandbox.test-stable.shopee.sg',
};

function hostFor(env) {
  return env === 'test' || env === 'sandbox' ? HOSTS.test : HOSTS.live;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

// Hitung signature. access_token + shop_id hanya ikut jika keduanya diisi (API toko).
function sign({ partner_id, partner_key, path, timestamp, access_token, shop_id }) {
  if (partner_id === undefined || partner_id === null || partner_id === '') throw new Error('partner_id wajib untuk sign');
  if (!partner_key) throw new Error('partner_key wajib untuk sign');
  if (!path) throw new Error('path wajib untuk sign');
  let base = `${partner_id}${path}${timestamp}`;
  if (access_token) base += `${access_token}${shop_id !== undefined && shop_id !== null ? shop_id : ''}`;
  return crypto.createHmac('sha256', String(partner_key)).update(base).digest('hex');
}

// Ubah nilai query menjadi string (array -> gabung koma, boolean -> 'true'/'false').
function toQueryValue(v) {
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// Susun request lengkap. Common params (partner_id, timestamp, sign, access_token, shop_id)
// SELALU di query string, juga untuk POST. Body dikirim sebagai JSON.
function buildRequest({ host, env, partner_id, partner_key, path, method = 'GET', query = {}, body, access_token, shop_id, timestamp }) {
  const m = String(method || 'GET').toUpperCase();
  const ts = timestamp || nowTs();
  const baseHost = host || hostFor(env);
  const signature = sign({ partner_id, partner_key, path, timestamp: ts, access_token, shop_id });
  const fullQuery = { partner_id, timestamp: ts, sign: signature };
  if (access_token) {
    fullQuery.access_token = access_token;
    if (shop_id !== undefined && shop_id !== null) fullQuery.shop_id = shop_id;
  }
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    fullQuery[k] = v;
  }
  const url = new URL(baseHost + path);
  for (const [k, v] of Object.entries(fullQuery)) url.searchParams.set(k, toQueryValue(v));
  const headers = { Accept: 'application/json, application/pdf, */*' };
  let bodyText;
  if (m !== 'GET') {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(body === undefined || body === null ? {} : body);
  }
  return { url: url.toString(), method: m, headers, body: bodyText, query: fullQuery, path, timestamp: ts, sign: signature, host: baseHost };
}

module.exports = { HOSTS, hostFor, nowTs, sign, buildRequest, toQueryValue };
