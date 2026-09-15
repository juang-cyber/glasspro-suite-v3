'use strict';
// Sinkronisasi order Shopee -> DB lokal, plus penjadwal otomatis (scheduler).
// Kontrak: docs/CONTRACTS.md bagian 4 (sync.js). Modul lain (shopee, preview) di-require secara lazy
// agar file ini tetap bisa di-require/di-test walau modul tersebut belum ada.
const log = require('../util/log').make('sync');
const { now: tnow } = require('../util/time');

const HEARTBEAT_MS = 15 * 1000; // detak scheduler; interval sebenarnya dibaca ulang dari setting tiap detak
const FIRST_RUN_DELAY_S = 10; // sync pertama 10 detik setelah server mulai
const RECENT_UPDATE_DAYS = 2; // rentang update_time untuk deteksi batal/berubah
const CANCEL_STATUSES = new Set(['CANCELLED', 'IN_CANCEL']);
const MAX_ERROR_LEN = 300;

// ---------- state modul ----------
let running = null; // Promise sync yang sedang berjalan (guard overlap)
let runningLogId = null;
let heartbeat = null; // setInterval detak scheduler
let firstTimer = null; // setTimeout sync pertama
let schedulerStartedAt = null;
let lastRunAt = null; // unix detik selesai sync terakhir (auto maupun manual)

// ---------- util ----------
function isModuleNotFound(e, name) {
  if (!e || e.code !== 'MODULE_NOT_FOUND') return false;
  const m = /Cannot find module '([^']+)'/.exec(String(e.message).split('\n')[0]);
  return !!m && m[1].replace(/\\/g, '/').endsWith(name);
}

function lazyShopee() {
  try {
    return require('../shopee').create();
  } catch (e) {
    if (isModuleNotFound(e, 'shopee')) return null;
    throw e;
  }
}

function lazyPreview() {
  try {
    return require('./preview');
  } catch (e) {
    if (isModuleNotFound(e, 'preview')) return null;
    throw e;
  }
}

