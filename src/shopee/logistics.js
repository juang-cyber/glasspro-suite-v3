'use strict';
// Logistik Shopee: parameter pengiriman, arrange shipment (pickup/dropoff), resi, dokumen AWB.
// Bentuk request/respons diverifikasi dari SDK open-source (congminh1254/shopee-sdk, passwind/go-shopee-v2).
const { ShopeeError } = require('./client');
const { now, startOfDay } = require('../util/time');
const log = require('../util/log').make('shopee:logistics');

const MAX_DOC_BATCH = 50;

const asList = (v) => (Array.isArray(v) ? v : []);

// Urutkan alamat pickup: pickup_address_id gudang -> flag pickup_address -> default_address -> sisanya.
function orderAddresses(list, warehouse) {
  const rest = [...list];
  const picked = [];
  const take = (pred) => {
    const idx = rest.findIndex(pred);
    if (idx >= 0) picked.push(rest.splice(idx, 1)[0]);
  };
  const wantId = warehouse && warehouse.pickup_address_id !== undefined && warehouse.pickup_address_id !== null && warehouse.pickup_address_id !== '' ? Number(warehouse.pickup_address_id) : null;
  if (wantId) take((a) => Number(a.address_id) === wantId);
  take((a) => asList(a.address_flag).includes('pickup_address'));
  take((a) => asList(a.address_flag).includes('default_address'));
  return [...picked, ...rest];
}

// Pilih time slot: slot berflag "recommended" (saran Shopee) didahulukan; selain itu slot pertama yang
// tanggalnya >= hari ini (WIB) jika ada field date, atau slot pertama.
function chooseSlot(slots, nowTs = now()) {
  const list = asList(slots).filter((s) => s && s.pickup_time_id !== undefined && s.pickup_time_id !== null && s.pickup_time_id !== '');
  if (!list.length) return null;
  const usable = list.filter((s) => !s.error);
  const pool = usable.length ? usable : list;
  const recommended = pool.find((s) => asList(s.flags).includes('recommended'));
  if (recommended) return recommended;
  const hasDate = pool.some((s) => Number.isFinite(Number(s.date)) && Number(s.date) > 0);
  if (hasDate) {
    const today = startOfDay(nowTs);
    const future = pool.find((s) => Number(s.date) >= today);
    if (future) return future;
  }
  return pool[0];
}

// Tentukan metode berdasarkan preferensi setting dan yang tersedia di info_needed.
function pickMethod(info_needed, pref) {
  const avail = Object.keys(info_needed || {}).filter((k) => Array.isArray(info_needed[k]));
  const has = (m) => avail.includes(m);
  const p = String(pref || 'auto').toLowerCase();
  if (p === 'pickup' && has('pickup')) return 'pickup';
  if (p === 'dropoff' && has('dropoff')) return 'dropoff';
  if (has('pickup')) return 'pickup';
  if (has('dropoff')) return 'dropoff';
  if (has('non_integrated')) throw new ShopeeError('non_integrated', 'Kurir order ini non-integrated (resi manual), tidak bisa diproses otomatis', { status: 400 });
  throw new ShopeeError('no_shipping_method', 'Shopee tidak memberikan metode pengiriman untuk order ini', { status: 400 });
}

// Bangun objek pickup untuk ship_order. Alamat dipilih sesuai prioritas (gudang -> pickup_address -> default).
// Dokumentasi Shopee: "Some logistics channels may not return any date or time for pickup time slots. In such
// cases, sellers can arrange shipment without selecting any time slot" -> bila alamat prioritas tidak punya slot,
// kirim address_id saja (jangan pindah ke alamat/gudang lain hanya karena alamat itu punya slot).
function buildPickup(params, info, warehouse) {
  const need = asList(info);
  if (need.includes('tracking_number') || need.includes('tracking_no')) {
    throw new ShopeeError('unsupported_pickup', 'Pickup kurir ini butuh nomor resi manual (tracking_number), tidak bisa diproses otomatis', { status: 400 });
  }
  const list = asList(params.pickup && params.pickup.address_list).filter((a) => a && a.address_id !== undefined && a.address_id !== null);
  if (!list.length) throw new ShopeeError('no_pickup_address', 'Tidak ada alamat pickup di akun Shopee', { status: 400 });
  const addr = orderAddresses(list, warehouse)[0];
  if (!need.includes('pickup_time_id')) return { address_id: addr.address_id };
  const slot = chooseSlot(addr.time_slot_list);
  return slot ? { address_id: addr.address_id, pickup_time_id: slot.pickup_time_id } : { address_id: addr.address_id };
}

// Bangun objek dropoff untuk ship_order. info_needed.dropoff bisa memuat 'branch_id', 'sender_real_name',
// 'tracking_no' (dokumentasi resmi; SDK memakai 'tracking_number'), dan 'slug' (TW). Untuk kurir 80003/80004
// Shopee menawarkan JOB (sender_real_name) ATAU Regular (tracking_no) - hanya salah satu; kita pilih JOB karena
// nomor resi manual tidak tersedia di aplikasi ini.
function buildDropoff(params, info, settings) {
  const need = asList(info);
  const d = {};
  if (need.includes('branch_id')) {
    const branch = asList(params.dropoff && params.dropoff.branch_list)[0];
    if (!branch || branch.branch_id === undefined || branch.branch_id === null) throw new ShopeeError('no_dropoff_branch', 'Shopee tidak memberikan daftar cabang drop-off', { status: 400 });
    d.branch_id = branch.branch_id;
  }
  if (need.includes('slug')) {
    const slug = asList(params.dropoff && params.dropoff.slug_list)[0];
    if (!slug || !slug.slug) throw new ShopeeError('unsupported_dropoff', 'Drop-off kurir ini butuh pilihan mitra 3PL (slug) yang tidak tersedia', { status: 400 });
    d.slug = slug.slug;
  }
  if (need.includes('sender_real_name')) {
    d.sender_real_name = (settings && settings.process && settings.process.sender_real_name) || 'Glass Pro';
  } else if (need.includes('tracking_number') || need.includes('tracking_no')) {
    throw new ShopeeError('unsupported_dropoff', 'Drop-off kurir ini butuh nomor resi manual', { status: 400 });
  }
  return d;
}

