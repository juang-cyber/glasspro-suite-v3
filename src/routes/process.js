'use strict';
// /api/process — preview, mulai run, progress, regenerate, batal, run aktif.
const express = require('express');
const repo = require('../db/repo');
const time = require('../util/time');
const { badRequest, notFound, wrap, httpError } = require('../util/errors');
const proc = require('../engine/process');

const router = express.Router();

function loadPreview() {
  try {
    return require('../engine/preview');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('preview')) throw httpError(503, 'module_missing', 'Modul preview belum tersedia di server');
    throw e;
  }
}

function parseId(v) {
  const id = parseInt(v, 10);
  if (!Number.isFinite(id) || id <= 0) throw badRequest('ID run tidak valid');
  return id;
}

// GET /preview?part=auto&warehouse=all
router.get('/preview', wrap(async (req, res) => {
  const part = String(req.query.part || 'auto').toLowerCase();
  const warehouse = String(req.query.warehouse || 'all').toLowerCase();
  if (!['auto', 'p1', 'p2', 'p3'].includes(part)) throw badRequest('Part tidak valid (auto/p1/p2/p3)');
  if (!['all', 'jkt', 'sby'].includes(warehouse)) throw badRequest('Gudang tidak valid (all/jkt/sby)');
  const include_processed = ['1', 'true', 'yes'].includes(String(req.query.include_processed || '').toLowerCase());
  const preview = loadPreview();
  const out = await preview.buildPreview({ part, warehouse, include_processed }, { settings: repo.getSettings(), repo, now: time.now(), activeRunOrderSns: proc.getActiveOrderSns() });
  res.json(out);
}));

// POST /run {part, warehouse, order_sns?, note?, ignore_sync_block?}
router.post('/run', wrap(async (req, res) => {
  const body = req.body || {};
  const order_sns = body.order_sns === undefined || body.order_sns === null ? undefined : body.order_sns;
  if (order_sns !== undefined && !Array.isArray(order_sns)) throw badRequest('order_sns harus berupa array');
  const out = await proc.startRun({
    part: body.part || 'auto', warehouse: body.warehouse || 'all', order_sns, note: body.note ? String(body.note).slice(0, 500) : undefined,
    user: req.user, ignore_sync_block: !!body.ignore_sync_block,
  });
  res.status(201).json(out);
}));

// GET /active -> {run_id|null, kind}
router.get('/active', (_req, res) => {
  res.json(proc.getActiveRun());
});

// GET /runs/:id -> {run, progress, orders, pdfs}
router.get('/runs/:id', wrap(async (req, res) => {
  const detail = proc.getRunDetail(parseId(req.params.id));
  if (!detail) throw notFound('Run tidak ditemukan');
  res.json(detail);
}));

// GET /runs/:id/progress -> progress ringan (polling)
router.get('/runs/:id/progress', wrap(async (req, res) => {
  const p = proc.getProgress(parseId(req.params.id));
  if (!p) throw notFound('Run tidak ditemukan');
  res.json(p);
}));

// POST /runs/:id/regenerate {only_failed?, pdf_ids?}
router.post('/runs/:id/regenerate', wrap(async (req, res) => {
  const body = req.body || {};
  if (body.pdf_ids !== undefined && body.pdf_ids !== null && !Array.isArray(body.pdf_ids)) throw badRequest('pdf_ids harus berupa array');
  const out = await proc.regenerate({ run_id: parseId(req.params.id), only_failed: !!body.only_failed, pdf_ids: body.pdf_ids || [], user: req.user, note: body.note });
  res.status(201).json(out);
}));

// POST /runs/:id/cancel
router.post('/runs/:id/cancel', wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const ok = proc.cancelRun(id);
  if (ok) repo.logActivity(req.user, 'process_cancel', String(id));
  res.json({ ok, message: ok ? 'Pembatalan diminta; order yang belum mulai akan dilewati' : 'Run tidak sedang berjalan' });
}));

module.exports = router;
