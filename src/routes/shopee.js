'use strict';
// Route /api/shopee (docs/CONTRACTS.md §5). Dimount di index.js TANPA requireAuth global karena
// /callback harus bisa diakses tanpa login (Shopee yang me-redirect ke sini); route lain dijaga per-route.
const express = require('express');
const repo = require('../db/repo');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { badRequest, notFound, wrap } = require('../util/errors');
const shopeeMod = require('../shopee');
const log = require('../util/log').make('routes:shopee');

const router = express.Router();
const shopee = () => shopeeMod.create();
const { publicShop } = shopeeMod;

function parseShopId(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('shop_id tidak valid');
  return n;
}

function shortMessage(e) {
  const msg = e && e.message ? String(e.message) : 'Kesalahan tidak diketahui';
  const code = e && typeof e.code === 'string' && e.code && !msg.startsWith(e.code) ? `${e.code}: ` : '';
  return `${code}${msg}`.slice(0, 200);
}

// Ambil code/shop_id/main_account_id dari URL callback yang ditempel pengguna (URL penuh, atau hanya query string).
function parseCallbackUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  let params;
  try {
    params = new URL(s).searchParams;
  } catch {
    const q = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s.replace(/^#?\/?/, '');
    params = new URLSearchParams(q);
  }
  const get = (k) => { const v = params.get(k); return v === null || v === '' ? undefined : v; };
  return { code: get('code'), shop_id: get('shop_id'), main_account_id: get('main_account_id') };
}

function shopView(row) {
  if (!row) return null;
  const out = publicShop(row);
  if (Array.isArray(row.shop_id_list)) out.shop_id_list = row.shop_id_list;
  return out;
}

// GET /status -> shopee.status() + { last_sync }
router.get('/status', requireAuth, wrap(async (_req, res) => {
  res.json({ ...shopee().status(), last_sync: repo.lastSync('shopee') });
}));

// GET /auth-url -> { url }
router.get('/auth-url', requireAuth, wrap(async (req, res) => {
  const redirect = typeof req.query.redirect === 'string' && req.query.redirect.trim() ? req.query.redirect.trim() : undefined;
  const url = shopee().getAuthUrl({ redirect });
  repo.logActivity(req.user, 'shopee_auth_url', null, { transport: shopee().status().transport });
  res.json({ url });
}));

// GET /callback?code&shop_id|main_account_id (tanpa login) -> redirect ke SPA
router.get('/callback', wrap(async (req, res) => {
  const { code, shop_id, main_account_id, error, message } = req.query;
  if (error) {
    log.warn('callback Shopee membawa error', { error, message });
    return res.redirect(302, `/#/settings?error=${encodeURIComponent(String(message || error).slice(0, 200))}`);
  }
  try {
    const shop = await shopee().exchangeCode({ code, shop_id, main_account_id });
    repo.logActivity(req.user, 'shopee_connect', String(shop.shop_id), { via: 'callback', shop_name: shop.shop_name || null, shop_id_list: shop.shop_id_list });
    res.redirect(302, `/#/settings?connected=${encodeURIComponent(String(shop.shop_id))}`);
  } catch (e) {
    log.warn('tukar code gagal', { error: e.code || e.message });
    res.redirect(302, `/#/settings?error=${encodeURIComponent(shortMessage(e))}`);
  }
}));

// POST /connect-manual { callback_url | code, shop_id, main_account_id } -> { shop }
router.post('/connect-manual', requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const fromUrl = b.callback_url ? parseCallbackUrl(b.callback_url) : {};
  const code = b.code || fromUrl.code;
  const shop_id = b.shop_id || fromUrl.shop_id;
  const main_account_id = b.main_account_id || fromUrl.main_account_id;
  if (!code) throw badRequest('Kode otorisasi (code) tidak ditemukan. Tempel URL callback lengkap dari Shopee atau isi code + shop_id.');
  if (!shop_id && !main_account_id) throw badRequest('shop_id atau main_account_id wajib diisi');
  const shop = await shopee().exchangeCode({ code, shop_id, main_account_id });
  repo.logActivity(req.user, 'shopee_connect', String(shop.shop_id), { via: 'manual', shop_name: shop.shop_name || null, shop_id_list: shop.shop_id_list });
  res.json({ shop: shopView(shop) });
}));

// POST /refresh/:shop_id (admin) -> { shop }
router.post('/refresh/:shop_id', requireAdmin, wrap(async (req, res) => {
  const sid = parseShopId(req.params.shop_id);
  if (!repo.getShop(sid)) throw notFound(`Toko ${sid} tidak ditemukan`);
  const shop = await shopee().refreshToken(sid);
  repo.logActivity(req.user, 'shopee_refresh', String(sid));
  res.json({ shop: shopView(shop) });
}));

// POST /disconnect/:shop_id (admin) -> { shop }
router.post('/disconnect/:shop_id', requireAdmin, wrap(async (req, res) => {
  const sid = parseShopId(req.params.shop_id);
  if (!repo.getShop(sid)) throw notFound(`Toko ${sid} tidak ditemukan`);
  const shop = repo.updateShop(sid, { status: 'disconnected', last_error: null });
  repo.logActivity(req.user, 'shopee_disconnect', String(sid));
  res.json({ shop: shopView(shop) });
}));

// POST /test { shop_id? } -> hasil testConnection
router.post('/test', requireAuth, wrap(async (req, res) => {
  const sid = req.body && req.body.shop_id !== undefined && req.body.shop_id !== null && req.body.shop_id !== '' ? parseShopId(req.body.shop_id) : undefined;
  const result = await shopee().testConnection(sid);
  repo.logActivity(req.user, 'shopee_test', String(result.shop_id), { ok: result.ok, latency_ms: result.latency_ms });
  res.json(result);
}));

// GET /warehouses?shop_id -> { shop_id, warehouses (live dari Shopee), mapping (setting warehouses) }
router.get('/warehouses', requireAuth, wrap(async (req, res) => {
  const s = shopee();
  const sid = s.resolveShopId(req.query.shop_id);
  const warehouses = await s.getWarehouses(sid);
  const settings = repo.getSettings();
  res.json({ shop_id: sid, warehouses, mapping: Array.isArray(settings.warehouses) ? settings.warehouses : [] });
}));

// GET /shop-info?shop_id -> { shop_id, shop (baris DB tanpa token), info (live get_shop_info) }
router.get('/shop-info', requireAuth, wrap(async (req, res) => {
  const s = shopee();
  const sid = s.resolveShopId(req.query.shop_id);
  const info = await s.getShopInfo(sid);
  if (info && (info.shop_name || info.region)) {
    repo.updateShop(sid, { shop_name: info.shop_name || undefined, region: info.region || undefined, raw_info: info });
  }
  res.json({ shop_id: sid, shop: shopView(repo.getShop(sid)), info });
}));

module.exports = router;
module.exports.parseCallbackUrl = parseCallbackUrl;
