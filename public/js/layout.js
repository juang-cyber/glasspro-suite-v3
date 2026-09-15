/**
 * layout — shell aplikasi: top bar putih 64px (logo + "Glass Pro Suite"), nav pil gelap di tengah,
 * kanan: indikator sync (GET /api/sync/status tiap 30 dtk), tombol "Sync sekarang" (POST /api/sync/now),
 * avatar user + menu (Pengaturan, Keluar). Halaman login dirender tanpa shell.
 *
 *   import { layout } from './layout.js';
 *   router.configure({ layout });           // layout(route) → elemen slot tempat halaman dirender
 *   layout.refreshSync();                   // paksa muat ulang status sync
 *   layout.syncNow();                       // jalankan sync manual (sama seperti tombol di top bar)
 *   layout.setNavBadge('process', 3);       // angka kecil merah di item nav (null = sembunyikan)
 */
import { api, router, store, el, toast, fmt, components as c, icons, userName, reportError } from './core.js';

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Overview', href: '#/', icon: 'home', match: (p) => p === '/' },
  { key: 'process', label: 'Process Order', href: '#/process', icon: 'process', match: (p) => p.startsWith('/process') },
  { key: 'orders', label: 'Pesanan', href: '#/orders', icon: 'orders', match: (p) => p.startsWith('/orders') },
  { key: 'history', label: 'Riwayat', href: '#/history', icon: 'history', match: (p) => p.startsWith('/history') },
  { key: 'settings', label: 'Pengaturan', href: '#/settings', icon: 'settings', match: (p) => p.startsWith('/settings') },
];
const SYNC_POLL_MS = 30000;

let shellEl = null;
let slotEl = null;
let navLinks = new Map();
let syncDot = null;
let syncText = null;
let syncBtn = null;
let syncIndicator = null;
let userTrigger = null;
let userDropdown = null;
let syncTimer = null;
let syncing = false;
let unsubUser = null;
let visibilityHandler = null;

/** Elemen mount utama (#app). */
function appRoot() { return document.getElementById('app') || document.body; }

// ----------------------------------------------------------------------------
// Bangun shell
// ----------------------------------------------------------------------------
function buildShell() {
  destroyShell();
  const app = appRoot();

  // Brand
  const brand = el('a', { class: 'brand', href: '#/', 'aria-label': 'Glass Pro Suite — Overview' },
    el('span', { class: 'brand-mark' }, icons.logo({ size: 20, strokeWidth: 2 })),
    el('span', { class: 'brand-text' }, 'Glass Pro Suite'));

  // Nav pil gelap
  navLinks = new Map();
  const nav = el('nav', { class: 'nav', 'aria-label': 'Navigasi utama' });
  for (const it of NAV_ITEMS) {
    // title + aria-label: di mobile label item non-aktif disembunyikan (hanya ikon), nama tetap terbaca.
    const a = el('a', { class: 'nav-item', href: it.href, dataset: { nav: it.key }, title: it.label, 'aria-label': it.label }, icons.get(it.icon, { size: 16 }), el('span', it.label));
    navLinks.set(it.key, a);
    nav.appendChild(a);
  }

  // Indikator sync + tombol sync
  syncDot = el('span', { class: 'status-dot tone-neutral' });
  syncText = el('span', { class: 'sync-text' }, 'Sync —');
  syncIndicator = el('button', { class: 'sync-indicator', type: 'button', title: 'Status sinkronisasi Shopee' }, syncDot, syncText, icons.chevronDown({ size: 14 }));
  const syncMenu = c.dropdown({
    trigger: syncIndicator, width: 280,
    items: () => syncMenuItems(),
  });
  syncBtn = c.iconButton({ icon: 'sync', title: 'Sync sekarang', kind: 'secondary', onClick: () => syncNow() });

  // Menu user
  userTrigger = el('button', { class: 'user-menu-trigger', type: 'button', title: 'Akun' });
  renderUserTrigger();
  userDropdown = c.dropdown({
    trigger: userTrigger, width: 220,
    items: () => [
      { label: 'Pengaturan', icon: 'cog', href: '#/settings' },
      { label: 'Riwayat proses', icon: 'history', href: '#/history' },
      { divider: true },
      { label: 'Keluar', icon: 'logout', danger: true, onClick: () => logout() },
    ],
  });
  // dropdown() menerima header objek/Node; kita butuh header dinamis → bungkus saat open.
  patchDynamicHeader(syncMenu, () => syncMenuHeader());
  patchDynamicHeader(userDropdown, () => ({ title: userName() || '-', sub: `${fmt.role(store.user && store.user.role)} · @${(store.user && store.user.username) || '-'}` }));

  const right = el('div', { class: 'topbar-right' }, syncMenu, syncBtn, userDropdown);
  const topbar = el('header', { class: 'topbar' }, el('div', { class: 'topbar-inner' }, brand, nav, right));

  slotEl = el('main', { class: 'page-container', id: 'page-slot' });
  shellEl = el('div', { class: 'shell' }, topbar, slotEl);
  app.replaceChildren(shellEl);

  // Perbarui avatar/nama ketika user berubah
  unsubUser = store.subscribe('user', () => { if (shellEl) renderUserTrigger(); });

  // Polling status sync (berhenti saat tab disembunyikan)
  startSyncPolling();
  visibilityHandler = () => { if (document.hidden) stopSyncPolling(); else startSyncPolling(); };
  document.addEventListener('visibilitychange', visibilityHandler);
}

