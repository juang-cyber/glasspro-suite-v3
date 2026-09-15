'use strict';
// Test route /api/sync, /api/orders, /api/dashboard, /api/settings lewat server HTTP sungguhan (port 3124).
const path = require('path');
const fs = require('fs');

const TMP = path.join(__dirname, '..', '.tmp', `routes-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;
process.env.SHOPEE_TRANSPORT = 'mock';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/index');
const db = require('../src/db');
const repo = require('../src/db/repo');
const config = require('../src/config');

const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;
const NOW = Math.floor(Date.now() / 1000);
const SN = 'TEST-ORDER-001';
let server;

// Sesi HTTP sederhana dengan cookie
class Session {
  constructor() { this.cookies = new Map(); }
  async req(method, p, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.cookies.size) headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq); const val = pair.slice(eq + 1);
      if (val === '') this.cookies.delete(name); else this.cookies.set(name, val);
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  patch(p, b) { return this.req('PATCH', p, b || {}); }
  del(p) { return this.req('DELETE', p); }
  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.user;
  }
}

function orderRow(sn, extra = {}) {
  return {
    order_sn: sn, shop_id: 999001, marketplace: 'shopee', order_status: 'READY_TO_SHIP',
    create_time: NOW - 3600, update_time: NOW - 1800, ship_by_date: NOW + 86400, shipping_carrier: 'GrabExpress Instant',
    buyer_username: 'pembeli', recipient_name: 'Siti', recipient_phone: '0812', recipient_address: 'Jl. Melati 2, Surabaya', note: '', message_to_seller: '',
    cod: false, total_amount: 75000, currency: 'IDR',
    items: [{ item_id: 2, item_name: 'HG Samsung', item_sku: 'HG-SAMS23U-MAT', model_id: 22, model_name: 'Samsung S23 Ultra', model_sku: 'HG-SAMS23U-MAT', qty: 2, price: 37500, product_location_id: 'SBY-001', order_item_id: 222, image_url: null }],
    packages: [], tracking_number: null, package_number: 'PKG-2', raw: { order_sn: sn, apa: 'saja' },
    ...extra,
  };
}

const admin = new Session();
const staff = new Session();
let staffUser;

before(async () => {
  assert.equal(config.STORAGE_DIR, TMP);
  const app = createApp();
  await new Promise((resolve, reject) => { server = app.listen(PORT, '127.0.0.1', resolve); server.on('error', reject); });
  repo.upsertOrder(orderRow(SN));
  repo.upsertOrder(orderRow('TEST-ORDER-002', { shipping_carrier: 'JNE Reguler' }));
  await admin.login('admin', 'glasspro123');
});

after(async () => {
  try { require('../src/engine/sync').stopScheduler(); } catch { /* abaikan */ }
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* abaikan */ }
});

test('tanpa login -> 401', async () => {
  const anon = new Session();
  for (const p of ['/api/orders', '/api/dashboard', '/api/settings', '/api/sync/status']) {
    const r = await anon.get(p);
    assert.equal(r.status, 401, p);
    assert.equal(r.json.error, 'unauthorized');
  }
});

test('GET /api/orders -> 200 dengan items, total, counts', async () => {
  const r = await admin.get('/api/orders');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.items));
  assert.equal(r.json.total, 2);
  assert.equal(r.json.counts.total, 2);
  assert.equal(r.json.counts.byProc.unprocessed, 2);
  const it = r.json.items.find((o) => o.order_sn === SN);
  assert.ok(it);
  assert.equal(it.proc_status, 'unprocessed');
  assert.equal(it.item_count, 1);
  assert.equal(it.qty_total, 2);
  assert.equal(it.raw_json, undefined);

  const r2 = await admin.get('/api/orders?proc_status=unprocessed&warehouse=all&category=all&stale=0&limit=1&page=2&sort=create_time&dir=asc&q=TEST-ORDER');
  assert.equal(r2.status, 200);
  assert.equal(r2.json.items.length, 1);
  assert.equal(r2.json.page, 2);
  assert.equal(r2.json.limit, 1);
  assert.equal(r2.json.total, 2);

  const r3 = await admin.get('/api/orders?stale=1');
  assert.equal(r3.json.total, 0);
});

test('GET /api/orders/:sn -> detail + raw; 404 jika tidak ada', async () => {
  const r = await admin.get(`/api/orders/${SN}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.order.order_sn, SN);
  assert.equal(r.json.raw.apa, 'saja');
  assert.ok(Array.isArray(r.json.run_orders));
  assert.ok(Array.isArray(r.json.pdfs));
  const nf = await admin.get('/api/orders/TIDAK-ADA');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error, 'not_found');
});

