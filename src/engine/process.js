'use strict';
// Pipeline proses order: arrange shipment -> dokumen AWB -> unduh label -> gabung PDF per grup -> catat riwayat.
// Progress disimpan di memori (Map) + tabel run_orders. Modul lain (repo/preview/pdf/shopee) di-require
// secara lazy atau diterima lewat ctx supaya modul ini bisa di-require dan di-test sendiri.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const time = require('../util/time');
const { badRequest, notFound, conflict, httpError } = require('../util/errors');
const log = require('../util/log').make('process');

const runs = new Map(); // run_id -> state (lihat newState)
const MAX_KEPT_RUNS = 30; // jumlah run selesai yang disimpan di memori
const FINAL_STATUSES = new Set(['ok', 'failed', 'skipped']);
const CANCELLED_STATUSES = new Set(['CANCELLED', 'IN_CANCEL']);
// Batas waktu per panggilan Shopee (pengaman pool: client sendiri punya timeout 60 dtk; ini lapis kedua).
const CALL_TIMEOUT_MS = 120 * 1000;
const DROPPED_REASON = 'Order dibatalkan di marketplace; tidak dimasukkan ke PDF';
let orphansChecked = false;

// ---------- util ----------
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

// Bungkus promise dengan batas waktu supaya satu panggilan yang menggantung tidak memacetkan pool.
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return Promise.resolve(promise);
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'Panggilan Shopee'} tidak merespons dalam ${Math.round(ms / 1000)} detik`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

// Error dari ship_order yang berarti "shipment sudah diatur" (mis. staf sudah arrange di Seller Centre).
function isAlreadyArrangedError(e) {
  const text = `${(e && e.code) || ''} ${(e && e.message) || ''}`.toLowerCase();
  return /status_limit|order_status|already|has been shipped|sudah diatur|bukan ready_to_ship|not ready_to_ship/.test(text);
}

function lazyRequire(p, label) {
  try {
    return require(p);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.basename(p))) {
      throw httpError(503, 'module_missing', `Modul ${label || p} belum tersedia di server`);
    }
    throw e;
  }
}

function resolveDeps(ctx = {}) {
  const repo = ctx.repo || require('../db/repo');
  const settings = ctx.settings || repo.getSettings();
  const nowFn = typeof ctx.now === 'function' ? ctx.now : () => (typeof ctx.now === 'number' ? ctx.now : time.now());
  return {
    repo,
    settings,
    now: nowFn,
    pdf: ctx.pdf || require('./pdf'),
    preview: () => ctx.preview || lazyRequire('./preview', 'preview'),
    shopee: () => ctx.shopee || lazyRequire('../shopee', 'shopee').create(),
    sleep: ctx.sleep || sleepDefault,
    pollMs: Number.isFinite(ctx.poll_ms) ? ctx.poll_ms : 2000,
    callTimeoutMs: Number.isFinite(ctx.call_timeout_ms) ? ctx.call_timeout_ms : CALL_TIMEOUT_MS,
  };
}

function shortError(e) {
  if (!e) return 'Kesalahan tidak diketahui';
  let msg = e.message ? String(e.message) : String(e);
  msg = msg.split('\n')[0];
  if (e.code && typeof e.code === 'string' && !msg.startsWith(e.code)) msg = `${e.code}: ${msg}`;
  if (e.request_id) msg += ` (req ${e.request_id})`;
  return msg.slice(0, 300);
}

function toBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  if (v && v.base64) return Buffer.from(v.base64, 'base64');
  if (v && v.data && (Buffer.isBuffer(v.data) || v.data instanceof Uint8Array)) return toBuffer(v.data);
  return null;
}

function groupKey({ ship_type, sku_category, warehouse_code }) {
  try {
    const naming = require('./naming');
    if (naming && typeof naming.groupKey === 'function') return naming.groupKey({ ship_type, sku_category, warehouse_code });
  } catch (e) { if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e; }
  return `${ship_type}-${sku_category}-${warehouse_code}`;
}

// Nama file sesuai kontrak: DDMMYYYY-p1-ins-tg-jkt.pdf / DDMMYYYY-p1-productlist-jkt.pdf (pakai engine/naming bila ada).
function pdfFileName({ ts, part, ship_type, sku_category, warehouse_code, kind }) {
  try {
    const naming = require('./naming');
    if (naming && typeof naming.pdfFileName === 'function') {
      const n = naming.pdfFileName({ ts, part, ship_type, sku_category, warehouse_code, kind });
      if (n) return n;
    }
  } catch (e) { if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e; }
  const d = time.ddmmyyyy(ts);
  if (kind === 'productlist') return `${d}-${part}-productlist-${warehouse_code || 'all'}.pdf`;
  return `${d}-${part}-${ship_type === 'instant' ? 'ins' : 'reg'}-${sku_category || 'mix'}-${warehouse_code || 'all'}.pdf`;
}

// Part otomatis (fallback bila preview tidak mengembalikan part konkret).
function resolveAutoPart(settings, ts) {
  const parts = (settings && settings.parts) || {};
  const mins = time.minutesOfDay(ts);
  const p2 = time.parseHHMM(parts.p2 && parts.p2.start) ?? 13 * 60;
  const p3 = time.parseHHMM(parts.p3 && parts.p3.start) ?? 15 * 60;
  if (mins < p2) return 'p1';
  if (mins < p3) return 'p2';
  return 'p3';
}

function warehouseName(settings, code) {
  if (code === 'all') return 'Semua Gudang';
  const w = ((settings && settings.warehouses) || []).find((x) => x && x.code === code);
  return w ? w.name : code || '-';
}

function warehouseSetting(settings, code) {
  return ((settings && settings.warehouses) || []).find((x) => x && x.code === code) || null;
}

function pickPackage(order) {
  if (!order) return null;
  if (order.package_number) return order.package_number;
  const pk = Array.isArray(order.packages) ? order.packages.find((p) => p && p.package_number) : null;
  return pk ? pk.package_number : null;
}

function firstResult(resp, orderSn) {
  if (!resp) return null;
  const list = Array.isArray(resp.result_list) ? resp.result_list : Array.isArray(resp.response && resp.response.result_list) ? resp.response.result_list : null;
  if (list && list.length) return list.find((r) => r && r.order_sn === orderSn) || list[0];
  if (Array.isArray(resp)) return resp.find((r) => r && r.order_sn === orderSn) || resp[0] || null;
  return resp;
}

// Ringkasan order minimal bila engine/preview.toSummary belum tersedia.
function fallbackSummary(order) {
  if (!order) return null;
  const items = (order.items || []).map((it) => ({
    item_name: it.item_name || null, model_name: it.model_name || null, item_sku: it.item_sku || null, model_sku: it.model_sku || null,
    qty: Number(it.qty) || 0, category: it.category || null, phone_type: it.phone_type || null, image_url: it.image_url || null,
  }));
  const flags = (order.validation && order.validation.flags) || {};
  return {
    order_sn: order.order_sn, marketplace: order.marketplace || 'shopee', order_status: order.order_status, proc_status: order.proc_status,
    create_time: order.create_time, update_time: order.update_time, ship_by_date: order.ship_by_date, shipping_carrier: order.shipping_carrier,
    ship_type: order.ship_type, sku_category: order.sku_category, warehouse_code: order.warehouse_code, buyer_username: order.buyer_username,
    recipient_name: order.recipient_name, recipient_phone: order.recipient_phone, recipient_address: order.recipient_address, note: order.note,
    message_to_seller: order.message_to_seller, cod: !!order.cod, total_amount: order.total_amount, currency: order.currency,
    items, item_count: items.length, qty_total: items.reduce((s, i) => s + (i.qty || 0), 0),
    phone_type: order.phone_type || null, validation: order.validation || null, overrides: order.overrides || {}, pdf_stale: !!order.pdf_stale,
    tracking_number: order.tracking_number || null, proc_run_id: order.proc_run_id || null, processed_at: order.processed_at || null,
    last_error: order.last_error || null, deadline_hours_left: flags.deadline_hours_left === undefined ? null : flags.deadline_hours_left,
  };
}

function toSummarySafe(order, ctx = {}) {
  if (!order) return null;
  try {
    const pv = ctx.preview || require('./preview');
    if (pv && typeof pv.toSummary === 'function') return pv.toSummary(order);
  } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND')) log.warn('toSummary gagal, pakai ringkasan sederhana:', shortError(e));
  }
  return fallbackSummary(order);
}

// ---------- state di memori ----------
function newState({ run, kind, part, warehouse, user, note, settings, source_run_id }) {
  return {
    run_id: run.id, kind, source_run_id: source_run_id || null, part, warehouse, user: user || null, note: note || null, settings,
    status: 'running', stage: 'shipping', done: 0, total: 0, current: null, errors: [], pdfs: [],
    finished: false, started_at: run.started_at, finished_at: null, summary: null, cancel: false,
    orders: new Map(), groups: new Map(),
    // regenerate: product list yang dipilih eksplisit untuk dibangun ulang; auto_productlists=false berarti
    // product list TIDAK dibangun otomatis dari order sukses (hanya PDF yang dipilih).
    productlist_rebuild: [], supersede_productlists: false, auto_productlists: true, merge_mode: false,
    dropped: [], // order yang tidak ikut karena sudah batal (regenerate) -> {order_sn, reason}
  };
}

function snapshot(st) {
  const active = [];
  for (const o of st.orders.values()) if (!FINAL_STATUSES.has(o.status) && o.status !== 'merged' && o.stage !== 'queued') active.push({ order_sn: o.order_sn, stage: o.stage });
  return {
    run_id: st.run_id, kind: st.kind, source_run_id: st.source_run_id, status: st.status, stage: st.stage, done: st.done, total: st.total,
    current: st.current, active, errors: st.errors.slice(), pdfs: st.pdfs.slice(), finished: st.finished,
    started_at: st.started_at, finished_at: st.finished_at, summary: st.summary, cancel_requested: st.cancel, part: st.part, warehouse: st.warehouse,
    dropped: st.dropped.slice(),
  };
}

function pruneRuns() {
  const finished = [...runs.values()].filter((s) => s.finished).sort((a, b) => (a.finished_at || 0) - (b.finished_at || 0));
  while (finished.length > MAX_KEPT_RUNS) runs.delete(finished.shift().run_id);
}

function findActive(kind) {
  for (const st of runs.values()) if (!st.finished && (!kind || st.kind === kind)) return st;
  return null;
}

// Run yang tercatat 'running' di DB tetapi tidak ada di memori (server pernah mati) -> tandai gagal.
function recoverOrphans(repo) {
  let rows = [];
  try { rows = repo.listRuns({ status: 'running', limit: 200 }).items || []; } catch (e) { log.warn('recoverOrphans gagal:', shortError(e)); return 0; }
  let n = 0;
  for (const run of rows) {
    if (runs.has(run.id)) continue;
    const reason = 'Proses terputus (server dimulai ulang)';
    try {
      for (const ro of repo.listRunOrders(run.id)) {
        if (FINAL_STATUSES.has(ro.status)) continue;
        repo.upsertRunOrder(run.id, ro.order_sn, { status: 'failed', error: reason });
      }
      for (const o of repo.allOrders({ proc_status: 'processing', proc_run_id: run.id })) repo.setOrderProc(o.order_sn, { proc_status: 'failed', last_error: reason });
      repo.updateRun(run.id, { status: 'failed', finished_at: time.now(), error: reason });
      n++;
    } catch (e) { log.warn(`recoverOrphans run #${run.id} gagal:`, shortError(e)); }
  }
  return n;
}

