'use strict';
// Preview proses: klasifikasi ulang order, terapkan override, saring gudang/part,
// kelompokkan per (jenis pengiriman, kategori, gudang), product list, status sync.
const { DEFAULTS } = require('../settings-defaults');
const time = require('../util/time');
const { badRequest } = require('../util/errors');
const classify = require('./classify');
const validate = require('./validate');
const partEngine = require('./part');
const naming = require('./naming');

const FETCH_STATUSES = ['READY_TO_SHIP', 'PROCESSED'];
const FETCH_PROC = ['unprocessed', 'review', 'failed', 'processing'];
const SHIP_ORDER = { instant: 0, regular: 1 };
const CAT_ORDER = { tg: 0, hg: 1, mix: 2 };

function getRepo(ctx) { return (ctx && ctx.repo) || require('../db/repo'); }
function getSettings(ctx, repo) { return (ctx && ctx.settings) || repo.getSettings(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ---------- OrderSummary ----------
// order: baris repo.getOrder (boleh sudah digabung dengan Derived terbaru).
function toSummary(order, now) {
  const o = order || {};
  // Entri null / bukan objek dibuang (konsisten dengan classify.classifyOrder).
  const items = (Array.isArray(o.items) ? o.items : []).filter((it) => it && typeof it === 'object').map((i) => {
    return {
      item_name: i.item_name ?? null,
      model_name: i.model_name ?? null,
      item_sku: i.item_sku ?? null,
      model_sku: i.model_sku ?? null,
      qty: num(i.qty),
      category: i.category ?? null,
      phone_type: i.phone_type ?? null,
      phone_type_required: !!i.phone_type_required,
      image_url: i.image_url ?? null,
    };
  });
  return {
    order_sn: o.order_sn,
    marketplace: o.marketplace || 'shopee',
    order_status: o.order_status ?? null,
    proc_status: o.proc_status ?? 'unprocessed',
    create_time: o.create_time ?? null,
    update_time: o.update_time ?? null,
    ship_by_date: o.ship_by_date ?? null,
    shipping_carrier: o.shipping_carrier || o.checkout_shipping_carrier || null,
    ship_type: o.ship_type ?? null,
    sku_category: o.sku_category ?? null,
    warehouse_code: o.warehouse_code ?? null,
    buyer_username: o.buyer_username ?? null,
    recipient_name: o.recipient_name ?? null,
    recipient_phone: o.recipient_phone ?? null,
    recipient_address: o.recipient_address ?? null,
    note: o.note ?? null,
    message_to_seller: o.message_to_seller ?? null,
    cod: !!o.cod,
    total_amount: o.total_amount ?? null,
    currency: o.currency ?? null,
    items,
    item_count: items.length,
    qty_total: items.reduce((a, it) => a + it.qty, 0),
    phone_type: o.phone_type && typeof o.phone_type === 'object' ? o.phone_type : { value: null, source: null, required: false, missing: false },
    validation: o.validation && typeof o.validation === 'object' ? o.validation : { holds: [], warnings: [], flags: { tipe_belum_ditulis: false, deadline_hours_left: null, needs_review: false } },
    overrides: o.overrides && typeof o.overrides === 'object' ? o.overrides : {},
    pdf_stale: !!o.pdf_stale,
    tracking_number: o.tracking_number ?? null,
    proc_run_id: o.proc_run_id ?? null,
    processed_at: o.processed_at ?? null,
    last_error: o.last_error ?? null,
    deadline_hours_left: validate.deadlineHoursLeft(o, now),
  };
}

// ---------- klasifikasi + simpan ----------
// Klasifikasi & validasi satu order dengan setting saat ini, simpan via repo.setOrderDerived,
// sinkronkan proc_status review <-> unprocessed. Mengembalikan order gabungan (row + derived).
function classifyAndStore(order, settings, ctx = {}, repo) {
  const now = Number(ctx.now) || time.now();
  const derived = classify.classifyOrder(order, settings);
  // Validasi yang DISIMPAN bebas konteks (tanpa part & tanpa daftar run aktif): REGULAR_WAIT_P1 hanya berlaku
  // saat preview p3 dan IN_PROGRESS dari run aktif berubah tiap saat. Kalau ikut disimpan, daftar order &
  // KPI "ditahan" di dashboard menampilkan hold basi sampai sync berikutnya.
  const stored = validate.validateOrder(order, derived, settings, { now });
  repo.setOrderDerived(order.order_sn, { ...derived, validation: stored });
  let proc_status = order.proc_status;
  if (stored.flags.needs_review && (proc_status === 'unprocessed' || proc_status === 'review')) {
    proc_status = 'review';
  } else if (!stored.flags.needs_review && proc_status === 'review') {
    proc_status = 'unprocessed';
  }
  if (proc_status !== order.proc_status) repo.setOrderProc(order.order_sn, { proc_status });
  // Validasi KONTEKSTUAL (part / run aktif) hanya untuk hasil yang dikembalikan ke preview.
  const active = ctx.activeRunOrderSns;
  const hasCtx = !!ctx.part || !!(active && typeof active.has === 'function' && active.size);
  const validation = hasCtx
    ? validate.validateOrder(order, derived, settings, { now, part: ctx.part || null, activeRunOrderSns: active })
    : stored;
  return { ...order, ...derived, validation, proc_status };
}

// Klasifikasi ulang semua order yang belum processed/cancelled. Dipanggil setelah sync & ubah setting.
function reclassifyAll(ctx) {
  if (!ctx || typeof ctx !== 'object') ctx = {};
  const repo = getRepo(ctx);
  const settings = getSettings(ctx, repo);
  const now = Number(ctx.now) || time.now();
  const orders = repo.allOrders({}).filter((o) => o.proc_status !== 'processed' && o.proc_status !== 'cancelled');
  const run = () => {
    let count = 0;
    for (const o of orders) {
      classifyAndStore(o, settings, { now, part: ctx.part || null, activeRunOrderSns: ctx.activeRunOrderSns }, repo);
      count++;
    }
    return count;
  };
  const count = typeof repo.transaction === 'function' ? repo.transaction(run)() : run();
  return { count };
}

// ---------- status sync ----------
function syncStatus(repo, settings, now) {
  const ls = (typeof repo.lastSync === 'function' && repo.lastSync('shopee')) || { last: null, last_ok: null };
  const last = ls.last || null;
  const lastOk = ls.last_ok || null;
  const interval = num((settings.sync || DEFAULTS.sync).interval_minutes) || DEFAULTS.sync.interval_minutes;
  const last_ok_at = lastOk ? (lastOk.finished_at || lastOk.started_at || null) : null;
  const last_at = last ? (last.finished_at || last.started_at || null) : null;
  const last_status = last ? last.status : null;
  return {
    ok: !!lastOk && last_status !== 'failed',
    last_ok_at,
    last_at,
    last_status,
    last_error: last && last.error ? last.error : null,
    stale: !last_ok_at || (now - last_ok_at) > 2 * interval * 60,
    interval_minutes: interval,
  };
}

function blockedReason(repo, sync) {
  const shop = typeof repo.getPrimaryShop === 'function' ? repo.getPrimaryShop('shopee') : null;
  if (!shop) return { code: 'NOT_CONNECTED', message: 'Toko Shopee belum terhubung. Hubungkan toko di Pengaturan.' };
  if (!sync.last_ok_at) return { code: 'NO_SYNC', message: 'Belum pernah ada sinkronisasi yang berhasil. Jalankan Sync terlebih dahulu.' };
  if (sync.last_status === 'failed') return { code: 'SYNC_FAILED', message: `Sinkronisasi terakhir gagal${sync.last_error ? ': ' + sync.last_error : ''}. Data order mungkin tidak terbaru.` };
  return null;
}

// ---------- preview ----------
function sortGroups(a, b, whOrder) {
  const s = (SHIP_ORDER[a.ship_type] ?? 9) - (SHIP_ORDER[b.ship_type] ?? 9);
  if (s) return s;
  const c = (CAT_ORDER[a.sku_category] ?? 9) - (CAT_ORDER[b.sku_category] ?? 9);
  if (c) return c;
  return (whOrder[a.warehouse_code] ?? 99) - (whOrder[b.warehouse_code] ?? 99);
}

function sortOrders(a, b) {
  const da = a.ship_by_date || Infinity;
  const db = b.ship_by_date || Infinity;
  if (da !== db) return da - db;
  return String(a.order_sn).localeCompare(String(b.order_sn));
}

function buildPreview(opts, ctx) {
  const { part = 'auto', warehouse = 'all', include_processed = false } = opts && typeof opts === 'object' ? opts : {};
  if (!ctx || typeof ctx !== 'object') ctx = {};
  const repo = getRepo(ctx);
  const settings = getSettings(ctx, repo);
  const now = Number(ctx.now) || time.now();
  const warehouses = (Array.isArray(settings.warehouses) ? settings.warehouses : DEFAULTS.warehouses).filter((w) => w && w.code);
  const whCodes = warehouses.map((w) => w.code);
  const whOrder = {}; whCodes.forEach((c, i) => { whOrder[c] = i; }); whOrder.all = 50;

  const part_auto = partEngine.currentPart(settings, now);
  const partIn = String(part || 'auto').trim().toLowerCase();
  const selPart = partIn === 'auto' || partIn === '' ? part_auto.part : partIn;
  if (!partEngine.isValidPart(selPart)) throw badRequest(`Part tidak dikenal: ${part}`);
  const selWh = String(warehouse || 'all').trim().toLowerCase() || 'all';
  if (selWh !== 'all' && !whCodes.includes(selWh)) throw badRequest(`Gudang tidak dikenal: ${warehouse}`);
  const mergeAll = selWh === 'all' && ((settings.process || DEFAULTS.process).all_warehouses_mode === 'merge');

  // 1) ambil order kandidat & klasifikasi ulang dengan setting saat ini
  const procList = include_processed ? [...FETCH_PROC, 'processed'] : FETCH_PROC;
  const rows = repo.allOrders({ order_status: FETCH_STATUSES, proc_status: procList });
  const vctx = { now, part: selPart, activeRunOrderSns: ctx.activeRunOrderSns };
  const classifyAll = () => rows.map((o) => classifyAndStore(o, settings, vctx, repo));
  const orders = typeof repo.transaction === 'function' ? repo.transaction(classifyAll)() : classifyAll();

  // 2) saring gudang, bagi ke grup / held / review / excluded
  const groupsMap = new Map();
  const held = []; const review = []; const excluded = [];
  const totals = {
    orders: 0, products: 0,
    by_category: { tg: 0, hg: 0, mix: 0 },
    by_ship_type: { instant: 0, regular: 0 },
    by_warehouse: {}, by_marketplace: { shopee: 0 },
    held: 0, review: 0, excluded: 0,
  };
  for (const c of whCodes) totals.by_warehouse[c] = 0;
  const productMap = new Map();

  for (const o of orders) {
    // Filter gudang: order dengan gudang lain disembunyikan (WAREHOUSE_FILTER); gudang null tetap masuk review.
    if (selWh !== 'all' && o.warehouse_code && o.warehouse_code !== selWh) continue;
    const summary = toSummary(o, now);
    const holds = (o.validation && o.validation.holds) || [];
    const flags = (o.validation && o.validation.flags) || {};
    if (holds.some((h) => h.code === 'EXCLUDED')) {
      excluded.push({ ...summary, reasons: holds });
      continue;
    }
    if (flags.needs_review) {
      review.push({ ...summary, reasons: holds });
      continue;
    }
    if (holds.length) {
      held.push({ ...summary, reasons: holds });
      continue;
    }
    // masuk grup. PDF hanya ada untuk tg/hg/mix; order berkategori 'review' yang lolos hold (force_process
    // tanpa override kategori) dimasukkan ke 'mix' supaya nama file & cover tetap sesuai kontrak.
    const effCat = naming.catCode(o.sku_category);
    if (summary.sku_category !== effCat) summary.sku_category = effCat;
    const gwh = mergeAll ? 'all' : o.warehouse_code;
    const gdef = { ship_type: o.ship_type, sku_category: effCat, warehouse_code: gwh };
    const key = naming.groupKey(gdef);
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        key, ...gdef,
        label: naming.groupLabel(gdef, settings),
        file_name: naming.pdfFileName({ ts: now, part: selPart, kind: 'labels', ...gdef }),
        orders: [], qty_total: 0,
      });
    }
    const g = groupsMap.get(key);
    g.orders.push(summary);
    g.qty_total += summary.qty_total;

    totals.orders++;
    totals.products += summary.qty_total;
    if (totals.by_category[effCat] !== undefined) totals.by_category[effCat]++;
    if (totals.by_ship_type[o.ship_type] !== undefined) totals.by_ship_type[o.ship_type]++;
    if (o.warehouse_code) totals.by_warehouse[o.warehouse_code] = (totals.by_warehouse[o.warehouse_code] || 0) + 1;
    const mp = o.marketplace || 'shopee';
    totals.by_marketplace[mp] = (totals.by_marketplace[mp] || 0) + 1;

    // product list
    for (const it of o.items || []) {
      const sku = it.model_sku || it.item_sku || '-';
      const pkey = `${mp} ${sku} ${it.item_name || ''} ${it.model_name || ''}`;
      if (!productMap.has(pkey)) {
        productMap.set(pkey, { marketplace: mp, sku, item_name: it.item_name || '', model_name: it.model_name || '', category: it.category || null, qty: 0, order_count: 0, _orders: new Set() });
      }
      const p = productMap.get(pkey);
      p.qty += num(it.qty);
      p._orders.add(o.order_sn);
    }
  }

  const groups = [...groupsMap.values()].sort((a, b) => sortGroups(a, b, whOrder));
  for (const g of groups) g.orders.sort(sortOrders);
  held.sort(sortOrders); review.sort(sortOrders); excluded.sort(sortOrders);
  totals.held = held.length; totals.review = review.length; totals.excluded = excluded.length;

  const product_list = [...productMap.values()]
    .map((p) => { const { _orders, ...rest } = p; return { ...rest, order_count: _orders.size }; })
    .sort((a, b) => {
      const c = (CAT_ORDER[a.category] ?? 9) - (CAT_ORDER[b.category] ?? 9);
      if (c) return c;
      const s = String(a.sku).localeCompare(String(b.sku));
      if (s) return s;
      return String(a.model_name).localeCompare(String(b.model_name));
    });

  const sync = syncStatus(repo, settings, now);
  const blocked = blockedReason(repo, sync);
  const win = partEngine.partWindow(settings, selPart);

  return {
    part: selPart,
    part_label: win ? win.label : selPart,
    part_window: win ? { start: win.start, end: win.end } : null,
    part_auto,
    warehouse: selWh,
    warehouse_name: naming.warehouseLabel(selWh, settings),
    include_processed: !!include_processed,
    generated_at: now,
    sync,
    blocked,
    totals,
    groups,
    held,
    review,
    excluded,
    product_list,
    product_list_file_name: naming.pdfFileName({ ts: now, part: selPart, warehouse_code: selWh, kind: 'productlist' }),
  };
}

module.exports = { toSummary, buildPreview, reclassifyAll, classifyAndStore, syncStatus, blockedReason, FETCH_STATUSES, FETCH_PROC };
