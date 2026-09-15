/**
 * Halaman Process Order (#/process) — halaman utama pemrosesan.
 *
 * Alur: GET /api/process/preview?part&warehouse → tampilkan grup PDF / ditahan / perlu diperiksa / dikeluarkan /
 * product list → koreksi manual (PATCH /api/orders/:sn/overrides) → POST /api/process/run → modal progres
 * (polling GET /api/process/runs/:id/progress tiap 1,5 dtk) → hasil (PDF, order gagal, buat ulang, riwayat).
 * Saat halaman dibuka, GET /api/process/active → bila ada run berjalan, modal progres langsung dibuka.
 */
import { api, router, store, el, mount, toast, modal, fmt, components as c, icons, classNames, reportError } from '../core.js';

export const title = 'Process Order';

const POLL_MS = 1500;
const PARTS = ['p1', 'p2', 'p3'];
const TABS = ['groups', 'held', 'review', 'excluded', 'products'];
const STAGE_LABEL = { shipping: 'Mengatur pengiriman di Shopee', documents: 'Meminta & mengunduh dokumen AWB', pdf: 'Menggabung PDF per kategori', done: 'Selesai' };
const DEFAULT_WAREHOUSES = [{ code: 'jkt', name: 'Jakarta' }, { code: 'sby', name: 'Surabaya' }];
const DEFAULT_PARTS = { p1: { label: 'Part 1', start: '08:00', end: '10:00' }, p2: { label: 'Part 2', start: '13:00', end: '14:00' }, p3: { label: 'Part 3', start: '15:00', end: '16:00' } };
const CATEGORY_OPTIONS = [
  { value: '', label: 'Ikuti klasifikasi otomatis' },
  { value: 'tg', label: 'TG · Tempered Glass' },
  { value: 'hg', label: 'HG · Hydrogel' },
  { value: 'mix', label: 'Mix · TG + HG' },
];

let S = null; // state halaman (dibuat ulang tiap render)
let R = null; // referensi elemen

function newState() {
  return {
    alive: true, seq: 0,
    part: 'auto', warehouse: 'all', tab: 'groups',
    preview: null, loading: false, error: null,
    selectedSn: null, openGroups: new Set(), groupsInit: false, ignoreBlock: false,
    runId: null, runModal: null, pollTimer: null, activeRunId: null, lastProgress: null, lastSig: null, pollBusy: false,
    detailModal: null, ctx: null, unsubSettings: null, allClosedByUser: false,
  };
}

// ---------------------------------------------------------------------------
// Helper data
// ---------------------------------------------------------------------------
function warehousesCfg() {
  const ws = store.settings && Array.isArray(store.settings.warehouses) ? store.settings.warehouses.filter((w) => w && w.code) : [];
  return ws.length ? ws.map((w) => ({ code: w.code, name: w.name || String(w.code).toUpperCase() })) : DEFAULT_WAREHOUSES;
}
function partsCfg() {
  const p = (store.settings && store.settings.parts) || {};
  const out = {};
  for (const k of PARTS) out[k] = { ...DEFAULT_PARTS[k], ...(p[k] || {}) };
  return out;
}
function partOptions() {
  const parts = partsCfg();
  const pa = S.preview && S.preview.part_auto;
  const autoLabel = pa && pa.window ? `Otomatis · ${pa.label} (${pa.window.start}–${pa.window.end})` : 'Otomatis';
  return [{ value: 'auto', label: autoLabel }, ...PARTS.map((k) => ({ value: k, label: `${parts[k].label} (${parts[k].start}–${parts[k].end})` }))];
}
function isNarrow() { return window.matchMedia('(max-width: 1023px)').matches; }

/** Cari OrderSummary di semua daftar preview. */
function findOrder(sn) {
  const p = S.preview;
  if (!p || !sn) return null;
  for (const g of p.groups || []) for (const o of g.orders || []) if (o.order_sn === sn) return o;
  for (const list of [p.held, p.review, p.excluded]) for (const o of list || []) if (o.order_sn === sn) return o;
  return null;
}
function allPreviewOrders() {
  const p = S.preview;
  if (!p) return [];
  return [...(p.groups || []).flatMap((g) => g.orders || []), ...(p.held || []), ...(p.review || []), ...(p.excluded || [])];
}
function val(o) { return (o && o.validation) || { holds: [], warnings: [], flags: {} }; }
function hasWarn(o, code) { return (val(o).warnings || []).some((w) => w.code === code); }
function tipeBelum(o) { return !!(val(o).flags && val(o).flags.tipe_belum_ditulis); }
function pdfCounts(p) {
  const labels = (p.groups || []).length;
  let lists = 0;
  if (labels) lists = p.warehouse === 'all' ? new Set((p.groups || []).map((g) => g.warehouse_code || 'all')).size : 1;
  return { labels, lists, total: labels + lists };
}
function canProcess() {
  const p = S.preview;
  if (!p) return false;
  if (!p.totals || !p.totals.orders) return false;
  if (p.blocked && !S.ignoreBlock) return false;
  return true;
}
function setUrlQuery() {
  try {
    const hash = router.buildHash('/process', { part: S.part !== 'auto' ? S.part : undefined, warehouse: S.warehouse !== 'all' ? S.warehouse : undefined, tab: S.tab !== 'groups' ? S.tab : undefined });
    history.replaceState(null, '', location.pathname + location.search + hash);
  } catch { /* abaikan */ }
}

// ---------------------------------------------------------------------------
// Render utama
// ---------------------------------------------------------------------------
export async function render(container, params, ctx) {
  destroy();
  S = newState();
  S.ctx = ctx || {};
  const q = (ctx && ctx.query) || {};
  if (PARTS.includes(q.part)) S.part = q.part;
  if (['jkt', 'sby'].includes(q.warehouse)) S.warehouse = q.warehouse;
  if (TABS.includes(q.tab)) S.tab = q.tab;
  buildShell(container);
  // Setting (nama gudang, jendela part) dimuat main.js di latar belakang — bisa datang setelah render pertama.
  S.unsubSettings = store.subscribe('settings', () => { if (!S || !S.alive || !R) return; renderWarehousePills(); R.partSelect.setOptions(partOptions(), S.part); });
  await Promise.all([loadPreview(), checkActiveRun()]);
}

export function destroy() {
  if (!S) return;
  S.alive = false;
  stopPolling();
  if (S.unsubSettings) { try { S.unsubSettings(); } catch { /* abaikan */ } S.unsubSettings = null; }
  if (S.runModal) { const m = S.runModal; S.runModal = null; try { m.close(); } catch { /* abaikan */ } }
  if (S.detailModal) { const m = S.detailModal; S.detailModal = null; try { m.handle.close(); } catch { /* abaikan */ } }
  S = null; R = null;
}

function buildShell(container) {
  R = {};
  // ---- Filter di kanan header ----
  R.whGroup = el('div', { class: 'pill-group proc-wh' });
  renderWarehousePills();
  R.partSelect = c.select({ options: partOptions(), value: S.part, inline: true, ariaLabel: 'Pilih Part', className: 'proc-part-select', onChange: (v) => { S.part = v; setUrlQuery(); loadPreview(); } });
  R.reloadBtn = c.button({ label: 'Muat ulang preview', kind: 'secondary', icon: 'refresh', onClick: () => loadPreview() });
  const filters = el('div', { class: 'proc-filters' },
    el('span', { class: 'proc-filter-label' }, icons.warehouse({ size: 14 }), 'Gudang'), R.whGroup,
    el('span', { class: 'proc-filter-label' }, icons.clock({ size: 14 }), 'Part'), R.partSelect,
    R.reloadBtn);

  R.header = c.pageHeader({
    title: 'Process Order', eyebrow: 'Pemrosesan order',
    subtitle: 'Periksa order Siap Kirim per part, jenis pengiriman, kategori, dan gudang — lalu buat label AWB & Product List.',
    actions: filters,
  });
  R.banners = el('div', { class: 'proc-banners' });
  R.totals = el('div', { class: 'proc-totals' });
  R.tabsRow = el('div', { class: 'proc-tabs-row' });
  R.body = el('div', { class: 'proc-body' });
  R.footer = el('div', { class: 'proc-footer', hidden: true });
  R.page = el('div', { class: 'proc-page' }, R.header, R.banners, R.totals, R.tabsRow, R.body, R.footer);
  container.replaceChildren(R.page);
  renderSkeleton();
}

function renderWarehousePills() {
  const list = [{ code: 'all', name: 'Semua' }, ...warehousesCfg()];
  R.whGroup.replaceChildren(...list.map((w) => c.pill({ text: w.name, active: S.warehouse === w.code, onClick: () => { if (S.warehouse === w.code) return; S.warehouse = w.code; renderWarehousePills(); setUrlQuery(); loadPreview(); } })));
}

