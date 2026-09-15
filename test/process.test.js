'use strict';
// Test engine/process.js + route /api/process & /api/history (AGENT PDFPROC).
// STORAGE_DIR diset SEBELUM require modul src apa pun.
const path = require('path');
const fs = require('fs');
const http = require('http');
const TMP = path.resolve(__dirname, '..', '.tmp', `pdfproc-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;
process.env.SHOPEE_TRANSPORT = 'mock';

const { test, describe, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const express = require('express');

const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repo');
const time = require('../src/util/time');
const { DEFAULTS } = require('../src/settings-defaults');
const proc = require('../src/engine/process');

// Preview: pakai engine/preview asli jika ada, jika belum ada pakai preview palsu minimal (kontrak sama).
let previewMod = null;
try { previewMod = require('../src/engine/preview'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const fakePreview = {
  toSummary(o) {
    const items = (o.items || []).map((it) => ({ item_name: it.item_name, model_name: it.model_name, item_sku: it.item_sku, model_sku: it.model_sku, qty: Number(it.qty) || 0, category: it.category || null, phone_type: it.phone_type || null, image_url: null }));
    return { ...o, items, item_count: items.length, qty_total: items.reduce((s, i) => s + i.qty, 0), validation: o.validation || { holds: [], warnings: [], flags: {} }, overrides: o.overrides || {}, deadline_hours_left: null };
  },
  buildPreview({ part, warehouse }, ctx) {
    const r = ctx.repo; const active = ctx.activeRunOrderSns || new Set();
    const groups = new Map();
    for (const o of r.allOrders({ order_status: ['READY_TO_SHIP', 'PROCESSED'], proc_status: ['unprocessed', 'failed'] })) {
      if (active.has(o.order_sn) || !o.warehouse_code || !o.sku_category || o.sku_category === 'review') continue;
      if (warehouse !== 'all' && o.warehouse_code !== warehouse) continue;
      const key = `${o.ship_type}-${o.sku_category}-${o.warehouse_code}`;
      if (!groups.has(key)) groups.set(key, { key, ship_type: o.ship_type, sku_category: o.sku_category, warehouse_code: o.warehouse_code, label: key, file_name: `${time.ddmmyyyy(ctx.now)}-${part}-${o.ship_type === 'instant' ? 'ins' : 'reg'}-${o.sku_category}-${o.warehouse_code}.pdf`, orders: [], qty_total: 0 });
      groups.get(key).orders.push(fakePreview.toSummary(o));
    }
    const ls = r.lastSync('shopee');
    const blocked = !r.getPrimaryShop('shopee') ? { code: 'NOT_CONNECTED', message: 'Toko belum terhubung' } : !ls.last_ok ? { code: 'NO_SYNC', message: 'Belum ada sync sukses' } : null;
    return { part: part === 'auto' ? 'p1' : part, warehouse, generated_at: ctx.now, sync: { ok: !!ls.last_ok }, blocked, totals: {}, groups: [...groups.values()], held: [], review: [], excluded: [], product_list: [] };
  },
};
const previewUsed = previewMod || fakePreview;

// ---------- setting uji: gudang terpetakan ----------
function settingsMapped(extra = {}) {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  s.warehouses = [
    { code: 'jkt', name: 'Jakarta', location_ids: ['JKT-001'], warehouse_ids: [], pickup_address_id: null, is_default: true },
    { code: 'sby', name: 'Surabaya', location_ids: ['SBY-001'], warehouse_ids: [], pickup_address_id: null, is_default: false },
  ];
  s.process = { ...s.process, concurrency: 2, doc_wait_seconds: 5, ...(extra.process || {}) };
  return { ...s, ...extra, process: s.process };
}
const S = settingsMapped();
const USER = { id: 1, username: 'admin', name: 'Admin Uji', role: 'admin' };
const NOW = time.now();

// ---------- data order ----------
const tgItem = (over = {}) => ({ item_id: 1, item_name: 'Tempered Glass Full Cover', item_sku: 'TG-IP15PM-CLR', model_id: 11, model_name: 'iPhone 15 Pro Max', model_sku: null, qty: 2, price: 25000, product_location_id: 'JKT-001', order_item_id: 1, image_url: null, ...over });
const hgItem = (over = {}) => ({ item_id: 2, item_name: 'Hydrogel Matte', item_sku: 'HG-SAMS23U-MAT', model_id: 22, model_name: 'Samsung S23 Ultra', model_sku: null, qty: 1, price: 30000, product_location_id: 'JKT-001', order_item_id: 2, image_url: null, ...over });
function orderRow(sn, over = {}) {
  return {
    order_sn: sn, shop_id: 999001, marketplace: 'shopee', order_status: 'READY_TO_SHIP', create_time: NOW - 3600, update_time: NOW - 1800, pay_time: NOW - 3500,
    ship_by_date: NOW + 2 * 86400, days_to_ship: 2, shipping_carrier: 'GrabExpress Instant', checkout_shipping_carrier: null, buyer_username: 'pembeli',
    recipient_name: `Penerima ${sn}`, recipient_phone: '0812', recipient_address: 'Jl. Uji No. 1', note: null, message_to_seller: null, cod: false, total_amount: 50000, currency: 'IDR',
    items: [tgItem()], packages: [{ package_number: `PKG-${sn}`, logistics_status: 'LOGISTICS_READY', shipping_carrier: 'GrabExpress Instant', item_list: [] }],
    tracking_number: null, package_number: `PKG-${sn}`, raw: { order_sn: sn }, ...over,
  };
}
const sby = (it) => ({ ...it, product_location_id: 'SBY-001' });

// Derived untuk preview palsu (preview asli mengklasifikasi ulang sendiri).
function derive(sn, { ship_type, sku_category, warehouse_code, tipe = false }) {
  repo.setOrderDerived(sn, { ship_type, sku_category, warehouse_code, phone_type: { value: 'x', source: 'model_name', required: true, missing: false }, validation: { holds: [], warnings: [], flags: { tipe_belum_ditulis: tipe, deadline_hours_left: null, needs_review: false } } });
}

// ---------- shopee palsu ----------
async function makeLabel(sn) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([283, 425]);
  p.drawText(`AWB ${sn}`, { x: 20, y: 380, size: 14, font: f });
  return Buffer.from(await d.save());
}
function makeShopee({ failSns = new Set(), gate = null } = {}) {
  const calls = { arrange: [], tracking: [], create: [], result: [], download: [] };
  const resultSeen = new Set();
  return {
    calls,
    async arrangeShipment({ order_sn, warehouse }) {
      calls.arrange.push({ order_sn, warehouse: warehouse ? warehouse.code : null });
      if (gate) await gate.wait(order_sn);
      if (failSns.has(order_sn)) { const e = new Error('Pickup tidak tersedia untuk alamat ini'); e.name = 'ShopeeError'; e.code = 'logistics.pickup_unavailable'; throw e; }
      return { method: 'pickup', detail: {} };
    },
    async getTrackingNumber({ order_sn }) { calls.tracking.push(order_sn); return `TRK${order_sn}`; },
    async createShippingDocument({ order_list }) {
      const sn = order_list[0].order_sn; calls.create.push(order_list[0]);
      if (sn === 'O3') return { result_list: [{ order_sn: sn, fail_error: 'logistics.document_already_exist', fail_message: 'Shipping document already exist' }] };
      return { result_list: [{ order_sn: sn, fail_error: '', fail_message: '' }] };
    },
    async getShippingDocumentResult({ order_list }) {
      const sn = order_list[0].order_sn; calls.result.push(sn);
      if (!resultSeen.has(sn)) { resultSeen.add(sn); return { result_list: [{ order_sn: sn, status: 'PROCESSING' }] }; }
      return { result_list: [{ order_sn: sn, status: 'READY' }] };
    },
    async downloadShippingDocument({ order_list }) { const sn = order_list[0].order_sn; calls.download.push(sn); return makeLabel(sn); },
  };
}
function makeGate() {
  let release; const gateP = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  return { async wait(sn) { reached(sn); await gateP; }, release, reached: reachedP };
}
async function waitFinished(runId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const p = proc.getProgress(runId);
    if (p && p.finished) return p;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${runId} tidak selesai dalam ${timeoutMs} ms: ${JSON.stringify(p)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ctxWith = (shopee, extra = {}) => ({ repo, settings: S, preview: previewUsed, shopee, poll_ms: 5, ...extra });

// ---------- setup ----------
before(() => {
  db.open();
  repo.upsertShop({ shop_id: 999001, shop_name: 'Glass Pro (Uji)', status: 'connected', access_token: 'tok', refresh_token: 'ref', access_expire_at: NOW + 3600, refresh_expire_at: NOW + 86400, authorized_at: NOW - 100 });
  const sid = repo.startSyncLog({ trigger: 'manual', user: USER });
  repo.finishSyncLog(sid, { status: 'ok', fetched: 6, created: 6, updated: 0 });
  // O1: instant tg jkt, tipe HP kosong + batas kirim < 5 jam -> TIPE BELUM DITULIS
  repo.upsertOrder(orderRow('O1', { ship_by_date: NOW + 2 * 3600, items: [tgItem({ model_name: 'Universal (tulis tipe di catatan)' })] }));
  repo.upsertOrder(orderRow('O2')); // instant tg jkt
  repo.upsertOrder(orderRow('O3', { order_status: 'PROCESSED', items: [hgItem()], tracking_number: 'TRK-ADA' })); // sudah di-arrange
  repo.upsertOrder(orderRow('O4', { shipping_carrier: 'J&T Express', items: [sby(tgItem())] })); // regular tg sby
  repo.upsertOrder(orderRow('O5', { shipping_carrier: 'JNE Reguler', items: [sby(tgItem()), sby(hgItem())] })); // regular mix sby -> gagal
  repo.upsertOrder(orderRow('O6', { order_status: 'PROCESSED', shipping_carrier: 'SPX Standard', items: [sby(tgItem())] })); // regular tg sby
  derive('O1', { ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt', tipe: true });
  derive('O2', { ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt' });
  derive('O3', { ship_type: 'instant', sku_category: 'hg', warehouse_code: 'jkt' });
  derive('O4', { ship_type: 'regular', sku_category: 'tg', warehouse_code: 'sby' });
  derive('O5', { ship_type: 'regular', sku_category: 'mix', warehouse_code: 'sby' });
  derive('O6', { ship_type: 'regular', sku_category: 'tg', warehouse_code: 'sby' });
});
after(() => {
  try { db.close(); } catch { /* abaikan */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* abaikan */ }
});

let run1; let run1Pdfs; let shopee1;

describe('process.startRun', () => {
  test('validasi: blocked tanpa sync, part/gudang tidak valid, tidak ada order', async () => {
    const shopee = makeShopee();
    await assert.rejects(proc.startRun({ part: 'p9', warehouse: 'all', user: USER }, ctxWith(shopee)), (e) => e.status === 400);
    await assert.rejects(proc.startRun({ part: 'p1', warehouse: 'xx', user: USER }, ctxWith(shopee)), (e) => e.status === 400);
    await assert.rejects(proc.startRun({ part: 'p1', warehouse: 'all', order_sns: ['TIDAK-ADA'], user: USER }, ctxWith(shopee)), (e) => e.status === 400 && /Tidak ada order/.test(e.message));
    // blokir sync: preview palsu yang mengembalikan blocked
    const blockedPreview = { ...previewUsed, buildPreview: (a, c) => ({ ...previewUsed.buildPreview(a, c), blocked: { code: 'SYNC_FAILED', message: 'Sync terakhir gagal' } }) };
    await assert.rejects(proc.startRun({ part: 'p1', warehouse: 'all', user: USER }, ctxWith(shopee, { preview: blockedPreview })), (e) => e.status === 409 && /Sync terakhir gagal/.test(e.message));
    // ignore_sync_block -> lolos (lalu dibatalkan supaya tidak mengganggu test berikut)
    const { run_id } = await proc.startRun({ part: 'p1', warehouse: 'jkt', order_sns: ['O2'], user: USER, ignore_sync_block: true }, ctxWith(shopee, { preview: blockedPreview }));
    assert.ok(run_id > 0);
    const p = await waitFinished(run_id);
    assert.equal(p.status, 'done');
    assert.equal(repo.getOrder('O2').proc_status, 'processed');
    // kembalikan O2 supaya ikut run utama
    repo.setOrderProc('O2', { proc_status: 'unprocessed', proc_run_id: null, processed_at: null, order_status: 'READY_TO_SHIP' });
    derive('O2', { ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt' });
  });

  test('memproses 6 order, 1 gagal -> run partial, PDF per grup + product list', async () => {
    shopee1 = makeShopee({ failSns: new Set(['O5']) });
    const { run_id } = await proc.startRun({ part: 'p1', warehouse: 'all', user: USER, note: 'uji' }, ctxWith(shopee1));
    run1 = run_id;
    const p0 = proc.getProgress(run_id);
    assert.equal(p0.status, 'running');
    assert.equal(p0.total, 6);
    assert.equal(p0.finished, false);
    for (const sn of ['O1', 'O2', 'O3', 'O4', 'O5', 'O6']) assert.equal(repo.getOrder(sn).proc_status, 'processing');
    assert.ok(proc.getActiveOrderSns().has('O1'));
    assert.equal(proc.getActiveRun().run_id, run_id);
    // run kedua ditolak 409
    await assert.rejects(proc.startRun({ part: 'p1', warehouse: 'all', user: USER }, ctxWith(makeShopee())), (e) => e.status === 409);

    const p = await waitFinished(run_id);
    assert.equal(p.finished, true);
    assert.equal(p.stage, 'done');
    assert.equal(p.status, 'partial');
    assert.equal(p.done, 6);
    assert.equal(p.summary.ok, 5);
    assert.equal(p.summary.failed, 1);
    assert.equal(p.summary.skipped, 0);
    assert.equal(p.errors.length, 1);
    assert.equal(p.errors[0].order_sn, 'O5');
    assert.match(p.errors[0].error, /logistics\.pickup_unavailable/);
    assert.match(p.errors[0].error, /Pickup tidak tersedia/);

    // run di DB
    const run = repo.getRun(run_id);
    assert.equal(run.status, 'partial');
    assert.equal(run.kind, 'process');
    assert.equal(run.part, 'p1');
    assert.ok(run.finished_at >= run.started_at);
    assert.equal(run.summary.ok, 5);
    assert.ok(run.summary.by_group['instant-tg-jkt']);
    assert.equal(run.summary.by_group['instant-tg-jkt'].ok, 2);

    // order
    for (const sn of ['O1', 'O2', 'O3', 'O4', 'O6']) {
      const o = repo.getOrder(sn);
      assert.equal(o.proc_status, 'processed', sn);
      assert.equal(o.proc_run_id, run_id);
      assert.ok(o.processed_at, sn);
      assert.equal(o.pdf_stale, false);
      assert.equal(o.last_error, null);
    }
    assert.equal(repo.getOrder('O1').tracking_number, 'TRKO1');
    assert.equal(repo.getOrder('O3').tracking_number, 'TRK-ADA', 'resi yang sudah ada tidak ditanya lagi');
    assert.equal(repo.getOrder('O1').order_status, 'PROCESSED', 'setelah arrange, status lokal jadi PROCESSED');
    const o5 = repo.getOrder('O5');
    assert.equal(o5.proc_status, 'failed');
    assert.match(o5.last_error, /Pickup tidak tersedia/);

    // shopee dipanggil sesuai status
    assert.deepEqual(shopee1.calls.arrange.map((c) => c.order_sn).sort(), ['O1', 'O2', 'O4', 'O5'], 'hanya READY_TO_SHIP yang di-arrange');
    assert.equal(shopee1.calls.arrange.find((c) => c.order_sn === 'O4').warehouse, 'sby', 'setting gudang order diteruskan');
    assert.ok(!shopee1.calls.tracking.includes('O3'));
    assert.ok(shopee1.calls.create.some((c) => c.order_sn === 'O3'), 'dokumen "already exist" dianggap ok');
    assert.equal(shopee1.calls.create.find((c) => c.order_sn === 'O1').shipping_document_type, 'NORMAL_AIR_WAYBILL');
    assert.equal(shopee1.calls.create.find((c) => c.order_sn === 'O1').tracking_number, 'TRKO1');
    assert.ok(shopee1.calls.result.filter((s) => s === 'O1').length >= 2, 'polling sampai READY');
    assert.deepEqual(shopee1.calls.download.sort(), ['O1', 'O2', 'O3', 'O4', 'O6']);

    // run_orders
    const ros = repo.listRunOrders(run_id);
    assert.equal(ros.length, 6);
    const ro1 = ros.find((r) => r.order_sn === 'O1');
    assert.equal(ro1.status, 'ok'); assert.equal(ro1.stage, 'merged'); assert.equal(ro1.ship_type, 'instant'); assert.equal(ro1.warehouse_code, 'jkt');
    assert.equal(ro1.flags.tipe_belum_ditulis, true, 'flag TIPE BELUM DITULIS tersimpan di run_order');
    const ro5 = ros.find((r) => r.order_sn === 'O5');
    assert.equal(ro5.status, 'failed'); assert.equal(ro5.stage, 'shipping'); assert.match(ro5.error, /Pickup/);

    // pdf: 3 label (ins-tg-jkt, ins-hg-jkt, reg-tg-sby) + product list jkt & sby
    run1Pdfs = repo.listPdfs(run_id);
    const labels = run1Pdfs.filter((x) => x.kind === 'labels');
    const lists = run1Pdfs.filter((x) => x.kind === 'productlist');
    assert.equal(labels.length, 3);
    assert.equal(lists.length, 2);
    assert.equal(p.pdfs.length, 5);
    const d = time.ddmmyyyy(run.started_at);
    assert.deepEqual(labels.map((x) => x.file_name).sort(), [`${d}-p1-ins-hg-jkt.pdf`, `${d}-p1-ins-tg-jkt.pdf`, `${d}-p1-reg-tg-sby.pdf`]);
    assert.deepEqual(lists.map((x) => x.file_name).sort(), [`${d}-p1-productlist-jkt.pdf`, `${d}-p1-productlist-sby.pdf`]);
    for (const x of run1Pdfs) {
      assert.ok(fs.existsSync(x.file_path), `file ada: ${x.file_path}`);
      assert.ok(path.resolve(x.file_path).startsWith(path.resolve(config.PDF_DIR)), 'file di dalam PDF_DIR');
      assert.equal(path.basename(path.dirname(x.file_path)), String(run_id));
      assert.equal(x.status, 'ok');
      assert.ok(x.size_bytes > 500);
      assert.ok(x.page_count >= 2);
      assert.equal(fs.statSync(x.file_path).size, x.size_bytes);
    }
    const insTg = labels.find((x) => x.sku_category === 'tg' && x.ship_type === 'instant');
    assert.deepEqual(insTg.order_sns.sort(), ['O1', 'O2']);
    assert.equal(insTg.order_count, 2);
    assert.equal(insTg.page_count, 3, 'cover + 2 label');
    const doc = await PDFDocument.load(fs.readFileSync(insTg.file_path));
    assert.equal(doc.getPageCount(), 3);
    const plSby = lists.find((x) => x.warehouse_code === 'sby');
    assert.deepEqual(plSby.order_sns.sort(), ['O4', 'O6'], 'product list hanya dari order sukses');
    const plJkt = lists.find((x) => x.warehouse_code === 'jkt');
    assert.deepEqual(plJkt.order_sns.sort(), ['O1', 'O2', 'O3']);

    // activity log
    const act = repo.listActivity(10).find((a) => a.action === 'process_run' && String(a.target) === String(run_id));
    assert.ok(act, 'activity process_run dicatat');
    assert.equal(act.details.ok, 5);
    assert.equal(proc.getActiveRun().run_id, null);
  });

  test('getProgress rekonstruksi dari DB bila tidak ada di memori', () => {
    proc._internal.runs.delete(run1);
    const p = proc.getProgress(run1);
    assert.equal(p.reconstructed, true);
    assert.equal(p.status, 'partial');
    assert.equal(p.finished, true);
    assert.equal(p.total, 6);
    assert.equal(p.done, 6);
    assert.equal(p.errors.length, 1);
    assert.equal(p.pdfs.length, 5);
    assert.equal(p.summary.ok, 5);
    assert.equal(proc.getProgress(999999), null);
  });

  test('getRunDetail mengembalikan run, progress, orders + summary, pdfs', () => {
    const d = proc.getRunDetail(run1);
    assert.equal(d.run.id, run1);
    assert.equal(d.orders.length, 6);
    const o1 = d.orders.find((o) => o.order_sn === 'O1');
    assert.equal(o1.status, 'ok');
    assert.equal(o1.summary.order_sn, 'O1');
    assert.equal(o1.summary.proc_status, 'processed');
    assert.ok(Array.isArray(o1.summary.items));
    assert.equal(d.pdfs.length, 5);
    assert.equal(proc.getRunDetail(999999), null);
  });

  test('aggregateRows menggabungkan item per SKU/variasi', () => {
    const rows = proc._internal.aggregateRows(repo, ['O1', 'O2', 'O5']);
    const tg = rows.find((r) => r.sku === 'TG-IP15PM-CLR' && r.model_name === 'iPhone 15 Pro Max');
    assert.ok(tg);
    assert.equal(tg.qty, 4, 'O2 + O5 masing-masing qty 2');
    assert.equal(tg.order_count, 2);
    assert.equal(rows.find((r) => r.sku === 'HG-SAMS23U-MAT').qty, 1);
  });
});

describe('process.regenerate', () => {
  let run2;
  test('only_failed: proses ulang order gagal di run baru (kind regenerate)', async () => {
    const shopee = makeShopee(); // O5 kini sukses
    await assert.rejects(proc.regenerate({ run_id: 999999, only_failed: true, user: USER }, ctxWith(shopee)), (e) => e.status === 404);
    const { run_id } = await proc.regenerate({ run_id: run1, only_failed: true, user: USER }, ctxWith(shopee));
    run2 = run_id;
    assert.notEqual(run_id, run1);
    const p = await waitFinished(run_id);
    assert.equal(p.status, 'done');
    assert.equal(p.kind, 'regenerate');
    assert.equal(p.summary.ok, 1);
    const run = repo.getRun(run_id);
    assert.equal(run.kind, 'regenerate');
    assert.equal(run.source_run_id, run1);
    assert.equal(run.status, 'done');
    const o5 = repo.getOrder('O5');
    assert.equal(o5.proc_status, 'processed');
    assert.equal(o5.proc_run_id, run_id);
    assert.equal(o5.last_error, null);
    assert.deepEqual(shopee.calls.arrange.map((c) => c.order_sn), ['O5'], 'order_status dibaca ulang: masih READY_TO_SHIP -> arrange');
    const pdfs = repo.listPdfs(run_id);
    assert.equal(pdfs.filter((x) => x.kind === 'labels').length, 1);
    assert.equal(pdfs.find((x) => x.kind === 'labels').sku_category, 'mix');
    assert.equal(pdfs.filter((x) => x.kind === 'productlist').length, 1);
    assert.equal(pdfs.find((x) => x.kind === 'productlist').warehouse_code, 'sby');
    // pdf lama run1 tidak disentuh
    assert.ok(repo.listPdfs(run1).every((x) => x.status === 'ok'));
    // tidak ada lagi order gagal -> 400
    await assert.rejects(proc.regenerate({ run_id: run1, only_failed: true, user: USER }, ctxWith(makeShopee())), (e) => e.status === 400);
  });

  test('pdf_ids: bangun ulang PDF dari order sukses, PDF lama superseded', async () => {
    const shopee = makeShopee();
    const target = run1Pdfs.find((x) => x.kind === 'labels' && x.sku_category === 'tg' && x.ship_type === 'instant');
    await assert.rejects(proc.regenerate({ run_id: run1, pdf_ids: [999999], user: USER }, ctxWith(shopee)), (e) => e.status === 400);
    const { run_id } = await proc.regenerate({ run_id: run1, pdf_ids: [target.id], user: USER }, ctxWith(shopee));
    const p = await waitFinished(run_id);
    assert.equal(p.status, 'done');
    assert.equal(p.summary.ok, 2);
    assert.deepEqual(shopee.calls.arrange, [], 'order sudah PROCESSED -> tidak di-arrange lagi');
    assert.deepEqual(shopee.calls.download.sort(), ['O1', 'O2'], 'label diunduh ulang');
    const old = repo.getPdf(target.id);
    assert.equal(old.status, 'superseded');
    assert.match(old.stale_reason, new RegExp(`run #${run_id}`));
    const pdfs = repo.listPdfs(run_id);
    assert.equal(pdfs.length, 1, 'hanya label yang dipilih (product list lama masih berlaku)');
    assert.equal(pdfs[0].kind, 'labels');
    assert.deepEqual(pdfs[0].order_sns.sort(), ['O1', 'O2']);
    assert.ok(fs.existsSync(pdfs[0].file_path));
    assert.equal(repo.getOrder('O1').proc_status, 'processed');
    assert.equal(repo.getOrder('O1').proc_run_id, run_id);
    const ros = repo.listRunOrders(run_id);
    assert.equal(ros.length, 2);
    assert.ok(ros.every((r) => r.status === 'ok' && r.stage === 'merged'));
  });

  test('tanpa only_failed & pdf_ids: semua PDF run sumber dibuat ulang', async () => {
    const shopee = makeShopee();
    const { run_id } = await proc.regenerate({ run_id: run2, user: USER }, ctxWith(shopee));
    const p = await waitFinished(run_id);
    assert.equal(p.status, 'done');
    const pdfs = repo.listPdfs(run_id);
    assert.equal(pdfs.filter((x) => x.kind === 'labels').length, 1);
    assert.equal(pdfs.filter((x) => x.kind === 'productlist').length, 1);
    assert.ok(repo.listPdfs(run2).every((x) => x.status === 'superseded'), 'semua pdf run sumber superseded');
  });
});