/** dropdown() dari components membaca `header` sekali saat build; kita ingin isi dinamis → ganti opsi lewat onOpen. */
function patchDynamicHeader(dd, headerFn) {
  const menu = dd.querySelector('.menu');
  const origOpen = dd.open;
  dd.open = () => {
    origOpen();
    const h = headerFn();
    const old = menu.querySelector('.menu-header');
    if (old) old.remove();
    if (h) {
      const node = h instanceof Node ? h : el('div', { class: 'menu-header' }, el('div', { class: 'menu-header-title' }, h.title), h.sub ? el('div', { class: 'menu-header-sub' }, h.sub) : null);
      menu.prepend(node);
    }
  };
}

function destroyShell() {
  stopSyncPolling();
  if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null; }
  if (unsubUser) { unsubUser(); unsubUser = null; }
  if (shellEl && shellEl.isConnected) shellEl.remove();
  shellEl = null; slotEl = null; navLinks = new Map();
  syncDot = syncText = syncBtn = syncIndicator = userTrigger = userDropdown = null;
}

function renderUserTrigger() {
  if (!userTrigger) return;
  const u = store.user;
  userTrigger.replaceChildren(
    c.avatar({ name: userName(u) || '?', size: 'sm', tone: 'auto' }),
    el('span', { class: 'user-menu-name truncate' }, userName(u) || 'Pengguna'),
    icons.chevronDown({ size: 14 }));
}