function renderSkeleton() {
  R.totals.replaceChildren(...Array.from({ length: 10 }, () => el('div', { class: 'proc-stat' }, el('div', { class: 'skeleton w-full' }, el('div', { class: 'skeleton-line', style: { height: '22px', width: '40%' } }), el('div', { class: 'skeleton-line w-80' })))));
  R.tabsRow.replaceChildren(el('div', { class: 'skeleton', style: { width: '420px', maxWidth: '100%' } }, el('div', { class: 'skeleton-line', style: { height: '40px', borderRadius: '999px' } })));
  R.body.replaceChildren(el('div', { class: 'proc-split' },
    el('div', { class: 'stack' }, c.card({ body: c.skeleton(3, { kind: 'list' }) }), c.card({ body: c.skeleton(3, { kind: 'list' }) })),
    el('div', { class: 'proc-detail' }, c.card({ body: c.skeleton(5) }))));
}

// ---------------------------------------------------------------------------
// Muat preview
// ---------------------------------------------------------------------------
async function loadPreview() {
  if (!S || !S.alive) return;
  const seq = ++S.seq;
  S.loading = true;
  R.reloadBtn.setLoading(true);
  R.body.classList.add('is-loading');
  try {
    const p = await api.get('/api/process/preview', { query: { part: S.part, warehouse: S.warehouse } });
    if (!S || !S.alive || seq !== S.seq) return;
    S.preview = p; S.error = null;
    S.groupsInit = true;
    // Buka grup pertama bila tidak ada grup yang terbuka (pertama kali, atau grup lama hilang setelah run selesai) —
    // kecuali user sendiri yang menutup semua grup.
    const groups = p.groups || [];
    if (groups.length && !groups.some((g) => S.openGroups.has(g.key)) && !S.allClosedByUser) S.openGroups.add(groups[0].key);
    renderAll();
  } catch (e) {
    if (!S || !S.alive || seq !== S.seq) return;
    S.error = e;
    renderLoadError(e);
  } finally {
    if (S && S.alive && seq === S.seq) { S.loading = false; R.reloadBtn.setLoading(false); R.body.classList.remove('is-loading'); }
  }
}

function renderLoadError(e) {
  R.totals.replaceChildren();
  R.tabsRow.replaceChildren();
  R.footer.hidden = true;
  R.banners.replaceChildren();
  const notReady = e && (e.status === 404 || e.status === 503);
  R.body.replaceChildren(el('div', { class: 'card page-placeholder' }, c.emptyState({
    icon: notReady ? 'layers' : 'alertCircle',
    title: notReady ? 'Modul preview belum tersedia' : 'Preview gagal dimuat',
    text: api.errorMessage(e, 'Terjadi kesalahan saat memuat preview.'),
    action: { label: 'Coba lagi', icon: 'refresh', onClick: () => loadPreview() },
  })));
}

function renderAll() {
  R.partSelect.setOptions(partOptions(), S.part);
  // Order yang sedang dipilih bisa pindah grup setelah koreksi → buka grup barunya supaya tetap terlihat.
  if (S.selectedSn && S.preview) {
    const g = (S.preview.groups || []).find((x) => (x.orders || []).some((o) => o.order_sn === S.selectedSn));
    if (g) S.openGroups.add(g.key);
  }
  renderWarehousePills();
  renderBanners();
  renderTotals();
  renderTabs();
  renderBody();
  renderFooter();
  if (S.detailModal) refreshDetailModal();
}

