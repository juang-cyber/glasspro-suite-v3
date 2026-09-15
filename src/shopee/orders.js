'use strict';
// Pengambilan order Shopee: get_order_list (paging cursor, rentang 15 hari) + get_order_detail (batch 50)
// lalu normalisasi ke bentuk OrderRow (docs/CONTRACTS.md §3).
const { ShopeeError } = require('./client');
const { now } = require('../util/time');
const log = require('../util/log').make('shopee:orders');

const DAY = 86400;
const MAX_WINDOW_SEC = 15 * DAY;
const LIST_PAGE_SIZE = 100;
const DETAIL_BATCH = 50;
// Hanya nilai yang tercantum resmi di dokumentasi get_order_detail (response_optional_fields "Available values").
// checkout_shipping_carrier / reverse_shipping_fee TIDAK ada di daftar itu -> jangan diminta (risiko error_param);
// keduanya tetap dibaca dari respons bila Shopee mengembalikannya bersama shipping_carrier.
const DETAIL_FIELDS = [
  'buyer_user_id', 'buyer_username', 'estimated_shipping_fee', 'recipient_address', 'actual_shipping_fee', 'goods_to_declare', 'note', 'note_update_time',
  'item_list', 'pay_time', 'dropshipper', 'dropshipper_phone', 'split_up', 'buyer_cancel_reason', 'cancel_by', 'cancel_reason', 'actual_shipping_fee_confirmed',
  'buyer_cpf_id', 'fulfillment_flag', 'pickup_done_time', 'package_list', 'shipping_carrier', 'payment_method', 'total_amount', 'invoice_data',
  'order_chargeable_weight_gram', 'edt',
].join(',');

const num = (v, def = null) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const ts = (v) => { const n = num(v, null); return n && n > 0 ? Math.floor(n) : null; };
const strOrNull = (v) => { const s = v === undefined || v === null ? '' : String(v).trim(); return s ? s : null; };

// product_location_id di item order bisa string atau array of string; di package selalu string.
function firstLocation(v) {
  if (Array.isArray(v)) { const f = v.find((x) => x !== undefined && x !== null && String(x).trim() !== ''); return f === undefined ? null : String(f); }
  return strOrNull(v);
}

// Gabungkan komponen alamat tanpa duplikasi (full_address biasanya sudah memuat kota/kodepos).
function joinAddress(ra) {
  if (!ra || typeof ra !== 'object') return null;
  const parts = [ra.full_address, ra.town, ra.district, ra.city, ra.state, ra.zipcode];
  let acc = '';
  for (const p of parts) {
    const s = strOrNull(p);
    if (!s) continue;
    if (acc.toLowerCase().includes(s.toLowerCase())) continue;
    acc = acc ? `${acc}, ${s}` : s;
  }
  return acc || null;
}

// Normalisasi satu detail order Shopee -> OrderRow.
function normalizeOrder(detail, shop_id) {
  if (!detail || !detail.order_sn) throw new ShopeeError('invalid_response', 'Detail order tanpa order_sn');
  const packages = (Array.isArray(detail.package_list) ? detail.package_list : []).map((p) => ({
    package_number: strOrNull(p.package_number),
    logistics_status: strOrNull(p.logistics_status),
    shipping_carrier: strOrNull(p.shipping_carrier),
    item_list: Array.isArray(p.item_list) ? p.item_list : [],
  }));
  // peta lokasi dari package (fallback bila item order tidak punya product_location_id)
  const pkgLoc = new Map();
  for (const p of packages) {
    for (const it of p.item_list) {
      const loc = firstLocation(it.product_location_id);
      if (loc) pkgLoc.set(`${it.item_id}|${it.model_id ?? 0}`, loc);
    }
  }
  const items = (Array.isArray(detail.item_list) ? detail.item_list : []).map((it) => ({
    item_id: num(it.item_id, null),
    item_name: strOrNull(it.item_name) || '',
    item_sku: strOrNull(it.item_sku) || '',
    model_id: num(it.model_id, 0),
    model_name: strOrNull(it.model_name) || '',
    model_sku: strOrNull(it.model_sku) || '',
    qty: num(it.model_quantity_purchased, 1),
    price: num(it.model_discounted_price, num(it.model_original_price, 0)),
    product_location_id: firstLocation(it.product_location_id) || pkgLoc.get(`${it.item_id}|${it.model_id ?? 0}`) || null,
    order_item_id: num(it.order_item_id, num(it.item_id, null)),
    image_url: it.image_info && it.image_info.image_url ? String(it.image_info.image_url) : null,
  }));
  const ra = detail.recipient_address || {};
  const firstPkg = packages[0] || null;
  const trackingFromPkg = Array.isArray(detail.package_list) && detail.package_list[0] ? strOrNull(detail.package_list[0].tracking_number) : null;
  return {
    order_sn: String(detail.order_sn),
    shop_id: num(shop_id, null),
    marketplace: 'shopee',
    order_status: strOrNull(detail.order_status) || 'UNKNOWN',
    create_time: ts(detail.create_time),
    update_time: ts(detail.update_time),
    pay_time: ts(detail.pay_time),
    ship_by_date: ts(detail.ship_by_date),
    days_to_ship: num(detail.days_to_ship, null),
    shipping_carrier: strOrNull(detail.shipping_carrier),
    checkout_shipping_carrier: strOrNull(detail.checkout_shipping_carrier),
    buyer_username: strOrNull(detail.buyer_username),
    recipient_name: strOrNull(ra.name),
    recipient_phone: strOrNull(ra.phone),
    recipient_address: joinAddress(ra),
    note: strOrNull(detail.note),
    message_to_seller: strOrNull(detail.message_to_seller),
    cod: !!detail.cod,
    total_amount: num(detail.total_amount, null),
    currency: strOrNull(detail.currency),
    items,
    packages,
    tracking_number: trackingFromPkg,
    package_number: firstPkg ? firstPkg.package_number : null,
    raw: detail,
  };
}