describe('process.cancelRun', () => {
  test('order yang belum mulai dilewati (skipped) dan dikembalikan ke unprocessed', async () => {
    for (const sn of ['O7', 'O8', 'O9']) { repo.upsertOrder(orderRow(sn)); derive(sn, { ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt' }); }
    const gate = makeGate();
    const shopee = makeShopee({ gate });
    const settings = settingsMapped({ process: { concurrency: 1 } });
    assert.equal(proc.cancelRun(999999), false);
    const { run_id } = await proc.startRun({ part: 'p1', warehouse: 'jkt', order_sns: ['O7', 'O8', 'O9'], user: USER }, ctxWith(shopee, { settings }));
    const first = await gate.reached; // order pertama sedang di arrangeShipment
    assert.equal(proc.cancelRun(run_id), true);
    assert.equal(proc.getProgress(run_id).cancel_requested, true);
    gate.release();
    const p = await waitFinished(run_id);
    assert.equal(p.status, 'partial');
    assert.equal(p.summary.ok, 1);
    assert.equal(p.summary.skipped, 2);
    assert.equal(p.summary.cancelled, true);
    assert.equal(repo.getOrder(first).proc_status, 'processed');
    const others = ['O7', 'O8', 'O9'].filter((sn) => sn !== first);
    for (const sn of others) {
      const o = repo.getOrder(sn);
      assert.equal(o.proc_status, 'unprocessed', sn);
      assert.equal(o.proc_run_id, null);
      const ro = repo.listRunOrders(run_id).find((r) => r.order_sn === sn);
      assert.equal(ro.status, 'skipped');
      assert.equal(ro.error, 'Dibatalkan pengguna');
    }
    assert.equal(proc.cancelRun(run_id), false, 'run sudah selesai');
  });
});

describe('process: run yang terputus (orphan) dipulihkan', () => {
  test('run running di DB tanpa state memori -> failed', () => {
    const run = repo.createRun({ part: 'p1', warehouse_filter: 'all', kind: 'process', user: USER });
    repo.upsertOrder(orderRow('O10'));
    repo.upsertRunOrder(run.id, 'O10', { stage: 'shipping', status: 'pending' });
    repo.setOrderProc('O10', { proc_status: 'processing', proc_run_id: run.id });
    const n = proc.recoverOrphans(repo);
    assert.equal(n, 1);
    assert.equal(repo.getRun(run.id).status, 'failed');
    assert.equal(repo.getOrder('O10').proc_status, 'failed');
    assert.equal(repo.listRunOrders(run.id)[0].status, 'failed');
    assert.equal(proc.getActiveRun().run_id, null);
  });
});

describe('route /api/process & /api/history', () => {
  let server; let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    app.use('/api/process', require('../src/routes/process'));
    app.use('/api/history', require('../src/routes/history'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => { res.status(err.status || 500).json({ error: err.code || 'internal_error', message: err.message, details: err.details }); });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((r) => server.close(r)));
  const get = (p) => fetch(base + p);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  test('history: daftar run, detail, pdf terbaru, activity, sync-logs', async () => {
    let r = await get('/api/history/runs?limit=50');
    assert.equal(r.status, 200);
    let j = await r.json();
    assert.ok(j.total >= 4);
    assert.ok(j.items.some((x) => x.id === run1 && x.pdf_count === 5 && x.order_count === 6));
    r = await get('/api/history/runs?kind=regenerate');
    j = await r.json();
    assert.ok(j.items.length >= 3 && j.items.every((x) => x.kind === 'regenerate'));
    r = await get('/api/history/runs?kind=salah');
    assert.equal(r.status, 400);
    r = await get(`/api/history/runs/${run1}`);
    j = await r.json();
    assert.equal(j.run.id, run1);
    assert.equal(j.orders.length, 6);
    assert.ok(j.orders[0].summary);
    assert.equal(j.pdfs.length, 5);
    assert.equal(j.progress.status, 'partial');
    r = await get('/api/history/runs/999999');
    assert.equal(r.status, 404);
    r = await get('/api/history/pdfs/recent?limit=3');
    j = await r.json();
    assert.equal(j.items.length, 3);
    r = await get('/api/history/activity?limit=5');
    j = await r.json();
    assert.ok(j.items.length >= 1 && j.items.length <= 5);
    r = await get('/api/history/sync-logs');
    j = await r.json();
    assert.equal(j.items.length, 1);
  });

  test('history: unduh & lihat PDF, 404 file hilang, tolak path traversal', async () => {
    const pdfRow = run1Pdfs.find((x) => x.kind === 'labels');
    let r = await get(`/api/history/pdfs/${pdfRow.id}/download`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="${pdfRow.file_name}"`);
    assert.equal(Number(r.headers.get('content-length')), pdfRow.size_bytes);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, pdfRow.size_bytes);
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
    r = await get(`/api/history/pdfs/${pdfRow.id}/view`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), `inline; filename="${pdfRow.file_name}"`);
    await r.arrayBuffer();
    r = await get(`/api/history/pdfs/${pdfRow.id}`);
    assert.equal((await r.json()).pdf.file_exists, true);
    r = await get('/api/history/pdfs/999999/download');
    assert.equal(r.status, 404);
    r = await get('/api/history/pdfs/abc/download');
    assert.equal(r.status, 400);
    // file hilang
    const gone = repo.createPdf({ run_id: run1, kind: 'labels', file_name: 'hilang.pdf', file_path: path.join(config.PDF_DIR, String(run1), 'hilang.pdf'), part: 'p1', warehouse_code: 'jkt', order_sns: [] });
    r = await get(`/api/history/pdfs/${gone.id}/download`);
    assert.equal(r.status, 404);
    // path traversal: file_path di luar PDF_DIR
    const outside = path.join(config.STORAGE_DIR, 'glasspro.db');
    const evil = repo.createPdf({ run_id: run1, kind: 'labels', file_name: 'jahat.pdf', file_path: outside, part: 'p1', warehouse_code: 'jkt', order_sns: [] });
    r = await get(`/api/history/pdfs/${evil.id}/download`);
    assert.equal(r.status, 403);
    const evil2 = repo.createPdf({ run_id: run1, kind: 'labels', file_name: 'jahat2.pdf', file_path: path.join(config.PDF_DIR, '..', 'glasspro.db'), part: 'p1', warehouse_code: 'jkt', order_sns: [] });
    r = await get(`/api/history/pdfs/${evil2.id}/view`);
    assert.equal(r.status, 403);
    const { safePdfPath } = require('../src/routes/history');
    assert.equal(safePdfPath('../x.pdf'), null);
    assert.equal(safePdfPath(''), null);
    assert.ok(safePdfPath(path.join(config.PDF_DIR, '1', 'a.pdf')));
  });

  test('process: active, progress, detail, cancel, regenerate validasi', async () => {
    let r = await get('/api/process/active');
    assert.deepEqual(await r.json(), { run_id: null, kind: null });
    r = await get(`/api/process/runs/${run1}/progress`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'partial');
    r = await get('/api/process/runs/999999/progress');
    assert.equal(r.status, 404);
    r = await get(`/api/process/runs/${run1}`);
    let j = await r.json();
    assert.equal(j.orders.length, 6);
    r = await post(`/api/process/runs/${run1}/cancel`);
    j = await r.json();
    assert.equal(j.ok, false);
    r = await post(`/api/process/runs/${run1}/regenerate`, { pdf_ids: 'x' });
    assert.equal(r.status, 400);
    r = await post('/api/process/run', { order_sns: 'bukan-array' });
    assert.equal(r.status, 400);
    r = await get('/api/process/preview?part=p9');
    assert.equal(r.status, 400);
  });

  test('process: preview lewat route (modul preview asli bila ada)', { skip: !previewMod && 'engine/preview belum ada' }, async () => {
    const r = await get('/api/process/preview?part=p1&warehouse=all');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.part, 'p1');
    assert.ok(Array.isArray(j.groups));
    assert.ok(j.sync);
  });
});
