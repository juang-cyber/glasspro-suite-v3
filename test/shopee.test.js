'use strict';
// Test modul Shopee: sign, siklus penuh transport mock, transport bridge (server http palsu),
// bridge router, ensureToken, dan route /api/shopee lewat server HTTP sungguhan (port acak).
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const TMP = path.join(__dirname, '..', '.tmp', `shopee-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;
process.env.SHOPEE_TRANSPORT = 'mock';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repo');
const { sign, buildRequest, HOSTS } = require('../src/shopee/sign');
const shopeeMod = require('../src/shopee');
const { ShopeeError } = shopeeMod;
const bridgeRouter = require('../src/bridge/router');
const shopeeRoutes = require('../src/routes/shopee');

const MOCK_SHOP = 999001;
const NOW = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(() => r()));
let shopee;

before(() => {
  db.open();
  repo.ensureSeeded();
  repo.setSettings({ 'shopee.transport': 'mock' });
  shopee = shopeeMod.create();
});

after(() => {
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* file WAL bisa masih terkunci di Windows */ }
});

// ---------- sign ----------
describe('sign', () => {
  test('deterministik, hex 64 huruf kecil, public vs shop berbeda', () => {
    const base = { partner_id: 2001887, partner_key: 'kunci-uji', path: '/api/v2/shop/get_shop_info', timestamp: 1655714431 };
    const pub1 = sign(base);
    const pub2 = sign(base);
    assert.equal(pub1, pub2);
    assert.match(pub1, /^[0-9a-f]{64}$/);
    assert.equal(pub1, crypto.createHmac('sha256', 'kunci-uji').update('2001887/api/v2/shop/get_shop_info1655714431').digest('hex'));
    const shopSig = sign({ ...base, access_token: '59777174636562737266615546704c6d', shop_id: 14701711 });
    assert.notEqual(shopSig, pub1);
    assert.equal(shopSig, crypto.createHmac('sha256', 'kunci-uji').update('2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711').digest('hex'));
    assert.notEqual(sign({ ...base, partner_key: 'kunci-lain' }), pub1);
    assert.throws(() => sign({ ...base, partner_key: '' }), /partner_key/);
  });

  test('buildRequest POST: common params di query string, body JSON', () => {
    const b = buildRequest({ env: 'live', partner_id: 1, partner_key: 'k', path: '/api/v2/logistics/ship_order', method: 'POST', body: { order_sn: 'X' }, access_token: 'tok', shop_id: 5, timestamp: 1700000000 });
    const u = new URL(b.url);
    assert.equal(u.origin, HOSTS.live);
    assert.equal(u.pathname, '/api/v2/logistics/ship_order');
    for (const k of ['partner_id', 'timestamp', 'sign', 'access_token', 'shop_id']) assert.ok(u.searchParams.get(k), `query ${k} kosong`);
    assert.equal(u.searchParams.get('sign'), b.sign);
    assert.equal(u.searchParams.get('shop_id'), '5');
    assert.equal(b.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(b.body), { order_sn: 'X' });
    assert.equal(b.query.sign, sign({ partner_id: 1, partner_key: 'k', path: '/api/v2/logistics/ship_order', timestamp: 1700000000, access_token: 'tok', shop_id: 5 }));

    const g = buildRequest({ env: 'test', partner_id: 1, partner_key: 'k', path: '/api/v2/order/get_order_list', query: { order_status: 'READY_TO_SHIP', page_size: 100, kosong: '' } });
    const gu = new URL(g.url);
    assert.equal(gu.origin, HOSTS.test);
    assert.equal(g.body, undefined);
    assert.equal(gu.searchParams.get('page_size'), '100');
    assert.equal(gu.searchParams.get('kosong'), null);
    assert.equal(gu.searchParams.get('access_token'), null, 'API publik tidak membawa access_token');
  });
});

// ---------- siklus mock ----------
describe('siklus transport mock', () => {
  let rows = [];
  let instantSn = null;
  let regularSn = null;
  const pkgOf = {};

  test('getAuthUrl mock mengarah ke callback lokal', () => {
    assert.match(shopee.getAuthUrl(), /\/api\/shopee\/callback\?code=mock&shop_id=999001$/);
  });

  test('exchangeCode menyimpan toko + status() rapi tanpa token', async () => {
    const shop = await shopee.exchangeCode({ code: 'mock', shop_id: MOCK_SHOP });
    assert.equal(shop.shop_id, MOCK_SHOP);
    const row = repo.getShop(MOCK_SHOP);
    assert.ok(row.access_token && row.refresh_token);
    assert.equal(row.status, 'connected');
    assert.equal(row.shop_name, 'Glass Pro Official (Mock)');
    assert.equal(row.region, 'ID');
    assert.ok(row.access_expire_at > NOW() + 3600);
    assert.ok(row.refresh_expire_at > NOW() + 20 * 86400);

    const st = shopee.status();
    assert.equal(st.configured, true);
    assert.equal(st.transport, 'mock');
    assert.ok(['live', 'test'].includes(st.env));
    const s = st.shops.find((x) => x.shop_id === MOCK_SHOP);
    assert.ok(s, 'toko mock ada di status().shops');
    for (const k of ['shop_id', 'shop_name', 'region', 'status', 'access_expire_at', 'refresh_expire_at', 'authorized_at', 'last_error']) assert.ok(k in s, `status().shops[] tanpa ${k}`);
    assert.equal(s.access_token, undefined);
    assert.equal(s.refresh_token, undefined);
    assert.equal(JSON.stringify(st).includes(row.access_token), false, 'status() membocorkan access_token');
  });

  test('exchangeCode menolak code kosong / shop_id bukan angka', async () => {
    await assert.rejects(shopee.exchangeCode({ code: '', shop_id: MOCK_SHOP }), (e) => e instanceof ShopeeError && e.status === 400);
    await assert.rejects(shopee.exchangeCode({ code: 'mock', shop_id: 'abc' }), (e) => e instanceof ShopeeError && e.status === 400);
    await assert.rejects(shopee.exchangeCode({ code: 'mock', shop_id: 123 }), (e) => e instanceof ShopeeError && e.code === 'invalid_shop_id');
  });

  test('fetchOrders READY_TO_SHIP+PROCESSED >= 20 OrderRow lengkap', async () => {
    const now = NOW();
    rows = await shopee.fetchOrders({ shop_id: MOCK_SHOP, statuses: ['READY_TO_SHIP', 'PROCESSED'], time_from: now - 7 * 86400, time_to: now, time_range_field: 'create_time' });
    assert.ok(rows.length >= 20, `hanya ${rows.length} order`);
    const sns = new Set();
    for (const r of rows) {
      assert.ok(!sns.has(r.order_sn), 'order_sn duplikat'); sns.add(r.order_sn);
      assert.equal(r.marketplace, 'shopee');
      assert.equal(r.shop_id, MOCK_SHOP);
      assert.ok(['READY_TO_SHIP', 'PROCESSED'].includes(r.order_status));
      assert.ok(Number.isInteger(r.create_time) && r.create_time > 0);
      assert.ok(Number.isInteger(r.ship_by_date) && r.ship_by_date > now, 'ship_by_date harus di masa depan');
      assert.ok(r.shipping_carrier, 'shipping_carrier kosong');
      assert.ok(r.checkout_shipping_carrier);
      assert.ok(Array.isArray(r.items) && r.items.length, 'items kosong');
      for (const it of r.items) {
        assert.ok(Number.isInteger(it.qty) && it.qty >= 1, 'qty item');
        assert.ok(['JKT-001', 'SBY-001'].includes(it.product_location_id), `product_location_id ${it.product_location_id}`);
        assert.ok(it.item_name);
        assert.equal(typeof it.model_sku, 'string');
      }
      assert.ok(Array.isArray(r.packages) && r.packages[0].package_number);
      assert.equal(r.package_number, r.packages[0].package_number);
      assert.ok(r.raw && r.raw.order_sn === r.order_sn);
      assert.ok(r.recipient_name && r.recipient_phone && r.recipient_address);
      assert.equal(typeof r.cod, 'boolean');
      assert.equal(r.currency, 'IDR');
    }
    // package_list Shopee tidak memuat tracking_number (kontrak: boleh null) -> ambil lewat getTrackingNumber
    const processed = rows.find((r) => r.order_status === 'PROCESSED');
    assert.ok(processed, 'harus ada order PROCESSED');
    assert.equal(processed.tracking_number, null);
    const tn = await shopee.getTrackingNumber({ shop_id: MOCK_SHOP, order_sn: processed.order_sn, package_number: processed.package_number });
    assert.ok(typeof tn === 'string' && tn.length > 5, 'order PROCESSED harus punya nomor resi');
    assert.ok(rows.some((r) => r.items.some((it) => it.item_sku === 'GP-UNIV-PROMO')), 'ada SKU tanpa kode (review)');
    assert.ok(rows.some((r) => r.ship_by_date - now < 5 * 3600), 'ada order dengan sisa < 5 jam');
    assert.ok(rows.some((r) => r.note) && rows.some((r) => r.message_to_seller));
    // rentang > 15 hari dipecah per jendela tanpa error dari mock
    const wide = await shopee.fetchOrders({ shop_id: MOCK_SHOP, statuses: ['READY_TO_SHIP'], time_from: now - 40 * 86400, time_to: now });
    assert.ok(wide.length >= 20);
  });

  test('arrangeShipment order instant -> pickup + tracking number', async () => {
    const o = rows.find((r) => r.order_status === 'READY_TO_SHIP' && /instant|same day/i.test(r.shipping_carrier) && !r.order_sn.endsWith('FAIL'));
    assert.ok(o, 'tidak ada order instant READY_TO_SHIP');
    const settings = repo.getSettings();
    const r = await shopee.arrangeShipment({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number, warehouse: settings.warehouses[0], settings });
    assert.equal(r.method, 'pickup');
    assert.ok(r.detail.address_id);
    assert.ok(r.detail.pickup_time_id);
    instantSn = o.order_sn; pkgOf[o.order_sn] = o.package_number;
    const [d] = await shopee.fetchOrderDetails({ shop_id: MOCK_SHOP, order_sns: [o.order_sn] });
    assert.equal(d.order_status, 'PROCESSED');
    assert.equal(d.packages[0].logistics_status, 'LOGISTICS_REQUEST_CREATED');
    const tn = await shopee.getTrackingNumber({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number });
    assert.equal(typeof tn, 'string');
    assert.match(tn, /^(GRAB|GSD|SPXID)\d{12}$/);
    // arrange ulang order yang sudah PROCESSED harus ditolak Shopee
    await assert.rejects(shopee.arrangeShipment({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number, warehouse: settings.warehouses[0], settings }), (e) => e instanceof ShopeeError && /status/i.test(e.code));
  });

  test('arrangeShipment regular SPX Standard -> dropoff', async () => {
    const o = rows.find((r) => r.order_status === 'READY_TO_SHIP' && r.shipping_carrier === 'SPX Standard');
    assert.ok(o, 'tidak ada order SPX Standard READY_TO_SHIP');
    const settings = repo.getSettings();
    const r = await shopee.arrangeShipment({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number, warehouse: settings.warehouses[0], settings });
    assert.equal(r.method, 'dropoff');
    regularSn = o.order_sn; pkgOf[o.order_sn] = o.package_number;
    assert.ok(await shopee.getTrackingNumber({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number }));
  });

  test('preferensi delivery_method dihormati bila tersedia', async () => {
    const o = rows.find((r) => r.order_status === 'READY_TO_SHIP' && r.shipping_carrier === 'SPX Instant' && !r.order_sn.endsWith('FAIL'));
    assert.ok(o);
    const settings = repo.getSettings();
    const r = await shopee.arrangeShipment({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number, warehouse: settings.warehouses[1], settings: { ...settings, process: { ...settings.process, delivery_method: 'dropoff' } } });
    assert.equal(r.method, 'dropoff');
  });

  test('dokumen: create -> result READY -> download Buffer PDF', async () => {
    const order_list = [instantSn, regularSn].map((sn) => ({ order_sn: sn, package_number: pkgOf[sn], shipping_document_type: 'NORMAL_AIR_WAYBILL' }));
    const created = await shopee.createShippingDocument({ shop_id: MOCK_SHOP, order_list });
    assert.equal(created.result_list.length, 2);
    for (const r of created.result_list) assert.ok(!r.fail_error, r.fail_message);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      const rr = await shopee.getShippingDocumentResult({ shop_id: MOCK_SHOP, order_list });
      assert.equal(rr.result_list.length, 2);
      assert.ok(rr.result_list.every((r) => ['READY', 'PROCESSING'].includes(r.status)), JSON.stringify(rr));
      ready = rr.result_list.every((r) => r.status === 'READY');
      if (!ready) await sleep(50);
    }
    assert.ok(ready, 'dokumen tidak pernah READY');
    const buf = await shopee.downloadShippingDocument({ shop_id: MOCK_SHOP, shipping_document_type: 'NORMAL_AIR_WAYBILL', order_list: order_list.map(({ order_sn, package_number }) => ({ order_sn, package_number })) });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.subarray(0, 4).toString('latin1'), '%PDF');
    assert.ok(buf.length > 1000);
  });

  test('dokumen untuk order yang belum di-arrange -> fail_error', async () => {
    const o = rows.find((r) => r.order_status === 'READY_TO_SHIP' && ![instantSn, regularSn].includes(r.order_sn) && r.shipping_carrier === 'J&T Express');
    assert.ok(o);
    const created = await shopee.createShippingDocument({ shop_id: MOCK_SHOP, order_list: [{ order_sn: o.order_sn, package_number: o.package_number, shipping_document_type: 'NORMAL_AIR_WAYBILL' }] });
    assert.ok(created.result_list[0].fail_error);
    await assert.rejects(shopee.downloadShippingDocument({ shop_id: MOCK_SHOP, shipping_document_type: 'NORMAL_AIR_WAYBILL', order_list: [{ order_sn: o.order_sn, package_number: o.package_number }] }), (e) => e instanceof ShopeeError);
  });

  test('order yang dirancang gagal melempar ShopeeError', async () => {
    const o = rows.find((r) => r.order_sn.endsWith('FAIL'));
    assert.ok(o, 'order *FAIL tidak ditemukan');
    const settings = repo.getSettings();
    await assert.rejects(
      shopee.arrangeShipment({ shop_id: MOCK_SHOP, order_sn: o.order_sn, package_number: o.package_number, warehouse: settings.warehouses[0], settings }),
      (e) => e instanceof ShopeeError && e.code === 'logistics.invalid_error' && !!e.request_id && e.status >= 400 && /pickup/i.test(e.message),
    );
    const [d] = await shopee.fetchOrderDetails({ shop_id: MOCK_SHOP, order_sns: [o.order_sn] });
    assert.equal(d.order_status, 'READY_TO_SHIP', 'order gagal tetap READY_TO_SHIP');
  });

  test('ensureToken: token kadaluarsa diperbarui, yang masih berlaku dibiarkan', async () => {
    const before = repo.getShop(MOCK_SHOP);
    repo.updateShop(MOCK_SHOP, { access_expire_at: NOW() - 10 });
    const refreshed = await shopee.ensureToken(MOCK_SHOP);
    assert.notEqual(refreshed.access_token, before.access_token);
    assert.notEqual(refreshed.refresh_token, before.refresh_token, 'refresh_token harus berotasi');
    assert.ok(refreshed.access_expire_at > NOW() + 3600);
    assert.equal(refreshed.status, 'connected');
    assert.ok(refreshed.last_refresh_at >= before.last_refresh_at);
    const same = await shopee.ensureToken(MOCK_SHOP);
    assert.equal(same.access_token, refreshed.access_token, 'token yang masih berlaku tidak boleh di-refresh');
    // token yang dicabut di sisi Shopee -> refresh otomatis saat call
    repo.updateShop(MOCK_SHOP, { access_token: 'mockat_dicabut' });
    const info = await shopee.getShopInfo(MOCK_SHOP);
    assert.equal(info.shop_name, 'Glass Pro Official (Mock)');
    assert.notEqual(repo.getShop(MOCK_SHOP).access_token, 'mockat_dicabut');
  });

  test('refresh_token kadaluarsa -> status expired + ShopeeError', async () => {
    const keep = repo.getShop(MOCK_SHOP);
    repo.updateShop(MOCK_SHOP, { refresh_token: 'expired-rt', access_expire_at: NOW() - 10 });
    await assert.rejects(shopee.ensureToken(MOCK_SHOP), (e) => e instanceof ShopeeError && e.code === 'refresh_token_expired');
    assert.equal(repo.getShop(MOCK_SHOP).status, 'expired');
    assert.match(repo.getShop(MOCK_SHOP).last_error, /Refresh token gagal/);
    repo.updateShop(MOCK_SHOP, { refresh_token: keep.refresh_token, access_token: keep.access_token, access_expire_at: keep.access_expire_at, status: 'connected', last_error: null });
  });

  test('testConnection, getShopInfo, getWarehouses', async () => {
    const r = await shopee.testConnection(MOCK_SHOP);
    assert.equal(r.ok, true);
    assert.equal(r.shop_name, 'Glass Pro Official (Mock)');
    assert.ok(Number.isFinite(r.latency_ms) && r.latency_ms >= 0);
    const info = await shopee.getShopInfo(MOCK_SHOP);
    assert.equal(info.region, 'ID');
    assert.equal(info.error, undefined);
    const w = await shopee.getWarehouses(MOCK_SHOP);
    assert.deepEqual(w.map((x) => x.location_id).sort(), ['JKT-001', 'SBY-001']);
    assert.ok(w.every((x) => x.warehouse_id && x.warehouse_name && x.address_id));
    // tanpa shop_id -> toko utama
    assert.equal((await shopee.testConnection()).shop_id, MOCK_SHOP);
  });

  test('token ditolak tapi pemanggil lain sudah refresh -> pakai token baru tanpa rotasi ulang', async () => {
    const mock = require('../src/shopee/mock');
    const real = repo.getShop(MOCK_SHOP);
    assert.ok(real && real.access_token);
    // repo tiruan: getShop pertama mengembalikan token basi (seolah dibaca sebelum pemanggil lain me-refresh)
    let calls = 0;
    const repoProxy = new Proxy(repo, {
      get(t, k) {
        if (k === 'getShop') return (id) => { calls++; return calls === 1 ? { ...t.getShop(id), access_token: 'mockat_basi' } : t.getShop(id); };
        return t[k];
      },
    });
    const inst = shopeeMod.create({ repo: repoProxy });
    const refreshBefore = mock.state.calls['/api/v2/auth/access_token/get'] || 0;
    const info = await inst.getShopInfo(MOCK_SHOP);
    assert.equal(info.shop_name, 'Glass Pro Official (Mock)');
    assert.equal(mock.state.calls['/api/v2/auth/access_token/get'] || 0, refreshBefore, 'tidak boleh refresh ulang');
    assert.equal(repo.getShop(MOCK_SHOP).access_token, real.access_token, 'token di DB tidak boleh berubah');
  });

  test('ShopeeError.status: 401/403 Shopee tidak diteruskan, kesalahan input -> 400, 5xx/429 diteruskan', () => {
    const { ShopeeError: SE } = require('../src/shopee/client');
    assert.equal(new SE('error_auth', 'x', { http_status: 401 }).status, 502);
    assert.equal(new SE('error_sign', 'x', { http_status: 403 }).status, 502);
    assert.equal(new SE('error_not_found', 'x', { http_status: 404 }).status, 502);
    assert.equal(new SE('invalid_code', 'x', { http_status: 200 }).status, 400);
    assert.equal(new SE('invalid_shop_id', 'x').status, 400);
    assert.equal(new SE('error_server', 'x', { http_status: 503 }).status, 503);
    assert.equal(new SE('error_rate_limit', 'x', { http_status: 429 }).status, 429);
    assert.equal(new SE('shop_not_found', 'x', { status: 404 }).status, 404);
    assert.equal(new SE('logistics.error_status_limit', 'x').status, 502);
  });

  test('logistics helper: dropoff JOB/tracking_no/slug, pickup tanpa slot, slot recommended, download bukan PDF', async () => {
    const L = require('../src/shopee/logistics');
    // dropoff: sender_real_name + tracking_no (kurir 80003/80004) -> pilih JOB (sender_real_name)
    assert.deepEqual(L.buildDropoff({ dropoff: null }, ['sender_real_name', 'tracking_no'], { process: { sender_real_name: 'GP' } }), { sender_real_name: 'GP' });
    assert.throws(() => L.buildDropoff({}, ['tracking_no'], {}), (e) => e.code === 'unsupported_dropoff');
    assert.throws(() => L.buildDropoff({}, ['tracking_number'], {}), (e) => e.code === 'unsupported_dropoff');
    assert.deepEqual(L.buildDropoff({ dropoff: { branch_list: [{ branch_id: 7 }] } }, ['branch_id'], {}), { branch_id: 7 });
    assert.throws(() => L.buildDropoff({ dropoff: { branch_list: [] } }, ['branch_id'], {}), (e) => e.code === 'no_dropoff_branch');
    assert.deepEqual(L.buildDropoff({ dropoff: { slug_list: [{ slug: 'tw-711', slug_name: '7-11' }] } }, ['slug'], {}), { slug: 'tw-711' });
    assert.deepEqual(L.buildDropoff({}, [], {}), {});
    // pickup: alamat gudang diutamakan walau tanpa slot (Shopee mengizinkan tanpa pickup_time_id); slot recommended didahulukan
    const params = { pickup: { address_list: [
      { address_id: 1, address_flag: ['default_address', 'pickup_address'], time_slot_list: [{ date: NOW(), pickup_time_id: 'a' }, { date: NOW(), pickup_time_id: 'b', flags: ['recommended'] }] },
      { address_id: 2, address_flag: [], time_slot_list: null },
    ] } };
    assert.deepEqual(L.buildPickup(params, ['address_id', 'pickup_time_id'], { pickup_address_id: 2 }), { address_id: 2 });
    assert.deepEqual(L.buildPickup(params, ['address_id', 'pickup_time_id'], {}), { address_id: 1, pickup_time_id: 'b' });
    assert.deepEqual(L.buildPickup(params, ['address_id'], {}), { address_id: 1 });
    assert.throws(() => L.buildPickup(params, ['address_id', 'tracking_number'], {}), (e) => e.code === 'unsupported_pickup');
    assert.throws(() => L.buildPickup({ pickup: { address_list: [] } }, ['address_id'], {}), (e) => e.code === 'no_pickup_address');
    assert.throws(() => L.buildPickup({ pickup: null }, ['address_id'], {}), (e) => e.code === 'no_pickup_address');
    assert.equal(L.chooseSlot(null), null);
    assert.equal(L.chooseSlot([{ date: 0, pickup_time_id: '' }]), null);
    // pickMethod: preferensi tak tersedia -> yang ada; non_integrated -> error
    assert.equal(L.pickMethod({ pickup: ['address_id'], dropoff: null }, 'dropoff'), 'pickup');
    assert.equal(L.pickMethod({ pickup: ['address_id'], dropoff: [] }, 'dropoff'), 'dropoff');
    assert.throws(() => L.pickMethod({ non_integrated: [] }, 'auto'), (e) => e.code === 'non_integrated');
    assert.throws(() => L.pickMethod({}, 'auto'), (e) => e.code === 'no_shipping_method');
    // download: bukan PDF -> invalid_document
    const lg = L.createLogistics({ client: { call: async () => Buffer.from('<html>error</html>') } });
    await assert.rejects(lg.downloadShippingDocument({ shop_id: 1, order_list: [{ order_sn: 'X' }] }), (e) => e.code === 'invalid_document');
    const lg2 = L.createLogistics({ client: { call: async () => Buffer.alloc(0) } });
    await assert.rejects(lg2.downloadShippingDocument({ shop_id: 1, order_list: [{ order_sn: 'X' }] }), (e) => e.code === 'empty_document');
  });

  test('call: validasi path & toko', async () => {
    await assert.rejects(shopee.call({ path: '/foo', shop_id: MOCK_SHOP }), (e) => e instanceof ShopeeError && e.status === 400);
    await assert.rejects(shopee.call({ path: '/api/v2/shop/get_shop_info' }), (e) => e instanceof ShopeeError && e.code === 'shop_required');
    await assert.rejects(shopee.call({ path: '/api/v2/shop/get_shop_info', shop_id: 123456 }), (e) => e instanceof ShopeeError && e.code === 'shop_not_found');
    repo.upsertShop({ shop_id: 555, marketplace: 'shopee', status: 'disconnected', access_token: 'x', refresh_token: 'y' });
    await assert.rejects(shopee.call({ path: '/api/v2/shop/get_shop_info', shop_id: 555 }), (e) => e instanceof ShopeeError && e.code === 'shop_disconnected');
    repo.deleteShop(555);
  });
});

// ---------- transport bridge (client) ----------
describe('transport bridge (client -> server http palsu)', () => {
  const BRIDGE_SHOP = 777001;
  const TOKEN = 'token-bridge-uji';
  const seen = [];
  let server; let port;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        if (req.headers['x-bridge-token'] !== TOKEN) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized', message: 'token salah' })); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 200, content_type: 'application/json', json: { error: '', message: '', response: { shop_name: 'X' } } }));
      });
    });
    port = await listen(server);
    repo.upsertShop({ shop_id: BRIDGE_SHOP, marketplace: 'shopee', shop_name: 'Toko Bridge', status: 'connected', access_token: 'tok-bridge', refresh_token: 'rtk-bridge', access_expire_at: NOW() + 4 * 3600, refresh_expire_at: NOW() + 30 * 86400, authorized_at: NOW() });
    repo.setSettings({ 'shopee.transport': 'bridge', 'shopee.env': 'live', 'shopee.bridge_url': `http://127.0.0.1:${port}/bridge/shopee`, 'shopee.bridge_token': TOKEN, 'shopee.partner_id': 2001887, 'shopee.partner_key': 'kunci-uji' });
  });

  after(async () => {
    repo.setSettings({ 'shopee.transport': 'mock' });
    repo.deleteShop(BRIDGE_SHOP); // jangan jadi "toko utama" untuk suite berikutnya
    await close(server);
  });

  test('GET lewat bridge: header token, path, query partner_id/timestamp/sign/access_token/shop_id', async () => {
    const info = await shopee.getShopInfo(BRIDGE_SHOP);
    assert.equal(info.shop_name, 'X');
    const req = seen.at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/bridge/shopee');
    assert.equal(req.headers['x-bridge-token'], TOKEN);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.body.method, 'GET');
    assert.equal(req.body.path, '/api/v2/shop/get_shop_info');
    assert.equal(req.body.binary, false);
    assert.equal(req.body.env, 'live');
    const q = req.body.query;
    assert.equal(Number(q.partner_id), 2001887);
    assert.ok(Math.abs(Number(q.timestamp) - NOW()) < 60, 'timestamp detik unix sekarang');
    assert.match(String(q.sign), /^[0-9a-f]{64}$/);
    assert.equal(q.access_token, 'tok-bridge');
    assert.equal(Number(q.shop_id), BRIDGE_SHOP);
    assert.equal(q.sign, sign({ partner_id: 2001887, partner_key: 'kunci-uji', path: '/api/v2/shop/get_shop_info', timestamp: q.timestamp, access_token: 'tok-bridge', shop_id: BRIDGE_SHOP }));
    assert.equal(JSON.stringify(req.body).includes('kunci-uji'), false, 'partner_key tidak boleh dikirim ke bridge');
  });

  test('POST lewat bridge membawa body & query bisnis', async () => {
    const r = await shopee.shipOrder({ shop_id: BRIDGE_SHOP, order_sn: 'SN1', package_number: 'PK1', dropoff: {} });
    assert.deepEqual(r, { shop_name: 'X' });
    const req = seen.at(-1);
    assert.equal(req.body.method, 'POST');
    assert.equal(req.body.path, '/api/v2/logistics/ship_order');
    assert.deepEqual(req.body.body, { order_sn: 'SN1', package_number: 'PK1', dropoff: {} });
    await shopee.getShippingParameter({ shop_id: BRIDGE_SHOP, order_sn: 'SN1', package_number: 'PK1' });
    const q = seen.at(-1).body.query;
    assert.equal(q.order_sn, 'SN1');
    assert.equal(q.package_number, 'PK1');
    assert.ok(q.sign && q.access_token);
  });

  test('token bridge salah -> ShopeeError bridge_unauthorized; bridge_url kosong -> bridge_not_configured', async () => {
    repo.setSettings({ 'shopee.bridge_token': 'salah' });
    await assert.rejects(shopee.getShopInfo(BRIDGE_SHOP), (e) => e instanceof ShopeeError && e.code === 'bridge_unauthorized');
    repo.setSettings({ 'shopee.bridge_token': TOKEN, 'shopee.bridge_url': '' });
    await assert.rejects(shopee.getShopInfo(BRIDGE_SHOP), (e) => e instanceof ShopeeError && e.code === 'bridge_not_configured');
    repo.setSettings({ 'shopee.bridge_url': `http://127.0.0.1:${port}/bridge/shopee` });
  });
});

