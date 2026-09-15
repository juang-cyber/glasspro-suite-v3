/**
 * main — titik masuk SPA Glass Pro Suite.
 *
 * Boot:
 *  1. Jika URL membawa ?code=...&shop_id=... (redirect OAuth Shopee) → teruskan ke /api/shopee/callback.
 *  2. GET /api/auth/me → store.user (tanpa user → #/login).
 *  3. router.start(): halaman diambil dari registry; jika belum terdaftar, router mengimpor ./pages/<nama>.js
 *     (nama: '' → dashboard, process, orders, history, settings, login, 'dev/gallery' → gallery).
 *     Gagal impor → kartu "Halaman belum tersedia" di dalam shell.
 * Setiap halaman mengekspor { render(container, params, ctx), destroy?() }.
 */
import { api, router, store, el, html, toast, modal, fmt, components as c, icons, takeNext, rememberNext, hasSessionHint, clearSessionHint } from './core.js';
import { layout } from './layout.js';

const APP_TITLE = 'Glass Pro Suite';

/** Placeholder ketika modul halaman belum dipasang (dirender di dalam shell). */
function notFound(container, route) {
  const name = route && route.name ? route.name : 'halaman';
  container.replaceChildren(
    el('div', { class: 'card page-placeholder' },
      c.emptyState({
        icon: 'layers',
        title: 'Halaman belum tersedia',
        text: `Modul halaman "${name}" belum dipasang di versi ini. Silakan kembali ke Overview atau coba lagi nanti.`,
        action: el('div', { class: 'row gap-2 wrap center' },
          c.button({ label: 'Ke Overview', kind: 'primary', icon: 'home', href: '#/' }),
          c.button({ label: 'Muat ulang', kind: 'secondary', icon: 'refresh', onClick: () => router.refresh() })),
      })));
}

/** Penjaga rute: tanpa user → #/login; sudah login tapi ke #/login → tujuan tersimpan / #/. */
function guard(route) {
  if (!store.user) {
    if (route.path === '/login') return null;
    rememberNext(route.hash);
    return '#/login';
  }
  if (route.path === '/login') return takeNext('#/');
  return null;
}

/** Tangani redirect OAuth Shopee yang mendarat di root SPA (bukan di /api/shopee/callback). */
function handleShopeeCallback() {
  const sp = new URLSearchParams(location.search);
  if (sp.has('code') && (sp.has('shop_id') || sp.has('main_account_id'))) {
    window.location.replace('/api/shopee/callback' + location.search);
    return true;
  }
  return false;
}

/** Muat pengaturan ke store di latar belakang (tidak memblokir; abaikan jika modul belum ada). */
async function preloadSettings() {
  if (!store.user) return;
  try {
    const s = await api.tryGet('/api/settings', null);
    if (s && store.user) store.settings = s;
  } catch { /* abaikan */ }
}

function installGlobalHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    if (r && r.name === 'ApiError') {
      if (r.status === 401) { ev.preventDefault(); return; }
      console.error('[app] permintaan gagal', r);
      toast.error(r.message || 'Permintaan gagal');
      ev.preventDefault();
    }
  });
  // Saat kembali online, segarkan status sync
  window.addEventListener('online', () => { if (store.user) layout.refreshSync(); });
}

async function boot() {
  if (handleShopeeCallback()) return;

  router.configure({
    layout,
    guard,
    notFound,
    appTitle: APP_TITLE,
    ctx: { store, api, el, html, toast, modal, fmt, components: c, icons, layout },
  });

  // Tanpa jejak sesi di browser ini (belum pernah login / sudah keluar) → langsung ke login tanpa memanggil
  // /api/auth/me yang pasti 401 (browser mencatatnya sebagai error di console). Ada jejak → verifikasi ke server;
  // bila sesi ternyata sudah tidak berlaku, jejaknya dihapus supaya boot berikutnya tidak mengulang 401.
  if (!hasSessionHint()) {
    store.user = null;
  } else {
    try {
      const r = await api.get('/api/auth/me');
      store.user = (r && r.user) || null;
      if (!store.user) clearSessionHint();
    } catch {
      store.user = null;
      clearSessionHint();
    }
  }

  installGlobalHandlers();
  await router.start();
  preloadSettings();
  store.subscribe('user', (u) => { if (u) preloadSettings(); });
}

boot().catch((e) => {
  console.error('[app] gagal memulai', e);
  const app = document.getElementById('app') || document.body;
  app.replaceChildren(el('div', { class: 'boot' }, el('div', { class: 'card page-placeholder' },
    c.emptyState({ icon: 'alert', title: 'Aplikasi gagal dimuat', text: (e && e.message) || 'Terjadi kesalahan', action: { label: 'Muat ulang', onClick: () => location.reload() } }))));
});

export { boot };
