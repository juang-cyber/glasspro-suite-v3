'use strict';
const repo = require('../db/repo');

// Isi req.user dari cookie sesi (jika ada).
function attachUser(req, _res, next) {
  req.user = null;
  const uid = req.session && req.session.uid;
  if (uid) {
    const u = repo.getUserById(uid);
    if (u && u.active) req.user = u;
    else req.session = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Silakan login terlebih dahulu' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Silakan login terlebih dahulu' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Hanya admin yang boleh melakukan ini' });
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin };
