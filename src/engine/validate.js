'use strict';
// Validasi order: menghasilkan hold (menghalangi proses), warning, dan flag.
const { DEFAULTS } = require('../settings-defaults');
const time = require('../util/time');

const PROCESSABLE_STATUS = ['READY_TO_SHIP', 'PROCESSED'];
const CANCELLED_STATUS = ['CANCELLED', 'IN_CANCEL'];

const HOLD_MESSAGES = {
  PHONE_TYPE_MISSING: 'Tipe HP belum diisi (variasi/catatan pembeli kosong)',
  SKU_UNKNOWN: 'Kategori SKU tidak dikenali (bukan TG/HG atau konflik)',
  WAREHOUSE_UNKNOWN: 'Gudang tidak terpetakan dari lokasi produk',
  ALREADY_PROCESSED: 'Order sudah pernah diproses',
  IN_PROGRESS: 'Order sedang diproses di run lain',
  CANCELLED: 'Order dibatalkan / dalam proses pembatalan',
  STATUS_NOT_READY: 'Status order belum siap diproses',
  REGULAR_WAIT_P1: 'Pengiriman Regular menunggu Part 1 besok (Part 3 hanya Instant/Same Day)',
  EXCLUDED: 'Dikeluarkan manual oleh staf',
  WAREHOUSE_FILTER: 'Bukan gudang yang dipilih',
};

const WARNING_MESSAGES = {
  DEADLINE_EXCEPTION: 'Batas pembatalan sudah dekat, tetap diproses tanpa tipe HP (TIPE BELUM DITULIS)',
  DEADLINE_NEAR: 'Batas kirim kurang dari 12 jam',
  NOTE_PRESENT: 'Ada catatan / pesan dari pembeli',
  COD: 'Pembayaran COD',
  WAREHOUSE_MIXED: 'Item berasal dari gudang berbeda; dipakai gudang item pertama',
  FORCED: 'Diproses paksa oleh staf',
};

const DEADLINE_NEAR_HOURS = 12;
// Hold yang menandakan order tidak lagi ikut antrian proses (needs_review tidak berlaku).
const NOT_IN_PLAY_HOLDS = ['EXCLUDED', 'CANCELLED', 'STATUS_NOT_READY', 'ALREADY_PROCESSED'];

function round2(n) { return Math.round(n * 100) / 100; }

// Sisa jam ke batas kirim (ship_by_date - now) / 3600, null jika tidak ada.
function deadlineHoursLeft(order, now) {
  const sbd = order && Number(order.ship_by_date);
  if (!sbd) return null;
  const t = Number(now) || time.now();
  return round2((sbd - t) / 3600);
}

function hasHold(validation, code) {
  return !!(validation && Array.isArray(validation.holds) && validation.holds.some((h) => h && h.code === code));
}
function hasWarning(validation, code) {
  return !!(validation && Array.isArray(validation.warnings) && validation.warnings.some((h) => h && h.code === code));
}

