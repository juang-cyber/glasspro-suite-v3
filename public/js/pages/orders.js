/**
 * Halaman Pesanan.
 *   #/orders       daftar order (cari, filter, tab cepat per status proses, paging) → klik baris ke detail
 *   #/orders/:sn   detail order: info, item, validasi, koreksi manual (overrides), panel status proses,
 *                  PDF yang memuat order, riwayat run, aksi admin (reset / klasifikasi ulang), data mentah Shopee.
 *
 * API: GET /api/orders, GET /api/orders/:sn, PATCH /api/orders/:sn/overrides, POST /api/orders/:sn/reset (admin),
 *      POST /api/orders/:sn/reclassify. Unduh PDF: GET /api/history/pdfs/:id/download.
 * Semua data order dirender lewat el()/text node — tidak ada innerHTML dengan data dari server.
 */
import { api, router, store, el, toast, modal, fmt, components as c, icons, reportError } from '../core.js';

// ============================================================================
// Konstanta & helper umum
// ============================================================================
const LIMIT_DEFAULT = 20;
const LIMIT_OPTIONS = [10, 20, 50, 100];
const PROC_KEYS = ['unprocessed', 'review', 'processing', 'processed', 'failed', 'cancelled'];
const PROC_TABS = [
  { key: 'all', label: 'Semua', icon: 'list' },
  { key: 'unprocessed', label: 'Belum diproses' },
  { key: 'review', label: 'Perlu diperiksa', tone: 'warning' },
  { key: 'processing', label: 'Sedang diproses' },
  { key: 'processed', label: 'Sudah diproses' },
  { key: 'failed', label: 'Gagal', tone: 'danger' },
  { key: 'cancelled', label: 'Dibatalkan' },
];
const ORDER_STATUSES = ['READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'COMPLETED', 'IN_CANCEL', 'CANCELLED', 'UNPAID', 'RETRY_SHIP', 'TO_CONFIRM_RECEIVE', 'TO_RETURN'];
const SORT_OPTIONS = [
  { value: 'create_time:desc', label: 'Terbaru dibuat' },
  { value: 'create_time:asc', label: 'Terlama dibuat' },
  { value: 'ship_by_date:asc', label: 'Batas kirim terdekat' },
  { value: 'update_time:desc', label: 'Terakhir diperbarui' },
  { value: 'processed_at:desc', label: 'Terakhir diproses' },
];
const SORT_KEYS = ['create_time', 'update_time', 'ship_by_date', 'processed_at'];
// Status Shopee yang sudah tidak butuh hitung mundur batas kirim.
const DEADLINE_DONE = new Set(['CANCELLED', 'IN_CANCEL', 'SHIPPED', 'COMPLETED', 'TO_CONFIRM_RECEIVE', 'TO_RETURN']);
const PHONE_SOURCE = { model_name: 'dari variasi', note: 'dari catatan pembeli', message_to_seller: 'dari pesan ke penjual', override: 'koreksi manual' };
const URGENT_HOURS = 5;

const nowSec = () => Math.floor(Date.now() / 1000);
const enc = (s) => encodeURIComponent(String(s));

/** Key override yang benar-benar aktif (nilai false/null/'' dianggap tidak ada, mis. sisa `force_process: false`). */
function activeOverrideKeys(ov) {
  return Object.keys(ov || {}).filter((k) => { const v = ov[k]; return v !== null && v !== undefined && v !== false && v !== ''; });
}

/** Daftar gudang dari setting (fallback jkt/sby bila setting belum termuat). */
function warehouseOptions(withAll = true) {
  const s = store.settings;
  const list = s && Array.isArray(s.warehouses) && s.warehouses.length ? s.warehouses : [{ code: 'jkt', name: 'Jakarta' }, { code: 'sby', name: 'Surabaya' }];
  const opts = list.filter((w) => w && w.code).map((w) => ({ value: String(w.code).toLowerCase(), label: w.name || fmt.warehouse(w.code) }));
  return withAll ? [{ value: 'all', label: 'Semua gudang' }, ...opts] : opts;
}

/**
 * Info batas kirim untuk tampilan: { main, sub, tone, hours }.
 * Order yang sudah diproses / batal / terkirim tidak dihitung mundur — cukup tanggalnya.
 */
function deadlineInfo(o, now = nowSec()) {
  if (!o || !o.ship_by_date) return { main: '-', sub: '', tone: 'muted', hours: null };
  const hours = (o.ship_by_date - now) / 3600;
  const done = DEADLINE_DONE.has(o.order_status) || o.proc_status === 'processed' || o.proc_status === 'cancelled';
  if (done) {
    const why = o.proc_status === 'processed' ? 'Sudah diproses' : o.proc_status === 'cancelled' || o.order_status === 'CANCELLED' || o.order_status === 'IN_CANCEL' ? 'Order dibatalkan' : fmt.orderStatus(o.order_status);
    return { main: fmt.datetimeShort(o.ship_by_date), sub: why, tone: 'muted', hours, done: true };
  }
  const tone = hours <= 0 ? 'danger' : hours < URGENT_HOURS ? 'danger' : hours < 12 ? 'warning' : 'normal';
  return { main: fmt.hoursLeft(hours), sub: fmt.datetimeShort(o.ship_by_date), tone, hours };
}

/** Ikon peringatan kecil bulat (dipakai di kolom tabel & chip). */
function warnIcon(name, tone, title) {
  return el('span', { class: `warn-ic tone-${tone}`, title, 'aria-label': title, role: 'img' }, icons.get(name, { size: 13 }));
}

function warnIcons(o) {
  const out = [];
  const v = o.validation || {};
  const flags = v.flags || {};
  if (o.pdf_stale) out.push(warnIcon('pdf', 'warning', 'PDF tidak sesuai, perlu dibuat ulang'));
  if (flags.tipe_belum_ditulis) out.push(warnIcon('phone', 'danger', 'Tipe HP belum ditulis — label diberi tanda besar'));
  const holds = (v.holds || []).filter((h) => h && h.code !== 'WAREHOUSE_FILTER');
  if (holds.length) out.push(warnIcon('alert', 'danger', `Ditahan: ${holds.map((h) => fmt.holdCode(h.code)).join(', ')}`));
  const warns = (v.warnings || []).filter(Boolean);
  if (warns.length) out.push(warnIcon('info', 'warning', warns.map((w) => fmt.warningCode(w.code)).join(', ')));
  if (activeOverrideKeys(o.overrides).length) out.push(warnIcon('edit', 'primary', 'Ada koreksi manual'));
  if (!out.length) return el('span', { class: 'text-muted-2' }, '—');
  return el('div', { class: 'orders-warn-icons' }, out);
}

function marketplaceBadge(m, size = 'sm') {
  return c.badge({ text: fmt.marketplace(m || 'shopee'), tone: m === 'tiktok' ? 'dark' : 'warning', size, icon: m === 'tiktok' ? 'tiktok' : 'shopee' });
}

function categoryBadge(cat, size = 'md') {
  if (!cat) return el('span', { class: 'text-muted' }, '-');
  return c.badge({ status: cat, text: fmt.categoryShort(cat), size, title: fmt.category(cat) });
}

function warehouseNode(code) {
  return code ? el('span', { class: 'row gap-2' }, icons.warehouse({ size: 14, class: 'text-muted' }), fmt.warehouse(code)) : c.badge({ text: 'Tidak diketahui', tone: 'warning', size: 'sm' });
}

// ============================================================================
// Halaman daftar (#/orders)
// ============================================================================
let lastListHash = '#/orders';   // untuk tautan "Kembali" dari detail (mempertahankan filter)
let listSeq = 0;
let listInst = null;             // instance render daftar yang masih hidup (callback tertunda, mis. debounce cari, diabaikan setelah pindah halaman)
let listUnsubs = [];             // langganan store yang dilepas saat destroy
let liveTimer = null;
const liveCells = [];            // sel hitung mundur yang diperbarui tiap 30 dtk

function defaultState() {
  return { q: '', proc_status: 'all', order_status: 'all', warehouse: 'all', ship_type: 'all', category: 'all', stale: false, sort: 'create_time', dir: 'desc', page: 1, limit: LIMIT_DEFAULT };
}
function stateFromQuery(q = {}) {
  const s = defaultState();
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  if (one(q.q)) s.q = String(one(q.q)).slice(0, 100);
  if (PROC_KEYS.includes(one(q.proc_status))) s.proc_status = one(q.proc_status);
  if (ORDER_STATUSES.includes(String(one(q.order_status) || '').toUpperCase())) s.order_status = String(one(q.order_status)).toUpperCase();
  if (one(q.warehouse) && one(q.warehouse) !== 'all') s.warehouse = String(one(q.warehouse)).toLowerCase();
  if (['instant', 'regular'].includes(one(q.ship_type))) s.ship_type = one(q.ship_type);
  if (['tg', 'hg', 'mix', 'review'].includes(one(q.category))) s.category = one(q.category);
  if (['1', 'true'].includes(String(one(q.stale)))) s.stale = true;
  if (SORT_KEYS.includes(one(q.sort))) s.sort = one(q.sort);
  if (['asc', 'desc'].includes(one(q.dir))) s.dir = one(q.dir);
  const page = parseInt(one(q.page), 10); if (page > 0) s.page = page;
  const limit = parseInt(one(q.limit), 10); if (LIMIT_OPTIONS.includes(limit)) s.limit = limit;
  return s;
}
function queryFromState(s) {
  const q = {};
  if (s.q) q.q = s.q;
  if (s.proc_status !== 'all') q.proc_status = s.proc_status;
  if (s.order_status !== 'all') q.order_status = s.order_status;
  if (s.warehouse !== 'all') q.warehouse = s.warehouse;
  if (s.ship_type !== 'all') q.ship_type = s.ship_type;
  if (s.category !== 'all') q.category = s.category;
  if (s.stale) q.stale = 1;
  if (!(s.sort === 'create_time' && s.dir === 'desc')) { q.sort = s.sort; q.dir = s.dir; }
  if (s.page > 1) q.page = s.page;
  if (s.limit !== LIMIT_DEFAULT) q.limit = s.limit;
  return q;
}
function hasFilter(s) {
  return !!(s.q || s.proc_status !== 'all' || s.order_status !== 'all' || s.warehouse !== 'all' || s.ship_type !== 'all' || s.category !== 'all' || s.stale);
}

function startLive() {
  stopLive();
  liveTimer = setInterval(() => {
    const now = nowSec();
    for (const { node, order } of liveCells) { if (node.isConnected) fillDeadlineCell(node, order, now); }
  }, 30000);
}
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } liveCells.length = 0; }