// ---------- bridge router (server) ----------
describe('bridge router', () => {
  const TOKEN = 'bridge-uji';
  let saved; let server; let port; let upstream; let upPort;
  const upSeen = [];
  const call = (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, opts);
  const hdr = (extra = {}) => ({ 'content-type': 'application/json', 'x-bridge-token': TOKEN, ...extra });

  before(async () => {
    saved = config.BRIDGE_TOKEN;
    config.BRIDGE_TOKEN = TOKEN;
    const app = express();
    app.use('/bridge', bridgeRouter);
    server = http.createServer(app);
    port = await listen(server);
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        upSeen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        if (req.url.includes('download_shipping_document')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from('%PDF-1.4 mock')); }
        if (req.url.includes('lambat')) return; // tidak pernah dibalas
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '', message: '', request_id: 'r1', response: { ok: 1 } }));
      });
    });
    upPort = await listen(upstream);
  });

  after(async () => {
    config.BRIDGE_TOKEN = saved;
    await close(server);
    upstream.closeAllConnections();
    await close(upstream);
  });

  test('tanpa token / token salah -> 401', async () => {
    assert.equal((await call('/bridge/ping')).status, 401);
    assert.equal((await call('/bridge/ping', { headers: { 'x-bridge-token': 'salah' } })).status, 401);
    const r = await call('/bridge/shopee', { method: 'POST', headers: hdr({ 'x-bridge-token': 'salah' }), body: JSON.stringify({ method: 'GET', path: '/api/v2/shop/get_shop_info' }) });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.error, 'unauthorized');
    assert.equal(j.status, undefined);
  });

  test('ping dengan token -> {ok:true}', async () => {
    const r = await call('/bridge/ping', { headers: { 'x-bridge-token': TOKEN } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });

  test('path bukan /api/v2/ -> 400; method selain GET/POST -> 400', async () => {
    for (const path of ['/foo', '/api/v1/shop', 'api/v2/shop', '/api/v2/../x', '/api/v2/a/../../x', '/api/v2/shop/get_shop_info.json', '/api/v2//shop', '/api/v2/shop get', '/api/v2/', '/api/v2/shop?x=1', '', 5]) {
      const r = await call('/bridge/shopee', { method: 'POST', headers: hdr(), body: JSON.stringify({ method: 'GET', path }) });
      assert.equal(r.status, 400, `path ${JSON.stringify(path)} harus 400`);
      assert.equal((await r.json()).error, 'bad_request');
    }
    const r = await call('/bridge/shopee', { method: 'POST', headers: hdr(), body: JSON.stringify({ method: 'DELETE', path: '/api/v2/shop/get_shop_info' }) });
    assert.equal(r.status, 400);
  });

  test('BRIDGE_TOKEN kosong -> 503', async () => {
    config.BRIDGE_TOKEN = '';
    try {
      const r = await call('/bridge/ping', { headers: { 'x-bridge-token': TOKEN } });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, 'bridge_disabled');
    } finally { config.BRIDGE_TOKEN = TOKEN; }
  });

  test('body > 1 MB -> 413', async () => {
    const r = await call('/bridge/shopee', { method: 'POST', headers: hdr(), body: JSON.stringify({ method: 'POST', path: '/api/v2/logistics/ship_order', body: { big: 'x'.repeat(1024 * 1024 + 100) } }) });
    assert.equal(r.status, 413);
  });

  test('relay meneruskan query apa adanya + body JSON ke host dan membungkus respons', async () => {
    const host = `http://127.0.0.1:${upPort}`;
    const out = await bridgeRouter.relay({ method: 'POST', path: '/api/v2/logistics/ship_order', query: { partner_id: 1, timestamp: 1700000000, sign: 'abc', access_token: 'tok', shop_id: 9, arr: ['a', 'b'] }, body: { order_sn: 'X', dropoff: {} }, host });
    assert.equal(out.status, 200);
    assert.equal(out.content_type, 'application/json');
    assert.deepEqual(out.json, { error: '', message: '', request_id: 'r1', response: { ok: 1 } });
    assert.equal(out.base64, undefined);
    const up = upSeen.at(-1);
    assert.equal(up.method, 'POST');
    const u = new URL(`http://x${up.url}`);
    assert.equal(u.pathname, '/api/v2/logistics/ship_order');
    assert.equal(u.searchParams.get('partner_id'), '1');
    assert.equal(u.searchParams.get('timestamp'), '1700000000');
    assert.equal(u.searchParams.get('sign'), 'abc');
    assert.equal(u.searchParams.get('access_token'), 'tok');
    assert.equal(u.searchParams.get('shop_id'), '9');
    assert.equal(u.searchParams.get('arr'), 'a,b');
    assert.equal(up.headers['content-type'], 'application/json');
    assert.deepEqual(up.body, { order_sn: 'X', dropoff: {} });

    const get = await bridgeRouter.relay({ method: 'GET', path: '/api/v2/order/get_order_list', query: { a: 1 }, host });
    assert.equal(get.status, 200);
    assert.equal(upSeen.at(-1).method, 'GET');
    assert.equal(upSeen.at(-1).body, null);

    const pdf = await bridgeRouter.relay({ method: 'POST', path: '/api/v2/logistics/download_shipping_document', body: { order_list: [] }, binary: true, host });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.json, undefined);
    assert.equal(Buffer.from(pdf.base64, 'base64').subarray(0, 4).toString('latin1'), '%PDF');
  });

  test('upstream tidak bisa dihubungi -> 502 {error, message} tanpa field status', async () => {
    await assert.rejects(bridgeRouter.relay({ method: 'GET', path: '/api/v2/shop/get_shop_info', host: 'http://127.0.0.1:1' }), (e) => e.status === 502 && e.code === 'upstream_unreachable');
  });

  test('host default mengikuti env: live vs test', () => {
    // relay dengan fetch palsu untuk memeriksa URL tujuan tanpa jaringan
    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), arrayBuffer: async () => Buffer.from('{"error":""}') }; };
    return Promise.all([
      bridgeRouter.relay({ method: 'GET', path: '/api/v2/shop/get_shop_info', env: 'test', fetchImpl }),
      bridgeRouter.relay({ method: 'GET', path: '/api/v2/shop/get_shop_info', env: 'live', fetchImpl }),
    ]).then(() => {
      assert.ok(urls[0].startsWith(HOSTS.test));
      assert.ok(urls[1].startsWith(HOSTS.live));
    });
  });
});

