'use strict';
// Titik masuk modul Shopee (docs/CONTRACTS.md §4 "src/shopee/index.js").
// `create()` mengembalikan singleton yang menggabungkan client (sign + token + transport),
// auth (auth_partner / tukar code / refresh), orders, logistics, dan shop.
// Semua setting (partner id/key/transport/env) dibaca ulang dari repo pada tiap panggilan.
const defaultRepo = require('../db/repo');
const { createClient, ShopeeError } = require('./client');
const { createAuth, MOCK_SHOP_ID } = require('./auth');
const { createOrders } = require('./orders');
const { createLogistics } = require('./logistics');
const { createShop } = require('./shop');
const { hostFor } = require('./sign');
const { now } = require('../util/time');
const log = require('../util/log').make('shopee');

const SHOP_PUBLIC_FIELDS = ['shop_id', 'shop_name', 'region', 'status', 'access_expire_at', 'refresh_expire_at', 'authorized_at', 'last_refresh_at', 'last_error'];

// Baris toko tanpa token (aman dikirim ke UI / log).
function publicShop(row) {
  if (!row) return null;
  const out = {};
  for (const k of SHOP_PUBLIC_FIELDS) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

function createShopee(deps = {}) {
  const repo = deps.repo || defaultRepo;
  const client = createClient({ repo, fetchImpl: deps.fetchImpl, retryDelays: deps.retryDelays });
  const shop = createShop({ client });
  const auth = createAuth({ repo, client, shop });
  const orders = createOrders({ client });
  const logistics = createLogistics({ client });

  // shop_id eksplisit, atau toko utama (yang belum diputus) bila tidak diisi.
  function resolveShopId(shop_id) {
    if (shop_id !== undefined && shop_id !== null && shop_id !== '') {
      const n = Number(shop_id);
      if (!Number.isFinite(n)) throw new ShopeeError('bad_request', 'shop_id harus berupa angka', { status: 400 });
      return n;
    }
    const primary = repo.getPrimaryShop('shopee');
    if (!primary) throw new ShopeeError('not_connected', 'Belum ada toko Shopee yang terhubung', { status: 400 });
    return Number(primary.shop_id);
  }

  // Ringkasan konfigurasi + daftar toko (tanpa token).
  function status() {
    const s = repo.getSettings();
    const transport = s['shopee.transport'] || 'direct';
    const env = s['shopee.env'] || 'live';
    const partner_id = s['shopee.partner_id'] !== undefined && s['shopee.partner_id'] !== null && s['shopee.partner_id'] !== '' ? Number(s['shopee.partner_id']) : null;
    const hasKey = !!s['shopee.partner_key'];
    const configured = transport === 'mock' || (!!partner_id && hasKey);
    const shops = (repo.listShops('shopee') || []).map(publicShop);
    return {
      configured,
      transport,
      env,
      partner_id,
      host: hostFor(env),
      redirect_url: s['shopee.redirect_url'] || '',
      bridge_url: transport === 'bridge' ? s['shopee.bridge_url'] || '' : undefined,
      mock_shop_id: transport === 'mock' ? MOCK_SHOP_ID : undefined,
      shops,
    };
  }

  // Uji koneksi: pastikan token berlaku lalu panggil get_shop_info; simpan nama toko / error terakhir.
  async function testConnection(shop_id) {
    const sid = resolveShopId(shop_id);
    const t0 = Date.now();
    try {
      await client.ensureToken(sid);
      const info = await shop.getShopInfo(sid);
      const latency_ms = Date.now() - t0;
      repo.updateShop(sid, {
        shop_name: info.shop_name || undefined,
        region: info.region || undefined,
        raw_info: info,
        status: 'connected',
        last_error: null,
      });
      return { ok: true, shop_id: sid, shop_name: info.shop_name || null, region: info.region || null, shop_status: info.status || null, latency_ms, transport: client.readConfig().transport };
    } catch (e) {
      const msg = `${e.code ? `${e.code}: ` : ''}${e.message || 'Kesalahan tidak diketahui'}`.slice(0, 300);
      try { if (repo.getShop(sid)) repo.updateShop(sid, { last_error: msg }); } catch (e2) { log.warn('gagal menyimpan last_error', e2.message); }
      throw e;
    }
  }

  return {
    // auth
    getAuthUrl: auth.getAuthUrl,
    exchangeCode: auth.exchangeCode,
    refreshToken: client.refreshToken,
    ensureToken: client.ensureToken,
    // low-level
    call: client.call,
    readConfig: client.readConfig,
    // shop
    // async agar kesalahan resolveShopId (belum ada toko) selalu berupa promise yang ditolak, bukan throw sinkron
    getShopInfo: async (shop_id) => shop.getShopInfo(resolveShopId(shop_id)),
    getWarehouses: async (shop_id) => shop.getWarehouses(resolveShopId(shop_id)),
    // orders
    fetchOrders: orders.fetchOrders,
    fetchOrderDetails: orders.fetchOrderDetails,
    // logistics
    getShippingParameter: logistics.getShippingParameter,
    shipOrder: logistics.shipOrder,
    getTrackingNumber: logistics.getTrackingNumber,
    createShippingDocument: logistics.createShippingDocument,
    getShippingDocumentResult: logistics.getShippingDocumentResult,
    downloadShippingDocument: logistics.downloadShippingDocument,
    getShippingDocumentParameter: logistics.getShippingDocumentParameter,
    arrangeShipment: logistics.arrangeShipment,
    // util
    testConnection,
    status,
    resolveShopId,
    publicShop,
    ShopeeError,
    MOCK_SHOP_ID,
  };
}

let singleton = null;

// Singleton (deps kosong) — instance terpisah hanya bila deps diberikan (mis. untuk test dengan repo/fetch palsu).
function create(deps) {
  if (deps && Object.keys(deps).length) return createShopee(deps);
  if (!singleton) singleton = createShopee();
  return singleton;
}

module.exports = { create, createShopee, publicShop, ShopeeError, MOCK_SHOP_ID, now };