// ---------------------------------------------------------------------------
// Banner status
// ---------------------------------------------------------------------------
function renderBanners() {
  const p = S.preview;
  const nodes = [];
  if (S.activeRunId && !S.runModal) {
    nodes.push(c.alert({ tone: 'primary', icon: 'loader', title: `Run #${S.activeRunId} masih berjalan`, text: 'Proses order sedang berlangsung di latar belakang. Preview mungkin berubah setelah run selesai.',
      actions: c.button({ label: 'Lihat progres', kind: 'primary', size: 'sm', icon: 'eye', onClick: () => openRunModal(S.activeRunId) }) }));
  }
  if (p) {
    const sync = p.sync || {};
    if (p.blocked) {
      const cb = c.checkbox({ label: 'Tetap proses dengan data terakhir', checked: S.ignoreBlock, onChange: (v) => { S.ignoreBlock = v; renderFooter(); } });
      const retry = c.button({ label: 'Coba sync lagi', kind: 'danger', size: 'sm', icon: 'sync', onClick: async () => {
        retry.setLoading(true);
        try { if (S.ctx.layout && S.ctx.layout.syncNow) await S.ctx.layout.syncNow(); else await api.post('/api/sync/now'); } catch (e) { reportError(e, 'Sinkronisasi gagal'); }
        finally { retry.setLoading(false); }
        loadPreview();
      } });
      const text = el('div', { class: 'stack-sm' },
        el('div', p.blocked.message || 'Proses diblokir.'),
        sync.last_ok_at ? el('div', { class: 'text-sm' }, `Sync sukses terakhir: ${fmt.datetime(sync.last_ok_at)} (${fmt.relative(sync.last_ok_at)})`) : null,
        p.blocked.code !== 'NOT_CONNECTED' ? cb : null);
      nodes.push(c.alert({ tone: 'danger', title: `Proses diblokir · ${p.blocked.code === 'NOT_CONNECTED' ? 'toko belum terhubung' : p.blocked.code === 'NO_SYNC' ? 'belum pernah sync' : 'sync terakhir gagal'}`, text,
        actions: p.blocked.code === 'NOT_CONNECTED' ? c.button({ label: 'Buka Pengaturan', kind: 'danger', size: 'sm', icon: 'plug', href: '#/settings?tab=shopee' }) : retry }));
    } else {
      const stale = !!sync.stale;
      nodes.push(c.alert({ tone: stale ? 'warning' : 'success', icon: stale ? 'clock' : 'checkCircle', className: 'proc-sync-alert',
        text: el('span', null, el('b', `Sync terakhir ${sync.last_ok_at ? fmt.relative(sync.last_ok_at) : '-'}`), sync.last_ok_at ? ` (${fmt.datetime(sync.last_ok_at)})` : '', stale ? ' — sudah lama, data order mungkin tidak terbaru.' : ` · preview dibuat ${fmt.time(p.generated_at)} WIB`),
        actions: c.button({ label: 'Sync sekarang', kind: 'ghost', size: 'sm', icon: 'sync', onClick: async (_e, btn) => {
          btn.setLoading(true);
          try { if (S.ctx.layout && S.ctx.layout.syncNow) await S.ctx.layout.syncNow(); else await api.post('/api/sync/now'); } catch (e) { reportError(e, 'Sinkronisasi gagal'); }
          finally { btn.setLoading(false); }
          loadPreview();
        } }) }));
    }
    const pa = p.part_auto;
    if (pa && pa.in_window === false) {
      const parts = partsCfg();
      const nextLabel = pa.next && parts[pa.next.part] ? parts[pa.next.part].label : (pa.next && pa.next.part) || '-';
      nodes.push(c.alert({ tone: 'warning', icon: 'clock', title: `Sekarang di luar jam ${pa.label} (${pa.window.start}–${pa.window.end})`,
        text: `Preview memakai aturan ${p.part_label || fmt.part(p.part)}${S.part === 'auto' ? ' (otomatis)' : ' (pilihan manual)'}. ${pa.next ? `Jendela berikutnya: ${nextLabel} mulai ${pa.next.start}${pa.next.tomorrow ? ' besok' : ''}.` : ''} Proses tetap bisa dijalankan.` }));
    }
  }
  R.banners.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------
// Ringkasan
// ---------------------------------------------------------------------------
function miniStat({ label, value, tone = 'primary', icon: ic }) {
  return el('div', { class: `proc-stat tone-${tone}` },
    el('div', { class: 'proc-stat-icon' }, icons.get(ic, { size: 15 })),
    el('div', { class: 'min-w-0' }, el('div', { class: 'proc-stat-value' }, fmt.number(value || 0)), el('div', { class: 'proc-stat-label', title: label }, label)));
}
function renderTotals() {
  const t = (S.preview && S.preview.totals) || {};
  const cat = t.by_category || {}; const st = t.by_ship_type || {};
  R.totals.replaceChildren(
    miniStat({ label: 'Order', value: t.orders, icon: 'orders', tone: 'primary' }),
    miniStat({ label: 'Produk', value: t.products, icon: 'box', tone: 'primary' }),
    miniStat({ label: 'Instant', value: st.instant, icon: 'zap', tone: 'primary' }),
    miniStat({ label: 'Regular', value: st.regular, icon: 'truck', tone: 'neutral' }),
    miniStat({ label: 'TG', value: cat.tg, icon: 'shield', tone: 'info' }),
    miniStat({ label: 'HG', value: cat.hg, icon: 'layers', tone: 'success' }),
    miniStat({ label: 'Mix', value: cat.mix, icon: 'grid', tone: 'warning' }),
    miniStat({ label: 'Ditahan', value: t.held, icon: 'pause', tone: t.held ? 'danger' : 'neutral' }),
    miniStat({ label: 'Perlu diperiksa', value: t.review, icon: 'alert', tone: t.review ? 'warning' : 'neutral' }),
    miniStat({ label: 'Dikeluarkan', value: t.excluded, icon: 'x', tone: 'neutral' }));
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function renderTabs() {
  const p = S.preview; const t = p.totals || {};
  R.tabs = c.tabs({
    items: [
      { key: 'groups', label: 'Siap diproses', icon: 'checkCircle', count: t.orders || 0 },
      { key: 'held', label: 'Ditahan', icon: 'pause', count: t.held || 0, tone: t.held ? 'danger' : undefined },
      { key: 'review', label: 'Perlu diperiksa', icon: 'alert', count: t.review || 0, tone: t.review ? 'warning' : undefined },
      { key: 'excluded', label: 'Dikeluarkan', icon: 'x', count: t.excluded || 0 },
      { key: 'products', label: 'Product List', icon: 'list', count: (p.product_list || []).length },
    ],
    active: S.tab,
    onChange: (k) => { S.tab = k; setUrlQuery(); renderBody(); },
  });
  const meta = el('div', { class: 'proc-tabs-meta text-sm text-muted' },
    el('span', { class: 'row gap-1' }, icons.clock({ size: 14 }), `${p.part_label || fmt.part(p.part)}${p.part_window ? ` · ${p.part_window.start}–${p.part_window.end}` : ''}`),
    el('span', { class: 'row gap-1' }, icons.warehouse({ size: 14 }), p.warehouse_name || fmt.warehouse(p.warehouse)),
    el('span', { class: 'row gap-1' }, icons.shopee({ size: 14 }), 'Shopee'));
  R.tabsRow.replaceChildren(R.tabs, meta);
}

// ---------------------------------------------------------------------------
// Isi tab
// ---------------------------------------------------------------------------
function renderBody() {
  const p = S.preview;
  if (!p) return;
  R.tables = [];
  R.groupNodes = new Map();
  let left;
  switch (S.tab) {
    case 'held': left = holdTable(p.held || [], { title: 'Order ditahan', subtitle: 'Tidak ikut diproses sampai alasan penahanan diselesaikan (isi tipe HP, paksa proses, atau keluarkan).', empty: { icon: 'checkCircle', title: 'Tidak ada order ditahan', text: 'Semua order lolos validasi.' } }); break;
    case 'review': left = holdTable(p.review || [], { title: 'Perlu diperiksa', subtitle: 'SKU tidak dikenali atau gudang tidak terpetakan. Tentukan kategori / gudang lewat detail, atau paksa proses.', empty: { icon: 'checkCircle', title: 'Tidak ada order yang perlu diperiksa', text: 'Semua SKU dan gudang dikenali.' } }); break;
    case 'excluded': left = holdTable(p.excluded || [], { title: 'Dikeluarkan dari proses', subtitle: 'Order yang dikeluarkan manual oleh staf. Masukkan kembali bila sudah siap.', excluded: true, empty: { icon: 'inbox', title: 'Tidak ada order yang dikeluarkan', text: 'Gunakan "Keluarkan dari proses" di detail order bila perlu.' } }); break;
    case 'products': left = productTable(p); break;
    default: left = groupsPanel(p);
  }
  const wide = S.tab === 'products';
  R.left = el('div', { class: 'proc-left min-w-0' }, left);
  R.detailCol = el('div', { class: 'proc-detail' });
  R.body.replaceChildren(el('div', { class: classNames('proc-split', wide && 'is-wide') }, R.left, wide ? null : R.detailCol));
  if (!wide) renderDetailCol();
}

// ---- Grup (Siap diproses) ----
function groupsPanel(p) {
  const groups = p.groups || [];
  if (!groups.length) {
    const t = p.totals || {};
    let hint;
    if (S.activeRunId) hint = `Run #${S.activeRunId} sedang memproses order — daftar akan diperbarui setelah run selesai.`;
    else if (t.held || t.review) hint = `Ada ${fmt.number((t.held || 0) + (t.review || 0))} order yang ditahan / perlu diperiksa — selesaikan di tab lain agar bisa diproses.`;
    else hint = 'Jalankan sync untuk menarik order Siap Kirim dari Shopee, atau ubah filter gudang / part.';
    const action = S.activeRunId
      ? { label: 'Lihat progres', icon: 'eye', kind: 'primary', onClick: () => openRunModal(S.activeRunId) }
      : { label: 'Muat ulang preview', icon: 'refresh', kind: 'secondary', onClick: () => loadPreview() };
    return el('div', { class: 'card' }, c.emptyState({ icon: S.activeRunId ? 'loader' : 'inbox', title: S.activeRunId ? 'Order sedang diproses' : 'Belum ada order siap diproses', text: hint, action }));
  }
  const allOpen = groups.every((g) => S.openGroups.has(g.key));
  const toolbar = el('div', { class: 'proc-groups-toolbar' },
    el('div', { class: 'text-sm text-muted' }, el('b', { class: 'text-primary' }, fmt.number(groups.length)), ` grup PDF · `, el('b', fmt.number(p.totals.orders)), ` order · `, el('b', fmt.number(p.totals.products)), ' produk'),
    c.button({ label: allOpen ? 'Tutup semua' : 'Buka semua', kind: 'ghost', size: 'sm', icon: allOpen ? 'chevronUp' : 'chevronDown', onClick: () => { if (allOpen) { S.openGroups.clear(); S.allClosedByUser = true; } else { groups.forEach((g) => S.openGroups.add(g.key)); S.allClosedByUser = false; } renderBody(); } }));
  const list = el('div', { class: 'proc-groups' }, groups.map((g) => { const n = groupCard(g); R.groupNodes.set(g.key, n); return n; }));
  return el('div', { class: 'stack' }, toolbar, list);
}

function groupCard(g) {
  const open = S.openGroups.has(g.key);
  const instant = g.ship_type === 'instant';
  const orders = g.orders || [];
  const nBelum = orders.filter(tipeBelum).length;
  const nStale = orders.filter((o) => o.pdf_stale).length;
  const head = el('button', {
    class: 'proc-group-head', type: 'button', 'aria-expanded': open ? 'true' : 'false',
    onClick: () => { if (S.openGroups.has(g.key)) S.openGroups.delete(g.key); else { S.openGroups.add(g.key); S.allClosedByUser = false; } const n = groupCard(g); R.groupNodes.get(g.key).replaceWith(n); R.groupNodes.set(g.key, n); },
  },
    c.iconBox({ icon: instant ? 'zap' : 'truck', tone: instant ? undefined : 'neutral' }),
    el('div', { class: 'proc-group-text' },
      el('div', { class: 'proc-group-title' }, g.label || g.key),
      el('div', { class: 'proc-group-file' }, icons.pdf({ size: 13 }), el('span', { class: 'truncate' }, g.file_name || '-'))),
    el('div', { class: 'proc-group-meta' },
      c.badge({ text: `${fmt.number(orders.length)} order`, tone: 'primary' }),
      c.badge({ text: `${fmt.number(g.qty_total)} pcs`, tone: 'neutral' }),
      nBelum ? c.badge({ text: `${fmt.number(nBelum)} tipe belum ditulis`, tone: 'danger', solid: true, icon: 'alert' }) : null,
      nStale ? c.badge({ text: `${fmt.number(nStale)} PDF usang`, tone: 'warning' }) : null,
      el('span', { class: 'proc-group-chevron' }, icons.chevronDown({ size: 18 }))));
  const body = open ? el('div', { class: 'proc-group-body' }, el('div', { class: 'proc-orders', role: 'listbox', 'aria-label': g.label }, orders.map(orderRow))) : null;
  return el('div', { class: classNames('card card-flush proc-group', open && 'is-open'), dataset: { group: g.key } }, head, body);
}

function flagIcon(name, tone, titleText) {
  return el('span', { class: `proc-flag tone-${tone}`, title: titleText }, icons.get(name, { size: 13 }));
}
function orderFlags(o, { dark = true } = {}) {
  const out = [];
  const ov = o.overrides || {};
  if (tipeBelum(o)) out.push(c.badge({ text: 'TIPE BELUM DITULIS', tone: 'danger', solid: true, size: 'sm', title: fmt.warningCode('DEADLINE_EXCEPTION') }));
  if (o.pdf_stale) out.push(c.badge({ text: 'PDF usang', tone: 'warning', size: 'sm', title: 'Order berubah setelah PDF dibuat; PDF perlu dibuat ulang' }));
  if (o.proc_status === 'failed') out.push(flagIcon('xCircle', 'danger', `Gagal di run sebelumnya${o.last_error ? `: ${o.last_error}` : ''} — akan dicoba lagi`));
  if (hasWarn(o, 'DEADLINE_NEAR') && !tipeBelum(o)) out.push(flagIcon('clock', 'warning', `Batas kirim ${fmt.hoursLeft(o.deadline_hours_left)}`));
  if (o.cod) out.push(flagIcon('tag', 'warning', 'Pembayaran COD'));
  if (hasWarn(o, 'NOTE_PRESENT')) out.push(flagIcon('mail', 'info', 'Ada catatan / pesan pembeli'));
  if (ov.force_process) out.push(flagIcon('zap', 'danger', 'Diproses paksa oleh staf'));
  else if (Object.keys(ov).length) out.push(flagIcon('edit', 'info', 'Ada koreksi manual'));
  return el('div', { class: classNames('proc-order-flags', !dark && 'is-light') }, out);
}

function orderRow(o) {
  const selected = S.selectedSn === o.order_sn;
  const row = el('div', {
    class: classNames('proc-order', selected && 'is-selected'), role: 'option', tabindex: 0, 'aria-selected': selected ? 'true' : 'false', dataset: { sn: o.order_sn },
    onClick: () => openDetail(o.order_sn),
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(o.order_sn); } },
  },
    el('div', { class: 'proc-order-main' },
      el('div', { class: 'proc-order-sn mono' }, o.order_sn),
      el('div', { class: 'proc-order-sub', title: `${o.recipient_name || '-'} · ${o.shipping_carrier || '-'}` }, `${o.recipient_name || '-'} · ${o.shipping_carrier || '-'}`)),
    el('div', { class: 'proc-order-items' }, `${fmt.number(o.item_count)} item · ${fmt.number(o.qty_total)} pcs`),
    c.badge({ status: o.sku_category, text: fmt.categoryShort(o.sku_category), size: 'sm' }),
    orderFlags(o),
    icons.chevronRight({ size: 16, class: 'proc-order-chev' }));
  return row;
}

