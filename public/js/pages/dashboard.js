/**
 * Halaman Overview (#/) — ringkasan order Shopee hari ini.
 * Data: GET /api/dashboard (lihat docs/CONTRACTS.md §5). Auto-refresh tiap 30 detik (berhenti saat tab
 * disembunyikan dan di destroy()).
 *
 * Susunan (mengikuti referensi FINNOVA):
 *   header → [peringatan sync] → 4 KPI → Jadwal Part hari ini → (Run terakhir gelap | Komposisi + Koneksi) → Aktivitas terbaru
 */
import { api, router, el, toast, fmt, components as c, icons, reportError } from '../core.js';

const REFRESH_MS = 30000;
const PART_DESC = {
  p1: 'Order kemarin yang belum diproses + order baru',
  p2: 'Sisa Part 1 + order baru',
  p3: 'Hanya Instant / Same Day',
};
const PART_STATUS = {
  done: { text: 'Selesai', tone: 'success', icon: 'check' },
  active: { text: 'Aktif', tone: 'primary', icon: 'zap' },
  upcoming: { text: 'Akan datang', tone: 'neutral', icon: 'clock' },
  // Diturunkan di sisi klien: jendela part sudah lewat (WIB) tapi belum ada run hari ini.
  missed: { text: 'Terlewat', tone: 'warning', icon: 'alert' },
};
// Label aksi activity_log (nama aksi mengikuti yang ditulis route/engine backend).
const ACTIVITY = {
  login: { label: 'Masuk', icon: 'login' },
  logout: { label: 'Keluar', icon: 'logout' },
  change_password: { label: 'Ganti password', icon: 'key' },
  sync_manual: { label: 'Sync manual', icon: 'sync' },
  sync_auto: { label: 'Sync otomatis', icon: 'sync' },
  sync: { label: 'Sinkronisasi', icon: 'sync' },
  process_run: { label: 'Proses order', icon: 'play' },
  regenerate_run: { label: 'Buat ulang PDF', icon: 'refresh' },
  process_cancel: { label: 'Batalkan proses', icon: 'stop', tone: 'warning' },
  order_override: { label: 'Koreksi manual', icon: 'edit' },
  order_reset: { label: 'Reset order', icon: 'undo', tone: 'warning' },
  order_reclassify: { label: 'Klasifikasi ulang', icon: 'layers' },
  settings_update: { label: 'Ubah pengaturan', icon: 'cog' },
  user_create: { label: 'Tambah pengguna', icon: 'users' },
  user_update: { label: 'Ubah pengguna', icon: 'user' },
  user_delete: { label: 'Hapus pengguna', icon: 'trash', tone: 'danger' },
  shopee_auth_url: { label: 'Minta URL otorisasi', icon: 'link' },
  shopee_connect: { label: 'Hubungkan toko', icon: 'plug', tone: 'success' },
  shopee_disconnect: { label: 'Putuskan toko', icon: 'plug', tone: 'danger' },
  shopee_refresh: { label: 'Perbarui token', icon: 'refresh' },
  shopee_test: { label: 'Tes koneksi', icon: 'wifi' },
};

let timer = null;
let visibilityHandler = null;
let alive = false;
let loading = false;
let instance = 0; // naik tiap destroy(); dipakai load() untuk mengabaikan respons dari instance lama
let ctxRef = null;
let ui = null; // referensi slot DOM yang diisi ulang tiap refresh

export const title = 'Overview';

// ----------------------------------------------------------------------------
// Util kecil
// ----------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
const sum = (obj) => Object.values(obj || {}).reduce((a, b) => a + num(b), 0);
const nowSec = () => Math.floor(Date.now() / 1000);

function shopeeOf(d) { return (d && d.sync && d.sync.marketplaces && d.sync.marketplaces.shopee) || {}; }
function isSyncFailed(d) { return shopeeOf(d).status === 'failed'; }
function isConnected(d) { return !!(d && ((d.shopee && d.shopee.connected) || shopeeOf(d).connected)); }

/** Ambil `n` nilai terakhir dari deret harian untuk mini chart. */
function series(rows, key, n = 14) {
  const arr = (Array.isArray(rows) ? rows : []).map((r) => num(r && r[key]));
  return arr.slice(-n);
}