// Sekali per proses server: run 'running' sisa server sebelumnya ditandai gagal supaya preview tidak
// terus menahan ordernya sebagai IN_PROGRESS.
function ensureOrphansChecked() {
  if (orphansChecked) return;
  orphansChecked = true;
  try { recoverOrphans(require('../db/repo')); } catch (e) { log.warn('pemeriksaan run terputus gagal:', shortError(e)); }
}

function getActiveOrderSns() {
  ensureOrphansChecked();
  const set = new Set();
  for (const st of runs.values()) if (!st.finished) for (const sn of st.orders.keys()) set.add(sn);
  return set;
}

function getActiveRun() {
  const st = findActive();
  if (st) return { run_id: st.run_id, kind: st.kind };
  orphansChecked = true;
  try { recoverOrphans(require('../db/repo')); } catch (e) { log.warn('recoverOrphans gagal:', shortError(e)); }
  return { run_id: null, kind: null };
}

// ---------- pipeline per order ----------
function setStage(st, o, stage, repo) {
  o.stage = stage;
  st.current = { order_sn: o.order_sn, stage };
  try { repo.upsertRunOrder(st.run_id, o.order_sn, { stage, status: 'pending' }); } catch (e) { log.warn('upsertRunOrder gagal:', shortError(e)); }
  let anyShipping = false;
  for (const x of st.orders.values()) if (x.stage === 'shipping' && !FINAL_STATUSES.has(x.status)) anyShipping = true;
  st.stage = anyShipping ? 'shipping' : 'documents';
}