// ---- Tabel ditahan / perlu diperiksa / dikeluarkan ----
function reasonBadges(o) {
  const reasons = o.reasons || val(o).holds || [];
  if (!reasons.length) return el('span', { class: 'text-muted' }, '-');
  return el('div', { class: 'chip-list' }, reasons.map((r) => c.badge({ status: r.code, text: fmt.holdCode(r.code), title: r.message, size: 'sm' })));
}
function holdTable(rows, { title, subtitle, empty, excluded = false }) {
  const columns = [
    { key: 'order_sn', label: 'Order', render: (r) => el('div', null, el('div', { class: 'table-cell-main mono' }, r.order_sn), el('div', { class: 'table-cell-sub' }, r.recipient_name || '-')) },
    { key: 'reasons', label: 'Alasan', render: (r) => el('div', { class: 'wrap-cell' }, reasonBadges(r)) },
    { key: 'shipping_carrier', label: 'Kurir', render: (r) => el('div', null, el('div', { class: 'text-sm' }, r.shipping_carrier || '-'), c.badge({ status: r.ship_type, text: fmt.shipTypeShort(r.ship_type), size: 'sm' })) },
    { key: 'warehouse_code', label: 'Gudang', render: (r) => (r.warehouse_code ? fmt.warehouse(r.warehouse_code) : c.badge({ text: 'Tidak diketahui', tone: 'warning', size: 'sm' })) },
    { key: 'items', label: 'Item', render: (r) => {
      const ph = r.phone_type || {};
      const phone = ph.value ? `Tipe HP: ${ph.value}` : (ph.required ? el('span', { class: 'text-danger fw-600' }, 'Tipe HP belum ada') : 'Tipe HP tidak wajib');
      return el('div', null, el('div', { class: 'text-sm' }, `${fmt.number(r.item_count)} item · ${fmt.number(r.qty_total)} pcs`), el('div', { class: 'table-cell-sub' }, phone));
    } },
    { key: 'actions', label: 'Aksi', align: 'right', render: (r) => quickActions(r, excluded) },
  ];
  const tbl = c.table({ columns, rows, rowKey: 'order_sn', selectedKey: S.selectedSn, onRowClick: (r) => openDetail(r.order_sn), empty: empty || 'Tidak ada order' });
  R.tables.push(tbl);
  return c.card({ title, subtitle, icon: excluded ? 'x' : 'alert', flush: true, body: tbl });
}
function quickActions(o, excluded) {
  const btns = [];
  if (excluded) {
    btns.push(c.button({ label: 'Masukkan kembali', kind: 'success', size: 'sm', icon: 'undo', onClick: () => applyOverride(o.order_sn, { excluded: false }, `Order ${o.order_sn} dimasukkan kembali ke proses`) }));
  } else {
    const holdsPhone = (o.reasons || []).some((r) => r.code === 'PHONE_TYPE_MISSING');
    const forceable = (o.reasons || []).some((r) => r.code === 'PHONE_TYPE_MISSING' || r.code === 'SKU_UNKNOWN');
    if (holdsPhone) btns.push(c.iconButton({ icon: 'phone', title: 'Isi tipe HP', kind: 'soft', size: 'sm', onClick: () => promptPhoneType(o) }));
    if (forceable) btns.push(c.iconButton({ icon: 'zap', title: 'Paksa proses', kind: 'soft', size: 'sm', onClick: () => applyOverride(o.order_sn, { force_process: true }, `Order ${o.order_sn} akan diproses paksa`) }));
    btns.push(c.iconButton({ icon: 'x', title: 'Keluarkan dari proses', kind: 'danger-soft', size: 'sm', onClick: () => applyOverride(o.order_sn, { excluded: true }, `Order ${o.order_sn} dikeluarkan dari proses`) }));
  }
  btns.push(c.iconButton({ icon: 'eye', title: 'Buka detail', kind: 'secondary', size: 'sm', onClick: () => openDetail(o.order_sn) }));
  return el('div', { class: 'proc-quick' }, btns);
}

// ---- Product list ----
function productTable(p) {
  const rows = p.product_list || [];
  const qty = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const tbl = c.table({
    columns: [
      { key: 'marketplace', label: 'Marketplace', render: (r) => c.badge({ status: r.marketplace, text: fmt.marketplace(r.marketplace), icon: r.marketplace === 'shopee' ? 'shopee' : null, size: 'sm' }) },
      { key: 'sku', label: 'SKU', render: (r) => el('span', { class: 'mono fw-600' }, r.sku || '-') },
      { key: 'item_name', label: 'Nama produk', render: (r) => el('div', { class: 'wrap-cell' }, r.item_name || '-') },
      { key: 'model_name', label: 'Variasi', render: (r) => el('div', { class: 'wrap-cell text-muted' }, r.model_name || '-') },
      { key: 'category', label: 'Kategori', render: (r) => (r.category ? c.badge({ status: r.category, text: fmt.categoryShort(r.category), size: 'sm' }) : c.badge({ text: '?', tone: 'warning', size: 'sm' })) },
      { key: 'qty', label: 'Qty', align: 'right', render: (r) => el('b', { class: 'tabular' }, fmt.number(r.qty)) },
      { key: 'order_count', label: 'Order', align: 'right', render: (r) => el('span', { class: 'tabular' }, fmt.number(r.order_count)) },
    ],
    rows, rowKey: (r, i) => `${r.sku}-${i}`,
    empty: { icon: 'list', title: 'Product list kosong', text: 'Product list dihitung dari order yang siap diproses.' },
    footer: rows.length ? el('div', { class: 'row-between wrap w-full text-sm', style: { padding: '0 var(--card-pad) var(--space-3)' } },
      el('span', { class: 'text-muted' }, `${fmt.number(rows.length)} SKU/variasi · `, el('b', fmt.number(qty)), ' pcs · ', el('b', fmt.number(p.totals.orders)), ' order'),
      el('span', { class: 'row gap-1 text-muted mono' }, icons.pdf({ size: 13 }), p.product_list_file_name || '-')) : null,
  });
  return c.card({ title: 'Product List', subtitle: 'Agregasi produk dari order siap diproses — dicetak sebagai PDF terpisah per gudang.', icon: 'list', flush: true, body: tbl });
}

