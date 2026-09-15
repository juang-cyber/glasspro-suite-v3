'use strict';
// Lapisan akses data. Semua modul lain memakai fungsi di sini, bukan SQL langsung.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { get: getDb } = require('./index');
const { DEFAULTS } = require('../settings-defaults');
const config = require('../config');
const { now } = require('../util/time');

const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const P = (s, def = null) => {
  if (s === null || s === undefined || s === '') return def;
  try { return JSON.parse(s); } catch { return def; }
};

// ---------- settings ----------
function getSetting(key, def) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return def !== undefined ? def : DEFAULTS[key];
  return P(row.value, def !== undefined ? def : DEFAULTS[key]);
}

function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now());
}

function setSettings(obj) {
  const tx = getDb().transaction((o) => {
    for (const [k, v] of Object.entries(o)) setSetting(k, v);
  });
  tx(obj);
}

// Semua setting: default digabung dengan yang tersimpan (deep merge 1 level untuk objek).
function getSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const r of rows) stored[r.key] = P(r.value);
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = stored[k];
    if (v === undefined) out[k] = clone(def);
    else if (isPlainObject(def) && isPlainObject(v)) out[k] = { ...clone(def), ...v };
    else out[k] = v;
  }
  for (const [k, v] of Object.entries(stored)) if (!(k in out)) out[k] = v;
  return out;
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }

// Seed awal: admin pertama + nilai Shopee dari env (hanya jika belum ada).
function ensureSeeded() {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    createUser({ username: config.ADMIN_USER, password: config.ADMIN_PASSWORD, name: config.ADMIN_NAME, role: 'admin' });
  }
  const seedKeys = ['shopee.partner_id', 'shopee.partner_key', 'shopee.env', 'shopee.redirect_url', 'shopee.transport', 'shopee.bridge_url', 'shopee.bridge_token'];
  for (const k of seedKeys) {
    const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k);
    if (!exists && DEFAULTS[k] !== null && DEFAULTS[k] !== undefined && DEFAULTS[k] !== '') setSetting(k, DEFAULTS[k]);
  }
  // Env selalu menang untuk partner key jika diisi (supaya ganti key cukup lewat env)
  if (config.SHOPEE.partner_key) setSetting('shopee.partner_key', config.SHOPEE.partner_key);
  if (config.SHOPEE.partner_id) setSetting('shopee.partner_id', config.SHOPEE.partner_id);
  if (process.env.SHOPEE_TRANSPORT) setSetting('shopee.transport', process.env.SHOPEE_TRANSPORT);
}

// ---------- users ----------
function createUser({ username, password, name, role = 'staff' }) {
  const hash = bcrypt.hashSync(password, 10);
  const info = getDb()
    .prepare('INSERT INTO users(username, password_hash, name, role, active, created_at) VALUES(?, ?, ?, ?, 1, ?)')
    .run(username.trim().toLowerCase(), hash, name || username, role, now());
  return getUserById(info.lastInsertRowid);
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return rest;
}
function getUserById(id) { return publicUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id)); }
function getUserByUsername(username) { return getDb().prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase()); }
function verifyPassword(userRow, password) { return !!userRow && bcrypt.compareSync(password || '', userRow.password_hash); }
function listUsers() { return getDb().prepare('SELECT id, username, name, role, active, created_at, last_login_at FROM users ORDER BY id').all(); }
function updateUser(id, patch) {
  const allowed = ['name', 'role', 'active'];
  const sets = [];
  const vals = [];
  for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(k === 'active' ? (patch[k] ? 1 : 0) : patch[k]); }
  if (patch.password) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(patch.password, 10)); }
  if (!sets.length) return getUserById(id);
  vals.push(id);
  getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getUserById(id);
}
function deleteUser(id) { return getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes; }
function touchLogin(id) { getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id); }

