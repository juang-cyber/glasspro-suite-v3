'use strict';
// /api/settings — pengaturan aplikasi (GET semua user, PUT admin) + manajemen user (admin).
const express = require('express');
const repo = require('../db/repo');
const { DEFAULTS } = require('../settings-defaults');
const { requireAdmin } = require('../middleware/auth');
const { badRequest, notFound, conflict, wrap } = require('../util/errors');
const { now: tnow, parseHHMM } = require('../util/time');
const log = require('../util/log').make('settings');

const router = express.Router();

const TRANSPORT_OPTIONS = ['direct', 'bridge', 'mock'];
const DOCUMENT_TYPES = ['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'];
const DELIVERY_METHODS = ['auto', 'pickup', 'dropoff'];
const MATCH_MODES = ['token', 'contains', 'regex'];
const PHONE_MODES = ['all', 'patterns', 'none'];
const PHONE_SOURCES = ['model_name', 'note', 'message_to_seller'];
const WAREHOUSE_MODES = ['split', 'merge'];
const ROLES = ['admin', 'staff'];
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const CODE_RE = /^[a-z0-9_-]{1,16}$/;
const META = {
  warehouses_live: null,
  transport_options: TRANSPORT_OPTIONS,
  document_types: DOCUMENT_TYPES,
  delivery_methods: DELIVERY_METHODS,
  match_modes: MATCH_MODES,
  phone_type_modes: PHONE_MODES,
  phone_type_sources: PHONE_SOURCES,
  all_warehouses_modes: WAREHOUSE_MODES,
  roles: ROLES,
};

// ---------- masking rahasia ----------
function maskPartnerKey(v) {
  const s = v == null ? '' : String(v);
  return s ? `shpk****${s.slice(-4)}` : '';
}
function maskToken(v) {
  const s = v == null ? '' : String(v);
  return s ? `****${s.slice(-4)}` : '';
}
function isMasked(v) { return typeof v === 'string' && v.includes('****'); }

function viewFor(user, settings) {
  const out = { ...settings };
  if (!user || user.role !== 'admin') {
    out['shopee.partner_key'] = maskPartnerKey(settings['shopee.partner_key']);
    out['shopee.bridge_token'] = maskToken(settings['shopee.bridge_token']);
  }
  return out;
}