// ---------------------------------------------------------------------------
// Detail order
// ---------------------------------------------------------------------------
function openDetail(sn) {
  S.selectedSn = sn;
  highlightSelected();
  if (isNarrow() || S.tab === 'products') openDetailModal(sn);
  else renderDetailCol();
}
function highlightSelected() {
  if (!R || !R.left) return;
  for (const n of R.left.querySelectorAll('.proc-order[data-sn]')) { const on = n.dataset.sn === S.selectedSn; n.classList.toggle('is-selected', on); n.setAttribute('aria-selected', on ? 'true' : 'false'); }
  for (const t of R.tables || []) t.setSelected(S.selectedSn);
}
function renderDetailCol() {
  if (!R || !R.detailCol) return;
  const o = findOrder(S.selectedSn);
  if (!o) {
    R.detailCol.replaceChildren(el('div', { class: 'card proc-empty-detail' }, c.emptyState({ icon: 'orders', title: 'Pilih order', text: 'Klik salah satu order di daftar untuk melihat detail, item, dan koreksi manual.', size: 'sm' })));
    return;
  }
  R.detailCol.replaceChildren(...detailNodes(o));
}
function openDetailModal(sn) {
  const o = findOrder(sn);
  if (!o) return;
  if (S.detailModal) { const m = S.detailModal; S.detailModal = null; m.handle.close(); }
  const body = el('div', { class: 'proc-detail-modal' }, el('div', { class: 'proc-confirm-top', tabindex: -1 }), ...detailNodes(o));
  const handle = modal.open({ title: `Order ${o.order_sn}`, subtitle: `${fmt.marketplace(o.marketplace)} · ${fmt.orderStatus(o.order_status)}`, size: 'lg', body, className: 'proc-detail-dialog', onClose: () => { if (S && S.detailModal && S.detailModal.handle === handle) S.detailModal = null; } });
  S.detailModal = { handle, sn, body };
}
function refreshDetailModal() {
  const dm = S.detailModal;
  if (!dm) return;
  const o = findOrder(dm.sn);
  if (!o) { dm.handle.close(); toast.info('Order tidak lagi ada di preview.'); return; }
  dm.body.replaceChildren(el('div', { class: 'proc-confirm-top', tabindex: -1 }), ...detailNodes(o));
}

function glassTag(text, tone, ic, titleText) {
  return el('span', { class: classNames('proc-tag', tone && `tone-${tone}`), title: titleText }, ic ? icons.get(ic, { size: 12 }) : null, text);
}
function detailNodes(o) {
  const instant = o.ship_type === 'instant';
  const v = val(o); const ov = o.overrides || {};
  const holds = v.holds || []; const warns = v.warnings || [];
  const near = o.deadline_hours_left !== null && o.deadline_hours_left !== undefined && o.deadline_hours_left < 12;

  const tiles = el('div', { class: 'glass-grid' },
    c.glassTile({ label: 'Kurir', value: o.shipping_carrier || '-', sub: fmt.shipType(o.ship_type), icon: instant ? 'zap' : 'truck', className: 'proc-tile-text' }),
    c.glassTile({ label: 'Gudang', value: o.warehouse_code ? fmt.warehouse(o.warehouse_code) : 'Tidak diketahui', sub: ov.warehouse_code ? 'Override staf' : 'Dari lokasi produk', icon: 'warehouse', className: 'proc-tile-text' }),
    c.glassTile({ label: 'Batas kirim', value: fmt.hoursLeft(o.deadline_hours_left), sub: fmt.datetime(o.ship_by_date), icon: 'clock', className: classNames('proc-tile-text', near && 'is-urgent') }),
    c.glassTile({ label: 'Total', value: fmt.currency(o.total_amount, o.currency), sub: o.cod ? 'COD · bayar di tempat' : 'Sudah dibayar', icon: 'tag', className: 'proc-tile-text' }));

  const phone = o.phone_type || {};
  const kv = c.kv([
    ['Pembeli', o.buyer_username ? `@${o.buyer_username}` : '-'],
    ['Penerima', el('span', null, o.recipient_name || '-', o.recipient_phone ? el('span', { class: 'proc-kv-muted' }, ` · ${o.recipient_phone}`) : null)],
    ['Alamat', o.recipient_address || '-'],
    ['Catatan pembeli', o.note ? el('span', { class: 'proc-note' }, o.note) : el('span', { class: 'proc-kv-muted' }, 'Tidak ada')],
    ['Pesan ke penjual', o.message_to_seller ? el('span', { class: 'proc-note' }, o.message_to_seller) : el('span', { class: 'proc-kv-muted' }, 'Tidak ada')],
    ['Tipe HP', phone.value ? el('span', null, el('b', phone.value), phone.source ? el('span', { class: 'proc-kv-muted' }, ` · dari ${sourceLabel(phone.source, ov)}`) : null) : (phone.required ? el('span', { class: 'proc-kv-danger' }, 'Belum ditulis') : el('span', { class: 'proc-kv-muted' }, 'Tidak wajib'))],
    ['Status proses', el('span', { class: 'row gap-2 wrap' }, c.badge({ status: o.proc_status, className: 'badge-glass', dot: true }), o.proc_run_id ? el('a', { href: `#/history/${o.proc_run_id}`, class: 'proc-link' }, `Run #${o.proc_run_id}`) : null)],
  ]);

  const items = el('div', { class: 'proc-detail-items' }, (o.items || []).map((it) => el('div', { class: 'proc-item' },
    el('div', { class: 'proc-item-qty' }, `×${fmt.number(it.qty)}`),
    el('div', { class: 'min-w-0 flex-1' },
      el('div', { class: 'proc-item-name' }, it.item_name || '-'),
      el('div', { class: 'proc-item-sub' }, it.model_name ? `Variasi: ${it.model_name}` : 'Tanpa variasi'),
      el('div', { class: 'proc-item-meta' },
        el('span', { class: 'proc-tag mono' }, it.model_sku || it.item_sku || 'SKU -'),
        it.category ? glassTag(fmt.categoryShort(it.category), null, null, fmt.category(it.category)) : glassTag('SKU tidak dikenali', 'warning', 'alert'),
        it.phone_type ? glassTag(it.phone_type, null, 'phone', 'Tipe HP') : (it.phone_type_required ? glassTag('Tipe HP belum ada', 'danger', 'phone') : null))))));

  const tags = [];
  for (const h of holds) tags.push(glassTag(fmt.holdCode(h.code), 'danger', 'pause', h.message));
  for (const w of warns) tags.push(glassTag(fmt.warningCode(w.code), w.code === 'DEADLINE_EXCEPTION' ? 'danger' : 'warning', w.code === 'DEADLINE_EXCEPTION' ? 'alert' : 'info', w.message));
  if (o.pdf_stale) tags.push(glassTag('PDF tidak sesuai, perlu dibuat ulang', 'warning', 'pdf'));
  if (o.last_error) tags.push(glassTag(`Gagal sebelumnya: ${o.last_error}`, 'danger', 'xCircle'));

  const ovTags = [];
  if (ov.sku_category) ovTags.push(glassTag(`Kategori → ${fmt.categoryShort(ov.sku_category)}`, null, 'edit'));
  if (ov.warehouse_code) ovTags.push(glassTag(`Gudang → ${fmt.warehouse(ov.warehouse_code)}`, null, 'edit'));
  if (ov.phone_type) ovTags.push(glassTag(`Tipe HP → ${ov.phone_type}`, null, 'phone'));
  if (ov.force_process) ovTags.push(glassTag('Paksa proses', 'danger', 'zap'));
  if (ov.excluded) ovTags.push(glassTag('Dikeluarkan dari proses', 'warning', 'x'));
  if (ov.note) ovTags.push(glassTag(`Catatan staf: ${ov.note}`, null, 'clipboard'));

  const gradient = el('div', { class: 'card card-gradient proc-detail-card' },
    el('div', { class: 'card-header' },
      el('div', { class: 'row gap-3 min-w-0' }, c.iconBox({ icon: instant ? 'zap' : 'truck', tone: 'glass' }),
        el('div', { class: 'card-header-text' }, el('div', { class: 'card-title mono' }, o.order_sn), el('div', { class: 'card-subtitle' }, `${fmt.marketplace(o.marketplace)} · ${fmt.orderStatus(o.order_status)} · dibuat ${fmt.datetime(o.create_time)}`))),
      el('div', { class: 'card-actions' }, c.badge({ status: o.sku_category, text: fmt.categoryShort(o.sku_category), className: 'badge-glass' }), tipeBelum(o) ? c.badge({ text: 'TIPE BELUM DITULIS', tone: 'danger', solid: true }) : null)),
    el('div', { class: 'card-body stack' },
      tiles,
      kv,
      el('div', null, el('div', { class: 'proc-section-title' }, `Item (${fmt.number(o.item_count)} · ${fmt.number(o.qty_total)} pcs)`), items),
      tags.length ? el('div', null, el('div', { class: 'proc-section-title' }, 'Hold & peringatan'), el('div', { class: 'proc-tags' }, tags)) : null,
      ovTags.length ? el('div', null, el('div', { class: 'proc-section-title' }, 'Koreksi manual aktif'), el('div', { class: 'proc-tags' }, ovTags)) : null));
  return [gradient, actionsCard(o)];
}
function sourceLabel(src, ov) {
  if (ov && ov.phone_type) return 'koreksi staf';
  return { model_name: 'variasi', note: 'catatan pembeli', message_to_seller: 'pesan ke penjual', override: 'koreksi staf' }[src] || src;
}

