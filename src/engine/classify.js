'use strict';
// Mesin klasifikasi order: jenis pengiriman, kategori SKU, gudang, tipe HP.
// Murni (tanpa akses DB) agar mudah diuji; setting diberikan lewat parameter.
const { DEFAULTS } = require('../settings-defaults');

const TOKEN_SPLIT = /[-_\s\/.]+/;

// ---------- helper setting ----------
function skuRules(settings) {
  return { ...DEFAULTS.sku_rules, ...((settings && settings.sku_rules) || {}) };
}
function shippingRules(settings) {
  return { ...DEFAULTS.shipping_rules, ...((settings && settings.shipping_rules) || {}) };
}
function warehouseList(settings) {
  const list = settings && Array.isArray(settings.warehouses) ? settings.warehouses : DEFAULTS.warehouses;
  return list.filter((w) => w && w.code);
}
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}
function asList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && String(x).trim() !== '').map((x) => String(x).trim());
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- jenis pengiriman ----------
// 'instant' jika nama kurir mengandung salah satu instant_keywords (case-insensitive), selain itu 'regular'.
function detectShipType(carrier, settings) {
  const name = str(carrier).toLowerCase();
  if (!name) return 'regular';
  const keywords = asList(shippingRules(settings).instant_keywords).map((k) => k.toLowerCase());
  return keywords.some((k) => k && name.includes(k)) ? 'instant' : 'regular';
}

// ---------- kategori SKU ----------
// Cocokkan satu string SKU dengan daftar pola sesuai mode.
function matchPatterns(sku, patterns, mode) {
  const s = str(sku).trim();
  if (!s) return false;
  const list = asList(patterns);
  if (!list.length) return false;
  if (mode === 'regex') {
    return list.some((p) => {
      try { return new RegExp(p, 'i').test(s); } catch { return false; }
    });
  }
  if (mode === 'contains') {
    const up = s.toUpperCase();
    return list.some((p) => up.includes(p.toUpperCase()));
  }
  // default: token
  const tokens = s.split(TOKEN_SPLIT).filter(Boolean).map((t) => t.toUpperCase());
  return list.some((p) => tokens.includes(p.toUpperCase()));
}

// Kategori satu string SKU: 'tg' | 'hg' | null | 'conflict'.
// Jika diberi objek item, cek model_sku dulu lalu item_sku.
function categorizeSku(sku, settings) {
  if (sku && typeof sku === 'object') return categorizeItem(sku, settings);
  const rules = skuRules(settings);
  const mode = rules.match_mode || 'token';
  const isTg = matchPatterns(sku, rules.tg_patterns, mode);
  const isHg = matchPatterns(sku, rules.hg_patterns, mode);
  if (isTg && isHg) return 'conflict';
  if (isTg) return 'tg';
  if (isHg) return 'hg';
  return null;
}

// Kategori item: model_sku dicek lebih dulu; jika tidak ada hasil, pakai item_sku.
function categorizeItem(item, settings) {
  if (!item) return null;
  const fromModel = categorizeSku(str(item.model_sku), settings);
  if (fromModel) return fromModel;
  return categorizeSku(str(item.item_sku), settings);
}

// Kategori order dari daftar kategori item: tg / hg / mix / review.
function categorizeOrderItems(categories) {
  const list = Array.isArray(categories) ? categories : [];
  if (!list.length) return 'review';
  if (list.some((c) => c !== 'tg' && c !== 'hg')) return 'review';
  const hasTg = list.includes('tg');
  const hasHg = list.includes('hg');
  if (hasTg && hasHg) return 'mix';
  return hasTg ? 'tg' : 'hg';
}

// ---------- gudang ----------
function isMapped(w) {
  return asList(w.location_ids).length > 0 || asList(w.warehouse_ids).length > 0;
}

// Detail pemetaan gudang: { code, mixed, matched:[code per lokasi cocok], unmatched:[id] }
function mapWarehouseDetail(locationIds, settings) {
  const ws = warehouseList(settings);
  const ids = asList(locationIds);
  const matched = [];
  const unmatched = [];
  for (const id of ids) {
    const w = ws.find((x) => asList(x.location_ids).includes(id) || asList(x.warehouse_ids).includes(id));
    if (w) matched.push(w.code);
    else unmatched.push(id);
  }
  const distinct = [...new Set(matched)];
  if (distinct.length) {
    return { code: matched[0], mixed: distinct.length > 1, matched, unmatched };
  }
  // Tidak ada yang cocok: pakai gudang default hanya jika cuma satu gudang yang belum dipetakan dan is_default.
  const unmappedWs = ws.filter((w) => !isMapped(w));
  if (unmappedWs.length === 1 && unmappedWs[0].is_default) {
    return { code: unmappedWs[0].code, mixed: false, matched: [], unmatched, fallback: true };
  }
  return { code: null, mixed: false, matched: [], unmatched };
}

