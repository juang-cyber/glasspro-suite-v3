'use strict';
// /api/orders — daftar & detail order, koreksi manual (overrides), reset, reclassify.
const express = require('express');
const repo = require('../db/repo');
const { requireAdmin } = require('../middleware/auth');
const { badRequest, notFound, conflict, wrap } = require('../util/errors');
const { now: tnow } = require('../util/time');
const log = require('../util/log').make('orders');

const router = express.Router();

const SKU_CATEGORIES = ['tg', 'hg', 'mix'];
const ACTIVE_PROC = new Set(['unprocessed', 'review']);
const OVERRIDE_KEYS = ['sku_category', 'warehouse_code', 'excluded', 'note', 'force_process', 'phone_type'];

// ---------- require lazy modul engine (mungkin belum ada saat dikembangkan paralel) ----------
function isModuleNotFound(e, name) {
  if (!e || e.code !== 'MODULE_NOT_FOUND') return false;
  const m = /Cannot find module '([^']+)'/.exec(String(e.message).split('\n')[0]);
  return !!m && m[1].replace(/\\/g, '/').endsWith(name);
}
function lazy(path, name) {
  try { return require(path); } catch (e) { if (isModuleNotFound(e, name)) return null; throw e; }
}

// Ringkasan sederhana bila engine/preview.toSummary belum tersedia (bentuk sama dengan OrderSummary).
function fallbackSummary(o) {
  if (!o) return null;
  const items = (Array.isArray(o.items) ? o.items : []).map((it) => ({
    item_name: it.item_name ?? null, model_name: it.model_name ?? null, item_sku: it.item_sku ?? null, model_sku: it.model_sku ?? null,
    qty: Number(it.qty) || 0, category: it.category ?? null, phone_type: it.phone_type ?? null, image_url: it.image_url ?? null,
  }));
  const v = o.validation || null;
  let deadline = v && v.flags && v.flags.deadline_hours_left != null ? v.flags.deadline_hours_left : null;
  if (deadline === null && o.ship_by_date) deadline = Math.round(((o.ship_by_date - tnow()) / 3600) * 100) / 100;
  return {
    order_sn: o.order_sn, marketplace: o.marketplace || 'shopee', order_status: o.order_status, proc_status: o.proc_status,
    create_time: o.create_time ?? null, update_time: o.update_time ?? null, ship_by_date: o.ship_by_date ?? null,
    shipping_carrier: o.shipping_carrier || o.checkout_shipping_carrier || null, ship_type: o.ship_type ?? null, sku_category: o.sku_category ?? null,
    warehouse_code: o.warehouse_code ?? null, buyer_username: o.buyer_username ?? null, recipient_name: o.recipient_name ?? null,
    recipient_phone: o.recipient_phone ?? null, recipient_address: o.recipient_address ?? null, note: o.note ?? null,
    message_to_seller: o.message_to_seller ?? null, cod: !!o.cod, total_amount: o.total_amount ?? null, currency: o.currency ?? null,
    items, item_count: items.length, qty_total: items.reduce((a, it) => a + it.qty, 0),
    phone_type: o.phone_type ?? null, validation: v, overrides: o.overrides || {}, pdf_stale: !!o.pdf_stale,
    tracking_number: o.tracking_number ?? null, proc_run_id: o.proc_run_id ?? null, processed_at: o.processed_at ?? null,
    last_error: o.last_error ?? null, deadline_hours_left: deadline,
  };
}

function toSummary(order) {
  const preview = lazy('../engine/preview', 'preview');
  if (preview && typeof preview.toSummary === 'function') {
    try { return preview.toSummary(order); } catch (e) { log.warn(`toSummary gagal untuk ${order && order.order_sn}: ${e.message}`); }
  }
  return fallbackSummary(order);
}