function fillDeadlineCell(node, o, now) {
  const d = deadlineInfo(o, now);
  node.className = `orders-deadline tone-${d.tone}`;
  node.replaceChildren(
    el('div', { class: 'orders-deadline-main' }, d.tone === 'danger' && !d.done ? icons.clock({ size: 13 }) : null, d.main),
    d.sub ? el('div', { class: 'table-cell-sub' }, d.sub) : null);
}
function deadlineCell(o) {
  const node = el('div');
  fillDeadlineCell(node, o, nowSec());
  liveCells.push({ node, order: o });
  return node;
}

function listColumns() {
  return [
    { key: 'order_sn', label: 'Order', render: (r) => el('div', { class: 'orders-cell-order' },
      el('div', { class: 'row gap-2' }, el('span', { class: 'table-cell-main mono' }, r.order_sn),
        // Badge marketplace: teks penuh di layar lebar, ikon saja (dengan title) di bawah 1440px agar 10 kolom tetap muat.
        el('span', { class: 'orders-mp-full' }, marketplaceBadge(r.marketplace)),
        c.badge({ text: '', icon: r.marketplace === 'tiktok' ? 'tiktok' : 'shopee', tone: r.marketplace === 'tiktok' ? 'dark' : 'warning', size: 'sm', title: fmt.marketplace(r.marketplace || 'shopee'), className: 'orders-mp-mini' })),
      el('div', { class: 'table-cell-sub' }, fmt.datetimeShort(r.create_time))) },
    { key: 'recipient_name', label: 'Penerima', render: (r) => el('div', { class: 'orders-cell-buyer' },
      el('div', { class: 'table-cell-main truncate', title: r.recipient_name || '' }, r.recipient_name || '-'),
      el('div', { class: 'table-cell-sub truncate' }, r.buyer_username ? `@${r.buyer_username}` : '-', r.cod ? ' · COD' : '')) },
    { key: 'items', label: 'Item', render: (r) => {
      const first = Array.isArray(r.items) && r.items.length ? r.items[0] : null;
      if (!first) return el('span', { class: 'text-muted' }, '-');
      const more = Math.max(0, (r.item_count || r.items.length) - 1);
      const sub = [first.model_name ? fmt.truncate(first.model_name, 26) : null, more ? `+${fmt.number(more)} lainnya` : null, `${fmt.number(r.qty_total)} pcs`].filter(Boolean).join(' · ');
      return el('div', { class: 'orders-cell-items' },
        el('div', { class: 'table-cell-main truncate', title: first.item_name || '' }, first.item_name || '-'),
        el('div', { class: 'table-cell-sub truncate', title: sub }, sub));
    } },
    { key: 'shipping_carrier', label: 'Kurir', render: (r) => el('div', { class: 'orders-cell-carrier' },
      el('div', { class: 'truncate', title: r.shipping_carrier || '' }, r.shipping_carrier || '-'),
      r.ship_type ? c.badge({ status: r.ship_type, text: fmt.shipTypeShort(r.ship_type), size: 'sm', icon: r.ship_type === 'instant' ? 'zap' : 'truck' }) : null) },
    { key: 'warehouse_code', label: 'Gudang', render: (r) => warehouseNode(r.warehouse_code) },
    { key: 'sku_category', label: 'Kategori', render: (r) => categoryBadge(r.sku_category) },
    { key: 'ship_by_date', label: 'Batas kirim', render: (r) => deadlineCell(r) },
    { key: 'order_status', label: 'Status Shopee', render: (r) => c.badge({ status: r.order_status, size: 'sm' }) },
    { key: 'proc_status', label: 'Status proses', render: (r) => c.badge({ status: r.proc_status, dot: true }) },
    { key: 'warn', label: '', align: 'center', width: 56, render: (r) => warnIcons(r) },
  ];
}

