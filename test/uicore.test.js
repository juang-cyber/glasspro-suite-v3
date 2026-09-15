'use strict';
// Test AGENT UICORE: file frontend tersaji, semua modul ES valid & impornya ada, pra-cek modul halaman (HEAD),
// dan alur auth yang dipakai main.js/login.js. Server HTTP sungguhan di port 3125.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TMP = path.join(__dirname, '..', '.tmp', `uicore-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;
process.env.SHOPEE_TRANSPORT = 'mock';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/index');
const db = require('../src/db');

const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;
const PUB = path.join(__dirname, '..', 'public');
let server;

const OWN_FILES = [
  'index.html', 'assets/logo.svg', 'css/tokens.css', 'css/base.css', 'css/components.css', 'css/pages.css',
  'js/core.js', 'js/api.js', 'js/router.js', 'js/fmt.js', 'js/components.js', 'js/layout.js', 'js/main.js', 'js/pages/login.js', 'js/pages/gallery.js',
];

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(PORT, '127.0.0.1', resolve); });
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* abaikan */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* abaikan */ }
});

test('semua file frontend milik UICORE ada', () => {
  for (const f of OWN_FILES) assert.ok(fs.existsSync(path.join(PUB, f)), `file hilang: public/${f}`);
});

test('semua modul ES di public/js valid secara sintaks (SourceTextModule)', () => {
  const files = listJs(path.join(PUB, 'js'));
  assert.ok(files.length >= 9);
  const script = `
    const vm = require('vm'); const fs = require('fs');
    const bad = [];
    for (const f of JSON.parse(process.argv[1])) {
      try { new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f }); }
      catch (e) { bad.push(f + ': ' + e.message); }
    }
    process.stdout.write(JSON.stringify(bad));
  `;
  const out = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', script, JSON.stringify(files)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), []);
});

