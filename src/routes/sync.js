'use strict';
// /api/sync — sinkronisasi manual, status, dan log. (Semua sudah dilindungi requireAuth di index.js.)
const express = require('express');
const repo = require('../db/repo');
const sync = require('../engine/sync');
const { wrap } = require('../util/errors');

const router = express.Router();

// POST /now — jalankan sync sekarang (manual). Jika sedang berjalan: { already_running:true, sync_log_id }.
router.post('/now', wrap(async (req, res) => {
  const result = await sync.runSync({ trigger: 'manual', user: req.user });
  if (!result.already_running) {
    repo.logActivity(req.user, 'sync_manual', null, {
      status: result.status, fetched: result.fetched, created: result.created, updated: result.updated,
      changed_processed: (result.changed_processed || []).length, error: result.error || undefined,
    });
  }
  res.json(result);
}));

// GET /status — status scheduler + hasil sync terakhir
router.get('/status', (_req, res) => {
  res.json(sync.getStatus());
});

// GET /logs?limit — riwayat sync_log (terbaru dulu)
router.get('/logs', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json({ items: repo.listSyncLogs(limit), limit });
});

module.exports = router;