// ---------- helper validasi ----------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function str(v, label, max = 500) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') throw badRequest(`${label} harus berupa teks`);
  if (v.length > max) throw badRequest(`${label} maksimal ${max} karakter`);
  return v.trim();
}
function bool(v, label) {
  if (typeof v !== 'boolean') throw badRequest(`${label} harus bernilai true/false`);
  return v;
}
function intMin(v, min, label, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label} harus bilangan bulat antara ${min} dan ${max === Number.MAX_SAFE_INTEGER ? '∞' : max}`);
  return n;
}
function numMin(v, min, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw badRequest(`${label} harus angka ≥ ${min}`);
  return n;
}
function oneOf(v, options, label) {
  if (!options.includes(v)) throw badRequest(`${label} harus salah satu dari: ${options.join(', ')}`);
  return v;
}
function strList(v, label, max = 200) {
  if (!Array.isArray(v)) throw badRequest(`${label} harus berupa daftar`);
  const out = [];
  for (const s of v) {
    if (s === null || s === undefined) continue;
    if (typeof s !== 'string' && typeof s !== 'number') throw badRequest(`${label} hanya boleh berisi teks`);
    const t = String(s).trim();
    if (t) out.push(t);
  }
  if (out.length > max) throw badRequest(`${label} maksimal ${max} entri`);
  return out;
}
function hhmm(v, label) {
  const m = parseHHMM(v);
  if (m === null || m >= 24 * 60) throw badRequest(`${label} harus berformat HH:MM`);
  return m;
}

function validateWarehouses(v) {
  if (!Array.isArray(v) || !v.length) throw badRequest('Daftar gudang minimal berisi satu gudang');
  const seen = new Set();
  const out = v.map((w, i) => {
    if (!isObj(w)) throw badRequest(`Gudang ke-${i + 1} tidak valid`);
    const code = String(w.code || '').trim().toLowerCase();
    if (!CODE_RE.test(code) || code === 'all') throw badRequest(`Kode gudang "${w.code}" tidak valid (huruf kecil/angka/-/_ maks 16, bukan "all")`);
    if (seen.has(code)) throw badRequest(`Kode gudang "${code}" duplikat`);
    seen.add(code);
    const idOf = (x) => (x === null || x === undefined ? '' : String(x).trim());
    return {
      code,
      name: str(w.name, `Nama gudang ${code}`, 100) || code.toUpperCase(),
      location_ids: [...new Set((Array.isArray(w.location_ids) ? w.location_ids : []).map(idOf).filter(Boolean))],
      warehouse_ids: [...new Set((Array.isArray(w.warehouse_ids) ? w.warehouse_ids : []).map(idOf).filter(Boolean))].map((x) => (/^\d+$/.test(x) ? Number(x) : x)),
      pickup_address_id: w.pickup_address_id === null || w.pickup_address_id === undefined || w.pickup_address_id === '' ? null : (/^\d+$/.test(String(w.pickup_address_id)) ? Number(w.pickup_address_id) : String(w.pickup_address_id).trim()),
      is_default: !!w.is_default,
    };
  });
  const defaults = out.filter((w) => w.is_default);
  if (defaults.length > 1) throw badRequest('Hanya boleh ada satu gudang default');
  if (!defaults.length) out[0].is_default = true;
  return out;
}

function validateParts(v, cur) {
  if (!isObj(v)) throw badRequest('Pengaturan part harus berupa objek');
  const out = {};
  for (const key of ['p1', 'p2', 'p3']) {
    const merged = { ...(cur[key] || {}), ...(isObj(v[key]) ? v[key] : {}) };
    const s = hhmm(merged.start, `Jam mulai ${key}`);
    const e = hhmm(merged.end, `Jam selesai ${key}`);
    if (s >= e) throw badRequest(`Jam mulai ${key} harus lebih awal dari jam selesai`);
    out[key] = { label: str(merged.label, `Label ${key}`, 50) || `Part ${key.slice(1)}`, start: String(merged.start).trim(), end: String(merged.end).trim() };
  }
  if (!(parseHHMM(out.p1.start) < parseHHMM(out.p2.start) && parseHHMM(out.p2.start) < parseHHMM(out.p3.start))) {
    throw badRequest('Urutan jam mulai harus p1 < p2 < p3');
  }
  return out;
}

function validateSkuRules(v, cur) {
  if (!isObj(v)) throw badRequest('sku_rules harus berupa objek');
  const m = { ...cur, ...v };
  const match_mode = oneOf(m.match_mode, MATCH_MODES, 'Mode pencocokan SKU');
  const tg_patterns = strList(m.tg_patterns, 'Pola TG');
  const hg_patterns = strList(m.hg_patterns, 'Pola HG');
  if (match_mode === 'regex') {
    for (const p of [...tg_patterns, ...hg_patterns]) {
      try { new RegExp(p, 'i'); } catch { throw badRequest(`Pola regex tidak valid: ${p}`); }
    }
  }
  const rpt = { ...(cur.require_phone_type || {}), ...(isObj(m.require_phone_type) ? m.require_phone_type : {}) };
  const require_phone_type = { mode: oneOf(rpt.mode, PHONE_MODES, 'Mode wajib tipe HP'), patterns: strList(rpt.patterns || [], 'Pola wajib tipe HP') };
  const phone_type_sources = strList(m.phone_type_sources, 'Sumber tipe HP');
  for (const s of phone_type_sources) if (!PHONE_SOURCES.includes(s)) throw badRequest(`Sumber tipe HP tidak dikenal: ${s}`);
  if (!phone_type_sources.length) throw badRequest('Sumber tipe HP minimal satu');
  return { match_mode, tg_patterns, hg_patterns, require_phone_type, phone_type_sources, generic_variation_words: strList(m.generic_variation_words, 'Kata variasi generik').map((s) => s.toLowerCase()) };
}

const VALIDATORS = {
  'shopee.partner_id': (v) => {
    if (v === null || v === undefined || v === '') return null;
    return intMin(v, 1, 'Partner ID Shopee');
  },
  'shopee.partner_key': (v) => str(v, 'Partner key Shopee', 512),
  'shopee.env': (v) => oneOf(v, ['live', 'test'], 'Lingkungan Shopee'),
  'shopee.redirect_url': (v) => str(v, 'Redirect URL', 500),
  'shopee.transport': (v) => oneOf(v, TRANSPORT_OPTIONS, 'Transport Shopee'),
  'shopee.bridge_url': (v) => str(v, 'URL bridge', 500),
  'shopee.bridge_token': (v) => str(v, 'Token bridge', 512),
  warehouses: (v) => validateWarehouses(v),
  sku_rules: (v, cur) => validateSkuRules(v, cur),
  shipping_rules: (v, cur) => {
    if (!isObj(v)) throw badRequest('shipping_rules harus berupa objek');
    const m = { ...cur, ...v };
    const kw = strList(m.instant_keywords, 'Kata kunci instant').map((s) => s.toLowerCase());
    if (!kw.length) throw badRequest('Kata kunci instant minimal satu');
    return { ...m, instant_keywords: kw };
  },
  parts: (v, cur) => validateParts(v, cur),
  cancel_rule: (v, cur) => {
    if (!isObj(v)) throw badRequest('cancel_rule harus berupa objek');
    const m = { ...cur, ...v };
    return { ...m, threshold_hours: numMin(m.threshold_hours, 0, 'Batas jam pembatalan'), time_source: oneOf(m.time_source || 'ship_by_date', ['ship_by_date'], 'Sumber waktu batas') };
  },
  process: (v, cur) => {
    if (!isObj(v)) throw badRequest('process harus berupa objek');
    const m = { ...cur, ...v };
    return {
      ...m,
      document_type: oneOf(m.document_type, DOCUMENT_TYPES, 'Jenis dokumen'),
      delivery_method: oneOf(m.delivery_method, DELIVERY_METHODS, 'Metode pengiriman'),
      all_warehouses_mode: oneOf(m.all_warehouses_mode, WAREHOUSE_MODES, 'Mode semua gudang'),
      max_orders_per_run: intMin(m.max_orders_per_run, 1, 'Maks. order per run', 5000),
      doc_wait_seconds: intMin(m.doc_wait_seconds, 5, 'Waktu tunggu dokumen (detik)', 900),
      concurrency: intMin(m.concurrency, 1, 'Paralel per order', 10),
      sender_real_name: str(m.sender_real_name, 'Nama pengirim', 100),
    };
  },
  sync: (v, cur) => {
    if (!isObj(v)) throw badRequest('sync harus berupa objek');
    const m = { ...cur, ...v };
    const statuses = strList(m.statuses, 'Status order yang ditarik').map((s) => s.toUpperCase());
    if (!statuses.length) throw badRequest('Status order yang ditarik minimal satu');
    return {
      ...m,
      enabled: bool(m.enabled, 'Sync otomatis'),
      interval_minutes: intMin(m.interval_minutes, 1, 'Interval sync (menit)', 24 * 60),
      lookback_days: intMin(m.lookback_days, 1, 'Rentang hari ke belakang', 90),
      statuses,
      include_recent_updates: bool(m.include_recent_updates, 'Tarik perubahan terbaru'),
    };
  },
  app: (v, cur) => {
    if (!isObj(v)) throw badRequest('app harus berupa objek');
    const m = { ...cur, ...v };
    const timezone = str(m.timezone, 'Zona waktu', 64) || 'Asia/Jakarta';
    try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); } catch { throw badRequest(`Zona waktu tidak dikenal: ${timezone}`); }
    return { ...m, timezone, company: str(m.company, 'Nama perusahaan', 100), marketplaces: strList(m.marketplaces, 'Marketplace').map((s) => s.toLowerCase()) };
  },
};

function validateSettingsPatch(body, current) {
  if (!isObj(body)) throw badRequest('Isi permintaan harus berupa objek { key: value }');
  const keys = Object.keys(body);
  if (!keys.length) throw badRequest('Tidak ada pengaturan yang dikirim');
  const unknown = keys.filter((k) => !(k in DEFAULTS));
  if (unknown.length) throw badRequest(`Key pengaturan tidak dikenal: ${unknown.join(', ')}`, { unknown });
  const out = {};
  const skipped = [];
  for (const k of keys) {
    const v = body[k];
    if ((k === 'shopee.partner_key' || k === 'shopee.bridge_token') && isMasked(v)) { skipped.push(k); continue; } // nilai ter-mask = tidak diubah
    const fn = VALIDATORS[k];
    out[k] = fn ? fn(v, current[k]) : v;
  }
  return { patch: out, skipped };
}

function reclassifyAllSafe(settings) {
  try {
    const preview = require('../engine/preview');
    if (typeof preview.reclassifyAll === 'function') return preview.reclassifyAll({ repo, settings, now: tnow() });
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') log.warn('engine/preview belum tersedia, klasifikasi ulang dilewati');
    else log.error('reclassifyAll gagal setelah pengaturan disimpan', e);
  }
  return null;
}

// ---------- routes: pengaturan ----------
router.get('/', (req, res) => {
  res.json({ ...viewFor(req.user, repo.getSettings()), meta: META });
});

router.put('/', requireAdmin, wrap(async (req, res) => {
  const current = repo.getSettings();
  const { patch, skipped } = validateSettingsPatch(req.body, current);
  if (Object.keys(patch).length) repo.setSettings(patch);
  const settings = repo.getSettings();
  await Promise.resolve(reclassifyAllSafe(settings)).catch((e) => log.error('reclassifyAll gagal', e));
  // Catat aktivitas tanpa nilai rahasia
  const detail = {};
  for (const k of Object.keys(patch)) detail[k] = k === 'shopee.partner_key' || k === 'shopee.bridge_token' ? '(diubah)' : patch[k];
  repo.logActivity(req.user, 'settings_update', null, { keys: Object.keys(patch), skipped, values: detail });
  res.json({ settings: viewFor(req.user, settings), skipped, meta: META });
}));

// ---------- routes: users (admin) ----------
function publicUserRow(u) { return u ? { ...u, active: !!u.active } : null; }
function parseId(v) {
  const id = parseInt(v, 10);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('ID user tidak valid');
  return id;
}
function otherActiveAdmins(exceptId) {
  return repo.listUsers().filter((u) => u.role === 'admin' && u.active && u.id !== exceptId).length;
}

router.get('/users', requireAdmin, (_req, res) => {
  res.json({ users: repo.listUsers().map(publicUserRow) });
});

router.post('/users', requireAdmin, wrap(async (req, res) => {
  const b = isObj(req.body) ? req.body : {};
  const username = String(b.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw badRequest('Username 3–32 karakter: huruf kecil, angka, titik, garis bawah, atau strip');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 6) throw badRequest('Password minimal 6 karakter');
  const role = b.role === undefined ? 'staff' : b.role;
  if (!ROLES.includes(role)) throw badRequest('Role harus admin atau staff');
  const name = str(b.name, 'Nama', 100) || username;
  if (repo.getUserByUsername(username)) throw conflict('Username sudah dipakai');
  const user = repo.createUser({ username, password, name, role });
  repo.logActivity(req.user, 'user_create', username, { role, name });
  res.status(201).json({ user: publicUserRow(user) });
}));

router.patch('/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const target = repo.getUserById(id);
  if (!target) throw notFound('User tidak ditemukan');
  const b = isObj(req.body) ? req.body : {};
  const patch = {};
  if (b.name !== undefined) { patch.name = str(b.name, 'Nama', 100); if (!patch.name) throw badRequest('Nama tidak boleh kosong'); }
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw badRequest('Role harus admin atau staff'); patch.role = b.role; }
  if (b.active !== undefined) patch.active = bool(b.active, 'Status aktif');
  if (b.password !== undefined && b.password !== null && b.password !== '') {
    if (typeof b.password !== 'string' || b.password.length < 6) throw badRequest('Password minimal 6 karakter');
    patch.password = b.password;
  }
  if (!Object.keys(patch).length) throw badRequest('Tidak ada perubahan yang dikirim');
  const isSelf = id === req.user.id;
  if (isSelf && patch.active === false) throw badRequest('Tidak dapat menonaktifkan akun sendiri');
  if (isSelf && patch.role !== undefined && patch.role !== 'admin') throw badRequest('Tidak dapat mengubah role akun sendiri');
  const losesAdmin = target.role === 'admin' && target.active && ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false);
  if (losesAdmin && otherActiveAdmins(id) === 0) throw badRequest('Harus tersisa minimal satu admin aktif');
  const user = repo.updateUser(id, patch);
  const { password, ...safePatch } = patch;
  repo.logActivity(req.user, 'user_update', target.username, { ...safePatch, password_changed: !!password });
  res.json({ user: publicUserRow(user) });
}));

router.delete('/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === req.user.id) throw badRequest('Tidak dapat menghapus akun sendiri');
  const target = repo.getUserById(id);
  if (!target) throw notFound('User tidak ditemukan');
  if (target.role === 'admin' && target.active && otherActiveAdmins(id) === 0) throw badRequest('Harus tersisa minimal satu admin aktif');
  repo.deleteUser(id);
  repo.logActivity(req.user, 'user_delete', target.username, { role: target.role });
  res.json({ ok: true });
}));

module.exports = router;
