/**
 * Halaman Riwayat (#/history dan #/history/:runId).
 *
 *   #/history?tab=runs|sync|activity&kind=&status=&page=
 *     - Run proses : daftar run (panel gelap), filter jenis/status, paginasi → klik ke detail.
 *     - Log sync   : tabel sync_log (waktu, pemicu, status, ditarik/baru/diperbarui, durasi, keterangan).
 *     - Aktivitas  : tabel activity_log (waktu, pengguna, aksi, target, detail ringkas).
 *   #/history/:runId
 *     - Panel gradien: part, gudang, status, mulai/selesai/durasi, user, jenis, run sumber, catatan + tile KPI.
 *     - Progress bar (polling) bila run masih berjalan; tombol batalkan.
 *     - Kartu PDF: unduh/lihat, pilih → "Buat ulang PDF terpilih"; peringatan PDF tidak sesuai.
 *     - Kartu order dalam run: tautan ke #/orders/:sn, kategori, jenis, gudang, tahap, status, error, flag TIPE BELUM DITULIS.
 *     - Tombol "Buat ulang yang gagal" bila ada order gagal.
 *
 * API: GET /api/history/runs, /api/history/runs/:id, /api/history/sync-logs, /api/history/activity,
 *      GET /api/history/pdfs/:id/{download,view}, GET /api/process/runs/:id/progress,
 *      POST /api/process/runs/:id/regenerate {only_failed|pdf_ids}, POST /api/process/runs/:id/cancel.
 *
 * Semua data order (nama, catatan, error) dirender lewat el() → selalu text node, tidak pernah innerHTML.
 */
import { api, router, el, toast, modal, fmt, components as c, icons, reportError } from '../core.js';

const TAB_ITEMS = [
  { key: 'runs', label: 'Run proses', icon: 'process' },
  { key: 'sync', label: 'Log sync', icon: 'sync' },
  { key: 'activity', label: 'Aktivitas', icon: 'activity' },
];
const TAB_KEYS = TAB_ITEMS.map((t) => t.key);
const KIND_OPTIONS = [{ value: '', label: 'Semua jenis' }, { value: 'process', label: 'Proses order' }, { value: 'regenerate', label: 'Buat ulang PDF' }];
const STATUS_OPTIONS = [{ value: '', label: 'Semua status' }, { value: 'running', label: 'Berjalan' }, { value: 'done', label: 'Selesai' }, { value: 'partial', label: 'Sebagian gagal' }, { value: 'failed', label: 'Gagal' }];
const RUN_KINDS = KIND_OPTIONS.map((o) => o.value).filter(Boolean);
const RUN_STATUSES = STATUS_OPTIONS.map((o) => o.value).filter(Boolean);
const PAGE_LIMIT = 20;
const POLL_MS = 1500;          // polling progress run yang masih berjalan
const LIST_REFRESH_MS = 4000;  // muat ulang daftar bila ada run berjalan
const LOG_LIMIT = 100;

const PDF_STATUS = {
  ok: { text: 'OK', tone: 'success' },
  stale: { text: 'Tidak sesuai', tone: 'warning' },
  failed: { text: 'Gagal', tone: 'danger' },
  superseded: { text: 'Digantikan', tone: 'neutral' },
};
const RUN_STAGE = { shipping: 'Mengatur pengiriman di Shopee', documents: 'Mengambil dokumen label', pdf: 'Menyusun PDF', done: 'Selesai' };

// Nama aksi yang benar-benar dicatat backend (repo.logActivity) → label Indonesia.
const ACTION_LABELS = {
  login: 'Masuk', logout: 'Keluar', change_password: 'Ganti password',
  sync_manual: 'Sync manual', sync_auto: 'Sync otomatis',
  process_run: 'Proses order', regenerate_run: 'Buat ulang PDF', process_cancel: 'Batalkan run',
  order_override: 'Koreksi manual order', order_reset: 'Reset order', order_reclassify: 'Klasifikasi ulang order',
  settings_update: 'Ubah pengaturan',
  user_create: 'Tambah pengguna', user_update: 'Ubah pengguna', user_delete: 'Hapus pengguna',
  shopee_auth_url: 'Minta URL otorisasi Shopee', shopee_connect: 'Hubungkan toko Shopee', shopee_refresh: 'Perbarui token Shopee',
  shopee_disconnect: 'Putuskan toko Shopee', shopee_test: 'Tes koneksi Shopee',
};
const ACTION_ICONS = {
  login: 'login', logout: 'logout', change_password: 'key', sync_manual: 'sync', sync_auto: 'sync',
  process_run: 'play', regenerate_run: 'refresh', process_cancel: 'stop',
  order_override: 'edit', order_reset: 'undo', order_reclassify: 'layers', settings_update: 'cog',
  user_create: 'users', user_update: 'users', user_delete: 'users',
  shopee_auth_url: 'shopee', shopee_connect: 'shopee', shopee_refresh: 'shopee', shopee_disconnect: 'shopee', shopee_test: 'shopee',
};
const OVERRIDE_LABELS = { sku_category: 'kategori SKU', warehouse_code: 'gudang', excluded: 'dikeluarkan', note: 'catatan', force_process: 'paksa proses', phone_type: 'tipe HP' };

// ----------------------------------------------------------------------------
// State modul: penanda render aktif + satu timer (polling / auto-refresh)
// ----------------------------------------------------------------------------
let seq = 0;
let timer = null;
// Token per permintaan muat: hasil permintaan lama (ganti tab/filter saat masih berjalan) diabaikan supaya
// tidak menimpa data terbaru maupun merebut timer auto-refresh/polling.
let loadSeq = 0;
function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
function later(fn, ms) { stopTimer(); timer = setTimeout(fn, ms); }

export const title = (route) => (route && route.params && route.params.runId ? `Run #${route.params.runId}` : 'Riwayat');

export async function render(container, params = {}, ctx = {}) {
  destroy();
  const mySeq = ++seq;
  const runId = params.runId || params.id;
  if (runId) return renderDetail(container, runId, mySeq);
  return renderList(container, ctx.query || router.query() || {}, mySeq, ctx);
}

export function destroy() { stopTimer(); seq++; }

// ============================================================================
// Helper umum
// ============================================================================
const num = (v) => fmt.number(Number(v) || 0);
const userLabel = (name) => name || 'system';

function runTitle(run) { return `${fmt.part(run.part)} · ${fmt.warehouse(run.warehouse_filter)} · ${fmt.datetimeShort(run.started_at)}`; }