// ---------- shops ----------
function upsertShop(s) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM shops WHERE shop_id = ?').get(s.shop_id);
  const row = { ...(existing || {}), ...s };
  db.prepare(`INSERT INTO shops(shop_id, marketplace, shop_name, region, access_token, refresh_token, access_expire_at, refresh_expire_at, authorized_at, last_refresh_at, status, last_error, raw_info)
    VALUES(@shop_id, @marketplace, @shop_name, @region, @access_token, @refresh_token, @access_expire_at, @refresh_expire_at, @authorized_at, @last_refresh_at, @status, @last_error, @raw_info)
    ON CONFLICT(shop_id) DO UPDATE SET marketplace=excluded.marketplace, shop_name=excluded.shop_name, region=excluded.region, access_token=excluded.access_token, refresh_token=excluded.refresh_token,
    access_expire_at=excluded.access_expire_at, refresh_expire_at=excluded.refresh_expire_at, authorized_at=excluded.authorized_at, last_refresh_at=excluded.last_refresh_at, status=excluded.status, last_error=excluded.last_error, raw_info=excluded.raw_info`)
    .run({
      shop_id: row.shop_id, marketplace: row.marketplace || 'shopee', shop_name: row.shop_name || null, region: row.region || null,
      access_token: row.access_token || null, refresh_token: row.refresh_token || null, access_expire_at: row.access_expire_at || null,
      refresh_expire_at: row.refresh_expire_at || null, authorized_at: row.authorized_at || null, last_refresh_at: row.last_refresh_at || null,
      status: row.status || 'connected', last_error: row.last_error || null, raw_info: typeof row.raw_info === 'string' ? row.raw_info : J(row.raw_info),
    });
  return getShop(s.shop_id);
}
function getShop(shopId) { return getDb().prepare('SELECT * FROM shops WHERE shop_id = ?').get(shopId); }
function listShops(marketplace = 'shopee') { return getDb().prepare('SELECT * FROM shops WHERE marketplace = ? ORDER BY authorized_at DESC').all(marketplace); }
function getPrimaryShop(marketplace = 'shopee') { return getDb().prepare("SELECT * FROM shops WHERE marketplace = ? AND status != 'disconnected' ORDER BY authorized_at DESC LIMIT 1").get(marketplace); }
function updateShop(shopId, patch) {
  const allowed = ['shop_name', 'region', 'access_token', 'refresh_token', 'access_expire_at', 'refresh_expire_at', 'authorized_at', 'last_refresh_at', 'status', 'last_error', 'raw_info'];
  const sets = []; const vals = [];
  for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(k === 'raw_info' && typeof patch[k] !== 'string' ? J(patch[k]) : patch[k]); }
  if (!sets.length) return getShop(shopId);
  vals.push(shopId);
  getDb().prepare(`UPDATE shops SET ${sets.join(', ')} WHERE shop_id = ?`).run(...vals);
  return getShop(shopId);
}
function deleteShop(shopId) { return getDb().prepare('DELETE FROM shops WHERE shop_id = ?').run(shopId).changes; }

// ---------- orders ----------
function contentHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

// Ubah baris DB -> objek order (JSON di-parse).
function hydrateOrder(row) {
  if (!row) return null;
  return {
    ...row,
    items: P(row.items_json, []),
    packages: P(row.packages_json, []),
    phone_type: P(row.phone_type_json, null),
    validation: P(row.validation_json, null),
    overrides: P(row.overrides_json, {}) || {},
    pdf_stale: !!row.pdf_stale,
    cod: !!row.cod,
  };
}