test('PATCH /api/orders/:sn/overrides -> validasi 400 dan sukses 200', async () => {
  const bad = [
    { sku_category: 'xx' }, { warehouse_code: 'bdg' }, { excluded: 'yes' }, { force_process: 1 },
    { note: 'x'.repeat(501) }, { phone_type: 'y'.repeat(101) }, { phone_type: 123 }, { tidak_dikenal: true }, {},
  ];
  for (const body of bad) {
    const r = await admin.patch(`/api/orders/${SN}/overrides`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'bad_request');
    assert.ok(r.json.message);
  }
  const nf = await admin.patch('/api/orders/TIDAK-ADA/overrides', { sku_category: 'tg' });
  assert.equal(nf.status, 404);

  const ok = await admin.patch(`/api/orders/${SN}/overrides`, { sku_category: 'TG', warehouse_code: 'sby', note: ' catatan ', excluded: false, phone_type: 'iPhone 15' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.order.order_sn, SN);
  assert.equal(ok.json.order.overrides.sku_category, 'tg');
  assert.equal(ok.json.order.overrides.warehouse_code, 'sby');
  assert.equal(ok.json.order.overrides.note, 'catatan');
  assert.equal(ok.json.order.overrides.excluded, false);
  assert.equal(ok.json.order.overrides.phone_type, 'iPhone 15');
  // Hapus override dengan null
  const rm = await admin.patch(`/api/orders/${SN}/overrides`, { note: null, phone_type: '' });
  assert.equal(rm.status, 200);
  assert.equal(rm.json.order.overrides.note, undefined);
  assert.equal(rm.json.order.overrides.phone_type, undefined);
  assert.equal(rm.json.order.overrides.sku_category, 'tg');
  const act = repo.listActivity(5).find((a) => a.action === 'order_override');
  assert.ok(act && act.target === SN);
});

test('POST /api/orders/:sn/reclassify -> 200', async () => {
  const r = await admin.post(`/api/orders/${SN}/reclassify`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.order.order_sn, SN);
});

test('POST /api/orders/:sn/reset (admin) -> kembali unprocessed', async () => {
  repo.setOrderProc(SN, { proc_status: 'processed', proc_run_id: 7, processed_at: NOW, last_error: 'x', pdf_stale: 1 });
  const r = await admin.post(`/api/orders/${SN}/reset`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const o = repo.getOrder(SN);
  assert.ok(['unprocessed', 'review'].includes(o.proc_status));
  assert.equal(o.proc_run_id, null);
  assert.equal(o.processed_at, null);
  assert.equal(o.last_error, null);
  assert.equal(o.pdf_stale, false);
  const nf = await admin.post('/api/orders/TIDAK-ADA/reset');
  assert.equal(nf.status, 404);
});

test('GET /api/dashboard -> 200 dengan kpis, parts, sync, shopee', async () => {
  const r = await admin.get('/api/dashboard');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json;
  for (const k of ['unprocessed', 'review', 'held', 'processed_today', 'failed', 'instant_pending', 'stale_pdf']) assert.equal(typeof d.kpis[k], 'number', k);
  assert.equal(d.kpis.unprocessed + d.kpis.review, 2);
  assert.equal(d.parts.length, 3);
  assert.deepEqual(d.parts.map((p) => p.key), ['p1', 'p2', 'p3']);
  for (const p of d.parts) {
    assert.ok(['done', 'active', 'upcoming'].includes(p.status));
    assert.ok(Array.isArray(p.run_ids));
    assert.equal(typeof p.processed_count, 'number');
    assert.match(p.start, /^\d{2}:\d{2}$/);
  }
  assert.ok(Array.isArray(d.recent_runs));
  assert.ok(Array.isArray(d.orders_per_day));
  assert.ok(Array.isArray(d.recent_activity));
  assert.deepEqual(Object.keys(d.by_category).sort(), ['hg', 'mix', 'review', 'tg']);
  assert.deepEqual(Object.keys(d.by_ship_type).sort(), ['instant', 'regular']);
  assert.ok('jkt' in d.by_warehouse && 'sby' in d.by_warehouse && 'unknown' in d.by_warehouse);
  assert.equal(typeof d.shopee.connected, 'boolean');
  assert.equal(typeof d.sync.running, 'boolean');
  assert.ok(d.sync.marketplaces.shopee);
});

test('GET /api/sync/status, /logs, POST /now', async () => {
  const st = await admin.get('/api/sync/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.running, false);
  assert.equal(typeof st.json.interval_minutes, 'number');
  assert.ok(['ok', 'failed', 'never'].includes(st.json.marketplaces.shopee.status));

  const now = await admin.post('/api/sync/now');
  assert.equal(now.status, 200, JSON.stringify(now.json));
  assert.ok(['ok', 'failed'].includes(now.json.status));
  assert.ok(now.json.sync_log_id > 0);
  if (now.json.status === 'failed') assert.equal(typeof now.json.error, 'string');

  const logs = await admin.get('/api/sync/logs?limit=5');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.items));
  assert.equal(logs.json.items[0].id, now.json.sync_log_id);
  assert.ok(repo.listActivity(5).some((a) => a.action === 'sync_manual'));
});

test('GET/PUT /api/settings (admin): validasi, merge, masking diabaikan', async () => {
  const g = await admin.get('/api/settings');
  assert.equal(g.status, 200);
  assert.ok('shopee.partner_key' in g.json);
  assert.ok(Array.isArray(g.json.warehouses));
  assert.deepEqual(g.json.meta.transport_options, ['direct', 'bridge', 'mock']);
  assert.ok(g.json.meta.document_types.includes('NORMAL_AIR_WAYBILL'));
  assert.ok(g.json.meta.delivery_methods.includes('auto'));
  assert.equal(g.json.meta.warehouses_live, null);
  assert.equal(g.json['shopee.transport'], 'mock');

  const bad = [
    { foo: 1 },
    {},
    { sync: { interval_minutes: 0 } },
    { sync: { lookback_days: 'x' } },
    { cancel_rule: { threshold_hours: -1 } },
    { parts: { p1: { start: '8am' } } },
    { parts: { p1: { start: '11:00', end: '10:00' } } },
    { warehouses: [{ code: 'jkt' }, { code: 'jkt' }] },
    { warehouses: [] },
    { warehouses: [{ code: 'all' }] },
    { 'shopee.transport': 'ftp' },
    { 'shopee.env': 'staging' },
    { process: { concurrency: 99 } },
    { sku_rules: { match_mode: 'fuzzy' } },
    { sku_rules: { match_mode: 'regex', tg_patterns: ['('] } },
  ];
  for (const body of bad) {
    const r = await admin.req('PUT', '/api/settings', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, 'bad_request');
  }

  // Merge parsial objek: lookback_days tetap
  const ok = await admin.req('PUT', '/api/settings', { sync: { interval_minutes: 10 }, cancel_rule: { threshold_hours: 4.5 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.settings.sync.interval_minutes, 10);
  assert.equal(ok.json.settings.sync.lookback_days, 7);
  assert.equal(ok.json.settings.sync.enabled, true);
  assert.equal(ok.json.settings.cancel_rule.threshold_hours, 4.5);
  assert.equal(repo.getSettings().sync.interval_minutes, 10);

  // Parts & gudang
  const p = await admin.req('PUT', '/api/settings', {
    parts: { p1: { start: '08:30' } },
    warehouses: [
      { code: 'JKT', name: 'Jakarta', location_ids: ['JKT-001', 'JKT-001'], warehouse_ids: ['12'], is_default: true },
      { code: 'sby', name: '', location_ids: ['SBY-001'] },
    ],
  });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.settings.parts.p1.start, '08:30');
  assert.equal(p.json.settings.parts.p1.end, '10:00');
  assert.equal(p.json.settings.parts.p2.start, '13:00');
  assert.deepEqual(p.json.settings.warehouses[0], { code: 'jkt', name: 'Jakarta', location_ids: ['JKT-001'], warehouse_ids: [12], pickup_address_id: null, is_default: true });
  assert.equal(p.json.settings.warehouses[1].name, 'SBY');
  assert.equal(p.json.settings.warehouses[1].is_default, false);

  // Partner key: admin dapat nilai penuh; nilai ter-mask diabaikan
  const key = 'shpk1234567890abcdef786f';
  const k1 = await admin.req('PUT', '/api/settings', { 'shopee.partner_key': key, 'shopee.partner_id': '12345' });
  assert.equal(k1.status, 200);
  assert.equal(k1.json.settings['shopee.partner_key'], key);
  assert.equal(k1.json.settings['shopee.partner_id'], 12345);
  const k2 = await admin.req('PUT', '/api/settings', { 'shopee.partner_key': 'shpk****786f' });
  assert.equal(k2.status, 200);
  assert.deepEqual(k2.json.skipped, ['shopee.partner_key']);
  assert.equal(repo.getSettings()['shopee.partner_key'], key);
  const g2 = await admin.get('/api/settings');
  assert.equal(g2.json['shopee.partner_key'], key);

  // Aktivitas tercatat tanpa nilai rahasia
  const act = repo.listActivity(20).filter((a) => a.action === 'settings_update');
  assert.ok(act.length >= 3);
  assert.ok(!JSON.stringify(act).includes(key));
});

test('users CRUD (admin)', async () => {
  const bad = [
    { username: 'ab', password: 'rahasia1' },
    { username: 'Staf Satu', password: 'rahasia1' },
    { username: 'staf1', password: '123' },
    { username: 'staf1', password: 'rahasia1', role: 'boss' },
  ];
  for (const body of bad) {
    const r = await admin.post('/api/settings/users', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const c = await admin.post('/api/settings/users', { username: 'STAF1', password: 'rahasia1', name: 'Staf Satu', role: 'staff' });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  staffUser = c.json.user;
  assert.equal(staffUser.username, 'staf1');
  assert.equal(staffUser.role, 'staff');
  assert.equal(staffUser.active, true);
  assert.equal(staffUser.password_hash, undefined);

  const dup = await admin.post('/api/settings/users', { username: 'staf1', password: 'rahasia1' });
  assert.equal(dup.status, 409);

  const list = await admin.get('/api/settings/users');
  assert.equal(list.status, 200);
  assert.ok(list.json.users.some((u) => u.username === 'staf1'));
  assert.ok(list.json.users.every((u) => u.password_hash === undefined));

  const up = await admin.patch(`/api/settings/users/${staffUser.id}`, { name: 'Staf Baru', password: 'rahasia2' });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.user.name, 'Staf Baru');
  assert.equal((await admin.patch(`/api/settings/users/${staffUser.id}`, {})).status, 400);
  assert.equal((await admin.patch(`/api/settings/users/${staffUser.id}`, { password: '12' })).status, 400);
  assert.equal((await admin.patch('/api/settings/users/99999', { name: 'x' })).status, 404);
  assert.equal((await admin.patch('/api/settings/users/abc', { name: 'x' })).status, 400);

  // Tidak boleh menonaktifkan / menghapus / menurunkan diri sendiri (admin id 1)
  const me = (await admin.get('/api/auth/me')).json.user;
  assert.equal((await admin.patch(`/api/settings/users/${me.id}`, { active: false })).status, 400);
  assert.equal((await admin.patch(`/api/settings/users/${me.id}`, { role: 'staff' })).status, 400);
  assert.equal((await admin.del(`/api/settings/users/${me.id}`)).status, 400);
  assert.equal((await admin.del('/api/settings/users/99999')).status, 404);
});

test('staff: partner key ter-mask, PUT settings & users & reset -> 403', async () => {
  const u = await staff.login('staf1', 'rahasia2');
  assert.equal(u.role, 'staff');
  const g = await staff.get('/api/settings');
  assert.equal(g.status, 200);
  assert.equal(g.json['shopee.partner_key'], 'shpk****786f');
  assert.ok(g.json.meta);
  assert.equal((await staff.req('PUT', '/api/settings', { sync: { interval_minutes: 3 } })).status, 403);
  assert.equal((await staff.get('/api/settings/users')).status, 403);
  assert.equal((await staff.post('/api/settings/users', { username: 'x1y2', password: 'rahasia1' })).status, 403);
  assert.equal((await staff.post(`/api/orders/${SN}/reset`)).status, 403);
  assert.equal((await staff.get('/api/orders')).status, 200);
  assert.equal((await staff.get('/api/dashboard')).status, 200);
  assert.equal((await staff.patch(`/api/orders/${SN}/overrides`, { force_process: true })).status, 200);
  assert.equal(repo.getSettings().sync.interval_minutes, 10);
});

test('admin menghapus staff -> sesi staff tidak berlaku lagi', async () => {
  const d = await admin.del(`/api/settings/users/${staffUser.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.json.ok, true);
  assert.equal((await staff.get('/api/auth/me')).status, 401);
  assert.equal((await admin.get('/api/settings/users')).json.users.some((x) => x.id === staffUser.id), false);
});