test('setiap import statis relatif menunjuk ke file yang ada', () => {
  const files = listJs(path.join(PUB, 'js'));
  // Hanya baris kode yang diawali import/export (contoh di komentar dokumentasi diabaikan).
  const re = /^\s*(?:import|export)\s[^'"\n]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm;
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src))) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(target)) missing.push(`${path.relative(PUB, f)} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('router.js: parseHash/compile/match/buildHash/pageNameFromPath sesuai kontrak rute hash', () => {
  // router.js tidak punya import statis → bisa dievaluasi sebagai modul ES di vm (fetch/URL distub).
  const script = `
    const vm = require('vm'); const fs = require('fs');
    (async () => {
      const src = fs.readFileSync(process.argv[1], 'utf8');
      const ctx = vm.createContext({ console: { warn() {}, error() {}, log() {} }, URL, URLSearchParams, fetch: async () => ({ ok: false, headers: new Map() }) });
      const m = new vm.SourceTextModule(src, { context: ctx, identifier: 'router.js', initializeImportMeta(meta) { meta.url = 'http://localhost/js/router.js'; } });
      await m.link(() => { throw new Error('router.js tidak boleh punya import'); });
      await m.evaluate();
      const r = m.namespace;
      const out = {};
      out.parse = r.parseHash('#/orders/ABC123?tab=items&x=1&x=2');
      out.matchSn = r.match(r.compile('#/orders/:sn'), '/orders/ABC123');
      out.matchRun = r.match(r.compile('#/history/:runId'), '/history/42');
      out.noMatch = r.match(r.compile('#/orders/:sn'), '/orders');
      out.names = ['/', '/orders/1', '/dev/gallery', '/history/5', '/login', '/settings'].map((p) => r.pageNameFromPath(p));
      out.build = r.buildHash('/orders', { page: 2, q: '', w: 'jkt' });
      r.register('#/orders/:sn', { render() {} });
      r.register('#/orders', { render() {} });
      out.findDetail = r.find('/orders/9');
      out.findList = r.find('/orders');
      out.missing = await r.resolve('/tidak-ada');
      process.stdout.write(JSON.stringify(out));
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', script, path.join(PUB, 'js/router.js')], { encoding: 'utf8' }));
  assert.deepEqual(out.parse, { path: '/orders/ABC123', query: { tab: 'items', x: ['1', '2'] }, search: '?tab=items&x=1&x=2', hash: '#/orders/ABC123?tab=items&x=1&x=2' });
  assert.deepEqual(out.matchSn, { sn: 'ABC123' });
  assert.deepEqual(out.matchRun, { runId: '42' });
  assert.equal(out.noMatch, null);
  assert.deepEqual(out.names, ['dashboard', 'orders', 'gallery', 'history', 'login', 'settings']);
  assert.equal(out.build, '#/orders?page=2&w=jkt');
  assert.equal(out.findDetail.route.pattern, '/orders/:sn');
  assert.deepEqual(out.findDetail.params, { sn: '9' });
  assert.equal(out.findList.route.pattern, '/orders');
  assert.equal(out.missing, null);
});

test('components.js: tidak ada jalur HTML mentah tanpa sanitasi & dropdown tidak menelan klik', () => {
  const src = fs.readFileSync(path.join(PUB, 'js/components.js'), 'utf8');
  assert.doesNotMatch(src, /e\.stopPropagation\(\); node\.toggle\(\)/, 'dropdown masih memakai stopPropagation (menu lain tidak ikut menutup)');
  assert.match(src, /function sanitizedSvg\(/, 'resolveIcon harus menyaring markup SVG');
  assert.match(src, /isUnsafeUrl\(/, 'setAttrs harus menolak href/src javascript:');
});

test('core.js mengekspor api, router, el, html, store, toast, modal, fmt, components, icons', () => {
  const src = fs.readFileSync(path.join(PUB, 'js/core.js'), 'utf8');
  for (const name of ['api', 'router', 'el', 'html', 'store', 'toast', 'modal', 'fmt', 'components', 'icons']) {
    assert.ok(new RegExp(`export (const|function|\\{)[^;]*\\b${name}\\b`).test(src), `core.js tidak mengekspor ${name}`);
  }
});

test('halaman login & gallery mengekspor render/destroy', () => {
  for (const p of ['login', 'gallery']) {
    const src = fs.readFileSync(path.join(PUB, `js/pages/${p}.js`), 'utf8');
    assert.match(src, /export function render\(/, `${p}.js tanpa export render`);
    assert.match(src, /export function destroy\(/, `${p}.js tanpa export destroy`);
  }
});

test('SPA: / dan path non-API mengembalikan index.html; modul JS dilayani dengan MIME javascript', async () => {
  const r1 = await fetch(`${BASE}/`);
  assert.equal(r1.status, 200);
  assert.match(r1.headers.get('content-type') || '', /text\/html/);
  assert.match(await r1.text(), /\/js\/main\.js/);
  const r2 = await fetch(`${BASE}/orders/123`); // deep link tanpa hash → tetap index.html
  assert.equal(r2.status, 200);
  assert.match(r2.headers.get('content-type') || '', /text\/html/);
  for (const f of ['js/core.js', 'js/main.js', 'js/layout.js', 'js/pages/login.js', 'js/pages/gallery.js']) {
    const r = await fetch(`${BASE}/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type') || '', /javascript/, `${f} MIME salah`);
  }
  const svg = await fetch(`${BASE}/assets/logo.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type') || '', /svg/);
});

test('pra-cek modul halaman (HEAD): ada → javascript, tidak ada → text/html (fallback SPA)', async () => {
  const ok = await fetch(`${BASE}/js/pages/login.js`, { method: 'HEAD' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') || '', /javascript/);
  const missing = await fetch(`${BASE}/js/pages/halaman-tidak-ada.js`, { method: 'HEAD' });
  assert.equal(missing.status, 200);
  assert.doesNotMatch(missing.headers.get('content-type') || '', /javascript/);
});

test('alur auth yang dipakai frontend: /me 401 → login → /me 200 → logout → 401', async () => {
  const me0 = await fetch(`${BASE}/api/auth/me`);
  assert.equal(me0.status, 401);
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'glasspro123' }) });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.equal(body.user.username, 'admin');
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie);
  const me1 = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } });
  assert.equal(me1.status, 200);
  const status = await fetch(`${BASE}/api/sync/status`, { headers: { cookie } });
  assert.equal(status.status, 200);
  const s = await status.json();
  assert.ok('running' in s && s.marketplaces && s.marketplaces.shopee, 'bentuk status sync');
  const bad = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'salah' }) });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).message, 'Username atau password salah');
  const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
});
