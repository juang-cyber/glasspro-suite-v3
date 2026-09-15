/**
 * Galeri komponen (#/dev/gallery) — pamerkan semua komponen UI Glass Pro Suite
 * sebagai referensi visual & contoh pemakaian untuk halaman fitur.
 */
import { el, html, toast, modal, fmt, components as c, icons } from '../core.js';

const NOW = Math.floor(Date.now() / 1000);
let timers = [];

function section(title, code, ...body) {
  return el('section', { class: 'gallery-section' },
    el('div', { class: 'gallery-section-title' }, el('h2', title), code ? el('code', code) : null),
    ...body);
}
const demo = (...children) => el('div', { class: 'gallery-demo' }, ...children);

// ---------------------------------------------------------------------------
const SWATCHES = [
  ['--color-primary', 'primary'], ['--color-primary-hover', 'primary-hover'], ['--color-primary-soft', 'primary-soft'], ['--color-navy', 'navy'],
  ['--color-success', 'success'], ['--color-warning', 'warning'], ['--color-danger', 'danger'], ['--color-info', 'info'],
  ['--color-text', 'text'], ['--color-muted', 'muted'], ['--color-border', 'border'], ['--color-bg', 'bg'],
];
function swatches() {
  return el('div', { class: 'gallery-swatches' }, SWATCHES.map(([v, name]) => el('div', { class: 'gallery-swatch' },
    el('div', { class: 'gallery-swatch-color', style: { background: `var(${v})`, borderBottom: '1px solid var(--color-border)' } }),
    el('div', { class: 'gallery-swatch-name' }, name))));
}

// ---------------------------------------------------------------------------
function kpiRow() {
  return el('div', { class: 'kpi-row' },
    c.statCard({ label: 'Belum diproses', value: 42, delta: 12, deltaLabel: 'vs kemarin', icon: 'inbox', tone: 'primary', chart: { type: 'bar', values: [3, 5, 2, 8, 6, 9, 7, 11] } }),
    c.statCard({ label: 'Diproses hari ini', value: 128, delta: 8.5, deltaLabel: 'vs kemarin', icon: 'checkCircle', tone: 'success', chart: { type: 'line', values: [20, 34, 28, 45, 40, 52, 61] } }),
    c.statCard({ label: 'Perlu diperiksa', value: 7, delta: -3, deltaLabel: 'vs kemarin', icon: 'alert', tone: 'warning', chart: { type: 'bar', values: [9, 7, 12, 6, 8, 5, 7] } }),
    c.statCard({ label: 'Instant tertunda', value: 3, hint: 'Batas Part 3 pukul 16:00', icon: 'zap', tone: 'danger', chart: { type: 'line', values: [1, 4, 2, 6, 3, 5, 3] } }));
}