function createLogistics({ client }) {
  if (!client) throw new Error('createLogistics butuh client');

  async function getShippingParameter({ shop_id, order_sn, package_number } = {}) {
    if (!order_sn) throw new ShopeeError('bad_request', 'order_sn wajib diisi', { status: 400 });
    const query = { order_sn };
    if (package_number) query.package_number = package_number;
    const json = await client.call({ path: '/api/v2/logistics/get_shipping_parameter', method: 'GET', query, shop_id });
    return json.response || {};
  }

  async function shipOrder({ shop_id, order_sn, package_number, pickup, dropoff, non_integrated } = {}) {
    if (!order_sn) throw new ShopeeError('bad_request', 'order_sn wajib diisi', { status: 400 });
    const body = { order_sn };
    if (package_number) body.package_number = package_number;
    if (pickup) body.pickup = pickup;
    if (dropoff) body.dropoff = dropoff;
    if (non_integrated) body.non_integrated = non_integrated;
    const json = await client.call({ path: '/api/v2/logistics/ship_order', method: 'POST', body, shop_id });
    return json.response || {};
  }

  async function getTrackingNumber({ shop_id, order_sn, package_number } = {}) {
    if (!order_sn) throw new ShopeeError('bad_request', 'order_sn wajib diisi', { status: 400 });
    const query = { order_sn };
    if (package_number) query.package_number = package_number;
    const json = await client.call({ path: '/api/v2/logistics/get_tracking_number', method: 'GET', query, shop_id });
    const tn = json.response && json.response.tracking_number;
    return tn ? String(tn) : null;
  }

  function checkList(order_list) {
    if (!Array.isArray(order_list) || !order_list.length) throw new ShopeeError('bad_request', 'order_list wajib berisi minimal 1 order', { status: 400 });
    if (order_list.length > MAX_DOC_BATCH) throw new ShopeeError('bad_request', `order_list maksimal ${MAX_DOC_BATCH} order per panggilan`, { status: 400 });
  }

  async function createShippingDocument({ shop_id, order_list } = {}) {
    checkList(order_list);
    const json = await client.call({ path: '/api/v2/logistics/create_shipping_document', method: 'POST', body: { order_list }, shop_id });
    return json.response || { result_list: [] };
  }

  async function getShippingDocumentResult({ shop_id, order_list } = {}) {
    checkList(order_list);
    const json = await client.call({ path: '/api/v2/logistics/get_shipping_document_result', method: 'POST', body: { order_list }, shop_id });
    return json.response || { result_list: [] };
  }

  async function downloadShippingDocument({ shop_id, shipping_document_type, order_list } = {}) {
    checkList(order_list);
    const body = { order_list };
    if (shipping_document_type) body.shipping_document_type = shipping_document_type;
    const buf = await client.call({ path: '/api/v2/logistics/download_shipping_document', method: 'POST', body, shop_id, binary: true });
    if (!Buffer.isBuffer(buf) || !buf.length) throw new ShopeeError('empty_document', 'Shopee mengembalikan dokumen kosong');
    // Waybill Shopee selalu PDF; HTML/teks (mis. halaman error gateway) jangan diteruskan ke penggabung PDF.
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new ShopeeError('invalid_document', 'Berkas dari Shopee bukan PDF', { details: { snippet: buf.subarray(0, 120).toString('utf8') } });
    }
    return buf;
  }

  async function getShippingDocumentParameter({ shop_id, order_list } = {}) {
    checkList(order_list);
    const json = await client.call({ path: '/api/v2/logistics/get_shipping_document_parameter', method: 'POST', body: { order_list }, shop_id });
    return json.response || { result_list: [] };
  }

  // Alur tingkat tinggi: get_shipping_parameter -> pilih pickup/dropoff sesuai process.delivery_method -> ship_order.
  async function arrangeShipment({ shop_id, order_sn, package_number, warehouse, settings } = {}) {
    const params = await getShippingParameter({ shop_id, order_sn, package_number });
    const info_needed = params.info_needed || {};
    const pref = settings && settings.process ? settings.process.delivery_method : 'auto';
    const method = pickMethod(info_needed, pref);
    const detail = { address_id: null, pickup_time_id: null, branch_id: null };
    const req = { shop_id, order_sn, package_number };
    if (method === 'pickup') {
      req.pickup = buildPickup(params, info_needed.pickup, warehouse);
      detail.address_id = req.pickup.address_id;
      detail.pickup_time_id = req.pickup.pickup_time_id ?? null;
    } else {
      req.dropoff = buildDropoff(params, info_needed.dropoff, settings);
      detail.branch_id = req.dropoff.branch_id ?? null;
    }
    await shipOrder(req);
    log.info('shipment diatur', { order_sn, method, address_id: detail.address_id, branch_id: detail.branch_id });
    return { method, detail };
  }

  return { getShippingParameter, shipOrder, getTrackingNumber, createShippingDocument, getShippingDocumentResult, downloadShippingDocument, getShippingDocumentParameter, arrangeShipment };
}

module.exports = { createLogistics, pickMethod, chooseSlot, orderAddresses, buildPickup, buildDropoff, MAX_DOC_BATCH };
