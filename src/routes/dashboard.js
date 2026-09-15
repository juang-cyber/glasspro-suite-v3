'use strict';
// /api/dashboard — ringkasan KPI, status part hari ini, grafik, aktivitas terbaru.
const express = require('express');
const repo = require('../db/repo');
const sync = require('../engine/sync');
const { wrap } = require('../util/errors');
const { now: tnow, startOfDay, minutesOfDay, parseHHMM } = require('../util/time');

const router = express.Router();

const PART_KEYS = ['p1', 'p2', 'p3'];
const PENDING_STATUSES = ['unprocessed', 'review'];
const FINISHED_RUN = new Set(['done', 'partial']);

// Hold yang benar-benar menahan (WAREHOUSE_FILTER hanya penyaring, bukan hold tampil)
function hasHold(order) {
  const holds = order && order.validation && Array.isArray(order.validation.holds) ? order.validation.holds : [];
  return holds.some((h) => h && h.code && h.code !== 'WAREHOUSE_FILTER');
}

function inc(obj, key) { obj[key] = (obj[key] || 0) + 1; }

function buildParts(settings, runsToday, now) {
  const parts = (settings && settings.parts) || {};
  const mod = minutesOfDay(now);
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
  const counts = repo.countOrders();
  const byProc = counts.byProc || {};
  const dayStart = startOfDay(now);

  // Order yang masih menunggu diproses (unprocessed / review) -> dihitung di JS
  const pending = repo.allOrders({ proc_status: PENDING_STATUSES });
  const by_category = { tg: 0, hg: 0, mix: 0, review: 0 };
  const by_ship_type = { instant: 0, regular: 0 };
  const by_warehouse = { jkt: 0, sby: 0, unknown: 0 };
  let held = 0; let instantPending = 0;
  for (const o of pending) {
    if (hasHold(o)) held++;
    if (o.proc_status === 'unprocessed' && o.ship_type === 'instant') instantPending++;
    inc(by_category, o.sku_category && o.sku_category !== 'review' && by_category[o.sku_category] !== undefined ? o.sku_category : 'review');
    inc(by_ship_type, o.ship_type === 'instant' ? 'instant' : 'regular');
    inc(by_warehouse, o.warehouse_code ? String(o.warehouse_code) : 'unknown');
  }

  const kpis = {
    unprocessed: byProc.unprocessed || 0,
    review: byProc.review || 0,
    held,
    processed_today: repo.countProcessedSince(dayStart),
    failed: byProc.failed || 0,
    instant_pending: instantPending,
    stale_pdf: repo.listOrders({ pdf_stale: true, limit: 1 }).total,
  };

  const runsToday = repo.listRuns({ kind: 'process', limit: 200 }).items.filter((r) => (r.started_at || 0) >= dayStart);
  const primary = repo.getPrimaryShop('shopee');

  res.json({
    generated_at: now,
    kpis,
    sync: sync.getStatus(),
    shopee: { connected: !!primary, shop_name: primary ? primary.shop_name || null : null },
    parts: buildParts(settings, runsToday, now),
    recent_runs: repo.listRuns({ limit: 5 }).items,
    orders_per_day: repo.ordersPerDay(14),
    by_category,
    by_ship_type,
    by_warehouse,
    recent_activity: repo.listActivity(10),
    counts,
  });
}));

module.exports = router;
