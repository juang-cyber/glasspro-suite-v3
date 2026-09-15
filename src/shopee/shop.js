'use strict';
// Info toko dan daftar gudang Shopee.
const log = require('../util/log').make('shopee:shop');

const ENVELOPE_KEYS = new Set(['error', 'message', 'request_id', 'warning']);

function createShop({ client }) {
  if (!client) throw new Error('createShop butuh client');

  // get_shop_info mengembalikan data di top-level (tanpa `response`); tangani keduanya.
  async function getShopInfo(shop_id) {
    const json = await client.call({ path: '/api/v2/shop/get_shop_info', method: 'GET', shop_id });
    const src = json.response && typeof json.response === 'object' && json.response.shop_name !== undefined ? json.response : json;
    const out = {};
    for (const [k, v] of Object.entries(src)) if (!ENVELOPE_KEYS.has(k)) out[k] = v;
    return out;
  }

  // get_warehouse_detail: response berupa array langsung atau {warehouse_list}. Toko yang bukan multi-gudang -> [].
  async function getWarehouses(shop_id) {
    let json;
    try {
      json = await client.call({ path: '/api/v2/shop/get_warehouse_detail', method: 'GET', shop_id });
    } catch (e) {
      const code = String(e.code || '');
      if (/warehouse/i.test(code) || code.endsWith('error_param') || /whitelist|multi-warehouse|multi warehouse/i.test(String(e.message || ''))) {
        log.info('toko bukan multi-gudang', { shop_id, error: code });
        return [];
      }
      throw e;
    }
    const r = json.response;
    let list = [];
    if (Array.isArray(r)) list = r;
    else if (r && Array.isArray(r.warehouse_list)) list = r.warehouse_list;
    else if (r && Array.isArray(r.list)) list = r.list;
    return list.filter((w) => w && typeof w === 'object').map((w) => ({
      warehouse_id: w.warehouse_id ?? null,
      warehouse_name: w.warehouse_name || '',
      warehouse_type: w.warehouse_type ?? null,
      location_id: w.location_id !== undefined && w.location_id !== null ? String(w.location_id) : '',
      address_id: w.address_id ?? null,
      region: w.region || null,
      state: w.state || null,
      city: w.city || null,
      district: w.district || null,
      town: w.town || null,
      address: w.address || null,
      zipcode: w.zipcode || null,
      holiday_mode_state: w.holiday_mode_state ?? null,
    }));
  }

  return { getShopInfo, getWarehouses };
}

module.exports = { createShop };