// ----------------------------------------------------------------------------
// Komponen lokal: bar komposisi bertumpuk + legenda
// ----------------------------------------------------------------------------
/**
 * compositionBar({ title, items:[{ key, label, value, tone, hint? }], total?, empty })
 * Satu baris: judul kecil + total, bar bertumpuk berwarna, legenda titik + label + angka.
 */
function compositionBar({ title, items = [], empty = 'Tidak ada order' }) {
  const total = items.reduce((a, it) => a + num(it.value), 0);
  const bar = el('div', { class: 'comp-bar', role: 'img', 'aria-label': `${title}: ${items.map((it) => `${it.label} ${fmt.number(it.value)}`).join(', ')}` });
  if (total > 0) {
    for (const it of items) {
      const v = num(it.value);
      if (v <= 0) continue;
      bar.appendChild(el('span', { class: `comp-seg tone-${it.tone || 'neutral'}`, style: { flexGrow: String(v) }, title: `${it.label}: ${fmt.number(v)} (${fmt.pct(v, total)})` }));
    }
  } else {
    bar.classList.add('is-empty');
  }
  const legend = el('div', { class: 'comp-legend' }, items.map((it) => el('span', { class: `comp-legend-item${num(it.value) === 0 ? ' is-zero' : ''}` },
    el('span', { class: `comp-dot tone-${it.tone || 'neutral'}` }), el('span', { class: 'comp-legend-label' }, it.label), el('b', { class: 'tabular' }, fmt.number(it.value)))));
  return el('div', { class: 'comp' },
    el('div', { class: 'comp-head' }, el('span', { class: 'label' }, title), el('span', { class: 'comp-total tabular' }, total > 0 ? fmt.count(total, 'order') : empty)),
    bar, legend);
}

// ----------------------------------------------------------------------------
// Bagian: header
// ----------------------------------------------------------------------------
function buildHeader() {
  const updatedEl = el('span', { class: 'page-meta-item' }, icons.clock({ size: 14 }), el('span', { class: 'dash-updated' }, 'Memuat…'));
  const syncBtn = c.button({ label: 'Sync sekarang', kind: 'secondary', icon: 'sync', onClick: () => syncNow(syncBtn) });
  const processBtn = c.button({ label: 'Mulai Process Order', kind: 'primary', icon: 'play', href: '#/process' });
  const header = c.pageHeader({
    title: 'Overview',
    subtitle: 'Ringkasan order Shopee hari ini',
    meta: [el('span', { class: 'page-meta-item' }, icons.calendar({ size: 14 }), fmt.date(nowSec(), 'weekday-long')), updatedEl],
    actions: [syncBtn, processBtn],
  });
  return { header, updatedEl: updatedEl.querySelector('.dash-updated'), syncBtn };
}

async function syncNow(btn) {
  const lay = ctxRef && ctxRef.layout;
  if (btn) btn.setLoading(true);
  try {
    if (lay && typeof lay.syncNow === 'function') await lay.syncNow();
    else {
      const r = await api.post('/api/sync/now');
      if (r && r.status === 'ok') toast.success(`Sync selesai: ${fmt.number(r.fetched || 0)} order ditarik.`);
      else if (r && r.already_running) toast.info('Sinkronisasi sedang berjalan.');
      else toast.error((r && r.error && (r.error.message || r.error)) || 'Sinkronisasi gagal.');
    }
  } catch (e) { reportError(e, 'Sinkronisasi gagal'); }
  finally { if (btn) btn.setLoading(false); }
  await load({ silent: true });
}

// ----------------------------------------------------------------------------
// Bagian: peringatan (sync gagal / belum terhubung)
// ----------------------------------------------------------------------------
function renderAlerts(d) {
  const out = [];
  const sh = shopeeOf(d);
  if (!isConnected(d)) {
    out.push(c.alert({ tone: 'warning', icon: 'plug', title: 'Toko Shopee belum terhubung',
      text: 'Hubungkan toko di Pengaturan agar order Siap Kirim bisa ditarik dan diproses.',
      actions: c.button({ label: 'Hubungkan toko', kind: 'primary', size: 'sm', icon: 'plug', href: '#/settings?tab=shopee' }) }));
  } else if (isSyncFailed(d)) {
    const okAt = sh.last_ok_at ? `sync sukses terakhir ${fmt.relative(sh.last_ok_at)} (${fmt.datetime(sh.last_ok_at)})` : 'belum pernah sync sukses';
    const retry = c.button({ label: 'Coba lagi', kind: 'danger', size: 'sm', icon: 'refresh', onClick: () => syncNow(retry) });
    out.push(c.alert({ tone: 'danger', icon: 'wifiOff', title: `API Shopee gagal · ${okAt}`,
      text: sh.last_error ? String(sh.last_error) : 'Sinkronisasi terakhir gagal. Data di bawah memakai hasil sync terakhir yang sukses.',
      actions: retry }));
  }
  return out;
}

