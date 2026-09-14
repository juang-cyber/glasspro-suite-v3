'use strict';
// Load .env (tanpa dependency) lalu expose konfigurasi runtime.
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = process.env;
const ROOT = path.resolve(__dirname, '..');
const STORAGE_DIR = path.resolve(process.cwd(), env.STORAGE_DIR || './storage');

const config = {
  ROOT,
  PORT: parseInt(env.PORT || '3000', 10),
  HOST: env.HOST || '0.0.0.0',
  STORAGE_DIR,
  DB_PATH: path.join(STORAGE_DIR, 'glasspro.db'),
  PDF_DIR: path.join(STORAGE_DIR, 'pdf'),
  SESSION_SECRET: env.SESSION_SECRET || 'dev-secret-ganti-di-produksi',
  APP_URL: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  NODE_ENV: env.NODE_ENV || 'development',
  ADMIN_USER: env.ADMIN_USER || 'admin',
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || 'glasspro123',
  ADMIN_NAME: env.ADMIN_NAME || 'Admin Glass Pro',
  BRIDGE_TOKEN: env.BRIDGE_TOKEN || '',
  // Nilai awal Shopee (disimpan ke tabel settings saat pertama kali jalan)
  SHOPEE: {
    partner_id: env.SHOPEE_PARTNER_ID ? parseInt(env.SHOPEE_PARTNER_ID, 10) : null,
    partner_key: env.SHOPEE_PARTNER_KEY || '',
    env: env.SHOPEE_ENV || 'live',
    redirect_url: env.SHOPEE_REDIRECT_URL || '',
    transport: env.SHOPEE_TRANSPORT || (env.SHOPEE_MOCK === '1' ? 'mock' : 'direct'),
    bridge_url: env.SHOPEE_BRIDGE_URL || '',
    bridge_token: env.SHOPEE_BRIDGE_TOKEN || '',
  },
  TIMEZONE: env.TIMEZONE || 'Asia/Jakarta',
  VERSION: require('../package.json').version,
};

module.exports = config;