// Simpan/perbarui order dari hasil sync. `o` sudah dinormalisasi (lihat CONTRACTS.md, OrderRow).
// Mengembalikan { created:boolean, changed:boolean, order }.
function upsertOrder(o) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM orders WHERE order_sn = ?').get(o.order_sn);
  const t = now();
  const hash = o.content_hash || contentHash({ status: o.order_status, items: o.items, ship_by: o.ship_by_date, carrier: o.shipping_carrier, note: o.note, msg: o.message_to_seller, addr: o.recipient_address });
  if (!existing) {
    db.prepare(`INSERT INTO orders(order_sn, shop_id, marketplace, order_status, create_time, update_time, pay_time, ship_by_date, days_to_ship, shipping_carrier, checkout_shipping_carrier,
      buyer_username, recipient_name, recipient_phone, recipient_address, note, message_to_seller, cod, total_amount, currency, items_json, packages_json, raw_json, content_hash,
      tracking_number, package_number, first_seen_at, synced_at)
      VALUES(@order_sn, @shop_id, @marketplace, @order_status, @create_time, @update_time, @pay_time, @ship_by_date, @days_to_ship, @shipping_carrier, @checkout_shipping_carrier,
      @buyer_username, @recipient_name, @recipient_phone, @recipient_address, @note, @message_to_seller, @cod, @total_amount, @currency, @items_json, @packages_json, @raw_json, @content_hash,
      @tracking_number, @package_number, @first_seen_at, @synced_at)`)
      .run({
        order_sn: o.order_sn, shop_id: o.shop_id, marketplace: o.marketplace || 'shopee', order_status: o.order_status,
        create_time: o.create_time || null, update_time: o.update_time || null, pay_time: o.pay_time || null, ship_by_date: o.ship_by_date || null, days_to_ship: o.days_to_ship || null,
        shipping_carrier: o.shipping_carrier || null, checkout_shipping_carrier: o.checkout_shipping_carrier || null, buyer_username: o.buyer_username || null,
        recipient_name: o.recipient_name || null, recipient_phone: o.recipient_phone || null, recipient_address: o.recipient_address || null,
        note: o.note || null, message_to_seller: o.message_to_seller || null, cod: o.cod ? 1 : 0, total_amount: o.total_amount || null, currency: o.currency || null,
        items_json: JSON.stringify(o.items || []), packages_json: J(o.packages || []), raw_json: JSON.stringify(o.raw || {}), content_hash: hash,
        tracking_number: o.tracking_number || null, package_number: o.package_number || null, first_seen_at: t, synced_at: t,
      });
    return { created: true, changed: true, order: getOrder(o.order_sn) };
  }
  const changed = existing.content_hash !== hash;
  db.prepare(`UPDATE orders SET shop_id=@shop_id, order_status=@order_status, create_time=@create_time, update_time=@update_time, pay_time=@pay_time, ship_by_date=@ship_by_date, days_to_ship=@days_to_ship,
      shipping_carrier=@shipping_carrier, checkout_shipping_carrier=@checkout_shipping_carrier, buyer_username=@buyer_username, recipient_name=@recipient_name, recipient_phone=@recipient_phone,
      recipient_address=@recipient_address, note=@note, message_to_seller=@message_to_seller, cod=@cod, total_amount=@total_amount, currency=@currency, items_json=@items_json, packages_json=@packages_json,
      raw_json=@raw_json, content_hash=@content_hash, tracking_number=COALESCE(@tracking_number, tracking_number), package_number=COALESCE(@package_number, package_number), synced_at=@synced_at
      WHERE order_sn=@order_sn`)
    .run({
      order_sn: o.order_sn, shop_id: o.shop_id, order_status: o.order_status,
      create_time: o.create_time || existing.create_time, update_time: o.update_time || existing.update_time, pay_time: o.pay_time || existing.pay_time,
      ship_by_date: o.ship_by_date || existing.ship_by_date, days_to_ship: o.days_to_ship || existing.days_to_ship,
      shipping_carrier: o.shipping_carrier || existing.shipping_carrier, checkout_shipping_carrier: o.checkout_shipping_carrier || existing.checkout_shipping_carrier,
      buyer_username: o.buyer_username || existing.buyer_username, recipient_name: o.recipient_name || existing.recipient_name, recipient_phone: o.recipient_phone || existing.recipient_phone,
      recipient_address: o.recipient_address || existing.recipient_address, note: o.note ?? existing.note, message_to_seller: o.message_to_seller ?? existing.message_to_seller,
      cod: o.cod ? 1 : 0, total_amount: o.total_amount ?? existing.total_amount, currency: o.currency || existing.currency,
      items_json: JSON.stringify(o.items || []), packages_json: J(o.packages || []), raw_json: JSON.stringify(o.raw || {}), content_hash: hash,
      tracking_number: o.tracking_number || null, package_number: o.package_number || null, synced_at: t,
    });
  return { created: false, changed, order: getOrder(o.order_sn), previous: hydrateOrder(existing) };
}

function getOrder(orderSn) { return hydrateOrder(getDb().prepare('SELECT * FROM orders WHERE order_sn = ?').get(orderSn)); }
function getOrders(orderSns) {
  if (!orderSns || !orderSns.length) return [];
  const ph = orderSns.map(() => '?').join(',');
  return getDb().prepare(`SELECT * FROM orders WHERE order_sn IN (${ph})`).all(...orderSns).map(hydrateOrder);
}