function failOrder(st, o, err, repo) {
  const msg = typeof err === 'string' ? err : shortError(err);
  o.status = 'failed';
  o.error = msg;
  o.buffer = null;
  st.errors.push({ order_sn: o.order_sn, error: msg });
  try {
    repo.upsertRunOrder(st.run_id, o.order_sn, { stage: o.stage, status: 'failed', error: msg });
    if (o.mode === 'process') repo.setOrderProc(o.order_sn, { proc_status: 'failed', last_error: msg });
    // rebuild: order tetap 'processed', tetapi PDF barunya tidak memuat order ini -> tandai perlu dibuat ulang
    else repo.setOrderProc(o.order_sn, { last_error: msg, pdf_stale: 1 });
  } catch (e) { log.warn('failOrder simpan gagal:', shortError(e)); }
}

function skipOrder(st, o, repo) {
  const msg = 'Dibatalkan pengguna';
  o.status = 'skipped';
  o.error = msg;
  try {
    repo.upsertRunOrder(st.run_id, o.order_sn, { stage: 'queued', status: 'skipped', error: msg });
    if (o.mode === 'process') repo.setOrderProc(o.order_sn, { proc_status: 'unprocessed', proc_run_id: null, last_error: null });
  } catch (e) { log.warn('skipOrder simpan gagal:', shortError(e)); }
}

function checkCreateResult(resp, orderSn) {
  const r = firstResult(resp, orderSn);
  if (!r) return;
  const err = String(r.fail_error || r.error || '').trim();
  const msg = String(r.fail_message || r.message || '').trim();
  if (!err && !msg) return;
  if (/exist|already|sudah/i.test(`${err} ${msg}`)) return; // dokumen sudah pernah dibuat -> lanjut
  throw new Error(`Gagal membuat dokumen: ${[err, msg].filter(Boolean).join(' - ')}`);
}

// Tahapan: queued -> shipping (ship_order hanya READY_TO_SHIP) -> doc_requested -> doc_ready -> downloaded -> merged.
// Gagal -> 'failed' + error; order lain tetap lanjut. Semua error ditangkap di sini (pool tidak pernah macet).
async function processOrder(st, d, shopee, o) {
  const { repo, settings } = d;
  const procSet = settings.process || {};
  const docType = procSet.document_type || 'NORMAL_AIR_WAYBILL';
  const waitSec = Number(procSet.doc_wait_seconds) > 0 ? Number(procSet.doc_wait_seconds) : 90;
  const call = (label, p) => withTimeout(p, d.callTimeoutMs, label);
  try {
    setStage(st, o, 'shipping', repo);
    const order = repo.getOrder(o.order_sn);
    if (!order) throw new Error('Order tidak ditemukan di database');
    const status = String(order.order_status || '').toUpperCase();
    if (CANCELLED_STATUSES.has(status)) throw new Error('Order dibatalkan di marketplace');
    const shop_id = order.shop_id;
    const package_number = pickPackage(order);
    const warehouse = warehouseSetting(settings, o.warehouse_code || order.warehouse_code);

    // (1) arrange shipment hanya untuk READY_TO_SHIP (PROCESSED = sudah di-arrange, langsung dokumen)
    if (status === 'READY_TO_SHIP') {
      try {
        const r = await call('Atur pengiriman (ship_order)', shopee.arrangeShipment({ shop_id, order_sn: o.order_sn, package_number, warehouse, settings }));
        o.ship_result = r && r.method ? { method: r.method } : null;
      } catch (e) {
        // Status lokal tertinggal (mis. sudah di-arrange lewat Seller Centre) -> lanjut ke dokumen
        if (!isAlreadyArrangedError(e)) throw e;
        log.warn(`ship_order ${o.order_sn}: shipment sudah diatur sebelumnya, lanjut ke dokumen (${shortError(e)})`);
        o.ship_result = { method: 'existing' };
      }
      try { repo.setOrderProc(o.order_sn, { order_status: 'PROCESSED' }); } catch { /* abaikan */ }
    }

    // (2) nomor resi: dari DB atau tanya Shopee (3x, jeda)
    let tracking = order.tracking_number || null;
    for (let i = 0; i < 3 && !tracking; i++) {
      if (i > 0) await d.sleep(d.pollMs);
      try {
        const t = await call('Ambil nomor resi', shopee.getTrackingNumber({ shop_id, order_sn: o.order_sn, package_number }));
        tracking = t && typeof t === 'object' ? (t.tracking_number || null) : (t || null);
      } catch (e) { log.warn(`tracking ${o.order_sn} percobaan ${i + 1} gagal:`, shortError(e)); }
    }
    o.tracking_number = tracking ? String(tracking) : null;
    if (o.tracking_number) { try { repo.setOrderProc(o.order_sn, { tracking_number: o.tracking_number }); } catch { /* abaikan */ } }

    // (3) minta dokumen
    setStage(st, o, 'doc_requested', repo);
    const entry = { order_sn: o.order_sn, package_number, shipping_document_type: docType };
    if (o.tracking_number) entry.tracking_number = o.tracking_number;
    const created = await call('Buat dokumen', shopee.createShippingDocument({ shop_id, order_list: [entry] }));
    checkCreateResult(created, o.order_sn);

    // (4) tunggu READY, maksimal process.doc_wait_seconds
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const rr = await call('Cek status dokumen', shopee.getShippingDocumentResult({ shop_id, order_list: [{ order_sn: o.order_sn, package_number, shipping_document_type: docType }] }));
      const item = firstResult(rr, o.order_sn) || {};
      const ds = String(item.status || '').toUpperCase();
      if (ds === 'READY') break;
      if (ds === 'FAILED') throw new Error(`Dokumen gagal dibuat: ${item.fail_message || item.fail_error || 'tanpa keterangan'}`);
      if (Date.now() >= deadline) throw new Error(`Dokumen belum siap setelah ${waitSec} detik`);
      // Catatan: pembatalan (st.cancel) TIDAK menghentikan order yang sedang berjalan — shipment sudah diatur di Shopee,
      // labelnya harus tetap diambil. Order yang belum mulai dilewati di executeRun.
      await d.sleep(d.pollMs);
    }
    setStage(st, o, 'doc_ready', repo);

    // (5) unduh label
    const raw = await call('Unduh label', shopee.downloadShippingDocument({ shop_id, shipping_document_type: docType, order_list: [{ order_sn: o.order_sn, package_number }] }));
    const buf = toBuffer(raw);
    if (!buf || !buf.length) throw new Error('File label kosong dari Shopee');
    o.buffer = buf;
    o.status = 'ok';
    setStage(st, o, 'downloaded', repo);
  } catch (e) {
    failOrder(st, o, e, repo);
  } finally {
    st.done++;
  }
}

