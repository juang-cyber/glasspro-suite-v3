'use strict';
// /api/dashboard — ringkasan KPI, status part hari ini, grafik, aktivitas terbaru.
const express = require('express');
const repo = require('../db/repo');
const sync = require('../engine/sync');
const { wrap } = require('../util/errors');
const { now: tnow, startOfDay, minutesOfDay, parseHHMM, isoDate, DEFAULT_TZ } = require('../util/time');

const router = express.Router();

const PART_KEYS = ['p1', 'p2', 'p3'];
const PENDING_STATUSES = ['unprocessed', 'review'];
// Hanya status Shopee ini yang bisa diproses (kontrak §2); SHIPPED/COMPLETED yang tidak lewat app cuma disembunyikan.
const PROCESSABLE_STATUSES = ['READY_TO_SHIP', 'PROCESSED'];
const FINISHED_RUN = new Set(['done', 'partial']);
// Hold yang bukan "tertahan" di KPI: penyaring gudang, status belum siap (disembunyikan), dikeluarkan manual (tab sendiri)
const NON_HOLD_CODES = new Set(['WAREHOUSE_FILTER', 'STATUS_NOT_READY', 'EXCLUDED']);
const DAYS_CHART = 14;

function holdsOf(order) {
  return order && order.validation && Array.isArray(order.validation.holds) ? order.validation.holds.filter((h) => h && h.code) : [];
}
function hasHold(order) { return holdsOf(order).some((h) => !NON_HOLD_CODES.has(h.code)); }
function isExcluded(order) { return holdsOf(order).some((h) => h.code === 'EXCLUDED') || !!(order.overrides && order.overrides.excluded); }
function needsReview(order) { return order.proc_status === 'review' || !!(order.validation && order.validation.flags && order.validation.flags.needs_review); }

function inc(obj, key) { obj[key] = (obj[key] || 0) + 1; }

function tzOf(settings) { return (settings && settings.app && settings.app.timezone) || DEFAULT_TZ; }

// Deret harian lengkap DAYS_CHART hari terakhir (hari tanpa order tetap muncul dengan 0) agar grafik rapi.
function fillOrdersPerDay(rows, now, tz) {
  const map = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.date, r]));
  const out = [];
  for (let i = DAYS_CHART - 1; i >= 0; i--) {
    const date = isoDate(now - i * 86400, tz);
    const r = map.get(date);
    out.push({ date, orders: r ? Number(r.orders) || 0 : 0, processed: r ? Number(r.processed) || 0 : 0 });
  }
  return out;
}

function buildParts(settings, runsToday, now, tz) {
  const parts = (settings && settings.parts) || {};
  const mod = minutesOfDay(now, tz);
  return PART_KEYS.map((key) => {
    const p = parts[key] || {};
    const start = parseHHMM(p.start);
    const end = parseHHMM(p.end);
    const runs = runsToday.filter((r) => r.part === key);
    const finished = runs.filter((r) => FINISHED_RUN.has(r.status));
    const isRunning = runs.some((r) => r.status === 'running');
    let status = 'upcoming';
    if (finished.length) status = 'done';
    else if (isRunning || (start !== null && end !== null && mod >= start && mod < end)) status = 'active';
    return {
      key,
      label: p.label || key.toUpperCase(),
      start: p.start || null,
      end: p.end || null,
      status,
      running: isRunning,
      processed_count: runs.reduce((a, r) => a + (Number(r.order_ok) || 0), 0),
      run_ids: runs.map((r) => r.id),
    };
  });
}

router.get('/', wrap(async (_req, res) => {
  const now = tnow();
  const settings = repo.getSettings();
  const tz = tzOf(settings);
  const counts = repo.countOrders();
  const byProc = counts.byProc || {};
  const dayStart = startOfDay(now, tz);

  // Order yang masih menunggu diproses (unprocessed / review) dan statusnya di Shopee memang bisa diproses.
  // Pembagian meniru preview: excluded (tab sendiri) -> review (Perlu Diperiksa) -> held (tertahan) -> siap.
  const pending = repo.allOrders({ proc_status: PENDING_STATUSES, order_status: PROCESSABLE_STATUSES });
  const by_category = { tg: 0, hg: 0, mix: 0, review: 0 };
  const by_ship_type = { instant: 0, regular: 0 };
  const by_warehouse = { jkt: 0, sby: 0, unknown: 0 };
  let unprocessed = 0; let review = 0; let held = 0; let excluded = 0; let instantPending = 0;
  for (const o of pending) {
    if (o.proc_status === 'review') review++; else unprocessed++;
    if (isExcluded(o)) excluded++;
    else if (!needsReview(o) && hasHold(o)) held++;
    if (o.ship_type === 'instant' && !isExcluded(o)) instantPending++;
    inc(by_category, o.sku_category && o.sku_category !== 'review' && by_category[o.sku_category] !== undefined ? o.sku_category : 'review');
    inc(by_ship_type, o.ship_type === 'instant' ? 'instant' : 'regular');
    inc(by_warehouse, o.warehouse_code ? String(o.warehouse_code) : 'unknown');
  }

  const kpis = {
    unprocessed,
    review,
    held,
    processed_today: repo.countProcessedSince(dayStart),
    failed: byProc.failed || 0,
    instant_pending: instantPending,
    stale_pdf: repo.listOrders({ pdf_stale: true, limit: 1 }).total,
    excluded,
  };

  const runsToday = repo.listRuns({ kind: 'process', limit: 200 }).items.filter((r) => (r.started_at || 0) >= dayStart);
  const primary = repo.getPrimaryShop('shopee');

  res.json({
    generated_at: now,
    timezone: tz,
    kpis,
    sync: sync.getStatus(),
    shopee: { connected: !!primary, shop_name: primary ? primary.shop_name || null : null },
    parts: buildParts(settings, runsToday, now, tz),
    recent_runs: repo.listRuns({ limit: 5 }).items,
    orders_per_day: fillOrdersPerDay(repo.ordersPerDay(DAYS_CHART, tz), now, tz),
    by_category,
    by_ship_type,
    by_warehouse,
    recent_activity: repo.listActivity(10),
    counts,
  });
}));

module.exports = router;