// ----------------------------------------------------------------------------
// Bagian: KPI
// ----------------------------------------------------------------------------
function kpiCards(d) {
  const k = d.kpis || {};
  const perDay = d.orders_per_day || [];
  const today = perDay.length ? perDay[perDay.length - 1] : null;
  const held = num(k.held);
  const review = num(k.review);
  const failed = num(k.failed);
  const stale = num(k.stale_pdf);
  const p3 = (d.parts || []).find((p) => p.key === 'p3');

  const unprocessed = c.statCard({
    label: 'Belum diproses', value: num(k.unprocessed), icon: 'box', tone: 'info',
    hint: today ? `${fmt.number(today.orders)} order masuk hari ini` : 'Siap diproses di part berikutnya',
    chart: { type: 'bar', values: series(perDay, 'orders') },
    onClick: () => router.navigate('#/orders?proc_status=unprocessed'),
  });

  const attention = c.statCard({
    label: 'Perlu diperiksa + Ditahan', value: review + held, icon: 'alert', tone: 'warning',
    hint: `${fmt.number(review)} perlu diperiksa · ${fmt.number(held)} ditahan`,
    onClick: () => router.navigate('#/orders?proc_status=review'),
  });

  const processed = c.statCard({
    label: 'Diproses hari ini', value: num(k.processed_today), icon: 'checkCircle', tone: 'success',
    chart: { type: 'line', values: series(perDay, 'processed') },
    onClick: () => router.navigate('#/history'),
  });
  setStatHint(processed, failed > 0
    ? c.badge({ text: `${fmt.number(failed)} order gagal`, tone: 'danger', icon: 'xCircle', title: 'Buka Riwayat untuk memeriksa order yang gagal' })
    : el('span', { class: 'stat-hint' }, 'Tidak ada order gagal'));

  const instant = c.statCard({
    label: 'Instant menunggu', value: num(k.instant_pending), icon: 'zap', tone: 'primary',
    onClick: () => router.navigate('#/orders?ship_type=instant&proc_status=unprocessed'),
  });
  setStatHint(instant, stale > 0
    ? el('span', { class: 'row gap-2 wrap' }, c.badge({ text: `${fmt.number(stale)} PDF tidak sesuai`, tone: 'danger', icon: 'alert' }), el('span', { class: 'stat-hint' }, 'perlu dibuat ulang'))
    : el('span', { class: 'stat-hint' }, p3 && p3.end ? `Batas Part 3 pukul ${p3.end} WIB` : 'Diproses setiap part'));

  return el('div', { class: 'kpi-row' }, unprocessed, attention, processed, instant);
}
/** Ganti area hint/delta statCard dengan node kustom (mis. badge). */
function setStatHint(card, node) {
  const wrap = card.querySelector('.stat-bottom > .row');
  if (wrap) wrap.replaceChildren(node);
}

// ----------------------------------------------------------------------------
// Bagian: jadwal part
// ----------------------------------------------------------------------------
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Math.min(23, parseInt(m[1], 10)) * 60 + Math.min(59, parseInt(m[2], 10)) : null;
}
/** Menit sejak tengah malam WIB saat ini (null bila tidak bisa dihitung). */
function nowMinWib() {
  const p = fmt.parts(nowSec());
  return p ? p.hour * 60 + p.minute : null;
}
/**
 * Status tile yang ditampilkan. Backend memberi prioritas 'done' di atas 'active' dan tidak membedakan part yang
 * jendelanya sudah lewat, jadi: run sedang berjalan → 'active'; 'upcoming' tapi jam selesai sudah lewat → 'missed'.
 */