/** "12 order · 4 PDF · 1 gagal" dari baris listRuns (order_count/pdf_count/order_failed). */
function runSummaryText(run) {
  const parts = [fmt.count(run.order_count || 0, 'order'), fmt.count(run.pdf_count || 0, 'PDF')];
  if (run.order_failed) parts.push(`${num(run.order_failed)} gagal`);
  return parts.join(' · ');
}

function durationText(run, nowTs) {
  if (!run.started_at) return '-';
  if (run.finished_at) return fmt.duration(run.finished_at - run.started_at);
  if (run.status === 'running') return `${fmt.duration((nowTs || Math.floor(Date.now() / 1000)) - run.started_at)} (berjalan)`;
  return '-';
}

/** Lead bulat di daftar run: "P1" / "P2" / "P3" (regenerate: ikon refresh). */
function partLead(run) {
  const regen = run.kind === 'regenerate';
  return el('span', { class: 'list-row-icon hist-part-icon', dataset: { part: run.part || '', kind: run.kind || 'process' }, title: regen ? 'Buat ulang PDF' : fmt.part(run.part) },
    regen ? icons.refresh({ size: 17 }) : String(run.part || '?').toUpperCase());
}

function runStatusBadge(run, opts = {}) { return c.badge({ status: run.status, text: fmt.runStatus(run.status), dot: true, ...opts }); }
function staleBadge(count) { return c.badge({ text: count > 1 ? `${num(count)} PDF tidak sesuai` : 'PDF tidak sesuai', tone: 'danger', icon: 'alert' }); }

function pdfStatusBadge(p) {
  const m = PDF_STATUS[p.status] || { text: p.status || '-', tone: 'neutral' };
  return c.badge({ text: m.text, tone: m.tone, dot: true });
}

function groupBadges(p) {
  const out = [];
  if (p.kind === 'productlist') out.push(c.badge({ text: 'Product List', tone: 'dark', size: 'sm', icon: 'list' }));
  else {
    if (p.ship_type) out.push(c.badge({ status: p.ship_type, text: fmt.shipTypeShort(p.ship_type), size: 'sm' }));
    if (p.sku_category) out.push(c.badge({ status: p.sku_category, text: fmt.categoryShort(p.sku_category), size: 'sm' }));
  }
  if (p.warehouse_code) out.push(c.badge({ status: p.warehouse_code, text: fmt.warehouseShort(p.warehouse_code), size: 'sm' }));
  return el('span', { class: 'chip-list' }, out);
}

/** Tombol tautan PDF (unduh/lihat) — <a target=_blank>. */
function pdfLink(p, mode) {
  const view = mode === 'view';
  const b = c.button({
    label: view ? 'Lihat' : 'Unduh', kind: view ? 'ghost' : 'soft', size: 'sm', icon: view ? 'eye' : 'download',
    href: api.url(`/api/history/pdfs/${encodeURIComponent(p.id)}/${view ? 'view' : 'download'}`), title: `${view ? 'Lihat' : 'Unduh'} ${p.file_name || 'PDF'}`,
  });
  b.target = '_blank';
  b.rel = 'noopener';
  return b;
}

function loadError(title, e, retry) {
  return c.alert({ tone: 'danger', title, text: api.errorMessage(e, 'Terjadi kesalahan'), actions: retry ? c.button({ label: 'Coba lagi', kind: 'secondary', size: 'sm', icon: 'refresh', onClick: retry }) : null });
}

function timeCell(ts) {
  return el('div', null, el('div', { class: 'table-cell-main nowrap' }, fmt.datetime(ts)), el('div', { class: 'table-cell-sub' }, fmt.relative(ts)));
}

// ============================================================================
// Daftar: #/history (tabs: Run proses / Log sync / Aktivitas)
// ============================================================================
function readListState(query) {
  return {
    tab: TAB_KEYS.includes(query.tab) ? query.tab : 'runs',
    kind: RUN_KINDS.includes(query.kind) ? query.kind : '',
    status: RUN_STATUSES.includes(query.status) ? query.status : '',
    page: Math.max(1, parseInt(query.page, 10) || 1),
  };
}

/** Simpan tab/filter/halaman ke hash tanpa memicu render ulang (replaceState tidak memicu hashchange). */
function syncUrl(state) {
  try {
    const hash = router.buildHash('/history', { tab: state.tab !== 'runs' ? state.tab : '', kind: state.tab === 'runs' ? state.kind : '', status: state.tab === 'runs' ? state.status : '', page: state.tab === 'runs' && state.page > 1 ? state.page : '' });
    history.replaceState(null, '', location.pathname + location.search + hash);
  } catch { /* abaikan */ }
}

function renderList(container, query, mySeq, ctx) {
  const state = readListState(query);
  const body = el('div', { class: 'hist-body' });
  let reload = () => {};
  const refreshBtn = c.iconButton({ icon: 'refresh', title: 'Muat ulang', kind: 'secondary', onClick: () => reload() });
  const tabs = c.tabs({ items: TAB_ITEMS, active: state.tab, onChange: (k) => { state.tab = k; state.page = 1; syncUrl(state); showTab(); } });

  container.replaceChildren(
    c.pageHeader({ title: 'Riwayat', subtitle: 'Run proses order, log sinkronisasi Shopee, dan aktivitas pengguna', actions: el('div', { class: 'hist-actions' }, refreshBtn) }),
    el('div', { class: 'hist-tabs-row' }, tabs),
    body);

  const showTab = () => {
    stopTimer();
    if (state.tab === 'sync') reload = renderSyncTab(body, mySeq, ctx);
    else if (state.tab === 'activity') reload = renderActivityTab(body, mySeq);
    else reload = renderRunsTab(body, state, mySeq);
  };
  showTab();
}