function actionsCard(o) {
  const sn = o.order_sn; const ov = o.overrides || {};
  const processing = o.proc_status === 'processing';
  const catSel = c.select({ options: CATEGORY_OPTIONS, value: ov.sku_category || '', disabled: processing, ariaLabel: 'Pindah kategori', onChange: (v) => applyOverride(sn, { sku_category: v || null }, v ? `Kategori ${sn} diubah ke ${fmt.categoryShort(v)}` : `Override kategori ${sn} dihapus`) });
  const whSel = c.select({ options: [{ value: '', label: 'Ikuti data marketplace' }, ...warehousesCfg().map((w) => ({ value: w.code, label: w.name }))], value: ov.warehouse_code || '', disabled: processing, ariaLabel: 'Ubah gudang', onChange: (v) => applyOverride(sn, { warehouse_code: v || null }, v ? `Gudang ${sn} diubah ke ${fmt.warehouse(v)}` : `Override gudang ${sn} dihapus`) });
  const savePhone = () => { const v = phoneInp.value.trim(); if (!v && !ov.phone_type) { phoneField.setError('Isi tipe HP terlebih dahulu'); return; } applyOverride(sn, { phone_type: v || null }, v ? `Tipe HP ${sn} disimpan: ${v}` : `Tipe HP ${sn} dikosongkan`); };
  const phoneBtn = c.iconButton({ icon: 'save', title: 'Simpan tipe HP', kind: 'soft', size: 'sm', onClick: savePhone });
  const phoneInp = c.input({ value: ov.phone_type || '', placeholder: 'mis. iPhone 15 Pro Max', icon: 'phone', suffix: phoneBtn, disabled: processing, onEnter: savePhone, maxlength: 100 });
  const phoneField = c.field({ label: 'Isi tipe HP', input: phoneInp, hint: o.phone_type && o.phone_type.value && !ov.phone_type ? `Terdeteksi otomatis: ${o.phone_type.value}` : 'Mengisi tipe HP menghapus hold "Tipe HP belum ditulis".' });
  const force = c.toggle({ label: 'Paksa proses (abaikan hold tipe HP / SKU)', checked: !!ov.force_process, disabled: processing, onChange: (v) => applyOverride(sn, { force_process: v }, v ? `Order ${sn} akan diproses paksa` : `Paksa proses ${sn} dibatalkan`) });
  const noteTa = c.textarea({ value: ov.note || '', rows: 2, placeholder: 'Catatan internal untuk staf (opsional)…', disabled: processing, maxlength: 500 });
  const noteBtn = c.button({ label: 'Simpan catatan', kind: 'soft', size: 'sm', icon: 'save', disabled: processing, onClick: () => { const v = noteTa.value.trim(); if (v === (ov.note || '')) { toast.info('Catatan tidak berubah.', { timeout: 1500 }); return; } applyOverride(sn, { note: v || null }, v ? 'Catatan staf disimpan' : 'Catatan staf dihapus'); } });
  const excl = c.button({
    label: ov.excluded ? 'Masukkan kembali ke proses' : 'Keluarkan dari proses', kind: ov.excluded ? 'success' : 'danger-soft', icon: ov.excluded ? 'undo' : 'x', block: true, disabled: processing,
    onClick: () => applyOverride(sn, { excluded: !ov.excluded }, ov.excluded ? `Order ${sn} dimasukkan kembali ke proses` : `Order ${sn} dikeluarkan dari proses`),
  });
  return c.card({
    title: 'Koreksi manual', subtitle: processing ? 'Order sedang diproses — koreksi dikunci sampai run selesai.' : 'Perubahan langsung disimpan dan preview dimuat ulang.', icon: 'edit', className: 'proc-actions-card',
    body: el('div', { class: 'stack' },
      el('div', { class: 'proc-actions-grid' },
        c.field({ label: 'Pindah kategori', input: catSel }),
        c.field({ label: 'Ubah gudang', input: whSel })),
      phoneField,
      force,
      c.field({ label: 'Catatan staf', input: el('div', { class: 'stack-sm' }, noteTa, el('div', { class: 'row-end' }, noteBtn)) }),
      excl),
  });
}

async function applyOverride(sn, patch, successMsg) {
  try {
    await api.patch(`/api/orders/${encodeURIComponent(sn)}/overrides`, patch);
    if (!S || !S.alive) return false;
    toast.success(successMsg || 'Koreksi disimpan');
    await loadPreview();
    return true;
  } catch (e) {
    reportError(e, 'Koreksi gagal disimpan');
    // Kontrol (select/toggle) sudah berubah di layar padahal server menolak → gambar ulang dari data terakhir.
    if (S && S.alive) { if (S.detailModal) refreshDetailModal(); else renderDetailCol(); }
    return false;
  }
}
async function promptPhoneType(o) {
  const v = await modal.prompt({ title: `Isi tipe HP · ${o.order_sn}`, label: 'Tipe HP', placeholder: 'mis. iPhone 15 Pro Max', value: (o.overrides && o.overrides.phone_type) || '', required: true, message: 'Tipe HP dipakai untuk label dan menghapus hold "Tipe HP belum ditulis".' });
  if (v === null || !S || !S.alive) return;
  await applyOverride(o.order_sn, { phone_type: v }, `Tipe HP ${o.order_sn} disimpan: ${v}`);
}

// ---------------------------------------------------------------------------
// Footer & konfirmasi
// ---------------------------------------------------------------------------
function renderFooter() {
  const p = S.preview;
  if (!p) { R.footer.hidden = true; return; }
  const n = (p.totals && p.totals.orders) || 0;
  const pc = pdfCounts(p);
  const ok = canProcess();
  const reason = !n ? 'Tidak ada order siap diproses.' : (p.blocked && !S.ignoreBlock ? 'Diblokir: centang "Tetap proses dengan data terakhir" untuk melanjutkan.' : `${fmt.number(pc.labels)} PDF label + ${fmt.number(pc.lists)} product list · ${p.part_label || fmt.part(p.part)} · ${p.warehouse_name || fmt.warehouse(p.warehouse)}`);
  R.processBtn = c.button({ label: 'Process & Buat PDF', kind: 'primary', size: 'lg', icon: 'play', disabled: !ok, onClick: () => confirmProcess() });
  R.footer.replaceChildren(
    el('div', { class: 'proc-footer-left' },
      el('div', { class: 'proc-footer-icon' }, icons.pdf({ size: 20 })),
      el('div', { class: 'min-w-0' },
        el('div', { class: 'proc-footer-text' }, `${fmt.number(n)} order · ${fmt.number(pc.total)} PDF akan dibuat`),
        el('div', { class: 'proc-footer-sub' }, reason))),
    el('div', { class: 'proc-footer-right' },
      el('span', { class: 'proc-footer-note' }, 'PDF berhasil ≠ order sudah dikirim'),
      R.processBtn));
  R.footer.hidden = false;
}