// Simpan hasil klasifikasi+validasi (engine).
function setOrderDerived(orderSn, d) {
  getDb().prepare(`UPDATE orders SET warehouse_code = @warehouse_code, ship_type = @ship_type, sku_category = @sku_category, phone_type_json = @phone_type_json, validation_json = @validation_json, items_json = COALESCE(@items_json, items_json) WHERE order_sn = @order_sn`)
    .run({
      order_sn: orderSn, warehouse_code: d.warehouse_code || null, ship_type: d.ship_type || null, sku_category: d.sku_category || null,
      phone_type_json: J(d.phone_type), validation_json: J(d.validation), items_json: d.items ? JSON.stringify(d.items) : null,
    });
}

// Perbarui status proses. patch: {proc_status, proc_run_id, processed_at, last_error, pdf_stale, tracking_number, package_number}
function setOrderProc(orderSn, patch) {
  const allowed = ['proc_status', 'proc_run_id', 'processed_at', 'last_error', 'pdf_stale', 'tracking_number', 'package_number', 'order_status'];
  const sets = []; const vals = [];
  for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(k === 'pdf_stale' ? (patch[k] ? 1 : 0) : patch[k]); }
  if (!sets.length) return;
  vals.push(orderSn);
  getDb().prepare(`UPDATE orders SET ${sets.join(', ')} WHERE order_sn = ?`).run(...vals);
}

function setOverrides(orderSn, overrides) {
  const cur = getOrder(orderSn);
  if (!cur) return null;
  const merged = { ...(cur.overrides || {}), ...overrides };
  for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === undefined || merged[k] === '') delete merged[k];
  getDb().prepare('UPDATE orders SET overrides_json = ? WHERE order_sn = ?').run(J(merged), orderSn);
  return getOrder(orderSn);
}