function effectivePartStatus(p, nowMin) {
  if (p.running) return 'active';
  if (p.status === 'upcoming' && nowMin !== null) {
    const end = hhmmToMin(p.end);
    if (end !== null && nowMin >= end) return 'missed';
  }
  return PART_STATUS[p.status] ? p.status : 'upcoming';
}
/** Subjudul kartu part: part yang jendelanya sedang berjalan (WIB) atau part berikutnya hari ini. */
function partsSubtitle(parts, active) {
  if (active && active.running) return `${active.label} sedang diproses · lihat progres di tile`;
  if (active) return `Sekarang: ${active.label} (${active.start}–${active.end} WIB)`;
  const nowMin = nowMinWib();
  if (nowMin === null) return 'Zona waktu WIB · proses tetap bisa dijalankan manual';
  const inWindow = parts.find((x) => { const s = hhmmToMin(x.start); const e = hhmmToMin(x.end); return s !== null && e !== null && nowMin >= s && nowMin < e; });
  if (inWindow) return `Sekarang: ${inWindow.label} (${inWindow.start}–${inWindow.end} WIB)${inWindow.status === 'done' ? ' · sudah diproses' : ''}`;
  const next = parts.filter((x) => hhmmToMin(x.start) !== null && hhmmToMin(x.start) > nowMin).sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start))[0];
  if (next) return `Berikutnya: ${next.label} pukul ${next.start} WIB · proses tetap bisa dijalankan manual`;
  return 'Semua part hari ini sudah lewat · proses tetap bisa dijalankan manual';
}
function partsCard(d) {
  const parts = (Array.isArray(d.parts) ? d.parts : []).filter((p) => p && typeof p === 'object');
  const nowMin = nowMinWib();
  const statusOf = new Map(parts.map((p) => [p, effectivePartStatus(p, nowMin)]));
  const active = parts.find((p) => statusOf.get(p) === 'active');
  const tiles = parts.map((p) => {
    const status = statusOf.get(p);
    const st = PART_STATUS[status];
    const isActive = status === 'active';
    const isDone = status === 'done';
    const isMissed = status === 'missed';
    const runId = Array.isArray(p.run_ids) && p.run_ids.length ? p.run_ids[p.run_ids.length - 1] : null;
    const runs = Array.isArray(p.run_ids) ? p.run_ids.length : 0;
    const processHref = `#/process?part=${encodeURIComponent(p.key)}`;
    let action = null;
    if (isActive) action = c.button({ label: p.running ? 'Lihat progres' : 'Proses sekarang', kind: 'glass', size: 'sm', icon: p.running ? 'loader' : 'play', href: p.running && runId ? `#/history/${runId}` : processHref });
    else if (isDone && runId) action = c.button({ label: runs > 1 ? `Lihat ${runs} run` : 'Lihat run', kind: 'soft', size: 'sm', icon: 'history', href: `#/history/${runId}` });
    else if (isMissed) action = c.button({ label: 'Proses sekarang', kind: 'soft', size: 'sm', icon: 'play', href: processHref });
    else action = c.button({ label: 'Proses lebih awal', kind: 'ghost', size: 'sm', icon: 'arrowRight', href: processHref });

    return el('div', { class: `dash-part${isActive ? ' is-active' : ''}${isDone ? ' is-done' : ''}${isMissed ? ' is-missed' : ''}`, dataset: { part: p.key, status } },
      el('div', { class: 'dash-part-top' },
        el('div', { class: 'dash-part-name' }, p.label || fmt.part(p.key)),
        isActive
          ? el('span', { class: 'badge badge-glass dash-part-badge' }, c.statusDot('success', { pulsing: !!p.running }), p.running ? 'Sedang berjalan' : st.text)
          : c.badge({ text: st.text, tone: st.tone, icon: st.icon })),
      el('div', { class: 'dash-part-time' }, p.start && p.end ? `${p.start}–${p.end}` : '-'),
      el('div', { class: 'dash-part-desc' }, PART_DESC[p.key] || ''),
      el('div', { class: 'dash-part-foot' },
        el('div', { class: 'dash-part-count' }, el('b', { class: 'tabular' }, fmt.number(num(p.processed_count))), ' order diproses'),
        action));
  });
  const nowLabel = partsSubtitle(parts, active);
  return c.card({
    title: 'Jadwal Part hari ini', subtitle: nowLabel, icon: 'clock',
    actions: c.button({ label: 'Atur jam part', kind: 'ghost', size: 'sm', icon: 'cog', href: '#/settings?tab=parts' }),
    body: tiles.length ? el('div', { class: 'dash-parts' }, tiles) : c.emptyState({ icon: 'clock', title: 'Jadwal part belum diatur', text: 'Atur jam Part 1–3 di Pengaturan.', size: 'sm' }),
  });
}

