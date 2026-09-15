/**
 * fmt — pemformatan angka/tanggal/label Bahasa Indonesia (zona WIB, Asia/Jakarta).
 * Semua waktu diterima sebagai unix DETIK (angka), boleh juga ms, Date, atau string ISO.
 * Nilai null/undefined selalu aman → mengembalikan '-' (atau '' untuk relative).
 *
 * Contoh:
 *   fmt.datetime(1758000000)   // '16 Sep 2026, 13:00'
 *   fmt.relative(ts)           // 'baru saja' | '5 mnt lalu' | '2 jam lalu' | 'kemarin' | '12 Sep 2026'
 *   fmt.part('p1')             // 'Part 1'
 *   fmt.category('tg')         // 'TG · Tempered Glass'   (fmt.categoryShort('tg') → 'TG')
 *   fmt.procStatus('review')   // 'Perlu diperiksa'
 *   fmt.tone('failed')         // 'danger'  (dipakai badge otomatis)
 */
export const TZ = 'Asia/Jakarta';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MONTHS_LONG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const DAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const DAYS_LONG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Ubah berbagai bentuk waktu menjadi Date; null jika tidak valid. */
export function toDate(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') {
    if (!isFinite(ts) || ts <= 0) return null;
    return new Date(ts < 1e12 ? ts * 1000 : ts);
  }
  if (typeof ts === 'string') {
    const t = ts.trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) return toDate(parseInt(t, 10));
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