// Ringkasan error yang aman ditampilkan (tanpa token/key). ShopeeError: "code: message".
function summarizeError(e) {
  if (!e) return 'Kesalahan tidak diketahui';
  const msg = String(e.message || e);
  const code = typeof e.code === 'string' && e.code ? e.code : null;
  const s = code && !msg.startsWith(code) ? `${code}: ${msg}` : msg;
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN - 3)}...` : s;
}

function intervalMinutes(syncSetting) {
  const n = Math.floor(Number(syncSetting && syncSetting.interval_minutes));
  return Number.isFinite(n) && n >= 1 ? n : 5;
}

function isActiveShop(shop) {
  // Semua toko selain yang sengaja diputus dicoba disinkronkan; token kadaluarsa dll. akan
  // muncul sebagai error sync yang jelas untuk pengguna.
  return !!shop && shop.status !== 'disconnected';
}

// Tanda tangan "isi material" order: perubahan yang membuat label/PDF tidak lagi sesuai.
// Sengaja TIDAK memuat order_status, karena setelah diproses status Shopee wajar berubah
// (READY_TO_SHIP -> PROCESSED -> SHIPPED) tanpa berarti PDF-nya usang.
// Normalisasi nilai: undefined/null/'' dianggap sama (repo menyimpan '' sebagai NULL).
const nv = (v) => (v === undefined || v === null || v === '' ? null : v);
function itemSignature(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => [
      nv(it.order_item_id) ?? nv(it.item_id), nv(it.model_id), nv(it.item_sku), nv(it.model_sku),
      Number(it.qty) || 0, nv(it.model_name), nv(it.product_location_id),
    ])
    .map((a) => JSON.stringify(a))
    .sort();
}
function materialSignature(o) {
  return JSON.stringify({
    items: itemSignature(o.items),
    ship_by_date: nv(o.ship_by_date),
    shipping_carrier: nv(o.shipping_carrier),
    note: nv(o.note),
    message_to_seller: nv(o.message_to_seller),
    recipient_name: nv(o.recipient_name),
    recipient_phone: nv(o.recipient_phone),
    recipient_address: nv(o.recipient_address),
  });
}
// Nilai efektif setelah upsert (repo memakai COALESCE untuk beberapa kolom).
function effectiveRow(row, prev) {
  return {
    items: row.items || [],
    ship_by_date: row.ship_by_date || prev.ship_by_date,
    shipping_carrier: row.shipping_carrier || prev.shipping_carrier,
    note: row.note ?? prev.note,
    message_to_seller: row.message_to_seller ?? prev.message_to_seller,
    recipient_name: row.recipient_name || prev.recipient_name,
    recipient_phone: row.recipient_phone || prev.recipient_phone,
    recipient_address: row.recipient_address || prev.recipient_address,
  };
}
function materiallyChanged(row, prev) {
  return materialSignature(effectiveRow(row, prev)) !== materialSignature(prev);
}

// ---------- sync per toko ----------
async function fetchShopOrders({ shopee, shop, settings, now }) {
  const syncSet = settings.sync || {};
  const lookbackDays = Math.max(1, Math.floor(Number(syncSet.lookback_days)) || 7);
  const statuses = Array.isArray(syncSet.statuses) && syncSet.statuses.length ? syncSet.statuses : ['READY_TO_SHIP', 'PROCESSED'];
  const merged = new Map();
  const add = (rows) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !r.order_sn) continue;
      const cur = merged.get(r.order_sn);
      // Simpan versi terbaru bila order muncul di kedua rentang
      if (!cur || (Number(r.update_time) || 0) >= (Number(cur.update_time) || 0)) merged.set(r.order_sn, r);
    }
  };

  add(await shopee.fetchOrders({
    shop_id: shop.shop_id, statuses, time_from: now - lookbackDays * 86400, time_to: now, time_range_field: 'create_time',
  }));
  if (syncSet.include_recent_updates !== false) {
    // Semua status (statuses null = tanpa filter) untuk mendeteksi CANCELLED / SHIPPED / perubahan isi
    add(await shopee.fetchOrders({
      shop_id: shop.shop_id, statuses: null, time_from: now - RECENT_UPDATE_DAYS * 86400, time_to: now, time_range_field: 'update_time',
    }));
  }
  return [...merged.values()];
}

function applyOrders({ repo, shop, rows }) {
  const out = { fetched: 0, created: 0, updated: 0, stale_changed: [], stale_cancelled: [], cancelled: [], restored: [], errors: [] };
  for (const row of rows) {
    const sn = row.order_sn;
    try {
      if (!row.shop_id) row.shop_id = shop.shop_id;
      if (!row.marketplace) row.marketplace = 'shopee';
      if (!row.order_status) row.order_status = 'UNKNOWN';
      const res = repo.upsertOrder(row);
      out.fetched++;
      if (res.created) out.created++;
      else if (res.changed) out.updated++;

      const prev = res.previous || null;
      const cancelledNow = CANCEL_STATUSES.has(String(row.order_status || '').toUpperCase());
      if (prev && prev.proc_status === 'processed') {
        // Sudah ada PDF: status proses tetap 'processed', tapi PDF ditandai usang bila batal / isi berubah
        if (cancelledNow) out.stale_cancelled.push(sn);
        else if (res.changed && materiallyChanged(row, prev)) out.stale_changed.push(sn);
      } else if (cancelledNow) {
        if (!prev || (prev.proc_status !== 'cancelled' && prev.proc_status !== 'processing')) {
          repo.setOrderProc(sn, { proc_status: 'cancelled' });
          out.cancelled.push(sn);
        }
      } else if (prev && prev.proc_status === 'cancelled') {
        // Pembatalan ditolak / status kembali normal -> masuk antrian lagi
        repo.setOrderProc(sn, { proc_status: 'unprocessed' });
        out.restored.push(sn);
      }
    } catch (e) {
      out.errors.push({ order_sn: sn, error: summarizeError(e) });
      log.error(`gagal menyimpan order ${sn}`, e);
    }
  }
  return out;
}

async function execute({ trigger, user, logId, repo, ctx }) {
  const t0 = Date.now();
  const result = { sync_log_id: logId, status: 'ok', fetched: 0, created: 0, updated: 0, changed_processed: [], error: null };
  const details = { trigger, shops: [], cancelled: [], restored: [], errors: [], reclassified: null };
  let anyShopOk = false;
  try {
    const settings = ctx.settings || repo.getSettings();
    const now = ctx.now || tnow();
    const shopee = ctx.shopee !== undefined ? ctx.shopee : lazyShopee();
    const preview = ctx.preview !== undefined ? ctx.preview : lazyPreview();

    const shops = (repo.listShops('shopee') || []).filter(isActiveShop);
    if (!shops.length) throw Object.assign(new Error('Belum ada toko Shopee yang terhubung'), { code: 'not_connected' });
    if (!shopee || typeof shopee.fetchOrders !== 'function') throw Object.assign(new Error('Modul Shopee belum tersedia'), { code: 'shopee_unavailable' });

    const staleChanged = []; const staleCancelled = [];
    for (const shop of shops) {
      const info = { shop_id: shop.shop_id, shop_name: shop.shop_name || null, fetched: 0, created: 0, updated: 0, error: null };
      try {
        log.info(`sync toko ${shop.shop_id} (${shop.shop_name || '-'}) mulai, trigger=${trigger}`);
        const rows = await fetchShopOrders({ shopee, shop, settings, now });
        const r = applyOrders({ repo, shop, rows });
        info.fetched = r.fetched; info.created = r.created; info.updated = r.updated;
        result.fetched += r.fetched; result.created += r.created; result.updated += r.updated;
        staleChanged.push(...r.stale_changed); staleCancelled.push(...r.stale_cancelled);
        details.cancelled.push(...r.cancelled); details.restored.push(...r.restored);
        if (r.errors.length) {
          details.errors.push(...r.errors);
          info.error = `Gagal menyimpan ${r.errors.length} order: ${r.errors[0].error}`;
        }
        anyShopOk = true;
      } catch (e) {
        info.error = summarizeError(e);
        log.error(`sync toko ${shop.shop_id} gagal: ${info.error}`);
      }
      details.shops.push(info);
      if (info.error) {
        result.status = 'failed';
        if (!result.error) result.error = shops.length > 1 ? `[${shop.shop_name || shop.shop_id}] ${info.error}` : info.error;
      }
    }

    // PDF usang untuk order yang sudah diproses lalu berubah / dibatalkan
    if (staleChanged.length) repo.markOrdersPdfStale(staleChanged, 'Isi order berubah setelah PDF dibuat');
    if (staleCancelled.length) repo.markOrdersPdfStale(staleCancelled, 'Order dibatalkan setelah PDF dibuat');
    result.changed_processed = [...new Set([...staleChanged, ...staleCancelled])];

    // Klasifikasi ulang semua order yang belum diproses
    if (anyShopOk) {
      if (preview && typeof preview.reclassifyAll === 'function') {
        try {
          const rc = await preview.reclassifyAll({ repo, settings, now });
          details.reclassified = rc && typeof rc.count === 'number' ? rc.count : rc || null;
        } catch (e) {
          details.reclassify_error = summarizeError(e);
          log.error('reclassifyAll gagal setelah sync', e);
        }
      } else {
        log.warn('modul engine/preview belum tersedia, klasifikasi ulang dilewati');
      }
    }
  } catch (e) {
    result.status = 'failed';
    result.error = summarizeError(e);
    log.error(`sync gagal: ${result.error}`);
  }

  details.duration_ms = Date.now() - t0;
  details.changed_processed = result.changed_processed;
  try {
    repo.finishSyncLog(logId, { status: result.status, fetched: result.fetched, created: result.created, updated: result.updated, error: result.error, details });
  } catch (e) {
    log.error('gagal menyimpan sync_log', e);
  }
  log.info(`sync selesai: status=${result.status} fetched=${result.fetched} created=${result.created} updated=${result.updated} stale=${result.changed_processed.length} durasi=${details.duration_ms}ms`);
  return result;
}

// ---------- API publik ----------
// runSync({ trigger, user }, ctx?) — ctx opsional { repo, shopee, preview, settings, now } (untuk test).
// Tidak pernah throw untuk kegagalan API: hasil { status:'failed', error }.
function runSync({ trigger = 'auto', user } = {}, ctx = {}) {
  if (running) return Promise.resolve({ already_running: true, sync_log_id: runningLogId, status: 'running' });
  const repo = ctx.repo || require('../db/repo');
  let logId = null;
  try {
    logId = repo.startSyncLog({ marketplace: 'shopee', trigger, user });
  } catch (e) {
    log.error('gagal membuat sync_log', e);
    return Promise.resolve({ sync_log_id: null, status: 'failed', fetched: 0, created: 0, updated: 0, changed_processed: [], error: summarizeError(e) });
  }
  runningLogId = logId;
  running = execute({ trigger, user, logId, repo, ctx })
    .catch((e) => {
      // Seharusnya tidak terjadi (execute sudah menangkap semua), jaga-jaga agar tidak reject
      log.error('sync error tak terduga', e);
      return { sync_log_id: logId, status: 'failed', fetched: 0, created: 0, updated: 0, changed_processed: [], error: summarizeError(e) };
    })
    .finally(() => {
      running = null;
      runningLogId = null;
      lastRunAt = tnow();
    });
  return running;
}

function nextRunAt(settings, hasShop) {
  if (!heartbeat) return null;
  const syncSet = (settings && settings.sync) || {};
  if (syncSet.enabled === false || !hasShop) return null;
  if (lastRunAt === null) return (schedulerStartedAt || tnow()) + FIRST_RUN_DELAY_S;
  return lastRunAt + intervalMinutes(syncSet) * 60;
}

function getStatus() {
  const repo = require('../db/repo');
  const settings = repo.getSettings();
  const syncSet = settings.sync || {};
  const { last, last_ok } = repo.lastSync('shopee');
  const primary = repo.getPrimaryShop('shopee');
  // Log terakhir yang sudah selesai (abaikan yang masih running)
  const lastFinished = last && last.status !== 'running' ? last : (repo.listSyncLogs(10).find((l) => l.status !== 'running') || null);
  let status = 'never';
  if (lastFinished) status = lastFinished.status === 'ok' ? 'ok' : 'failed';
  return {
    running: !!running,
    enabled: syncSet.enabled !== false,
    interval_minutes: intervalMinutes(syncSet),
    next_at: nextRunAt(settings, !!primary),
    last: last || null,
    last_ok: last_ok || null,
    marketplaces: {
      shopee: {
        connected: !!primary,
        shop_name: primary ? primary.shop_name || null : null,
        status,
        last_ok_at: last_ok ? last_ok.finished_at || null : null,
        last_error: lastFinished && lastFinished.status !== 'ok' ? lastFinished.error || null : null,
      },
    },
  };
}

async function tick() {
  try {
    if (running) return;
    const repo = require('../db/repo');
    const settings = repo.getSettings();
    const syncSet = settings.sync || {};
    if (syncSet.enabled === false) return;
    if (!repo.getPrimaryShop('shopee')) return;
    const due = nextRunAt(settings, true);
    if (due === null || tnow() < due) return;
    await runSync({ trigger: 'auto' });
  } catch (e) {
    log.error('scheduler error', e);
  }
}

function startScheduler() {
  if (heartbeat) return;
  schedulerStartedAt = tnow();
  lastRunAt = null;
  try {
    const repo = require('../db/repo');
    const n = repo.markRunningSyncLogsFailed('Sinkronisasi terputus karena server dimulai ulang');
    if (n) log.warn(`${n} sync_log yang menggantung ditandai gagal`);
  } catch (e) {
    log.warn('tidak bisa membersihkan sync_log menggantung', e);
  }
  firstTimer = setTimeout(() => { firstTimer = null; tick(); }, FIRST_RUN_DELAY_S * 1000);
  firstTimer.unref();
  heartbeat = setInterval(tick, HEARTBEAT_MS);
  heartbeat.unref();
  log.info('scheduler sync aktif (interval dibaca dari setting sync.interval_minutes)');
}

function stopScheduler() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  schedulerStartedAt = null;
}

function isRunning() { return !!running; }

module.exports = {
  runSync, getStatus, startScheduler, stopScheduler, isRunning,
  // diekspor untuk test/unit kecil
  summarizeError, materiallyChanged, intervalMinutes,
};