// ----------------------------------------------------------------------------
// Nav aktif
// ----------------------------------------------------------------------------
function setActive(route) {
  const path = route ? route.path : '/';
  for (const it of NAV_ITEMS) {
    const a = navLinks.get(it.key);
    if (!a) continue;
    const on = it.match(path);
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

/** Badge angka kecil pada item nav (mis. jumlah order perlu diperiksa). null/0 → sembunyikan. */
export function setNavBadge(key, count) {
  const a = navLinks.get(key);
  if (!a) return;
  let b = a.querySelector('.nav-item-badge');
  if (!count) { if (b) b.remove(); return; }
  if (!b) { b = el('span', { class: 'nav-item-badge' }); a.appendChild(b); }
  b.textContent = count > 99 ? '99+' : String(count);
}

// ----------------------------------------------------------------------------
// Sync
// ----------------------------------------------------------------------------
function startSyncPolling() {
  stopSyncPolling();
  refreshSync();
  syncTimer = setInterval(refreshSync, SYNC_POLL_MS);
}
function stopSyncPolling() { if (syncTimer) { clearInterval(syncTimer); syncTimer = null; } }

/** Muat status sync dari server dan perbarui indikator. Error diabaikan (modul mungkin belum ada). */
export async function refreshSync() {
  if (!shellEl) return null;
  try {
    const s = await api.get('/api/sync/status');
    store.sync = s;
    renderSync(s);
    return s;
  } catch (e) {
    if (e && e.status === 401) return null;
    renderSync(null, e);
    return null;
  }
}

function syncSummary(s) {
  if (!s) return { tone: 'neutral', text: 'Sync —', detail: 'Status sync tidak tersedia', pulsing: false };
  const shopee = (s.marketplaces && s.marketplaces.shopee) || {};
  if (s.running) return { tone: 'primary', text: 'Sedang sync…', detail: 'Sinkronisasi sedang berjalan', pulsing: true };
  if (!shopee.connected) return { tone: 'neutral', text: 'Belum terhubung', detail: 'Toko Shopee belum dihubungkan. Buka Pengaturan untuk menghubungkan.', pulsing: false };
  if (shopee.status === 'failed') {
    const okAt = shopee.last_ok_at ? ` Sukses terakhir ${fmt.relative(shopee.last_ok_at)}.` : ' Belum pernah sukses.';
    return { tone: 'danger', text: 'Sync gagal', detail: `${shopee.last_error || 'Sinkronisasi terakhir gagal.'}${okAt}`, pulsing: false };
  }
  if (shopee.status === 'ok' && shopee.last_ok_at) {
    const stale = s.interval_minutes && (Date.now() / 1000 - shopee.last_ok_at) > s.interval_minutes * 60 * 2;
    return { tone: stale ? 'warning' : 'success', text: `Sync ${fmt.relative(shopee.last_ok_at)}`, detail: stale ? 'Sync terakhir sudah lama; jadwal otomatis mungkin tertunda.' : `Sinkronisasi berhasil ${fmt.datetime(shopee.last_ok_at)}`, pulsing: false };
  }
  return { tone: 'neutral', text: 'Belum pernah sync', detail: 'Belum pernah sinkronisasi. Klik tombol sync untuk menarik order.', pulsing: false };
}

function renderSync(s, err) {
  if (!syncDot) return;
  const sum = syncSummary(s);
  syncDot.className = `status-dot tone-${sum.tone}${sum.pulsing ? ' is-pulsing' : ''}`;
  syncText.textContent = sum.text;
  syncIndicator.title = err ? `Status sync tidak tersedia: ${err.message || ''}` : sum.detail;
}

function syncMenuHeader() {
  const s = store.sync;
  const sum = syncSummary(s);
  return el('div', { class: 'menu-header' },
    el('div', { class: 'row gap-2' }, el('span', { class: `status-dot tone-${sum.tone}` }), el('div', { class: 'menu-header-title' }, 'Sinkronisasi Shopee')),
    el('div', { class: 'menu-header-sub mt-1' }, sum.detail));
}

function syncMenuItems() {
  const s = store.sync;
  const shopee = (s && s.marketplaces && s.marketplaces.shopee) || {};
  const items = [];
  if (s) {
    items.push({ note: true, label: `Terakhir sukses: ${shopee.last_ok_at ? fmt.datetime(shopee.last_ok_at) : 'belum pernah'}` });
    if (s.last && s.last.finished_at && s.last.status !== 'ok') items.push({ note: true, label: `Terakhir dicoba: ${fmt.datetime(s.last.finished_at)} (${fmt.syncStatus(s.last.status)})` });
    items.push({ note: true, label: s.enabled ? `Otomatis${s.interval_minutes ? ` tiap ${fmt.number(s.interval_minutes)} menit` : ''}${s.next_at ? `, berikutnya ${fmt.relative(s.next_at)}` : ''}` : 'Sync otomatis nonaktif' });
    if (shopee.shop_name) items.push({ note: true, label: `Toko: ${shopee.shop_name}` });
  } else {
    items.push({ note: true, label: 'Status sync tidak tersedia.' });
  }
  items.push({ divider: true });
  items.push({ label: 'Sync sekarang', icon: 'sync', onClick: () => syncNow(), disabled: syncing });
  items.push({ label: 'Lihat log sync', icon: 'history', href: '#/history?tab=sync' });
  if (!shopee.connected) items.push({ label: 'Hubungkan toko', icon: 'plug', href: '#/settings?tab=shopee' });
  return items;
}

/** Teks error dari berbagai bentuk (string | {message} | Error) → string ('' jika kosong). */
function errText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e.message) return String(e.message);
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Jalankan sync manual; hasil ditampilkan lewat toast. Mengembalikan hasil atau null. */
export async function syncNow() {
  if (syncing) { toast.info('Sinkronisasi sedang berjalan…'); return null; }
  syncing = true;
  if (syncBtn) { syncBtn.classList.add('is-spinning'); syncBtn.disabled = true; }
  if (syncDot) { syncDot.className = 'status-dot tone-primary is-pulsing'; syncText.textContent = 'Sedang sync…'; }
  try {
    const r = await api.post('/api/sync/now');
    if (r && r.already_running) {
      toast.info('Sinkronisasi sedang berjalan di latar belakang.');
    } else if (r && r.status === 'ok') {
      const parts = [`${fmt.number(r.fetched || 0)} order ditarik`, `${fmt.number(r.created || 0)} baru`, `${fmt.number(r.updated || 0)} diperbarui`];
      const changed = (r.changed_processed || []).length;
      toast.success(`Sync selesai: ${parts.join(', ')}.${changed ? ` ${changed} order yang sudah diproses berubah (PDF perlu dibuat ulang).` : ''}`, { title: 'Sinkronisasi berhasil' });
    } else if (r && r.status === 'partial') {
      toast.warn(`Sync selesai sebagian: ${errText(r.error) || 'sebagian data gagal ditarik.'}`, { title: 'Sinkronisasi sebagian' });
    } else {
      toast.error(errText(r && r.error) || 'Sinkronisasi gagal.', { title: 'Sinkronisasi gagal' });
    }
    await refreshSync();
    return r;
  } catch (e) {
    if (e && e.status === 404) toast.warn('Modul sinkronisasi belum tersedia di server.');
    else reportError(e, 'Sinkronisasi gagal');
    await refreshSync();
    return null;
  } finally {
    syncing = false;
    if (syncBtn) { syncBtn.classList.remove('is-spinning'); syncBtn.disabled = false; }
  }
}

// ----------------------------------------------------------------------------
// Logout
// ----------------------------------------------------------------------------
export async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* abaikan — sesi tetap dihapus di sisi klien */ }
  store.reset();
  toast.info('Anda telah keluar.', { timeout: 2500 });
  router.navigate('#/login', { replace: true });
}

// ----------------------------------------------------------------------------
// Fungsi layout untuk router: kembalikan slot tempat halaman dirender.
// ----------------------------------------------------------------------------
function isBare(route) {
  return !route || route.path === '/login' || !store.user;
}

export function layout(route) {
  const app = appRoot();
  if (isBare(route)) {
    destroyShell();
    let bare = app.querySelector(':scope > .bare');
    if (!bare) { bare = el('div', { class: 'bare' }); app.replaceChildren(bare); }
    document.body.classList.add('is-bare');
    return bare;
  }
  document.body.classList.remove('is-bare');
  if (!shellEl || !shellEl.isConnected) buildShell();
  setActive(route);
  return slotEl;
}

layout.refreshSync = refreshSync;
layout.syncNow = syncNow;
layout.logout = logout;
layout.setNavBadge = setNavBadge;
layout.destroy = destroyShell;
layout.slot = () => slotEl;
layout.isMounted = () => !!(shellEl && shellEl.isConnected);

export default layout;