// Pool paralel sederhana. Error worker ditangkap agar worker lain tetap jalan; dikembalikan sebagai daftar.
async function runPool(items, concurrency, worker) {
  let idx = 0;
  const n = Math.max(1, Math.min(Number(concurrency) || 1, 20));
  const errors = [];
  const workers = Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      try { await worker(item); } catch (e) { errors.push({ item, error: e }); }
    }
  });
  await Promise.all(workers);
  return errors;
}

// ---------- pembuatan PDF ----------
function coverFor(st, d, { ship_type, sku_category, warehouse_code, order_count, file_name }) {
  const parts = (d.settings && d.settings.parts) || {};
  const user = st.user || {};
  return {
    part: st.part, part_label: parts[st.part] ? parts[st.part].label : undefined, ship_type, sku_category, warehouse_code,
    warehouse_name: warehouseName(d.settings, warehouse_code), date_text: time.formatDate(st.started_at), order_count, marketplace: 'Shopee',
    generated_by: user.name || user.username || 'system', generated_at_text: `${time.formatDateTime(d.now())} WIB`, file_name,
  };
}

// Baris Product List: agregasi per (marketplace, sku, nama, variasi).
function aggregateRows(repo, orderSns) {
  const map = new Map();
  const orders = orderSns.length ? repo.getOrders(orderSns) : [];
  for (const order of orders) {
    if (!order) continue;
    const seen = new Set();
    for (const it of order.items || []) {
      if (!it) continue;
      const sku = it.model_sku || it.item_sku || '-';
      const key = [order.marketplace || 'shopee', sku, it.item_name || '', it.model_name || ''].join('|');
      let row = map.get(key);
      if (!row) {
        const cat = it.category || (['tg', 'hg'].includes(order.sku_category) ? order.sku_category : null);
        row = { marketplace: order.marketplace || 'shopee', sku, item_name: it.item_name || '-', model_name: it.model_name || '', category: cat, qty: 0, order_count: 0 };
        map.set(key, row);
      }
      row.qty += Number(it.qty) || 0;
      if (!seen.has(key)) { row.order_count++; seen.add(key); }
    }
  }
  return [...map.values()];
}

function writePdfFile(st, fileName, bytes) {
  const dir = path.join(config.PDF_DIR, String(st.run_id));
  fs.mkdirSync(dir, { recursive: true });
  const file_path = path.join(dir, fileName);
  fs.writeFileSync(file_path, bytes);
  return file_path;
}

async function buildGroupPdfs(st, d) {
  const { repo, pdf } = d;
  for (const g of st.groups.values()) {
    const members = [...st.orders.values()].filter((o) => o.group_key === g.key && o.status === 'ok' && o.buffer);
    if (!members.length) continue;
    try {
      const labels = members.map((o) => ({ order_sn: o.order_sn, marketplace: o.marketplace || 'shopee', buffer: o.buffer, flags: o.flags || {} }));
      const cover = coverFor(st, d, { ship_type: g.ship_type, sku_category: g.sku_category, warehouse_code: g.warehouse_code, order_count: members.length, file_name: g.file_name });
      const res = await pdf.buildLabelsPdf({ cover, labels });
      const bad = new Map();
      for (const f of res.failed || []) if (!f.page_added) bad.set(f.order_sn, f.error);
      for (const o of members) if (bad.has(o.order_sn)) failOrder(st, o, `Label tidak bisa dibaca: ${bad.get(o.order_sn)}`, repo);
      const okMembers = members.filter((o) => !bad.has(o.order_sn));
      if (!okMembers.length) continue;
      if (bad.size) {
        // bangun ulang tanpa label rusak supaya jumlah order di cover benar
        const res2 = await pdf.buildLabelsPdf({ cover: { ...cover, order_count: okMembers.length }, labels: labels.filter((l) => !bad.has(l.order_sn)) });
        res.bytes = res2.bytes; res.page_count = res2.page_count;
      }
      const file_path = writePdfFile(st, g.file_name, res.bytes);
      const row = repo.createPdf({
        run_id: st.run_id, kind: 'labels', file_name: g.file_name, file_path, part: st.part, ship_type: g.ship_type, sku_category: g.sku_category,
        warehouse_code: g.warehouse_code, order_sns: okMembers.map((o) => o.order_sn), page_count: res.page_count, size_bytes: res.bytes.length,
      });
      st.pdfs.push({ id: row.id, kind: 'labels', file_name: row.file_name, order_count: row.order_count, page_count: row.page_count, ship_type: g.ship_type, sku_category: g.sku_category, warehouse_code: g.warehouse_code });
      for (const o of okMembers) { o.status = 'merged'; o.pdf_id = row.id; o.buffer = null; }
      for (const oldId of g.supersedes || []) {
        try { repo.setPdfStatus(oldId, 'superseded', `Dibuat ulang di run #${st.run_id} (PDF #${row.id})`); } catch (e) { log.warn('supersede gagal:', shortError(e)); }
      }
    } catch (e) {
      log.error(`PDF grup ${g.key} gagal:`, e);
      for (const o of members) if (o.status === 'ok') failOrder(st, o, `Gagal membuat PDF: ${shortError(e)}`, repo);
    }
  }
}

