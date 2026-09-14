'use strict';
// Nilai default semua pengaturan. Disimpan di tabel settings (key -> JSON).
// Nilai Shopee awal diambil dari env saat pertama kali jalan (lihat repo.ensureSeeded).
const config = require('./config');

const DEFAULTS = {
  'shopee.partner_id': config.SHOPEE.partner_id,
  'shopee.partner_key': config.SHOPEE.partner_key,
  'shopee.env': config.SHOPEE.env, // 'live' | 'test'
  'shopee.redirect_url': config.SHOPEE.redirect_url || `${config.APP_URL}/api/shopee/callback`,
  'shopee.transport': config.SHOPEE.transport, // 'direct' | 'bridge' | 'mock'
  'shopee.bridge_url': config.SHOPEE.bridge_url,
  'shopee.bridge_token': config.SHOPEE.bridge_token,

  warehouses: [
    { code: 'jkt', name: 'Jakarta', location_ids: [], warehouse_ids: [], pickup_address_id: null, is_default: true },
    { code: 'sby', name: 'Surabaya', location_ids: [], warehouse_ids: [], pickup_address_id: null, is_default: false },
  ],

  sku_rules: {
    // Cara mencocokkan kode: 'token' = kode harus muncul sebagai token terpisah
    // (dipisah -, _, spasi, /), 'contains' = cukup mengandung teks, 'regex' = pola regex.
    match_mode: 'token',
    tg_patterns: ['TG'],
    hg_patterns: ['HG'],
    // Produk yang wajib tipe HP: 'all' = semua produk TG/HG, 'patterns' = hanya SKU yang cocok,
    // 'none' = tidak ada validasi tipe HP.
    require_phone_type: { mode: 'all', patterns: [] },
    // Urutan sumber tipe HP yang dicek.
    phone_type_sources: ['model_name', 'note', 'message_to_seller'],
    // Kata variasi yang dianggap BUKAN tipe HP (berarti pembeli harus tulis tipe di catatan).
    generic_variation_words: ['universal', 'custom', 'tulis', 'ketik', 'isi tipe', 'pilih tipe', 'tipe hp', 'lainnya', 'other'],
  },

  shipping_rules: {
    instant_keywords: ['instant', 'same day', 'sameday', 'same-day'],
  },

  parts: {
    p1: { label: 'Part 1', start: '08:00', end: '10:00' },
    p2: { label: 'Part 2', start: '13:00', end: '14:00' },
    p3: { label: 'Part 3', start: '15:00', end: '16:00' },
  },

  cancel_rule: {
    threshold_hours: 5, // batas pembatalan < 5 jam -> tetap diproses dengan tanda TIPE BELUM DITULIS
    time_source: 'ship_by_date', // sumber waktu batas: ship_by_date dari Shopee
  },

  process: {
    document_type: 'NORMAL_AIR_WAYBILL', // atau THERMAL_AIR_WAYBILL
    delivery_method: 'auto', // 'auto' (ikuti Shopee), 'pickup', 'dropoff'
    all_warehouses_mode: 'split', // saat filter "Semua": 'split' = PDF per gudang, 'merge' = gabung jadi satu (kode all)
    max_orders_per_run: 500,
    doc_wait_seconds: 90,
    concurrency: 3,
    sender_real_name: 'Glass Pro',
  },

  sync: {
    enabled: true,
    interval_minutes: 5,
    lookback_days: 7,
    statuses: ['READY_TO_SHIP', 'PROCESSED'],
    include_recent_updates: true, // juga tarik order yang update_time berubah (untuk deteksi batal/berubah)
  },

  app: {
    timezone: config.TIMEZONE,
    company: 'Glass Pro',
    marketplaces: ['shopee'],
  },
};

module.exports = { DEFAULTS };
