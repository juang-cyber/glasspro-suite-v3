'use strict';
const express = require('express');
const repo = require('../db/repo');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Rate-limit sederhana untuk login (per IP): 10 percobaan / 5 menit
const attempts = new Map();
function tooMany(ip) {
  const t = Date.now();
  const a = (attempts.get(ip) || []).filter((x) => t - x < 5 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}
function noteAttempt(ip) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); }

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'too_many', message: 'Terlalu banyak percobaan. Coba lagi dalam 5 menit.' });
  const { username, password } = req.body || {};
  const row = repo.getUserByUsername(username);
  if (!row || !row.active || !repo.verifyPassword(row, password)) {
    noteAttempt(ip);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Username atau password salah' });
  }
  req.session.uid = row.id;
  repo.touchLogin(row.id);
  repo.logActivity(repo.publicUser(row), 'login', null, { ip });
  res.json({ user: repo.publicUser(row) });
});

router.post('/logout', (req, res) => {
  if (req.user) repo.logActivity(req.user, 'logout');
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: req.user });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const row = repo.getUserByUsername(req.user.username);
  if (!repo.verifyPassword(row, current_password)) return res.status(400).json({ error: 'wrong_password', message: 'Password saat ini salah' });
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'weak_password', message: 'Password baru minimal 6 karakter' });
  repo.updateUser(req.user.id, { password: new_password });
  repo.logActivity(req.user, 'change_password');
  res.json({ ok: true });
});

module.exports = router;
