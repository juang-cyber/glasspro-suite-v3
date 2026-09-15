'use strict';
// Penamaan file PDF dan kunci/label grup.
const time = require('../util/time');

const SHIP_CODE = { instant: 'ins', regular: 'reg' };
const SHIP_LABEL = { instant: 'Instant/Same Day', regular: 'Regular' };
const CATEGORY_LABEL = { tg: 'TG', hg: 'HG', mix: 'Mix', review: 'Perlu Diperiksa' };

function shipCode(shipType) { return SHIP_CODE[shipType] || String(shipType || 'reg').toLowerCase(); }
function whCode(code) { return code ? String(code).toLowerCase() : 'all'; }

// 'DDMMYYYY-p1-ins-tg-jkt.pdf' atau 'DDMMYYYY-p1-productlist-jkt.pdf'
function pdfFileName({ ts, part, ship_type, sku_category, warehouse_code, kind = 'labels' } = {}) {
  const date = time.ddmmyyyy(Number(ts) || time.now());
  const p = String(part || 'p1').toLowerCase();
  const wh = whCode(warehouse_code);
  if (kind === 'productlist') return `${date}-${p}-productlist-${wh}.pdf`;
  const cat = String(sku_category || 'mix').toLowerCase();
  return `${date}-${p}-${shipCode(ship_type)}-${cat}-${wh}.pdf`;
}

// 'instant-tg-jkt'
function groupKey({ ship_type, sku_category, warehouse_code } = {}) {
  return `${ship_type || 'regular'}-${sku_category || 'mix'}-${whCode(warehouse_code)}`;
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

module.exports = { pdfFileName, groupKey, groupLabel, shipTypeLabel, categoryLabel, warehouseLabel, shipCode };