let _partsFmt = null;
function partsFormatter() {
  if (!_partsFmt) {
    _partsFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
    });
  }
  return _partsFmt;
}
const WEEKDAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Komponen tanggal/jam dalam zona WIB. */
export function parts(ts) {
  const d = toDate(ts);
  if (!d) return null;
  const out = {};
  for (const p of partsFormatter().formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  return {
    year: parseInt(out.year, 10), month: parseInt(out.month, 10), day: parseInt(out.day, 10),
    hour: parseInt(out.hour, 10) % 24, minute: parseInt(out.minute, 10), second: parseInt(out.second, 10),
    weekday: WEEKDAY_IDX[out.weekday] ?? 0,
  };
}

/** 'YYYY-MM-DD' WIB — berguna untuk membandingkan hari. */
export function isoDate(ts) {
  const p = parts(ts);
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : null;
}

/**
 * Tanggal. style: 'medium' (default) '15 Sep 2026' | 'short' '15/09/2026' | 'long' '15 September 2026' | 'weekday' 'Sel, 15 Sep 2026' | 'day' '15 Sep'
 */
export function date(ts, style = 'medium') {
  const p = parts(ts);
  if (!p) return '-';
  switch (style) {
    case 'short': return `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
    case 'long': return `${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}`;
    case 'weekday': return `${DAYS_SHORT[p.weekday]}, ${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
    case 'weekday-long': return `${DAYS_LONG[p.weekday]}, ${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}`;
    case 'day': return `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
    default: return `${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
  }
}

/** Jam 'HH:mm' WIB (withSeconds → 'HH:mm:ss'). */
export function time(ts, withSeconds = false) {
  const p = parts(ts);
  if (!p) return '-';
  return `${pad2(p.hour)}:${pad2(p.minute)}${withSeconds ? ':' + pad2(p.second) : ''}`;
}

/** '15 Sep 2026, 13:05' (style tanggal mengikuti `date`). */
export function datetime(ts, style = 'medium') {
  const p = parts(ts);
  if (!p) return '-';
  return `${date(ts, style)}, ${time(ts)}`;
}

/** 'DD/MM/YYYY HH:mm' — sama dengan util/time.js backend. */
export function datetimeShort(ts) {
  const p = parts(ts);
  if (!p) return '-';
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Waktu relatif: 'baru saja', '5 mnt lalu', '2 jam lalu', 'kemarin', lalu tanggal.
 * Untuk waktu di masa depan: 'dalam 5 mnt', 'dalam 2 jam', 'besok', lalu tanggal.
 * @param {number|Date|string} ts
 * @param {number} [nowTs] unix detik "sekarang" (untuk test)
 */
export function relative(ts, nowTs) {
  const d = toDate(ts);
  if (!d) return '';
  const nowD = nowTs !== undefined && nowTs !== null ? toDate(nowTs) : null;
  const nowMs = nowD ? nowD.getTime() : Date.now();
  const diff = Math.round((nowMs - d.getTime()) / 1000); // positif = masa lalu
  const abs = Math.abs(diff);
  if (abs < 45) return 'baru saja';
  if (abs < 3600) {
    const m = Math.max(1, Math.round(abs / 60));
    return diff > 0 ? `${m} mnt lalu` : `dalam ${m} mnt`;
  }
  if (abs < 86400) {
    const h = Math.round(abs / 3600);
    return diff > 0 ? `${h} jam lalu` : `dalam ${h} jam`;
  }
  const today = isoDate(nowMs);
  const day = isoDate(d);
  const yesterday = isoDate(nowMs - 86400 * 1000);
  const tomorrow = isoDate(nowMs + 86400 * 1000);
  if (day === today) return diff > 0 ? `${Math.round(abs / 3600)} jam lalu` : `dalam ${Math.round(abs / 3600)} jam`;
  if (day === yesterday) return 'kemarin';
  if (day === tomorrow) return 'besok';
  if (abs < 7 * 86400) {
    const dd = Math.round(abs / 86400);
    return diff > 0 ? `${dd} hari lalu` : `dalam ${dd} hari`;
  }
  return date(d);
}

/** Durasi detik → '1 jam 5 mnt' / '45 dtk' / '2 hari 3 jam'. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return '-';
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s} dtk`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${d} hari ${h} jam` : `${d} hari`;
  if (h > 0) return m ? `${h} jam ${m} mnt` : `${h} jam`;
  return `${m} mnt`;
}

/** Sisa jam ke batas (deadline_hours_left) → '3,5 jam lagi' / 'Lewat batas' / '-' */
export function hoursLeft(h) {
  if (h === null || h === undefined || !isFinite(h)) return '-';
  const n = Number(h);
  if (n <= 0) return 'Lewat batas';
  if (n < 1) return `${Math.round(n * 60)} mnt lagi`;
  if (n < 48) return `${number(Math.round(n * 10) / 10, 1)} jam lagi`;
  return `${Math.round(n / 24)} hari lagi`;
}

/** Angka dengan pemisah ribuan Indonesia: 1234567 → '1.234.567'. digits = desimal maks. */
export function number(n, digits = 0) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '-';
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(n));
}

/** Mata uang: 'Rp 1.234.000'. Non-IDR memakai Intl. */
export function currency(n, cur = 'IDR') {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '-';
  const c = String(cur || 'IDR').toUpperCase();
  if (c === 'IDR') return `Rp ${number(Math.round(Number(n)))}`;
  try {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(Number(n));
  } catch {
    return `${c} ${number(Number(n), 2)}`;
  }
}

/** Persentase: pct(3, 12) → '25%'. */
export function pct(value, max = 100, digits = 0) {
  const v = Number(value), m = Number(max);
  if (!isFinite(v) || !isFinite(m) || m <= 0) return '0%';
  return `${number(Math.min(100, Math.max(0, (v / m) * 100)), digits)}%`;
}

/** Ukuran file: 1536 → '1,5 KB'. */
export function fileSize(bytes) {
  const b = Number(bytes);
  if (!isFinite(b) || b < 0) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${number(b / 1024, 1)} KB`;
  return `${number(b / (1024 * 1024), 1)} MB`;
}

/** Potong teks panjang dengan '…'. */
export function truncate(s, n = 40) {
  const str = s === null || s === undefined ? '' : String(s);
  return str.length > n ? `${str.slice(0, Math.max(0, n - 1)).trimEnd()}…` : str;
}

/** Inisial nama: 'Admin Glass Pro' → 'AG'. */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** 'Ya' / 'Tidak' */
export function bool(v) { return v ? 'Ya' : 'Tidak'; }

/** 'n' + kata: count(12, 'order') → '12 order' (angka diformat). */
export function count(n, noun) { return `${number(n)} ${noun}`; }

/** Nilai kosong → '-' */
export function dash(v) { return v === null || v === undefined || v === '' ? '-' : String(v); }

// ---------- Label domain ----------
const PART = { p1: 'Part 1', p2: 'Part 2', p3: 'Part 3', auto: 'Otomatis' };
const SHIP_TYPE = { instant: 'Instant/Same Day', regular: 'Regular' };
const SHIP_TYPE_SHORT = { instant: 'Instant', regular: 'Regular' };
const CATEGORY = { tg: 'TG · Tempered Glass', hg: 'HG · Hydrogel', mix: 'Mix · TG + HG', review: 'Perlu diperiksa' };
const CATEGORY_SHORT = { tg: 'TG', hg: 'HG', mix: 'Mix', review: 'Review' };
const WAREHOUSE = { jkt: 'Jakarta', sby: 'Surabaya', all: 'Semua gudang' };
const WAREHOUSE_SHORT = { jkt: 'JKT', sby: 'SBY', all: 'Semua' };
const PROC_STATUS = { unprocessed: 'Belum diproses', processing: 'Sedang diproses', processed: 'Sudah diproses', failed: 'Gagal', review: 'Perlu diperiksa', cancelled: 'Dibatalkan' };
const ORDER_STATUS = {
  UNPAID: 'Belum dibayar', READY_TO_SHIP: 'Siap dikirim', PROCESSED: 'Diproses', RETRY_SHIP: 'Ulangi pengiriman', SHIPPED: 'Dikirim',
  TO_CONFIRM_RECEIVE: 'Menunggu konfirmasi', IN_CANCEL: 'Proses pembatalan', CANCELLED: 'Dibatalkan', TO_RETURN: 'Pengembalian', COMPLETED: 'Selesai',
};
const RUN_STATUS = { running: 'Berjalan', done: 'Selesai', partial: 'Sebagian gagal', failed: 'Gagal', cancelled: 'Dibatalkan', pending: 'Menunggu' };
const RUN_KIND = { process: 'Proses order', regenerate: 'Buat ulang PDF' };
const PDF_STATUS = { ok: 'OK', stale: 'Perlu dibuat ulang', failed: 'Gagal' };
const PDF_KIND = { labels: 'Label', productlist: 'Product List' };
const SYNC_STATUS = { ok: 'Berhasil', failed: 'Gagal', running: 'Berjalan', never: 'Belum pernah', partial: 'Sebagian' };
const STAGE = { queued: 'Antre', shipping: 'Atur pengiriman', doc_requested: 'Minta dokumen', doc_ready: 'Dokumen siap', downloaded: 'Label diunduh', merged: 'Digabung', failed: 'Gagal', done: 'Selesai', ok: 'Selesai', skipped: 'Dilewati' };
const RUN_ORDER_STATUS = { pending: 'Menunggu', ok: 'Berhasil', failed: 'Gagal', skipped: 'Dilewati', running: 'Berjalan' };
const MARKETPLACE = { shopee: 'Shopee', tiktok: 'TikTok', tokopedia: 'Tokopedia' };
const SHOP_STATUS = { connected: 'Terhubung', disconnected: 'Terputus', expired: 'Kadaluarsa', error: 'Bermasalah' };
const HOLD = {
  PHONE_TYPE_MISSING: 'Tipe HP belum ditulis', SKU_UNKNOWN: 'SKU tidak dikenali', WAREHOUSE_UNKNOWN: 'Gudang tidak diketahui',
  ALREADY_PROCESSED: 'Sudah pernah diproses', IN_PROGRESS: 'Sedang diproses di run lain', CANCELLED: 'Order dibatalkan',
  STATUS_NOT_READY: 'Status belum siap kirim', REGULAR_WAIT_P1: 'Regular menunggu Part 1 besok', EXCLUDED: 'Dikeluarkan manual', WAREHOUSE_FILTER: 'Bukan gudang yang dipilih',
};
const WARNING = { DEADLINE_EXCEPTION: 'Dekat batas batal — diproses tanpa tipe HP', DEADLINE_NEAR: 'Dekat batas batal (< 12 jam)', NOTE_PRESENT: 'Ada catatan pembeli', COD: 'COD (bayar di tempat)' };
const ROLE = { admin: 'Admin', staff: 'Staf' };
const DELIVERY = { pickup: 'Pickup (dijemput)', dropoff: 'Drop-off (antar ke counter)', auto: 'Otomatis', non_integrated: 'Non-integrasi' };
const USER_ACTIVITY = {
  login: 'Masuk', logout: 'Keluar', change_password: 'Ganti password', sync: 'Sinkronisasi', process: 'Proses order', regenerate: 'Buat ulang PDF',
  settings_update: 'Ubah pengaturan', override: 'Koreksi manual', reset_order: 'Reset order', connect_shop: 'Hubungkan toko', disconnect_shop: 'Putuskan toko',
  create_user: 'Tambah pengguna', update_user: 'Ubah pengguna', delete_user: 'Hapus pengguna', cancel_run: 'Batalkan proses',
};

const lbl = (map, v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback !== undefined ? fallback : '-';
  const key = typeof v === 'string' ? v : String(v);
  return map[key] ?? map[key.toLowerCase()] ?? map[key.toUpperCase()] ?? (fallback !== undefined ? fallback : key);
};

export function part(p) { return lbl(PART, p); }
export function shipType(t) { return lbl(SHIP_TYPE, t); }
export function shipTypeShort(t) { return lbl(SHIP_TYPE_SHORT, t); }
export function category(c) { return lbl(CATEGORY, c); }
export function categoryShort(c) { return lbl(CATEGORY_SHORT, c); }
export function warehouse(w) { return lbl(WAREHOUSE, w, 'Tidak diketahui'); }
export function warehouseShort(w) { return lbl(WAREHOUSE_SHORT, w, '?'); }
export function procStatus(s) { return lbl(PROC_STATUS, s); }
export function orderStatus(s) { return lbl(ORDER_STATUS, s); }
export function runStatus(s) { return lbl(RUN_STATUS, s); }
export function runKind(k) { return lbl(RUN_KIND, k); }
export function pdfStatus(s) { return lbl(PDF_STATUS, s); }
export function pdfKind(k) { return lbl(PDF_KIND, k); }
export function syncStatus(s) { return lbl(SYNC_STATUS, s); }
export function stage(s) { return lbl(STAGE, s); }
export function runOrderStatus(s) { return lbl(RUN_ORDER_STATUS, s); }
export function marketplace(m) { return lbl(MARKETPLACE, m); }
export function shopStatus(s) { return lbl(SHOP_STATUS, s); }
export function role(r) { return lbl(ROLE, r); }
export function deliveryMethod(m) { return lbl(DELIVERY, m); }
export function activity(a) { return lbl(USER_ACTIVITY, a); }
/** Label kode hold (mis. 'PHONE_TYPE_MISSING' → 'Tipe HP belum ditulis'). */
export function holdCode(code) { return lbl(HOLD, code); }
/** Label kode warning (mis. 'COD'). */
export function warningCode(code) { return lbl(WARNING, code); }
/** Label untuk kode apa pun (hold atau warning). */
export function code(c) { return HOLD[c] || WARNING[c] || dash(c); }

/**
 * Tone warna untuk status apa pun (proc_status, order_status, run, pdf, sync, stage, ship_type, kategori, hold code):
 * 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'neutral'.
 */
export function tone(status) {
  if (status === null || status === undefined) return 'neutral';
  const s = String(status).toLowerCase();
  const map = {
    // proc_status
    unprocessed: 'info', processing: 'primary', processed: 'success', failed: 'danger', review: 'warning', cancelled: 'danger',
    // order_status shopee
    unpaid: 'neutral', ready_to_ship: 'info', retry_ship: 'warning', shipped: 'success', to_confirm_receive: 'success', in_cancel: 'danger', to_return: 'warning', completed: 'success',
    // run / pdf / sync / run_orders
    running: 'primary', done: 'success', partial: 'warning', ok: 'success', stale: 'warning', never: 'neutral', pending: 'neutral', skipped: 'neutral', queued: 'neutral',
    error: 'danger', warning: 'warning', success: 'success', danger: 'danger', info: 'info', primary: 'primary', neutral: 'neutral',
    // tahapan
    shipping: 'primary', doc_requested: 'primary', doc_ready: 'info', downloaded: 'info', merged: 'success',
    // ship type / kategori / gudang / marketplace
    instant: 'primary', regular: 'neutral', tg: 'info', hg: 'success', mix: 'warning', jkt: 'info', sby: 'primary', all: 'neutral', shopee: 'warning', tiktok: 'dark',
    // toko / koneksi
    connected: 'success', disconnected: 'danger', expired: 'danger', active: 'success', inactive: 'neutral', enabled: 'success', disabled: 'neutral',
    // part
    p1: 'primary', p2: 'info', p3: 'warning', auto: 'neutral', upcoming: 'neutral',
    // hold / warning codes
    phone_type_missing: 'danger', sku_unknown: 'warning', warehouse_unknown: 'warning', already_processed: 'neutral', in_progress: 'primary',
    status_not_ready: 'neutral', regular_wait_p1: 'warning', excluded: 'neutral', warehouse_filter: 'neutral',
    deadline_exception: 'danger', deadline_near: 'warning', note_present: 'info', cod: 'warning',
    // peran
    admin: 'primary', staff: 'neutral',
  };
  return map[s] || 'neutral';
}

/** Label terbaik untuk status apa pun (dicoba berurutan: proc, order, run, pdf, sync, stage, ship_type, kategori, gudang, kode hold/warning). */
export function statusLabel(s) {
  if (s === null || s === undefined || s === '') return '-';
  const k = String(s);
  return PROC_STATUS[k] ?? ORDER_STATUS[k.toUpperCase()] ?? RUN_STATUS[k] ?? PDF_STATUS[k] ?? SYNC_STATUS[k] ?? STAGE[k] ?? RUN_ORDER_STATUS[k]
    ?? SHIP_TYPE[k] ?? CATEGORY_SHORT[k] ?? WAREHOUSE[k] ?? PART[k] ?? HOLD[k.toUpperCase()] ?? WARNING[k.toUpperCase()] ?? SHOP_STATUS[k] ?? ROLE[k] ?? MARKETPLACE[k] ?? k;
}

/** Nama file PDF → potongan mudah dibaca: '15092026-p1-ins-tg-jkt.pdf' → 'Part 1 · Instant · TG · JKT'. */
export function pdfLabel(fileName) {
  const m = /^(\d{8})-(p[123])-(?:(ins|reg)-(tg|hg|mix)|(productlist))-(jkt|sby|all)\.pdf$/i.exec(String(fileName || ''));
  if (!m) return dash(fileName);
  const p = PART[m[2].toLowerCase()];
  const wh = WAREHOUSE_SHORT[m[6].toLowerCase()];
  if (m[5]) return `${p} · Product List · ${wh}`;
  return `${p} · ${m[3].toLowerCase() === 'ins' ? 'Instant' : 'Regular'} · ${CATEGORY_SHORT[m[4].toLowerCase()]} · ${wh}`;
}

export const fmt = {
  TZ, toDate, parts, isoDate, date, time, datetime, datetimeShort, relative, duration, hoursLeft, number, currency, pct, fileSize, truncate, initials, bool, count, dash,
  part, shipType, shipTypeShort, category, categoryShort, warehouse, warehouseShort, procStatus, orderStatus, runStatus, runKind, pdfStatus, pdfKind, syncStatus, stage, runOrderStatus,
  marketplace, shopStatus, role, deliveryMethod, activity, holdCode, warningCode, code, tone, statusLabel, pdfLabel,
};
export default fmt;