// ---------------------------------------------------------------------------
const GROUPS = [
  { key: 'instant-tg-jkt', title: 'Instant · TG · Jakarta', subtitle: '15092026-p1-ins-tg-jkt.pdf', icon: 'zap', value: 24, valueSub: '31 produk', badge: 'instant' },
  { key: 'instant-hg-jkt', title: 'Instant · HG · Jakarta', subtitle: '15092026-p1-ins-hg-jkt.pdf', icon: 'zap', value: 9, valueSub: '12 produk', badge: 'instant' },
  { key: 'regular-tg-sby', title: 'Regular · TG · Surabaya', subtitle: '15092026-p1-reg-tg-sby.pdf', icon: 'truck', value: 41, valueSub: '55 produk', badge: 'regular' },
  { key: 'regular-mix-jkt', title: 'Regular · Mix · Jakarta', subtitle: '15092026-p1-reg-mix-jkt.pdf', icon: 'layers', value: 6, valueSub: '14 produk', badge: { text: 'Mix', tone: 'warning' } },
  { key: 'productlist', title: 'Product List', subtitle: '15092026-p1-productlist-jkt.pdf', icon: 'list', value: 80, valueSub: '112 produk', badge: { text: 'Semua', tone: 'neutral' } },
];
function listDetail() {
  const detailTitle = el('div', { class: 'card-title' }, GROUPS[0].title);
  const detailSub = el('div', { class: 'card-subtitle' }, GROUPS[0].subtitle);
  const tiles = el('div', { class: 'glass-grid' });
  const renderTiles = (g) => {
    tiles.replaceChildren(
      c.glassTile({ label: 'Order', value: g.value, icon: 'orders' }),
      c.glassTile({ label: 'Produk', value: parseInt(g.valueSub, 10), icon: 'box' }),
      c.glassTile({ label: 'Gudang', value: g.title.split(' · ')[2] || '-', icon: 'warehouse' }),
      c.glassTile({ label: 'Part', value: 'Part 1', sub: '08:00–10:00', icon: 'clock' }));
  };
  renderTiles(GROUPS[0]);
  const progress = c.progressBar({ value: 18, max: 24, label: 'Label diunduh', tone: 'success' });
  const list = c.listPanel({
    items: GROUPS, selectedKey: GROUPS[0].key,
    onSelect: (it) => { detailTitle.textContent = it.title; detailSub.textContent = it.subtitle; renderTiles(it); progress.set(Math.round(it.value * 0.75), it.value); },
  });
  const dark = c.card({ tone: 'dark', title: 'Grup PDF Part 1', subtitle: 'Pilih grup untuk melihat detail', icon: 'pdf', body: list,
    actions: c.button({ label: 'Proses semua', kind: 'primary', size: 'sm', icon: 'play' }) });
  const gradient = el('div', { class: 'card card-gradient' },
    el('div', { class: 'card-header' },
      el('div', { class: 'row gap-3 min-w-0' }, c.iconBox({ icon: 'zap', tone: 'glass' }), el('div', { class: 'card-header-text' }, detailTitle, detailSub)),
      el('div', { class: 'card-actions' }, c.button({ label: 'Unduh', kind: 'glass', size: 'sm', icon: 'download' }))),
    el('div', { class: 'card-body stack' }, tiles, progress,
      el('div', { class: 'row gap-2 wrap' }, c.badge({ text: 'Shopee', tone: 'glass', className: 'badge-glass' }), c.badge({ text: '2 order ditahan', className: 'badge-glass' }), c.badge({ text: 'COD 3', className: 'badge-glass' }))),
    el('div', { class: 'card-footer text-sm', style: { color: 'rgba(255,255,255,.8)' } }, 'PDF berhasil ≠ order sudah dikirim. Pastikan resi diserahkan ke kurir.'));
  return el('div', { class: 'split' }, dark, gradient);
}