// ---------- route /api/shopee lewat server sungguhan ----------
describe('route /api/shopee', () => {
  let server; let port;
  const cookies = new Map();
  async function req(method, p, body, extra = {}) {
    const headers = { 'content-type': 'application/json' };
    if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', ...extra });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq); const val = pair.slice(eq + 1);
      if (val === '') cookies.delete(name); else cookies.set(name, val);
    }
    let json = null;
    try { json = await res.clone().json(); } catch { json = null; }
    return { status: res.status, json, headers: res.headers };
  }

  before(async () => {
    const { createApp } = require('../src/index');
    server = http.createServer(createApp());
    port = await listen(server);
    repo.setSettings({ 'shopee.transport': 'mock' });
    // mulai dari toko mock yang belum terhubung
    repo.deleteShop(MOCK_SHOP);
  });

  after(async () => { await close(server); });

  test('parseCallbackUrl menerima URL penuh maupun potongan query', () => {
    assert.deepEqual(shopeeRoutes.parseCallbackUrl('https://suite.glasspro.co.id/api/shopee/callback?code=abc&shop_id=123'), { code: 'abc', shop_id: '123', main_account_id: undefined });
    assert.deepEqual(shopeeRoutes.parseCallbackUrl('?code=abc&main_account_id=9'), { code: 'abc', shop_id: undefined, main_account_id: '9' });
    assert.deepEqual(shopeeRoutes.parseCallbackUrl('code=abc&shop_id=1'), { code: 'abc', shop_id: '1', main_account_id: undefined });
    assert.deepEqual(shopeeRoutes.parseCallbackUrl(''), {});
  });

  test('tanpa login -> 401 (kecuali /callback)', async () => {
    assert.equal((await req('GET', '/api/shopee/status')).status, 401);
    assert.equal((await req('GET', '/api/shopee/auth-url')).status, 401);
    assert.equal((await req('POST', '/api/shopee/test', {})).status, 401);
    assert.equal((await req('GET', '/api/shopee/warehouses')).status, 401);
    const cb = await req('GET', '/api/shopee/callback?code=&shop_id=999001');
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get('location'), /^\/#\/settings\?error=/);
  });

  test('login lalu status belum terhubung', async () => {
    const r = await req('POST', '/api/auth/login', { username: config.ADMIN_USER, password: config.ADMIN_PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = await req('GET', '/api/shopee/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.transport, 'mock');
    assert.equal(st.json.configured, true);
    assert.ok(Array.isArray(st.json.shops) && !st.json.shops.some((s) => s.shop_id === MOCK_SHOP));
    assert.ok('last_sync' in st.json && 'last' in st.json.last_sync);
    const t = await req('POST', '/api/shopee/test', {});
    assert.equal(t.status, 400);
    assert.equal(t.json.error, 'not_connected');
  });

  test('auth-url -> callback (redirect) -> status terhubung', async () => {
    const au = await req('GET', '/api/shopee/auth-url');
    assert.equal(au.status, 200);
    assert.match(au.json.url, /\/api\/shopee\/callback\?code=mock&shop_id=999001$/);
    const cb = await req('GET', au.json.url);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/#/settings?connected=999001');
    const st = await req('GET', '/api/shopee/status');
    const s = st.json.shops.find((x) => x.shop_id === MOCK_SHOP);
    assert.ok(s && s.status === 'connected' && s.shop_name === 'Glass Pro Official (Mock)');
    assert.equal(s.access_token, undefined);
  });

  test('test, warehouses, shop-info, refresh, disconnect, connect-manual', async () => {
    const t = await req('POST', '/api/shopee/test', {});
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.equal(t.json.ok, true);
    assert.equal(t.json.shop_name, 'Glass Pro Official (Mock)');

    const w = await req('GET', '/api/shopee/warehouses');
    assert.equal(w.status, 200);
    assert.deepEqual(w.json.warehouses.map((x) => x.location_id).sort(), ['JKT-001', 'SBY-001']);
    assert.ok(Array.isArray(w.json.mapping) && w.json.mapping.some((m) => m.code === 'jkt'));

    const si = await req('GET', '/api/shopee/shop-info');
    assert.equal(si.status, 200);
    assert.equal(si.json.info.shop_name, 'Glass Pro Official (Mock)');
    assert.equal(si.json.shop.shop_id, MOCK_SHOP);
    assert.equal(si.json.shop.access_token, undefined);

    const before = repo.getShop(MOCK_SHOP).access_token;
    const rf = await req('POST', `/api/shopee/refresh/${MOCK_SHOP}`, {});
    assert.equal(rf.status, 200, JSON.stringify(rf.json));
    assert.notEqual(repo.getShop(MOCK_SHOP).access_token, before);
    assert.equal(rf.json.shop.access_token, undefined);
    assert.equal((await req('POST', '/api/shopee/refresh/abc', {})).status, 400);
    assert.equal((await req('POST', '/api/shopee/refresh/424242', {})).status, 404);

    const dc = await req('POST', `/api/shopee/disconnect/${MOCK_SHOP}`, {});
    assert.equal(dc.status, 200);
    assert.equal(dc.json.shop.status, 'disconnected');
    assert.equal((await req('POST', '/api/shopee/test', {})).status, 400);

    const cm = await req('POST', '/api/shopee/connect-manual', { callback_url: 'https://suite.glasspro.co.id/api/shopee/callback?code=mock&shop_id=999001' });
    assert.equal(cm.status, 200, JSON.stringify(cm.json));
    assert.equal(cm.json.shop.shop_id, MOCK_SHOP);
    assert.equal(cm.json.shop.status, 'connected');
    assert.equal(cm.json.shop.access_token, undefined);
    assert.equal((await req('POST', '/api/shopee/connect-manual', { shop_id: 999001 })).status, 400);
    assert.equal((await req('POST', '/api/shopee/connect-manual', { code: 'mock' })).status, 400);
    const bad = await req('POST', '/api/shopee/connect-manual', { code: 'mock', shop_id: 42 });
    assert.equal(bad.status, 400, 'invalid_shop_id adalah kesalahan input, bukan gateway');
    assert.equal(bad.json.error, 'invalid_shop_id');
  });

  test('refresh/disconnect butuh admin', async () => {
    repo.createUser({ username: 'staf_shopee', password: 'rahasia1', name: 'Staf', role: 'staff' });
    cookies.clear();
    assert.equal((await req('POST', '/api/auth/login', { username: 'staf_shopee', password: 'rahasia1' })).status, 200);
    assert.equal((await req('POST', `/api/shopee/refresh/${MOCK_SHOP}`, {})).status, 403);
    assert.equal((await req('POST', `/api/shopee/disconnect/${MOCK_SHOP}`, {})).status, 403);
    assert.equal((await req('GET', '/api/shopee/status')).status, 200);
  });
});