async function buildOneProductList(st, d, { warehouse_code, order_sns, supersedes }) {
  const { repo, pdf } = d;
  if (!order_sns.length) return null;
  const file_name = pdfFileName({ ts: st.started_at, part: st.part, warehouse_code, kind: 'productlist' });
  const rows = aggregateRows(repo, order_sns);
  const qty = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const cover = coverFor(st, d, { ship_type: null, sku_category: null, warehouse_code, order_count: order_sns.length, file_name });
  const res = await pdf.buildProductListPdf({ cover, rows, summary: { orders: order_sns.length, qty } });
  const file_path = writePdfFile(st, file_name, res.bytes);
  const row = repo.createPdf({ run_id: st.run_id, kind: 'productlist', file_name, file_path, part: st.part, warehouse_code, order_sns, page_count: res.page_count, size_bytes: res.bytes.length });
  st.pdfs.push({ id: row.id, kind: 'productlist', file_name, order_count: row.order_count, page_count: row.page_count, warehouse_code });
  for (const oldId of supersedes || []) {
    try { repo.setPdfStatus(oldId, 'superseded', `Dibuat ulang di run #${st.run_id} (PDF #${row.id})`); } catch (e) { log.warn('supersede gagal:', shortError(e)); }
  }
  return row;
}

// Order yang masih berlaku untuk product list (ada di DB dan tidak batal).
function liveOrderSns(repo, orderSns) {
  const out = [];
  for (const o of repo.getOrders(orderSns || [])) {
    if (!o || o.proc_status === 'cancelled' || CANCELLED_STATUSES.has(String(o.order_status || '').toUpperCase())) continue;
    out.push(o.order_sn);
  }
  return out;
}

async function buildProductLists(st, d) {
  const { repo } = d;
  const merged = [...st.orders.values()].filter((o) => o.status === 'merged');
  // Product list yang diminta dibangun ulang langsung (regenerate pdf_ids berisi productlist); order batal dibuang.
  const handledWh = new Set();
  for (const p of st.productlist_rebuild || []) {
    try {
      const sns = liveOrderSns(repo, p.order_sns || []);
      if (!sns.length) throw new Error('Semua order di product list ini sudah batal');
      await buildOneProductList(st, d, { warehouse_code: p.warehouse_code, order_sns: sns, supersedes: [p.id] });
      handledWh.add(p.warehouse_code);
    } catch (e) {
      log.error('Product list gagal dibuat ulang:', e);
      st.errors.push({ order_sn: null, error: `Product list ${p.warehouse_code} gagal: ${shortError(e)}` });
    }
  }
  // regenerate pdf_ids: hanya PDF yang dipilih; product list lama tetap berlaku
  if (!st.auto_productlists || !merged.length) return;
  const byWh = new Map();
  for (const o of merged) {
    const wh = st.merge_mode ? 'all' : (o.warehouse_code || 'all');
    if (!byWh.has(wh)) byWh.set(wh, []);
    byWh.get(wh).push(o.order_sn);
  }
  let oldLists = [];
  if (st.supersede_productlists && st.source_run_id) {
    try { oldLists = repo.listPdfs(st.source_run_id).filter((p) => p.kind === 'productlist' && p.status !== 'superseded'); } catch { oldLists = []; }
  }
  for (const [wh, sns] of byWh) {
    if (handledWh.has(wh)) continue;
    try {
      await buildOneProductList(st, d, { warehouse_code: wh, order_sns: sns, supersedes: oldLists.filter((p) => p.warehouse_code === wh).map((p) => p.id) });
    } catch (e) {
      log.error('Product list gagal:', e);
      st.errors.push({ order_sn: null, error: `Product list ${wh} gagal: ${shortError(e)}` });
    }
  }
}

// ---------- penyelesaian ----------
function finalize(st, d) {
  const { repo } = d;
  const nowTs = d.now();
  const all = [...st.orders.values()];
  for (const o of all) {
    if (o.status === 'ok') failOrder(st, o, 'PDF tidak dibuat untuk order ini', repo); // label ada tapi tidak sempat digabung
  }
  const ok = all.filter((o) => o.status === 'merged');
  const failed = all.filter((o) => o.status === 'failed');
  const skipped = all.filter((o) => o.status === 'skipped');
  for (const o of ok) {
    try {
      repo.upsertRunOrder(st.run_id, o.order_sn, { stage: 'merged', status: 'ok', error: null });
      const patch = { proc_status: 'processed', pdf_stale: 0, proc_run_id: st.run_id, last_error: null };
      // rebuild PDF: waktu proses asli dipertahankan (KPI "diproses hari ini" tidak ikut berubah)
      const prev = o.mode === 'rebuild' ? repo.getOrder(o.order_sn) : null;
      patch.processed_at = prev && prev.processed_at ? prev.processed_at : nowTs;
      if (o.tracking_number) patch.tracking_number = o.tracking_number;
      repo.setOrderProc(o.order_sn, patch);
    } catch (e) { log.warn('finalize order gagal:', shortError(e)); }
  }
  const by_group = {};
  for (const g of st.groups.values()) {
    const members = all.filter((o) => o.group_key === g.key);
    const pdfRow = st.pdfs.find((p) => p.kind === 'labels' && p.file_name === g.file_name);
    by_group[g.key] = {
      ship_type: g.ship_type, sku_category: g.sku_category, warehouse_code: g.warehouse_code, orders: members.length,
      ok: members.filter((o) => o.status === 'merged').length, failed: members.filter((o) => o.status === 'failed').length,
      skipped: members.filter((o) => o.status === 'skipped').length, pdf_id: pdfRow ? pdfRow.id : null, file_name: pdfRow ? pdfRow.file_name : null,
    };
  }
  let status;
  if (!all.length && st.pdfs.length) status = 'done';
  else if (ok.length === all.length && all.length > 0) status = 'done';
  else if (ok.length > 0) status = 'partial';
  else status = 'failed';
  const summary = {
    orders: all.length, ok: ok.length, failed: failed.length, skipped: skipped.length, pdfs: st.pdfs.length, by_group,
    cancelled: !!st.cancel, kind: st.kind, source_run_id: st.source_run_id, part: st.part, warehouse: st.warehouse,
    dropped: st.dropped.slice(),
    pdf_list: st.pdfs.map((p) => ({ id: p.id, kind: p.kind, file_name: p.file_name, order_count: p.order_count, page_count: p.page_count })),
  };
  const errorText = status === 'failed' ? (st.cancel && !failed.length ? 'Dibatalkan pengguna' : (st.errors[0] && st.errors[0].error) || 'Tidak ada order yang berhasil') : null;
  st.status = status; st.summary = summary; st.finished = true; st.finished_at = nowTs; st.stage = 'done'; st.current = null;
  try { repo.updateRun(st.run_id, { status, finished_at: nowTs, summary, error: errorText }); } catch (e) { log.error('updateRun gagal:', e); }
  try { repo.logActivity(st.user, st.kind === 'regenerate' ? 'regenerate_run' : 'process_run', String(st.run_id), summary); } catch (e) { log.warn('logActivity gagal:', shortError(e)); }
  for (const o of all) o.buffer = null;
  pruneRuns();
  log.info(`run #${st.run_id} selesai: ${status} (ok ${ok.length}, gagal ${failed.length}, dilewati ${skipped.length}, pdf ${st.pdfs.length})`);
}

