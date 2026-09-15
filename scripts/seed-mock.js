#!/usr/bin/env node
'use strict';
// Isi DB dengan data mock Shopee: hubungkan toko mock (exchangeCode) lalu jalankan sync manual
// (memakai src/engine/sync.js bila ada; kalau belum ada, order di-upsert langsung lewat repo).
//
// Pakai:  STORAGE_DIR=./storage node scripts/seed-mock.js [--force]
// Transport dipaksa 'mock' bila env SHOPEE_TRANSPORT kosong. PERHATIAN: nilai itu ikut TERSIMPAN ke tabel
// settings (repo.ensureSeeded) sehingga server yang memakai STORAGE_DIR yang sama langsung beralih ke mock.
// Karena itu seed dibatalkan bila DB sudah memuat toko Shopee asli (bukan toko mock) kecuali diberi --force,
// dan dibatalkan bila transport aktif bukan mock.
const FORCED_MOCK = !process.env.SHOPEE_TRANSPORT;
if (FORCED_MOCK) process.env.SHOPEE_TRANSPORT = 'mock';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repo');
const shopeeMod = require('../src/shopee');

function loadSync() {
  try {
    return require('../src/engine/sync');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /engine[\\/]sync/.test(String(e.message))) return null;
    throw e;
  }
}

async function main() {
  db.open();
  // Nilai transport yang tersimpan SEBELUM ensureSeeded (ensureSeeded menulis ulang dari env SHOPEE_TRANSPORT).
  const storedTransport = repo.getSetting('shopee.transport', null);
  const realShops = (repo.listShops('shopee') || []).filter((s) => Number(s.shop_id) !== shopeeMod.MOCK_SHOP_ID);
  if (realShops.length && !process.argv.includes('--force')) {
    console.error(`DB ini memuat ${realShops.length} toko Shopee asli (${realShops.map((s) => s.shop_id).join(', ')}); seed dibatalkan agar transport/data asli tidak tersentuh. Pakai --force bila memang disengaja.`);
    process.exitCode = 1;
    return;
  }
  repo.ensureSeeded();
  const shopee = shopeeMod.create();
  const st = shopee.status();
  console.log(`Storage  : ${config.STORAGE_DIR}`);
  console.log(`Transport: ${st.transport} (env ${st.env})`);
  if (st.transport !== 'mock') {
    console.error('Transport aktif bukan mock; seed dibatalkan agar tidak menyentuh data asli. Jalankan dengan SHOPEE_TRANSPORT=mock.');
    process.exitCode = 1;
    return;
  }
  if (FORCED_MOCK && storedTransport && storedTransport !== 'mock') {
    console.log(`Catatan  : setting shopee.transport di DB diubah dari '${storedTransport}' menjadi 'mock' (ubah kembali lewat Pengaturan atau env SHOPEE_TRANSPORT).`);
  }

  const shop = await shopee.exchangeCode({ code: 'mock', shop_id: shopeeMod.MOCK_SHOP_ID });
  console.log(`Toko     : ${shop.shop_id} "${shop.shop_name}" (${shop.status})`);

  const sync = loadSync();
  if (sync && typeof sync.runSync === 'function') {
    const r = await sync.runSync({ trigger: 'manual', user: null });
    console.log(`Sync     : status=${r.status} fetched=${r.fetched} created=${r.created} updated=${r.updated}${r.error ? ` error=${r.error}` : ''}`);
  } else {
    const now = Math.floor(Date.now() / 1000);
    const rows = await shopee.fetchOrders({ shop_id: shop.shop_id, statuses: null, time_from: now - 7 * 86400, time_to: now, time_range_field: 'create_time' });
    let created = 0; let updated = 0;
    for (const row of rows) {
      const res = repo.upsertOrder(row);
      if (res.created) created++; else if (res.changed) updated++;
    }
    console.log(`Fetch    : ${rows.length} order (baru ${created}, berubah ${updated}) - engine/sync.js belum ada, upsert langsung`);
  }

  const c = repo.countOrders();
  console.log(`Order    : total ${c.total}`);
  console.log(`  status : ${JSON.stringify(c.byStatus)}`);
  console.log(`  proses : ${JSON.stringify(c.byProc)}`);
  console.log('Selesai. Login: admin / (ADMIN_PASSWORD) lalu buka Process Order.');
}

main()
  .catch((e) => {
    console.error('Seed gagal:', e && e.code ? `${e.code}: ${e.message}` : (e && e.message) || e);
    process.exitCode = 1;
  })
  .finally(() => { try { db.close(); } catch { /* abaikan */ } });