// Kode gudang untuk daftar product_location_id: 'jkt' | 'sby' | null.
function mapWarehouse(locationIds, settings) {
  return mapWarehouseDetail(locationIds, settings).code;
}

// ---------- tipe HP ----------
function containsGeneric(text, words) {
  const low = str(text).toLowerCase();
  return asList(words).some((w) => w && low.includes(w.toLowerCase()));
}

// Ambil tipe HP dari sumber berurutan (phone_type_sources). Override tidak diproses di sini.
function extractPhoneType(order, item, settings) {
  const rules = skuRules(settings);
  const sources = asList(rules.phone_type_sources);
  const o = order || {};
  const it = item || {};
  for (const src of sources) {
    if (src === 'model_name') {
      const v = str(it.model_name).trim();
      if (v.length >= 2 && !containsGeneric(v, rules.generic_variation_words)) return { value: v, source: 'model_name' };
    } else if (src === 'note') {
      const v = str(o.note).trim();
      if (v) return { value: v, source: 'note' };
    } else if (src === 'message_to_seller') {
      const v = str(o.message_to_seller).trim();
      if (v) return { value: v, source: 'message_to_seller' };
    }
  }
  return { value: null, source: null };
}

// Apakah item wajib tipe HP sesuai sku_rules.require_phone_type.
function phoneTypeRequired(item, category, settings) {
  const rules = skuRules(settings);
  const req = rules.require_phone_type || { mode: 'all' };
  const mode = req.mode || 'all';
  if (mode === 'none') return false;
  if (mode === 'patterns') {
    const pats = req.patterns || [];
    const m = rules.match_mode || 'token';
    return matchPatterns(str(item.model_sku), pats, m) || matchPatterns(str(item.item_sku), pats, m);
  }
  return category === 'tg' || category === 'hg';
}

// ---------- klasifikasi order lengkap ----------
// order: hasil repo.getOrder (items, overrides sudah di-parse). Mengembalikan Derived tanpa validation.
function classifyOrder(order, settings) {
  const o = order || {};
  const overrides = (o.overrides && typeof o.overrides === 'object') ? o.overrides : {};
  const rawItems = Array.isArray(o.items) ? o.items : [];

  const items = rawItems.map((it) => {
    const item = it || {};
    const cat = categorizeItem(item, settings);
    const category = cat === 'tg' || cat === 'hg' ? cat : null;
    const required = phoneTypeRequired(item, category, settings);
    let phone = { value: null, source: null };
    if (str(overrides.phone_type).trim()) phone = { value: str(overrides.phone_type).trim(), source: 'override' };
    else phone = extractPhoneType(o, item, settings);
    return {
      ...item,
      qty: Number(item.qty) || 0,
      category,
      category_conflict: cat === 'conflict',
      phone_type_required: required,
      phone_type: phone.value,
      phone_type_source: phone.source,
    };
  });

  // Kategori order (item konflik dihitung sebagai 'conflict' → review)
  const cats = items.map((it) => (it.category_conflict ? 'conflict' : it.category));
  let sku_category = categorizeOrderItems(cats);
  if (['tg', 'hg', 'mix'].includes(overrides.sku_category)) sku_category = overrides.sku_category;

  // Gudang
  const locIds = items.map((it) => it.product_location_id).filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
  const wh = mapWarehouseDetail(locIds, settings);
  let warehouse_code = wh.code;
  const validCodes = warehouseList(settings).map((w) => w.code);
  if (overrides.warehouse_code && validCodes.includes(overrides.warehouse_code)) warehouse_code = overrides.warehouse_code;

  // Jenis pengiriman
  const ship_type = detectShipType(o.shipping_carrier || o.checkout_shipping_carrier, settings);

  // Tipe HP tingkat order
  const requiredItems = items.filter((it) => it.phone_type_required);
  const required = requiredItems.length > 0;
  const pool = required ? requiredItems : items;
  const found = pool.filter((it) => it.phone_type);
  const values = [...new Set(found.map((it) => it.phone_type))];
  const phone_type = {
    value: values.length ? values.join(', ') : null,
    source: found.length ? found[0].phone_type_source : null,
    required,
    missing: required && requiredItems.some((it) => !it.phone_type),
  };

  return {
    warehouse_code,
    warehouse_mixed: wh.mixed && !overrides.warehouse_code,
    ship_type,
    sku_category,
    items,
    phone_type,
  };
}

module.exports = {
  detectShipType, categorizeSku, categorizeItem, categorizeOrderItems, mapWarehouse, mapWarehouseDetail,
  extractPhoneType, phoneTypeRequired, classifyOrder, matchPatterns,
};