// ---------------------------------------------------------------- Run proses
function runListItem(run) {
  const badges = el('span', { class: 'hist-run-badges' }, runStatusBadge(run));
  if (run.pdf_stale_count > 0) badges.appendChild(staleBadge(run.pdf_stale_count));
  const sub = [];
  if (run.kind === 'regenerate') sub.push(`Buat ulang PDF${run.source_run_id ? ` dari run #${run.source_run_id}` : ''}`);
  sub.push(userLabel(run.user_name), runSummaryText(run));
  return { key: run.id, lead: partLead(run), title: runTitle(run), subtitle: sub.join(' · '), badge: badges, value: `#${run.id}`, valueSub: fmt.relative(run.started_at), chevron: true };
}

function renderRunsTab(body, state, mySeq) {
  const kindSel = c.select({ options: KIND_OPTIONS, value: state.kind, size: 'sm', inline: true, ariaLabel: 'Jenis run', onChange: (v) => { state.kind = v; state.page = 1; syncUrl(state); load(); } });
  const statusSel = c.select({ options: STATUS_OPTIONS, value: state.status, size: 'sm', inline: true, ariaLabel: 'Status run', onChange: (v) => { state.status = v; state.page = 1; syncUrl(state); load(); } });
  const info = el('span', { class: 'hist-filter-info' });
  const list = c.listPanel({ items: [], onSelect: (it) => router.navigate(`#/history/${encodeURIComponent(it.key)}`) });
  const pager = c.pagination({ page: state.page, total: 0, limit: PAGE_LIMIT, noun: 'run', onChange: (p) => { state.page = p; syncUrl(state); load(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
  const pagerWrap = el('div', { class: 'hist-pager', hidden: true }, pager);
  const card = c.card({ tone: 'dark', title: 'Daftar run', subtitle: 'Klik run untuk melihat detail, PDF, dan order di dalamnya', icon: 'history', className: 'hist-runs', body: c.skeleton(5, { kind: 'list' }) });

  body.replaceChildren(
    el('div', { class: 'hist-filter' }, el('span', { class: 'hist-filter-label' }, icons.filter({ size: 15 }), 'Filter'), kindSel, statusSel, info),
    card, pagerWrap);

  // quiet=true (auto-refresh saat ada run berjalan): perbarui isi tanpa skeleton agar daftar tidak berkedip.
  async function load(opts = {}) {
    stopTimer();
    const myLoad = ++loadSeq;
    if (!opts.quiet) {
      card.setBody(c.skeleton(5, { kind: 'list' }));
      info.textContent = 'Memuat…';
    }
    try {
      const r = await api.get('/api/history/runs', { query: { page: state.page, limit: PAGE_LIMIT, kind: state.kind, status: state.status } });
      if (mySeq !== seq || myLoad !== loadSeq) return;
      const items = Array.isArray(r.items) ? r.items : [];
      const total = Number(r.total) || 0;
      // Halaman di luar jangkauan (mis. ?page=99 atau run terhapus) → lompat ke halaman terakhir yang ada.
      if (!items.length && total > 0 && state.page > 1) {
        state.page = Math.max(1, Math.ceil(total / PAGE_LIMIT));
        syncUrl(state);
        return load(opts);
      }
      if (!items.length) {
        const filtered = !!(state.kind || state.status);
        card.setBody(c.emptyState({
          icon: 'history',
          title: filtered ? 'Tidak ada run yang cocok' : 'Belum ada run proses',
          text: filtered ? 'Ubah filter jenis atau status untuk melihat run lain.' : 'Run akan tercatat di sini setiap kali order diproses dari halaman Process Order.',
          action: filtered
            ? c.button({ label: 'Hapus filter', kind: 'secondary', size: 'sm', icon: 'x', onClick: () => { state.kind = ''; state.status = ''; state.page = 1; kindSel.value = ''; statusSel.value = ''; syncUrl(state); load(); } })
            : c.button({ label: 'Ke Process Order', kind: 'primary', size: 'sm', icon: 'process', href: '#/process' }),
        }));
      } else {
        list.update(items.map(runListItem));
        card.setBody(list);
      }
      pager.set({ page: r.page || state.page, total, limit: r.limit || PAGE_LIMIT });
      pagerWrap.hidden = total <= 0;
      info.textContent = total ? `${num(total)} run` : '';
      if (items.some((x) => x.status === 'running')) later(() => load({ quiet: true }), LIST_REFRESH_MS);
    } catch (e) {
      if (mySeq !== seq || myLoad !== loadSeq || (e && e.status === 401)) return;
      info.textContent = '';
      card.setBody(loadError('Gagal memuat daftar run', e, () => load()));
    }
  }
  load();
  return () => load();
}

// ---------------------------------------------------------------- Log sync
function syncNote(r) {
  const d = r.details || {};
  if (r.error) return el('div', { class: 'hist-err', title: r.error }, r.error);
  const parts = [];
  const stale = Array.isArray(d.changed_processed) ? d.changed_processed.length : 0;
  if (stale) parts.push(`${num(stale)} order yang sudah diproses berubah (PDF perlu dibuat ulang)`);
  if (typeof d.reclassified === 'number') parts.push(`${num(d.reclassified)} order diklasifikasi ulang`);
  if (d.reclassify_error) parts.push(`Klasifikasi ulang gagal: ${d.reclassify_error}`);
  if (Array.isArray(d.shops) && d.shops.length > 1) parts.push(`${num(d.shops.length)} toko`);
  return parts.length ? el('div', { class: classNames('hist-detail-cell', stale && 'text-warning') }, parts.join(' · ')) : '-';
}
function classNames(...a) { return a.filter(Boolean).join(' '); }

const SYNC_COLUMNS = [
  { key: 'started_at', label: 'Waktu', render: (r) => timeCell(r.started_at) },
  { key: 'marketplace', label: 'Marketplace', render: (r) => c.badge({ status: r.marketplace, text: fmt.marketplace(r.marketplace), icon: r.marketplace === 'shopee' ? 'shopee' : null }) },
  { key: 'trigger', label: 'Pemicu', render: (r) => c.badge({ text: r.trigger === 'manual' ? 'Manual' : 'Otomatis', tone: r.trigger === 'manual' ? 'primary' : 'neutral', icon: r.trigger === 'manual' ? 'user' : 'clock' }) },
  { key: 'status', label: 'Status', render: (r) => c.badge({ status: r.status, text: fmt.syncStatus(r.status), dot: true }) },
  { key: 'fetched', label: 'Ditarik', align: 'right', render: (r) => el('span', { class: 'tabular' }, num(r.fetched)) },
  { key: 'created', label: 'Baru', align: 'right', render: (r) => el('span', { class: 'tabular' }, num(r.created)) },
  { key: 'updated', label: 'Diperbarui', align: 'right', render: (r) => el('span', { class: 'tabular' }, num(r.updated)) },
  { key: 'duration', label: 'Durasi', render: (r) => {
    if (r.status === 'running') return el('span', { class: 'row gap-2' }, c.spinner({ size: 'sm' }), 'Berjalan');
    const d = r.details && Number(r.details.duration_ms);
    if (d && isFinite(d)) return d < 1000 ? `${num(d)} ms` : fmt.duration(d / 1000);
    return r.finished_at ? fmt.duration(r.finished_at - r.started_at) : '-';
  } },
  { key: 'note', label: 'Keterangan', render: syncNote },
];

function renderSyncTab(body, mySeq, ctx) {
  const tbl = c.table({ columns: SYNC_COLUMNS, rows: [], loading: true, rowKey: 'id', empty: { icon: 'sync', title: 'Belum ada log sync', text: 'Log akan muncul setelah sinkronisasi pertama dijalankan (otomatis atau lewat tombol Sync).' } });
  const syncBtn = c.button({ label: 'Sync sekarang', kind: 'primary', size: 'sm', icon: 'sync', onClick: async () => {
    if (!(ctx && ctx.layout && typeof ctx.layout.syncNow === 'function')) return;
    syncBtn.setLoading(true);
    try { await ctx.layout.syncNow(); } finally { syncBtn.setLoading(false); }
    load();
  } });
  const card = c.card({ title: 'Log sinkronisasi', subtitle: `Terbaru dulu · ${LOG_LIMIT} entri terakhir`, icon: 'sync', flush: true, actions: syncBtn, body: tbl });
  body.replaceChildren(card);

  async function load(opts = {}) {
    stopTimer();
    const myLoad = ++loadSeq;
    if (!opts.quiet) tbl.update({ loading: true });
    try {
      const r = await api.get('/api/history/sync-logs', { query: { limit: LOG_LIMIT } });
      if (mySeq !== seq || myLoad !== loadSeq) return;
      const items = Array.isArray(r.items) ? r.items : [];
      card.setBody(tbl);
      tbl.update({ rows: items });
      if (items.some((x) => x.status === 'running')) later(() => load({ quiet: true }), LIST_REFRESH_MS);
    } catch (e) {
      if (mySeq !== seq || myLoad !== loadSeq || (e && e.status === 401)) return;
      card.setBody(el('div', { style: { padding: 'var(--card-pad)' } }, loadError('Gagal memuat log sync', e, () => load())));
    }
  }
  load();
  return () => load();
}

// ---------------------------------------------------------------- Aktivitas
function actionLabel(a) { return ACTION_LABELS[a] || fmt.activity(a); }
function actionTone(a) {
  const s = String(a || '');
  if (s === 'process_cancel' || s === 'user_delete' || s === 'shopee_disconnect') return 'danger';
  if (s.startsWith('process') || s === 'regenerate_run') return 'primary';
  if (s.startsWith('sync')) return 'info';
  if (s.startsWith('order') || s.startsWith('settings') || s.startsWith('shopee')) return 'warning';
  return 'neutral';
}

function activityTarget(a) {
  const t = a.target;
  if (t === null || t === undefined || t === '') return '-';
  const s = String(t);
  switch (a.action) {
    case 'process_run': case 'regenerate_run': case 'process_cancel':
      return el('a', { href: `#/history/${encodeURIComponent(s)}`, class: 'fw-600' }, `Run #${s}`);
    case 'order_override': case 'order_reset': case 'order_reclassify':
      return el('a', { href: `#/orders/${encodeURIComponent(s)}`, class: 'mono fw-600' }, s);
    case 'shopee_connect': case 'shopee_refresh': case 'shopee_disconnect': case 'shopee_test':
      return el('span', null, 'Toko ', el('span', { class: 'mono' }, s));
    case 'user_create': case 'user_update': case 'user_delete':
      return el('span', { class: 'fw-600' }, `@${s}`);
    default:
      return el('span', { class: 'mono' }, s);
  }
}

function genericDetail(d) {
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || v === '') continue;
    let val;
    try { val = typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { val = String(v); }
    parts.push(`${k}: ${fmt.truncate(val, 48)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ') || '-';
}

function activityDetail(a) {
  const d = a.details;
  if (d === null || d === undefined) return '-';
  if (typeof d !== 'object') return String(d);
  switch (a.action) {
    case 'process_run': case 'regenerate_run': {
      const parts = [];
      if (d.part) parts.push(fmt.part(d.part));
      if (d.warehouse) parts.push(fmt.warehouse(d.warehouse));
      if (d.orders !== undefined) parts.push(fmt.count(d.orders, 'order'));
      if (d.ok !== undefined) parts.push(`${num(d.ok)} berhasil`);
      if (d.failed) parts.push(`${num(d.failed)} gagal`);
      if (d.skipped) parts.push(`${num(d.skipped)} dilewati`);
      if (d.pdfs !== undefined) parts.push(fmt.count(d.pdfs, 'PDF'));
      if (d.source_run_id) parts.push(`dari run #${d.source_run_id}`);
      if (d.cancelled) parts.push('dibatalkan');
      if (d.fatal) parts.push(`Gagal: ${d.fatal}`);
      return parts.join(' · ') || '-';
    }
    case 'sync_manual': case 'sync_auto': {
      const parts = [fmt.syncStatus(d.status)];
      if (d.fetched !== undefined) parts.push(`${num(d.fetched)} ditarik`);
      if (d.created !== undefined) parts.push(`${num(d.created)} baru`);
      if (d.updated !== undefined) parts.push(`${num(d.updated)} diperbarui`);
      if (d.changed_processed) parts.push(`${num(d.changed_processed)} PDF perlu dibuat ulang`);
      if (d.error) parts.push(String(d.error));
      return parts.join(' · ');
    }
    case 'settings_update': {
      const keys = Array.isArray(d.keys) ? d.keys : [];
      return keys.length ? `Kunci: ${keys.join(', ')}` : '-';
    }
    case 'order_override': {
      const keys = d.patch && typeof d.patch === 'object' ? Object.keys(d.patch) : [];
      return keys.length ? `Ubah ${keys.map((k) => OVERRIDE_LABELS[k] || k).join(', ')}${d.proc_status ? ` · status ${fmt.procStatus(d.proc_status)}` : ''}` : '-';
    }
    case 'order_reset':
      return `${fmt.procStatus(d.from)} → ${fmt.procStatus(d.to)}${d.run_id ? ` (run #${d.run_id})` : ''}`;
    case 'login': return d.ip ? `IP ${d.ip}` : '-';
    case 'shopee_connect': return [d.shop_name, d.via ? `via ${d.via === 'callback' ? 'OAuth callback' : 'input manual'}` : null].filter(Boolean).join(' · ') || '-';
    case 'shopee_test': return d.ok ? `Berhasil${d.latency_ms ? ` · ${num(d.latency_ms)} ms` : ''}` : 'Gagal';
    case 'shopee_auth_url': return d.transport ? `Transport ${d.transport}` : '-';
    case 'user_create': case 'user_update': case 'user_delete': {
      const parts = [];
      if (d.name) parts.push(d.name);
      if (d.role) parts.push(fmt.role(d.role));
      if (d.active !== undefined) parts.push(d.active ? 'aktif' : 'nonaktif');
      if (d.password_changed) parts.push('password diubah');
      return parts.join(' · ') || '-';
    }
    default: return genericDetail(d);
  }
}

const ACTIVITY_COLUMNS = [
  { key: 'ts', label: 'Waktu', render: (a) => timeCell(a.ts) },
  { key: 'user_name', label: 'Pengguna', render: (a) => el('span', { class: 'row gap-2 nowrap' }, c.avatar({ name: userLabel(a.user_name), size: 'xs' }), el('span', { class: 'fw-600' }, userLabel(a.user_name))) },
  { key: 'action', label: 'Aksi', render: (a) => c.badge({ text: actionLabel(a.action), tone: actionTone(a.action), icon: ACTION_ICONS[a.action] || 'activity' }) },
  { key: 'target', label: 'Target', render: activityTarget },
  { key: 'details', label: 'Detail', render: (a) => el('div', { class: 'hist-detail-cell' }, activityDetail(a)) },
];

function renderActivityTab(body, mySeq) {
  const tbl = c.table({ columns: ACTIVITY_COLUMNS, rows: [], loading: true, rowKey: 'id', empty: { icon: 'activity', title: 'Belum ada aktivitas', text: 'Login, sync, proses order, dan perubahan pengaturan akan tercatat di sini.' } });
  const card = c.card({ title: 'Aktivitas pengguna', subtitle: `Terbaru dulu · ${LOG_LIMIT} entri terakhir`, icon: 'activity', flush: true, body: tbl });
  body.replaceChildren(card);

  async function load() {
    stopTimer();
    const myLoad = ++loadSeq;
    tbl.update({ loading: true });
    try {
      const r = await api.get('/api/history/activity', { query: { limit: LOG_LIMIT } });
      if (mySeq !== seq || myLoad !== loadSeq) return;
      card.setBody(tbl);
      tbl.update({ rows: Array.isArray(r.items) ? r.items : [] });
    } catch (e) {
      if (mySeq !== seq || myLoad !== loadSeq || (e && e.status === 401)) return;
      card.setBody(el('div', { style: { padding: 'var(--card-pad)' } }, loadError('Gagal memuat aktivitas', e, () => load())));
    }
  }
  load();
  return () => load();
}

// ============================================================================
// Detail run: #/history/:runId
// ============================================================================
function detailHeader(runId, run) {
  const kindText = run ? fmt.runKind(run.kind) : null;
  return c.pageHeader({
    title: `Run #${runId}`,
    back: { label: 'Riwayat', href: '#/history' },
    eyebrow: el('span', { class: 'hist-eyebrow' }, kindText || 'Detail run'),
  });
}

async function renderDetail(container, runId, mySeq, quiet = false) {
  if (!quiet) {
    container.replaceChildren(detailHeader(runId, null),
      el('div', { class: 'stack' }, c.skeleton(1, { kind: 'card', height: 240 }), c.skeleton(6, { kind: 'table' })));
  }
  let detail;
  try {
    detail = await api.get(`/api/history/runs/${encodeURIComponent(runId)}`);
  } catch (e) {
    if (mySeq !== seq || (e && e.status === 401)) return;
    const notFound = e && (e.status === 404 || e.status === 400);
    container.replaceChildren(detailHeader(runId, null),
      el('div', { class: 'card page-placeholder' }, c.emptyState({
        icon: notFound ? 'history' : 'alert',
        title: notFound ? 'Run tidak ditemukan' : 'Gagal memuat run',
        text: notFound ? `Run #${runId} tidak ada di riwayat. Mungkin ID salah atau data sudah dihapus.` : api.errorMessage(e),
        action: el('div', { class: 'row gap-2 wrap center' },
          c.button({ label: 'Ke daftar riwayat', kind: 'primary', icon: 'history', href: '#/history' }),
          notFound ? null : c.button({ label: 'Coba lagi', kind: 'secondary', icon: 'refresh', onClick: () => renderDetail(container, runId, mySeq) })),
      })));
    return;
  }
  if (mySeq !== seq) return;
  if (!detail || !detail.run) { container.replaceChildren(detailHeader(runId, null), el('div', { class: 'card page-placeholder' }, c.emptyState({ icon: 'history', title: 'Run tidak ditemukan', action: c.button({ label: 'Ke daftar riwayat', kind: 'primary', href: '#/history' }) }))); return; }
  paintDetail(container, detail, mySeq);
}

function infoItem(label, value, opts = {}) {
  return el('div', { class: classNames('hist-info-item', opts.wide && 'is-wide') },
    el('div', { class: 'hist-info-label' }, label),
    el('div', { class: classNames('hist-info-value', opts.danger && 'is-danger', opts.mono && 'mono') }, value === null || value === undefined || value === '' ? '-' : value));
}

function paintDetail(container, detail, mySeq) {
  let run = detail.run;
  const runId = run.id;
  const progress = detail.progress || {};
  // Run tercatat 'running' di DB tetapi progress menyatakan sudah selesai (mis. server dimulai ulang dan run
  // dipulihkan sebagai gagal tepat saat detail diambil) → pakai status akhir dari progress agar tidak terlihat "Berjalan" terus.
  if (run.status === 'running' && progress.finished === true && progress.status && progress.status !== 'running') {
    run = { ...run, status: progress.status, finished_at: run.finished_at || progress.finished_at || null, summary: run.summary || progress.summary || null };
  }
  const orders = Array.isArray(detail.orders) ? detail.orders : [];
  const pdfs = Array.isArray(detail.pdfs) ? detail.pdfs : [];
  const running = run.status === 'running' && progress.finished !== true;
  const failedOrders = orders.filter((o) => o.status === 'failed');
  const s = run.summary || progress.summary || null;
  const counts = {
    orders: s && s.orders !== undefined ? s.orders : orders.length,
    ok: s && s.ok !== undefined ? s.ok : orders.filter((o) => o.status === 'ok').length,
    failed: s && s.failed !== undefined ? s.failed : failedOrders.length,
    skipped: s && s.skipped !== undefined ? s.skipped : orders.filter((o) => o.status === 'skipped').length,
    pdfs: pdfs.length,
  };
  if (running) { counts.orders = orders.length; counts.ok = orders.filter((o) => o.status === 'ok').length; counts.failed = failedOrders.length; counts.skipped = orders.filter((o) => o.status === 'skipped').length; }
  const reload = () => renderDetail(container, runId, mySeq, true);

  // ---------- aksi header ----------
  const actions = [];
  if (running) {
    const cancelBtn = c.button({ label: progress.cancel_requested ? 'Membatalkan…' : 'Batalkan run', kind: 'danger-soft', icon: 'stop', disabled: !!progress.cancel_requested, onClick: () => cancelRun(runId, cancelBtn) });
    actions.push(cancelBtn);
  }
  if (!running && failedOrders.length) {
    actions.push(c.button({ label: 'Buat ulang yang gagal', kind: 'primary', icon: 'refresh', onClick: (_e, btn) => confirmRegenerate(runId, { only_failed: true }, {
      title: `Proses ulang ${num(failedOrders.length)} order yang gagal?`,
      message: `Order yang gagal di run #${runId} akan diproses ulang di run baru (jenis "Buat ulang PDF"). Order yang sudah berhasil tidak disentuh.`,
      label: 'Proses ulang order gagal',
    }, btn) }));
  }
  actions.push(c.iconButton({ icon: 'refresh', title: 'Muat ulang', kind: 'secondary', onClick: reload }));
  const header = c.pageHeader({
    title: `Run #${runId}`,
    back: { label: 'Riwayat', href: '#/history' },
    eyebrow: el('span', { class: 'hist-eyebrow' }, fmt.runKind(run.kind)),
    actions: el('div', { class: 'hist-actions' }, actions),
  });

  // ---------- panel gradien: info + tile KPI (+ progress) ----------
  const statusPill = el('span', { class: 'hist-status-pill' }, c.statusDot(run.status, { pulsing: running }), fmt.runStatus(run.status));
  const tiles = el('div', { class: 'glass-grid hist-tiles' },
    c.glassTile({ label: 'Order', value: counts.orders, icon: 'orders' }),
    c.glassTile({ label: 'Berhasil', value: counts.ok, icon: 'checkCircle' }),
    c.glassTile({ label: 'Gagal', value: counts.failed, icon: 'xCircle' }),
    c.glassTile({ label: 'Dilewati', value: counts.skipped, icon: 'minus' }),
    c.glassTile({ label: 'PDF', value: counts.pdfs, icon: 'pdf' }));
  const nowTs = Math.floor(Date.now() / 1000);
  const durationItem = infoItem('Durasi', durationText(run, nowTs));
  const info = el('div', { class: 'hist-info' },
    infoItem('Mulai', fmt.datetime(run.started_at)),
    infoItem('Selesai', run.finished_at ? fmt.datetime(run.finished_at) : (running ? 'Sedang berjalan…' : '-')),
    durationItem,
    infoItem('Dijalankan oleh', userLabel(run.user_name)),
    infoItem('Jenis run', fmt.runKind(run.kind)),
    infoItem('Marketplace', fmt.marketplace(run.marketplace)),
    run.kind === 'regenerate' && run.source_run_id ? infoItem('Run sumber', el('a', { href: `#/history/${encodeURIComponent(run.source_run_id)}` }, `Run #${run.source_run_id}`)) : null,
    run.note ? infoItem('Catatan', run.note, { wide: true }) : null,
    run.error ? infoItem('Kesalahan', run.error, { wide: true, danger: true }) : null);

  let progressUi = null;
  if (running) {
    const bar = c.progressBar({ value: progress.done || 0, max: progress.total || counts.orders || 0, label: progress.cancel_requested ? 'Membatalkan…' : 'Memproses order', striped: true, format: (v, m) => `${num(v)} / ${num(m)} order` });
    const note = el('div', { class: 'hist-progress-note' });
    const describe = (p) => {
      const parts = [RUN_STAGE[p.stage] || fmt.stage(p.stage)];
      if (p.current && p.current.order_sn) parts.push(`${p.current.order_sn} · ${fmt.stage(p.current.stage)}`);
      else if (Array.isArray(p.active) && p.active.length) parts.push(`${num(p.active.length)} order sedang berjalan`);
      if (p.cancel_requested) parts.push('pembatalan diminta');
      note.textContent = parts.join(' — ');
    };
    describe(progress);
    const durationValue = durationItem.querySelector('.hist-info-value');
    progressUi = { node: el('div', { class: 'stack-sm hist-progress' }, bar, note), update: (p) => {
      bar.set(p.done || 0, p.total || 0);
      if (p.cancel_requested) bar.setLabel('Membatalkan…');
      describe(p);
      // Durasi ikut berdetak selama polling (kalau tidak, "0 dtk (berjalan)" membeku sampai run selesai).
      if (durationValue) durationValue.textContent = durationText(run, Math.floor(Date.now() / 1000));
    } };
  }

  const hero = el('div', { class: 'card card-gradient hist-hero' },
    el('div', { class: 'card-header' },
      el('div', { class: 'row gap-3 min-w-0' },
        c.iconBox({ icon: run.kind === 'regenerate' ? 'refresh' : 'process', tone: 'glass', size: 'lg' }),
        el('div', { class: 'card-header-text' },
          el('div', { class: 'card-title hist-hero-title' }, `${fmt.part(run.part)} · ${fmt.warehouse(run.warehouse_filter)}`),
          el('div', { class: 'card-subtitle' }, `${fmt.datetimeShort(run.started_at)} · ${fmt.runKind(run.kind)}${run.kind === 'regenerate' && run.source_run_id ? ` dari run #${run.source_run_id}` : ''}`))),
      el('div', { class: 'card-actions' }, statusPill)),
    el('div', { class: 'card-body stack' }, tiles, progressUi ? progressUi.node : null, info));

  // ---------- kartu PDF ----------
  const pdfCard = buildPdfCard({ runId, pdfs, running, run });

  // ---------- kartu order ----------
  const orderCard = buildOrderCard({ orders, running, counts });

  const note = el('div', { class: 'notice-box hist-note' }, icons.info({ size: 16 }),
    el('span', null, el('b', 'PDF berhasil dibuat bukan berarti order sudah dikirim ke kurir.'), ' Pastikan paket dan resi diserahkan ke kurir sesuai jadwal pickup/drop-off.'));

  container.replaceChildren(header, el('div', { class: 'stack hist-detail' }, hero, pdfCard, orderCard, note));

  if (running) {
    watchProgress(runId, progressUi, mySeq, (p) => {
      toast[p.status === 'done' ? 'success' : p.status === 'partial' ? 'warn' : 'error'](`Run #${runId} selesai: ${fmt.runStatus(p.status)}.`, { title: 'Proses selesai' });
      reload();
    });
  }
}

function buildPdfCard({ runId, pdfs, running, run }) {
  const selected = new Set();
  const selectable = (p) => !running && p.status !== 'superseded';
  const selectableIds = pdfs.filter(selectable).map((p) => p.id);
  const staleIds = pdfs.filter((p) => p.status === 'stale').map((p) => p.id);

  const regenBtn = c.button({ label: 'Buat ulang PDF terpilih', kind: 'primary', size: 'sm', icon: 'refresh', disabled: true, onClick: (_e, btn) => {
    const ids = [...selected];
    if (!ids.length) return;
    confirmRegenerate(runId, { pdf_ids: ids }, {
      title: `Buat ulang ${num(ids.length)} PDF?`,
      message: 'Label akan diunduh ulang dari Shopee untuk order di PDF terpilih, lalu digabung menjadi PDF baru di run baru. Order yang sudah batal tidak disertakan. PDF lama ditandai "Digantikan".',
      label: 'Pembuatan ulang PDF',
    }, btn);
  } });
  const regenLabel = regenBtn.querySelector('.btn-label');
  const headCb = el('input', { type: 'checkbox', 'aria-label': 'Pilih semua PDF', disabled: !selectableIds.length, onChange: () => {
    if (headCb.checked) selectableIds.forEach((id) => selected.add(id)); else selected.clear();
    for (const cb of table.querySelectorAll('tbody input[type=checkbox]')) if (!cb.disabled) cb.checked = selected.has(Number(cb.dataset.id));
    syncSelection();
  } });
  const syncSelection = () => {
    const n = selected.size;
    regenBtn.disabled = n === 0;
    regenLabel.textContent = n ? `Buat ulang PDF terpilih (${num(n)})` : 'Buat ulang PDF terpilih';
    headCb.checked = n > 0 && n === selectableIds.length;
    headCb.indeterminate = n > 0 && n < selectableIds.length;
    for (const tr of table.querySelectorAll('tbody tr[data-key]')) tr.classList.toggle('is-selected', selected.has(Number(tr.dataset.key)));
  };
  const toggle = (p, on) => {
    if (!selectable(p)) return;
    const next = on === undefined ? !selected.has(p.id) : !!on;
    if (next) selected.add(p.id); else selected.delete(p.id);
    const cb = table.querySelector(`tbody input[type=checkbox][data-id="${p.id}"]`);
    if (cb) cb.checked = next;
    syncSelection();
  };

  const columns = [
    { key: 'select', label: el('span', { class: 'hist-check' }, headCb), width: 36, render: (p) => el('span', { class: 'hist-check' }, el('input', { type: 'checkbox', dataset: { id: p.id }, disabled: !selectable(p), 'aria-label': `Pilih ${p.file_name || 'PDF'}`, onChange: (e) => toggle(p, e.target.checked) })) },
    { key: 'file_name', label: 'Berkas', render: (p) => el('div', { class: 'min-w-0' }, el('div', { class: 'table-cell-main mono' }, p.file_name || '-'), el('div', { class: 'table-cell-sub' }, fmt.pdfLabel(p.file_name))) },
    { key: 'group', label: 'Kelompok', render: groupBadges },
    { key: 'order_count', label: 'Order', align: 'right', render: (p) => el('span', { class: 'tabular' }, num(p.order_count)) },
    { key: 'page_count', label: 'Halaman', align: 'right', render: (p) => (p.page_count ? el('span', { class: 'tabular' }, num(p.page_count)) : '-') },
    { key: 'size_bytes', label: 'Ukuran', align: 'right', render: (p) => (p.size_bytes ? fmt.fileSize(p.size_bytes) : '-') },
    { key: 'status', label: 'Status', render: (p) => el('div', null, pdfStatusBadge(p), p.stale_reason ? el('div', { class: classNames('hist-reason', p.status === 'failed' && 'is-danger'), title: p.stale_reason }, p.stale_reason) : null) },
    { key: 'actions', label: 'Aksi', align: 'right', render: (p) => el('span', { class: 'hist-pdf-actions' }, pdfLink(p, 'download'), pdfLink(p, 'view')) },
  ];
  const emptyOpts = { icon: 'pdf', title: running ? 'PDF belum dibuat' : 'Tidak ada PDF', text: running ? 'PDF akan muncul setelah semua order selesai diproses.' : (run.status === 'failed' ? 'Run gagal sebelum PDF sempat dibuat.' : 'Run ini tidak menghasilkan PDF.') };
  const table = c.table({
    columns, rows: pdfs, rowKey: 'id',
    rowClass: (p) => (p.status === 'superseded' ? 'is-muted' : null),
    onRowClick: (p) => toggle(p),
    empty: emptyOpts,
  });

  const bodyParts = [];
  if (staleIds.length) {
    bodyParts.push(el('div', { class: 'hist-card-alert' }, c.alert({
      tone: 'warning', icon: 'alert', title: 'PDF tidak sesuai, perlu dibuat ulang',
      text: `${num(staleIds.length)} PDF berisi order yang berubah atau dibatalkan setelah PDF dibuat. Buat ulang agar label yang dicetak sesuai data terbaru.`,
      actions: running ? null : c.button({ label: 'Buat ulang PDF tidak sesuai', kind: 'primary', size: 'sm', icon: 'refresh', onClick: (_e, btn) => confirmRegenerate(runId, { pdf_ids: staleIds }, {
        title: `Buat ulang ${num(staleIds.length)} PDF yang tidak sesuai?`,
        message: 'Label akan diunduh ulang dari Shopee untuk order di PDF tersebut (order yang sudah batal dikeluarkan), lalu digabung menjadi PDF baru di run baru.',
        label: 'Pembuatan ulang PDF',
      }, btn) }),
    })));
  }
  // Tanpa baris: tampilkan state kosong langsung di badan kartu (bukan di dalam tabel) — di layar sempit tabel
  // lebih lebar dari kartunya sehingga state kosong di tengah tabel akan terpotong oleh gulir mendatar.
  bodyParts.push(pdfs.length ? table : c.emptyState({ ...emptyOpts, size: 'sm' }));

  const okCount = pdfs.filter((p) => p.status === 'ok').length;
  // Tombol & petunjuk "centang berkas" hanya bila memang ada berkas yang bisa dipilih (run selesai, belum semua digantikan).
  const subtitle = pdfs.length
    ? `${num(pdfs.length)} berkas${okCount !== pdfs.length ? ` · ${num(okCount)} OK` : ''}${staleIds.length ? ` · ${num(staleIds.length)} tidak sesuai` : ''}${selectableIds.length ? ' · centang berkas untuk membuat ulang sebagian' : ''}`
    : 'Label AWB dan Product List hasil run ini';
  return c.card({ title: 'PDF', subtitle, icon: 'pdf', flush: true, actions: selectableIds.length ? regenBtn : null, body: bodyParts, className: 'hist-pdf-card' });
}

function buildOrderCard({ orders, running, counts }) {
  const columns = [
    { key: 'order_sn', label: 'Order', render: (o) => {
      const sn = String(o.order_sn || '');
      const sum = o.summary || {};
      return el('div', { class: 'min-w-0' },
        el('a', { class: 'table-cell-main mono', href: `#/orders/${encodeURIComponent(sn)}`, title: 'Lihat detail order' }, sn || '-'),
        sum.recipient_name ? el('div', { class: 'table-cell-sub truncate hist-recipient' }, sum.recipient_name) : null);
    } },
    { key: 'sku_category', label: 'Kategori', render: (o) => (o.sku_category ? c.badge({ status: o.sku_category, text: fmt.categoryShort(o.sku_category) }) : '-') },
    { key: 'ship_type', label: 'Jenis', render: (o) => (o.ship_type ? c.badge({ status: o.ship_type, text: fmt.shipTypeShort(o.ship_type) }) : '-') },
    { key: 'warehouse_code', label: 'Gudang', render: (o) => (o.warehouse_code ? fmt.warehouse(o.warehouse_code) : c.badge({ text: 'Tidak diketahui', tone: 'warning', size: 'sm' })) },
    { key: 'stage', label: 'Tahap', render: (o) => fmt.stage(o.stage) },
    { key: 'status', label: 'Status', render: (o) => c.badge({ status: o.status, text: fmt.runOrderStatus(o.status), dot: true }) },
    { key: 'note', label: 'Keterangan', render: (o) => {
      const flags = o.flags || {};
      const sum = o.summary || {};
      const parts = [];
      if (flags.tipe_belum_ditulis) parts.push(c.badge({ text: 'TIPE BELUM DITULIS', tone: 'danger', solid: true, icon: 'alert' }));
      if (sum.pdf_stale) parts.push(c.badge({ text: 'PDF tidak sesuai', tone: 'warning', size: 'sm' }));
      if (sum.proc_status === 'cancelled') parts.push(c.badge({ status: 'cancelled', text: 'Order dibatalkan', size: 'sm' }));
      if (o.error) parts.push(el('div', { class: 'hist-err', title: o.error }, o.error));
      return parts.length ? el('div', { class: 'hist-note-cell' }, parts) : '-';
    } },
  ];
  const emptyOpts = { icon: 'orders', title: 'Tidak ada order di run ini', text: running ? 'Order sedang disiapkan…' : 'Run ini tidak memuat order (mis. hanya membangun ulang Product List).' };
  const table = c.table({ columns, rows: orders, rowKey: 'order_sn', rowClass: (o) => (o.status === 'skipped' ? 'is-muted' : null), empty: emptyOpts });
  const sub = orders.length
    ? [fmt.count(orders.length, 'order'), `${num(counts.ok)} berhasil`, counts.failed ? `${num(counts.failed)} gagal` : null, counts.skipped ? `${num(counts.skipped)} dilewati` : null].filter(Boolean).join(' · ')
    : 'Order yang ikut diproses di run ini';
  // Lihat catatan di buildPdfCard: state kosong dirender langsung di badan kartu agar tidak terpotong di layar sempit.
  return c.card({ title: 'Order dalam run', subtitle: sub, icon: 'orders', flush: true, body: orders.length ? table : c.emptyState({ ...emptyOpts, size: 'sm' }), className: 'hist-order-card' });
}

// ---------------------------------------------------------------- aksi
let busy = false; // satu aksi POST (regenerate/cancel) pada satu waktu — cegah klik ganda / submit ganda
const setBtnLoading = (btn, on) => { if (btn && typeof btn.setLoading === 'function') btn.setLoading(on); };

async function confirmRegenerate(runId, body, { title, message, label }, btn) {
  if (busy) return;
  const ok = await modal.confirm({ title, message, confirmLabel: 'Buat ulang', icon: 'refresh' });
  if (!ok || busy) return;
  busy = true;
  setBtnLoading(btn, true);
  try {
    const r = await api.post(`/api/process/runs/${encodeURIComponent(runId)}/regenerate`, body);
    const newId = r && r.run_id;
    toast.success(`${label} dimulai${newId ? ` sebagai run #${newId}` : ''}.`, { title: 'Buat ulang PDF' });
    if (newId) router.navigate(`#/history/${encodeURIComponent(newId)}`);
  } catch (e) {
    reportError(e, 'Gagal memulai pembuatan ulang PDF');
  } finally {
    busy = false;
    setBtnLoading(btn, false);
  }
}

async function cancelRun(runId, btn) {
  if (busy) return;
  const ok = await modal.confirm({ title: `Batalkan run #${runId}?`, message: 'Order yang sedang diproses akan diselesaikan dulu; order yang belum mulai akan dilewati. PDF hanya dibuat untuk order yang sudah berhasil.', confirmLabel: 'Ya, batalkan', danger: true });
  if (!ok || busy) return;
  busy = true;
  setBtnLoading(btn, true);
  try {
    const r = await api.post(`/api/process/runs/${encodeURIComponent(runId)}/cancel`);
    toast[r && r.ok ? 'info' : 'warn']((r && r.message) || 'Pembatalan diminta.');
    if (r && r.ok && btn) {
      // Pembatalan sudah diminta: tombol dikunci sampai polling mengganti tampilan (run selesai → detail dimuat ulang).
      setBtnLoading(btn, false);
      btn.disabled = true;
      const lbl = btn.querySelector('.btn-label');
      if (lbl) lbl.textContent = 'Membatalkan…';
      return;
    }
  } catch (e) {
    reportError(e, 'Gagal membatalkan run');
  } finally {
    busy = false;
    if (btn && !btn.disabled) setBtnLoading(btn, false);
  }
}

/** Polling GET /api/process/runs/:id/progress sampai finished. Hanya rantai polling terbaru yang berjalan. */
function watchProgress(runId, ui, mySeq, onFinished) {
  const myWatch = ++loadSeq;
  const alive = () => mySeq === seq && myWatch === loadSeq;
  const tick = async () => {
    if (!alive()) return;
    try {
      const p = await api.get(`/api/process/runs/${encodeURIComponent(runId)}/progress`);
      if (!alive()) return;
      if (ui) ui.update(p);
      if (p && p.finished) { onFinished(p); return; }
    } catch (e) {
      if (!alive() || (e && (e.status === 401 || e.status === 404))) return;
    }
    later(tick, POLL_MS);
  };
  later(tick, POLL_MS);
}

export const page = { title, render, destroy };
export default page;
