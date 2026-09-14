'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;

function open(dbPath = config.DB_PATH) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(config.PDF_DIR, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

// Migrasi ringan: tambah kolom baru jika belum ada (aman dijalankan berulang).
function migrate(d) {
  const addCol = (table, col, ddl) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  addCol('runs', 'note', 'TEXT');
  addCol('orders', 'tracking_number', 'TEXT');
  addCol('orders', 'package_number', 'TEXT');
}

function get() {
  if (!db) return open();
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { open, get, close };
