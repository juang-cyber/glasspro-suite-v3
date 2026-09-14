PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shops (
  shop_id INTEGER PRIMARY KEY,
  marketplace TEXT NOT NULL DEFAULT 'shopee',
  shop_name TEXT,
  region TEXT,
  access_token TEXT,
  refresh_token TEXT,
  access_expire_at INTEGER,
  refresh_expire_at INTEGER,
  authorized_at INTEGER,
  last_refresh_at INTEGER,
  status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  raw_info TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  order_sn TEXT PRIMARY KEY,
  shop_id INTEGER NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'shopee',
  order_status TEXT NOT NULL,
  create_time INTEGER,
  update_time INTEGER,
  pay_time INTEGER,
  ship_by_date INTEGER,
  days_to_ship INTEGER,
  shipping_carrier TEXT,
  checkout_shipping_carrier TEXT,
  buyer_username TEXT,
  recipient_name TEXT,
  recipient_phone TEXT,
  recipient_address TEXT,
  note TEXT,
  message_to_seller TEXT,
  cod INTEGER,
  total_amount REAL,
  currency TEXT,
  items_json TEXT NOT NULL,
  packages_json TEXT,
  raw_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  warehouse_code TEXT,
  ship_type TEXT,
  sku_category TEXT,
  phone_type_json TEXT,
  validation_json TEXT,
  proc_status TEXT NOT NULL DEFAULT 'unprocessed',
  proc_run_id INTEGER,
  processed_at INTEGER,
  last_error TEXT,
  overrides_json TEXT,
  pdf_stale INTEGER NOT NULL DEFAULT 0,
  tracking_number TEXT,
  package_number TEXT,
  first_seen_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status, proc_status);
CREATE INDEX IF NOT EXISTS idx_orders_create ON orders(create_time);
CREATE INDEX IF NOT EXISTS idx_orders_run ON orders(proc_run_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part TEXT NOT NULL,
  warehouse_filter TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'shopee',
  kind TEXT NOT NULL DEFAULT 'process',
  user_id INTEGER,
  user_name TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  summary_json TEXT,
  error TEXT,
  note TEXT,
  source_run_id INTEGER
);

CREATE TABLE IF NOT EXISTS run_orders (
  run_id INTEGER NOT NULL,
  order_sn TEXT NOT NULL,
  ship_type TEXT,
  sku_category TEXT,
  warehouse_code TEXT,
  stage TEXT NOT NULL DEFAULT 'queued',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  flags_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, order_sn)
);

CREATE TABLE IF NOT EXISTS pdfs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  part TEXT NOT NULL,
  ship_type TEXT,
  sku_category TEXT,
  warehouse_code TEXT NOT NULL,
  order_sns_json TEXT NOT NULL,
  order_count INTEGER NOT NULL,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  stale_reason TEXT,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdfs_run ON pdfs(run_id);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL DEFAULT 'shopee',
  trigger TEXT NOT NULL,
  user_id INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  fetched INTEGER DEFAULT 0,
  created INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  error TEXT,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details_json TEXT
);
