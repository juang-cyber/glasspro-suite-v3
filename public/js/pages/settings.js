/**
 * Halaman Pengaturan (#/settings).
 * Nav samping (kartu) + konten kartu per bagian. Tiap bagian punya tombol "Simpan" sendiri yang mengirim
 * PUT /api/settings hanya dengan key bagian itu. Staf (non-admin) melihat read-only kecuali "Akun saya".
 * Query ?connected=<shop_id> / ?error=<pesan> (dari callback Shopee) → toast lalu query dibersihkan.
 * Query ?tab=<bagian> membuka bagian tertentu (dipakai menu top bar: #/settings?tab=shopee).
 */
import { api, router, store, el, toast, modal, fmt, components as c, icons, classNames, userName } from '../core.js';

const SECTIONS = [
  { key: 'shopee', label: 'Koneksi Shopee', sub: 'Toko, partner, transport', icon: 'shopee', group: 'Marketplace' },
  { key: 'warehouses', label: 'Gudang', sub: 'Pemetaan lokasi Shopee', icon: 'warehouse', group: 'Marketplace' },
  { key: 'sku', label: 'Aturan SKU & Tipe HP', sub: 'Kategori TG/HG, validasi', icon: 'tag', group: 'Pemrosesan' },
  { key: 'shipping', label: 'Pengiriman & Part', sub: 'Instant, jam part, batas batal', icon: 'truck', group: 'Pemrosesan' },
  { key: 'process', label: 'Proses & PDF', sub: 'Dokumen, metode kirim', icon: 'pdf', group: 'Pemrosesan' },
  { key: 'sync', label: 'Sinkronisasi', sub: 'Jadwal tarik order', icon: 'sync', group: 'Pemrosesan' },
  { key: 'users', label: 'Pengguna', sub: 'Akun staf & admin', icon: 'users', group: 'Akun', admin: true },
  { key: 'account', label: 'Akun saya', sub: 'Profil & password', icon: 'user', group: 'Akun' },
];

const TRANSPORT_LABEL = { direct: 'Langsung (direct)', bridge: 'Lewat jembatan (bridge)', mock: 'Simulasi (mock)' };
const TRANSPORT_HELP = {
  direct: 'Server ini memanggil API Shopee secara langsung. IP publik server harus terdaftar (whitelist) di Shopee Open Platform.',
  bridge: 'Permintaan diteruskan lewat server jembatan (VPS ber-IP tetap) memakai URL + token bridge. Cocok bila aplikasi berjalan di laptop/kantor tanpa IP publik.',
  mock: 'Simulasi toko tanpa memanggil Shopee — untuk uji coba. Order yang ditarik adalah data palsu (toko 999001).',
};
const ENV_LABEL = { live: 'Live (produksi)', test: 'Test (sandbox)' };
const MATCH_MODE_LABEL = { token: 'Token (kode berdiri sendiri)', contains: 'Mengandung teks', regex: 'Regex' };
const MATCH_MODE_HELP = {
  token: 'Kode harus muncul sebagai token terpisah oleh -, _, spasi, / atau titik. Contoh: "TG-IP15PM" cocok dengan TG; "TGX-01" tidak.',
  contains: 'Cukup mengandung teks kode (tidak peka huruf besar/kecil). Contoh: "MYTG01" cocok dengan TG.',
  regex: 'Pola regex JavaScript (flag i). Contoh: ^TG[-_] atau \\bHG\\b.',
};
const PHONE_MODE_LABEL = { all: 'Semua produk TG/HG', patterns: 'Hanya SKU yang cocok pola', none: 'Tidak ada validasi' };
const PHONE_SOURCE_LABEL = { model_name: 'Nama variasi (model_name)', note: 'Catatan pembeli (note)', message_to_seller: 'Pesan ke penjual (message_to_seller)' };
const DOC_TYPE_LABEL = { NORMAL_AIR_WAYBILL: 'Normal air waybill (PDF A4/A5)', THERMAL_AIR_WAYBILL: 'Thermal air waybill (A6)' };
const WH_MODE_LABEL = { split: 'Pisah PDF per gudang', merge: 'Gabung jadi satu (kode all)' };
const SYNC_STATUSES = ['READY_TO_SHIP', 'PROCESSED'];
const TOKEN_SPLIT = /[-_\s/.]+/;

let state = null;

// ---------------------------------------------------------------------------
// Helper umum
// ---------------------------------------------------------------------------
function ctrlInput(ctrl) {
  if (!ctrl) return ctrl;
  if (ctrl instanceof Element && ctrl.matches('input, select, textarea')) return ctrl;
  if (ctrl.input instanceof Element) return ctrl.input; // input-group / chips / toggle
  if (ctrl.select instanceof Element) return ctrl.select; // select-wrap
  return ctrl;
}
function setDisabled(ctrl, on) {
  if (!ctrl) return;
  if (typeof ctrl.setDisabled === 'function') { ctrl.setDisabled(on); return; }
  const i = ctrlInput(ctrl);
  if (i && 'disabled' in i) i.disabled = !!on;
}
function labelOptions(map, keys) { return (keys || Object.keys(map)).map((k) => ({ value: k, label: map[k] || k })); }
function nowSec() { return Math.floor(Date.now() / 1000); }
/** true bila halaman masih hidup dan `snap` adalah state yang sama (dipakai setelah await agar tidak menyentuh state halaman yang sudah ditinggalkan). */
function alive(snap) { return !!state && state === snap; }
function errMsg(e, fallback) { return api.errorMessage(e, fallback); }
function metaList(key, fallback) { const m = state && state.settings && state.settings.meta; return (m && Array.isArray(m[key]) && m[key].length) ? m[key] : fallback; }

/** Nilai numerik dari input; NaN bila kosong/tidak valid. */
function numVal(ctrl) { const v = String(ctrlInput(ctrl).value || '').trim(); return v === '' ? NaN : Number(v); }

/** Bersihkan query hash (connected/error) tanpa memicu router; tab dipertahankan. */
function setHashQuery(tab) {
  const hash = tab && tab !== 'shopee' ? `#/settings?tab=${encodeURIComponent(tab)}` : '#/settings';
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
}

/** Input chips: ketik lalu Enter/koma → chip; Backspace pada input kosong hapus chip terakhir. .value get/set (array). */
function chipsInput(opts = {}) {
  const { placeholder = 'Ketik lalu Enter', disabled = false, mono = false, transform, onChange, ariaLabel } = opts;
  let items = [];
  const inp = el('input', { class: 'chips-input', placeholder, disabled, autocomplete: 'off', 'aria-label': ariaLabel || placeholder });
  const wrap = el('div', { class: classNames('chips', disabled && 'is-disabled'), onClick: (e) => { if (e.target === wrap && !inp.disabled) inp.focus(); } });
  const fire = () => { if (onChange) onChange([...items]); };
  const render = () => {
    wrap.replaceChildren();
    items.forEach((it, i) => {
      wrap.appendChild(el('span', { class: classNames('chip', mono && 'chip-mono') },
        el('span', { class: 'chip-text', title: it }, it),
        inp.disabled ? null : el('button', { class: 'chip-remove', type: 'button', 'aria-label': `Hapus ${it}`, onClick: (e) => { e.stopPropagation(); items.splice(i, 1); render(); fire(); } }, icons.x({ size: 12 }))));
    });
    wrap.appendChild(inp);
  };
  const commit = (refocus) => {
    const raw = inp.value; inp.value = '';
    let changed = false;
    for (let s of raw.split(',')) {
      s = s.trim(); if (!s) continue;
      if (transform) s = transform(s);
      if (!items.includes(s)) { items.push(s); changed = true; }
    }
    render();
    if (changed) fire();
    if (refocus) inp.focus();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(true); }
    else if (e.key === 'Backspace' && !inp.value && items.length) { items.pop(); render(); fire(); inp.focus(); }
  });
  inp.addEventListener('blur', () => { if (inp.value.trim()) commit(false); });
  Object.defineProperty(wrap, 'value', { get: () => { if (inp.value.trim()) commit(false); return [...items]; }, set: (v) => { items = (Array.isArray(v) ? v : []).map((x) => String(x)); render(); } });
  wrap.input = inp;
  wrap.setDisabled = (on) => { inp.disabled = !!on; wrap.classList.toggle('is-disabled', !!on); render(); };
  wrap.value = opts.value || [];
  return wrap;
}

/** Input angka + field, mengembalikan field dengan .num() (NaN bila kosong). */
function numField(label, value, o = {}) {
  const inp = c.input({ type: 'number', value: value ?? '', min: o.min, max: o.max, step: o.step, disabled: state.ro || o.disabled, placeholder: o.placeholder });
  const f = c.field({ label, input: inp, hint: o.hint, required: o.required });
  f.num = () => numVal(inp);
  f.check = () => {
    const n = f.num();
    if (isNaN(n)) { f.setError('Wajib diisi angka'); return false; }
    if (o.integer !== false && !Number.isInteger(n)) { f.setError('Harus bilangan bulat'); return false; }
    if (o.min !== undefined && n < o.min) { f.setError(`Minimal ${o.min}`); return false; }
    if (o.max !== undefined && n > o.max) { f.setError(`Maksimal ${o.max}`); return false; }
    f.setError(null); return true;
  };
  return f;
}