function createOrders({ client }) {
  if (!client) throw new Error('createOrders butuh client');

  const report = (onProgress, info) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(info); } catch (e) { log.warn('onProgress error', e.message); }
  };

  // Kumpulkan order_sn unik dari get_order_list (per jendela 15 hari, per status, paging cursor).
  async function listOrderSns({ shop_id, statuses, time_from, time_to, time_range_field = 'create_time', onProgress } = {}) {
    const to = num(time_to, now());
    const from = num(time_from, to - 7 * DAY);
    if (from >= to) throw new ShopeeError('bad_request', 'time_from harus lebih kecil dari time_to', { status: 400 });
    const field = time_range_field === 'update_time' ? 'update_time' : 'create_time';
    const statusList = Array.isArray(statuses) && statuses.length ? statuses.filter(Boolean) : [null];
    const seen = new Map(); // order_sn -> order_status dari list (bisa undefined)
    for (let wFrom = from; wFrom < to; wFrom += MAX_WINDOW_SEC) {
      const wTo = Math.min(wFrom + MAX_WINDOW_SEC - 1, to);
      for (const status of statusList) {
        let cursor = '';
        let page = 0;
        for (;;) {
          const query = { time_range_field: field, time_from: wFrom, time_to: wTo, page_size: LIST_PAGE_SIZE, response_optional_fields: 'order_status' };
          if (status) query.order_status = status;
          if (cursor) query.cursor = cursor;
          const json = await client.call({ path: '/api/v2/order/get_order_list', method: 'GET', query, shop_id });
          const resp = json.response || {};
          const list = Array.isArray(resp.order_list) ? resp.order_list : [];
          for (const o of list) if (o && o.order_sn) seen.set(String(o.order_sn), o.order_status);
          page++;
          report(onProgress, { stage: 'list', status, window: { from: wFrom, to: wTo }, page, listed: seen.size });
          if (resp.more && resp.next_cursor) cursor = String(resp.next_cursor);
          else break;
          if (page > 1000) { log.warn('paging get_order_list melebihi 1000 halaman, dihentikan'); break; }
        }
      }
    }
    return seen;
  }

  // Ambil detail (batch 50) dan normalisasi.
  async function fetchOrderDetails({ shop_id, order_sns, onProgress } = {}) {
    const sns = [...new Set((order_sns || []).map((s) => String(s || '').trim()).filter(Boolean))];
    const out = [];
    for (let i = 0; i < sns.length; i += DETAIL_BATCH) {
      const batch = sns.slice(i, i + DETAIL_BATCH);
      const json = await client.call({
        path: '/api/v2/order/get_order_detail', method: 'GET', shop_id,
        query: { order_sn_list: batch.join(','), response_optional_fields: DETAIL_FIELDS },
      });
      const list = json.response && Array.isArray(json.response.order_list) ? json.response.order_list : [];
      for (const d of list) {
        try { out.push(normalizeOrder(d, shop_id)); } catch (e) { log.warn('order dilewati', { order_sn: d && d.order_sn, error: e.message }); }
      }
      if (Array.isArray(json.warning) && json.warning.length) log.warn('warning get_order_detail', json.warning.slice(0, 3));
      report(onProgress, { stage: 'detail', done: Math.min(i + DETAIL_BATCH, sns.length), total: sns.length });
    }
    return out;
  }

  async function fetchOrders(opts = {}) {
    if (opts.shop_id === undefined || opts.shop_id === null) throw new ShopeeError('shop_required', 'shop_id wajib diisi', { status: 400 });
    const seen = await listOrderSns(opts);
    const sns = [...seen.keys()];
    log.info('daftar order', { shop_id: opts.shop_id, count: sns.length, statuses: opts.statuses || null });
    return fetchOrderDetails({ shop_id: opts.shop_id, order_sns: sns, onProgress: opts.onProgress });
  }

  return { fetchOrders, fetchOrderDetails, listOrderSns, normalizeOrder };
}

module.exports = { createOrders, normalizeOrder, joinAddress, firstLocation, DETAIL_FIELDS, MAX_WINDOW_SEC };