function confirmProcess() {
  const p = S.preview;
  if (!p || !canProcess()) return;
  const pc = pdfCounts(p);
  const belum = allPreviewOrders().filter((o) => tipeBelum(o) && !(o.reasons && o.reasons.length)).length;
  const noteTa = c.textarea({ rows: 2, placeholder: 'Catatan run (opsional, tampil di riwayat)…', maxlength: 500 });
  const groups = el('div', { class: 'proc-confirm-groups' }, (p.groups || []).map((g) => el('div', { class: 'proc-confirm-group' },
    icons.get(g.ship_type === 'instant' ? 'zap' : 'truck', { size: 14 }),
    el('span', { class: 'flex-1 truncate' }, g.label),
    c.badge({ text: `${fmt.number((g.orders || []).length)} order`, tone: 'primary', size: 'sm' }),
    el('span', { class: 'mono text-xs text-muted proc-confirm-file' }, g.file_name))));
  const warnings = [];
  if (belum) warnings.push(c.alert({ tone: 'warning', icon: 'alert', text: `${fmt.number(belum)} order diproses tanpa tipe HP (dekat batas batal) — label akan diberi stempel "TIPE BELUM DITULIS".` }));
  if (p.blocked && S.ignoreBlock) warnings.push(c.alert({ tone: 'danger', text: `Sync bermasalah (${p.blocked.message}). Proses dijalankan dengan data terakhir yang ada.` }));
  if (p.part_auto && p.part_auto.in_window === false) warnings.push(c.alert({ tone: 'neutral', icon: 'clock', text: `Sekarang di luar jam ${p.part_auto.label}. Run akan dicatat sebagai ${p.part_label || fmt.part(p.part)}.` }));
  if ((p.totals.held || 0) + (p.totals.review || 0)) warnings.push(el('div', { class: 'notice-box' }, `${fmt.number(p.totals.held || 0)} order ditahan dan ${fmt.number(p.totals.review || 0)} perlu diperiksa tidak ikut diproses.`));
  // Elemen fokus awal (tabindex -1) di atas: modal memfokuskan kontrol pertama; tanpa ini textarea di bawah
  // yang difokuskan sehingga isi modal langsung tergulir ke bawah.
  const body = el('div', { class: 'stack' },
    el('div', { class: 'proc-confirm-top', tabindex: -1 }),
    c.kv([
      ['Part', `${p.part_label || fmt.part(p.part)}${p.part_window ? ` (${p.part_window.start}–${p.part_window.end})` : ''}`],
      ['Gudang', p.warehouse_name || fmt.warehouse(p.warehouse)],
      ['Order', `${fmt.number(p.totals.orders)} order · ${fmt.number(p.totals.products)} produk`],
      ['PDF', `${fmt.number(pc.labels)} label + ${fmt.number(pc.lists)} product list`],
    ]),
    el('div', null, el('div', { class: 'label mb-2' }, 'Grup PDF'), groups),
    warnings.length ? el('div', { class: 'stack-sm' }, warnings) : null,
    c.field({ label: 'Catatan run', input: noteTa }),
    el('p', { class: 'text-sm text-muted' }, 'Shipment akan diatur di Shopee (arrange shipment) lalu label AWB diunduh dan digabung per kategori. Order yang sudah diproses tidak diulang.'));
  modal.open({
    title: `Proses ${fmt.number(p.totals.orders)} order & buat ${fmt.number(pc.total)} PDF?`, subtitle: `${p.part_label || fmt.part(p.part)} · ${p.warehouse_name || fmt.warehouse(p.warehouse)}`, size: 'md', body,
    actions: [
      { label: 'Batal', kind: 'secondary' },
      { label: 'Process & Buat PDF', kind: 'primary', icon: 'play', onClick: async () => {
        try {
          const r = await api.post('/api/process/run', { part: S.part, warehouse: S.warehouse, note: noteTa.value.trim() || undefined, ignore_sync_block: !!(p.blocked && S.ignoreBlock) });
          if (!S || !S.alive) return true;
          toast.success(`Run #${r.run_id} dimulai.`, { timeout: 2500 });
          openRunModal(r.run_id);
          return true;
        } catch (e) {
          if (e && e.status === 409 && e.details && e.details.run_id) { toast.warn(e.message); openRunModal(e.details.run_id); return true; }
          throw e;
        }
      } },
    ],
  });
}