/**
 * Workaround: modal.open() memanggil handle.setLoading(false) tanpa activeBtn setelah onClick mengembalikan false,
 * sehingga class is-loading pada tombol yang diklik tidak pernah dilepas (tombol jadi tidak bisa diklik lagi).
 */
function resetModalButtons(handle) {
  if (!handle || !handle.el) return;
  for (const b of handle.el.querySelectorAll('.modal-footer .btn.is-loading')) if (typeof b.setLoading === 'function') b.setLoading(false);
}

/** Kotak error di dalam kartu (alert danger). */
function errorBox() {
  const box = el('div', { class: 'settings-error', hidden: true });
  box.show = (msg) => { box.replaceChildren(c.alert({ tone: 'danger', text: msg, icon: 'alertCircle' })); box.hidden = false; };
  box.clear = () => { box.hidden = true; box.replaceChildren(); };
  return box;
}

/**
 * Kartu bagian dengan footer "Simpan" sendiri. onSave() → payload untuk PUT /api/settings (atau false untuk batal).
 * Setelah sukses: toast + state.settings diperbarui + bagian dibangun ulang (nilai ternormalisasi dari server).
 */
function sectionCard({ key, title, subtitle, icon, body, onSave, saveLabel = 'Simpan', actions, note, afterSave }) {
  const err = errorBox();
  const savedAt = state.savedAt[key];
  const savedEl = el('span', { class: 'settings-saved' }, savedAt ? [icons.checkCircle({ size: 14 }), `Tersimpan ${fmt.time(savedAt)}`] : null);
  let saveBtn = null;
  if (onSave && !state.ro) {
    saveBtn = c.button({ label: saveLabel, kind: 'primary', icon: 'save', onClick: async () => {
      err.clear();
      let payload;
      try { payload = onSave(); } catch (e) { err.show(errMsg(e, 'Data belum valid')); return; }
      if (payload === false || payload === null || payload === undefined) return;
      saveBtn.setLoading(true);
      const snap = state;
      try {
        const r = await api.put('/api/settings', payload);
        if (r && r.settings) store.settings = r.settings;
        if (!alive(snap)) return; // halaman sudah ditinggalkan saat menunggu server
        if (r && r.settings) state.settings = { ...state.settings, ...r.settings };
        state.savedAt[key] = nowSec();
        toast.success(`${title} disimpan.`, { title: 'Pengaturan tersimpan' });
        if (afterSave) { try { await afterSave(r); } catch (e) { console.error(e); } }
        if (alive(snap)) rebuildSection(key);
      } catch (e) {
        if (e && e.status === 401) return;
        toast.error(errMsg(e, 'Gagal menyimpan pengaturan'));
        if (!alive(snap)) return;
        err.show(errMsg(e, 'Gagal menyimpan pengaturan'));
        saveBtn.setLoading(false);
      }
    } });
  }
  const footer = (saveBtn || note) ? el('div', { class: 'settings-section-footer' }, el('div', { class: 'row gap-3 wrap min-w-0' }, note ? el('span', { class: 'text-sm text-muted' }, note) : null, savedEl), saveBtn) : null;
  const card = c.card({ title, subtitle, icon, actions, body: [err, body], footer, className: 'settings-card' });
  card.error = err;
  return card;
}

// ---------------------------------------------------------------------------
// Render halaman
// ---------------------------------------------------------------------------
export const title = 'Pengaturan';

function handleCallbackQuery(q) {
  if (!q) return;
  if (q.connected) toast.success(`Toko Shopee ${String(q.connected)} berhasil terhubung.`, { title: 'Koneksi Shopee' });
  if (q.error) toast.error(`Koneksi Shopee gagal: ${String(q.error)}`, { title: 'Koneksi Shopee', timeout: 9000 });
}

export async function render(container, params, ctx) {
  destroy();
  const ro = !store.isAdmin;
  const q = (ctx && ctx.query) || router.query() || {};
  handleCallbackQuery(q);
  const wanted = String(q.tab || '');
  const initial = SECTIONS.some((s) => s.key === wanted && (!s.admin || !ro)) ? wanted : 'shopee';
  state = { ro, ctx, container, active: null, sections: new Map(), navItems: new Map(), savedAt: {}, settings: null, shopee: null, sync: null, users: null, liveWarehouses: null };
  setHashQuery(initial);

  const header = c.pageHeader({
    title: 'Pengaturan', eyebrow: 'Glass Pro Suite',
    subtitle: 'Koneksi marketplace, aturan pemrosesan order, sinkronisasi, dan pengguna.',
    actions: ro ? c.badge({ text: 'Hanya baca (staf)', tone: 'warning', icon: 'lock', size: 'lg' }) : c.badge({ text: 'Mode admin', tone: 'primary', icon: 'shield', size: 'lg' }),
  });
  const content = el('div', { class: 'settings-content' }, c.skeleton(3, { kind: 'card', height: 140 }));
  state.contentEl = content;
  const nav = buildNav(initial);
  container.replaceChildren(...[header,
    ro ? c.alert({ tone: 'warning', icon: 'lock', title: 'Mode hanya baca', text: 'Hanya admin yang dapat mengubah pengaturan. Anda tetap bisa melihat konfigurasi dan mengganti password sendiri di "Akun saya".', className: 'mb-4' }) : null,
    el('div', { class: 'settings-layout' }, nav, content)].filter(Boolean));

  let settings, shopee, sync;
  try {
    [settings, shopee, sync] = await Promise.all([
      api.get('/api/settings'),
      api.tryGet('/api/shopee/status', null).catch(() => null),
      api.tryGet('/api/sync/status', null).catch(() => null),
    ]);
  } catch (e) {
    if (e && e.status === 401) return;
    if (!state || state.container !== container) return;
    content.replaceChildren(c.card({ body: c.emptyState({ icon: 'alert', title: 'Pengaturan gagal dimuat', text: errMsg(e), action: { label: 'Coba lagi', icon: 'refresh', onClick: () => router.refresh() } }) }));
    return;
  }
  if (!state || state.container !== container) return;
  state.settings = settings; state.shopee = shopee; state.sync = sync;
  store.settings = settings;
  showSection(initial);
}

export function destroy() {
  if (state && state.syncTimer) clearInterval(state.syncTimer);
  state = null;
}

function buildNav(initial) {
  const list = el('div', { class: 'settings-nav-list' });
  let lastGroup = null;
  for (const s of SECTIONS) {
    if (s.admin && state.ro) continue;
    if (s.group !== lastGroup) { list.appendChild(el('div', { class: 'settings-nav-group' }, s.group)); lastGroup = s.group; }
    const btn = el('button', { class: classNames('settings-nav-item', s.key === initial && 'is-active'), type: 'button', dataset: { section: s.key }, onClick: () => showSection(s.key, { scroll: true }) },
      icons.get(s.icon, { size: 18 }), el('span', { class: 'min-w-0' }, el('span', { class: 'settings-nav-label' }, s.label), el('span', { class: 'settings-nav-sub' }, s.sub)));
    state.navItems.set(s.key, btn);
    list.appendChild(btn);
  }
  return el('aside', { class: 'card settings-nav detail-sticky', 'aria-label': 'Bagian pengaturan' }, list);
}