// validateOrder(order, derived, settings, ctx) -> { holds, warnings, flags }
// ctx: { now, part:'p1'|'p2'|'p3'|null, activeRunOrderSns:Set }
function validateOrder(order, derived, settings, ctx) {
  const o = order || {};
  const d = derived || {};
  const s = settings || {};
  if (!ctx || typeof ctx !== 'object') ctx = {};
  const now = Number(ctx.now) || time.now();
  const overrides = (o.overrides && typeof o.overrides === 'object') ? o.overrides : {};
  const cancelRule = { ...DEFAULTS.cancel_rule, ...(s.cancel_rule || {}) };
  const threshold = Number(cancelRule.threshold_hours);
  const thresholdHours = Number.isFinite(threshold) ? threshold : DEFAULTS.cancel_rule.threshold_hours;

  const holds = [];
  const warnings = [];
  const flags = { tipe_belum_ditulis: false, deadline_hours_left: deadlineHoursLeft(o, now), needs_review: false };
  const addHold = (code, message) => holds.push({ code, message: message || HOLD_MESSAGES[code] || code });
  const addWarn = (code, message) => warnings.push({ code, message: message || WARNING_MESSAGES[code] || code });

  // --- status & duplikasi ---
  if (overrides.excluded) addHold('EXCLUDED');
  const status = String(o.order_status || '').toUpperCase();
  if (CANCELLED_STATUS.includes(status)) addHold('CANCELLED');
  else if (!PROCESSABLE_STATUS.includes(status)) addHold('STATUS_NOT_READY', `${HOLD_MESSAGES.STATUS_NOT_READY} (${status || 'tidak diketahui'})`);
  if (o.proc_status === 'processed') addHold('ALREADY_PROCESSED');
  const active = ctx.activeRunOrderSns;
  const inActiveRun = active && typeof active.has === 'function' && active.has(o.order_sn);
  if (inActiveRun || o.proc_status === 'processing') addHold('IN_PROGRESS');

  // --- klasifikasi ---
  if (d.sku_category === 'review' || !d.sku_category) addHold('SKU_UNKNOWN');
  if (!d.warehouse_code) addHold('WAREHOUSE_UNKNOWN');

  // --- tipe HP ---
  const pt = d.phone_type || {};
  const phoneMissing = !!pt.required && !!pt.missing;
  const hl = flags.deadline_hours_left;
  if (phoneMissing) {
    if (hl !== null && hl < thresholdHours) {
      flags.tipe_belum_ditulis = true;
      addWarn('DEADLINE_EXCEPTION', `Batas pembatalan < ${thresholdHours} jam, tetap diproses tanpa tipe HP (TIPE BELUM DITULIS)`);
    } else {
      addHold('PHONE_TYPE_MISSING');
    }
  }

  // --- part ---
  if (ctx.part === 'p3' && d.ship_type === 'regular') addHold('REGULAR_WAIT_P1');

  // --- force_process: hapus PHONE_TYPE_MISSING & SKU_UNKNOWN, jadikan warning FORCED ---
  if (overrides.force_process) {
    const forced = holds.filter((h) => h.code === 'PHONE_TYPE_MISSING' || h.code === 'SKU_UNKNOWN');
    if (forced.length) {
      for (const f of forced) holds.splice(holds.indexOf(f), 1);
      addWarn('FORCED', `${WARNING_MESSAGES.FORCED} (mengabaikan: ${forced.map((f) => f.code).join(', ')})`);
      if (forced.some((f) => f.code === 'PHONE_TYPE_MISSING')) flags.tipe_belum_ditulis = true;
    }
  }

  // --- warning lain ---
  if (hl !== null && hl < DEADLINE_NEAR_HOURS) addWarn('DEADLINE_NEAR', `Batas kirim tinggal ${hl < 0 ? 'lewat ' + Math.abs(hl) : hl} jam`);
  if (String(o.note || '').trim() || String(o.message_to_seller || '').trim()) addWarn('NOTE_PRESENT');
  if (o.cod) addWarn('COD');
  if (d.warehouse_mixed) addWarn('WAREHOUSE_MIXED');

  // "Perlu Diperiksa" hanya relevan untuk order yang masih hidup di antrian. Order batal / status belum siap
  // (SHIPPED, COMPLETED, UNPAID, ...) / dikeluarkan staf / sudah diproses tidak boleh berubah jadi proc_status 'review'
  // hanya karena SKU/gudang tidak dikenali (kontrak: SHIPPED yang tidak diproses lewat app cukup disembunyikan).
  const inPlay = !holds.some((h) => NOT_IN_PLAY_HOLDS.includes(h.code));
  flags.needs_review = inPlay && holds.some((h) => h.code === 'SKU_UNKNOWN' || h.code === 'WAREHOUSE_UNKNOWN');
  return { holds, warnings, flags };
}

module.exports = { validateOrder, deadlineHoursLeft, hasHold, hasWarning, HOLD_MESSAGES, WARNING_MESSAGES, PROCESSABLE_STATUS, CANCELLED_STATUS };
