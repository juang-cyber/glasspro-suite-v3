'use strict';
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const log = require('./util/log');
const db = require('./db');
const repo = require('./db/repo');
const { attachUser, requireAuth } = require('./middleware/auth');

function safeRequire(p) {
  try {
    return require(p);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(p.replace('./', ''))) {
      log.warn(`modul ${p} belum tersedia, dilewati`);
      return null;
    }
    throw e;
  }
}

function createApp() {
  db.open();
  repo.ensureSeeded();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(
    cookieSession({
      name: 'gps_session',
      keys: [config.SESSION_SECRET],
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.APP_URL.startsWith('https://') && config.NODE_ENV === 'production',
    }),
  );
  app.use(attachUser);

  // Health (tanpa login)
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: config.VERSION, time: Math.floor(Date.now() / 1000), app: 'glasspro-suite' }));

  // Jembatan ke API Shopee (dilindungi BRIDGE_TOKEN, tanpa login) - dipakai instance lokal
  const bridge = safeRequire('./bridge/router');
  if (bridge) app.use('/bridge', bridge);

  // Auth
  app.use('/api/auth', require('./routes/auth'));

  // Callback OAuth Shopee harus bisa diakses tanpa login (Shopee yang redirect ke sini)
  const shopeeRoutes = safeRequire('./routes/shopee');
  if (shopeeRoutes) app.use('/api/shopee', shopeeRoutes);

  // Semua route API lain wajib login
  const mount = (p, mod) => { const r = safeRequire(mod); if (r) app.use(p, requireAuth, r); };
  mount('/api/sync', './routes/sync');
  mount('/api/orders', './routes/orders');
  mount('/api/process', './routes/process');
  mount('/api/history', './routes/history');
  mount('/api/dashboard', './routes/dashboard');
  mount('/api/settings', './routes/settings');

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found', message: 'Endpoint tidak ditemukan' }));

  // SPA statis
  const pub = path.join(config.ROOT, 'public');
  app.use(express.static(pub, { index: 'index.html', maxAge: config.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/bridge/')) return next();
    res.sendFile(path.join(pub, 'index.html'));
  });

  // Error handler JSON
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    // Body JSON tidak valid dari express.json → 400 yang jelas
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'bad_request', message: 'Body JSON tidak valid' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Ukuran body terlalu besar' });
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500 && !err.expose) log.error('unhandled', err);
    else if (status >= 500) log.warn(`${req.method} ${req.path} → ${status} ${err.code || ''}: ${err.message}`);
    res.status(status).json({ error: err.code || 'internal_error', message: err.expose || status < 500 ? err.message : 'Terjadi kesalahan pada server', details: err.details });
  });

  return app;
}

function start() {
  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    log.info(`Glass Pro Suite v${config.VERSION} berjalan di http://${config.HOST}:${config.PORT} (storage: ${config.STORAGE_DIR})`);
    const sync = safeRequire('./engine/sync');
    if (sync && typeof sync.startScheduler === 'function') sync.startScheduler();
  });
  const shutdown = () => {
    log.info('shutdown...');
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start };