function fatal(st, d, err) {
  log.error(`run #${st.run_id} gagal fatal:`, err);
  const msg = shortError(err);
  try {
    for (const o of st.orders.values()) if (!FINAL_STATUSES.has(o.status) && o.status !== 'merged') failOrder(st, o, msg, d.repo);
    for (const o of st.orders.values()) if (o.status === 'merged') {
      d.repo.upsertRunOrder(st.run_id, o.order_sn, { stage: 'merged', status: 'ok', error: null });
      d.repo.setOrderProc(o.order_sn, { proc_status: 'processed', processed_at: d.now(), pdf_stale: 0, proc_run_id: st.run_id, last_error: null });
    }
    const ok = [...st.orders.values()].filter((o) => o.status === 'merged').length;
    st.status = ok > 0 ? 'partial' : 'failed'; st.finished = true; st.finished_at = d.now(); st.stage = 'done'; st.current = null;
    st.summary = { orders: st.orders.size, ok, failed: st.orders.size - ok, skipped: 0, pdfs: st.pdfs.length, by_group: {}, fatal: msg, kind: st.kind, dropped: st.dropped.slice() };
    d.repo.updateRun(st.run_id, { status: st.status, finished_at: st.finished_at, summary: st.summary, error: msg });
    d.repo.logActivity(st.user, st.kind === 'regenerate' ? 'regenerate_run' : 'process_run', String(st.run_id), st.summary);
  } catch (e) { log.error('fatal(): gagal menyimpan status:', e); }
  for (const o of st.orders.values()) o.buffer = null;
  pruneRuns();
}

async function executeRun(st, d, shopee) {
  try {
    const list = [...st.orders.values()];
    const concurrency = (d.settings.process && d.settings.process.concurrency) || 3;
    st.stage = list.length ? 'shipping' : 'pdf';
    const poolErrors = await runPool(list, concurrency, async (o) => {
      if (st.cancel) { skipOrder(st, o, d.repo); st.done++; return; }
      await processOrder(st, d, shopee, o);
    });
    // processOrder menangkap semua error sendiri; ini pengaman terakhir supaya order tidak menggantung 'pending'
    for (const { item, error } of poolErrors) {
      if (item && !FINAL_STATUSES.has(item.status) && item.status !== 'merged') { failOrder(st, item, error, d.repo); st.done++; }
    }
    st.stage = 'pdf'; st.current = null;
    await buildGroupPdfs(st, d);
    await buildProductLists(st, d);
    finalize(st, d);
  } catch (e) {
    fatal(st, d, e);
  }
}

// ---------- API publik ----------
function addOrderToState(st, { order_sn, mode, ship_type, sku_category, warehouse_code, flags, marketplace, group, supersedes }) {
  const key = group.key;
  if (!st.groups.has(key)) st.groups.set(key, { key, ship_type: group.ship_type, sku_category: group.sku_category, warehouse_code: group.warehouse_code, file_name: group.file_name, supersedes: new Set() });
  const g = st.groups.get(key);
  for (const id of supersedes || []) g.supersedes.add(id);
  st.orders.set(order_sn, { order_sn, mode, ship_type, sku_category, warehouse_code, flags: flags || {}, marketplace: marketplace || 'shopee', group_key: key, stage: 'queued', status: 'pending', error: null, buffer: null, tracking_number: null });
}

/**
 * Mulai run proses order. Validasi, buat run + run_orders, lalu eksekusi async. Return { run_id }.
 */
async function startRun({ part = 'auto', warehouse = 'all', order_sns, note, user, ignore_sync_block } = {}, ctx = {}) {
  const d = resolveDeps(ctx);
  orphansChecked = true;
  recoverOrphans(d.repo);
  // Run apa pun yang masih jalan (process maupun regenerate) memblokir run baru: satu run pada satu waktu.
  const active = findActive();
  if (active) throw conflict(active.kind === 'regenerate' ? 'Masih ada pembuatan ulang PDF yang sedang berjalan' : 'Masih ada proses order yang sedang berjalan', { run_id: active.run_id, kind: active.kind });
  part = String(part || 'auto').toLowerCase();
  warehouse = String(warehouse || 'all').toLowerCase();
  if (!['auto', 'p1', 'p2', 'p3'].includes(part)) throw badRequest('Part tidak valid (auto/p1/p2/p3)');
  if (!['all', 'jkt', 'sby'].includes(warehouse)) throw badRequest('Gudang tidak valid (all/jkt/sby)');

  const shopee = d.shopee(); // 503 bila modul Shopee belum ada — sebelum run dibuat
  const previewMod = d.preview();
  const nowTs = d.now();
  const pv = previewMod.buildPreview({ part, warehouse }, { settings: d.settings, repo: d.repo, now: nowTs, activeRunOrderSns: getActiveOrderSns() });
  if (pv && pv.blocked && !ignore_sync_block) throw conflict(pv.blocked.message || 'Sinkronisasi belum berhasil; proses diblokir', { code: pv.blocked.code, blocked: pv.blocked });

  const filter = Array.isArray(order_sns) && order_sns.length ? new Set(order_sns.map(String)) : null;
  const selected = [];
  for (const g of (pv && pv.groups) || []) for (const o of g.orders || []) if (o && o.order_sn && (!filter || filter.has(String(o.order_sn)))) selected.push({ order: o, group: g });
  if (!selected.length) throw badRequest('Tidak ada order yang bisa diproses');
  const max = Number(d.settings.process && d.settings.process.max_orders_per_run) || 0;
  if (max > 0 && selected.length > max) throw badRequest(`Jumlah order (${selected.length}) melebihi batas per run (${max}). Pilih sebagian order.`);

  let resolvedPart = pv && pv.part && pv.part !== 'auto' ? pv.part : part;
  if (resolvedPart === 'auto') resolvedPart = (pv && pv.part_auto && pv.part_auto.part) || resolveAutoPart(d.settings, nowTs);
  const mergeMode = warehouse === 'all' && d.settings.process && d.settings.process.all_warehouses_mode === 'merge';

  const run = d.repo.createRun({ part: resolvedPart, warehouse_filter: warehouse, kind: 'process', user, note });
  const st = newState({ run, kind: 'process', part: resolvedPart, warehouse, user, note, settings: d.settings });
  st.merge_mode = mergeMode;
  for (const { order, group } of selected) {
    const ship_type = group.ship_type || order.ship_type;
    const sku_category = group.sku_category || order.sku_category;
    // Dalam mode merge, grup preview memakai warehouse_code 'all'; gudang asli order tetap dari summary.
    const warehouse_code = order.warehouse_code || (group.warehouse_code && group.warehouse_code !== 'all' ? group.warehouse_code : null);
    const gwh = mergeMode ? 'all' : (warehouse_code || group.warehouse_code || 'all');
    const key = mergeMode ? groupKey({ ship_type, sku_category, warehouse_code: 'all' }) : (group.key || groupKey({ ship_type, sku_category, warehouse_code }));
    const file_name = !mergeMode && group.file_name ? group.file_name : pdfFileName({ ts: run.started_at, part: resolvedPart, ship_type, sku_category, warehouse_code: gwh, kind: 'labels' });
    const flags = (order.validation && order.validation.flags) || {};
    addOrderToState(st, { order_sn: String(order.order_sn), mode: 'process', ship_type, sku_category, warehouse_code, flags, marketplace: order.marketplace, group: { key, ship_type, sku_category, warehouse_code: gwh, file_name } });
    d.repo.upsertRunOrder(run.id, String(order.order_sn), { ship_type, sku_category, warehouse_code, stage: 'queued', status: 'pending', error: null, flags });
    d.repo.setOrderProc(String(order.order_sn), { proc_status: 'processing', proc_run_id: run.id, last_error: null });
  }
  st.total = st.orders.size;
  runs.set(run.id, st);
  log.info(`run #${run.id} dimulai: part ${resolvedPart}, gudang ${warehouse}, ${st.total} order`);
  setImmediate(() => executeRun(st, d, shopee).catch((e) => log.error('executeRun:', e)));
  return { run_id: run.id };
}

/**
 * Buat run baru (kind 'regenerate') dari run sumber: proses ulang order gagal, atau bangun ulang PDF.
 */