// Order yang sedang ikut run proses aktif (engine/process), kosong bila modul belum ada.
function activeRunOrderSns() {
  const proc = lazy('../engine/process', 'process');
  if (proc && typeof proc.getActiveOrderSns === 'function') {
    try { const s = proc.getActiveOrderSns(); if (s && typeof s.has === 'function') return s; } catch (e) { log.warn(`getActiveOrderSns gagal: ${e.message}`); }
  }
  return new Set();
}

function isInProgress(order) {
  return order.proc_status === 'processing' || activeRunOrderSns().has(order.order_sn);
}

// Klasifikasi + validasi ulang satu order, simpan, dan sesuaikan proc_status review <-> unprocessed.
// Utamakan preview.classifyAndStore (satu sumber semantik dengan reclassifyAll); fallback classify+validate
// bebas konteks (tanpa part / run aktif) — hold khusus part & IN_PROGRESS dihitung saat preview, bukan disimpan.
function reclassifyOne(orderSn, settings) {
  const order = repo.getOrder(orderSn);
  if (!order) throw notFound('Order tidak ditemukan');
  const now = tnow();
  const preview = lazy('../engine/preview', 'preview');
  if (preview && typeof preview.classifyAndStore === 'function') {
    preview.classifyAndStore(order, settings, { now }, repo);
    return repo.getOrder(orderSn);
  }
  const classify = lazy('../engine/classify', 'classify');
  const validate = lazy('../engine/validate', 'validate');
  if (!classify || !validate) {
    log.warn('engine/classify atau engine/validate belum tersedia, klasifikasi ulang dilewati');
    return order;
  }
  const derived = classify.classifyOrder(order, settings) || {};
  const validation = validate.validateOrder(order, derived, settings, { now });
  repo.setOrderDerived(orderSn, { ...derived, validation });
  if (ACTIVE_PROC.has(order.proc_status)) {
    const needsReview = !!(validation && validation.flags && validation.flags.needs_review);
    const target = needsReview ? 'review' : 'unprocessed';
    if (target !== order.proc_status) repo.setOrderProc(orderSn, { proc_status: target });
  }
  return repo.getOrder(orderSn);
}

// ---------- validasi overrides ----------
function validateOverrides(body, settings) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Isi permintaan harus berupa objek');
  const unknown = Object.keys(body).filter((k) => !OVERRIDE_KEYS.includes(k));
  if (unknown.length) throw badRequest(`Field tidak dikenal: ${unknown.join(', ')}`, { unknown });
  const out = {};
  const codes = (Array.isArray(settings.warehouses) ? settings.warehouses : []).map((w) => String(w.code || '').toLowerCase()).filter(Boolean);
  for (const [k, raw] of Object.entries(body)) {
    // null / '' berarti hapus override tersebut (repo.setOverrides menghapus key bernilai null/'')
    if (raw === null || raw === '') { out[k] = null; continue; }
    switch (k) {
      case 'sku_category': {
        const v = String(raw).toLowerCase();
        if (!SKU_CATEGORIES.includes(v)) throw badRequest('Kategori SKU harus tg, hg, atau mix');
        out[k] = v; break;
      }
      case 'warehouse_code': {
        const v = String(raw).toLowerCase();
        if (!codes.includes(v)) throw badRequest(`Kode gudang tidak dikenal (pilihan: ${codes.join(', ') || '-'})`);
        out[k] = v; break;
      }
      case 'excluded':
      case 'force_process':
        if (typeof raw !== 'boolean') throw badRequest(`${k} harus bernilai true/false`);
        out[k] = raw; break;
      case 'note':
        if (typeof raw !== 'string') throw badRequest('Catatan harus berupa teks');
        if (raw.length > 500) throw badRequest('Catatan maksimal 500 karakter');
        out[k] = raw.trim() || null; break;
      case 'phone_type':
        if (typeof raw !== 'string') throw badRequest('Tipe HP harus berupa teks');
        if (raw.length > 100) throw badRequest('Tipe HP maksimal 100 karakter');
        out[k] = raw.trim() || null; break;
      default:
        break;
    }
  }
  if (!Object.keys(out).length) throw badRequest('Tidak ada perubahan yang dikirim');
  return out;
}