// ----------------------------------------------------------------------------
// Bagian: run terakhir (panel gelap)
// ----------------------------------------------------------------------------
function runsCard(d) {
  const runs = Array.isArray(d.recent_runs) ? d.recent_runs : [];
  const items = runs.map((r) => {
    const kind = r.kind === 'regenerate' ? 'Buat ulang' : 'Proses';
    const wh = fmt.warehouseShort(r.warehouse_filter || 'all');
    const okCount = num(r.order_ok);
    const total = num(r.order_count);
    const failed = num(r.order_failed);
    const stale = num(r.pdf_stale_count);
    const subParts = [fmt.datetime(r.started_at), r.user_name || 'sistem'];
    if (failed > 0) subParts.push(`${fmt.number(failed)} gagal`);
    if (stale > 0) subParts.push(`${fmt.number(stale)} PDF perlu dibuat ulang`);
    return {
      key: r.id,
      icon: r.kind === 'regenerate' ? 'refresh' : (r.status === 'running' ? 'loader' : 'play'),
      title: `#${r.id} · ${kind} · ${fmt.part(r.part)} · ${wh}`,
      subtitle: subParts.join(' · '),
      badge: c.badge({ status: r.status, dot: true, text: fmt.runStatus(r.status) }),
      value: `${fmt.number(okCount)}/${fmt.number(total)}`,
      valueSub: `order · ${fmt.number(num(r.pdf_count))} PDF`,
      chevron: true,
    };
  });
  const list = c.listPanel({
    items,
    onSelect: (it) => router.navigate(`#/history/${it.key}`),
    empty: c.emptyState({ icon: 'pdf', title: 'Belum ada run', text: 'Proses order pertama akan muncul di sini setelah dijalankan.', size: 'sm',
      action: c.button({ label: 'Mulai Process Order', kind: 'primary', size: 'sm', icon: 'play', href: '#/process' }) }),
  });
  return c.card({
    tone: 'dark', title: 'Run terakhir', subtitle: runs.length ? `${fmt.number(runs.length)} proses terakhir · klik untuk detail` : 'Riwayat proses & PDF', icon: 'history',
    actions: c.button({ label: 'Semua riwayat', kind: 'glass', size: 'sm', iconRight: 'arrowRight', href: '#/history' }),
    body: list,
    footer: el('div', { class: 'text-sm', style: { color: 'rgba(255,255,255,.72)' } }, icons.info({ size: 14, class: 'dash-inline-icon' }), 'PDF berhasil ≠ order sudah dikirim. Pastikan resi diserahkan ke kurir.'),
    className: 'dash-runs',
  });
}

