'use strict';
// Otorisasi Shopee: link auth_partner, tukar code -> token, refresh token.
const { sign, nowTs } = require('./sign');
const { ShopeeError } = require('./client');
const { now } = require('../util/time');
const log = require('../util/log').make('shopee:auth');

const MOCK_SHOP_ID = 999001;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;

function createAuth({ repo, client, shop }) {
  if (!repo || !client) throw new Error('createAuth butuh repo dan client');

  // Link otorisasi legacy (signed). Timestamp/sign hanya berlaku 5 menit -> buat saat diminta.
  function getAuthUrl({ redirect } = {}) {
    const cfg = client.readConfig();
    if (cfg.transport === 'mock') return `/api/shopee/callback?code=mock&shop_id=${MOCK_SHOP_ID}`;
    const settings = repo.getSettings();
    const target = redirect || settings['shopee.redirect_url'] || '';
    if (!target) throw new ShopeeError('redirect_missing', 'Redirect URL Shopee belum diisi di Pengaturan', { status: 400 });
    const path = '/api/v2/shop/auth_partner';
    const timestamp = nowTs();
    const sg = sign({ partner_id: cfg.partner_id, partner_key: cfg.partner_key, path, timestamp });
    return `${cfg.host}${path}?partner_id=${encodeURIComponent(cfg.partner_id)}&timestamp=${timestamp}&sign=${sg}&redirect=${encodeURIComponent(target)}`;
  }

  // Isi nama toko/region dari get_shop_info (tidak fatal bila gagal).
  async function fillShopInfo(shop_id) {
    if (!shop || typeof shop.getShopInfo !== 'function') return;
    try {
      const info = await shop.getShopInfo(shop_id);
      if (info) repo.updateShop(shop_id, { shop_name: info.shop_name || null, region: info.region || null, raw_info: info });
    } catch (e) {
      log.warn('gagal mengambil info toko', { shop_id, error: e.code || e.message });
    }
  }

  // Tukar code dari callback menjadi token. Untuk main_account_id: semua shop_id_list diupsert lalu direfresh satu per satu.
  async function exchangeCode({ code, shop_id, main_account_id } = {}) {
    if (!code) throw new ShopeeError('invalid_code', 'Kode otorisasi (code) kosong', { status: 400 });
    const given = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const sid = given(shop_id) ? Number(shop_id) : null;
    const mid = given(main_account_id) ? Number(main_account_id) : null;
    if (sid === null && mid === null) throw new ShopeeError('shop_required', 'shop_id atau main_account_id wajib diisi', { status: 400 });
    if ((sid !== null && !(Number.isInteger(sid) && sid > 0)) || (mid !== null && !(Number.isInteger(mid) && mid > 0))) {
      throw new ShopeeError('bad_request', 'shop_id / main_account_id harus berupa angka positif', { status: 400 });
    }
    const cfg = client.readConfig();
    const body = { code: String(code), partner_id: cfg.partner_id };
    if (sid) body.shop_id = sid;
    else body.main_account_id = mid;
    const json = await client.call({ path: '/api/v2/auth/token/get', method: 'POST', body, public: true });
    const data = json.response && json.response.access_token ? json.response : json;
    if (!data.access_token) throw new ShopeeError('invalid_response', 'Shopee tidak mengembalikan access_token', { request_id: json.request_id });
    const t = now();
    const tokenFields = {
      marketplace: 'shopee',
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      access_expire_at: client.computeExpiry(data.expire_in),
      refresh_expire_at: t + REFRESH_TOKEN_TTL_SEC,
      authorized_at: t,
      last_refresh_at: t,
      status: 'connected',
      last_error: null,
    };
    let shopIds = sid ? [sid] : (Array.isArray(data.shop_id_list) ? data.shop_id_list.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []);
    if (!shopIds.length) throw new ShopeeError('no_shop', 'Shopee tidak mengembalikan daftar toko untuk akun ini', { request_id: json.request_id, status: 400 });
    for (const id of shopIds) repo.upsertShop({ shop_id: id, ...tokenFields });
    log.info('toko terhubung', { shop_ids: shopIds, via: sid ? 'shop_id' : 'main_account_id' });
    if (mid) {
      // Pasangan token awal dipakai bersama; refresh per toko supaya masing-masing punya token sendiri.
      for (const id of shopIds) {
        try { await client.refreshToken(id); } catch (e) { log.warn('refresh awal gagal', { shop_id: id, error: e.code || e.message }); }
      }
    }
    for (const id of shopIds) await fillShopInfo(id);
    const first = repo.getShop(shopIds[0]);
    return { ...first, shop_id_list: shopIds };
  }

  async function refreshToken(shop_id) {
    return client.refreshToken(shop_id);
  }

  return { getAuthUrl, exchangeCode, refreshToken, MOCK_SHOP_ID };
}

module.exports = { createAuth, MOCK_SHOP_ID };