async function regenerate({ run_id, only_failed, pdf_ids, user, note } = {}, ctx = {}) {
  const d = resolveDeps(ctx);
  orphansChecked = true;
  recoverOrphans(d.repo);
  const id = Number(run_id);
  const src = Number.isFinite(id) ? d.repo.getRun(id) : null;
  if (!src) throw notFound('Run tidak ditemukan');
  const active = findActive();
  if (active) throw conflict('Masih ada run yang sedang berjalan', { run_id: active.run_id, kind: active.kind });
  if (src.status === 'running') throw conflict('Run sumber masih berjalan');
  const shopee = d.shopee(); // 503 bila modul Shopee belum ada — sebelum run dibuat

  const srcRunOrders = d.repo.listRunOrders(id);
  const srcPdfs = d.repo.listPdfs(id);
  const part = src.part;
  const warehouse = src.warehouse_filter || 'all';
  const mergeMode = warehouse === 'all' && d.settings.process && d.settings.process.all_warehouses_mode === 'merge';
  const tasks = []; // {order_sn, mode, ship_type, sku_category, warehouse_code, flags, marketplace, supersedes}
  const dropped = []; // order batal yang tidak ikut rebuild -> {order_sn, reason, ship_type, sku_category, warehouse_code}
  const plRebuild = [];
  let supersedeLists = false;
  let autoLists = true;
  const isCancelled = (order) => order.proc_status === 'cancelled' || CANCELLED_STATUSES.has(String(order.order_status || '').toUpperCase());

  if (only_failed) {
    for (const ro of srcRunOrders.filter((r) => r.status === 'failed')) {
      const order = d.repo.getOrder(ro.order_sn);
      if (!order) continue;
      if (!['failed', 'unprocessed'].includes(order.proc_status)) continue; // sudah diproses/dibatalkan lewat jalur lain
      if (isCancelled(order)) continue;
      tasks.push({
        order_sn: ro.order_sn, mode: 'process', ship_type: ro.ship_type || order.ship_type, sku_category: ro.sku_category || order.sku_category,
        warehouse_code: ro.warehouse_code || order.warehouse_code, flags: (order.validation && order.validation.flags) || ro.flags || {}, marketplace: order.marketplace, supersedes: [],
      });
    }
    if (!tasks.length) throw badRequest('Tidak ada order gagal yang bisa diproses ulang');
  } else {
    let targets = srcPdfs.filter((p) => p.status !== 'superseded');
    if (Array.isArray(pdf_ids) && pdf_ids.length) {
      const wanted = new Set(pdf_ids.map(Number));
      targets = srcPdfs.filter((p) => wanted.has(p.id));
      if (targets.length !== wanted.size) throw badRequest('Ada PDF yang tidak ditemukan di run ini');
      const old = targets.find((p) => p.status === 'superseded');
      if (old) throw badRequest(`PDF ${old.file_name} sudah digantikan oleh PDF yang lebih baru; buat ulang dari run penggantinya`);
      autoLists = false; // hanya PDF yang dipilih yang dibangun ulang; PDF lain di run sumber tetap berlaku
    } else {
      supersedeLists = true;
    }
    if (!targets.length) throw badRequest('Tidak ada PDF yang bisa dibuat ulang');
    const seen = new Map();
    for (const p of targets) {
      if (p.kind === 'productlist') { plRebuild.push(p); continue; }
      for (const sn of p.order_sns || []) {
        const order = d.repo.getOrder(sn);
        if (!order) continue;
        if (seen.has(sn)) { seen.get(sn).supersedes.push(p.id); continue; }
        const ro = srcRunOrders.find((r) => r.order_sn === sn) || {};
        const t = {
          order_sn: sn, mode: 'rebuild', ship_type: p.ship_type || ro.ship_type || order.ship_type, sku_category: p.sku_category || ro.sku_category || order.sku_category,
          warehouse_code: ro.warehouse_code || order.warehouse_code || p.warehouse_code, group_wh: p.warehouse_code,
          flags: (order.validation && order.validation.flags) || ro.flags || {}, marketplace: order.marketplace, supersedes: [p.id],
        };
        seen.set(sn, t);
        // Order yang sudah batal tidak dimasukkan ke PDF baru (inilah alasan utama "buat ulang")
        if (isCancelled(order)) { dropped.push({ order_sn: sn, reason: DROPPED_REASON, ship_type: t.ship_type, sku_category: t.sku_category, warehouse_code: t.warehouse_code, flags: t.flags }); continue; }
        tasks.push(t);
      }
    }
    if (supersedeLists) plRebuild.length = 0; // regenerate semua: product list dibangun dari order sukses & yang lama di-supersede
    if (!tasks.length && !plRebuild.length) {
      throw badRequest(dropped.length ? 'Semua order di PDF yang dipilih sudah batal; tidak ada yang bisa dibuat ulang' : 'Tidak ada order di PDF yang dipilih');
    }
  }

  const run = d.repo.createRun({ part, warehouse_filter: warehouse, kind: 'regenerate', user, note: note || `Dari run #${id}`, source_run_id: id });
  const st = newState({ run, kind: 'regenerate', part, warehouse, user, note, settings: d.settings, source_run_id: id });
  st.merge_mode = mergeMode;
  st.productlist_rebuild = plRebuild;
  st.supersede_productlists = supersedeLists;
  st.auto_productlists = autoLists;
  for (const t of tasks) {
    const gwh = mergeMode ? 'all' : (t.group_wh || t.warehouse_code);
    const key = groupKey({ ship_type: t.ship_type, sku_category: t.sku_category, warehouse_code: gwh });
    const file_name = pdfFileName({ ts: run.started_at, part, ship_type: t.ship_type, sku_category: t.sku_category, warehouse_code: gwh, kind: 'labels' });
    addOrderToState(st, { ...t, group: { key, ship_type: t.ship_type, sku_category: t.sku_category, warehouse_code: gwh, file_name } });
    d.repo.upsertRunOrder(run.id, t.order_sn, { ship_type: t.ship_type, sku_category: t.sku_category, warehouse_code: t.warehouse_code, stage: 'queued', status: 'pending', error: null, flags: t.flags });
    if (t.mode === 'process') d.repo.setOrderProc(t.order_sn, { proc_status: 'processing', proc_run_id: run.id, last_error: null });
  }
  for (const x of dropped) {
    st.dropped.push({ order_sn: x.order_sn, reason: x.reason });
    d.repo.upsertRunOrder(run.id, x.order_sn, { ship_type: x.ship_type, sku_category: x.sku_category, warehouse_code: x.warehouse_code, stage: 'queued', status: 'skipped', error: x.reason, flags: x.flags });
  }
  st.total = st.orders.size + dropped.length;
  st.done = dropped.length;
  runs.set(run.id, st);
  log.info(`run regenerate #${run.id} dari #${id}: ${st.orders.size} order, ${plRebuild.length} product list, ${dropped.length} order batal dilewati`);
  setImmediate(() => executeRun(st, d, shopee).catch((e) => log.error('executeRun:', e)));
  return { run_id: run.id };
}

function getProgress(run_id) {
  const id = Number(run_id);
  const st = runs.get(id);
  if (st) return snapshot(st);
  // Tidak ada di memori: rekonstruksi dari DB (run lama, atau server pernah dimulai ulang -> pulihkan dulu)
  ensureOrphansChecked();
  const repo = require('../db/repo');
  const run = repo.getRun(id);
  if (!run) return null;
  const ros = repo.listRunOrders(id);
  const pdfs = repo.listPdfs(id);
  const done = ros.filter((r) => FINAL_STATUSES.has(r.status)).length;
  return {
    run_id: id, kind: run.kind, source_run_id: run.source_run_id, status: run.status, stage: run.status === 'running' ? 'documents' : 'done',
    done, total: ros.length, current: null, active: [], errors: ros.filter((r) => r.status === 'failed').map((r) => ({ order_sn: r.order_sn, error: r.error })),
    pdfs: pdfs.map((p) => ({ id: p.id, kind: p.kind, file_name: p.file_name, order_count: p.order_count, page_count: p.page_count, ship_type: p.ship_type, sku_category: p.sku_category, warehouse_code: p.warehouse_code, status: p.status })),
    finished: run.status !== 'running', started_at: run.started_at, finished_at: run.finished_at, summary: run.summary, cancel_requested: false,
    part: run.part, warehouse: run.warehouse_filter, reconstructed: true,
  };
}

function cancelRun(run_id) {
  const st = runs.get(Number(run_id));
  if (!st || st.finished) return false;
  st.cancel = true;
  log.info(`run #${st.run_id}: pembatalan diminta`);
  return true;
}

// Detail run untuk UI: { run, progress, orders:[run_order + summary], pdfs }
function getRunDetail(run_id, ctx = {}) {
  const repo = ctx.repo || require('../db/repo');
  const id = Number(run_id);
  const run = Number.isFinite(id) ? repo.getRun(id) : null;
  if (!run) return null;
  const orders = repo.listRunOrders(id).map((ro) => ({ ...ro, summary: toSummarySafe(repo.getOrder(ro.order_sn), ctx) }));
  return { run, progress: getProgress(id), orders, pdfs: repo.listPdfs(id) };
}

module.exports = {
  startRun, getProgress, regenerate, cancelRun, getRunDetail, getActiveRun, getActiveOrderSns, recoverOrphans, toSummarySafe,
  // diekspor untuk test
  _internal: { aggregateRows, pdfFileName, groupKey, resolveAutoPart, runs, fallbackSummary },
};
