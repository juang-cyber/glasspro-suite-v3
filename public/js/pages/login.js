/**
 * Halaman login (#/login) — tanpa shell.
 * Kiri: panel gradien indigo (logo, tagline, 3 poin fitur). Kanan: kartu form username/password.
 * Sukses → store.user → tujuan tersimpan / #/.
 */
import { api, router, store, el, toast, components as c, icons, takeNext } from '../core.js';

const FEATURES = [
  { icon: 'sync', title: 'Sinkron otomatis dari Shopee', text: 'Order Siap Kirim ditarik berkala, dikelompokkan per part, jenis pengiriman, kategori, dan gudang.' },
  { icon: 'checkCircle', title: 'Validasi tipe HP sebelum cetak', text: 'Order tanpa tipe HP ditahan atau diberi tanda besar, jadi tidak ada label yang salah.' },
  { icon: 'pdf', title: 'Label AWB & Product List siap cetak', text: 'PDF digabung per kategori lengkap dengan cover dan stempel marketplace.' },
];

let cleanup = null;

export const title = 'Masuk';

export function render(container) {
  destroy();
  const year = new Date().getFullYear();

  // ---------- Panel kiri ----------
  const left = el('section', { class: 'login-left', 'aria-hidden': 'true' },
    el('div', { class: 'login-brand' },
      el('span', { class: 'brand-mark brand-mark-lg' }, icons.logo({ size: 28, strokeWidth: 2 })),
      el('div', null, el('div', { class: 'login-brand-text' }, 'Glass Pro Suite'), el('div', { class: 'login-brand-sub' }, 'Pemrosesan order marketplace'))),
    el('div', { class: 'login-hero' },
      el('span', { class: 'login-hero-eyebrow' }, icons.sparkles({ size: 13 }), 'Shopee Open Platform'),
      el('h1', { class: 'login-tagline' }, 'Proses order Shopee lebih cepat, rapi, dan tanpa salah label'),
      el('p', { class: 'login-tagline-sub' }, 'Satu tempat untuk menarik order, memeriksa tipe HP, mengatur pengiriman, dan mencetak label AWB per kategori — dalam hitungan menit setiap part.'),
      el('div', { class: 'login-features' }, FEATURES.map((f) => el('div', { class: 'login-feature' },
        el('span', { class: 'login-feature-icon' }, icons.get(f.icon, { size: 18 })),
        el('div', { class: 'min-w-0' }, el('div', { class: 'login-feature-title' }, f.title), el('div', { class: 'login-feature-text' }, f.text)))))),
    el('div', { class: 'login-footer' }, el('span', `© ${year} Glass Pro`), el('span', 'Zona waktu WIB (Asia/Jakarta)')));

  // ---------- Form ----------
  const userInput = c.input({ name: 'username', id: 'username', placeholder: 'Nama pengguna', icon: 'user', autocomplete: 'username', autofocus: true, size: 'lg', required: true });
  let showPass = false;
  const eyeBtn = c.iconButton({ icon: 'eye', kind: 'ghost', size: 'sm', title: 'Lihat password', onClick: () => {
    showPass = !showPass;
    passInput.input.type = showPass ? 'text' : 'password';
    eyeBtn.replaceChildren(icons.get(showPass ? 'eyeOff' : 'eye', { size: 16 }));
    eyeBtn.title = showPass ? 'Sembunyikan password' : 'Lihat password';
    eyeBtn.setAttribute('aria-label', eyeBtn.title);
    passInput.input.focus();
  } });
  const passInput = c.input({ name: 'password', id: 'password', type: 'password', placeholder: 'Password', icon: 'lock', suffix: eyeBtn, autocomplete: 'current-password', size: 'lg', required: true });
  const userField = c.field({ label: 'Username', input: userInput });
  const passField = c.field({ label: 'Password', input: passInput });
  const errorBox = el('div', { class: 'login-error', hidden: true, role: 'alert' });
  const submitBtn = c.button({ label: 'Masuk', kind: 'primary', size: 'lg', block: true, type: 'submit', iconRight: 'arrowRight' });

  const showError = (msg) => {
    errorBox.replaceChildren(c.alert({ tone: 'danger', text: msg, icon: 'alertCircle' }));
    errorBox.hidden = false;
  };
  const clearError = () => { errorBox.hidden = true; errorBox.replaceChildren(); };

  let busy = false;
  const submit = async (ev) => {
    if (ev) ev.preventDefault();
    if (busy) return;
    clearError();
    const username = userInput.value.trim();
    const password = passInput.value;
    let ok = true;
    if (!username) { userField.setError('Username wajib diisi'); ok = false; }
    if (!password) { passField.setError('Password wajib diisi'); ok = false; }
    if (!ok) { (username ? passInput : userInput).focus(); return; }
    busy = true;
    submitBtn.setLoading(true);
    userInput.input.disabled = true; passInput.input.disabled = true;
    try {
      const r = await api.post('/api/auth/login', { username, password });
      store.user = (r && r.user) || null;
      if (!store.user) throw new Error('Respons login tidak valid');
      toast.success(`Selamat datang, ${store.user.name || store.user.username}!`, { timeout: 2500 });
      router.navigate(takeNext('#/'), { replace: true });
    } catch (e) {
      const status = e && e.status;
      let msg = (e && e.message) || 'Tidak dapat masuk';
      if (status === 401) msg = 'Username atau password salah.';
      else if (status === 429) msg = e.message || 'Terlalu banyak percobaan. Coba lagi dalam 5 menit.';
      else if (status === 0) msg = 'Tidak dapat terhubung ke server. Periksa koneksi Anda.';
      showError(msg);
      userInput.input.disabled = false; passInput.input.disabled = false;
      submitBtn.setLoading(false);
      busy = false;
      if (status === 401) { passInput.value = ''; passInput.focus(); }
    }
  };

  const form = el('form', { class: 'login-form', novalidate: true, onSubmit: submit, autocomplete: 'on' },
    userField, passField, errorBox, submitBtn);
  // Enter di input mana pun → submit (form menangani secara native; tambahan untuk input yang dibungkus group)
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  userInput.input.addEventListener('keydown', onKey);
  passInput.input.addEventListener('keydown', onKey);

  const card = el('div', { class: 'card login-card' },
    el('div', { class: 'login-mobile-brand' },
      el('span', { class: 'brand-mark' }, icons.logo({ size: 20, strokeWidth: 2 })),
      el('span', { class: 'brand-text' }, 'Glass Pro Suite')),
    el('h2', { class: 'login-card-title' }, 'Selamat datang'),
    el('p', { class: 'login-card-sub' }, 'Masuk dengan akun staf Glass Pro untuk mulai memproses order.'),
    form,
    el('p', { class: 'login-hint' }, 'Lupa password? Hubungi admin untuk mengatur ulang.'));

  const right = el('section', { class: 'login-right' }, card);
  const page = el('div', { class: 'login' }, left, right);
  container.replaceChildren(page);

  requestAnimationFrame(() => { try { userInput.input.focus(); } catch { /* abaikan */ } });
  cleanup = () => { userInput.input.removeEventListener('keydown', onKey); passInput.input.removeEventListener('keydown', onKey); };
}

export function destroy() {
  if (cleanup) { try { cleanup(); } catch { /* abaikan */ } cleanup = null; }
}

export const page = { title, render, destroy };
export default page;