// ---------------------------------------------------------------------------
const ORDERS = [
  { order_sn: '2509150ABCD001', recipient_name: 'Siti Rahma', buyer_username: 'sitirahma', shipping_carrier: 'GrabExpress Instant', ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt', proc_status: 'unprocessed', order_status: 'READY_TO_SHIP', total_amount: 75000, ship_by_date: NOW + 3 * 3600, qty_total: 2, phone: 'iPhone 15 Pro Max' },
  { order_sn: '2509150ABCD002', recipient_name: 'Budi Santoso', buyer_username: 'budis', shipping_carrier: 'SPX Standard', ship_type: 'regular', sku_category: 'hg', warehouse_code: 'sby', proc_status: 'processed', order_status: 'PROCESSED', total_amount: 120000, ship_by_date: NOW + 40 * 3600, qty_total: 3, phone: 'Samsung S23 Ultra' },
  { order_sn: '2509150ABCD003', recipient_name: 'Dewi Lestari', buyer_username: 'dewil', shipping_carrier: 'GoSend Same Day', ship_type: 'instant', sku_category: 'mix', warehouse_code: 'jkt', proc_status: 'review', order_status: 'READY_TO_SHIP', total_amount: 98000, ship_by_date: NOW + 20 * 3600, qty_total: 4, phone: null },
  { order_sn: '2509150ABCD004', recipient_name: 'Andi Wijaya', buyer_username: 'andiw', shipping_carrier: 'J&T Express', ship_type: 'regular', sku_category: 'tg', warehouse_code: null, proc_status: 'failed', order_status: 'READY_TO_SHIP', total_amount: 45000, ship_by_date: NOW + 60 * 3600, qty_total: 1, phone: 'Xiaomi 13T' },
  { order_sn: '2509150ABCD005', recipient_name: 'Rina Kusuma', buyer_username: 'rinak', shipping_carrier: 'JNE Reguler', ship_type: 'regular', sku_category: 'hg', warehouse_code: 'sby', proc_status: 'cancelled', order_status: 'CANCELLED', total_amount: 60000, ship_by_date: NOW - 3600, qty_total: 2, phone: 'Oppo Reno 11' },
];
function tableDemo() {
  const tbl = c.table({
    columns: [
      { key: 'order_sn', label: 'No. Order', render: (r) => el('div', null, el('div', { class: 'table-cell-main mono' }, r.order_sn), el('div', { class: 'table-cell-sub' }, `@${r.buyer_username}`)) },
      { key: 'recipient_name', label: 'Penerima', render: (r) => el('div', null, el('div', { class: 'table-cell-main' }, r.recipient_name), el('div', { class: 'table-cell-sub' }, r.phone || el('span', { class: 'text-danger fw-600' }, 'Tipe HP belum ditulis'))) },
      { key: 'shipping_carrier', label: 'Kurir', render: (r) => el('div', null, el('div', null, r.shipping_carrier), c.badge({ status: r.ship_type, size: 'sm', text: fmt.shipTypeShort(r.ship_type) })) },
      { key: 'sku_category', label: 'Kategori', render: (r) => c.badge({ status: r.sku_category, text: fmt.categoryShort(r.sku_category) }) },
      { key: 'warehouse_code', label: 'Gudang', render: (r) => (r.warehouse_code ? fmt.warehouse(r.warehouse_code) : c.badge({ text: 'Tidak diketahui', tone: 'warning' })) },
      { key: 'ship_by_date', label: 'Batas kirim', render: (r) => el('span', { class: r.ship_by_date - NOW < 5 * 3600 ? 'text-danger fw-600' : '' }, fmt.hoursLeft((r.ship_by_date - NOW) / 3600)) },
      { key: 'total_amount', label: 'Total', align: 'right', render: (r) => fmt.currency(r.total_amount) },
      { key: 'proc_status', label: 'Status', render: (r) => c.badge({ status: r.proc_status, dot: true }) },
    ],
    rows: ORDERS, rowKey: 'order_sn', selectedKey: ORDERS[0].order_sn,
    onRowClick: (row) => { tbl.setSelected(row.order_sn); toast.info(`Order ${row.order_sn} dipilih`, { timeout: 1500 }); },
  });
  const pager = c.pagination({ page: 1, total: 123, limit: 20, noun: 'order', onChange: (p) => toast.info(`Halaman ${p}`, { timeout: 1200 }) });
  return c.card({ title: 'Daftar order', subtitle: 'Klik baris untuk memilih', flush: true,
    actions: [c.searchInput({ placeholder: 'Cari order…', size: 'sm', width: 220 }), c.select({ options: [{ value: 'all', label: 'Semua gudang' }, { value: 'jkt', label: 'Jakarta' }, { value: 'sby', label: 'Surabaya' }], value: 'all', size: 'sm', inline: true })],
    body: [tbl, el('div', { style: { padding: '12px var(--card-pad) 0' } }, pager)] });
}

// ---------------------------------------------------------------------------
function badges() {
  const groups = [
    ['Status proses', ['unprocessed', 'processing', 'processed', 'failed', 'review', 'cancelled']],
    ['Status Shopee', ['READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'IN_CANCEL', 'CANCELLED', 'COMPLETED']],
    ['Run / PDF / Sync', ['running', 'done', 'partial', 'ok', 'stale', 'never']],
    ['Jenis & kategori', ['instant', 'regular', 'tg', 'hg', 'mix', 'jkt', 'sby', 'p1', 'p2', 'p3']],
    ['Kode hold / warning', ['PHONE_TYPE_MISSING', 'SKU_UNKNOWN', 'WAREHOUSE_UNKNOWN', 'ALREADY_PROCESSED', 'DEADLINE_EXCEPTION', 'COD']],
  ];
  return el('div', { class: 'stack' },
    groups.map(([label, list]) => el('div', { class: 'row-start gap-3 wrap' }, el('span', { class: 'label', style: { minWidth: '150px', paddingTop: '4px' } }, label), el('div', { class: 'chip-list' }, list.map((s) => c.badge({ status: s, dot: true }))))),
    el('div', { class: 'row-start gap-3 wrap' }, el('span', { class: 'label', style: { minWidth: '150px', paddingTop: '4px' } }, 'Varian'), el('div', { class: 'chip-list' },
      c.badge({ text: 'Solid sukses', tone: 'success', solid: true }), c.badge({ text: 'Solid bahaya', tone: 'danger', solid: true }), c.badge({ text: 'Solid utama', tone: 'primary', solid: true }),
      c.badge({ text: 'Kecil', tone: 'info', size: 'sm' }), c.badge({ text: 'Besar', tone: 'primary', size: 'lg', icon: 'shopee' }), c.badge({ text: 'Gelap', tone: 'dark' }))),
    el('div', { class: 'row-start gap-3 wrap' }, el('span', { class: 'label', style: { minWidth: '150px', paddingTop: '8px' } }, 'Pill'), el('div', { class: 'pill-group' },
      c.pill({ text: 'Semua', count: 128, active: true, onClick: () => {} }), c.pill({ text: 'Instant', icon: 'zap', count: 24, onClick: () => {} }), c.pill({ text: 'Regular', icon: 'truck', count: 104, onClick: () => {} }),
      c.pill({ text: 'Sukses', tone: 'success' }), c.pill({ text: 'Peringatan', tone: 'warning' }), c.pill({ text: 'Gagal', tone: 'danger' }), c.pill({ text: 'Gelap', tone: 'dark' }))),
    el('div', { class: 'row-start gap-3 wrap' }, el('span', { class: 'label', style: { minWidth: '150px', paddingTop: '2px' } }, 'Titik status'), el('div', { class: 'row gap-4 wrap' },
      ['success', 'warning', 'danger', 'info', 'primary', 'neutral'].map((t) => el('span', { class: 'row gap-2 text-sm' }, c.statusDot(t), t)), el('span', { class: 'row gap-2 text-sm' }, c.statusDot('primary', { pulsing: true }), 'pulsing'))));
}

// ---------------------------------------------------------------------------
function buttons() {
  const loadingBtn = c.button({ label: 'Memproses…', kind: 'primary', loading: true });
  return el('div', { class: 'stack' },
    demo(c.button({ label: 'Primary', kind: 'primary', icon: 'play' }), c.button({ label: 'Secondary', kind: 'secondary' }), c.button({ label: 'Soft', kind: 'soft', icon: 'download' }), c.button({ label: 'Ghost', kind: 'ghost' }),
      c.button({ label: 'Danger', kind: 'danger', icon: 'trash' }), c.button({ label: 'Danger soft', kind: 'danger-soft' }), c.button({ label: 'Success', kind: 'success', icon: 'check' }), c.button({ label: 'Dark', kind: 'dark' }), c.button({ label: 'Disabled', kind: 'primary', disabled: true }), loadingBtn),
    demo(c.button({ label: 'Kecil', kind: 'primary', size: 'sm', icon: 'plus' }), c.button({ label: 'Sedang', kind: 'secondary' }), c.button({ label: 'Besar', kind: 'primary', size: 'lg', iconRight: 'arrowRight' }),
      c.iconButton({ icon: 'sync', title: 'Sync', kind: 'secondary' }), c.iconButton({ icon: 'bell', title: 'Notifikasi', kind: 'secondary', badge: true }), c.iconButton({ icon: 'edit', title: 'Ubah', kind: 'soft', size: 'sm' }), c.iconButton({ icon: 'trash', title: 'Hapus', kind: 'danger-soft', size: 'sm' }),
      el('div', { class: 'card card-dark', style: { padding: '10px 14px', borderRadius: '16px' } }, demo(c.button({ label: 'Glass', kind: 'glass', icon: 'download' }), c.button({ label: 'Primary', kind: 'primary', size: 'sm' })))),
    demo(c.link({ label: 'Tautan teks', icon: 'arrowRight', href: '#/dev/gallery' }), c.link({ label: 'Buka Shopee Seller', href: 'https://seller.shopee.co.id', external: true }), c.kbd('Enter'), c.kbd('Esc'), c.copyable('2509150ABCD001')));
}

// ---------------------------------------------------------------------------
function tabsDemo() {
  const content = el('div', { class: 'notice-box mt-3' }, 'Tab aktif: semua');
  const t = c.tabs({ items: [{ key: 'all', label: 'Semua', count: 128, icon: 'list' }, { key: 'held', label: 'Ditahan', count: 5, tone: 'danger' }, { key: 'review', label: 'Perlu diperiksa', count: 7, tone: 'warning' }, { key: 'excluded', label: 'Dikeluarkan', count: 0 }], active: 'all', onChange: (k) => { content.textContent = `Tab aktif: ${k}`; } });
  const t2 = c.tabs({ items: [{ key: 'p1', label: 'Part 1' }, { key: 'p2', label: 'Part 2' }, { key: 'p3', label: 'Part 3' }], active: 'p2', dark: true, size: 'sm' });
  return el('div', null, demo(t, t2), content);
}

// ---------------------------------------------------------------------------
function formDemo() {
  const f1 = c.field({ label: 'Nama toko', input: c.input({ placeholder: 'Glass Pro Official', icon: 'store', value: 'Glass Pro Official (Mock)' }), hint: 'Nama sesuai Shopee Seller Centre', required: true });
  const f2 = c.field({ label: 'Partner ID', input: c.input({ placeholder: '2000000', mono: true, value: '2001234' }), error: 'Partner ID tidak valid' });
  const f3 = c.field({ label: 'Gudang default', input: c.select({ options: [{ value: 'jkt', label: 'Jakarta' }, { value: 'sby', label: 'Surabaya' }], value: 'jkt' }) });
  const f4 = c.field({ label: 'Metode pengiriman', input: c.select({ options: [{ value: 'auto', label: 'Otomatis (ikuti Shopee)' }, { value: 'pickup', label: 'Pickup' }, { value: 'dropoff', label: 'Drop-off' }], placeholder: 'Pilih metode' }) });
  const f5 = c.field({ label: 'Catatan proses', input: c.textarea({ placeholder: 'Catatan opsional untuk run ini…', rows: 3 }), hint: 'Ditampilkan di riwayat' });
  const f6 = c.field({ label: 'Password', input: c.input({ type: 'password', placeholder: '••••••••', icon: 'lock', suffix: c.iconButton({ icon: 'eye', kind: 'ghost', size: 'sm', title: 'Lihat' }) }) });
  const toggles = el('div', { class: 'stack-sm' },
    c.toggle({ label: 'Sync otomatis aktif', checked: true, onChange: (v) => toast.info(`Sync otomatis: ${v ? 'aktif' : 'nonaktif'}`, { timeout: 1200 }) }),
    c.toggle({ label: 'Tarik juga order yang berubah', checked: false }),
    c.toggle({ label: 'Nonaktif', checked: true, disabled: true }),
    c.checkbox({ label: 'Tetap proses walau sync terakhir gagal', checked: false }),
    c.checkbox({ label: 'Sertakan order yang sudah diproses', checked: true }));
  const search = c.searchInput({ placeholder: 'Cari order, nama, atau SKU…', onSearch: (q) => { if (q) toast.info(`Mencari "${q}"`, { timeout: 1200 }); } });
  return el('div', { class: 'stack' },
    el('div', { class: 'form-grid' }, f1, f2, f3, f4, f6, c.field({ label: 'Toggle & checkbox', input: toggles }), el('div', { class: 'span-2' }, f5)),
    el('div', { class: 'row gap-3 wrap' }, search, c.select({ options: ['Semua', 'Instant', 'Regular'], value: 'Semua', inline: true, size: 'sm' }), c.input({ placeholder: 'Input kecil', size: 'sm', icon: 'search' })),
    el('div', { class: 'form-actions' }, c.button({ label: 'Batal', kind: 'secondary' }), c.button({ label: 'Simpan pengaturan', kind: 'primary', icon: 'save', onClick: () => toast.success('Pengaturan disimpan (demo)') })));
}

// ---------------------------------------------------------------------------
function feedbackDemo() {
  return el('div', { class: 'stack' },
    demo(
      c.button({ label: 'Toast sukses', kind: 'success', size: 'sm', onClick: () => toast.success('Sync selesai: 12 order ditarik, 3 baru.', { title: 'Sinkronisasi berhasil' }) }),
      c.button({ label: 'Toast error', kind: 'danger', size: 'sm', onClick: () => toast.error('Gagal memproses order 2509150ABCD004: shipping parameter tidak tersedia.') }),
      c.button({ label: 'Toast peringatan', kind: 'secondary', size: 'sm', onClick: () => toast.warn('PDF tidak sesuai, perlu dibuat ulang.', { action: { label: 'Buat ulang', onClick: () => toast.info('Regenerate dimulai (demo)') } }) }),
      c.button({ label: 'Toast info', kind: 'secondary', size: 'sm', onClick: () => toast.info('Sinkronisasi sedang berjalan di latar belakang.') }),
      el('span', { class: 'text-muted text-sm' }, '·'),
      c.button({ label: 'Modal konfirmasi', kind: 'primary', size: 'sm', onClick: async () => { const ok = await modal.confirm({ title: 'Proses 24 order Part 1?', message: 'Shipment akan diatur di Shopee dan PDF label dibuat per kategori. Order yang sudah diproses tidak akan diulang.', confirmLabel: 'Proses sekarang' }); toast.info(ok ? 'Dikonfirmasi' : 'Dibatalkan', { timeout: 1200 }); } }),
      c.button({ label: 'Modal bahaya', kind: 'danger-soft', size: 'sm', onClick: async () => { const ok = await modal.confirm({ title: 'Reset order ini?', message: 'Order akan kembali ke status Belum diproses. PDF yang sudah dibuat tidak dihapus.', confirmLabel: 'Ya, reset', danger: true }); if (ok) toast.success('Order direset (demo)'); } }),
      c.button({ label: 'Modal form', kind: 'secondary', size: 'sm', onClick: () => modal.open({
        title: 'Koreksi manual', subtitle: 'Order 2509150ABCD003', size: 'md',
        body: el('div', { class: 'stack' },
          c.field({ label: 'Kategori SKU', input: c.select({ options: [{ value: 'tg', label: 'TG · Tempered Glass' }, { value: 'hg', label: 'HG · Hydrogel' }, { value: 'mix', label: 'Mix' }], value: 'mix' }) }),
          c.field({ label: 'Tipe HP', input: c.input({ placeholder: 'mis. iPhone 15 Pro Max' }) }),
          c.checkbox({ label: 'Paksa proses (abaikan hold tipe HP / SKU)' })),
        actions: [{ label: 'Batal', kind: 'secondary' }, { label: 'Simpan', kind: 'primary', icon: 'save', onClick: async () => { await new Promise((r) => setTimeout(r, 700)); toast.success('Koreksi disimpan (demo)'); } }],
      }) }),
      c.button({ label: 'Modal prompt', kind: 'secondary', size: 'sm', onClick: async () => { const v = await modal.prompt({ title: 'Catatan run', label: 'Catatan', placeholder: 'Opsional…' }); if (v !== null) toast.info(`Catatan: ${v || '(kosong)'}`, { timeout: 1500 }); } })),
    el('div', { class: 'stack-sm' },
      c.alert({ tone: 'info', title: 'Sinkronisasi berjalan', text: 'Order terbaru akan muncul dalam beberapa detik.' }),
      c.alert({ tone: 'success', text: 'Semua label Part 1 berhasil dibuat.', dismissible: true }),
      c.alert({ tone: 'warning', title: 'Sync terakhir gagal', text: 'Preview memakai data dari sync terakhir yang sukses (10 mnt lalu).', actions: c.button({ label: 'Coba lagi', kind: 'secondary', size: 'sm', icon: 'refresh' }) }),
      c.alert({ tone: 'danger', title: 'Toko Shopee belum terhubung', text: 'Hubungkan toko di Pengaturan sebelum memproses order.', actions: c.button({ label: 'Hubungkan', kind: 'danger', size: 'sm' }) })));
}

// ---------------------------------------------------------------------------
function stateDemo() {
  const p1 = c.progressBar({ value: 18, max: 24, label: 'Memproses order', format: (v, m) => `${v} / ${m} order` });
  const p2 = c.progressBar({ value: 65, tone: 'success', label: 'Selesai', size: 'lg', striped: true });
  const p3 = c.progressBar({ value: 30, tone: 'warning', size: 'sm', showValue: false });
  const p4 = c.progressBar({ indeterminate: true, label: 'Menunggu dokumen Shopee…', showValue: false });
  let v = 18;
  timers.push(setInterval(() => { v = v >= 24 ? 0 : v + 1; p1.set(v, 24); }, 900));
  return el('div', { class: 'grid-3' },
    c.card({ title: 'Progress', body: el('div', { class: 'stack' }, p1, p2, p3, p4) }),
    c.card({ title: 'Skeleton', body: el('div', { class: 'stack' }, c.skeleton(4), c.skeleton(2, { kind: 'list' }), c.skeleton(3, { kind: 'table' })) }),
    c.card({ title: 'Empty state', flush: true, body: c.emptyState({ icon: 'inbox', title: 'Belum ada order', text: 'Jalankan sync untuk menarik order Siap Kirim dari Shopee.', action: { label: 'Sync sekarang', icon: 'sync', onClick: () => toast.info('Sync (demo)') } }) }),
    c.card({ title: 'Spinner', body: demo(c.spinner({ size: 'sm' }), c.spinner(), c.spinner({ size: 'lg' }), c.spinner({ label: 'Memuat preview…' })) }),
    c.card({ tone: 'dark', title: 'Empty state gelap', body: c.emptyState({ icon: 'pdf', title: 'Belum ada PDF', text: 'PDF akan muncul setelah proses selesai.', size: 'sm' }) }),
    c.card({ title: 'Avatar', body: demo(c.avatar({ name: 'Admin Glass Pro', size: 'xs' }), c.avatar({ name: 'Budi Santoso', size: 'sm' }), c.avatar({ name: 'Dewi Lestari' }), c.avatar({ name: 'Rina Kusuma', size: 'lg' }), c.avatar({ name: 'Glass Pro', size: 'xl', tone: 'primary' }), c.avatar({ icon: 'user', size: 'lg', tone: 'soft' }), c.avatar({ icon: 'store', size: 'md', square: true, tone: 'primary' })) }));
}

// ---------------------------------------------------------------------------
function miscDemo() {
  const tl = c.timeline([
    { title: 'Run #42 selesai', sub: '24 order · 6 PDF · Part 1 · Jakarta', tone: 'success', icon: 'check', time: fmt.time(NOW - 600) },
    { title: 'Label diunduh', sub: '2509150ABCD002 · SPX Standard', icon: 'download', time: fmt.time(NOW - 900) },
    { title: 'Shipment diatur', sub: '2509150ABCD001 · GrabExpress Instant · pickup', icon: 'truck', time: fmt.time(NOW - 1200) },
    { title: 'Order gagal', sub: '2509150ABCD004 · shipping parameter tidak tersedia', tone: 'danger', icon: 'x', time: fmt.time(NOW - 1500) },
    { title: 'Run #42 dimulai oleh Admin', sub: 'Part 1 · Semua gudang', icon: 'play', time: fmt.time(NOW - 1800) },
  ]);
  const kv = c.kv([
    ['No. Order', c.copyable('2509150ABCD001')], ['Penerima', 'Siti Rahma · 0812-3456-7890'], ['Alamat', 'Jl. Melati No. 2, Kebayoran Baru, Jakarta Selatan 12160'],
    ['Kurir', el('span', { class: 'row gap-2' }, 'GrabExpress Instant', c.badge({ status: 'instant', size: 'sm' }))], ['Batas kirim', el('span', { class: 'text-danger fw-600' }, fmt.hoursLeft(3.5))], ['Total', fmt.currency(75000)],
  ]);
  const kvStacked = c.kv([['Part', 'Part 1 (08:00–10:00)'], ['Gudang', 'Jakarta'], ['Dibuat oleh', 'Admin Glass Pro'], ['Dibuat', fmt.datetime(NOW - 600)]], { stacked: true });
  const menuTrigger = c.button({ label: 'Menu dropdown', kind: 'secondary', iconRight: 'chevronDown' });
  const dd = c.dropdown({ trigger: menuTrigger, align: 'left', header: { title: 'Admin Glass Pro', sub: 'Admin · @admin' }, items: [
    { label: 'Lihat detail', icon: 'eye', onClick: () => toast.info('Detail (demo)', { timeout: 1000 }) }, { label: 'Koreksi manual', icon: 'edit' }, { divider: true }, { label: 'Reset order', icon: 'undo', danger: true }] });
  return el('div', { class: 'grid-3' },
    c.card({ title: 'Timeline', body: tl }),
    c.card({ title: 'Key-value', body: el('div', { class: 'stack' }, kv, c.divider('Ringkas'), kvStacked) }),
    c.card({ title: 'Lain-lain', body: el('div', { class: 'stack' }, demo(dd, c.iconBox({ icon: 'pdf' }), c.iconBox({ icon: 'zap', tone: 'warning' }), c.iconBox({ icon: 'check', tone: 'success', size: 'lg' })),
      el('div', { class: 'notice-box' }, 'Kotak catatan: PDF berhasil ≠ order sudah dikirim.'),
      el('div', { class: 'card card-soft card-sm' }, el('div', { class: 'fw-600' }, 'Kartu lembut'), el('div', { class: 'text-sm text-muted' }, 'Latar indigo lembut untuk sorotan ringan.')),
      c.pageHeader({ title: 'Judul halaman', subtitle: 'Contoh pageHeader dengan eyebrow dan meta', eyebrow: 'Process Order', back: { label: 'Kembali', href: '#/dev/gallery' }, meta: [el('span', null, icons.clock({ size: 14 }), 'Part 1 · 08:00–10:00'), el('span', null, icons.warehouse({ size: 14 }), 'Jakarta')], actions: c.button({ label: 'Aksi', kind: 'primary', size: 'sm' }) })) }));
}

// ---------------------------------------------------------------------------
function iconsDemo() {
  return el('div', { class: 'gallery-icons' }, icons.names.map((n) => el('div', { class: 'gallery-icon', title: n }, icons.get(n, { size: 20 }), el('span', { class: 'truncate w-full text-center' }, n))));
}

function typography() {
  return c.card({ body: el('div', { class: 'stack-sm' },
    el('h1', 'Heading 1 — Overview'), el('h2', 'Heading 2 — Bagian'), el('h3', 'Heading 3 — Kartu'), el('h4', 'Heading 4 — Sub'),
    el('p', 'Teks paragraf 14px Inter. Semua waktu dalam WIB (Asia/Jakarta). ', el('a', { href: '#/dev/gallery' }, 'Tautan'), ' · ', el('span', { class: 'text-muted' }, 'muted'), ' · ', el('code', 'kode mono'), ' · ', el('span', { class: 'label' }, 'label kecil')),
    el('p', { class: 'text-sm text-muted' }, `fmt: ${fmt.datetime(NOW)} · ${fmt.relative(NOW - 120)} · ${fmt.currency(1234500)} · ${fmt.number(1234567)} · ${fmt.duration(3725)} · ${fmt.pdfLabel('15092026-p1-ins-tg-jkt.pdf')}`)) });
}

// ---------------------------------------------------------------------------
export const title = 'Galeri Komponen';

export function render(container) {
  destroy();
  container.replaceChildren(
    c.pageHeader({ title: 'Galeri Komponen', subtitle: 'Referensi visual semua komponen UI Glass Pro Suite — dipakai halaman fitur lewat core.js', eyebrow: 'Dev', actions: [c.badge({ text: 'dev/gallery', tone: 'primary', icon: 'grid', size: 'lg' })] }),
    section('Warna', 'tokens.css', swatches()),
    section('Tipografi & fmt', 'fmt.js', typography()),
    section('KPI', 'components.statCard({ chart })', kpiRow()),
    section('Panel daftar gelap + detail gradien', 'card({tone:"dark"}) · listPanel · card({tone:"gradient"}) · glassTile', listDetail()),
    section('Tabel', 'components.table · pagination · searchInput · select', tableDemo()),
    section('Badge, pill, status', 'badge({ status }) · pill · statusDot', c.card({ body: badges() })),
    section('Tombol', 'button · iconButton · link · kbd · copyable', c.card({ body: buttons() })),
    section('Tabs', 'components.tabs', c.card({ body: tabsDemo() })),
    section('Form', 'field · input · select · textarea · toggle · checkbox', c.card({ body: formDemo() })),
    section('Toast, modal, alert', 'toast.* · modal.* · alert', c.card({ body: feedbackDemo() })),
    section('Progress, skeleton, empty state, spinner, avatar', 'progressBar · skeleton · emptyState · spinner · avatar', stateDemo()),
    section('Timeline, key-value, dropdown, pageHeader', 'timeline · kv · dropdown · pageHeader', miscDemo()),
    section('Ikon', 'icons.<nama>({ size })', iconsDemo()),
    html`<p class="text-sm text-muted text-center mt-6">Glass Pro Suite · galeri komponen · ${fmt.date(NOW, 'weekday')}</p>`);
}

export function destroy() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

export const page = { title, render, destroy };
export default page;