const listPage = {
  title: 'Pesanan',
  async render(container, params, ctx) {
    listPage.destroy();
    const inst = {};
    listInst = inst;
    const state = stateFromQuery((ctx && ctx.query) || {});
    let counts = null;
    let total = 0;

    // ---------- header ----------
    const metaTotal = el('span', null, icons.orders({ size: 14 }), 'Memuat…');
    const metaSync = el('span', null, icons.sync({ size: 14 }), syncMetaText());
    const refreshBtn = c.button({ label: 'Muat ulang', kind: 'secondary', icon: 'refresh', onClick: () => load() });
    const header = c.pageHeader({
      title: 'Pesanan', subtitle: 'Semua order Shopee hasil sinkronisasi. Cari, saring, lalu buka detail untuk koreksi manual.',
      eyebrow: 'Marketplace · Shopee', meta: [metaTotal, metaSync], actions: [refreshBtn],
    });

    // ---------- toolbar filter ----------
    const search = c.searchInput({ placeholder: 'Cari no. order, pembeli, SKU, atau resi…', value: state.q, onSearch: (q) => { if (q === state.q) return; state.q = q; state.page = 1; load(); } });
    const procSel = c.select({ options: [{ value: 'all', label: 'Semua status proses' }, ...PROC_KEYS.map((v) => ({ value: v, label: fmt.procStatus(v) }))], value: state.proc_status, ariaLabel: 'Status proses', onChange: (v) => { setProc(v); } });
    const orderSel = c.select({ options: [{ value: 'all', label: 'Semua status Shopee' }, ...ORDER_STATUSES.map((v) => ({ value: v, label: fmt.orderStatus(v) }))], value: state.order_status, ariaLabel: 'Status Shopee', onChange: (v) => { state.order_status = v; state.page = 1; load(); } });
    const whSel = c.select({ options: warehouseOptions(true), value: state.warehouse, ariaLabel: 'Gudang', onChange: (v) => { state.warehouse = v; state.page = 1; load(); } });
    const shipSel = c.select({ options: [{ value: 'all', label: 'Semua jenis kirim' }, { value: 'instant', label: fmt.shipType('instant') }, { value: 'regular', label: fmt.shipType('regular') }], value: state.ship_type, ariaLabel: 'Jenis kirim', onChange: (v) => { state.ship_type = v; state.page = 1; load(); } });
    const catSel = c.select({ options: [{ value: 'all', label: 'Semua kategori' }, ...['tg', 'hg', 'mix', 'review'].map((v) => ({ value: v, label: fmt.category(v) }))], value: state.category, ariaLabel: 'Kategori SKU', onChange: (v) => { state.category = v; state.page = 1; load(); } });
    const staleTg = c.toggle({ label: 'PDF tidak sesuai', checked: state.stale, onChange: (v) => { state.stale = v; state.page = 1; load(); } });
    const clearBtn = c.button({ label: 'Hapus filter', kind: 'ghost', size: 'sm', icon: 'x', onClick: () => {
      Object.assign(state, defaultState(), { sort: state.sort, dir: state.dir, limit: state.limit });
      search.value = ''; procSel.value = 'all'; orderSel.value = 'all'; whSel.value = 'all'; shipSel.value = 'all'; catSel.value = 'all'; staleTg.checked = false; tabs.setActive('all');
      load();
    } });
    const filterBar = el('div', { class: 'filter-bar orders-filter' },
      el('div', { class: 'orders-filter-top' }, search, el('div', { class: 'orders-filter-end' }, staleTg, clearBtn)),
      el('div', { class: 'orders-filter-selects' }, procSel, orderSel, whSel, shipSel, catSel));

    // ---------- tabs cepat + sort/limit ----------
    const tabs = c.tabs({ items: PROC_TABS.map((t) => ({ ...t })), active: state.proc_status, onChange: (k) => setProc(k, true) });
    const sortSel = c.select({ options: SORT_OPTIONS, value: `${state.sort}:${state.dir}`, size: 'sm', inline: true, ariaLabel: 'Urutkan', onChange: (v) => { const [s, d] = v.split(':'); state.sort = s; state.dir = d; state.page = 1; load(); } });
    const limitSel = c.select({ options: LIMIT_OPTIONS.map((n) => ({ value: n, label: `${n} / halaman` })), value: state.limit, size: 'sm', inline: true, ariaLabel: 'Jumlah per halaman', onChange: (v) => { state.limit = parseInt(v, 10) || LIMIT_DEFAULT; state.page = 1; load(); } });

    // ---------- tabel ----------
    const emptyBox = el('div');
    const table = c.table({ columns: listColumns(), rows: [], rowKey: 'order_sn', loading: true, empty: emptyBox,
      rowClass: (r) => (r.proc_status === 'cancelled' ? 'is-muted' : null),
      onRowClick: (r) => router.navigate(`#/orders/${enc(r.order_sn)}`) });
    const pager = c.pagination({ page: state.page, total: 0, limit: state.limit, noun: 'order', onChange: (p) => { state.page = p; load(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
    const errorBox = el('div', { hidden: true });
    const tableCard = c.card({ flush: true, className: 'orders-table-card',
      title: 'Daftar order', subtitle: 'Klik baris untuk membuka detail order',
      actions: [sortSel, limitSel],
      body: [el('div', { class: 'orders-tabs-row' }, tabs), errorBox, table, el('div', { class: 'orders-pager' }, pager)] });

    container.replaceChildren(header, filterBar, tableCard);

    function setProc(v, fromTab = false) {
      if (state.proc_status === v) return;
      state.proc_status = v;
      state.page = 1;
      if (fromTab) procSel.value = v; else tabs.setActive(v);
      load();
    }
    function syncHash() {
      const hash = router.buildHash('/orders', queryFromState(state));
      lastListHash = hash;
      if (location.hash !== hash) { try { history.replaceState(null, '', location.pathname + location.search + hash); } catch { /* abaikan */ } }
    }
    function applyCounts(cn) {
      counts = cn || counts;
      if (!counts) return;
      const byProc = counts.byProc || {};
      tabs.setCount('all', counts.total || 0);
      for (const k of PROC_KEYS) tabs.setCount(k, byProc[k] || 0);
    }
    function fillEmpty() {
      emptyBox.replaceChildren();
      if (counts && !counts.total) {
        emptyBox.appendChild(c.emptyState({ icon: 'inbox', title: 'Belum ada order', text: 'Jalankan sinkronisasi untuk menarik order Siap Kirim dari Shopee.', size: 'sm',
          action: ctx && ctx.layout && ctx.layout.syncNow ? { label: 'Sync sekarang', icon: 'sync', onClick: async () => { await ctx.layout.syncNow(); load(); } } : null }));
      } else {
        emptyBox.appendChild(c.emptyState({ icon: 'search', title: 'Tidak ada order yang cocok', text: 'Coba ubah kata kunci atau longgarkan filter.', size: 'sm',
          action: hasFilter(state) ? { label: 'Hapus filter', kind: 'secondary', icon: 'x', onClick: () => clearBtn.click() } : null }));
      }
    }
    async function load() {
      if (listInst !== inst) return; // halaman sudah ditinggalkan (mis. debounce pencarian menembak setelah pindah ke detail)
      const seq = ++listSeq;
      syncHash();
      clearBtn.hidden = !hasFilter(state);
      errorBox.hidden = true;
      table.hidden = false;
      liveCells.length = 0;
      table.update({ loading: true });
      refreshBtn.setLoading(true);
      try {
        const query = { page: state.page, limit: state.limit, sort: state.sort, dir: state.dir, q: state.q || undefined,
          proc_status: state.proc_status !== 'all' ? state.proc_status : undefined, order_status: state.order_status !== 'all' ? state.order_status : undefined,
          warehouse: state.warehouse !== 'all' ? state.warehouse : undefined, ship_type: state.ship_type !== 'all' ? state.ship_type : undefined,
          category: state.category !== 'all' ? state.category : undefined, stale: state.stale ? 1 : undefined };
        const r = await api.get('/api/orders', { query });
        if (seq !== listSeq) return;
        total = r.total || 0;
        applyCounts(r.counts);
        fillEmpty();
        table.update({ rows: r.items || [] });
        pager.set({ page: r.page || state.page, total, limit: r.limit || state.limit });
        metaTotal.replaceChildren(icons.orders({ size: 14 }), hasFilter(state) ? `${fmt.number(total)} dari ${fmt.number((counts && counts.total) || total)} order` : `${fmt.number(total)} order tersinkron`);
        metaSync.replaceChildren(icons.sync({ size: 14 }), syncMetaText());
        // Halaman di luar jangkauan (mis. filter berubah) → kembali ke halaman terakhir yang ada
        const pages = Math.max(1, Math.ceil(total / state.limit));
        if (state.page > pages) { state.page = pages; load(); }
      } catch (e) {
        if (seq !== listSeq) return;
        if (e && e.status === 401) return;
        table.update({ rows: [] });
        emptyBox.replaceChildren();
        table.hidden = true; // tabel kosong tanpa isi hanya menyisakan header menganga di bawah alert
        errorBox.hidden = false;
        errorBox.replaceChildren(c.alert({ tone: 'danger', title: 'Gagal memuat daftar order', text: api.errorMessage(e), actions: c.button({ label: 'Coba lagi', kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => load() }) }));
      } finally {
        if (seq === listSeq) refreshBtn.setLoading(false);
      }
    }

    clearBtn.hidden = !hasFilter(state);
    // Status sync & daftar gudang dimuat layout/main secara asinkron — perbarui meta & opsi select saat tiba.
    listUnsubs.push(store.subscribe('sync', () => { if (listInst === inst) metaSync.replaceChildren(icons.sync({ size: 14 }), syncMetaText()); }));
    listUnsubs.push(store.subscribe('settings', () => { if (listInst === inst) whSel.setOptions(warehouseOptions(true), state.warehouse); }));
    startLive();
    await load();
  },
  destroy() {
    listSeq++;
    listInst = null;
    for (const u of listUnsubs.splice(0)) { try { u(); } catch { /* abaikan */ } }
    stopLive();
  },
};

function syncMetaText() {
  const s = store.sync;
  const shopee = s && s.marketplaces && s.marketplaces.shopee;
  if (!shopee) return 'Status sync belum diketahui';
  if (!shopee.connected) return 'Toko Shopee belum terhubung';
  return shopee.last_ok_at ? `Sync terakhir ${fmt.relative(shopee.last_ok_at)}` : 'Belum pernah sync';
}

// ============================================================================
// Halaman detail (#/orders/:sn)
// ============================================================================
let detailSeq = 0;
let detailUnsubs = [];           // langganan store milik kartu detail (dilepas saat render ulang / destroy)

function detailSkeleton(sn) {
  return el('div', null,
    c.pageHeader({ title: sn, back: { label: 'Kembali ke Pesanan', href: lastListHash }, subtitle: 'Memuat detail order…' }),
    el('div', { class: 'split' },
      el('div', { class: 'stack' }, c.card({ body: c.skeleton(6) }), c.card({ body: c.skeleton(3, { kind: 'table' }) })),
      el('div', { class: 'stack' }, c.card({ tone: 'gradient', body: c.skeleton(4) }), c.card({ tone: 'dark', body: c.skeleton(2, { kind: 'list' }) }))));
}

function section(title, rows) {
  return el('div', { class: 'orders-info-section' }, el('div', { class: 'label mb-2' }, title), c.kv(rows));
}

function phoneTypeNode(o) {
  const pt = o.phone_type || {};
  const ov = o.overrides || {};
  if (pt.value) {
    const src = ov.phone_type ? 'override' : pt.source;
    return el('span', { class: 'row gap-2 wrap' }, el('span', { class: 'fw-600' }, pt.value), src ? c.badge({ text: PHONE_SOURCE[src] || src, tone: src === 'override' ? 'primary' : 'neutral', size: 'sm' }) : null);
  }
  if (pt.required) return c.badge({ text: 'Belum ditulis', tone: 'danger', size: 'sm', dot: true });
  return el('span', { class: 'text-muted' }, 'Tidak diperlukan');
}

function infoCard(o) {
  const ov = o.overrides || {};
  const dl = deadlineInfo(o);
  const overrideTag = () => c.badge({ text: 'koreksi manual', tone: 'primary', size: 'sm', icon: 'edit' });
  const body = el('div', { class: 'orders-info-grid' },
    section('Order', [
      ['No. order', c.copyable(o.order_sn)],
      ['Marketplace', marketplaceBadge(o.marketplace, 'md')],
      ['Status Shopee', c.badge({ status: o.order_status })],
      ['Dibuat', o.create_time ? `${fmt.datetime(o.create_time)} (${fmt.relative(o.create_time)})` : '-'],
      ['Diperbarui', o.update_time ? `${fmt.datetime(o.update_time)} (${fmt.relative(o.update_time)})` : '-'],
      ['Batas kirim', o.ship_by_date ? el('span', { class: `orders-deadline-inline tone-${dl.tone}` }, fmt.datetime(o.ship_by_date), dl.done ? null : el('span', { class: 'orders-deadline-tag' }, `${dl.main}`)) : '-'],
      ['Total', el('span', { class: 'fw-600' }, fmt.currency(o.total_amount, o.currency || 'IDR'))],
      ['Pembayaran', o.cod ? c.badge({ text: 'COD (bayar di tempat)', tone: 'warning', size: 'sm' }) : 'Non-COD'],
    ]),
    section('Pengiriman', [
      ['Kurir', el('span', { class: 'row gap-2 wrap' }, o.shipping_carrier || '-', o.ship_type ? c.badge({ status: o.ship_type, text: fmt.shipTypeShort(o.ship_type), size: 'sm', icon: o.ship_type === 'instant' ? 'zap' : 'truck' }) : null)],
      ['Gudang', el('span', { class: 'row gap-2 wrap' }, warehouseNode(o.warehouse_code), ov.warehouse_code ? overrideTag() : null)],
      ['Kategori SKU', el('span', { class: 'row gap-2 wrap' }, categoryBadge(o.sku_category), o.sku_category ? el('span', { class: 'text-muted text-sm' }, fmt.category(o.sku_category)) : null, ov.sku_category ? overrideTag() : null)],
      ['Tipe HP', phoneTypeNode(o)],
      ['No. resi', o.tracking_number ? c.copyable(o.tracking_number) : el('span', { class: 'text-muted' }, 'Belum ada')],
    ]),
    section('Pembeli & penerima', [
      ['Username', o.buyer_username ? `@${o.buyer_username}` : '-'],
      ['Penerima', el('span', { class: 'fw-600' }, o.recipient_name || '-')],
      ['Telepon', o.recipient_phone || '-'],
      ['Alamat', o.recipient_address || '-'],
    ]),
    section('Catatan', [
      ['Catatan pembeli', o.note ? el('span', { class: 'orders-note' }, o.note) : el('span', { class: 'text-muted' }, 'Tidak ada')],
      ['Pesan ke penjual', o.message_to_seller ? el('span', { class: 'orders-note' }, o.message_to_seller) : el('span', { class: 'text-muted' }, 'Tidak ada')],
      ['Catatan staf', ov.note ? el('span', { class: 'orders-note' }, ov.note) : el('span', { class: 'text-muted' }, 'Tidak ada')],
    ]));
  return c.card({ title: 'Informasi order', subtitle: 'Data hasil sinkronisasi Shopee dan klasifikasi otomatis', icon: 'orders', body });
}

function itemsCard(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const table = c.table({ compact: true, rowKey: (_r, i) => i,
    columns: [
      { key: 'no', label: '#', width: 44, render: (_r, i) => el('span', { class: 'text-muted' }, String(i + 1)) },
      { key: 'item_name', label: 'Produk', render: (r) => el('div', { class: 'orders-item-name' }, el('div', { class: 'table-cell-main wrap-cell' }, r.item_name || '-'), r.model_name ? el('div', { class: 'table-cell-sub wrap-cell' }, r.model_name) : null) },
      { key: 'sku', label: 'SKU', render: (r) => el('div', null, el('div', { class: 'mono text-sm' }, r.model_sku || r.item_sku || '-'), r.model_sku && r.item_sku && r.model_sku !== r.item_sku ? el('div', { class: 'table-cell-sub mono' }, r.item_sku) : null) },
      { key: 'category', label: 'Kategori', render: (r) => (r.category ? categoryBadge(r.category, 'sm') : c.badge({ text: 'Tidak dikenali', tone: 'warning', size: 'sm' })) },
      { key: 'phone_type', label: 'Tipe HP', render: (r) => (r.phone_type ? r.phone_type : r.phone_type_required ? c.badge({ text: 'Belum ditulis', tone: 'danger', size: 'sm' }) : el('span', { class: 'text-muted' }, '-')) },
      { key: 'qty', label: 'Qty', align: 'right', render: (r) => el('span', { class: 'fw-600 tabular' }, fmt.number(r.qty)) },
    ],
    rows: items, empty: { icon: 'box', title: 'Tidak ada item', text: 'Order ini tidak memuat item.' } });
  return c.card({ title: 'Item', subtitle: `${fmt.count(o.item_count || items.length, 'item')} · ${fmt.count(o.qty_total || 0, 'pcs')}`, icon: 'box', flush: true, body: table });
}

function checkRow(tone, ic, title, message, code) {
  return el('div', { class: `orders-check tone-${tone}` },
    el('span', { class: 'orders-check-icon' }, icons.get(ic, { size: 16 })),
    el('div', { class: 'min-w-0 flex-1' }, el('div', { class: 'fw-600' }, title), message ? el('div', { class: 'text-sm text-muted' }, message) : null),
    code ? el('code', { class: 'orders-check-code' }, code) : null);
}

function validationCard(o) {
  const v = o.validation || {};
  const holds = (v.holds || []).filter((h) => h && h.code !== 'WAREHOUSE_FILTER');
  const warns = (v.warnings || []).filter(Boolean);
  const flags = v.flags || {};
  const ov = o.overrides || {};
  const body = el('div', { class: 'stack' });
  if (!holds.length && !warns.length) body.appendChild(c.alert({ tone: 'success', title: 'Tidak ada masalah', text: 'Order lolos semua pengecekan otomatis dan siap diproses pada part berikutnya.' }));
  if (holds.length) body.appendChild(el('div', { class: 'orders-check-group' }, el('div', { class: 'label mb-2' }, `Ditahan · ${fmt.number(holds.length)}`), el('div', { class: 'orders-check-list' }, holds.map((h) => checkRow('danger', 'alertCircle', fmt.holdCode(h.code), h.message, h.code)))));
  if (warns.length) body.appendChild(el('div', { class: 'orders-check-group' }, el('div', { class: 'label mb-2' }, `Peringatan · ${fmt.number(warns.length)}`), el('div', { class: 'orders-check-list' }, warns.map((w) => checkRow('warning', 'alert', fmt.warningCode(w.code), w.message, w.code)))));
  const chips = [];
  if (flags.tipe_belum_ditulis) chips.push(c.badge({ text: 'TIPE BELUM DITULIS', tone: 'danger', solid: true, icon: 'phone', title: 'Label PDF diberi stempel merah besar' }));
  if (flags.needs_review) chips.push(c.badge({ text: 'Perlu diperiksa staf', tone: 'warning', dot: true }));
  if (ov.force_process) chips.push(c.badge({ text: 'Paksa proses aktif', tone: 'primary', icon: 'zap' }));
  if (ov.excluded) chips.push(c.badge({ text: 'Dikeluarkan dari proses', tone: 'neutral', icon: 'x' }));
  // Hitung mundur dihitung langsung dari ship_by_date (bukan snapshot flags.deadline_hours_left saat validasi) agar
  // konsisten dengan header/panel status; order yang sudah diproses/batal/terkirim tidak perlu chip ini.
  const dl = deadlineInfo(o);
  if (o.ship_by_date && !dl.done) chips.push(c.badge({ text: `Batas kirim ${dl.main}`, tone: dl.tone === 'danger' ? 'danger' : dl.tone === 'warning' ? 'warning' : 'neutral', icon: 'clock' }));
  if (o.pdf_stale) chips.push(c.badge({ status: 'stale', text: 'PDF tidak sesuai, perlu dibuat ulang', icon: 'pdf' }));
  if (chips.length) body.appendChild(el('div', null, el('div', { class: 'label mb-2' }, 'Penanda'), el('div', { class: 'chip-list' }, chips)));
  return c.card({ title: 'Validasi', subtitle: 'Hasil pengecekan otomatis saat klasifikasi terakhir', icon: 'shield', body });
}

function overridesCard(o, { onSaved }) {
  const ov = o.overrides || {};
  const busy = o.proc_status === 'processing';
  const catSel = c.select({ options: [{ value: '', label: 'Otomatis (ikuti klasifikasi SKU)' }, ...['tg', 'hg', 'mix'].map((v) => ({ value: v, label: fmt.category(v) }))], value: ov.sku_category || '', disabled: busy });
  const whSel = c.select({ options: [{ value: '', label: 'Otomatis (ikuti lokasi produk)' }, ...warehouseOptions(false)], value: ov.warehouse_code || '', disabled: busy });
  const phoneInp = c.input({ placeholder: 'mis. iPhone 15 Pro Max', value: ov.phone_type || '', icon: 'phone', maxlength: 100, disabled: busy });
  const forceTg = c.toggle({ label: 'Paksa proses', checked: !!ov.force_process, disabled: busy });
  const exclTg = c.toggle({ label: 'Keluarkan dari proses', checked: !!ov.excluded, disabled: busy });
  const noteTa = c.textarea({ placeholder: 'Catatan staf untuk order ini (opsional, maks. 500 karakter)…', value: ov.note || '', rows: 3, maxlength: 500, disabled: busy });
  const fCat = c.field({ label: 'Kategori SKU', input: catSel, hint: 'Mengganti hasil klasifikasi otomatis untuk pengelompokan PDF.' });
  const fWh = c.field({ label: 'Gudang', input: whSel, hint: 'Gunakan bila lokasi produk Shopee tidak terpetakan.' });
  const fPhone = c.field({ label: 'Tipe HP', input: phoneInp, hint: 'Mengisi tipe HP bila pembeli tidak menulisnya di variasi / catatan.' });
  const fNote = c.field({ label: 'Catatan staf', input: noteTa });
  // Bukan c.field(): field() memasang `for` label ke input pertama di dalamnya, sehingga klik teks "Opsi proses" akan men-toggle "Paksa proses".
  const toggles = el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Opsi proses'),
    el('div', { class: 'stack-sm' }, forceTg, el('div', { class: 'field-hint' }, 'Abaikan hold "Tipe HP belum ditulis" dan "SKU tidak dikenali" (tetap ada peringatan).'), exclTg, el('div', { class: 'field-hint' }, 'Order tidak dimasukkan ke grup PDF mana pun (tampil di tab "Dikeluarkan").')));
  // Daftar gudang dari setting bisa tiba setelah halaman dirender (dimuat main.js di latar belakang).
  detailUnsubs.push(store.subscribe('settings', () => { if (whSel.isConnected) whSel.setOptions([{ value: '', label: 'Otomatis (ikuti lokasi produk)' }, ...warehouseOptions(false)], whSel.value); }));

  const current = () => ({ sku_category: ov.sku_category || '', warehouse_code: ov.warehouse_code || '', phone_type: ov.phone_type || '', note: ov.note || '', force_process: !!ov.force_process, excluded: !!ov.excluded });
  const values = () => ({ sku_category: catSel.value, warehouse_code: whSel.value, phone_type: phoneInp.value.trim(), note: noteTa.value.trim(), force_process: forceTg.checked, excluded: exclTg.checked });
  const buildPatch = () => {
    const cur = current(); const next = values(); const patch = {};
    // Nilai kosong / toggle mati dikirim null → server menghapus key-nya (bukan menyimpan `false` sebagai "koreksi").
    for (const k of Object.keys(next)) { if (next[k] !== cur[k]) patch[k] = next[k] === true ? true : (next[k] || null); }
    return patch;
  };
  const saveBtn = c.button({ label: 'Simpan koreksi', kind: 'primary', icon: 'save', disabled: busy, onClick: async () => {
    const patch = buildPatch();
    if (!Object.keys(patch).length) { toast.info('Tidak ada perubahan untuk disimpan.', { timeout: 2000 }); return; }
    if (patch.phone_type && patch.phone_type.length > 100) { fPhone.setError('Tipe HP maksimal 100 karakter'); return; }
    saveBtn.setLoading(true);
    try {
      const r = await api.patch(`/api/orders/${enc(o.order_sn)}/overrides`, patch);
      toast.success('Koreksi disimpan. Order diklasifikasi dan divalidasi ulang.');
      onSaved(r && r.order);
    } catch (e) { reportError(e, 'Gagal menyimpan koreksi'); saveBtn.setLoading(false); }
  } });
  const activeKeys = activeOverrideKeys(ov);
  const hasAny = activeKeys.length > 0;
  const clearBtn = c.button({ label: 'Hapus semua koreksi', kind: 'ghost', icon: 'trash', disabled: busy, onClick: async () => {
    const ok = await modal.confirm({ title: 'Hapus semua koreksi manual?', message: 'Order akan kembali mengikuti hasil klasifikasi otomatis (kategori, gudang, tipe HP, opsi proses, dan catatan staf dihapus).', confirmLabel: 'Ya, hapus', danger: true });
    if (!ok) return;
    const patch = {}; for (const k of Object.keys(ov)) patch[k] = null;
    clearBtn.setLoading(true);
    try { const r = await api.patch(`/api/orders/${enc(o.order_sn)}/overrides`, patch); toast.success('Semua koreksi dihapus.'); onSaved(r && r.order); } catch (e) { reportError(e, 'Gagal menghapus koreksi'); clearBtn.setLoading(false); }
  } });
  if (!hasAny) clearBtn.hidden = true;

  const body = el('div', { class: 'stack' },
    busy ? c.alert({ tone: 'info', title: 'Order sedang diproses', text: 'Koreksi bisa diubah lagi setelah run selesai.' }) : null,
    el('div', { class: 'form-grid' }, fCat, fWh, fPhone, toggles, el('div', { class: 'span-2' }, fNote)),
    el('div', { class: 'form-actions orders-form-actions' }, clearBtn, saveBtn));
  return c.card({ title: 'Koreksi manual', subtitle: hasAny ? `${fmt.number(activeKeys.length)} koreksi aktif — mengganti hasil klasifikasi otomatis` : 'Mengganti hasil klasifikasi otomatis untuk order ini', icon: 'edit', body,
    actions: hasAny ? c.badge({ text: 'Ada koreksi', tone: 'primary', icon: 'edit' }) : null });
}

function describeProc(o) {
  switch (o.proc_status) {
    case 'unprocessed': return 'Menunggu diproses pada part berikutnya.';
    case 'review': return 'Ada hold yang perlu diperiksa staf sebelum bisa diproses.';
    case 'processing': return 'Sedang berjalan di run proses yang aktif.';
    case 'processed': return `Diproses ${o.processed_at ? fmt.relative(o.processed_at) : ''}${o.proc_run_id ? ` di run #${o.proc_run_id}` : ''}.`;
    case 'failed': return 'Proses terakhir gagal — lihat pesan error di bawah, lalu proses ulang.';
    case 'cancelled': return 'Order dibatalkan di Shopee dan tidak akan diproses.';
    default: return '';
  }
}
const PROC_ICON = { unprocessed: 'inbox', review: 'alert', processing: 'loader', processed: 'checkCircle', failed: 'xCircle', cancelled: 'x' };

function statusPanel(o, { onReclassify, onReset }) {
  const dl = deadlineInfo(o);
  const hero = el('div', { class: 'orders-status-hero' },
    el('span', { class: `orders-status-hero-icon is-${o.proc_status}` }, icons.get(PROC_ICON[o.proc_status] || 'help', { size: 24 })),
    el('div', { class: 'min-w-0' },
      el('div', { class: 'orders-status-hero-label' }, 'Status proses'),
      el('div', { class: 'orders-status-hero-value' }, fmt.procStatus(o.proc_status)),
      el('div', { class: 'orders-status-hero-sub' }, describeProc(o))));
  const runValue = o.proc_run_id ? el('a', { class: 'orders-glass-link', href: `#/history/${enc(o.proc_run_id)}`, title: 'Buka riwayat run' }, `Run #${o.proc_run_id}`, icons.arrowRight({ size: 15 })) : '-';
  const tiles = el('div', { class: 'glass-grid orders-status-tiles' },
    c.glassTile({ label: 'Run terkait', value: runValue, sub: o.proc_run_id ? 'Lihat riwayat run' : 'Belum pernah diproses', icon: 'history' }),
    c.glassTile({ label: 'Diproses', value: o.processed_at ? fmt.time(o.processed_at) : '-', sub: o.processed_at ? fmt.date(o.processed_at, 'weekday') : 'Belum diproses', icon: 'checkCircle' }),
    c.glassTile({ label: 'Batas kirim', value: dl.main, sub: dl.sub || '—', icon: 'clock', className: dl.tone === 'danger' && !dl.done ? 'is-urgent' : null }),
    c.glassTile({ label: 'No. resi', value: o.tracking_number ? el('span', { class: 'mono' }, o.tracking_number) : '-', sub: o.tracking_number ? (o.shipping_carrier || 'Resi dari Shopee') : 'Belum ada resi', icon: 'truck' }));
  const notes = [];
  if (o.last_error) notes.push(el('div', { class: 'orders-glass-alert tone-danger', role: 'alert' }, icons.xCircle({ size: 18 }), el('div', { class: 'min-w-0' }, el('div', { class: 'fw-700' }, 'Error terakhir'), el('div', { class: 'text-sm break' }, o.last_error))));
  if (o.pdf_stale) notes.push(el('div', { class: 'orders-glass-alert tone-warning' }, icons.pdf({ size: 18 }), el('div', { class: 'min-w-0' }, el('div', { class: 'fw-700' }, 'PDF tidak sesuai, perlu dibuat ulang'), el('div', { class: 'text-sm' }, 'Order berubah atau dibatalkan setelah PDF dibuat. Buat ulang PDF dari halaman Riwayat.'), o.proc_run_id ? el('a', { class: 'orders-glass-link mt-1', href: `#/history/${enc(o.proc_run_id)}` }, 'Buka run', icons.arrowRight({ size: 14 })) : null)));
  const reclassBtn = c.button({ label: 'Klasifikasi ulang', kind: 'glass', size: 'sm', icon: 'refresh', disabled: o.proc_status === 'processing', onClick: async () => { reclassBtn.setLoading(true); try { await onReclassify(); } finally { reclassBtn.setLoading(false); } } });
  const actions = el('div', { class: 'orders-status-actions' }, reclassBtn);
  if (store.isAdmin) {
    const canReset = o.proc_status !== 'processing' && !(o.proc_status === 'unprocessed' && !o.proc_run_id);
    const resetBtn = c.button({ label: 'Reset ke belum diproses', kind: 'glass', size: 'sm', icon: 'undo', disabled: !canReset, title: canReset ? 'Kembalikan order ke status Belum diproses (admin)' : 'Order sudah berstatus Belum diproses', onClick: async () => { resetBtn.setLoading(true); try { await onReset(); } finally { resetBtn.setLoading(false); } } });
    actions.appendChild(resetBtn);
  }
  return el('div', { class: 'card card-gradient orders-status' },
    el('div', { class: 'card-header' },
      el('div', { class: 'row gap-3 min-w-0' }, c.iconBox({ icon: 'process', tone: 'glass' }), el('div', { class: 'card-header-text' }, el('div', { class: 'card-title' }, 'Pemrosesan'), el('div', { class: 'card-subtitle' }, 'Hasil proses order di aplikasi'))),
      el('div', { class: 'card-actions' }, c.badge({ status: o.proc_status, className: 'badge-glass', dot: true }))),
    el('div', { class: 'card-body stack' }, hero, tiles, notes.length ? el('div', { class: 'stack-sm' }, notes) : null, actions),
    el('div', { class: 'card-footer text-sm orders-status-footer' }, icons.info({ size: 14 }), 'PDF berhasil ≠ order sudah dikirim. Pastikan resi diserahkan ke kurir.'));
}

function pdfCard(pdfs, o) {
  const list = Array.isArray(pdfs) ? pdfs : [];
  const items = list.map((p) => {
    const dl = c.button({ label: 'Unduh', kind: 'glass', size: 'sm', icon: 'download', href: `/api/history/pdfs/${enc(p.id)}/download`, title: `Unduh ${p.file_name}` });
    const view = c.iconButton({ icon: 'eye', kind: 'glass', size: 'sm', title: 'Lihat di tab baru', href: `/api/history/pdfs/${enc(p.id)}/view` });
    view.target = '_blank'; view.rel = 'noopener';
    return {
      key: p.id, icon: p.kind === 'productlist' ? 'list' : 'pdf', title: p.file_name,
      subtitle: [fmt.pdfKind(p.kind), fmt.part(p.part), fmt.warehouseShort(p.warehouse_code), fmt.count(p.order_count, 'order'), p.page_count ? fmt.count(p.page_count, 'hal.') : null, p.size_bytes ? fmt.fileSize(p.size_bytes) : null, fmt.datetime(p.created_at)].filter(Boolean).join(' · '),
      badge: el('span', { class: 'orders-pdf-actions' }, c.badge({ status: p.status, size: 'sm', title: p.stale_reason || undefined, dot: true }), dl, view),
    };
  });
  const body = c.listPanel({ items, empty: c.emptyState({ icon: 'pdf', title: 'Belum ada PDF', text: 'PDF label akan muncul di sini setelah order diproses.', size: 'sm' }) });
  return c.card({ tone: 'dark', title: 'PDF yang memuat order ini', subtitle: list.length ? `${fmt.count(list.length, 'berkas')} · Run #${[...new Set(list.map((p) => p.run_id))].join(', #')}` : 'Label AWB dan Product List', icon: 'pdf', body,
    actions: o.proc_run_id ? c.button({ label: 'Riwayat', kind: 'glass', size: 'sm', icon: 'history', href: `#/history/${enc(o.proc_run_id)}` }) : null });
}

function runHistoryCard(runOrders) {
  const list = Array.isArray(runOrders) ? runOrders : [];
  const toneOf = (st) => (st === 'ok' ? 'success' : st === 'failed' ? 'danger' : st === 'pending' || st === 'running' ? 'primary' : undefined);
  const iconOf = (st) => (st === 'ok' ? 'check' : st === 'failed' ? 'x' : st === 'skipped' ? 'minus' : 'loader');
  const items = list.map((r) => ({
    title: el('span', { class: 'row gap-2 wrap' }, el('a', { href: `#/history/${enc(r.run_id)}` }, `Run #${r.run_id}`), el('span', { class: 'text-muted fw-500' }, `${fmt.part(r.run_part)} · ${fmt.runKind(r.run_kind)}${r.run_user_name ? ` · ${r.run_user_name}` : ''}`)),
    sub: el('span', { class: 'orders-run-sub' },
      c.badge({ status: r.status, text: fmt.runOrderStatus(r.status), size: 'sm', dot: true }),
      el('span', null, `Tahap: ${fmt.stage(r.stage)}`),
      [r.ship_type ? fmt.shipTypeShort(r.ship_type) : null, r.sku_category ? fmt.categoryShort(r.sku_category) : null, r.warehouse_code ? fmt.warehouseShort(r.warehouse_code) : null].filter(Boolean).length ? el('span', { class: 'text-muted' }, [r.ship_type ? fmt.shipTypeShort(r.ship_type) : null, r.sku_category ? fmt.categoryShort(r.sku_category) : null, r.warehouse_code ? fmt.warehouseShort(r.warehouse_code) : null].filter(Boolean).join(' · ')) : null,
      r.flags && r.flags.tipe_belum_ditulis ? c.badge({ text: 'Tipe belum ditulis', tone: 'danger', size: 'sm' }) : null,
      r.error ? el('span', { class: 'text-danger break orders-run-error' }, r.error) : null),
    tone: toneOf(r.status), icon: iconOf(r.status), time: fmt.datetimeShort(r.updated_at),
  }));
  const body = items.length ? c.timeline(items) : c.emptyState({ icon: 'history', title: 'Belum pernah ikut run', text: 'Riwayat tahapan proses akan muncul setelah order diproses.', size: 'sm' });
  return c.card({ title: 'Riwayat proses', subtitle: items.length ? `${fmt.count(items.length, 'catatan run')} — terbaru di atas` : 'Tahapan per run yang pernah memuat order ini', icon: 'history', body });
}

function rawCard(raw) {
  const text = raw ? JSON.stringify(raw, null, 2) : '';
  const pre = el('pre', { class: 'orders-raw-pre' }, text || 'Data mentah tidak tersedia.');
  const summary = el('summary', { class: 'orders-raw-summary' }, icons.chevronRight({ size: 16, class: 'orders-raw-chev' }), 'Tampilkan JSON get_order_detail', el('span', { class: 'text-muted text-sm ml-auto' }, text ? fmt.fileSize(new Blob([text]).size) : ''));
  const details = el('details', { class: 'orders-raw' }, summary, pre);
  const copyBtn = c.button({ label: 'Salin JSON', kind: 'secondary', size: 'sm', icon: 'copy', disabled: !text, onClick: async () => { try { await navigator.clipboard.writeText(text); toast.success('JSON disalin ke clipboard', { timeout: 1800 }); } catch { toast.error('Tidak bisa menyalin'); } } });
  return c.card({ title: 'Data mentah Shopee', subtitle: 'Respons get_order_detail apa adanya (untuk pemeriksaan)', icon: 'database', body: details, actions: copyBtn });
}

function releaseDetailSubs() { for (const u of detailUnsubs.splice(0)) { try { u(); } catch { /* abaikan */ } } }

function renderDetail(container, data, reload) {
  releaseDetailSubs();
  const o = data.order;
  const runOrders = data.run_orders || [];
  const pdfs = data.pdfs || [];
  const dl = deadlineInfo(o);
  const header = c.pageHeader({
    back: { label: 'Kembali ke Pesanan', href: lastListHash },
    title: el('span', { class: 'row gap-3 wrap' }, el('span', { class: 'mono' }, o.order_sn), c.badge({ status: o.proc_status, dot: true, size: 'lg' })),
    subtitle: `${o.recipient_name || 'Tanpa nama penerima'}${o.buyer_username ? ` (@${o.buyer_username})` : ''} · ${o.shipping_carrier || 'Kurir tidak diketahui'} · ${fmt.currency(o.total_amount, o.currency || 'IDR')}`,
    meta: [
      el('span', null, marketplaceBadge(o.marketplace), c.badge({ status: o.order_status, size: 'sm' })),
      el('span', null, icons.calendar({ size: 14 }), `Dibuat ${fmt.datetime(o.create_time)}`),
      el('span', { class: dl.tone === 'danger' && !dl.done ? 'text-danger fw-600' : null }, icons.clock({ size: 14 }), dl.done ? `Batas kirim ${fmt.datetimeShort(o.ship_by_date)}` : `Batas kirim ${dl.main}`),
      el('span', null, icons.warehouse({ size: 14 }), fmt.warehouse(o.warehouse_code)),
      o.ship_type ? el('span', null, icons.get(o.ship_type === 'instant' ? 'zap' : 'truck', { size: 14 }), fmt.shipType(o.ship_type)) : null,
    ].filter(Boolean),
    actions: [c.button({ label: 'Muat ulang', kind: 'secondary', icon: 'refresh', onClick: () => reload() })],
  });
  const onSaved = () => reload();
  const onReclassify = async () => {
    try { await api.post(`/api/orders/${enc(o.order_sn)}/reclassify`); toast.success('Order diklasifikasi dan divalidasi ulang.'); await reload(); } catch (e) { reportError(e, 'Gagal mengklasifikasi ulang'); }
  };
  const onReset = async () => {
    const ok = await modal.confirm({ title: 'Reset order ke belum diproses?',
      message: el('div', { class: 'stack-sm' }, el('p', `Order ${o.order_sn} akan kembali ke status "Belum diproses" dan keterkaitannya dengan run #${o.proc_run_id || '-'} dihapus, sehingga bisa diproses lagi di run berikutnya.`), el('p', { class: 'text-sm text-muted' }, 'PDF yang sudah dibuat tidak dihapus. Shipment yang sudah diatur di Shopee juga tidak dibatalkan.')),
      confirmLabel: 'Ya, reset', danger: true });
    if (!ok) return;
    try { await api.post(`/api/orders/${enc(o.order_sn)}/reset`); toast.success('Order dikembalikan ke status Belum diproses.'); await reload(); } catch (e) { reportError(e, 'Gagal mereset order'); }
  };
  const left = el('div', { class: 'stack' }, infoCard(o), itemsCard(o), validationCard(o), overridesCard(o, { onSaved }));
  const right = el('div', { class: 'stack' }, statusPanel(o, { onReclassify, onReset }), pdfCard(pdfs, o), runHistoryCard(runOrders), rawCard(data.raw));
  container.replaceChildren(header, el('div', { class: 'split orders-detail' }, left, right));
}

const detailPage = {
  title: (route) => `Order ${(route && route.params && route.params.sn) || ''}`,
  async render(container, params) {
    detailPage.destroy();
    const sn = params && params.sn ? String(params.sn) : '';
    const load = async (silent = false) => {
      const seq = ++detailSeq;
      const keepScroll = silent ? window.scrollY : null;
      if (!silent) container.replaceChildren(detailSkeleton(sn));
      try {
        const d = await api.get(`/api/orders/${enc(sn)}`);
        if (seq !== detailSeq) return;
        if (!d || !d.order) throw new Error('Respons detail order tidak valid');
        renderDetail(container, d, () => load(true));
        if (keepScroll !== null) window.scrollTo({ top: keepScroll });
      } catch (e) {
        if (seq !== detailSeq || (e && e.status === 401)) return;
        const notFound = e && e.status === 404;
        container.replaceChildren(
          c.pageHeader({ title: sn || 'Order', back: { label: 'Kembali ke Pesanan', href: lastListHash } }),
          el('div', { class: 'card page-placeholder' }, c.emptyState({ icon: notFound ? 'search' : 'alert', title: notFound ? 'Order tidak ditemukan' : 'Gagal memuat order',
            text: notFound ? `Order ${sn} tidak ada di data lokal. Mungkin belum tersinkron atau nomor order salah.` : api.errorMessage(e),
            action: el('div', { class: 'row gap-2 wrap center' }, c.button({ label: 'Ke daftar pesanan', kind: 'primary', icon: 'arrowLeft', href: lastListHash }), notFound ? null : c.button({ label: 'Coba lagi', kind: 'secondary', icon: 'refresh', onClick: () => load() })) })));
      }
    };
    await load();
  },
  destroy() { detailSeq++; releaseDetailSubs(); },
};

// ============================================================================
// Registrasi rute
// ============================================================================
router.register('#/orders', listPage);
router.register('#/orders/:sn', detailPage);

export const title = 'Pesanan';
export function render(container, params, ctx) { return params && params.sn ? detailPage.render(container, params, ctx) : listPage.render(container, params, ctx); }
export function destroy() { listPage.destroy(); detailPage.destroy(); }
export const page = { title, render, destroy };
export default page;
