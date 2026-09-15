'use strict';
// Penamaan file PDF dan kunci/label grup.
const time = require('../util/time');

const SHIP_CODE = { instant: 'ins', regular: 'reg' };
const SHIP_LABEL = { instant: 'Instant/Same Day', regular: 'Regular' };
const CATEGORY_LABEL = { tg: 'TG', hg: 'HG', mix: 'Mix', review: 'Perlu Diperiksa' };

const CATEGORY_CODES = ['tg', 'hg', 'mix'];

// Kontrak: jenis pengiriman hanya instant|regular, kategori PDF hanya tg|hg|mix. Nilai lain (null, 'review'
// dari order yang diproses paksa, huruf besar) dinormalkan supaya nama file & kunci grup selalu sesuai kontrak.
function shipType(v) { return String(v || '').trim().toLowerCase() === 'instant' ? 'instant' : 'regular'; }
function shipCode(v) { return SHIP_CODE[shipType(v)]; }
function catCode(v) { const c = String(v || '').trim().toLowerCase(); return CATEGORY_CODES.includes(c) ? c : 'mix'; }
function whCode(code) { const c = String(code || '').trim().toLowerCase(); return c || 'all'; }

// 'DDMMYYYY-p1-ins-tg-jkt.pdf' atau 'DDMMYYYY-p1-productlist-jkt.pdf'
function pdfFileName({ ts, part, ship_type, sku_category, warehouse_code, kind = 'labels' } = {}) {
  const date = time.ddmmyyyy(Number(ts) || time.now());
  const p = String(part || 'p1').trim().toLowerCase();
  const wh = whCode(warehouse_code);
  if (kind === 'productlist') return `${date}-${p}-productlist-${wh}.pdf`;
  return `${date}-${p}-${shipCode(ship_type)}-${catCode(sku_category)}-${wh}.pdf`;
}

// 'instant-tg-jkt' (normalisasi sama dengan pdfFileName agar satu grup selalu memetakan ke satu nama file)
function groupKey({ ship_type, sku_category, warehouse_code } = {}) {
  return `${shipType(ship_type)}-${catCode(sku_category)}-${whCode(warehouse_code)}`;
}

function shipTypeLabel(shipType) { return SHIP_LABEL[shipType] || String(shipType || '-'); }
function categoryLabel(cat) { return CATEGORY_LABEL[cat] || String(cat || '-').toUpperCase(); }
function warehouseLabel(code, settings) {
  if (!code || code === 'all') return 'Semua Gudang';
  const ws = (settings && Array.isArray(settings.warehouses)) ? settings.warehouses : [];
  const w = ws.find((x) => x && x.code === code);
  return w && w.name ? w.name : String(code).toUpperCase();
}

// 'Instant/Same Day · TG · Jakarta'
function groupLabel({ ship_type, sku_category, warehouse_code } = {}, settings) {
  return `${shipTypeLabel(ship_type)} · ${categoryLabel(sku_category)} · ${warehouseLabel(warehouse_code, settings)}`;
}

module.exports = { pdfFileName, groupKey, groupLabel, shipTypeLabel, categoryLabel, warehouseLabel, shipCode, catCode, CATEGORY_CODES };