// ----------------------------------------------------------------------------
// Bagian: komposisi order belum diproses
// ----------------------------------------------------------------------------
function compositionCard(d) {
  const cat = d.by_category || {};
  const ship = d.by_ship_type || {};
  const wh = d.by_warehouse || {};
  const total = sum(ship) || sum(cat);
  const totalOrders = d.counts && typeof d.counts.total === 'number' ? d.counts.total : null;

  let body;
  if (total === 0) {
    body = c.emptyState({
      icon: 'inbox', size: 'sm',
      title: totalOrders === 0 ? 'Belum ada order' : 'Semua order sudah diproses',
      text: totalOrders === 0 ? 'Jalankan sync untuk menarik order Siap Kirim dari Shopee.' : 'Tidak ada order yang menunggu. Order baru akan muncul setelah sync berikutnya.',
      action: totalOrders === 0 ? c.button({ label: 'Sync sekarang', kind: 'primary', size: 'sm', icon: 'sync', onClick: (e, btn) => syncNow(btn) }) : null,
    });
  } else {
    const unknown = num(wh.unknown);
    body = el('div', { class: 'stack' },
      compositionBar({ title: 'Kategori SKU', items: [
        { key: 'tg', label: 'TG', value: num(cat.tg), tone: 'info' },
        { key: 'hg', label: 'HG', value: num(cat.hg), tone: 'success' },
        { key: 'mix', label: 'Mix', value: num(cat.mix), tone: 'warning' },
        { key: 'review', label: 'Perlu diperiksa', value: num(cat.review), tone: 'danger' },
      ] }),
      compositionBar({ title: 'Jenis pengiriman', items: [
        { key: 'instant', label: 'Instant / Same Day', value: num(ship.instant), tone: 'primary' },
        { key: 'regular', label: 'Regular', value: num(ship.regular), tone: 'navy' },
      ] }),
      compositionBar({ title: 'Gudang', items: [
        { key: 'jkt', label: 'Jakarta', value: num(wh.jkt), tone: 'info' },
        { key: 'sby', label: 'Surabaya', value: num(wh.sby), tone: 'primary' },
        { key: 'unknown', label: 'Tidak diketahui', value: unknown, tone: 'warning' },
      ] }),
      unknown > 0 ? el('div', { class: 'notice-box row gap-2 wrap' }, icons.warehouse({ size: 15, class: 'dash-inline-icon' }),
        el('span', { class: 'flex-1' }, `${fmt.number(unknown)} order belum terpetakan ke gudang. `), c.link({ label: 'Atur mapping gudang', icon: 'arrowRight', href: '#/settings?tab=warehouses' })) : null);
  }
  return c.card({
    title: 'Komposisi order belum diproses', subtitle: total > 0 ? `${fmt.count(total, 'order')} menunggu diproses` : 'Termasuk order Perlu Diperiksa', icon: 'layers',
    actions: c.button({ label: 'Lihat pesanan', kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#/orders' }),
    body,
  });
}

// ----------------------------------------------------------------------------
// Bagian: status koneksi
// ----------------------------------------------------------------------------
function connectionCard(d) {
  const s = d.sync || {};
  const sh = shopeeOf(d);
  const connected = isConnected(d);
  const failed = isSyncFailed(d);
  const shopName = (d.shopee && d.shopee.shop_name) || sh.shop_name || null;

  let statusBadge;
  if (!connected) statusBadge = c.badge({ text: 'Belum terhubung', tone: 'neutral', dot: true });
  else if (s.running) statusBadge = c.badge({ text: 'Sedang sync…', tone: 'primary', dot: true });
  else if (failed) statusBadge = c.badge({ text: 'Sync gagal', tone: 'danger', dot: true });
  else if (sh.status === 'ok') statusBadge = c.badge({ text: 'Terhubung', tone: 'success', dot: true });
  else statusBadge = c.badge({ text: 'Terhubung · belum sync', tone: 'info', dot: true });

  const rows = [
    ['Marketplace', el('span', { class: 'row gap-2' }, icons.shopee({ size: 16 }), 'Shopee')],
    ['Status', statusBadge],
    ['Toko', shopName ? el('span', { class: 'fw-600 break' }, shopName) : el('span', { class: 'text-muted' }, '-')],
    ['Sync sukses terakhir', sh.last_ok_at ? el('span', null, fmt.datetime(sh.last_ok_at), ' ', el('span', { class: 'text-muted' }, `(${fmt.relative(sh.last_ok_at)})`)) : el('span', { class: 'text-muted' }, 'Belum pernah')],
    ['Sync otomatis', s.enabled
      ? el('span', null, `Tiap ${fmt.number(s.interval_minutes || 0)} menit`, s.next_at ? el('span', { class: 'text-muted' }, ` · berikutnya ${fmt.relative(s.next_at)}`) : null)
      : el('span', { class: 'text-warning fw-600' }, 'Nonaktif')],
  ];
  if (s.last && s.last.finished_at && s.last.status !== 'ok') rows.push(['Percobaan terakhir', el('span', null, fmt.datetime(s.last.finished_at), ' ', c.badge({ status: s.last.status, size: 'sm', text: fmt.syncStatus(s.last.status) }))]);

  const body = el('div', { class: 'stack' });
  if (connected && failed) {
    const okAt = sh.last_ok_at ? `sync sukses terakhir ${fmt.relative(sh.last_ok_at)}` : 'belum pernah sync sukses';
    const retry = c.button({ label: 'Coba lagi', kind: 'danger', size: 'sm', icon: 'refresh', onClick: () => syncNow(retry) });
    // Detail error lengkap sudah ditampilkan di peringatan atas halaman; di sini cukup ringkasannya.
    body.appendChild(c.alert({ tone: 'danger', icon: 'wifiOff', title: 'API Shopee gagal', text: `Sync sukses terakhir: ${okAt.replace(/^sync sukses terakhir /, '')}.`, actions: retry }));
  } else if (!connected) {
    body.appendChild(c.alert({ tone: 'warning', icon: 'plug', text: 'Toko belum dihubungkan. Hubungkan di Pengaturan untuk mulai menarik order.',
      actions: c.button({ label: 'Hubungkan', kind: 'primary', size: 'sm', href: '#/settings?tab=shopee' }) }));
  }
  body.appendChild(c.kv(rows));

  // Tombol sync sudah ada di header halaman & top bar; di kartu cukup tautan ke pengaturan.
  const actions = c.button({ label: 'Pengaturan', kind: 'ghost', size: 'sm', icon: 'cog', href: '#/settings?tab=shopee' });
  return c.card({ title: 'Koneksi Shopee', subtitle: 'Status API & sinkronisasi', icon: 'wifi', actions, body });
}

// ----------------------------------------------------------------------------
// Bagian: aktivitas terbaru
// ----------------------------------------------------------------------------
function activityDetail(a) {
  const dt = a.details && typeof a.details === 'object' ? a.details : {};
  switch (a.action) {
    case 'sync_manual': case 'sync_auto': case 'sync': {
      const bits = [];
      if (dt.fetched !== undefined) bits.push(`${fmt.number(dt.fetched)} ditarik`);
      if (dt.created !== undefined) bits.push(`${fmt.number(dt.created)} baru`);
      if (dt.updated !== undefined) bits.push(`${fmt.number(dt.updated)} diperbarui`);
      if (dt.status && dt.status !== 'ok') bits.push(fmt.syncStatus(dt.status));
      if (dt.error) bits.push(String(dt.error.message || dt.error));
      return bits.join(' · ');
    }
    case 'process_run': case 'regenerate_run': {
      const bits = [];
      if (a.target) bits.push(`Run #${a.target}`);
      if (dt.part) bits.push(fmt.part(dt.part));
      if (dt.warehouse) bits.push(fmt.warehouse(dt.warehouse));
      if (dt.ok !== undefined) bits.push(`${fmt.number(dt.ok)} ok`);
      if (dt.failed) bits.push(`${fmt.number(dt.failed)} gagal`);
      if (dt.pdfs !== undefined) bits.push(`${fmt.number(dt.pdfs)} PDF`);
      if (dt.fatal) bits.push(String(dt.fatal));
      return bits.join(' · ');
    }
    case 'process_cancel': return a.target ? `Run #${a.target}` : '';
    case 'order_override': case 'order_reset': case 'order_reclassify': return a.target ? `Order ${a.target}` : '';
    case 'shopee_connect': return dt.shop_name ? String(dt.shop_name) : (a.target ? `Shop ${a.target}` : '');
    case 'shopee_test': return dt.ok ? `Berhasil${dt.latency_ms ? ` · ${fmt.number(dt.latency_ms)} ms` : ''}` : 'Gagal';
    case 'settings_update': return Array.isArray(dt.keys) && dt.keys.length ? dt.keys.join(', ') : '';
    case 'user_create': case 'user_update': case 'user_delete': return a.target ? `@${a.target}` : '';
    default: return a.target ? String(a.target) : '';
  }
}
function activityTone(a) {
  const meta = ACTIVITY[a.action];
  const dt = a.details && typeof a.details === 'object' ? a.details : {};
  if (dt.status && dt.status !== 'ok') return dt.status === 'failed' ? 'danger' : 'warning';
  if (dt.fatal || (dt.failed && !dt.ok)) return 'danger';
  if (dt.failed) return 'warning';
  return meta && meta.tone ? meta.tone : (a.action === 'process_run' || a.action === 'regenerate_run' ? 'success' : undefined);
}
function activityLabel(action) {
  const meta = ACTIVITY[action];
  if (meta) return meta.label;
  const viaFmt = fmt.activity(action);
  if (viaFmt && viaFmt !== action) return viaFmt;
  return String(action || '-').replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());
}
function activityCard(d) {
  const acts = Array.isArray(d.recent_activity) ? d.recent_activity : [];
  const todayIso = fmt.isoDate(nowSec());
  const items = acts.map((a) => {
    const detail = activityDetail(a);
    const meta = ACTIVITY[a.action] || {};
    return {
      title: activityLabel(a.action),
      sub: [a.user_name || 'sistem', detail].filter(Boolean).join(' · '),
      icon: meta.icon || 'activity',
      tone: activityTone(a),
      time: fmt.isoDate(a.ts) === todayIso ? fmt.time(a.ts) : fmt.relative(a.ts),
    };
  });
  const body = items.length ? c.timeline(items) : c.emptyState({ icon: 'activity', title: 'Belum ada aktivitas', text: 'Login, sync, dan proses order akan tercatat di sini.', size: 'sm' });
  return c.card({
    title: 'Aktivitas terbaru', subtitle: items.length ? `${fmt.number(items.length)} kejadian terakhir` : null, icon: 'activity',
    actions: c.button({ label: 'Lihat semua', kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#/history?tab=activity' }),
    body, className: 'dash-activity',
  });
}

// ----------------------------------------------------------------------------
// Skeleton & error
// ----------------------------------------------------------------------------
function skeletonView() {
  return el('div', { class: 'stack-lg' },
    c.skeleton(4, { kind: 'kpi' }),
    el('div', { class: 'card' }, c.skeleton(3, { kind: 'lines' })),
    el('div', { class: 'dash-grid' },
      el('div', { class: 'stack-lg' }, el('div', { class: 'card card-dark' }, c.skeleton(4, { kind: 'list' })), el('div', { class: 'card' }, c.skeleton(4, { kind: 'list' }))),
      el('div', { class: 'stack-lg' }, el('div', { class: 'card' }, c.skeleton(5)), el('div', { class: 'card' }, c.skeleton(3)))));
}
function errorView(e) {
  return el('div', { class: 'card' }, c.emptyState({
    icon: 'alert', title: 'Ringkasan gagal dimuat',
    text: e && e.status === 404 ? 'Modul dashboard belum tersedia di server.' : api.errorMessage(e, 'Terjadi kesalahan saat memuat data.'),
    action: c.button({ label: 'Coba lagi', kind: 'primary', icon: 'refresh', onClick: () => load() }),
  }));
}

// ----------------------------------------------------------------------------
// Render data ke slot
// ----------------------------------------------------------------------------
function renderData(d) {
  if (!ui) return;
  ui.alerts.replaceChildren(...renderAlerts(d));
  ui.alerts.hidden = !ui.alerts.childElementCount;
  // Kiri: panel gelap run terakhir + aktivitas; kanan: komposisi + koneksi (tinggi kolom jadi seimbang).
  ui.body.replaceChildren(
    kpiCards(d),
    partsCard(d),
    el('div', { class: 'dash-grid' },
      el('div', { class: 'stack-lg' }, runsCard(d), activityCard(d)),
      el('div', { class: 'stack-lg' }, compositionCard(d), connectionCard(d))));
  ui.updatedEl.textContent = `Diperbarui ${fmt.time(d.generated_at || nowSec(), true)} · otomatis tiap 30 dtk`;
}

async function load({ silent = false } = {}) {
  if (!alive || loading) return;
  // Penanda instance: permintaan yang masih terbang saat halaman di-destroy lalu dirender ulang tidak boleh
  // menulis ke UI instance baru atau mereset flag `loading` miliknya.
  const inst = instance;
  loading = true;
  if (!silent && ui) ui.body.replaceChildren(skeletonView());
  try {
    const d = await api.get('/api/dashboard');
    if (!alive || inst !== instance) return;
    renderData(d);
  } catch (e) {
    if (!alive || inst !== instance) return;
    if (e && e.status === 401) return;
    if (silent) { console.warn('[dashboard] refresh gagal', e); if (ui) ui.updatedEl.textContent = 'Refresh gagal · data mungkin usang'; }
    else if (ui) ui.body.replaceChildren(errorView(e));
  } finally { if (inst === instance) loading = false; }
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => { if (!document.hidden) load({ silent: true }); }, REFRESH_MS);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

// ----------------------------------------------------------------------------
// Halaman
// ----------------------------------------------------------------------------
export function render(container, _params, ctx) {
  destroy();
  alive = true;
  ctxRef = ctx || null;
  const { header, updatedEl } = buildHeader();
  const alerts = el('div', { class: 'stack mb-6', hidden: true });
  const body = el('div', { class: 'stack-lg' });
  ui = { header, alerts, body, updatedEl };
  container.replaceChildren(el('div', { class: 'dash' }, header, alerts, body));
  load();
  startTimer();
  visibilityHandler = () => { if (!document.hidden) { load({ silent: true }); startTimer(); } else stopTimer(); };
  document.addEventListener('visibilitychange', visibilityHandler);
}

export function destroy() {
  alive = false;
  loading = false;
  instance++;
  stopTimer();
  if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null; }
  ui = null;
  ctxRef = null;
}

export const page = { title, render, destroy };
export default page;
