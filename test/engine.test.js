'use strict';
// Test mesin klasifikasi/validasi/preview (AGENT ENGINE).
// STORAGE_DIR harus diset SEBELUM require modul src apa pun.
const path = require('path');
const fs = require('fs');
const TMP = path.resolve(__dirname, '..', '.tmp', `engine-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;
process.env.SHOPEE_TRANSPORT = 'mock';

const { test, after, describe } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS } = require('../src/settings-defaults');
const time = require('../src/util/time');
const classify = require('../src/engine/classify');
const validate = require('../src/engine/validate');
const part = require('../src/engine/part');
const naming = require('../src/engine/naming');
const preview = require('../src/engine/preview');

// Setting uji: gudang sudah dipetakan (jkt=JKT-001, sby=SBY-001)
function settingsMapped(extra = {}) {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  s.warehouses = [
    { code: 'jkt', name: 'Jakarta', location_ids: ['JKT-001'], warehouse_ids: [], pickup_address_id: null, is_default: true },
    { code: 'sby', name: 'Surabaya', location_ids: ['SBY-001'], warehouse_ids: [], pickup_address_id: null, is_default: false },
  ];
  return { ...s, ...extra };
}
const S = settingsMapped();

// WIB = UTC+7 → jam WIB h:m pada 15 Sep 2026
const wib = (h, m = 0) => Math.floor(Date.UTC(2026, 8, 15, h - 7, m, 0) / 1000);

const item = (over = {}) => ({
  item_id: 1, item_name: 'Tempered Glass Full Cover', item_sku: 'TG-IP15PM-CLR', model_id: 11, model_name: 'iPhone 15 Pro Max', model_sku: null,
  qty: 1, price: 25000, product_location_id: 'JKT-001', order_item_id: 1, image_url: null, ...over,
});
const order = (over = {}) => ({
  order_sn: 'SN-TEST', shop_id: 999001, marketplace: 'shopee', order_status: 'READY_TO_SHIP', proc_status: 'unprocessed',
  create_time: 1000, update_time: 1000, ship_by_date: null, shipping_carrier: 'GrabExpress Instant', checkout_shipping_carrier: null,
  note: null, message_to_seller: null, cod: false, items: [item()], overrides: {}, ...over,
});

// ---------------------------------------------------------------------------
describe('classify.categorizeSku', () => {
  test('mode token', () => {
    assert.equal(classify.categorizeSku('TG-IP15PM-CLR', S), 'tg');
    assert.equal(classify.categorizeSku('HG-SAMS23U-MAT', S), 'hg');
    assert.equal(classify.categorizeSku('hg_sams23u', S), 'hg', 'case-insensitive + pemisah _');
    assert.equal(classify.categorizeSku('GP-UNIV-PROMO', S), null);
    assert.equal(classify.categorizeSku('TGX-123', S), null, 'token mode: TGX bukan token TG');
    assert.equal(classify.categorizeSku('', S), null);
    assert.equal(classify.categorizeSku(null, S), null);
    assert.equal(classify.categorizeSku('TG-HG-COMBO', S), 'conflict');
  });
  test('mode contains & regex', () => {
    const sc = settingsMapped({ sku_rules: { ...S.sku_rules, match_mode: 'contains' } });
    assert.equal(classify.categorizeSku('TGX-123', sc), 'tg');
    assert.equal(classify.categorizeSku('xhgx', sc), 'hg');
    const sr = settingsMapped({ sku_rules: { ...S.sku_rules, match_mode: 'regex', tg_patterns: ['^TG\\d'], hg_patterns: ['^HG\\d', '['] } });
    assert.equal(classify.categorizeSku('TG9-ABC', sr), 'tg');
    assert.equal(classify.categorizeSku('TG-ABC', sr), null);
    assert.equal(classify.categorizeSku('HG1', sr), 'hg', 'regex tidak valid diabaikan');
  });
  test('item: model_sku dulu lalu item_sku', () => {
    assert.equal(classify.categorizeSku({ model_sku: 'HG-X', item_sku: 'TG-Y' }, S), 'hg');
    assert.equal(classify.categorizeSku({ model_sku: '', item_sku: 'TG-Y' }, S), 'tg');
    assert.equal(classify.categorizeItem({ model_sku: null, item_sku: null }, S), null);
  });
});

describe('classify.detectShipType', () => {
  test('instant vs regular', () => {
    assert.equal(classify.detectShipType('GrabExpress Instant', S), 'instant');
    assert.equal(classify.detectShipType('GoSend Same Day', S), 'instant');
    assert.equal(classify.detectShipType('SPX Standard', S), 'regular');
    assert.equal(classify.detectShipType('J&T Express', S), 'regular');
    assert.equal(classify.detectShipType(null, S), 'regular');
  });
  test('fallback checkout_shipping_carrier', () => {
    const d = classify.classifyOrder(order({ shipping_carrier: null, checkout_shipping_carrier: 'SPX Instant' }), S);
    assert.equal(d.ship_type, 'instant');
  });
});

describe('classify.mapWarehouse', () => {
  test('pemetaan location_ids & warehouse_ids', () => {
    assert.equal(classify.mapWarehouse(['JKT-001'], S), 'jkt');
    assert.equal(classify.mapWarehouse(['SBY-001'], S), 'sby');
    assert.equal(classify.mapWarehouse(['XXX'], S), null, 'semua gudang terpetakan → tidak ada default');
    const sw = settingsMapped();
    sw.warehouses[1].location_ids = []; sw.warehouses[1].warehouse_ids = [12345];
    assert.equal(classify.mapWarehouse(['12345'], sw), 'sby', 'warehouse_ids dibandingkan sebagai string');
  });
  test('default hanya jika satu gudang belum dipetakan dan is_default', () => {
    const sd = settingsMapped();
    sd.warehouses[0].location_ids = []; // jkt kosong + default, sby terpetakan
    assert.equal(classify.mapWarehouse(['XXX'], sd), 'jkt');
    assert.equal(classify.mapWarehouse([], sd), 'jkt');
    assert.equal(classify.mapWarehouse(['JKT-001'], DEFAULTS), null, 'setting default: dua gudang kosong → null');
    const snd = settingsMapped();
    snd.warehouses[0].location_ids = []; snd.warehouses[0].is_default = false;
    assert.equal(classify.mapWarehouse(['XXX'], snd), null, 'satu gudang kosong tapi bukan default → null');
  });
  test('item beda gudang → gudang item pertama + warning WAREHOUSE_MIXED', () => {
    const o = order({ items: [item({ product_location_id: 'SBY-001' }), item({ product_location_id: 'JKT-001', item_sku: 'HG-A' })] });
    const d = classify.classifyOrder(o, S);
    assert.equal(d.warehouse_code, 'sby');
    assert.equal(d.warehouse_mixed, true);
    const v = validate.validateOrder(o, d, S, { now: 1000 });
    assert.ok(validate.hasWarning(v, 'WAREHOUSE_MIXED'));
  });
});

describe('classify.extractPhoneType', () => {
  test('sumber berurutan variasi → catatan → pesan', () => {
    assert.deepEqual(classify.extractPhoneType(order(), item(), S), { value: 'iPhone 15 Pro Max', source: 'model_name' });
    const generic = item({ model_name: 'Universal (tulis tipe di catatan)' });
    assert.deepEqual(classify.extractPhoneType(order({ note: '  Samsung A54 ' }), generic, S), { value: 'Samsung A54', source: 'note' });
    assert.deepEqual(classify.extractPhoneType(order({ message_to_seller: 'Xiaomi 13T' }), generic, S), { value: 'Xiaomi 13T', source: 'message_to_seller' });
    assert.deepEqual(classify.extractPhoneType(order(), generic, S), { value: null, source: null });
    assert.deepEqual(classify.extractPhoneType(order(), item({ model_name: 'X' }), S), { value: null, source: null }, 'panjang < 2 diabaikan');
    assert.deepEqual(classify.extractPhoneType(order(), item({ model_name: 'Tipe HP Lainnya' }), S), { value: null, source: null });
  });
  test('override phone_type menang', () => {
    const d = classify.classifyOrder(order({ items: [item({ model_name: 'Universal' })], overrides: { phone_type: 'Oppo A78' } }), S);
    assert.equal(d.phone_type.value, 'Oppo A78');
    assert.equal(d.phone_type.source, 'override');
    assert.equal(d.phone_type.missing, false);
  });
});

describe('classify.classifyOrder', () => {
  test('kategori order tg/hg/mix/review', () => {
    assert.equal(classify.classifyOrder(order(), S).sku_category, 'tg');
    assert.equal(classify.classifyOrder(order({ items: [item({ item_sku: 'HG-A' }), item({ item_sku: 'HG-B' })] }), S).sku_category, 'hg');
    assert.equal(classify.classifyOrder(order({ items: [item(), item({ item_sku: 'HG-A' })] }), S).sku_category, 'mix');
    assert.equal(classify.classifyOrder(order({ items: [item(), item({ item_sku: 'GP-UNIV-PROMO' })] }), S).sku_category, 'review');
    assert.equal(classify.classifyOrder(order({ items: [item({ item_sku: 'TG-HG-X' })] }), S).sku_category, 'review', 'konflik → review');
    assert.equal(classify.classifyOrder(order({ items: [] }), S).sku_category, 'review');
    assert.equal(classify.classifyOrder(order({ items: null }), S).sku_category, 'review');
  });
  test('override sku_category & warehouse_code', () => {
    const d = classify.classifyOrder(order({ items: [item({ item_sku: 'GP-UNIV', product_location_id: null })], overrides: { sku_category: 'hg', warehouse_code: 'sby' } }), S);
    assert.equal(d.sku_category, 'hg');
    assert.equal(d.warehouse_code, 'sby');
    assert.equal(d.items[0].category, null, 'kategori item tetap apa adanya');
  });
  test('phone_type tingkat order & item', () => {
    const d = classify.classifyOrder(order({ items: [item(), item({ item_sku: 'HG-A', model_name: 'Samsung S23' }), item({ item_sku: 'GP-PROMO', model_name: 'Universal' })] }), S);
    assert.equal(d.items[0].phone_type_required, true);
    assert.equal(d.items[2].phone_type_required, false, 'item tanpa kategori tidak wajib tipe HP');
    assert.deepEqual(d.phone_type, { value: 'iPhone 15 Pro Max, Samsung S23', source: 'model_name', required: true, missing: false });
    const s2 = settingsMapped({ sku_rules: { ...S.sku_rules, require_phone_type: { mode: 'none', patterns: [] } } });
    assert.equal(classify.classifyOrder(order({ items: [item({ model_name: 'Universal' })] }), s2).phone_type.required, false);
  });
});

// ---------------------------------------------------------------------------
describe('validate.validateOrder', () => {
  const now = 1_800_000_000;
  const run = (o, ctx = {}) => {
    const d = classify.classifyOrder(o, S);
    return validate.validateOrder(o, d, S, { now, ...ctx });
  };
  const codes = (v) => v.holds.map((h) => h.code);

  test('order bersih: tanpa hold', () => {
    const v = run(order({ ship_by_date: now + 48 * 3600 }));
    assert.deepEqual(codes(v), []);
    assert.equal(v.flags.needs_review, false);
    assert.equal(v.flags.deadline_hours_left, 48);
    assert.equal(run(order()).flags.deadline_hours_left, null);
  });
  test('PHONE_TYPE_MISSING vs pengecualian deadline < 5 jam', () => {
    const o = order({ items: [item({ model_name: 'Universal (tulis tipe di catatan)' })], ship_by_date: now + 30 * 3600 });
    const v = run(o);
    assert.deepEqual(codes(v), ['PHONE_TYPE_MISSING']);
    assert.equal(v.flags.tipe_belum_ditulis, false);
    const v2 = run({ ...o, ship_by_date: now + 3 * 3600 });
    assert.deepEqual(codes(v2), []);
    assert.ok(validate.hasWarning(v2, 'DEADLINE_EXCEPTION'));
    assert.ok(validate.hasWarning(v2, 'DEADLINE_NEAR'));
    assert.equal(v2.flags.tipe_belum_ditulis, true);
    assert.equal(v2.flags.deadline_hours_left, 3);
    const v3 = run({ ...o, ship_by_date: null });
    assert.deepEqual(codes(v3), ['PHONE_TYPE_MISSING'], 'tanpa ship_by_date tidak ada pengecualian');
  });
  test('SKU_UNKNOWN / WAREHOUSE_UNKNOWN → needs_review', () => {
    const v = run(order({ items: [item({ item_sku: 'GP-UNIV', product_location_id: 'ZZZ' })] }));
    assert.deepEqual(codes(v), ['SKU_UNKNOWN', 'WAREHOUSE_UNKNOWN']);
    assert.equal(v.flags.needs_review, true);
  });
  test('p3 regular → REGULAR_WAIT_P1, instant tidak', () => {
    assert.deepEqual(codes(run(order({ shipping_carrier: 'J&T Express' }), { part: 'p3' })), ['REGULAR_WAIT_P1']);
    assert.deepEqual(codes(run(order({ shipping_carrier: 'J&T Express' }), { part: 'p1' })), []);
    assert.deepEqual(codes(run(order(), { part: 'p3' })), []);
  });
  test('status order & proses', () => {
    assert.deepEqual(codes(run(order({ order_status: 'CANCELLED' }))), ['CANCELLED']);
    assert.deepEqual(codes(run(order({ order_status: 'IN_CANCEL' }))), ['CANCELLED']);
    assert.deepEqual(codes(run(order({ order_status: 'SHIPPED' }))), ['STATUS_NOT_READY']);
    assert.deepEqual(codes(run(order({ order_status: 'PROCESSED' }))), []);
    assert.deepEqual(codes(run(order({ proc_status: 'processed' }))), ['ALREADY_PROCESSED']);
    assert.deepEqual(codes(run(order(), { activeRunOrderSns: new Set(['SN-TEST']) })), ['IN_PROGRESS']);
    assert.deepEqual(codes(run(order(), { activeRunOrderSns: new Set(['LAIN']) })), []);
  });
  test('overrides excluded & force_process', () => {
    assert.deepEqual(codes(run(order({ overrides: { excluded: true } }))), ['EXCLUDED']);
    const o = order({ items: [item({ model_name: 'Universal' })], overrides: { force_process: true } });
    assert.deepEqual(codes(run({ ...o, overrides: {} })), ['PHONE_TYPE_MISSING']);
    const v = run(o);
    assert.deepEqual(codes(v), [], 'force_process menghapus PHONE_TYPE_MISSING');
    assert.ok(validate.hasWarning(v, 'FORCED'));
    assert.equal(v.flags.tipe_belum_ditulis, true);
    const o2 = order({ items: [item({ item_sku: 'GP-UNIV' })], overrides: { force_process: true } });
    const v2 = run(o2);
    assert.deepEqual(codes(v2), [], 'force_process menghapus SKU_UNKNOWN');
    assert.equal(v2.flags.needs_review, false);
    const o3 = order({ items: [item({ item_sku: 'GP-UNIV', product_location_id: null })], overrides: { force_process: true } });
    assert.deepEqual(codes(run(o3)), ['WAREHOUSE_UNKNOWN'], 'force tidak menghapus WAREHOUSE_UNKNOWN');
  });
  test('warning NOTE_PRESENT, COD, DEADLINE_NEAR', () => {
    const v = run(order({ note: 'tolong bubble wrap', cod: true, ship_by_date: now + 6 * 3600 }));
    assert.deepEqual(v.warnings.map((w) => w.code), ['DEADLINE_NEAR', 'NOTE_PRESENT', 'COD']);
    assert.deepEqual(codes(v), []);
  });
});

// ---------------------------------------------------------------------------
describe('part', () => {
  test('currentPart pada beberapa jam WIB', () => {
    const cp = (h, m) => part.currentPart(S, wib(h, m));
    assert.equal(cp(7, 0).part, 'p1');
    assert.equal(cp(7, 0).in_window, false);
    assert.equal(cp(9, 30).part, 'p1');
    assert.equal(cp(9, 30).in_window, true);
    assert.equal(cp(12, 0).part, 'p1');
    assert.equal(cp(12, 59).part, 'p1');
    assert.equal(cp(13, 0).part, 'p2');
    assert.equal(cp(13, 30).in_window, true);
    assert.equal(cp(14, 30).part, 'p2');
    assert.equal(cp(14, 30).in_window, false);
    assert.equal(cp(15, 0).part, 'p3');
    assert.equal(cp(15, 30).in_window, true);
    assert.equal(cp(20, 0).part, 'p3');
    assert.equal(cp(0, 5).part, 'p1');
    const r = cp(9, 30);
    assert.deepEqual(r.window, { start: '08:00', end: '10:00' });
    assert.equal(r.label, 'Part 1');
    assert.deepEqual(r.next, { part: 'p2', start: '13:00', tomorrow: false });
    assert.deepEqual(cp(16, 0).next, { part: 'p1', start: '08:00', tomorrow: true });
  });
  test('partWindow & setting kustom', () => {
    assert.deepEqual(part.partWindow(S, 'p2'), { part: 'p2', label: 'Part 2', start: '13:00', end: '14:00', start_min: 780, end_min: 840 });
    assert.equal(part.partWindow(S, 'p9'), null);
    const custom = settingsMapped({ parts: { ...S.parts, p2: { label: 'Siang', start: '11:00', end: '12:00' } } });
    assert.equal(part.currentPart(custom, wib(11, 30)).part, 'p2');
    assert.equal(part.currentPart(custom, wib(10, 59)).part, 'p1');
  });
});

describe('naming', () => {
  test('pdfFileName & groupKey & groupLabel', () => {
    const ts = wib(9, 0);
    assert.equal(naming.pdfFileName({ ts, part: 'p1', ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt', kind: 'labels' }), '15092026-p1-ins-tg-jkt.pdf');
    assert.equal(naming.pdfFileName({ ts, part: 'p2', ship_type: 'regular', sku_category: 'mix', warehouse_code: null }), '15092026-p2-reg-mix-all.pdf');
    assert.equal(naming.pdfFileName({ ts, part: 'p3', warehouse_code: 'sby', kind: 'productlist' }), '15092026-p3-productlist-sby.pdf');
    assert.equal(naming.groupKey({ ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt' }), 'instant-tg-jkt');
    assert.equal(naming.groupKey({ ship_type: 'regular', sku_category: 'hg', warehouse_code: null }), 'regular-hg-all');
    assert.equal(naming.groupLabel({ ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt' }, S), 'Instant/Same Day · TG · Jakarta');
    assert.equal(naming.groupLabel({ ship_type: 'regular', sku_category: 'mix', warehouse_code: 'all' }, S), 'Regular · Mix · Semua Gudang');
  });
});

// ---------------------------------------------------------------------------
describe('preview (DB sementara)', () => {
  const db = require('../src/db');
  const repo = require('../src/db/repo');
  db.open();
  repo.setSetting('warehouses', S.warehouses);
  const now = time.now();
  const far = now + 48 * 3600;

  const mk = (sn, over = {}, items = [item()]) => repo.upsertOrder({
    order_sn: sn, shop_id: 999001, marketplace: 'shopee', order_status: 'READY_TO_SHIP', create_time: now - 3600, update_time: now - 3600,
    ship_by_date: far, shipping_carrier: 'GrabExpress Instant', buyer_username: 'buyer', recipient_name: 'Penerima ' + sn, recipient_address: 'Jl. Uji',
    cod: false, total_amount: 50000, currency: 'IDR', items, packages: [], raw: {}, ...over,
  });
  const hgItem = item({ item_id: 2, item_name: 'Hydrogel Matte', item_sku: 'HG-SAMS23U-MAT', model_name: 'Samsung S23 Ultra', price: 30000 });
  const universal = item({ model_name: 'Universal (tulis tipe di catatan)' });

  mk('O1', {}, [item({ qty: 2 })]);                                                  // instant-tg-jkt
  mk('O2', { shipping_carrier: 'SPX Instant' }, [hgItem]);                            // instant-hg-jkt
  mk('O3', { shipping_carrier: 'J&T Express', note: 'Xiaomi 13T' }, [item({ item_sku: 'TG-XIA13T', model_name: 'Universal', product_location_id: 'SBY-001' })]); // regular-tg-sby
  mk('O4', { shipping_carrier: 'JNE Reguler' }, [item(), hgItem]);                    // regular-mix-jkt
  mk('O5', { shipping_carrier: 'GoSend Same Day' }, [item({ item_sku: 'GP-UNIV-PROMO', item_name: 'Promo' })]); // review SKU_UNKNOWN
  mk('O6', { shipping_carrier: 'SPX Standard' }, [universal]);                        // held PHONE_TYPE_MISSING
  mk('O7', { ship_by_date: now + 3 * 3600 }, [universal]);                            // instant-tg-jkt, TIPE BELUM DITULIS
  mk('O8', { order_status: 'PROCESSED', shipping_carrier: 'SPX Instant' }, [item({ model_name: 'iPhone 14' })]); // excluded
  repo.setOverrides('O8', { excluded: true });
  mk('O9', { order_status: 'CANCELLED' });                                           // tidak ikut preview
  mk('O10', {}, [item({ product_location_id: 'UNKNOWN-9' })]);                        // review WAREHOUSE_UNKNOWN
  mk('O11', { shipping_carrier: 'J&T Express' }, [item({ item_sku: 'TG-OPPOA78', model_name: 'Oppo A78', product_location_id: 'SBY-001' })]); // regular-tg-sby
  mk('O12', { proc_status: 'x' });                                                    // proc_status tidak dipakai upsert; sudah processed diset manual
  repo.setOrderProc('O12', { proc_status: 'processed', processed_at: now });

  after(() => {
    try { db.close(); } catch { /* abaikan */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* file mungkin masih terkunci di Windows */ }
  });

  test('blocked: NOT_CONNECTED → NO_SYNC → SYNC_FAILED → null', () => {
    let p = preview.buildPreview({ part: 'p1', warehouse: 'all' }, { now });
    assert.equal(p.blocked.code, 'NOT_CONNECTED');
    repo.upsertShop({ shop_id: 999001, shop_name: 'Glass Pro Official (Mock)', authorized_at: now, status: 'connected' });
    p = preview.buildPreview({ part: 'p1' }, { now });
    assert.equal(p.blocked.code, 'NO_SYNC');
    assert.equal(p.sync.ok, false);
    const id1 = repo.startSyncLog({ trigger: 'manual' });
    repo.finishSyncLog(id1, { status: 'ok', fetched: 5 });
    const id2 = repo.startSyncLog({ trigger: 'auto' });
    repo.finishSyncLog(id2, { status: 'failed', error: 'timeout' });
    p = preview.buildPreview({ part: 'p1' }, { now });
    assert.equal(p.blocked.code, 'SYNC_FAILED');
    assert.match(p.blocked.message, /timeout/);
    assert.equal(p.sync.last_status, 'failed');
    const id3 = repo.startSyncLog({ trigger: 'auto' });
    repo.finishSyncLog(id3, { status: 'ok', fetched: 5 });
    p = preview.buildPreview({ part: 'p1' }, { now });
    assert.equal(p.blocked, null);
    assert.equal(p.sync.ok, true);
    assert.equal(p.sync.stale, false);
    assert.equal(preview.buildPreview({ part: 'p1' }, { now: now + 3 * 3600 }).sync.stale, true, 'stale jika > 2×interval');
  });

  test('buildPreview p1/all: grouping, held, review, excluded, product_list, totals', () => {
    const p = preview.buildPreview({ part: 'p1', warehouse: 'all' }, { now });
    assert.equal(p.part, 'p1');
    assert.equal(p.warehouse, 'all');
    assert.ok(p.part_auto && ['p1', 'p2', 'p3'].includes(p.part_auto.part));
    assert.deepEqual(p.groups.map((g) => g.key), ['instant-tg-jkt', 'instant-hg-jkt', 'regular-tg-sby', 'regular-mix-jkt']);
    const g1 = p.groups[0];
    assert.deepEqual(g1.orders.map((o) => o.order_sn), ['O7', 'O1'], 'urut ship_by_date terdekat dulu');
    assert.equal(g1.label, 'Instant/Same Day · TG · Jakarta');
    assert.equal(g1.file_name, `${time.ddmmyyyy(now)}-p1-ins-tg-jkt.pdf`);
    assert.equal(g1.qty_total, 3);
    const o7 = g1.orders.find((o) => o.order_sn === 'O7');
    assert.equal(o7.validation.flags.tipe_belum_ditulis, true);
    assert.equal(o7.deadline_hours_left, 3);
    assert.equal(o7.phone_type.missing, true);
    const o3 = p.groups[2].orders.find((o) => o.order_sn === 'O3');
    assert.equal(o3.phone_type.value, 'Xiaomi 13T');
    assert.equal(o3.phone_type.source, 'note');
    assert.equal(o3.items[0].phone_type, 'Xiaomi 13T');

    assert.deepEqual(p.held.map((o) => o.order_sn), ['O6']);
    assert.deepEqual(p.held[0].reasons.map((r) => r.code), ['PHONE_TYPE_MISSING']);
    assert.deepEqual(p.review.map((o) => o.order_sn).sort(), ['O10', 'O5']);
    assert.deepEqual(p.review.find((o) => o.order_sn === 'O5').reasons.map((r) => r.code), ['SKU_UNKNOWN']);
    assert.deepEqual(p.excluded.map((o) => o.order_sn), ['O8']);
    const all = [...p.groups.flatMap((g) => g.orders), ...p.held, ...p.review, ...p.excluded].map((o) => o.order_sn);
    assert.ok(!all.includes('O9'), 'CANCELLED tidak ikut');
    assert.ok(!all.includes('O12'), 'processed tidak ikut tanpa include_processed');

    assert.equal(p.totals.orders, 6);
    assert.equal(p.totals.products, 8);
    assert.deepEqual(p.totals.by_category, { tg: 4, hg: 1, mix: 1 });
    assert.deepEqual(p.totals.by_ship_type, { instant: 3, regular: 3 });
    assert.deepEqual(p.totals.by_warehouse, { jkt: 4, sby: 2 });
    assert.deepEqual(p.totals.by_marketplace, { shopee: 6 });
    assert.equal(p.totals.held, 1); assert.equal(p.totals.review, 2); assert.equal(p.totals.excluded, 1);

    const row = p.product_list.find((r) => r.sku === 'TG-IP15PM-CLR' && r.model_name === 'iPhone 15 Pro Max');
    assert.deepEqual(row, { marketplace: 'shopee', sku: 'TG-IP15PM-CLR', item_name: 'Tempered Glass Full Cover', model_name: 'iPhone 15 Pro Max', category: 'tg', qty: 3, order_count: 2 });
    assert.equal(p.product_list.filter((r) => r.category === 'hg').length, 1);
    assert.equal(p.product_list.find((r) => r.sku === 'HG-SAMS23U-MAT').order_count, 2);
    assert.ok(!p.product_list.some((r) => r.sku === 'GP-UNIV-PROMO'), 'order review tidak masuk product list');
    assert.ok(p.product_list.every((r, i, a) => i === 0 || (a[i - 1].category === 'tg' || r.category !== 'tg')), 'tg lebih dulu');
    assert.equal(p.product_list_file_name, `${time.ddmmyyyy(now)}-p1-productlist-all.pdf`);

    // Hasil klasifikasi tersimpan di DB & proc_status review disetel
    const stored = repo.getOrder('O5');
    assert.equal(stored.sku_category, 'review');
    assert.equal(stored.proc_status, 'review');
    assert.equal(repo.getOrder('O1').proc_status, 'unprocessed');
    assert.equal(repo.getOrder('O1').ship_type, 'instant');
    assert.equal(repo.getOrder('O1').validation.holds.length, 0);
  });

  test('p3: regular ditahan REGULAR_WAIT_P1', () => {
    const p = preview.buildPreview({ part: 'p3', warehouse: 'all' }, { now });
    assert.deepEqual(p.groups.map((g) => g.key), ['instant-tg-jkt', 'instant-hg-jkt']);
    assert.deepEqual(p.held.map((o) => o.order_sn).sort(), ['O11', 'O3', 'O4', 'O6']);
    assert.deepEqual(p.held.find((o) => o.order_sn === 'O3').reasons.map((r) => r.code), ['REGULAR_WAIT_P1']);
    assert.deepEqual(p.held.find((o) => o.order_sn === 'O6').reasons.map((r) => r.code), ['PHONE_TYPE_MISSING', 'REGULAR_WAIT_P1']);
  });

  test('filter gudang sby: order jkt disembunyikan, gudang null tetap di review', () => {
    const p = preview.buildPreview({ part: 'p1', warehouse: 'sby' }, { now });
    assert.deepEqual(p.groups.map((g) => g.key), ['regular-tg-sby']);
    assert.deepEqual(p.review.map((o) => o.order_sn), ['O10']);
    assert.deepEqual(p.held, []);
    assert.deepEqual(p.excluded, []);
    assert.equal(p.warehouse_name, 'Surabaya');
  });

  test('mode merge & include_processed & activeRunOrderSns & part auto', () => {
    const merged = { ...repo.getSettings(), process: { ...DEFAULTS.process, all_warehouses_mode: 'merge' } };
    const p = preview.buildPreview({ part: 'p1', warehouse: 'all', include_processed: true }, { now, settings: merged, activeRunOrderSns: new Set(['O2']) });
    assert.deepEqual(p.groups.map((g) => g.key), ['instant-tg-all', 'regular-tg-all', 'regular-mix-all']);
    assert.equal(p.groups[0].file_name, `${time.ddmmyyyy(now)}-p1-ins-tg-all.pdf`);
    assert.ok(p.held.some((o) => o.order_sn === 'O12' && o.reasons[0].code === 'ALREADY_PROCESSED'));
    assert.ok(p.held.some((o) => o.order_sn === 'O2' && o.reasons[0].code === 'IN_PROGRESS'));
    const auto = preview.buildPreview({ part: 'auto' }, { now: wib(13, 30) });
    assert.equal(auto.part, 'p2');
    assert.equal(auto.part_auto.in_window, true);
    assert.throws(() => preview.buildPreview({ part: 'p9' }, { now }), /Part tidak dikenal/);
    assert.throws(() => preview.buildPreview({ warehouse: 'bdg' }, { now }), /Gudang tidak dikenal/);
  });

  test('overrides: force_process & sku_category memindahkan order dari review ke grup', () => {
    repo.setOverrides('O5', { sku_category: 'tg' });
    let p = preview.buildPreview({ part: 'p1' }, { now });
    assert.ok(p.groups[0].orders.some((o) => o.order_sn === 'O5'), 'O5 masuk instant-tg-jkt');
    assert.equal(repo.getOrder('O5').proc_status, 'unprocessed', 'review → unprocessed');
    repo.setOverrides('O5', { sku_category: null, force_process: true });
    p = preview.buildPreview({ part: 'p1' }, { now });
    const o5 = p.groups.flatMap((g) => g.orders).find((o) => o.order_sn === 'O5');
    assert.ok(o5, 'force_process: masuk grup meski SKU_UNKNOWN');
    assert.equal(o5.sku_category, 'review');
    assert.ok(o5.validation.warnings.some((w) => w.code === 'FORCED'));
    repo.setOverrides('O5', { force_process: null });
  });

  test('reclassifyAll', () => {
    repo.setOrderProc('O10', { proc_status: 'unprocessed' });
    const r = preview.reclassifyAll({ now });
    assert.equal(r.count, 11, '12 order dikurangi O12 (processed); O9 CANCELLED masih proc_status unprocessed → ikut');
    assert.equal(repo.getOrder('O10').proc_status, 'review');
    assert.equal(repo.getOrder('O5').proc_status, 'review');
    assert.equal(repo.getOrder('O9').validation.holds[0].code, 'CANCELLED');
    assert.equal(repo.getOrder('O11').validation.holds.length, 0, 'tanpa part: tidak ada REGULAR_WAIT_P1 tersimpan');
    repo.setOverrides('O10', { warehouse_code: 'jkt' });
    preview.reclassifyAll({ now });
    assert.equal(repo.getOrder('O10').proc_status, 'unprocessed');
    assert.equal(repo.getOrder('O10').warehouse_code, 'jkt');
  });

  test('toSummary', () => {
    const s = preview.toSummary(repo.getOrder('O7'), now);
    assert.equal(s.order_sn, 'O7');
    assert.equal(s.deadline_hours_left, 3);
    assert.equal(s.item_count, 1);
    assert.equal(s.qty_total, 1);
    assert.equal(s.cod, false);
    assert.equal(s.pdf_stale, false);
    assert.deepEqual(Object.keys(s.items[0]).sort(), ['category', 'image_url', 'item_name', 'item_sku', 'model_name', 'model_sku', 'phone_type', 'phone_type_required', 'qty']);
    for (const k of ['marketplace', 'order_status', 'proc_status', 'shipping_carrier', 'ship_type', 'sku_category', 'warehouse_code', 'phone_type', 'validation', 'overrides', 'tracking_number', 'proc_run_id', 'processed_at', 'last_error']) {
      assert.ok(k in s, `field ${k} ada`);
    }
    const empty = preview.toSummary({ order_sn: 'X' });
    assert.equal(empty.deadline_hours_left, null);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.validation.holds.length, 0);
  });
});