function showSection(key, opts = {}) {
  if (!state || !state.settings) return;
  state.active = key;
  for (const [k, btn] of state.navItems) { btn.classList.toggle('is-active', k === key); if (k === key) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current'); }
  let node = state.sections.get(key);
  if (!node) { node = buildSection(key); state.sections.set(key, node); }
  state.contentEl.replaceChildren(node);
  setHashQuery(key);
  if (opts.scroll && window.innerWidth < 1024) { try { state.contentEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* abaikan */ } }
}

function rebuildSection(key) {
  if (!state) return;
  state.sections.delete(key);
  if (state.active === key) showSection(key);
}

function buildSection(key) {
  switch (key) {
    case 'shopee': return buildShopeeSection();
    case 'warehouses': return buildWarehousesSection();
    case 'sku': return buildSkuSection();
    case 'shipping': return buildShippingSection();
    case 'process': return buildProcessSection();
    case 'sync': return buildSyncSection();
    case 'users': return buildUsersSection();
    case 'account': return buildAccountSection();
    default: return c.card({ body: c.emptyState({ title: 'Bagian tidak ditemukan' }) });
  }
}

async function reloadShopeeStatus() {
  const snap = state;
  let st = null;
  try { st = await api.get('/api/shopee/status'); } catch (e) { if (e && e.status !== 401) console.warn('status shopee gagal dimuat', e); }
  if (!alive(snap)) return;
  if (st) state.shopee = st;
  rebuildSection('shopee');
  if (state.ctx && state.ctx.layout && state.ctx.layout.refreshSync) state.ctx.layout.refreshSync();
}

// ---------------------------------------------------------------------------
// Bagian: Koneksi Shopee
// ---------------------------------------------------------------------------
function shopeeHero() {
  const st = state.shopee;
  const s = state.settings;
  const transport = (st && st.transport) || s['shopee.transport'] || 'direct';
  const env = (st && st.env) || s['shopee.env'] || 'live';
  const partnerId = st ? st.partner_id : s['shopee.partner_id'];
  const shops = (st && st.shops) || [];
  const connected = shops.filter((x) => x.status === 'connected').length;
  const configured = st ? !!st.configured : false;
  const tiles = el('div', { class: 'glass-grid glass-grid-4' },
    c.glassTile({ label: 'Transport', value: TRANSPORT_LABEL[transport] ? TRANSPORT_LABEL[transport].replace(/\s*\(.*\)$/, '') : transport, sub: transport, icon: 'plug' }),
    c.glassTile({ label: 'Lingkungan', value: env === 'test' ? 'Test' : 'Live', sub: st && st.host ? st.host.replace(/^https?:\/\//, '') : ENV_LABEL[env], icon: 'globe' }),
    c.glassTile({ label: 'Partner ID', value: partnerId ? String(partnerId) : '-', sub: configured ? 'Key terpasang' : 'Belum lengkap', icon: 'key' }),
    c.glassTile({ label: 'Toko terhubung', value: connected, sub: shops.length ? `${shops.length} toko terdaftar` : 'Belum ada toko', icon: 'store' }));
  const statusBadge = st
    ? c.badge({ text: configured ? 'Terkonfigurasi' : 'Belum lengkap', tone: 'glass', className: 'badge-glass', icon: configured ? 'checkCircle' : 'alertCircle', size: 'lg' })
    : c.badge({ text: 'Status tidak tersedia', className: 'badge-glass', icon: 'alertCircle', size: 'lg' });
  return c.card({
    tone: 'gradient', icon: 'shopee', title: 'Shopee Open Platform',
    subtitle: st ? (configured ? 'Partner ID & key siap dipakai untuk memanggil API Shopee.' : 'Isi Partner ID dan Partner key lalu simpan sebelum menghubungkan toko.') : 'Modul Shopee tidak merespons — status tidak dapat dimuat.',
    actions: statusBadge,
    body: tiles,
    footer: el('div', { class: 'row gap-2 wrap text-sm', style: { color: 'rgba(255,255,255,.82)' } },
      icons.link({ size: 14 }), el('span', { class: 'break' }, `Redirect URL: ${(st && st.redirect_url) || s['shopee.redirect_url'] || '-'}`)),
  });
}

function shopRow(shop) {
  const ro = state.ro;
  const now = nowSec();
  const exp = shop.access_expire_at;
  const expired = exp && exp < now;
  const tokenText = !exp ? 'masa berlaku token tidak diketahui' : `token ${expired ? 'kadaluarsa' : 'berlaku s/d'} ${fmt.datetime(exp)} (${fmt.relative(exp)})`;
  const sub = el('div', { class: 'list-row-sub' }, `ID ${shop.shop_id}${shop.region ? ` · ${shop.region}` : ''} · ${tokenText}`);
  const errLine = shop.last_error ? el('div', { class: 'list-row-sub text-danger', style: { color: '#FCA5A5', whiteSpace: 'normal' } }, `Error terakhir: ${shop.last_error}`) : null;
  const actions = ro ? null : el('div', { class: 'row gap-2 wrap shop-row-actions' },
    c.button({ label: 'Refresh token', kind: 'glass', size: 'sm', icon: 'refresh', onClick: async (e, btn) => {
      btn.setLoading(true);
      try { await api.post(`/api/shopee/refresh/${shop.shop_id}`); toast.success(`Token toko ${shop.shop_name || shop.shop_id} diperbarui.`); await reloadShopeeStatus(); }
      catch (err) { if (err && err.status !== 401) toast.error(errMsg(err, 'Gagal memperbarui token')); btn.setLoading(false); }
    } }),
    c.button({ label: 'Putuskan', kind: 'danger-soft', size: 'sm', icon: 'x', onClick: async () => {
      const ok = await modal.confirm({ title: `Putuskan toko ${shop.shop_name || shop.shop_id}?`, message: 'Sinkronisasi dan proses order untuk toko ini akan berhenti sampai dihubungkan kembali. Order yang sudah ditarik tetap tersimpan.', confirmLabel: 'Ya, putuskan', danger: true });
      if (!ok) return;
      try { await api.post(`/api/shopee/disconnect/${shop.shop_id}`); toast.success(`Toko ${shop.shop_name || shop.shop_id} diputuskan.`); await reloadShopeeStatus(); }
      catch (err) { if (err && err.status !== 401) toast.error(errMsg(err, 'Gagal memutuskan toko')); }
    } }));
  return el('div', { class: 'list-row shop-row' },
    el('span', { class: 'list-row-lead' }, el('span', { class: 'list-row-icon' }, icons.store({ size: 18 }))),
    el('div', { class: 'list-row-main' }, el('div', { class: 'list-row-title' }, shop.shop_name || `Toko ${shop.shop_id}`), sub, errLine),
    el('span', { class: 'list-row-badge' }, c.badge({ status: shop.status || 'disconnected', dot: true })),
    actions);
}

function shopsCard() {
  const st = state.shopee;
  const shops = (st && st.shops) || [];
  const result = el('div', { class: 'mt-3', hidden: true });
  const connectBtn = c.button({ label: 'Hubungkan toko Shopee', kind: 'primary', size: 'sm', icon: 'plug', onClick: async (e, btn) => {
    btn.setLoading(true);
    try {
      const r = await api.get('/api/shopee/auth-url');
      const url = r && r.url;
      if (!url) throw new Error('URL otorisasi kosong');
      if (/^https?:\/\//i.test(url)) {
        const w = window.open(url, '_blank', 'noopener');
        toast.info('Halaman otorisasi Shopee dibuka di tab baru. Setelah menyetujui, Anda akan diarahkan kembali ke sini.', { timeout: 6000 });
        if (!w) toast.warn('Pop-up diblokir browser. Izinkan pop-up lalu coba lagi.');
        btn.setLoading(false);
      } else {
        window.location.href = url; // transport mock: callback lokal → redirect kembali ke #/settings?connected=
      }
    } catch (err) { if (err && err.status !== 401) toast.error(errMsg(err, 'Gagal membuat URL otorisasi')); btn.setLoading(false); }
  } });
  const testBtn = c.button({ label: 'Tes koneksi', kind: 'glass', size: 'sm', icon: 'wifi', onClick: async (e, btn) => {
    btn.setLoading(true); result.hidden = true;
    const snap = state;
    try {
      const r = await api.post('/api/shopee/test', {});
      result.replaceChildren(c.alert({ tone: 'success', title: `Terhubung ke ${r.shop_name || `toko ${r.shop_id}`}`, text: `Latensi ${fmt.number(r.latency_ms)} ms · transport ${r.transport || '-'}${r.shop_status ? ` · status toko ${r.shop_status}` : ''}${r.region ? ` · ${r.region}` : ''}`, dismissible: true }));
      result.hidden = false;
      toast.success(`Koneksi OK: ${r.shop_name || r.shop_id} (${fmt.number(r.latency_ms)} ms)`);
      const st = await api.tryGet('/api/shopee/status', null).catch(() => null);
      if (st && alive(snap)) state.shopee = st;
    } catch (err) {
      if (err && err.status === 401) return;
      result.replaceChildren(c.alert({ tone: 'danger', title: 'Tes koneksi gagal', text: errMsg(err, 'Tidak dapat menghubungi Shopee'), dismissible: true }));
      result.hidden = false;
    } finally { btn.setLoading(false); }
  } });
  const refreshBtn = c.iconButton({ icon: 'refresh', title: 'Muat ulang status', kind: 'glass', size: 'sm', onClick: () => reloadShopeeStatus() });
  const list = shops.length
    ? el('div', { class: 'list-panel' }, shops.map(shopRow))
    : c.emptyState({ icon: 'store', size: 'sm', title: 'Belum ada toko terhubung', text: !st ? 'Status toko tidak dapat dimuat dari server.' : state.ro ? 'Minta admin untuk menghubungkan toko lewat Shopee Open Platform.' : 'Klik "Hubungkan toko Shopee" untuk otorisasi lewat Shopee Open Platform.' });
  // Staf hanya baca: boleh tes koneksi & muat ulang, tidak menghubungkan toko (konsisten dengan form tempel URL yang disembunyikan).
  return c.card({ tone: 'dark', icon: 'store', title: 'Toko terhubung', subtitle: shops.length ? `${shops.length} toko · sync menarik order dari toko berstatus Terhubung` : 'Otorisasi toko agar order bisa ditarik',
    actions: state.ro ? [testBtn, refreshBtn] : [testBtn, connectBtn, refreshBtn], body: [list, result] });
}

function manualConnectCard() {
  const err = errorBox();
  const urlInput = c.input({ placeholder: 'https://…/api/shopee/callback?code=…&shop_id=…', mono: true, icon: 'link' });
  const urlField = c.field({ label: 'URL callback dari Shopee', input: urlInput, hint: 'Tempel URL lengkap yang muncul di address bar setelah menyetujui otorisasi (boleh hanya bagian ?code=…&shop_id=…).' });
  const btn = c.button({ label: 'Hubungkan dari URL', kind: 'primary', icon: 'plug', onClick: async () => {
    err.clear();
    const v = urlInput.value.trim();
    if (!v) { urlField.setError('URL callback wajib diisi'); return; }
    if (!/code=/.test(v)) { urlField.setError('URL harus memuat parameter code=…'); return; }
    btn.setLoading(true);
    try {
      const r = await api.post('/api/shopee/connect-manual', { callback_url: v });
      const shop = r && r.shop;
      toast.success(`Toko ${shop && (shop.shop_name || shop.shop_id) || ''} berhasil terhubung.`, { title: 'Koneksi Shopee' });
      urlInput.value = '';
      await reloadShopeeStatus();
    } catch (e) {
      if (e && e.status === 401) return;
      err.show(errMsg(e, 'Gagal menghubungkan toko'));
    } finally { btn.setLoading(false); }
  } });
  return c.card({ icon: 'clipboard', title: 'Tempel URL callback (mode laptop)', subtitle: 'Bila redirect Shopee mengarah ke server yang tidak bisa diakses dari komputer ini, salin URL hasil redirect lalu tempel di sini.',
    body: el('div', { class: 'stack' }, err, urlField, el('div', { class: 'form-actions' }, btn)) });
}

function shopeeConfigCard() {
  const s = state.settings; const ro = state.ro;
  const partnerId = c.input({ type: 'number', value: s['shopee.partner_id'] ?? '', placeholder: '2000000', mono: true, min: 1, step: 1, disabled: ro });
  const fPartnerId = c.field({ label: 'Partner ID', input: partnerId, hint: 'Dari Shopee Open Platform → App' });
  let showKey = false;
  const keyMasked = /\*\*\*\*/.test(String(s['shopee.partner_key'] || ''));
  const eyeBtn = ro ? null : c.iconButton({ icon: 'eye', kind: 'ghost', size: 'sm', title: 'Lihat key', onClick: () => {
    showKey = !showKey; partnerKey.input.type = showKey ? 'text' : 'password';
    eyeBtn.replaceChildren(icons.get(showKey ? 'eyeOff' : 'eye', { size: 16 })); eyeBtn.title = showKey ? 'Sembunyikan key' : 'Lihat key';
  } });
  const partnerKey = c.input({ type: ro ? 'text' : 'password', value: s['shopee.partner_key'] || '', placeholder: 'shpk…', mono: true, icon: 'key', suffix: eyeBtn || undefined, disabled: ro, autocomplete: 'off' });
  const fPartnerKey = c.field({ label: 'Partner key', input: partnerKey, hint: ro ? 'Ditampilkan ter-mask untuk staf.' : (keyMasked ? 'Nilai ter-mask tidak akan mengubah key tersimpan.' : 'Jangan bagikan key ini. Kosongkan bila belum punya.') });
  const envSel = c.select({ options: labelOptions(ENV_LABEL), value: s['shopee.env'] || 'live', disabled: ro });
  const help = el('div', { class: 'notice-box' });
  const bridgeUrl = c.input({ value: s['shopee.bridge_url'] || '', placeholder: 'https://bridge.contoh.id', mono: true, icon: 'globe', disabled: ro });
  const fBridgeUrl = c.field({ label: 'URL bridge', input: bridgeUrl, hint: 'Alamat server jembatan (endpoint /bridge/shopee).' });
  const bridgeToken = c.input({ type: ro ? 'text' : 'password', value: s['shopee.bridge_token'] || '', placeholder: 'token rahasia', mono: true, icon: 'lock', disabled: ro, autocomplete: 'off' });
  const fBridgeToken = c.field({ label: 'Token bridge', input: bridgeToken, hint: 'Harus sama dengan BRIDGE_TOKEN di server jembatan.' });
  const bridgeWrap = el('div', { class: 'form-grid span-2 settings-subgrid' }, fBridgeUrl, fBridgeToken);
  const transportSel = c.select({ options: labelOptions(TRANSPORT_LABEL, metaList('transport_options', ['direct', 'bridge', 'mock'])), value: s['shopee.transport'] || 'direct', disabled: ro,
    onChange: (v) => applyTransport(v) });
  const applyTransport = (v) => { help.textContent = TRANSPORT_HELP[v] || ''; bridgeWrap.hidden = v !== 'bridge'; };
  applyTransport(s['shopee.transport'] || 'direct');
  const redirect = s['shopee.redirect_url'] || '';
  const redirectField = c.field({ label: 'Redirect URL (info)', input: c.input({ value: redirect, readonly: true, mono: true, icon: 'link', suffix: c.iconButton({ icon: 'copy', kind: 'ghost', size: 'sm', title: 'Salin', onClick: async () => { try { await navigator.clipboard.writeText(redirect); toast.success('Redirect URL disalin'); } catch { toast.error('Tidak bisa menyalin'); } } }) }),
    hint: 'Daftarkan URL ini sebagai Redirect URL di Shopee Open Platform. Diatur lewat env SHOPEE_REDIRECT_URL / APP_URL.' });

  const body = el('div', { class: 'form-grid' },
    fPartnerId, fPartnerKey,
    c.field({ label: 'Lingkungan', input: envSel, hint: 'Live = partner.shopeemobile.com, Test = sandbox.' }),
    c.field({ label: 'Transport', input: transportSel }),
    el('div', { class: 'span-2' }, help),
    bridgeWrap,
    el('div', { class: 'span-2' }, redirectField));

  return sectionCard({
    key: 'shopee', icon: 'cog', title: 'Konfigurasi partner & transport', subtitle: 'Kredensial aplikasi Shopee dan cara server memanggil API.', body,
    note: 'Setelah mengganti Partner ID/key, hubungkan ulang toko.',
    onSave: () => {
      let ok = true;
      const pidRaw = String(partnerId.value || '').trim();
      let pid = null;
      if (pidRaw !== '') { pid = Number(pidRaw); if (!Number.isInteger(pid) || pid < 1) { fPartnerId.setError('Partner ID harus bilangan bulat positif'); ok = false; } }
      const transport = transportSel.value;
      if (transport === 'bridge' && !bridgeUrl.value.trim()) { fBridgeUrl.setError('URL bridge wajib diisi untuk transport bridge'); ok = false; }
      if (transport === 'bridge' && bridgeUrl.value.trim() && !/^https?:\/\//i.test(bridgeUrl.value.trim())) { fBridgeUrl.setError('URL harus diawali http:// atau https://'); ok = false; }
      if (!ok) return false;
      return {
        'shopee.partner_id': pid,
        'shopee.partner_key': partnerKey.value,
        'shopee.env': envSel.value,
        'shopee.transport': transport,
        'shopee.bridge_url': bridgeUrl.value.trim(),
        'shopee.bridge_token': bridgeToken.value,
      };
    },
    afterSave: async () => { const snap = state; try { const st = await api.get('/api/shopee/status'); if (alive(snap)) state.shopee = st; } catch { /* abaikan */ } },
  });
}

function buildShopeeSection() {
  return el('div', { class: 'settings-section' }, shopeeHero(), shopsCard(), state.ro ? null : manualConnectCard(), shopeeConfigCard());
}

// ---------------------------------------------------------------------------
// Bagian: Gudang
// ---------------------------------------------------------------------------
function buildWarehousesSection() {
  const s = state.settings; const ro = state.ro;
  const list = Array.isArray(s.warehouses) && s.warehouses.length ? s.warehouses : [{ code: 'jkt', name: 'Jakarta', location_ids: [], warehouse_ids: [], pickup_address_id: null, is_default: true }, { code: 'sby', name: 'Surabaya', location_ids: [], warehouse_ids: [], pickup_address_id: null, is_default: false }];
  const editors = list.map((w) => {
    const name = c.input({ value: w.name || '', placeholder: 'Nama gudang', disabled: ro });
    const locs = chipsInput({ value: w.location_ids || [], placeholder: `mis. ${String(w.code).toUpperCase()}-001`, mono: true, disabled: ro, ariaLabel: `Location ID ${w.code}` });
    const whs = chipsInput({ value: (w.warehouse_ids || []).map(String), placeholder: 'mis. 30001', mono: true, disabled: ro, ariaLabel: `Warehouse ID ${w.code}` });
    const pickup = c.input({ value: w.pickup_address_id ?? '', placeholder: 'address_id pickup (opsional)', mono: true, disabled: ro });
    const radio = el('input', { type: 'radio', name: 'wh-default', value: w.code, checked: !!w.is_default, disabled: ro });
    const node = el('div', { class: 'wh-card' },
      el('div', { class: 'row-between gap-3 wrap' },
        el('div', { class: 'row gap-2' }, c.badge({ status: w.code, text: String(w.code).toUpperCase(), size: 'lg' }), el('span', { class: 'fw-700' }, fmt.warehouse(w.code))),
        el('label', { class: 'checkbox text-sm' }, radio, el('span', 'Gudang default'))),
      el('div', { class: 'stack mt-3' },
        c.field({ label: 'Nama', input: name }),
        c.field({ label: 'Location ID (product_location_id item Shopee)', input: locs, hint: 'Item dengan location ini dipetakan ke gudang ini. Enter/koma untuk menambah.' }),
        c.field({ label: 'Warehouse ID Shopee', input: whs }),
        c.field({ label: 'Pickup address ID', input: pickup, hint: 'Alamat penjemputan untuk arrange shipment (opsional).' })));
    return { code: w.code, node, name, locs, whs, pickup, radio };
  });
  const grid = el('div', { class: 'grid-2 wh-grid' }, editors.map((e) => e.node));
  const cardMain = sectionCard({
    key: 'warehouses', icon: 'warehouse', title: 'Gudang', subtitle: 'Kode gudang jkt/sby dan pemetaan lokasi Shopee. Item yang tidak terpetakan masuk "Perlu diperiksa".', body: grid,
    note: 'Default hanya dipakai bila cuma ada satu gudang tanpa Location ID.',
    onSave: () => ({ warehouses: editors.map((e) => ({
      code: e.code, name: e.name.value.trim(), location_ids: e.locs.value, warehouse_ids: e.whs.value,
      pickup_address_id: String(e.pickup.value || '').trim() || null, is_default: e.radio.checked,
    })) }),
  });

  // ---- Gudang live dari Shopee ----
  const liveBody = el('div');
  const renderLive = () => {
    const data = state.liveWarehouses;
    if (!data) { liveBody.replaceChildren(c.emptyState({ icon: 'warehouse', size: 'sm', title: 'Belum diambil', text: 'Klik "Ambil daftar gudang dari Shopee" untuk melihat warehouse_id dan location_id toko yang terhubung.' })); return; }
    const rows = data.warehouses || [];
    if (!rows.length) { liveBody.replaceChildren(c.emptyState({ icon: 'warehouse', size: 'sm', title: 'Tidak ada daftar gudang', text: 'Toko ini bukan multi-gudang di Shopee, atau tidak ada gudang yang dikembalikan.' })); return; }
    liveBody.replaceChildren(el('div', { class: 'list-panel' }, rows.map((w) => {
      const addr = [w.address, w.district, w.city, w.state, w.zipcode].filter(Boolean).join(', ');
      const mapBtns = ro ? null : el('div', { class: 'row gap-2 wrap shop-row-actions' }, editors.map((e) => c.button({ label: `Petakan ke ${fmt.warehouse(e.code)}`, kind: 'glass', size: 'sm', icon: 'arrowRight', onClick: () => {
        const cur = e.locs.value;
        if (w.location_id && !cur.includes(w.location_id)) e.locs.value = [...cur, w.location_id];
        const curW = e.whs.value; const wid = w.warehouse_id !== null && w.warehouse_id !== undefined ? String(w.warehouse_id) : '';
        if (wid && !curW.includes(wid)) e.whs.value = [...curW, wid];
        toast.success(`${w.warehouse_name || w.location_id} dipetakan ke ${fmt.warehouse(e.code)}. Klik Simpan pada kartu Gudang untuk menyimpan.`);
      } })));
      return el('div', { class: 'list-row shop-row' },
        el('span', { class: 'list-row-lead' }, el('span', { class: 'list-row-icon' }, icons.mapPin({ size: 18 }))),
        el('div', { class: 'list-row-main' },
          el('div', { class: 'list-row-title' }, w.warehouse_name || `Gudang ${w.warehouse_id}`),
          el('div', { class: 'list-row-sub' }, `warehouse_id ${w.warehouse_id ?? '-'} · location_id ${w.location_id || '-'}${w.address_id ? ` · address_id ${w.address_id}` : ''}`),
          addr ? el('div', { class: 'list-row-sub', style: { whiteSpace: 'normal' } }, addr) : null),
        mapBtns);
    })));
  };
  renderLive();
  const fetchBtn = c.button({ label: 'Ambil daftar gudang dari Shopee', kind: 'glass', size: 'sm', icon: 'download', onClick: async (e, btn) => {
    btn.setLoading(true);
    const snap = state;
    try {
      const data = await api.get('/api/shopee/warehouses');
      if (!alive(snap)) return;
      state.liveWarehouses = data; renderLive();
      toast.success(`${(data.warehouses || []).length} gudang diambil dari toko ${data.shop_id}.`);
    } catch (err) { if (err && err.status !== 401) { liveBody.replaceChildren(c.alert({ tone: 'danger', title: 'Gagal mengambil gudang', text: errMsg(err) })); } }
    finally { btn.setLoading(false); }
  } });
  const cardLive = c.card({ tone: 'dark', icon: 'shopee', title: 'Gudang di Shopee (live)', subtitle: 'Daftar warehouse dari toko terhubung; petakan location_id ke gudang lokal.', actions: fetchBtn, body: liveBody });

  return el('div', { class: 'settings-section' }, cardMain, cardLive);
}

// ---------------------------------------------------------------------------
// Bagian: Aturan SKU & Tipe HP
// ---------------------------------------------------------------------------
function matchPatterns(sku, patterns, mode) {
  const s = String(sku || '').trim();
  if (!s || !patterns.length) return false;
  if (mode === 'regex') return patterns.some((p) => { try { return new RegExp(p, 'i').test(s); } catch { return false; } });
  if (mode === 'contains') { const up = s.toUpperCase(); return patterns.some((p) => up.includes(String(p).toUpperCase())); }
  const tokens = s.split(TOKEN_SPLIT).filter(Boolean).map((t) => t.toUpperCase());
  return patterns.some((p) => tokens.includes(String(p).toUpperCase()));
}
function categorizeSkuLocal(sku, rules) {
  const tg = matchPatterns(sku, rules.tg_patterns, rules.match_mode);
  const hg = matchPatterns(sku, rules.hg_patterns, rules.match_mode);
  if (tg && hg) return 'conflict';
  if (tg) return 'tg';
  if (hg) return 'hg';
  return null;
}

/** Editor urutan sumber tipe HP: checkbox + tombol naik/turun. .value → daftar key aktif berurutan. */
function sourcesEditor(value, allSources) {
  const ro = state.ro;
  const active = (value || []).filter((k) => allSources.includes(k));
  let order = [...active, ...allSources.filter((k) => !active.includes(k))];
  const checked = new Set(active);
  const node = el('div', { class: 'src-list' });
  const render = () => {
    node.replaceChildren();
    order.forEach((k, i) => {
      const cb = c.checkbox({ label: PHONE_SOURCE_LABEL[k] || k, checked: checked.has(k), disabled: ro, onChange: (v) => { if (v) checked.add(k); else checked.delete(k); } });
      node.appendChild(el('div', { class: 'src-row' },
        el('span', { class: 'src-order' }, String(i + 1)), cb,
        ro ? null : el('div', { class: 'row gap-1 ml-auto' },
          c.iconButton({ icon: 'arrowUp', title: 'Naik', kind: 'ghost', size: 'sm', disabled: i === 0, onClick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; render(); } }),
          c.iconButton({ icon: 'arrowDown', title: 'Turun', kind: 'ghost', size: 'sm', disabled: i === order.length - 1, onClick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; render(); } }))));
    });
  };
  render();
  Object.defineProperty(node, 'value', { get: () => order.filter((k) => checked.has(k)) });
  return node;
}

function buildSkuSection() {
  const s = state.settings; const ro = state.ro;
  const r = { match_mode: 'token', tg_patterns: [], hg_patterns: [], require_phone_type: { mode: 'all', patterns: [] }, phone_type_sources: [], generic_variation_words: [], ...(s.sku_rules || {}) };
  const rpt = { mode: 'all', patterns: [], ...(r.require_phone_type || {}) };
  const modeHelp = el('div', { class: 'field-hint' }, MATCH_MODE_HELP[r.match_mode] || '');
  const modeSel = c.select({ options: labelOptions(MATCH_MODE_LABEL, metaList('match_modes', ['token', 'contains', 'regex'])), value: r.match_mode, disabled: ro, onChange: (v) => { modeHelp.textContent = MATCH_MODE_HELP[v] || ''; runTest(); } });
  const tg = chipsInput({ value: r.tg_patterns, placeholder: 'mis. TG', disabled: ro, mono: true, onChange: () => runTest() });
  const hg = chipsInput({ value: r.hg_patterns, placeholder: 'mis. HG', disabled: ro, mono: true, onChange: () => runTest() });
  const fTg = c.field({ label: 'Pola SKU Tempered Glass (TG)', input: tg, hint: 'Dicek pada model_sku lalu item_sku.' });
  const fHg = c.field({ label: 'Pola SKU Hydrogel (HG)', input: hg });
  const reqPatterns = chipsInput({ value: rpt.patterns || [], placeholder: 'pola SKU wajib tipe HP', disabled: ro, mono: true });
  const fReqPatterns = c.field({ label: 'Pola SKU yang wajib tipe HP', input: reqPatterns, hint: 'Dipakai bila mode "Hanya SKU yang cocok pola" (mengikuti mode pencocokan di atas).' });
  const reqSel = c.select({ options: labelOptions(PHONE_MODE_LABEL, metaList('phone_type_modes', ['all', 'patterns', 'none'])), value: rpt.mode, disabled: ro, onChange: (v) => { fReqPatterns.hidden = v !== 'patterns'; } });
  fReqPatterns.hidden = rpt.mode !== 'patterns';
  const sources = sourcesEditor(r.phone_type_sources, metaList('phone_type_sources', ['model_name', 'note', 'message_to_seller']));
  const generic = chipsInput({ value: r.generic_variation_words, placeholder: 'mis. universal', disabled: ro, transform: (x) => x.toLowerCase() });

  // Uji cepat (client-side, logika sama dengan engine)
  const testInput = c.input({ placeholder: 'mis. TG-IP15PM-CLR', mono: true, icon: 'search', onInput: () => runTest() });
  const testOut = el('div', { class: 'row gap-2 wrap text-sm' }, el('span', { class: 'text-muted' }, 'Ketik contoh SKU untuk melihat kategorinya.'));
  const runTest = () => {
    const sku = testInput.value.trim();
    if (!sku) { testOut.replaceChildren(el('span', { class: 'text-muted' }, 'Ketik contoh SKU untuk melihat kategorinya.')); return; }
    const cat = categorizeSkuLocal(sku, { match_mode: modeSel.value, tg_patterns: tg.value, hg_patterns: hg.value });
    const badge = cat === 'conflict' ? c.badge({ text: 'Konflik (TG & HG) → Perlu diperiksa', tone: 'warning', dot: true })
      : cat ? c.badge({ status: cat, text: fmt.category(cat), dot: true })
        : c.badge({ text: 'Tidak dikenali → Perlu diperiksa', tone: 'danger', dot: true });
    testOut.replaceChildren(el('span', { class: 'mono fw-600' }, sku), icons.arrowRight({ size: 14 }), badge);
  };
  const tester = el('div', { class: 'card card-soft card-sm stack-sm' },
    el('div', { class: 'row gap-2' }, icons.sparkles({ size: 16 }), el('span', { class: 'fw-700' }, 'Uji cepat SKU')),
    testInput, testOut);

  const body = el('div', { class: 'form-grid' },
    el('div', { class: 'field' }, el('label', { class: 'field-label' }, 'Mode pencocokan'), modeSel, modeHelp),
    tester,
    fTg, fHg,
    c.field({ label: 'Produk yang wajib tipe HP', input: reqSel, hint: 'Order tanpa tipe HP ditahan (PHONE_TYPE_MISSING) kecuali dekat batas batal.' }),
    fReqPatterns,
    c.field({ label: 'Sumber tipe HP (urutan dicek)', input: sources, hint: 'Nama variasi dipakai bila tidak kosong dan tidak mengandung kata generik.' }),
    c.field({ label: 'Kata variasi generik (bukan tipe HP)', input: generic, hint: 'Bila variasi mengandung kata ini, tipe HP dicari di catatan/pesan.' }));

  return el('div', { class: 'settings-section' }, sectionCard({
    key: 'sku', icon: 'tag', title: 'Aturan SKU & Tipe HP', subtitle: 'Menentukan kategori TG/HG per item dan validasi tipe HP sebelum cetak.', body,
    note: 'Setelah disimpan, semua order yang belum diproses diklasifikasi ulang.',
    onSave: () => {
      let ok = true;
      const mode = modeSel.value;
      if (mode === 'regex') {
        for (const [f, list] of [[fTg, tg.value], [fHg, hg.value], [fReqPatterns, reqPatterns.value]]) {
          const bad = list.find((p) => { try { new RegExp(p, 'i'); return false; } catch { return true; } });
          if (bad) { f.setError(`Regex tidak valid: ${bad}`); ok = false; }
        }
      }
      if (!tg.value.length && !hg.value.length) { fTg.setError('Isi minimal satu pola TG atau HG'); ok = false; }
      if (!sources.value.length) { toast.warn('Pilih minimal satu sumber tipe HP.'); ok = false; }
      if (reqSel.value === 'patterns' && !reqPatterns.value.length) { fReqPatterns.setError('Isi minimal satu pola'); ok = false; }
      if (!ok) return false;
      return { sku_rules: { match_mode: mode, tg_patterns: tg.value, hg_patterns: hg.value, require_phone_type: { mode: reqSel.value, patterns: reqPatterns.value }, phone_type_sources: sources.value, generic_variation_words: generic.value } };
    },
  }));
}

// ---------------------------------------------------------------------------
// Bagian: Pengiriman & Part
// ---------------------------------------------------------------------------
function hhmmToMin(v) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim()); if (!m) return null; const n = Number(m[1]) * 60 + Number(m[2]); return n < 24 * 60 ? n : null; }

function buildShippingSection() {
  const s = state.settings; const ro = state.ro;
  const kw = chipsInput({ value: (s.shipping_rules && s.shipping_rules.instant_keywords) || [], placeholder: 'mis. instant', disabled: ro, transform: (x) => x.toLowerCase() });
  const fKw = c.field({ label: 'Kata kunci kurir Instant / Same Day', input: kw, hint: 'Jika nama kurir (shipping_carrier) mengandung salah satu kata ini → jenis pengiriman instant; selain itu regular.' });
  const parts = s.parts || {};
  const partDesc = { p1: 'Order kemarin yang belum diproses + order masuk sampai proses dimulai', p2: 'Sisa Part 1 + order baru', p3: 'Hanya Instant/Same Day; Regular menunggu Part 1 besok' };
  const partEds = ['p1', 'p2', 'p3'].map((k) => {
    const p = parts[k] || {};
    const label = c.input({ value: p.label || fmt.part(k), disabled: ro });
    const start = c.input({ type: 'time', value: p.start || '', disabled: ro });
    const end = c.input({ type: 'time', value: p.end || '', disabled: ro });
    const fStart = c.field({ label: 'Mulai', input: start });
    const fEnd = c.field({ label: 'Selesai', input: end });
    const node = el('div', { class: 'card card-soft card-sm stack-sm part-editor' },
      el('div', { class: 'row gap-2' }, c.badge({ status: k, text: fmt.part(k), size: 'lg' }), el('span', { class: 'text-sm text-muted' }, partDesc[k])),
      c.field({ label: 'Label', input: label }),
      el('div', { class: 'form-grid' }, fStart, fEnd));
    return { k, node, label, start, end, fStart, fEnd };
  });
  const threshold = numField('Batas jam sebelum pembatalan', (s.cancel_rule && s.cancel_rule.threshold_hours) ?? 5, { min: 0, step: 0.5, integer: false, hint: 'Sisa waktu ke ship_by_date kurang dari ini → order tanpa tipe HP tetap diproses dengan tanda TIPE BELUM DITULIS.' });
  const timeSrc = c.select({ options: [{ value: 'ship_by_date', label: 'ship_by_date (batas kirim dari Shopee)' }], value: (s.cancel_rule && s.cancel_rule.time_source) || 'ship_by_date', disabled: ro });

  const body = el('div', { class: 'stack' },
    fKw,
    c.divider('Jam part (WIB)'),
    el('div', { class: 'parts-grid' }, partEds.map((p) => p.node)),
    el('div', { class: 'notice-box' }, 'Part otomatis: sebelum jam mulai Part 2 → Part 1; sebelum jam mulai Part 3 → Part 2; selain itu Part 3. Part selalu bisa dipilih manual saat proses.'),
    c.divider('Batas pembatalan'),
    el('div', { class: 'form-grid' }, threshold, c.field({ label: 'Sumber waktu batas', input: timeSrc })));

  return el('div', { class: 'settings-section' }, sectionCard({
    key: 'shipping', icon: 'truck', title: 'Pengiriman & Part', subtitle: 'Deteksi kurir instant, jendela waktu part, dan aturan dekat batas pembatalan.', body,
    onSave: () => {
      let ok = true;
      if (!kw.value.length) { fKw.setError('Isi minimal satu kata kunci'); ok = false; }
      const mins = {};
      for (const p of partEds) {
        const a = hhmmToMin(p.start.value), b = hhmmToMin(p.end.value);
        p.fStart.setError(null); p.fEnd.setError(null);
        if (a === null) { p.fStart.setError('Format HH:MM'); ok = false; }
        if (b === null) { p.fEnd.setError('Format HH:MM'); ok = false; }
        if (a !== null && b !== null && a >= b) { p.fEnd.setError('Harus setelah jam mulai'); ok = false; }
        mins[p.k] = a;
      }
      if (ok && !(mins.p1 < mins.p2 && mins.p2 < mins.p3)) { partEds[1].fStart.setError('Urutan jam mulai harus Part 1 < Part 2 < Part 3'); ok = false; }
      if (!threshold.check()) ok = false;
      if (!ok) return false;
      const partsOut = {};
      for (const p of partEds) partsOut[p.k] = { label: p.label.value.trim() || fmt.part(p.k), start: p.start.value, end: p.end.value };
      return { shipping_rules: { instant_keywords: kw.value }, parts: partsOut, cancel_rule: { threshold_hours: threshold.num(), time_source: timeSrc.value } };
    },
  }));
}

// ---------------------------------------------------------------------------
// Bagian: Proses & PDF
// ---------------------------------------------------------------------------
function buildProcessSection() {
  const s = state.settings; const ro = state.ro;
  const p = { document_type: 'NORMAL_AIR_WAYBILL', delivery_method: 'auto', all_warehouses_mode: 'split', max_orders_per_run: 500, doc_wait_seconds: 90, concurrency: 3, sender_real_name: '', ...(s.process || {}) };
  const docType = c.select({ options: labelOptions(DOC_TYPE_LABEL, metaList('document_types', ['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'])), value: p.document_type, disabled: ro });
  const delivery = c.select({ options: metaList('delivery_methods', ['auto', 'pickup', 'dropoff']).map((k) => ({ value: k, label: k === 'auto' ? 'Otomatis (ikuti Shopee)' : fmt.deliveryMethod(k) })), value: p.delivery_method, disabled: ro });
  const whMode = c.select({ options: labelOptions(WH_MODE_LABEL, metaList('all_warehouses_modes', ['split', 'merge'])), value: p.all_warehouses_mode, disabled: ro });
  const maxRun = numField('Maks. order per run', p.max_orders_per_run, { min: 1, max: 5000, step: 1 });
  const docWait = numField('Waktu tunggu dokumen (detik)', p.doc_wait_seconds, { min: 5, max: 900, step: 1, hint: 'Batas menunggu Shopee menyiapkan label AWB per order.' });
  const conc = numField('Paralel per order', p.concurrency, { min: 1, max: 10, step: 1, hint: 'Jumlah order yang diproses bersamaan.' });
  const sender = c.input({ value: p.sender_real_name || '', placeholder: 'Glass Pro', disabled: ro, maxlength: 100 });
  const body = el('div', { class: 'form-grid' },
    c.field({ label: 'Jenis dokumen label', input: docType, hint: 'Thermal cocok untuk printer label A6.' }),
    c.field({ label: 'Metode pengiriman', input: delivery, hint: 'Pickup = dijemput kurir; Drop-off = antar ke counter.' }),
    c.field({ label: 'Filter "Semua gudang"', input: whMode, hint: 'Saat memproses semua gudang sekaligus.' }),
    maxRun, docWait, conc,
    el('div', { class: 'span-2' }, c.field({ label: 'Nama pengirim (sender_real_name)', input: sender, hint: 'Dikirim ke Shopee saat arrange shipment bila diminta.' })));
  return el('div', { class: 'settings-section' }, sectionCard({
    key: 'process', icon: 'pdf', title: 'Proses & PDF', subtitle: 'Cara shipment diatur di Shopee dan bagaimana label AWB diunduh lalu digabung.', body,
    onSave: () => {
      if (![maxRun.check(), docWait.check(), conc.check()].every(Boolean)) return false;
      return { process: { document_type: docType.value, delivery_method: delivery.value, all_warehouses_mode: whMode.value, max_orders_per_run: maxRun.num(), doc_wait_seconds: docWait.num(), concurrency: conc.num(), sender_real_name: sender.value.trim() } };
    },
  }));
}

// ---------------------------------------------------------------------------
// Bagian: Sinkronisasi
// ---------------------------------------------------------------------------
function syncStatusCard() {
  const body = el('div');
  const renderBody = () => {
    const st = state.sync;
    if (!st) { body.replaceChildren(c.emptyState({ icon: 'sync', size: 'sm', title: 'Status sync tidak tersedia', text: 'Modul sinkronisasi tidak merespons.' })); return; }
    const sh = (st.marketplaces && st.marketplaces.shopee) || {};
    const statusBadge = st.running ? c.badge({ text: 'Sedang berjalan', tone: 'primary', dot: true }) : c.badge({ status: sh.status || 'never', text: fmt.syncStatus(sh.status || 'never'), dot: true });
    const last = st.last || null;
    body.replaceChildren(c.kv([
      ['Status', statusBadge],
      ['Toko Shopee', sh.connected ? el('span', { class: 'row gap-2' }, sh.shop_name || 'Terhubung', c.badge({ status: 'connected', size: 'sm' })) : c.badge({ text: 'Belum terhubung', tone: 'danger', size: 'sm' })],
      ['Sukses terakhir', sh.last_ok_at ? `${fmt.datetime(sh.last_ok_at)} (${fmt.relative(sh.last_ok_at)})` : 'Belum pernah'],
      ['Terakhir dicoba', last && (last.finished_at || last.started_at) ? `${fmt.datetime(last.finished_at || last.started_at)} · ${fmt.syncStatus(last.status)}${last.fetched !== undefined && last.fetched !== null ? ` · ${fmt.number(last.fetched)} order ditarik` : ''}` : '-'],
      ['Jadwal otomatis', st.enabled ? `Aktif, tiap ${fmt.number(st.interval_minutes)} menit${st.next_at ? ` · berikutnya ${fmt.time(st.next_at)} (${fmt.relative(st.next_at)})` : ''}` : 'Nonaktif'],
      sh.last_error ? ['Error terakhir', el('span', { class: 'text-danger' }, sh.last_error)] : null,
    ]));
  };
  renderBody();
  const refresh = async () => {
    const snap = state;
    let st = null;
    try { st = await api.get('/api/sync/status'); } catch (e) { if (e && e.status !== 401) console.warn(e); }
    if (!alive(snap)) return;
    if (st) state.sync = st;
    renderBody();
  };
  const syncBtn = c.button({ label: 'Sync sekarang', kind: 'primary', size: 'sm', icon: 'sync', onClick: async (e, btn) => {
    btn.setLoading(true);
    try {
      const layout = state.ctx && state.ctx.layout;
      if (layout && layout.syncNow) await layout.syncNow();
      else { const r = await api.post('/api/sync/now'); toast[r && r.status === 'ok' ? 'success' : 'warn'](`Sync ${r && r.status === 'ok' ? 'selesai' : 'berakhir'}: ${fmt.number((r && r.fetched) || 0)} order ditarik.`); }
    } catch (err) { if (err && err.status !== 401) toast.error(errMsg(err, 'Sinkronisasi gagal')); }
    finally { btn.setLoading(false); refresh(); }
  } });
  const card = c.card({ icon: 'activity', title: 'Status sinkronisasi', subtitle: 'Kondisi penarikan order dari Shopee saat ini.', actions: [c.iconButton({ icon: 'refresh', title: 'Muat ulang status', kind: 'secondary', size: 'sm', onClick: refresh }), syncBtn], body });
  card.refresh = refresh;
  return card;
}

function buildSyncSection() {
  const s = state.settings; const ro = state.ro;
  const sy = { enabled: true, interval_minutes: 5, lookback_days: 7, statuses: ['READY_TO_SHIP', 'PROCESSED'], include_recent_updates: true, ...(s.sync || {}) };
  const enabled = c.toggle({ label: 'Sync otomatis aktif', checked: !!sy.enabled, disabled: ro });
  const interval = numField('Interval (menit)', sy.interval_minutes, { min: 1, max: 1440, step: 1 });
  const lookback = numField('Rentang hari ke belakang', sy.lookback_days, { min: 1, max: 90, step: 1, hint: 'Order dengan create_time dalam N hari terakhir ditarik.' });
  const statusBoxes = SYNC_STATUSES.map((k) => c.checkbox({ label: `${k} · ${fmt.orderStatus(k)}`, checked: (sy.statuses || []).includes(k), disabled: ro }));
  const includeRecent = c.toggle({ label: 'Tarik juga order yang berubah (2 hari terakhir, semua status)', checked: !!sy.include_recent_updates, disabled: ro });
  const fStatuses = c.field({ label: 'Status order yang ditarik', input: el('div', { class: 'stack-sm' }, statusBoxes), hint: 'PROCESSED = shipment sudah diatur, tinggal cetak label.' });
  const body = el('div', { class: 'form-grid' },
    el('div', { class: 'span-2 stack-sm' }, enabled, includeRecent),
    interval, lookback,
    el('div', { class: 'span-2' }, fStatuses));
  const statusCard = syncStatusCard();
  return el('div', { class: 'settings-section' }, statusCard, sectionCard({
    key: 'sync', icon: 'sync', title: 'Pengaturan sinkronisasi', subtitle: 'Jadwal dan cakupan penarikan order otomatis.', body,
    note: 'Deteksi pembatalan/perubahan order memerlukan opsi "tarik order yang berubah".',
    onSave: () => {
      if (![interval.check(), lookback.check()].every(Boolean)) return false;
      const statuses = SYNC_STATUSES.filter((k, i) => statusBoxes[i].checked);
      if (!statuses.length) { fStatuses.setError('Pilih minimal satu status'); return false; }
      return { sync: { enabled: enabled.checked, interval_minutes: interval.num(), lookback_days: lookback.num(), statuses, include_recent_updates: includeRecent.checked } };
    },
    afterSave: async () => { const snap = state; try { const st = await api.get('/api/sync/status'); if (alive(snap)) state.sync = st; } catch { /* abaikan */ } if (alive(snap) && state.ctx && state.ctx.layout && state.ctx.layout.refreshSync) state.ctx.layout.refreshSync(); },
  }));
}

// ---------------------------------------------------------------------------
// Bagian: Pengguna (admin)
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function userFormModal({ mode, user, onDone }) {
  const isEdit = mode === 'edit';
  const me = store.user || {};
  const isSelf = isEdit && user.id === me.id;
  const err = errorBox();
  const username = c.input({ value: isEdit ? user.username : '', placeholder: 'mis. budi', mono: true, icon: 'user', disabled: isEdit, autocomplete: 'off' });
  const fUsername = c.field({ label: 'Username', input: username, hint: isEdit ? 'Username tidak dapat diubah.' : '3–32 karakter: huruf kecil, angka, titik, garis bawah, strip.', required: !isEdit });
  const name = c.input({ value: isEdit ? user.name || '' : '', placeholder: 'Nama lengkap', autocomplete: 'off' });
  const fName = c.field({ label: 'Nama', input: name, required: true });
  const role = c.select({ options: metaList('roles', ['admin', 'staff']).map((k) => ({ value: k, label: fmt.role(k) })), value: isEdit ? user.role : 'staff', disabled: isSelf });
  const fRole = c.field({ label: 'Role', input: role, hint: isSelf ? 'Role akun sendiri tidak dapat diubah.' : 'Admin dapat mengubah pengaturan dan pengguna.' });
  const active = c.toggle({ label: 'Akun aktif', checked: isEdit ? !!user.active : true, disabled: isSelf });
  const password = c.input({ type: 'password', placeholder: isEdit ? 'Kosongkan bila tidak diganti' : 'Minimal 6 karakter', icon: 'lock', autocomplete: 'new-password' });
  const fPassword = c.field({ label: isEdit ? 'Reset password' : 'Password', input: password, required: !isEdit });
  const body = el('div', { class: 'stack' }, err, fUsername, fName, fRole, isEdit ? active : null, fPassword);
  modal.open({
    title: isEdit ? `Ubah pengguna @${user.username}` : 'Tambah pengguna', subtitle: isEdit ? 'Perubahan berlaku pada login berikutnya.' : 'Akun baru langsung bisa dipakai untuk masuk.', body,
    actions: [
      { label: 'Batal', kind: 'secondary' },
      { label: isEdit ? 'Simpan' : 'Tambah', kind: 'primary', icon: isEdit ? 'save' : 'plus', onClick: async (handle) => {
        err.clear();
        let ok = true;
        const u = username.value.trim().toLowerCase();
        const n = name.value.trim();
        const pw = password.value;
        if (!isEdit && !USERNAME_RE.test(u)) { fUsername.setError('Username 3–32 karakter: huruf kecil, angka, titik, garis bawah, strip'); ok = false; }
        if (!n) { fName.setError('Nama wajib diisi'); ok = false; }
        if ((!isEdit || pw) && pw.length < 6) { fPassword.setError('Password minimal 6 karakter'); ok = false; }
        if (!ok) { resetModalButtons(handle); return false; }
        try {
          if (isEdit) {
            const patch = { name: n };
            if (!isSelf) { patch.role = role.value; patch.active = active.checked; }
            if (pw) patch.password = pw;
            await api.patch(`/api/settings/users/${user.id}`, patch);
            toast.success(`Pengguna @${user.username} diperbarui.`);
          } else {
            await api.post('/api/settings/users', { username: u, password: pw, name: n, role: role.value });
            toast.success(`Pengguna @${u} ditambahkan.`);
          }
          if (onDone) onDone();
          return true;
        } catch (e) {
          if (e && e.status === 401) return true;
          err.show(errMsg(e, 'Gagal menyimpan pengguna'));
          resetModalButtons(handle);
          return false;
        }
      } },
    ],
  });
}

function buildUsersSection() {
  const me = store.user || {};
  const tbl = c.table({
    columns: [
      { key: 'name', label: 'Pengguna', render: (u) => el('div', { class: 'row gap-3' }, c.avatar({ name: u.name || u.username, size: 'sm' }), el('div', { class: 'min-w-0' }, el('div', { class: 'table-cell-main' }, u.name || u.username, u.id === me.id ? el('span', { class: 'text-muted fw-500' }, ' (Anda)') : null), el('div', { class: 'table-cell-sub mono' }, `@${u.username}`))) },
      { key: 'role', label: 'Role', render: (u) => c.badge({ status: u.role, text: fmt.role(u.role), icon: u.role === 'admin' ? 'shield' : null }) },
      { key: 'active', label: 'Status', render: (u) => c.badge({ text: u.active ? 'Aktif' : 'Nonaktif', tone: u.active ? 'success' : 'neutral', dot: true }) },
      { key: 'last_login_at', label: 'Login terakhir', className: 'hide-mobile', headerClass: 'hide-mobile', render: (u) => (u.last_login_at ? el('span', { title: fmt.datetime(u.last_login_at) }, fmt.relative(u.last_login_at)) : el('span', { class: 'text-muted' }, 'Belum pernah')) },
      { key: 'created_at', label: 'Dibuat', className: 'hide-mobile', headerClass: 'hide-mobile', render: (u) => fmt.date(u.created_at) },
      { key: 'actions', label: '', align: 'right', render: (u) => el('div', { class: 'row-end gap-1' },
        c.iconButton({ icon: 'edit', title: 'Ubah', kind: 'soft', size: 'sm', onClick: () => userFormModal({ mode: 'edit', user: u, onDone: loadUsers }) }),
        c.iconButton({ icon: 'trash', title: u.id === me.id ? 'Tidak dapat menghapus akun sendiri' : 'Hapus', kind: 'danger-soft', size: 'sm', disabled: u.id === me.id, onClick: async () => {
          const ok = await modal.confirm({ title: `Hapus pengguna @${u.username}?`, message: `${u.name || u.username} tidak akan bisa masuk lagi. Riwayat aktivitasnya tetap tersimpan.`, confirmLabel: 'Ya, hapus', danger: true });
          if (!ok) return;
          try { await api.del(`/api/settings/users/${u.id}`); toast.success(`Pengguna @${u.username} dihapus.`); loadUsers(); }
          catch (e) { if (e && e.status !== 401) toast.error(errMsg(e, 'Gagal menghapus pengguna')); }
        } })) },
    ],
    rows: state.users || [], rowKey: 'id', loading: !state.users,
    empty: { icon: 'users', title: 'Belum ada pengguna', text: 'Tambahkan akun staf agar bisa memproses order.' },
  });
  state.usersTable = tbl;
  const addBtn = c.button({ label: 'Tambah pengguna', kind: 'primary', size: 'sm', icon: 'plus', onClick: () => userFormModal({ mode: 'add', onDone: loadUsers }) });
  const card = c.card({ icon: 'users', title: 'Pengguna', subtitle: 'Akun yang dapat masuk ke Glass Pro Suite. Harus tersisa minimal satu admin aktif.', flush: true, actions: [c.iconButton({ icon: 'refresh', title: 'Muat ulang', kind: 'secondary', size: 'sm', onClick: loadUsers }), addBtn], body: tbl });
  if (!state.users) loadUsers();
  return el('div', { class: 'settings-section' }, card);
}

async function loadUsers() {
  if (!state) return;
  const snap = state;
  try {
    const r = await api.get('/api/settings/users');
    if (!alive(snap)) return; // halaman sudah ditinggalkan
    state.users = (r && r.users) || [];
    if (state.usersTable) state.usersTable.update({ rows: state.users });
  } catch (e) {
    if (e && e.status === 401) return;
    toast.error(errMsg(e, 'Gagal memuat pengguna'));
    if (alive(snap) && state.usersTable) state.usersTable.update({ rows: [] });
  }
}

// ---------------------------------------------------------------------------
// Bagian: Akun saya
// ---------------------------------------------------------------------------
function buildAccountSection() {
  const me = store.user || {};
  const profile = c.card({ icon: 'user', title: 'Profil', subtitle: 'Data akun yang sedang masuk.',
    body: el('div', { class: 'row-start gap-4 wrap' }, c.avatar({ name: userName(me) || '?', size: 'xl' }),
      c.kv([['Nama', userName(me) || '-'], ['Username', el('span', { class: 'mono' }, `@${me.username || '-'}`)], ['Role', c.badge({ status: me.role, text: fmt.role(me.role), icon: me.role === 'admin' ? 'shield' : null })], ['Login terakhir', me.last_login_at ? fmt.datetime(me.last_login_at) : '-']])) });

  const err = errorBox();
  const cur = c.input({ type: 'password', placeholder: 'Password saat ini', icon: 'lock', autocomplete: 'current-password' });
  const nw = c.input({ type: 'password', placeholder: 'Minimal 6 karakter', icon: 'key', autocomplete: 'new-password' });
  const cf = c.input({ type: 'password', placeholder: 'Ulangi password baru', icon: 'key', autocomplete: 'new-password' });
  const fCur = c.field({ label: 'Password saat ini', input: cur, required: true });
  const fNew = c.field({ label: 'Password baru', input: nw, required: true });
  const fCf = c.field({ label: 'Konfirmasi password baru', input: cf, required: true });
  const btn = c.button({ label: 'Ganti password', kind: 'primary', icon: 'save', onClick: async () => {
    err.clear();
    let ok = true;
    if (!cur.value) { fCur.setError('Wajib diisi'); ok = false; }
    if (nw.value.length < 6) { fNew.setError('Password baru minimal 6 karakter'); ok = false; }
    if (nw.value !== cf.value) { fCf.setError('Konfirmasi tidak sama dengan password baru'); ok = false; }
    if (ok && nw.value === cur.value) { fNew.setError('Password baru harus berbeda dari password saat ini'); ok = false; }
    if (!ok) return;
    btn.setLoading(true);
    try {
      await api.post('/api/auth/change-password', { current_password: cur.value, new_password: nw.value });
      toast.success('Password berhasil diganti.');
      cur.value = ''; nw.value = ''; cf.value = '';
    } catch (e) {
      if (e && e.status === 401) return;
      const msg = errMsg(e, 'Gagal mengganti password');
      if (e && e.code === 'wrong_password') fCur.setError(msg); else err.show(msg);
    } finally { btn.setLoading(false); }
  } });
  const form = el('form', { class: 'stack', novalidate: true, onSubmit: (e) => { e.preventDefault(); btn.click(); } },
    err, el('div', { class: 'form-grid' }, el('div', { class: 'span-2' }, fCur), fNew, fCf), el('div', { class: 'form-actions' }, btn));
  const pw = c.card({ icon: 'lock', title: 'Ganti password', subtitle: 'Gunakan password yang tidak dipakai di layanan lain.', body: form });
  return el('div', { class: 'settings-section' }, profile, pw);
}

export const page = { title, render, destroy };
export default page;
