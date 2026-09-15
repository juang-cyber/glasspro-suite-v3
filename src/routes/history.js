'use strict';
// /api/history — riwayat run, unduh/lihat PDF, log aktivitas, log sync.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const express = require('express');
const config = require('../config');
const repo = require('../db/repo');
const { badRequest, notFound, wrap, httpError } = require('../util/errors');
const proc = require('../engine/process');

const router = express.Router();

function parseId(v, label = 'ID') {
  const id = parseInt(v, 10);
  if (!Number.isFinite(id) || id <= 0) throw badRequest(`${label} tidak valid`);
  return id;
}

function clampLimit(v, def = 50, max = 500) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// Pastikan path file berada di dalam config.PDF_DIR (cegah path traversal). Mengembalikan path absolut.
function safePdfPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const root = path.resolve(config.PDF_DIR);
  const abs = path.resolve(root, filePath);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const r = norm(root); const a = norm(abs);
  if (a === r || !a.startsWith(r + path.sep)) return null;
  return abs;
}

// Nama file aman untuk header Content-Disposition (ASCII, tanpa tanda kutip/kontrol).
function safeFileName(name) {
  const base = path.basename(String(name || 'file.pdf')).replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_').trim();
  return base || 'file.pdf';
}

function sendPdf(req, res, next, { inline }) {
  const pdf = repo.getPdf(parseId(req.params.id, 'ID PDF'));
  if (!pdf) throw notFound('PDF tidak ditemukan');
  const abs = safePdfPath(pdf.file_path);
  if (!abs) throw httpError(403, 'forbidden', 'Lokasi file PDF tidak diizinkan');
  let stat;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isFile()) throw notFound('File PDF tidak ditemukan di penyimpanan (mungkin sudah dihapus)');
  const name = safeFileName(pdf.file_name);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(abs), res, (err) => { if (err && !res.headersSent) next(err); });
}

// GET /runs?page&limit&kind&status
router.get('/runs', wrap(async (req, res) => {
  const { page, limit, kind, status, part, warehouse } = req.query;
  if (kind && !['process', 'regenerate'].includes(String(kind))) throw badRequest('kind tidak valid (process/regenerate)');
  res.json(repo.listRuns({ page: parseInt(page, 10) || 1, limit: clampLimit(limit, 20, 200), kind: kind || undefined, status: status || undefined, part: part || undefined, warehouse: warehouse || undefined }));
}));

// GET /runs/:id -> sama dengan /api/process/runs/:id
router.get('/runs/:id', wrap(async (req, res) => {
  const detail = proc.getRunDetail(parseId(req.params.id, 'ID run'));
  if (!detail) throw notFound('Run tidak ditemukan');
  res.json(detail);
}));

// GET /pdfs/recent?limit  (harus sebelum /pdfs/:id)
router.get('/pdfs/recent', wrap(async (req, res) => {
  res.json({ items: repo.listRecentPdfs(clampLimit(req.query.limit, 50, 500)) });
}));

// GET /pdfs/:id -> metadata
router.get('/pdfs/:id', wrap(async (req, res) => {
  const pdf = repo.getPdf(parseId(req.params.id, 'ID PDF'));
  if (!pdf) throw notFound('PDF tidak ditemukan');
  const abs = safePdfPath(pdf.file_path);
  let exists = false;
  try { exists = !!abs && fs.statSync(abs).isFile(); } catch { exists = false; }
  res.json({ pdf: { ...pdf, file_exists: exists } });
}));

// GET /pdfs/:id/download -> attachment
router.get('/pdfs/:id/download', wrap(async (req, res, next) => sendPdf(req, res, next, { inline: false })));
// GET /pdfs/:id/view -> inline
router.get('/pdfs/:id/view', wrap(async (req, res, next) => sendPdf(req, res, next, { inline: true })));

// GET /activity?limit
router.get('/activity', wrap(async (req, res) => {
  res.json({ items: repo.listActivity(clampLimit(req.query.limit, 100, 1000)) });
}));

// GET /sync-logs?limit
router.get('/sync-logs', wrap(async (req, res) => {
  res.json({ items: repo.listSyncLogs(clampLimit(req.query.limit, 50, 500)) });
}));

module.exports = router;
module.exports.safePdfPath = safePdfPath;