// filter: {order_status, proc_status, warehouse_code, ship_type, sku_category, q, shop_id, since, until, pdf_stale, page, limit, sort}
function listOrders(filter = {}) {
  const where = []; const vals = [];
  const inList = (col, v) => {
    const arr = Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
    if (!arr.length) return;
    where.push(`${col} IN (${arr.map(() => '?').join(',')})`); vals.push(...arr);
  };
  if (filter.order_status) inList('order_status', filter.order_status);
  if (filter.proc_status) inList('proc_status', filter.proc_status);
  if (filter.warehouse_code) inList('warehouse_code', filter.warehouse_code);
  if (filter.ship_type) inList('ship_type', filter.ship_type);
  if (filter.sku_category) inList('sku_category', filter.sku_category);
  if (filter.marketplace) inList('marketplace', filter.marketplace);
  if (filter.shop_id) { where.push('shop_id = ?'); vals.push(filter.shop_id); }
  if (filter.proc_run_id) { where.push('proc_run_id = ?'); vals.push(filter.proc_run_id); }
  if (filter.since) { where.push('create_time >= ?'); vals.push(filter.since); }
  if (filter.until) { where.push('create_time <= ?'); vals.push(filter.until); }
  if (filter.pdf_stale !== undefined) { where.push('pdf_stale = ?'); vals.push(filter.pdf_stale ? 1 : 0); }
  if (filter.q) {
    const q = `%${filter.q}%`;
    where.push('(order_sn LIKE ? OR buyer_username LIKE ? OR recipient_name LIKE ? OR items_json LIKE ? OR tracking_number LIKE ?)');
    vals.push(q, q, q, q, q);
  }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortMap = { create_time: 'create_time', update_time: 'update_time', ship_by_date: 'ship_by_date', synced_at: 'synced_at', processed_at: 'processed_at' };
  const sortCol = sortMap[filter.sort] || 'create_time';
  const dir = filter.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(parseInt(filter.limit || 50, 10) || 50, 1000);
  const page = Math.max(parseInt(filter.page || 1, 10) || 1, 1);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM orders ${sql}`).get(...vals).c;
  const rows = db.prepare(`SELECT * FROM orders ${sql} ORDER BY ${sortCol} ${dir}, order_sn ASC LIMIT ? OFFSET ?`).all(...vals, limit, (page - 1) * limit);
  return { items: rows.map(hydrateOrder), total, page, limit };
}

// Semua order (tanpa paging) untuk engine; filter sama seperti listOrders (tanpa page/limit).
function allOrders(filter = {}) {
  return listOrders({ ...filter, limit: 100000, page: 1 }).items;
}

function countOrders() {
  const db = getDb();
  const byProc = {}; const byStatus = {};
  for (const r of db.prepare('SELECT proc_status s, COUNT(*) c FROM orders GROUP BY proc_status').all()) byProc[r.s] = r.c;
  for (const r of db.prepare('SELECT order_status s, COUNT(*) c FROM orders GROUP BY order_status').all()) byStatus[r.s] = r.c;
  return { byProc, byStatus, total: db.prepare('SELECT COUNT(*) c FROM orders').get().c };
}

function markOrdersPdfStale(orderSns, reason) {
  if (!orderSns.length) return 0;
  const db = getDb();
  const ph = orderSns.map(() => '?').join(',');
  const changes = db.prepare(`UPDATE orders SET pdf_stale = 1 WHERE order_sn IN (${ph}) AND proc_status = 'processed'`).run(...orderSns).changes;
  const pdfs = db.prepare("SELECT id, order_sns_json FROM pdfs WHERE status = 'ok'").all();
  const set = new Set(orderSns);
  const upd = db.prepare("UPDATE pdfs SET status = 'stale', stale_reason = ? WHERE id = ?");
  for (const p of pdfs) {
    const sns = P(p.order_sns_json, []);
    if (sns.some((s) => set.has(s))) upd.run(reason || 'Order berubah/batal setelah PDF dibuat', p.id);
  }
  return changes;
}

// ---------- runs ----------
function createRun({ part, warehouse_filter, marketplace = 'shopee', kind = 'process', user, note, source_run_id }) {
  const info = getDb()
    .prepare('INSERT INTO runs(part, warehouse_filter, marketplace, kind, user_id, user_name, started_at, status, note, source_run_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(part, warehouse_filter, marketplace, kind, user ? user.id : null, user ? user.name || user.username : null, now(), 'running', note || null, source_run_id || null);
  return getRun(info.lastInsertRowid);
}
function hydrateRun(r) { return r ? { ...r, summary: P(r.summary_json, null) } : null; }
function getRun(id) { return hydrateRun(getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id)); }
function updateRun(id, patch) {
  const allowed = ['finished_at', 'status', 'summary_json', 'error', 'note'];
  const p = { ...patch };
  if (p.summary !== undefined) { p.summary_json = J(p.summary); delete p.summary; }
  const sets = []; const vals = [];
  for (const k of allowed) if (p[k] !== undefined) { sets.push(`${k} = ?`); vals.push(p[k]); }
  if (!sets.length) return getRun(id);
  vals.push(id);
  getDb().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getRun(id);
}
function listRuns({ page = 1, limit = 20, kind, status, part, warehouse } = {}) {
  const where = []; const vals = [];
  if (kind) { where.push('kind = ?'); vals.push(kind); }
  if (status) { where.push('status = ?'); vals.push(status); }
  if (part) { where.push('part = ?'); vals.push(part); }
  if (warehouse) { where.push('warehouse_filter = ?'); vals.push(warehouse); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM runs ${sql}`).get(...vals).c;
  const lim = Math.min(parseInt(limit, 10) || 20, 500); const pg = Math.max(parseInt(page, 10) || 1, 1);
  const rows = db.prepare(`SELECT * FROM runs ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...vals, lim, (pg - 1) * lim).map(hydrateRun);
  const pdfCount = db.prepare('SELECT run_id, COUNT(*) c, SUM(CASE WHEN status = \'stale\' THEN 1 ELSE 0 END) stale FROM pdfs GROUP BY run_id').all();
  const pc = {}; for (const r of pdfCount) pc[r.run_id] = r;
  const oc = {}; for (const r of db.prepare('SELECT run_id, COUNT(*) c, SUM(CASE WHEN status = \'ok\' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status = \'failed\' THEN 1 ELSE 0 END) failed FROM run_orders GROUP BY run_id').all()) oc[r.run_id] = r;
  for (const r of rows) {
    r.pdf_count = pc[r.id] ? pc[r.id].c : 0; r.pdf_stale_count = pc[r.id] ? pc[r.id].stale || 0 : 0;
    r.order_count = oc[r.id] ? oc[r.id].c : 0; r.order_ok = oc[r.id] ? oc[r.id].ok || 0 : 0; r.order_failed = oc[r.id] ? oc[r.id].failed || 0 : 0;
  }
  return { items: rows, total, page: pg, limit: lim };
}
function upsertRunOrder(runId, orderSn, patch = {}) {
  const db = getDb();
  const ex = db.prepare('SELECT * FROM run_orders WHERE run_id = ? AND order_sn = ?').get(runId, orderSn);
  const row = { ship_type: null, sku_category: null, warehouse_code: null, stage: 'queued', status: 'pending', error: null, flags_json: null, ...(ex || {}), ...patch, updated_at: now() };
  if (patch.flags !== undefined) row.flags_json = J(patch.flags);
  db.prepare(`INSERT INTO run_orders(run_id, order_sn, ship_type, sku_category, warehouse_code, stage, status, error, flags_json, updated_at)
    VALUES(@run_id, @order_sn, @ship_type, @sku_category, @warehouse_code, @stage, @status, @error, @flags_json, @updated_at)
    ON CONFLICT(run_id, order_sn) DO UPDATE SET ship_type=excluded.ship_type, sku_category=excluded.sku_category, warehouse_code=excluded.warehouse_code, stage=excluded.stage, status=excluded.status, error=excluded.error, flags_json=excluded.flags_json, updated_at=excluded.updated_at`)
    .run({ run_id: runId, order_sn: orderSn, ship_type: row.ship_type, sku_category: row.sku_category, warehouse_code: row.warehouse_code, stage: row.stage, status: row.status, error: row.error, flags_json: row.flags_json, updated_at: row.updated_at });
}
function listRunOrders(runId) {
  return getDb().prepare('SELECT * FROM run_orders WHERE run_id = ? ORDER BY order_sn').all(runId).map((r) => ({ ...r, flags: P(r.flags_json, {}) || {} }));
}

// ---------- pdfs ----------
function createPdf(p) {
  const info = getDb()
    .prepare(`INSERT INTO pdfs(run_id, kind, file_name, file_path, part, ship_type, sku_category, warehouse_code, order_sns_json, order_count, page_count, status, stale_reason, size_bytes, created_at)
      VALUES(@run_id, @kind, @file_name, @file_path, @part, @ship_type, @sku_category, @warehouse_code, @order_sns_json, @order_count, @page_count, @status, @stale_reason, @size_bytes, @created_at)`)
    .run({
      run_id: p.run_id, kind: p.kind, file_name: p.file_name, file_path: p.file_path, part: p.part, ship_type: p.ship_type || null, sku_category: p.sku_category || null,
      warehouse_code: p.warehouse_code, order_sns_json: JSON.stringify(p.order_sns || []), order_count: (p.order_sns || []).length, page_count: p.page_count || null,
      status: p.status || 'ok', stale_reason: p.stale_reason || null, size_bytes: p.size_bytes || null, created_at: now(),
    });
  return getPdf(info.lastInsertRowid);
}
function hydratePdf(r) { return r ? { ...r, order_sns: P(r.order_sns_json, []) } : null; }
function getPdf(id) { return hydratePdf(getDb().prepare('SELECT * FROM pdfs WHERE id = ?').get(id)); }
function listPdfs(runId) { return getDb().prepare('SELECT * FROM pdfs WHERE run_id = ? ORDER BY id').all(runId).map(hydratePdf); }
function listRecentPdfs(limit = 50) { return getDb().prepare('SELECT * FROM pdfs ORDER BY id DESC LIMIT ?').all(limit).map(hydratePdf); }
function setPdfStatus(id, status, reason) { getDb().prepare('UPDATE pdfs SET status = ?, stale_reason = ? WHERE id = ?').run(status, reason || null, id); }
function deletePdfsOfRun(runId) { return getDb().prepare('DELETE FROM pdfs WHERE run_id = ?').run(runId).changes; }

// ---------- sync log ----------
function startSyncLog({ marketplace = 'shopee', trigger = 'auto', user } = {}) {
  const info = getDb().prepare('INSERT INTO sync_log(marketplace, trigger, user_id, started_at, status) VALUES(?, ?, ?, ?, ?)').run(marketplace, trigger, user ? user.id : null, now(), 'running');
  return info.lastInsertRowid;
}
function finishSyncLog(id, { status, fetched = 0, created = 0, updated = 0, error, details }) {
  getDb().prepare('UPDATE sync_log SET finished_at = ?, status = ?, fetched = ?, created = ?, updated = ?, error = ?, details_json = ? WHERE id = ?')
    .run(now(), status, fetched, created, updated, error || null, J(details), id);
}
function lastSync(marketplace = 'shopee') {
  const db = getDb();
  const last = db.prepare('SELECT * FROM sync_log WHERE marketplace = ? ORDER BY id DESC LIMIT 1').get(marketplace);
  const lastOk = db.prepare("SELECT * FROM sync_log WHERE marketplace = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(marketplace);
  return { last: last ? { ...last, details: P(last.details_json) } : null, last_ok: lastOk ? { ...lastOk, details: P(lastOk.details_json) } : null };
}
function listSyncLogs(limit = 50) { return getDb().prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r, details: P(r.details_json) })); }

// ---------- activity ----------
function logActivity(user, action, target, details) {
  getDb().prepare('INSERT INTO activity_log(ts, user_id, user_name, action, target, details_json) VALUES(?, ?, ?, ?, ?, ?)')
    .run(now(), user ? user.id : null, user ? user.name || user.username : 'system', action, target || null, J(details));
}
function listActivity(limit = 100) { return getDb().prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r, details: P(r.details_json) })); }

// ---------- statistik dashboard ----------
function ordersPerDay(days = 14, tz = 'Asia/Jakarta') {
  const { isoDate, now: tnow } = require('../util/time');
  const since = tnow() - days * 86400;
  const rows = getDb().prepare('SELECT create_time, proc_status FROM orders WHERE create_time >= ?').all(since);
  const map = {};
  for (const r of rows) {
    const d = isoDate(r.create_time, tz);
    map[d] = map[d] || { date: d, orders: 0, processed: 0 };
    map[d].orders++;
    if (r.proc_status === 'processed') map[d].processed++;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

function transaction(fn) { return getDb().transaction(fn); }

module.exports = {
  getSetting, setSetting, setSettings, getSettings, ensureSeeded,
  createUser, getUserById, getUserByUsername, verifyPassword, listUsers, updateUser, deleteUser, touchLogin, publicUser,
  upsertShop, getShop, listShops, getPrimaryShop, updateShop, deleteShop,
  contentHash, hydrateOrder, upsertOrder, getOrder, getOrders, setOrderDerived, setOrderProc, setOverrides, listOrders, allOrders, countOrders, markOrdersPdfStale,
  createRun, getRun, updateRun, listRuns, upsertRunOrder, listRunOrders,
  createPdf, getPdf, listPdfs, listRecentPdfs, setPdfStatus, deletePdfsOfRun,
  startSyncLog, finishSyncLog, lastSync, listSyncLogs,
  logActivity, listActivity, ordersPerDay, transaction,
};

// ============================================================================
// [ditambah oleh AGENT SYNC] fungsi kecil pendukung dashboard, detail order, dan scheduler sync.
// ============================================================================

// Jumlah order berstatus processed dengan processed_at >= ts (mis. "diproses hari ini").
function countProcessedSince(ts) {
  return getDb().prepare("SELECT COUNT(*) c FROM orders WHERE proc_status = 'processed' AND processed_at IS NOT NULL AND processed_at >= ?").get(ts || 0).c;
}

// Riwayat keikutsertaan satu order di semua run (terbaru dulu), digabung info run-nya.
function listRunOrdersByOrder(orderSn) {
  return getDb()
    .prepare(`SELECT ro.*, r.part AS run_part, r.kind AS run_kind, r.status AS run_status, r.warehouse_filter AS run_warehouse_filter,
      r.started_at AS run_started_at, r.finished_at AS run_finished_at, r.user_name AS run_user_name
      FROM run_orders ro LEFT JOIN runs r ON r.id = ro.run_id WHERE ro.order_sn = ? ORDER BY ro.run_id DESC`)
    .all(orderSn)
    .map((r) => ({ ...r, flags: P(r.flags_json, {}) || {} }));
}

// Semua PDF yang memuat order tertentu (terbaru dulu).
function listPdfsForOrder(orderSn) {
  const like = `%${JSON.stringify(String(orderSn))}%`;
  return getDb().prepare('SELECT * FROM pdfs WHERE order_sns_json LIKE ? ORDER BY id DESC').all(like)
    .map(hydratePdf)
    .filter((p) => Array.isArray(p.order_sns) && p.order_sns.includes(orderSn));
}

// Tandai sync_log yang masih 'running' (sisa proses yang mati mendadak) sebagai gagal. Mengembalikan jumlah baris.
function markRunningSyncLogsFailed(reason) {
  return getDb().prepare("UPDATE sync_log SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'")
    .run(now(), reason || 'Sinkronisasi terputus (server dimulai ulang)').changes;
}

Object.assign(module.exports, { countProcessedSince, listRunOrdersByOrder, listPdfsForOrder, markRunningSyncLogsFailed });
