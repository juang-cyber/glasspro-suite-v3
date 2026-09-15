'use strict';
// Test engine/sync.js dengan DB sementara, shopee palsu, dan preview palsu.
const path = require('path');
const fs = require('fs');

const TMP = path.join(__dirname, '..', '.tmp', `sync-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const repo = require('../src/db/repo');
const sync = require('../src/engine/sync');

const SHOP_ID = 999001;
const NOW = Math.floor(Date.now() / 1000);

function order(sn, extra = {}) {
  return {
    order_sn: sn, shop_id: SHOP_ID, marketplace: 'shopee', order_status: 'READY_TO_SHIP',
    create_time: NOW - 3600, update_time: NOW - 1800, pay_time: NOW - 3500, ship_by_date: NOW + 86400, days_to_ship: 2,
    shipping_carrier: 'SPX Instant', checkout_shipping_carrier: 'SPX Instant', buyer_username: 'pembeli',
    recipient_name: 'Budi', recipient_phone: '08123456789', recipient_address: 'Jl. Mawar No. 1, Jakarta', note: '', message_to_seller: '',
    cod: false, total_amount: 50000, currency: 'IDR',
    items: [{ item_id: 1, item_name: 'TG iPhone', item_sku: 'TG-IP15PM-CLR', model_id: 11, model_name: 'iPhone 15 Pro Max', model_sku: 'TG-IP15PM-CLR', qty: 1, price: 50000, product_location_id: 'JKT-001', order_item_id: 111, image_url: null }],
    packages: [], tracking_number: null, package_number: 'PKG-1', raw: { order_sn: sn },
    ...extra,
  };
}

const fakePreview = () => {
  const p = { calls: 0, reclassifyAll: async () => { p.calls++; return { count: 0 }; } };
  return p;
};

before(() => {
  db.open();
  repo.upsertShop({ shop_id: SHOP_ID, marketplace: 'shopee', shop_name: 'Toko Uji', status: 'connected', access_token: 'tkn-uji', refresh_token: 'rtk-uji', authorized_at: NOW });

  // Data awal di DB
  repo.upsertOrder(order('A-PROCESSED-CANCEL')); // sudah diproses, nanti CANCELLED
  repo.upsertOrder(order('B-PROCESSED-CHANGED')); // sudah diproses, nanti item berubah
  repo.upsertOrder(order('F-PROCESSED-STATUS')); // sudah diproses, hanya status berubah -> tidak stale
  repo.upsertOrder(order('C-UNCHANGED')); // tidak berubah
  repo.upsertOrder(order('G-WAS-CANCELLED', { order_status: 'IN_CANCEL' })); // dulu batal, kini kembali normal
  for (const sn of ['A-PROCESSED-CANCEL', 'B-PROCESSED-CHANGED', 'F-PROCESSED-STATUS']) {
    repo.setOrderProc(sn, { proc_status: 'processed', processed_at: NOW - 600, proc_run_id: 1, pdf_stale: 0 });
  }
  repo.setOrderProc('G-WAS-CANCELLED', { proc_status: 'cancelled' });
  repo.createPdf({ run_id: 1, kind: 'labels', file_name: 'a.pdf', file_path: 'a.pdf', part: 'p1', ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt', order_sns: ['A-PROCESSED-CANCEL', 'B-PROCESSED-CHANGED'], status: 'ok' });
  repo.createPdf({ run_id: 1, kind: 'labels', file_name: 'f.pdf', file_path: 'f.pdf', part: 'p1', ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt', order_sns: ['F-PROCESSED-STATUS'], status: 'ok' });
});

after(() => {
  sync.stopScheduler();
  db.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* abaikan (file WAL mungkin masih terkunci di Windows) */ }
});

test('summarizeError meringkas ShopeeError tanpa throw', () => {
  assert.equal(sync.summarizeError({ code: 'error_auth', message: 'Token kadaluarsa' }), 'error_auth: Token kadaluarsa');
  assert.equal(sync.summarizeError(new Error('x')), 'x');
  assert.equal(sync.summarizeError(null), 'Kesalahan tidak diketahui');
  assert.ok(sync.summarizeError({ message: 'y'.repeat(1000) }).length <= 300);
});

test('materiallyChanged mengabaikan perubahan order_status saja', () => {
  const prev = repo.getOrder('F-PROCESSED-STATUS');
  assert.equal(sync.materiallyChanged(order('F-PROCESSED-STATUS', { order_status: 'PROCESSED' }), prev), false);
  assert.equal(sync.materiallyChanged(order('F-PROCESSED-STATUS', { recipient_address: 'Alamat baru' }), prev), true);
  const items = [{ ...prev.items[0], qty: 3 }];
  assert.equal(sync.materiallyChanged(order('F-PROCESSED-STATUS', { items }), prev), true);
});

test('runSync: upsert, hitung created/updated, pdf stale, cancelled, restore', async () => {
  const calls = [];
  const shopee = {
    fetchOrders: async (args) => {
      calls.push(args);
      if (args.time_range_field === 'create_time') {
        return [
          order('A-PROCESSED-CANCEL', { order_status: 'CANCELLED', update_time: NOW - 100 }),
          order('B-PROCESSED-CHANGED', { items: [{ ...order('x').items[0], qty: 2 }] }),
          order('F-PROCESSED-STATUS', { order_status: 'PROCESSED' }),
          order('C-UNCHANGED'),
          order('D-NEW'),
          null, // data tidak lengkap harus diabaikan
          { order_sn: null },
        ];
      }
      return [
        order('E-NEW-CANCELLED', { order_status: 'IN_CANCEL' }),
        order('A-PROCESSED-CANCEL', { order_status: 'CANCELLED', update_time: NOW - 50 }), // duplikat lintas rentang
        order('G-WAS-CANCELLED', { order_status: 'READY_TO_SHIP' }),
      ];
    },
  };
  const preview = fakePreview();
  const r = await sync.runSync({ trigger: 'manual', user: { id: 1, name: 'Admin' } }, { shopee, preview, now: NOW });

  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.error, null);
  assert.ok(r.sync_log_id > 0);
  assert.equal(r.fetched, 7);
  assert.equal(r.created, 2); // D, E
  assert.equal(r.updated, 4); // A (status), B (item), F (status), G (status)
  assert.deepEqual([...r.changed_processed].sort(), ['A-PROCESSED-CANCEL', 'B-PROCESSED-CHANGED']);
  assert.equal(preview.calls, 1);

  // Parameter fetchOrders sesuai kontrak
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].statuses, ['READY_TO_SHIP', 'PROCESSED']);
  assert.equal(calls[0].time_range_field, 'create_time');
  assert.equal(calls[0].time_from, NOW - 7 * 86400);
  assert.equal(calls[0].time_to, NOW);
  assert.equal(calls[0].shop_id, SHOP_ID);
  assert.equal(calls[1].statuses, null);
  assert.equal(calls[1].time_range_field, 'update_time');
  assert.equal(calls[1].time_from, NOW - 2 * 86400);

  // Order processed yang batal: tetap processed, pdf_stale, status Shopee ikut diperbarui
  const a = repo.getOrder('A-PROCESSED-CANCEL');
  assert.equal(a.proc_status, 'processed');
  assert.equal(a.pdf_stale, true);
  assert.equal(a.order_status, 'CANCELLED');
  // Order processed yang isinya berubah: pdf_stale
  const b = repo.getOrder('B-PROCESSED-CHANGED');
  assert.equal(b.proc_status, 'processed');
  assert.equal(b.pdf_stale, true);
  assert.equal(b.items[0].qty, 2);
  // Hanya status berubah (READY_TO_SHIP -> PROCESSED): PDF tetap sah
  const f = repo.getOrder('F-PROCESSED-STATUS');
  assert.equal(f.pdf_stale, false);
  assert.equal(f.order_status, 'PROCESSED');
  // PDF: yang memuat A/B jadi stale, yang memuat F tetap ok
  const pdfs = repo.listPdfs(1);
  assert.equal(pdfs.find((p) => p.file_name === 'a.pdf').status, 'stale');
  assert.ok(pdfs.find((p) => p.file_name === 'a.pdf').stale_reason);
  assert.equal(pdfs.find((p) => p.file_name === 'f.pdf').status, 'ok');
  // Order baru berstatus batal -> cancelled; order lain tetap unprocessed
  assert.equal(repo.getOrder('E-NEW-CANCELLED').proc_status, 'cancelled');
  assert.equal(repo.getOrder('D-NEW').proc_status, 'unprocessed');
  assert.equal(repo.getOrder('C-UNCHANGED').proc_status, 'unprocessed');
  // Pembatalan ditolak -> kembali unprocessed
  assert.equal(repo.getOrder('G-WAS-CANCELLED').proc_status, 'unprocessed');

  // sync_log tercatat ok
  const { last, last_ok } = repo.lastSync('shopee');
  assert.equal(last.id, r.sync_log_id);
  assert.equal(last.status, 'ok');
  assert.equal(last.trigger, 'manual');
  assert.equal(last.user_id, 1);
  assert.equal(last.fetched, 7);
  assert.equal(last.created, 2);
  assert.equal(last.updated, 4);
  assert.ok(last.finished_at >= last.started_at);
  assert.deepEqual([...last.details.changed_processed].sort(), ['A-PROCESSED-CANCEL', 'B-PROCESSED-CHANGED']);
  assert.deepEqual(last.details.cancelled, ['E-NEW-CANCELLED']);
  assert.equal(last_ok.id, last.id);

  // getStatus
  const st = sync.getStatus();
  assert.equal(st.running, false);
  assert.equal(st.enabled, true);
  assert.equal(st.interval_minutes, 5);
  assert.equal(st.next_at, null); // scheduler belum jalan
  assert.equal(st.marketplaces.shopee.connected, true);
  assert.equal(st.marketplaces.shopee.status, 'ok');
  assert.equal(st.marketplaces.shopee.last_error, null);
  assert.equal(st.marketplaces.shopee.last_ok_at, last.finished_at);
  assert.equal(st.last.id, r.sync_log_id);
});

test('runSync kedua: order processed yang sudah batal & tidak berubah tidak dilaporkan ulang', async () => {
  const shopee = {
    fetchOrders: async () => [
      order('A-PROCESSED-CANCEL', { order_status: 'CANCELLED', update_time: NOW - 50 }), // sama persis dengan sync sebelumnya
      order('B-PROCESSED-CHANGED', { items: [{ ...order('x').items[0], qty: 2 }] }), // sudah tersimpan qty 2
    ],
  };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview: fakePreview(), now: NOW });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.updated, 0);
  assert.deepEqual(r.changed_processed, []);
  assert.equal(repo.getOrder('A-PROCESSED-CANCEL').pdf_stale, true);
  assert.equal(repo.getOrder('A-PROCESSED-CANCEL').proc_status, 'processed');

  // Bila pdf_stale sempat direset (mis. PDF dibuat ulang), pembatalan ditandai lagi walau isi tidak berubah
  repo.setOrderProc('A-PROCESSED-CANCEL', { pdf_stale: 0 });
  const r2 = await sync.runSync({ trigger: 'auto' }, { shopee, preview: fakePreview(), now: NOW });
  assert.deepEqual(r2.changed_processed, ['A-PROCESSED-CANCEL']);
  assert.equal(repo.getOrder('A-PROCESSED-CANCEL').pdf_stale, true);
});

test('runSync: kategori/tipe HP per item order processed & cancelled tidak hilang setelah upsert', async () => {
  // Order processed yang item-nya sudah diperkaya engine (category, phone_type)
  repo.upsertOrder(order('P-ENRICHED'));
  const p = repo.getOrder('P-ENRICHED');
  repo.setOrderDerived('P-ENRICHED', {
    warehouse_code: 'jkt', ship_type: 'instant', sku_category: 'tg',
    phone_type: { value: 'iPhone 15 Pro Max', source: 'model_name', required: true, missing: false },
    validation: { holds: [], warnings: [], flags: { tipe_belum_ditulis: false, deadline_hours_left: 24, needs_review: false } },
    items: [{ ...p.items[0], category: 'tg', phone_type_required: true, phone_type: 'iPhone 15 Pro Max', phone_type_source: 'model_name' }],
  });
  repo.setOrderProc('P-ENRICHED', { proc_status: 'processed', processed_at: NOW - 100, proc_run_id: 1 });
  // Order cancelled yang sebelumnya sudah diklasifikasi
  repo.upsertOrder(order('Q-CANCELLED', { order_status: 'CANCELLED' }));
  const q = repo.getOrder('Q-CANCELLED');
  repo.setOrderDerived('Q-CANCELLED', { warehouse_code: 'jkt', ship_type: 'instant', sku_category: 'tg', items: [{ ...q.items[0], category: 'tg' }] });
  repo.setOrderProc('Q-CANCELLED', { proc_status: 'cancelled' });

  const shopee = {
    fetchOrders: async () => [
      order('P-ENRICHED', { order_status: 'SHIPPED', items: [{ ...order('x').items[0], price: 45000 }] }), // harga berubah (tidak material)
      order('Q-CANCELLED', { order_status: 'CANCELLED' }),
    ],
  };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview: fakePreview(), now: NOW });
  assert.equal(r.status, 'ok', r.error);
  const after = repo.getOrder('P-ENRICHED');
  assert.equal(after.order_status, 'SHIPPED');
  assert.equal(after.items[0].price, 45000); // data mentah terbaru tetap dipakai
  assert.equal(after.items[0].category, 'tg'); // hasil engine dipertahankan
  assert.equal(after.items[0].phone_type, 'iPhone 15 Pro Max');
  assert.equal(after.sku_category, 'tg');
  assert.equal(after.pdf_stale, false); // status SHIPPED bukan perubahan material
  assert.equal(after.proc_status, 'processed');
  assert.equal(repo.getOrder('Q-CANCELLED').items[0].category, 'tg');
  assert.equal(repo.getOrder('Q-CANCELLED').proc_status, 'cancelled');
});

test('runSync: setting sync.statuses dipakai untuk rentang create_time', async () => {
  const calls = [];
  const shopee = { fetchOrders: async (args) => { calls.push(args); return []; } };
  const base = repo.getSettings();
  const settings = { ...base, sync: { ...base.sync, statuses: ['READY_TO_SHIP'], lookback_days: 1 } };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview: fakePreview(), settings, now: NOW });
  assert.equal(r.status, 'ok');
  assert.deepEqual(calls[0].statuses, ['READY_TO_SHIP']);
  assert.equal(calls[0].time_from, NOW - 86400);
  assert.equal(calls[1].statuses, null); // rentang update_time selalu semua status
});

test('runSync: include_recent_updates=false hanya satu panggilan fetchOrders', async () => {
  const calls = [];
  const shopee = { fetchOrders: async (args) => { calls.push(args); return []; } };
  const settings = { ...repo.getSettings(), sync: { ...repo.getSettings().sync, include_recent_updates: false, lookback_days: 3 } };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview: fakePreview(), settings, now: NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.fetched, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].time_from, NOW - 3 * 86400);
});

test('runSync: overlap guard -> panggilan kedua mendapat already_running', async () => {
  const shopee = { fetchOrders: async () => { await new Promise((r) => setTimeout(r, 80)); return []; } };
  const preview = fakePreview();
  const before = repo.listSyncLogs(100).length;
  const p1 = sync.runSync({ trigger: 'manual' }, { shopee, preview, now: NOW });
  assert.equal(sync.isRunning(), true);
  const p2 = sync.runSync({ trigger: 'manual' }, { shopee, preview, now: NOW });
  const r2 = await p2;
  const r1 = await p1;
  assert.equal(r2.already_running, true);
  assert.equal(r2.sync_log_id, r1.sync_log_id);
  assert.equal(r1.status, 'ok');
  assert.equal(repo.listSyncLogs(100).length, before + 1);
  assert.equal(preview.calls, 1);
  assert.equal(sync.isRunning(), false);
});

test('runSync: shopee melempar -> status failed tanpa throw, log gagal, getStatus failed', async () => {
  const err = Object.assign(new Error('Token kadaluarsa'), { code: 'error_auth', request_id: 'abc', status: 403 });
  const shopee = { fetchOrders: async () => { throw err; } };
  const preview = fakePreview();
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview, now: NOW });
  assert.equal(r.status, 'failed');
  assert.equal(r.fetched, 0);
  assert.ok(r.error.includes('error_auth') && r.error.includes('Token kadaluarsa'), r.error);
  assert.equal(preview.calls, 0); // tidak reclassify bila fetch gagal
  const { last, last_ok } = repo.lastSync('shopee');
  assert.equal(last.status, 'failed');
  assert.ok(last.error.includes('error_auth'));
  assert.ok(last_ok && last_ok.status === 'ok');
  const st = sync.getStatus();
  assert.equal(st.marketplaces.shopee.status, 'failed');
  assert.ok(st.marketplaces.shopee.last_error.includes('error_auth'));
  assert.equal(st.marketplaces.shopee.last_ok_at, last_ok.finished_at);
  assert.equal(sync.isRunning(), false);
});

test('runSync: reclassifyAll melempar tidak menggagalkan sync', async () => {
  const shopee = { fetchOrders: async () => [order('H-NEW')] };
  const preview = { reclassifyAll: async () => { throw new Error('preview rusak'); } };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview, now: NOW });
  assert.equal(r.status, 'ok');
  assert.equal(r.created, 1);
  const { last } = repo.lastSync('shopee');
  assert.ok(String(last.details.reclassify_error).includes('preview rusak'));
});

test('runSync: modul preview belum ada (null) -> tetap ok', async () => {
  const shopee = { fetchOrders: async () => [] };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview: null, now: NOW });
  assert.equal(r.status, 'ok');
});

test('runSync: tanpa toko terhubung -> failed dengan pesan jelas', async () => {
  repo.updateShop(SHOP_ID, { status: 'disconnected' });
  try {
    const shopee = { fetchOrders: async () => { throw new Error('tidak boleh dipanggil'); } };
    const r = await sync.runSync({ trigger: 'manual' }, { shopee, preview: fakePreview(), now: NOW });
    assert.equal(r.status, 'failed');
    assert.ok(r.error.includes('Belum ada toko'), r.error);
    assert.equal(sync.getStatus().marketplaces.shopee.connected, false);
  } finally {
    repo.updateShop(SHOP_ID, { status: 'connected' });
  }
});

test('runSync: ShopeeError dari satu order tidak menghentikan order lain', async () => {
  const shopee = { fetchOrders: async () => [order('I-OK'), { order_sn: 'J-RUSAK', items: 'bukan-array', raw: {} }, order('K-OK')] };
  const r = await sync.runSync({ trigger: 'auto' }, { shopee, preview: fakePreview(), now: NOW });
  // J-RUSAK tetap bisa disimpan (repo toleran) atau gagal; yang penting I & K tersimpan dan tidak throw
  assert.ok(['ok', 'failed'].includes(r.status));
  assert.ok(repo.getOrder('I-OK'));
  assert.ok(repo.getOrder('K-OK'));
});

test('scheduler: start/stop dan next_at', async () => {
  sync.startScheduler();
  const st = sync.getStatus();
  assert.ok(typeof st.next_at === 'number' && st.next_at >= NOW && st.next_at <= NOW + 60, `next_at=${st.next_at}`);
  sync.startScheduler(); // idempoten
  sync.stopScheduler();
  assert.equal(sync.getStatus().next_at, null);

  // Sync dinonaktifkan -> next_at null walau scheduler jalan
  const s = repo.getSettings().sync;
  repo.setSetting('sync', { ...s, enabled: false });
  sync.startScheduler();
  const st2 = sync.getStatus();
  assert.equal(st2.enabled, false);
  assert.equal(st2.next_at, null);
  sync.stopScheduler();
  repo.setSetting('sync', s);

  // interval minimal 1 menit
  assert.equal(sync.intervalMinutes({ interval_minutes: 0 }), 5);
  assert.equal(sync.intervalMinutes({ interval_minutes: 1 }), 1);
  assert.equal(sync.intervalMinutes({ interval_minutes: 'abc' }), 5);
  assert.equal(sync.intervalMinutes({ interval_minutes: 12.7 }), 12);
});

test('scheduler tick: jalan saat jatuh tempo (trigger auto), baca ulang setting tiap detak, diam saat nonaktif', async () => {
  const calls = [];
  const ctx = () => ({ shopee: { fetchOrders: async (a) => { calls.push(a); return []; } }, preview: fakePreview(), now: NOW });
  const s = repo.getSettings().sync;
  sync.startScheduler();
  try {
    // Baru mulai: sync pertama dijadwalkan 10 detik setelah start -> belum jatuh tempo
    await sync._test.tick(ctx());
    assert.equal(calls.length, 0);

    // Paksa jatuh tempo -> runSync trigger 'auto' (dua rentang: create_time + update_time)
    sync._test.setSchedulerStartedAt(NOW - 60);
    const before = repo.listSyncLogs(200).length;
    await sync._test.tick(ctx());
    assert.equal(calls.length, 2);
    const logs = repo.listSyncLogs(200);
    assert.equal(logs.length, before + 1);
    assert.equal(logs[0].trigger, 'auto');
    assert.equal(logs[0].status, 'ok');

    // Setelah jalan: berikutnya = selesai terakhir + interval; tick lagi tidak menjalankan apa pun
    const st = sync.getStatus();
    assert.ok(st.next_at >= NOW + 5 * 60 - 5 && st.next_at <= NOW + 5 * 60 + 60, `next_at=${st.next_at}`);
    await sync._test.tick(ctx());
    assert.equal(calls.length, 2);

    // Interval diperkecil lewat setting -> detak berikutnya langsung memakai interval baru
    repo.setSetting('sync', { ...s, interval_minutes: 1 });
    sync._test.setLastRunAt(NOW - 61);
    assert.equal(sync.getStatus().interval_minutes, 1);
    await sync._test.tick(ctx());
    assert.equal(calls.length, 4);

    // Nonaktif -> tick diam walau sudah jatuh tempo
    repo.setSetting('sync', { ...s, enabled: false });
    sync._test.setLastRunAt(NOW - 3600);
    await sync._test.tick(ctx());
    assert.equal(calls.length, 4);
    assert.equal(sync.getStatus().next_at, null);
  } finally {
    sync.stopScheduler();
    repo.setSetting('sync', s);
  }
});

test('startScheduler menandai sync_log yang menggantung sebagai failed', () => {
  const id = repo.startSyncLog({ trigger: 'auto' });
  sync.startScheduler();
  sync.stopScheduler();
  const row = repo.listSyncLogs(50).find((l) => l.id === id);
  assert.equal(row.status, 'failed');
  assert.ok(row.error);
});