// ---------------------------------------------------------------------------
// Run aktif & modal progres
// ---------------------------------------------------------------------------
async function checkActiveRun() {
  try {
    const r = await api.get('/api/process/active');
    if (S && S.alive && r && r.run_id) { S.activeRunId = r.run_id; openRunModal(r.run_id); }
  } catch { /* abaikan: modul mungkin belum ada */ }
}
function stopPolling() { if (S && S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

function openRunModal(runId) {
  if (!S || !S.alive) return;
  if (S.runModal) { const m = S.runModal; S.runModal = null; stopPolling(); m.close(); }
  S.runId = runId; S.activeRunId = runId; S.lastProgress = null; S.lastSig = null; S.pollBusy = false;
  const body = el('div', { class: 'proc-run stack' }, c.spinner({ label: 'Mengambil status run…' }));
  const handle = modal.open({
    title: `Run #${runId}`, subtitle: 'Memproses order & membuat PDF', size: 'lg', body, className: 'proc-run-dialog', dismissOnBackdrop: false,
    onClose: () => {
      if (!S) return;
      if (S.runModal === handle) S.runModal = null;
      stopPolling();
      const fin = S.lastProgress && S.lastProgress.finished;
      if (fin) S.activeRunId = null; else toast.info('Proses tetap berjalan di latar belakang.', { timeout: 3000 });
      if (S.alive) loadPreview();
    },
  });
  S.runModal = handle;
  renderBanners();
  startPolling(runId, body, handle);
}

function startPolling(runId, body, handle) {
  stopPolling();
  let failures = 0;
  S.pollBusy = false;
  const tick = async () => {
    if (!S || !S.alive || S.runId !== runId || S.runModal !== handle) { stopPolling(); return; }
    if (S.pollBusy) return; // permintaan sebelumnya belum selesai (server lambat) — jangan tumpuk
    S.pollBusy = true;
    try {
      const p = await api.get(`/api/process/runs/${runId}/progress`);
      if (!S || !S.alive || S.runId !== runId || S.runModal !== handle) return;
      failures = 0;
      S.lastProgress = p;
      // Gambar ulang hanya bila ada yang berubah (hindari kedip & reset scroll daftar error tiap 1,5 dtk).
      const sig = JSON.stringify([p.status, p.stage, p.done, p.total, p.current, p.active, (p.errors || []).length, (p.pdfs || []).length, p.finished, p.cancel_requested]);
      if (sig !== S.lastSig) { S.lastSig = sig; renderRunBody(body, handle, p); }
      if (p.finished) { stopPolling(); S.activeRunId = null; renderBanners(); }
    } catch (e) {
      failures++;
      if (e && e.status === 404) { stopPolling(); body.replaceChildren(c.emptyState({ icon: 'alertCircle', title: 'Run tidak ditemukan', text: e.message, size: 'sm' })); return; }
      if (failures >= 5) { stopPolling(); body.replaceChildren(c.alert({ tone: 'danger', title: 'Koneksi ke server terputus', text: api.errorMessage(e), actions: c.button({ label: 'Coba lagi', kind: 'danger', size: 'sm', icon: 'refresh', onClick: () => { S.lastSig = null; startPolling(runId, body, handle); } }) })); }
    } finally {
      if (S) S.pollBusy = false;
    }
  };
  tick();
  S.pollTimer = setInterval(tick, POLL_MS);
}

function pdfList(pdfs, { compact = false } = {}) {
  if (!pdfs || !pdfs.length) return el('div', { class: 'notice-box' }, compact ? 'Belum ada PDF yang dibuat.' : 'Tidak ada PDF yang dihasilkan.');
  return c.table({
    compact: true,
    columns: [
      { key: 'file_name', label: 'File PDF', render: (p) => el('div', null, el('div', { class: 'table-cell-main mono text-sm' }, p.file_name), el('div', { class: 'table-cell-sub' }, fmt.pdfLabel(p.file_name))) },
      // Di layar sempit kolom ini disembunyikan (label file sudah memuat part/jenis/kategori) agar tombol Unduh terlihat.
      { key: 'kind', label: 'Jenis', className: 'hide-mobile', headerClass: 'hide-mobile', render: (p) => (p.kind === 'productlist' ? c.badge({ text: 'Product List', tone: 'neutral', size: 'sm' }) : el('span', { class: 'row gap-1 wrap' }, c.badge({ status: p.ship_type, text: fmt.shipTypeShort(p.ship_type), size: 'sm' }), c.badge({ status: p.sku_category, text: fmt.categoryShort(p.sku_category), size: 'sm' }))) },
      { key: 'order_count', label: 'Order', align: 'right', className: 'hide-mobile', headerClass: 'hide-mobile', render: (p) => fmt.number(p.order_count) },
      { key: 'page_count', label: 'Hal.', align: 'right', className: 'hide-mobile', headerClass: 'hide-mobile', render: (p) => fmt.number(p.page_count) },
      { key: 'dl', label: '', align: 'right', render: (p) => el('div', { class: 'row-end gap-1' }, p.status && p.status !== 'ok' ? c.badge({ status: p.status, size: 'sm' }) : null, c.button({ label: 'Unduh', kind: 'soft', size: 'sm', icon: 'download', href: api.url(`/api/history/pdfs/${p.id}/download`) })) },
    ],
    rows: pdfs, rowKey: 'id',
  });
}
function errorList(errors) {
  return el('div', { class: 'proc-run-errors' }, errors.map((e) => el('div', { class: 'proc-run-error' }, icons.xCircle({ size: 15 }), el('span', { class: 'mono fw-600 nowrap' }, e.order_sn || 'Run'), el('span', { class: 'min-w-0 break' }, e.error || 'Gagal'))));
}

function renderRunBody(body, handle, p) {
  const isRegen = p.kind === 'regenerate';
  handle.setTitle(`Run #${p.run_id} · ${isRegen ? 'Buat ulang PDF' : 'Proses order'}`);
  const meta = el('div', { class: 'proc-run-head' },
    c.badge({ status: p.status, dot: true, size: 'lg', className: p.status === 'running' ? 'is-pulsing' : null }),
    el('span', { class: 'text-sm text-muted' }, `${fmt.part(p.part)} · ${fmt.warehouse(p.warehouse)} · mulai ${fmt.time(p.started_at)}${p.finished_at ? ` · selesai ${fmt.time(p.finished_at)} (${fmt.duration((p.finished_at || 0) - (p.started_at || 0))})` : ''}`),
    p.cancel_requested && !p.finished ? c.badge({ text: 'Pembatalan diminta', tone: 'warning' }) : null);

  if (!p.finished) {
    const bar = c.progressBar({ value: p.done, max: Math.max(p.total, 1), label: STAGE_LABEL[p.stage] || fmt.stage(p.stage), striped: true, size: 'lg', format: (v, m) => `${fmt.number(v)} / ${fmt.number(p.total)} order` });
    const active = (p.active || []).slice(0, 8);
    const current = el('div', { class: 'proc-run-current' }, c.spinner({ size: 'sm' }),
      el('div', { class: 'min-w-0 flex-1' },
        p.current ? el('div', null, 'Sedang: ', el('b', { class: 'mono' }, p.current.order_sn), ` — ${fmt.stage(p.current.stage)}`) : el('div', p.stage === 'pdf' ? 'Menggabung label menjadi PDF per kategori…' : 'Menunggu antrean order…'),
        active.length ? el('div', { class: 'chip-list mt-2' }, active.map((a) => c.badge({ text: `${a.order_sn} · ${fmt.stage(a.stage)}`, status: a.stage, size: 'sm' }))) : null));
    const cancelBtn = c.button({ label: 'Batalkan', kind: 'danger-soft', icon: 'stop', disabled: !!p.cancel_requested, onClick: async () => {
      const ok = await modal.confirm({ title: 'Batalkan run ini?', message: 'Order yang sedang berjalan akan diselesaikan; order yang belum mulai dilewati. PDF dibuat dari order yang sudah selesai.', confirmLabel: 'Ya, batalkan', danger: true });
      if (!ok) return;
      try { const r = await api.post(`/api/process/runs/${p.run_id}/cancel`); toast.info((r && r.message) || 'Pembatalan diminta'); } catch (e) { reportError(e, 'Gagal membatalkan'); }
    } });
    // mount() melewati null (replaceChildren native akan menulis teks "null")
    mount(body, meta, bar, current,
      p.pdfs && p.pdfs.length ? el('div', null, el('div', { class: 'label mb-2' }, `PDF dibuat (${fmt.number(p.pdfs.length)})`), pdfList(p.pdfs, { compact: true })) : null,
      p.errors && p.errors.length ? el('div', null, el('div', { class: 'label mb-2 text-danger' }, `Gagal (${fmt.number(p.errors.length)})`), errorList(p.errors)) : null,
      el('div', { class: 'proc-run-actions' }, cancelBtn, c.button({ label: 'Sembunyikan', kind: 'secondary', onClick: () => handle.close() })));
    return;
  }

  // ---- selesai ----
  const s = p.summary || {};
  const okN = s.ok !== undefined ? s.ok : Math.max(0, (p.total || 0) - (p.errors || []).length);
  const failedN = s.failed !== undefined ? s.failed : (p.errors || []).filter((e) => e.order_sn).length;
  const skippedN = s.skipped || 0;
  const statusTone = fmt.tone(p.status);
  const headline = { done: 'Semua order berhasil diproses', partial: 'Sebagian order gagal', failed: s.cancelled ? 'Run dibatalkan' : 'Run gagal', cancelled: 'Run dibatalkan' }[p.status] || fmt.runStatus(p.status);
  const result = el('div', { class: `proc-result-head tone-${statusTone}` },
    c.iconBox({ icon: p.status === 'done' ? 'checkCircle' : p.status === 'partial' ? 'alert' : 'xCircle', tone: statusTone, size: 'lg' }),
    el('div', { class: 'min-w-0 flex-1' }, el('div', { class: 'proc-result-title' }, headline), el('div', { class: 'text-sm text-muted' }, s.fatal ? s.fatal : `${fmt.number(okN)} berhasil · ${fmt.number(failedN)} gagal · ${fmt.number(skippedN)} dilewati · ${fmt.number((p.pdfs || []).length)} PDF`)),
    c.badge({ status: p.status, size: 'lg', dot: true }));
  const stats = el('div', { class: 'proc-result-stats' },
    resultStat('Berhasil', okN, 'success'), resultStat('Gagal', failedN, failedN ? 'danger' : 'neutral'), resultStat('Dilewati', skippedN, 'neutral'), resultStat('PDF', (p.pdfs || []).length, 'primary'));
  const failedErrors = (p.errors || []).filter((e) => e.order_sn);
  const otherErrors = (p.errors || []).filter((e) => !e.order_sn);
  const actions = el('div', { class: 'proc-run-actions' });
  if (failedN > 0 && !isRegen) actions.appendChild(c.button({ label: 'Buat ulang yang gagal', kind: 'primary', icon: 'refresh', onClick: async (e, btn) => {
    btn.setLoading(true);
    try { const r = await api.post(`/api/process/runs/${p.run_id}/regenerate`, { only_failed: true }); toast.success(`Run #${r.run_id} (buat ulang) dimulai.`); openRunModal(r.run_id); }
    catch (err) { reportError(err, 'Gagal memulai buat ulang'); btn.setLoading(false); }
  } }));
  else if (failedN > 0 && isRegen) actions.appendChild(c.button({ label: 'Coba ulang yang gagal', kind: 'primary', icon: 'refresh', onClick: async (e, btn) => {
    btn.setLoading(true);
    try { const r = await api.post(`/api/process/runs/${p.run_id}/regenerate`, { only_failed: true }); toast.success(`Run #${r.run_id} dimulai.`); openRunModal(r.run_id); }
    catch (err) { reportError(err, 'Gagal memulai buat ulang'); btn.setLoading(false); }
  } }));
  actions.appendChild(c.button({ label: 'Lihat di Riwayat', kind: 'secondary', icon: 'history', href: `#/history/${p.run_id}` }));
  actions.appendChild(c.button({ label: 'Tutup', kind: 'soft', onClick: () => handle.close() }));
  mount(body, meta, result, stats,
    el('div', null, el('div', { class: 'label mb-2' }, `PDF (${fmt.number((p.pdfs || []).length)})`), pdfList(p.pdfs)),
    failedErrors.length ? el('div', null, el('div', { class: 'label mb-2 text-danger' }, `Order gagal (${fmt.number(failedErrors.length)})`), errorList(failedErrors)) : null,
    otherErrors.length ? el('div', null, el('div', { class: 'label mb-2 text-danger' }, 'Kesalahan lain'), errorList(otherErrors)) : null,
    p.dropped && p.dropped.length ? el('div', { class: 'notice-box' }, `${fmt.number(p.dropped.length)} order dilewati karena sudah dibatalkan di marketplace.`) : null,
    el('div', { class: 'notice-box' }, 'PDF berhasil ≠ order sudah dikirim. Pastikan paket dan resi diserahkan ke kurir.'),
    actions);
}
function resultStat(label, value, tone) {
  return el('div', { class: `proc-result-stat tone-${tone}` }, el('div', { class: 'proc-result-stat-value' }, fmt.number(value)), el('div', { class: 'proc-result-stat-label' }, label));
}

export const page = { title, render, destroy };
export default page;