function boolParam(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return ['1', 'true', 'yes', 'ya'].includes(String(v).toLowerCase());
}
function listParam(v) {
  if (v === undefined || v === null) return undefined;
  const s = Array.isArray(v) ? v.join(',') : String(v);
  const arr = s.split(',').map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'all');
  return arr.length ? arr : undefined;
}

// ---------- routes ----------
// GET / — daftar order (paging) + counts
router.get('/', wrap(async (req, res) => {
  const q = req.query || {};
  const filter = {
    order_status: listParam(q.order_status),
    proc_status: listParam(q.proc_status),
    warehouse_code: listParam(q.warehouse),
    ship_type: listParam(q.ship_type),
    sku_category: listParam(q.category),
    q: q.q ? String(q.q).trim().slice(0, 100) : undefined,
    page: q.page, limit: q.limit, sort: q.sort, dir: q.dir,
  };
  const stale = boolParam(q.stale);
  if (stale !== undefined) filter.pdf_stale = stale;
  for (const k of Object.keys(filter)) if (filter[k] === undefined || filter[k] === '') delete filter[k];
  const r = repo.listOrders(filter);
  res.json({ items: r.items.map(toSummary), total: r.total, page: r.page, limit: r.limit, counts: repo.countOrders() });
}));

// GET /:sn — detail order + raw Shopee + riwayat run + PDF
router.get('/:sn', wrap(async (req, res) => {
  const order = repo.getOrder(req.params.sn);
  if (!order) throw notFound('Order tidak ditemukan');
  let raw = null;
  try { raw = order.raw_json ? JSON.parse(order.raw_json) : null; } catch { raw = null; }
  res.json({ order: toSummary(order), raw, run_orders: repo.listRunOrdersByOrder(order.order_sn), pdfs: repo.listPdfsForOrder(order.order_sn) });
}));

// PATCH /:sn/overrides — koreksi manual, lalu klasifikasi + validasi ulang order ini
router.patch('/:sn/overrides', wrap(async (req, res) => {
  const sn = req.params.sn;
  const before = repo.getOrder(sn);
  if (!before) throw notFound('Order tidak ditemukan');
  if (isInProgress(before)) throw conflict('Order sedang diproses; tunggu sampai run selesai sebelum mengubah koreksi');
  const settings = repo.getSettings();
  const patch = validateOverrides(req.body, settings);
  repo.setOverrides(sn, patch);
  const order = reclassifyOne(sn, settings);
  repo.logActivity(req.user, 'order_override', sn, { patch, proc_status: order.proc_status });
  res.json({ order: toSummary(order) });
}));

// POST /:sn/reset — (admin) kembalikan ke unprocessed
router.post('/:sn/reset', requireAdmin, wrap(async (req, res) => {
  const sn = req.params.sn;
  const before = repo.getOrder(sn);
  if (!before) throw notFound('Order tidak ditemukan');
  if (isInProgress(before)) throw conflict('Order sedang diproses di run yang masih berjalan; tidak bisa di-reset sekarang');
  repo.setOrderProc(sn, { proc_status: 'unprocessed', proc_run_id: null, processed_at: null, last_error: null, pdf_stale: 0 });
  const order = reclassifyOne(sn, repo.getSettings());
  repo.logActivity(req.user, 'order_reset', sn, { from: before.proc_status, run_id: before.proc_run_id, to: order.proc_status });
  res.json({ order: toSummary(order) });
}));

// POST /:sn/reclassify — klasifikasi + validasi ulang order ini
router.post('/:sn/reclassify', wrap(async (req, res) => {
  const order = reclassifyOne(req.params.sn, repo.getSettings());
  res.json({ order: toSummary(order) });
}));

module.exports = router;
