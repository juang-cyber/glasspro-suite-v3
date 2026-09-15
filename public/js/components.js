/**
 * components — pembuat DOM (el/html), set ikon SVG, toast, modal, dan komponen UI Glass Pro Suite.
 * Semua komponen mengembalikan HTMLElement siap dipasang (container.append(...)).
 * Tidak ada dependency; hanya memakai fmt.js untuk label/tone.
 *
 * ---------------------------------------------------------------------------
 * CONTOH PEMAKAIAN (lihat juga #/dev/gallery)
 * ---------------------------------------------------------------------------
 *   import { el, html, components as c, icons, toast, modal, fmt } from '../core.js';
 *
 *   // DOM builder
 *   const box = el('div', { class: 'row', onClick: () => alert('hai') }, 'Halo ', el('b', 'dunia'));
 *   const frag = html`<p class="text-muted">Total: <b>${fmt.number(1234)}</b> ${c.badge({ status: 'processed' })}</p>`;
 *
 *   // KPI
 *   c.statCard({ label: 'Belum diproses', value: 42, delta: 12, deltaLabel: 'vs kemarin', icon: icons.box, tone: 'primary',
 *                chart: { type: 'bar', values: [3, 5, 2, 8, 6, 9, 7] } });
 *
 *   // Badge (tone otomatis dari status lewat fmt.tone / label lewat fmt.statusLabel)
 *   c.badge({ status: 'review' });                 // → "Perlu diperiksa" kuning
 *   c.badge({ text: 'Instant', tone: 'primary' });
 *
 *   // Tabel
 *   c.table({
 *     columns: [
 *       { key: 'order_sn', label: 'No. Order', render: (r) => el('span', { class: 'mono' }, r.order_sn) },
 *       { key: 'proc_status', label: 'Status', render: (r) => c.badge({ status: r.proc_status }) },
 *       { key: 'total_amount', label: 'Total', align: 'right', render: (r) => fmt.currency(r.total_amount) },
 *     ],
 *     rows, rowKey: 'order_sn', onRowClick: (row) => router.navigate(`#/orders/${row.order_sn}`),
 *     empty: { title: 'Belum ada order', text: 'Jalankan sync untuk menarik order dari Shopee.' },
 *   });
 *
 *   // Tabs, pencarian (debounce 300ms), select, pagination
 *   const tabs = c.tabs({ items: [{ key: 'all', label: 'Semua', count: 12 }, { key: 'held', label: 'Ditahan', count: 2, tone: 'danger' }], active: 'all', onChange: (k) => load(k) });
 *   c.searchInput({ placeholder: 'Cari order…', onSearch: (q) => load({ q }) });
 *   c.select({ options: [{ value: 'all', label: 'Semua gudang' }, { value: 'jkt', label: 'Jakarta' }], value: 'all', onChange: (v) => ... });
 *   c.pagination({ page: 1, total: 120, limit: 20, onChange: (p) => load({ page: p }) });
 *
 *   // Panel gelap + detail gradien (pola daftar/detail seperti referensi)
 *   c.card({ tone: 'dark', title: 'Grup PDF', body: c.listPanel({ items, selectedKey, onSelect }) });
 *   c.card({ tone: 'gradient', title: 'Part 1', body: el('div', { class: 'glass-grid' }, c.glassTile({ label: 'Order', value: 24 }), c.glassTile({ label: 'Produk', value: 31 })) });
 *
 *   // Toast & modal
 *   toast.success('Sync selesai'); toast.error('Gagal memproses order');
 *   const ok = await modal.confirm({ title: 'Proses 24 order?', message: 'PDF akan dibuat per kategori.', confirmLabel: 'Proses sekarang' });
 *   modal.open({ title: 'Detail', body: el('p', 'Isi'), actions: [{ label: 'Tutup', kind: 'secondary' }, { label: 'Simpan', kind: 'primary', onClick: async (m) => { await save(); } }] });
 * ---------------------------------------------------------------------------
 */
import { fmt } from './fmt.js';

// ============================================================================
// DOM builder
// ============================================================================
const BOOL_PROPS = new Set(['disabled', 'checked', 'selected', 'hidden', 'readOnly', 'readonly', 'required', 'multiple', 'autofocus', 'open', 'indeterminate']);

function isPlainObject(v) { return v !== null && typeof v === 'object' && !(v instanceof Node) && !Array.isArray(v) && !(v instanceof RawHtml); }

/** Tambahkan anak (string/number/Node/array/fungsi/null) ke parent. */
export function append(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return parent;
  if (Array.isArray(child)) { for (const c of child) append(parent, c); return parent; }
  if (child instanceof Node) { parent.appendChild(child); return parent; }
  if (child instanceof RawHtml) { const t = document.createElement('template'); t.innerHTML = child.value; parent.appendChild(t.content); return parent; }
  if (typeof child === 'function') return append(parent, child());
  parent.appendChild(document.createTextNode(String(child)));
  return parent;
}

/** Terapkan atribut ke elemen (class/style/dataset/on*/html/text/ref/boolean props). */
export function setAttrs(node, attrs) {
  if (!attrs) return node;
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined) continue;
    if (key === 'class' || key === 'className') { const c = classNames(val); if (c) node.setAttribute('class', c); continue; }
    if (key === 'style') {
      if (typeof val === 'string') node.style.cssText = val;
      else if (val && typeof val === 'object') for (const [k, v] of Object.entries(val)) { if (v === null || v === undefined) continue; if (k.startsWith('--')) node.style.setProperty(k, v); else node.style[k] = v; }
      continue;
    }
    if (key === 'dataset') { if (val) for (const [k, v] of Object.entries(val)) if (v !== null && v !== undefined) node.dataset[k] = String(v); continue; }
    if (key === 'html') { node.innerHTML = val === null ? '' : String(val); continue; }
    if (key === 'text') { node.textContent = val === null ? '' : String(val); continue; }
    if (key === 'ref') { if (typeof val === 'function') val(node); continue; }
    if (key.startsWith('on') && typeof val === 'function') { node.addEventListener(key.slice(2).toLowerCase(), val); continue; }
    if (BOOL_PROPS.has(key)) { node[key === 'readonly' ? 'readOnly' : key] = !!val; continue; }
    if (key === 'value') { node.value = val === null ? '' : val; continue; }
    if (key === 'for') { node.htmlFor = val; continue; }
    if (val === null || val === false) continue;
    node.setAttribute(key, val === true ? '' : String(val));
  }
  return node;
}

/** Gabungkan nama class dari string / array / objek {nama: boolean}. */
export function classNames(...args) {
  const out = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') out.push(a);
    else if (Array.isArray(a)) { const s = classNames(...a); if (s) out.push(s); }
    else if (typeof a === 'object') for (const [k, v] of Object.entries(a)) if (v) out.push(k);
  }
  return out.join(' ');
}

/**
 * Buat elemen: el('div', { class: 'card', onClick }, 'teks', childNode, [lebih, banyak]).
 * Tag boleh memuat class/id singkat: el('span.badge.badge-success#x', 'OK'). Argumen ke-2 boleh langsung anak.
 */
export function el(tag, attrs, ...children) {
  let t = tag || 'div';
  const shortClasses = []; let shortId = null;
  if (typeof t === 'string' && /[.#]/.test(t)) {
    const parts = t.split(/(?=[.#])/);
    t = parts[0] || 'div';
    for (const p of parts.slice(1)) { if (p[0] === '.') shortClasses.push(p.slice(1)); else if (p[0] === '#') shortId = p.slice(1); }
  }
  const node = document.createElement(t);
  if (attrs !== undefined && !isPlainObject(attrs)) { children.unshift(attrs); attrs = null; }
  if (attrs) setAttrs(node, attrs);
  if (shortClasses.length) node.classList.add(...shortClasses);
  if (shortId) node.id = shortId;
  for (const c of children) append(node, c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Buat elemen SVG (namespace svg): svgEl('svg', { viewBox: '0 0 24 24' }, svgEl('path', { d: '...' })) */
export function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', classNames(v));
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) append(node, c);
  return node;
}

class RawHtml { constructor(value) { this.value = String(value ?? ''); } toString() { return this.value; } }

/** Escape HTML (&, <, >, ", '). */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function serializeValue(v, nodes) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Node) { nodes.push(v); return `<!--gps:${nodes.length - 1}-->`; }
  if (v instanceof RawHtml) return v.value;
  if (Array.isArray(v)) return v.map((x) => serializeValue(x, nodes)).join('');
  if (typeof v === 'function') return serializeValue(v(), nodes);
  return escapeHtml(String(v));
}

/**
 * Tagged template → DocumentFragment. Nilai string di-escape otomatis; Node/array/fragment lain disisipkan;
 * html.raw('<b>x</b>') untuk HTML tepercaya. Node hanya boleh dipakai di posisi anak (bukan di dalam atribut).
 *   container.append(html`<h3>${judul}</h3>${c.badge({ status })}`);
 *   const node = html.first`<div class="card">…</div>`;   // elemen pertama saja
 */
export function html(strings, ...values) {
  const nodes = [];
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += serializeValue(values[i], nodes);
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = out;
  const frag = tpl.content;
  if (nodes.length) {
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_COMMENT);
    const found = [];
    let c;
    while ((c = walker.nextNode())) if (c.data.startsWith('gps:')) found.push(c);
    for (const cm of found) { const idx = parseInt(cm.data.slice(4), 10); const n = nodes[idx]; if (n) cm.replaceWith(n); else cm.remove(); }
  }
  return frag;
}
html.raw = (s) => new RawHtml(s);
html.first = (strings, ...values) => html(strings, ...values).firstElementChild;
html.escape = escapeHtml;

/** Kosongkan lalu isi container: mount(container, ...children) */
export function mount(container, ...children) {
  container.replaceChildren();
  for (const c of children) append(container, c);
  return container;
}

/** Debounce sederhana. */
export function debounce(fn, ms = 300) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

// ============================================================================
// Ikon SVG (stroke 1.75, 20px). icons.home() → SVGElement; icons.get('home', { size: 16 })
// ============================================================================
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  process: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  orders: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>',
  refresh: '<path d="M21 2v6h-6"/><path d="M21 13a9 9 0 1 1-3-7.7L21 8"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
  warehouse: '<path d="M3 21V8l9-5 9 5v13"/><path d="M3 21h18"/><rect x="7" y="13" width="10" height="8"/><path d="M7 17h10"/><path d="M12 13v8"/>',
  truck: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  checkCircle: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronsLeft: '<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>',
  chevronsRight: '<path d="m13 17 5-5-5-5"/><path d="m6 17 5-5-5-5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.9 10.9 0 0 1 12 20c-7 0-11-8-11-8a20 20 0 0 1 5.1-6"/><path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a20 20 0 0 1-2.2 3.2"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="m1 1 22 22"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  shopee: '<path d="M5 8h14l-1 12.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20.5z"/><path d="M8.5 8a3.5 3.5 0 0 1 7 0"/><path d="M14 12.3c-.5-.7-1.3-1-2.1-1-1.2 0-2 .6-2 1.4 0 2 4.2 1.2 4.2 3.5 0 1-1 1.7-2.3 1.7-.9 0-1.8-.4-2.3-1.1"/>',
  tiktok: '<path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/>',
  store: '<path d="M3 9h18l-1.5-5h-15z"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21v-6h6v6"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  externalLink: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  trendUp: '<path d="m23 6-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  trendDown: '<path d="m23 18-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/>',
  menu: '<path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  moreVertical: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<path d="m21 2-2 2"/><path d="M11.4 11.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8z"/><path d="m11.4 11.6 4.1-4.1"/><path d="m15.5 7.5 3 3L22 7l-3-3z"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="m22 6-10 7L2 6"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  mapPin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  barChart: '<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/>',
  wifi: '<path d="M5 12.6a11 11 0 0 1 14 0"/><path d="M8.5 16.1a6 6 0 0 1 7 0"/><path d="M2 8.8a16 16 0 0 1 20 0"/><path d="M12 20h.01"/>',
  wifiOff: '<path d="m1 1 22 22"/><path d="M16.7 11.4a11 11 0 0 1 2.3 1.2"/><path d="M5 12.6a11 11 0 0 1 5.2-2.6"/><path d="M10.7 5.1A16 16 0 0 1 22 8.8"/><path d="M2 8.8a16 16 0 0 1 4.8-2.8"/><path d="M8.5 16.1a6 6 0 0 1 7 0"/><path d="M12 20h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
  loader: '<path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.9 4.9 2.8 2.8"/><path d="m16.3 16.3 2.8 2.8"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.9 19.1 2.8-2.8"/><path d="m16.3 7.7 2.8-2.8"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  package: '<path d="m16.5 9.4-9-5.2"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 21"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17v4"/><path d="M17 19h4"/><path d="M5 3v3"/><path d="M3.5 4.5h3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  logo: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 15.5V8.5h4.5a2 2 0 0 1 0 4H8"/><path d="m12 12.5 4 3"/>',
};

/** Buat SVG ikon. opts: { size=20, class, strokeWidth=1.75, title } */
export function icon(name, opts = {}) {
  const { size = 20, class: cls, strokeWidth = 1.75, title } = opts;
  const paths = ICON_PATHS[name];
  const svg = svgEl('svg', {
    xmlns: SVG_NS, viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: classNames('icon', `icon-${name}`, cls), 'aria-hidden': title ? null : 'true', role: title ? 'img' : null,
  });
  if (title) svg.appendChild(svgEl('title', null, title));
  svg.innerHTML += paths || ICON_PATHS.help;
  return svg;
}

/** Objek ikon: icons.home(opts) → SVGElement. Juga icons.get(name, opts), icons.has(name), icons.names. */
export const icons = {};
for (const name of Object.keys(ICON_PATHS)) icons[name] = (opts) => icon(name, opts);
Object.defineProperty(icons, 'get', { value: (name, opts) => icon(name, opts), enumerable: false });
Object.defineProperty(icons, 'has', { value: (name) => Object.prototype.hasOwnProperty.call(ICON_PATHS, name), enumerable: false });
Object.defineProperty(icons, 'names', { get: () => Object.keys(ICON_PATHS), enumerable: false });
Object.defineProperty(icons, 'raw', { value: (name) => ICON_PATHS[name] || '', enumerable: false });

/** Normalisasi berbagai bentuk ikon → Node|null (fungsi ikon, nama ikon, Node, atau string HTML/emoji). */
export function resolveIcon(ic, opts) {
  if (!ic) return null;
  if (typeof ic === 'function') { const n = ic(opts); return n instanceof Node ? n : resolveIcon(n, opts); }
  if (ic instanceof Node) return ic.isConnected ? ic.cloneNode(true) : ic;
  if (typeof ic === 'string') {
    if (ICON_PATHS[ic]) return icon(ic, opts);
    if (ic.trim().startsWith('<')) { const t = document.createElement('template'); t.innerHTML = ic.trim(); return t.content.firstChild; }
    return document.createTextNode(ic);
  }
  return null;
}

// ============================================================================
// Toast (kanan-bawah, bertumpuk)
// ============================================================================
const TOAST_ICON = { success: 'checkCircle', error: 'xCircle', warn: 'alert', info: 'info' };
const TOAST_TIMEOUT = { success: 4000, info: 4000, warn: 5500, error: 7000 };
let toastContainer = null;
function toastRoot() {
  if (!toastContainer || !toastContainer.isConnected) {
    toastContainer = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

/**
 * toast.show({ kind:'success'|'error'|'warn'|'info', title?, message, timeout?, action?:{label,onClick} }) → { close(), el }
 * Pintasan: toast.success(msg, opts) / error / warn / info.  msg boleh Error (pesan diambil).
 */
export const toast = {
  show(opts = {}) {
    const o = typeof opts === 'string' ? { message: opts } : opts;
    const kind = ['success', 'error', 'warn', 'info'].includes(o.kind) ? o.kind : 'info';
    const message = o.message instanceof Error ? o.message.message : (o.message ?? '');
    const root = toastRoot();
    while (root.children.length >= 5) root.firstElementChild.remove();
    let timer = null;
    const node = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : null },
      el('div', { class: 'toast-icon' }, icon(TOAST_ICON[kind])),
      el('div', { class: 'toast-body' },
        o.title ? el('div', { class: 'toast-title' }, o.title) : null,
        el('div', { class: 'toast-message' }, message),
        o.action ? el('div', { class: 'toast-action' }, button({ label: o.action.label, kind: 'glass', size: 'sm', onClick: () => { try { o.action.onClick && o.action.onClick(); } finally { close(); } } })) : null),
      el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Tutup', onClick: () => close() }, icon('x')));
    const close = () => {
      if (!node.isConnected) return;
      clearTimeout(timer);
      node.classList.add('is-closing');
      setTimeout(() => node.remove(), 180);
    };
    const ms = o.timeout === 0 ? 0 : (o.timeout || TOAST_TIMEOUT[kind]);
    const arm = () => { if (ms > 0) timer = setTimeout(close, ms); };
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', arm);
    root.appendChild(node);
    arm();
    return { close, el: node };
  },
  success(message, opts) { return toast.show({ ...(opts || {}), kind: 'success', message }); },
  error(message, opts) { return toast.show({ ...(opts || {}), kind: 'error', message }); },
  warn(message, opts) { return toast.show({ ...(opts || {}), kind: 'warn', message }); },
  warning(message, opts) { return toast.show({ ...(opts || {}), kind: 'warn', message }); },
  info(message, opts) { return toast.show({ ...(opts || {}), kind: 'info', message }); },
  clear() { if (toastContainer) toastContainer.replaceChildren(); },
};

// ============================================================================
// Modal (tengah, backdrop blur)
// ============================================================================
const openModals = [];
function syncBodyModalClass() { document.body.classList.toggle('is-modal-open', openModals.length > 0); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) { const top = openModals[openModals.length - 1]; if (top.closable) top.close(); }
});

/**
 * modal.open({ title, subtitle?, body: Node|string|fn, actions?: [{ label, kind, icon, onClick(handle), close?:true, disabled? }],
 *              size:'sm'|'md'|'lg'|'xl', closable:true, icon?, tone?, onClose?(result), className? })
 * → handle { close(result), el, body, setLoading(bool), setTitle(str) }
 * onClick boleh async: tombol menampilkan loading; jika mengembalikan false → modal tetap terbuka; jika throw → toast error.
 */
export const modal = {
  open(opts = {}) {
    const { title, subtitle, body, actions = [], size = 'md', closable = true, icon: ic, tone, onClose, className, dismissOnBackdrop = true } = opts;
    let closed = false;
    const previousFocus = document.activeElement;
    const bodyEl = el('div', { class: 'modal-body' });
    if (ic) bodyEl.appendChild(el('div', { class: classNames('modal-icon', tone && `tone-${tone}`) }, resolveIcon(ic, { size: 22 })));
    append(bodyEl, typeof body === 'string' ? el('p', body) : body);
    const dialog = el('div', { class: classNames('modal', size !== 'md' && `modal-${size}`, className), role: 'dialog', 'aria-modal': 'true' });
    const titleEl = el('div', { class: 'modal-title' }, title || '');
    if (title || closable) {
      dialog.appendChild(el('div', { class: 'modal-header' },
        el('div', { class: 'min-w-0' }, titleEl, subtitle ? el('div', { class: 'modal-subtitle' }, subtitle) : null),
        closable ? el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Tutup', onClick: () => handle.close() }, icon('x')) : null));
    }
    dialog.appendChild(bodyEl);
    const buttons = [];
    if (actions.length) {
      const footer = el('div', { class: 'modal-footer' });
      for (const a of actions) {
        const btn = button({
          label: a.label, kind: a.kind || 'secondary', icon: a.icon, disabled: a.disabled, className: a.left ? 'modal-footer-left' : null,
          onClick: async () => {
            if (!a.onClick) { if (a.close !== false) handle.close(a.value); return; }
            try {
              handle.setLoading(true, btn);
              const r = await a.onClick(handle);
              if (r !== false && a.close !== false) handle.close(r === undefined ? a.value : r);
            } catch (e) {
              toast.error(e && e.message ? e.message : 'Terjadi kesalahan');
            } finally { if (!closed) handle.setLoading(false); }
          },
        });
        buttons.push(btn);
        footer.appendChild(btn);
      }
      dialog.appendChild(footer);
    }
    const backdrop = el('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === backdrop && closable && dismissOnBackdrop) handle.close(); } }, dialog);
    const handle = {
      el: dialog, body: bodyEl, closable,
      close(result) {
        if (closed) return; closed = true;
        const i = openModals.indexOf(handle); if (i >= 0) openModals.splice(i, 1);
        backdrop.remove(); syncBodyModalClass();
        if (onClose) { try { onClose(result); } catch (e) { console.error(e); } }
        if (previousFocus && previousFocus.focus && document.contains(previousFocus)) { try { previousFocus.focus(); } catch { /* abaikan */ } }
      },
      setLoading(on, activeBtn) {
        for (const b of buttons) { if (b === activeBtn) b.setLoading(!!on); else b.disabled = !!on; }
      },
      setTitle(t) { titleEl.textContent = t; },
    };
    openModals.push(handle);
    document.body.appendChild(backdrop);
    syncBodyModalClass();
    requestAnimationFrame(() => {
      const f = bodyEl.querySelector('input:not([type=hidden]), select, textarea, button, [tabindex]') || buttons.find((b) => b.classList.contains('btn-primary') || b.classList.contains('btn-danger')) || buttons[buttons.length - 1];
      if (f && f.focus) try { f.focus(); } catch { /* abaikan */ }
    });
    return handle;
  },

  /** modal.confirm({ title, message, confirmLabel='Ya, lanjutkan', cancelLabel='Batal', danger=false, icon? }) → Promise<boolean> */
  confirm(opts = {}) {
    const { title = 'Konfirmasi', message = '', confirmLabel = 'Ya, lanjutkan', cancelLabel = 'Batal', danger = false, icon: ic, size = 'sm' } = opts;
    return new Promise((resolve) => {
      modal.open({
        title, size, icon: ic || (danger ? 'alert' : null), tone: danger ? 'danger' : undefined,
        body: typeof message === 'string' ? el('p', message) : message,
        actions: [
          { label: cancelLabel, kind: 'secondary', value: false },
          { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true, onClick: opts.onConfirm },
        ],
        onClose: (r) => resolve(r === true),
      });
    });
  },

  /** modal.alert({ title, message, okLabel='Mengerti', tone? }) → Promise<void> */
  alert(opts = {}) {
    const { title = 'Informasi', message = '', okLabel = 'Mengerti', tone, icon: ic } = opts;
    return new Promise((resolve) => {
      modal.open({ title, size: 'sm', icon: ic, tone, body: typeof message === 'string' ? el('p', message) : message, actions: [{ label: okLabel, kind: 'primary' }], onClose: () => resolve() });
    });
  },

  /** modal.prompt({ title, message?, label?, value?, placeholder?, multiline?, required?, confirmLabel='Simpan' }) → Promise<string|null> */
  prompt(opts = {}) {
    const { title = 'Masukkan nilai', message, label, value = '', placeholder, multiline = false, required = false, confirmLabel = 'Simpan', cancelLabel = 'Batal' } = opts;
    return new Promise((resolve) => {
      const inp = multiline ? textarea({ value, placeholder }) : input({ value, placeholder });
      const fld = field({ label, input: inp, hint: message });
      let result = null;
      const m = modal.open({
        title, size: 'sm', body: fld,
        actions: [
          { label: cancelLabel, kind: 'secondary' },
          { label: confirmLabel, kind: 'primary', onClick: () => { const v = inp.value.trim(); if (required && !v) { fld.setError('Wajib diisi'); return false; } result = v; return true; } },
        ],
        onClose: () => resolve(result),
      });
      if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.trim(); if (required && !v) { fld.setError('Wajib diisi'); return; } result = v; m.close(true); } });
    });
  },

  closeAll() { for (const m of [...openModals]) m.close(); },
  get count() { return openModals.length; },
};

// ============================================================================
// Komponen
// ============================================================================

/**
 * button({ label, icon, iconRight, kind:'primary'|'secondary'|'ghost'|'soft'|'danger'|'danger-soft'|'success'|'dark'|'glass', size:'sm'|'md'|'lg',
 *          onClick, loading, disabled, type='button', title, block, href, className }) → <button> dengan .setLoading(bool)
 */
export function button(opts = {}) {
  const { label, icon: ic, iconRight, kind = 'secondary', size = 'md', onClick, loading = false, disabled = false, type = 'button', title, block = false, href, className, ariaLabel, dataset } = opts;
  const cls = classNames('btn', `btn-${kind}`, size !== 'md' && `btn-${size}`, block && 'btn-block', !label && (ic || iconRight) && 'btn-icon', className);
  const node = href
    ? el('a', { class: cls, href, title, 'aria-label': ariaLabel || (!label ? title : null), dataset })
    : el('button', { class: cls, type, title, disabled, 'aria-label': ariaLabel || (!label ? title : null), dataset });
  const leftIcon = resolveIcon(ic, { size: size === 'sm' ? 15 : 18 });
  const spinner = el('span', { class: 'spinner', hidden: true });
  if (leftIcon) node.appendChild(leftIcon);
  node.appendChild(spinner);
  if (label !== undefined && label !== null && label !== '') node.appendChild(el('span', { class: 'btn-label' }, label));
  const rightIcon = resolveIcon(iconRight, { size: size === 'sm' ? 15 : 18 });
  if (rightIcon) node.appendChild(rightIcon);
  if (onClick) node.addEventListener('click', (e) => { if (node.classList.contains('is-loading') || node.disabled) return; onClick(e, node); });
  node.setLoading = (on) => {
    node.classList.toggle('is-loading', !!on);
    spinner.hidden = !on;
    if (leftIcon) leftIcon.style.display = on ? 'none' : '';
    if (!href) node.disabled = !!on || disabled;
    return node;
  };
  if (loading) node.setLoading(true);
  return node;
}

/** iconButton({ icon, onClick, title, kind='secondary', size, badge:false, className }) → tombol bulat ikon saja */
export function iconButton(opts = {}) {
  const b = button({ ...opts, label: undefined, ariaLabel: opts.title });
  if (opts.badge) { b.classList.add('has-badge'); b.appendChild(el('span', { class: 'btn-badge' })); }
  return b;
}

/**
 * statCard({ label, value, delta, deltaLabel, deltaTone?, icon, tone, chart:{type:'bar'|'line', values}, hint, onClick, variant:'light'|'dark'|'gradient' })
 * → .card.stat  dengan .setValue(v) / .setDelta(d)
 */
export function statCard(opts = {}) {
  const { label, value, delta, deltaLabel, deltaTone, icon: ic, tone = 'primary', chart, hint, onClick, variant = 'light', className } = opts;
  const valueEl = el('div', { class: 'stat-value' }, formatStatValue(value));
  const deltaWrap = el('div', { class: 'row gap-2 wrap' });
  const renderDelta = (d, dl, dt) => {
    deltaWrap.replaceChildren();
    if (d === null || d === undefined || d === '') { if (hint) deltaWrap.appendChild(el('span', { class: 'stat-hint' }, hint)); return; }
    let num = typeof d === 'number' ? d : parseFloat(String(d).replace(/[^0-9.+-]/g, ''));
    if (isNaN(num)) num = 0;
    const dir = dt ? (dt === 'success' ? 'up' : dt === 'danger' ? 'down' : '') : (num > 0 ? 'up' : num < 0 ? 'down' : '');
    const text = typeof d === 'number' ? `${num > 0 ? '+' : ''}${fmt.number(num, 1)}` : String(d);
    deltaWrap.appendChild(el('span', { class: classNames('stat-delta', dir) }, num > 0 ? icon('arrowUp') : num < 0 ? icon('arrowDown') : null, text));
    if (dl) deltaWrap.appendChild(el('span', { class: 'stat-delta-label' }, dl));
  };
  renderDelta(delta, deltaLabel, deltaTone);
  const chartEl = chart && Array.isArray(chart.values) && chart.values.length ? el('div', { class: 'stat-chart' }, kpiChart({ tone, ...chart })) : null;
  const node = el('div', {
    class: classNames('card stat', variant === 'dark' && 'card-dark stat-dark', variant === 'gradient' && 'card-gradient stat-gradient', onClick && 'is-clickable', className),
    role: onClick ? 'button' : null, tabindex: onClick ? 0 : null,
    onClick, onKeydown: onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : null,
  },
    el('div', { class: 'stat-top' },
      el('div', { class: 'min-w-0' }, el('div', { class: 'stat-label' }, label), valueEl),
      ic ? el('div', { class: classNames('stat-icon', `tone-${tone}`) }, resolveIcon(ic, { size: 20 })) : null),
    el('div', { class: 'stat-bottom' }, deltaWrap, chartEl));
  node.setValue = (v) => { valueEl.textContent = formatStatValue(v); return node; };
  node.setDelta = (d, dl, dt) => { renderDelta(d, dl, dt); return node; };
  return node;
}
function formatStatValue(v) { return typeof v === 'number' ? fmt.number(v) : (v === null || v === undefined ? '-' : String(v)); }

/**
 * kpiChart({ type:'bar'|'line', values:[number], width=110, height=36, tone='primary', color?, highlightLast=true, max? }) → <svg> mini chart
 */
export function kpiChart(opts = {}) {
  const { type = 'bar', values = [], width = 110, height = 36, tone = 'primary', color, highlightLast = true, max: maxOpt } = opts;
  const vals = (Array.isArray(values) ? values : []).map((v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0));
  const toneColor = color || `var(--color-${tone === 'dark' ? 'navy' : tone})`;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: `kpi-chart kpi-chart-${type}`, 'aria-hidden': 'true', style: { color: toneColor } });
  if (!vals.length) return svg;
  const max = Math.max(maxOpt || 0, ...vals, 1);
  const min = Math.min(0, ...vals);
  const range = max - min || 1;
  if (type === 'line') {
    const n = vals.length;
    const stepX = n > 1 ? width / (n - 1) : 0;
    const pts = vals.map((v, i) => [n > 1 ? i * stepX : width / 2, height - 3 - ((v - min) / range) * (height - 6)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${d} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
    svg.appendChild(svgEl('path', { d: area, fill: 'currentColor', opacity: 0.12 }));
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    if (highlightLast) { const last = pts[pts.length - 1]; svg.appendChild(svgEl('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 3, fill: 'currentColor' })); svg.appendChild(svgEl('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 6, fill: 'currentColor', opacity: 0.2 })); }
    return svg;
  }
  const n = vals.length;
  const gap = n > 12 ? 2 : 4;
  const bw = Math.max(2, (width - gap * (n - 1)) / n);
  vals.forEach((v, i) => {
    const h = Math.max(2, ((v - min) / range) * (height - 2));
    const isLast = i === n - 1;
    svg.appendChild(svgEl('rect', { x: (i * (bw + gap)).toFixed(1), y: (height - h).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), rx: Math.min(3, bw / 2), fill: 'currentColor', opacity: highlightLast && !isLast ? 0.3 : 1 }));
  });
  return svg;
}

/**
 * badge({ text, tone, status, dot, size:'sm'|'md'|'lg', icon, solid, className })
 * Jika `status` diberikan: text default = fmt.statusLabel(status), tone default = fmt.tone(status).
 */
export function badge(opts = {}) {
  const o = typeof opts === 'string' ? { status: opts } : opts;
  const { text, status, dot = false, size = 'md', icon: ic, solid = false, className, title } = o;
  const tone = o.tone || (status !== undefined ? fmt.tone(status) : 'neutral');
  const label = text !== undefined && text !== null ? text : (status !== undefined ? fmt.statusLabel(status) : '');
  return el('span', { class: classNames('badge', solid ? `badge-solid-${tone}` : `badge-${tone}`, dot && 'badge-dot', size !== 'md' && `badge-${size}`, className), title, dataset: status !== undefined ? { status: String(status) } : null },
    resolveIcon(ic, { size: 12 }), label);
}

/** pill({ text, tone, icon, active, onClick, count, className }) → chip/pil (klik-able jika onClick) */
export function pill(opts = {}) {
  const { text, tone, icon: ic, active = false, onClick, count, className, title } = opts;
  const node = el(onClick ? 'button' : 'span', {
    class: classNames('pill', tone && `pill-${tone}`, active && 'is-active', onClick && 'is-clickable', className), type: onClick ? 'button' : null, title, onClick,
  }, resolveIcon(ic, { size: 15 }), text, count !== undefined && count !== null ? el('span', { class: 'pill-count' }, fmt.number(count)) : null);
  node.setActive = (on) => { node.classList.toggle('is-active', !!on); return node; };
  return node;
}

/** statusDot(tone|status, { pulsing }) → titik status kecil */
export function statusDot(toneOrStatus, opts = {}) {
  const t = ['success', 'warning', 'danger', 'info', 'primary', 'neutral'].includes(toneOrStatus) ? toneOrStatus : fmt.tone(toneOrStatus);
  return el('span', { class: classNames('status-dot', `tone-${t}`, opts.pulsing && 'is-pulsing'), title: opts.title });
}

const AVATAR_COLORS = ['#5B5BD6', '#7C3AED', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6', '#6366F1', '#F97316'];
/** avatar({ name, size:'xs'|'sm'|'md'|'lg'|'xl', src, icon, tone:'auto'|'primary'|'soft'|'glass', square, className }) */
export function avatar(opts = {}) {
  const { name, size = 'md', src, icon: ic, tone = 'auto', square = false, className, title } = opts;
  const node = el('span', { class: classNames('avatar', `avatar-${size}`, square && 'avatar-square', tone === 'soft' && 'avatar-soft', tone === 'glass' && 'avatar-glass', ic && 'avatar-icon', className), title: title || name, 'aria-label': name });
  if (src) node.appendChild(el('img', { src, alt: name || '' }));
  else if (ic) node.appendChild(resolveIcon(ic));
  else node.textContent = fmt.initials(name);
  if (tone === 'auto' && !src) {
    let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    node.style.background = AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  return node;
}

/** spinner({ size:'sm'|'md'|'lg', white, label }) → spinner (dengan teks bila label diberikan) */
export function spinner(opts = {}) {
  const { size = 'md', white = false, label, className } = opts;
  const s = el('span', { class: classNames('spinner', size !== 'md' && `spinner-${size}`, white && 'spinner-white', className), role: 'status', 'aria-label': label || 'Memuat' });
  if (!label) return s;
  return el('div', { class: 'spinner-wrap' }, s, el('span', label));
}

/**
 * skeleton(rows=3, { kind:'lines'|'card'|'table'|'kpi'|'list', height }) → placeholder shimmer
 */
export function skeleton(rows = 3, opts = {}) {
  const o = typeof rows === 'object' && rows !== null ? rows : { rows, ...opts };
  const n = Math.max(1, o.rows || 3);
  const kind = o.kind || 'lines';
  const wrap = el('div', { class: classNames('skeleton', `skeleton-${kind}`, o.className), 'aria-busy': 'true', 'aria-label': 'Memuat' });
  const widths = ['w-80', 'w-60', 'w-40', 'w-80', 'w-25'];
  if (kind === 'card') { for (let i = 0; i < n; i++) wrap.appendChild(el('div', { class: 'skeleton-box', style: o.height ? { height: typeof o.height === 'number' ? `${o.height}px` : o.height } : null })); return wrap; }
  if (kind === 'kpi') { wrap.className = 'skeleton-kpi'; for (let i = 0; i < n; i++) wrap.appendChild(el('div', { class: 'card stat' }, el('div', { class: 'skeleton' }, el('div', { class: 'skeleton-line w-40' }), el('div', { class: 'skeleton-line', style: { height: '28px', width: '55%' } }), el('div', { class: 'skeleton-line w-60' })))); return wrap; }
  if (kind === 'list') { for (let i = 0; i < n; i++) wrap.appendChild(el('div', { class: 'skeleton-row' }, el('div', { class: 'skeleton-line skeleton-circle' }), el('div', { class: 'skeleton flex-1' }, el('div', { class: 'skeleton-line w-60' }), el('div', { class: 'skeleton-line w-40' })))); return wrap; }
  if (kind === 'table') { for (let i = 0; i < n; i++) wrap.appendChild(el('div', { class: 'skeleton-row' }, el('div', { class: 'skeleton-line', style: { width: '18%' } }), el('div', { class: 'skeleton-line', style: { width: '32%' } }), el('div', { class: 'skeleton-line', style: { width: '14%' } }), el('div', { class: 'skeleton-line', style: { width: '22%' } }))); return wrap; }
  for (let i = 0; i < n; i++) wrap.appendChild(el('div', { class: `skeleton-line ${widths[i % widths.length]}` }));
  return wrap;
}

/**
 * progressBar({ value, max=100, tone, label, showValue=true, indeterminate, striped, size:'sm'|'md'|'lg' }) → .progress dengan .set(value, max)
 */
export function progressBar(opts = {}) {
  const { value = 0, max = 100, tone, label, showValue = true, indeterminate = false, striped = false, size = 'md', className, format } = opts;
  const bar = el('div', { class: classNames('progress-bar', tone && `tone-${tone}`, indeterminate && 'is-indeterminate', striped && 'is-striped') });
  const valueEl = el('span');
  const labelEl = el('span', label ? [el('strong', label)] : null);
  const node = el('div', { class: classNames('progress', size !== 'md' && `progress-${size}`, className), role: 'progressbar', 'aria-valuemin': 0 },
    (label || showValue) ? el('div', { class: 'progress-meta' }, labelEl, showValue ? valueEl : null) : null,
    el('div', { class: 'progress-track' }, bar));
  node.set = (v, m) => {
    const mx = m !== undefined ? m : (node._max ?? max); node._max = mx;
    const val = Math.max(0, Number(v) || 0);
    const p = mx > 0 ? Math.min(100, (val / mx) * 100) : 0;
    if (!indeterminate) bar.style.width = `${p}%`;
    node.setAttribute('aria-valuenow', val); node.setAttribute('aria-valuemax', mx);
    valueEl.textContent = format ? format(val, mx) : (mx === 100 && max === 100 ? `${Math.round(p)}%` : `${fmt.number(val)} / ${fmt.number(mx)}`);
    return node;
  };
  node.setLabel = (t) => { labelEl.replaceChildren(el('strong', t)); return node; };
  node.set(value, max);
  return node;
}

/**
 * tabs({ items:[{ key, label, count, icon, tone }], active, onChange(key, item), dark, size:'sm'|'md', block })
 * → .tabs dengan .setActive(key) / .setCount(key, n) / .getActive()
 */
export function tabs(opts = {}) {
  const { items = [], onChange, dark = false, size = 'md', block = false, className } = opts;
  let active = opts.active ?? (items[0] && items[0].key);
  const node = el('div', { class: classNames('tabs', dark && 'tabs-dark', size === 'sm' && 'tabs-sm', block && 'tabs-block', className), role: 'tablist' });
  const btns = new Map();
  for (const it of items) {
    const countEl = el('span', { class: 'tab-count', hidden: it.count === undefined || it.count === null }, it.count !== undefined && it.count !== null ? fmt.number(it.count) : '');
    const b = el('button', { class: classNames('tab', it.key === active && 'is-active', it.tone && `tone-${it.tone}`), type: 'button', role: 'tab', 'aria-selected': it.key === active ? 'true' : 'false', dataset: { key: it.key }, disabled: it.disabled,
      onClick: () => { if (active === it.key) return; node.setActive(it.key); if (onChange) onChange(it.key, it); } },
      resolveIcon(it.icon, { size: 15 }), it.label, countEl);
    b._count = countEl;
    btns.set(it.key, b);
    node.appendChild(b);
  }
  node.setActive = (key) => { active = key; for (const [k, b] of btns) { b.classList.toggle('is-active', k === key); b.setAttribute('aria-selected', k === key ? 'true' : 'false'); } return node; };
  node.setCount = (key, n) => { const b = btns.get(key); if (b) { b._count.hidden = n === undefined || n === null; b._count.textContent = n === undefined || n === null ? '' : fmt.number(n); } return node; };
  node.getActive = () => active;
  return node;
}

/**
 * emptyState({ icon, title, text, action: Node|{label, icon, kind, onClick}, size:'sm'|'md' })
 */
export function emptyState(opts = {}) {
  const { icon: ic = 'inbox', title = 'Tidak ada data', text, action, size = 'md', className } = opts;
  const act = action instanceof Node ? action : action && typeof action === 'object' ? button({ kind: 'primary', ...action }) : null;
  return el('div', { class: classNames('empty', size === 'sm' && 'empty-sm', className) },
    ic ? el('div', { class: 'empty-icon' }, resolveIcon(ic, { size: 26 })) : null,
    title ? el('div', { class: 'empty-title' }, title) : null,
    text ? el('div', { class: 'empty-text' }, text) : null,
    act ? el('div', { class: 'empty-action' }, act) : null);
}

/**
 * table({ columns:[{ key, label, render?(row,i,col), width?, align?:'left'|'right'|'center', className?, headerClass? }],
 *         rows, rowKey: 'field'|fn(row), onRowClick(row, i, ev), empty: string|Node|emptyStateOpts, selectedKey, compact, loading, rowClass(row), maxHeight, footer })
 * → .table-wrap dengan .update({ rows, selectedKey, loading }) / .setSelected(key) / .rows
 */
export function table(opts = {}) {
  const { columns = [], rowKey, onRowClick, empty, compact = false, className, rowClass, maxHeight, footer, loading = false } = opts;
  const keyOf = (row, i) => (typeof rowKey === 'function' ? rowKey(row, i) : rowKey ? row[rowKey] : (row.order_sn ?? row.id ?? row.key ?? i));
  const tbody = el('tbody');
  const thead = el('thead', el('tr', columns.map((c) => el('th', { class: classNames(c.align && `align-${c.align}`, c.headerClass), style: c.width ? { width: typeof c.width === 'number' ? `${c.width}px` : c.width } : null, scope: 'col' }, c.label ?? ''))));
  const tbl = el('table', { class: classNames('table', compact && 'table-compact') }, thead, tbody);
  const wrap = el('div', { class: classNames('table-wrap', className), style: maxHeight ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight, overflowY: 'auto' } : null }, tbl);
  if (footer) wrap.appendChild(el('div', { class: 'table-footer' }, footer));
  let selected = opts.selectedKey ?? null;
  wrap.rows = [];
  const renderRows = (rows) => {
    tbody.replaceChildren();
    wrap.rows = Array.isArray(rows) ? rows : [];
    if (!wrap.rows.length) {
      const content = empty === undefined || typeof empty === 'string' ? emptyState({ title: empty || 'Tidak ada data', size: 'sm', icon: 'inbox' }) : empty instanceof Node ? empty : emptyState({ size: 'sm', ...empty });
      tbody.appendChild(el('tr', { class: 'table-empty' }, el('td', { colspan: Math.max(1, columns.length) }, content)));
      return;
    }
    wrap.rows.forEach((row, i) => {
      const key = keyOf(row, i);
      const tr = el('tr', { class: classNames(onRowClick && 'is-clickable', selected !== null && String(key) === String(selected) && 'is-selected', rowClass && rowClass(row, i)), dataset: { key } });
      if (onRowClick) tr.addEventListener('click', (ev) => { if (ev.target.closest('button, a, input, select, label, textarea')) return; onRowClick(row, i, ev); });
      for (const c of columns) {
        let v;
        try { v = c.render ? c.render(row, i, c) : (c.key ? getPath(row, c.key) : ''); } catch (e) { console.error('[table] render error', e); v = '!'; }
        const td = el('td', { class: classNames(c.align && `align-${c.align}`, c.className) });
        append(td, v === null || v === undefined || v === '' ? '-' : v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
  };
  const renderLoading = () => { tbody.replaceChildren(el('tr', { class: 'table-empty' }, el('td', { colspan: Math.max(1, columns.length) }, skeleton(4, { kind: 'table' })))); };
  wrap.update = ({ rows, selectedKey, loading: ld } = {}) => {
    if (selectedKey !== undefined) selected = selectedKey;
    if (ld) renderLoading(); else renderRows(rows !== undefined ? rows : wrap.rows);
    return wrap;
  };
  wrap.setSelected = (key) => { selected = key; for (const tr of tbody.querySelectorAll('tr[data-key]')) tr.classList.toggle('is-selected', key !== null && key !== undefined && tr.dataset.key === String(key)); return wrap; };
  if (loading) renderLoading(); else renderRows(opts.rows);
  return wrap;
}
function getPath(obj, path) { return String(path).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj); }

/**
 * input({ type='text', name, value, placeholder, onInput(value, ev), onChange(value, ev), onEnter(value, ev), disabled, icon, suffix:Node, size:'sm'|'md'|'lg', mono, autofocus, required, id, min, max, step, autocomplete })
 * → <input> (atau .input-group jika ada icon/suffix; elemen input ada di .input) — nilai lewat .value (proxy ke input)
 */
export function input(opts = {}) {
  const { type = 'text', name, value, placeholder, onInput, onChange, onEnter, disabled = false, icon: ic, suffix, size = 'md', mono = false, autofocus = false, required = false, id, min, max, step, autocomplete, className, readonly, maxlength, invalid } = opts;
  const inp = el('input', { class: classNames('input', size !== 'md' && `input-${size}`, mono && 'input-mono', invalid && 'is-invalid', !ic && !suffix && className), type, name, value: value ?? '', placeholder, disabled, autofocus, required, id, min, max, step, autocomplete, readonly, maxlength, 'aria-label': opts.ariaLabel });
  if (onInput) inp.addEventListener('input', (e) => onInput(inp.value, e));
  if (onChange) inp.addEventListener('change', (e) => onChange(inp.value, e));
  if (onEnter) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(inp.value, e); } });
  if (!ic && !suffix) return inp;
  const group = el('div', { class: classNames('input-group', suffix && 'has-suffix', size === 'sm' && 'input-group-sm', className) }, ic ? el('span', { class: 'input-icon' }, resolveIcon(ic, { size: 18 })) : null, inp, suffix ? el('span', { class: 'input-suffix' }, suffix) : null);
  group.input = inp;
  Object.defineProperty(group, 'value', { get: () => inp.value, set: (v) => { inp.value = v ?? ''; } });
  group.focus = () => inp.focus();
  return group;
}

/** textarea({ name, value, placeholder, rows=3, onInput, onChange, disabled, mono, id, maxlength }) → <textarea class="textarea"> */
export function textarea(opts = {}) {
  const { name, value, placeholder, rows = 3, onInput, onChange, disabled = false, mono = false, id, maxlength, className, required } = opts;
  const ta = el('textarea', { class: classNames('textarea', mono && 'input-mono', className), name, placeholder, rows, disabled, id, maxlength, required });
  ta.value = value ?? '';
  if (onInput) ta.addEventListener('input', (e) => onInput(ta.value, e));
  if (onChange) ta.addEventListener('change', (e) => onChange(ta.value, e));
  return ta;
}

/**
 * searchInput({ placeholder='Cari…', value, onSearch(q) (debounce 300ms), onInput, debounce=300, size, autofocus, width, className })
 * → .search dengan .value (get/set), .focus(), .clear()
 */
export function searchInput(opts = {}) {
  const { placeholder = 'Cari…', value = '', onSearch, onInput, debounce: ms = 300, size = 'md', autofocus = false, width, className, name = 'q' } = opts;
  const inp = el('input', { class: classNames('input', size !== 'md' && `input-${size}`), type: 'search', name, placeholder, value, autofocus, autocomplete: 'off', 'aria-label': placeholder });
  const wrap = el('div', { class: classNames('search', value && 'has-value', className), style: width ? { width: typeof width === 'number' ? `${width}px` : width } : null },
    el('span', { class: 'input-icon' }, icon('search', { size: size === 'sm' ? 15 : 18 })), inp,
    el('button', { class: 'search-clear', type: 'button', 'aria-label': 'Hapus pencarian', onClick: () => { wrap.clear(); inp.focus(); } }, icon('x')));
  const fire = debounce((q) => { if (onSearch) onSearch(q); }, ms);
  inp.addEventListener('input', () => { wrap.classList.toggle('has-value', !!inp.value); if (onInput) onInput(inp.value); fire(inp.value.trim()); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fire.flush(inp.value.trim()); } if (e.key === 'Escape' && inp.value) { wrap.clear(); } });
  inp.addEventListener('search', () => { if (!inp.value) { wrap.classList.remove('has-value'); fire.flush(''); } });
  wrap.input = inp;
  Object.defineProperty(wrap, 'value', { get: () => inp.value, set: (v) => { inp.value = v ?? ''; wrap.classList.toggle('has-value', !!inp.value); } });
  wrap.focus = () => inp.focus();
  wrap.clear = () => { inp.value = ''; wrap.classList.remove('has-value'); fire.cancel(); if (onInput) onInput(''); if (onSearch) onSearch(''); };
  return wrap;
}

/**
 * select({ options:[{ value, label, disabled? }] | ['a','b'], value, onChange(value, option, ev), placeholder, name, size:'sm'|'md', disabled, inline, id })
 * → .select-wrap dengan .value (get/set), .setOptions(options, value), .select (elemen <select>)
 */
export function select(opts = {}) {
  const { onChange, placeholder, name, size = 'md', disabled = false, inline = false, id, className, ariaLabel } = opts;
  const sel = el('select', { class: classNames('select', size !== 'md' && `select-${size}`), name, disabled, id, 'aria-label': ariaLabel || placeholder });
  const wrap = el('div', { class: classNames('select-wrap', inline && 'select-inline', className) }, sel, el('span', { class: 'select-chevron' }, icon('chevronDown', { size: 16 })));
  const norm = (o) => (typeof o === 'object' && o !== null ? o : { value: o, label: String(o) });
  let current = [];
  wrap.setOptions = (options = [], value) => {
    current = (options || []).map(norm);
    sel.replaceChildren();
    if (placeholder) sel.appendChild(el('option', { value: '', disabled: true, selected: value === undefined || value === null || value === '' }, placeholder));
    for (const o of current) sel.appendChild(el('option', { value: o.value ?? '', disabled: o.disabled }, o.label ?? String(o.value)));
    if (value !== undefined && value !== null) sel.value = String(value);
    return wrap;
  };
  wrap.setOptions(opts.options, opts.value);
  sel.addEventListener('change', (e) => { if (onChange) onChange(sel.value, current.find((o) => String(o.value) === sel.value), e); });
  wrap.select = sel;
  Object.defineProperty(wrap, 'value', { get: () => sel.value, set: (v) => { sel.value = v === null || v === undefined ? '' : String(v); } });
  wrap.focus = () => sel.focus();
  return wrap;
}

/**
 * toggle({ checked, onChange(checked, ev), label, disabled, name, id }) → <label class="toggle"> dengan .checked (get/set), .input
 */
export function toggle(opts = {}) {
  const { checked = false, onChange, label, disabled = false, name, id, className, labelFirst = false } = opts;
  const inp = el('input', { type: 'checkbox', checked, disabled, name, id, role: 'switch', 'aria-checked': checked ? 'true' : 'false' });
  const track = el('span', { class: 'toggle-track', 'aria-hidden': 'true' });
  const lbl = label ? el('span', { class: 'toggle-label' }, label) : null;
  const node = el('label', { class: classNames('toggle', className) }, labelFirst ? [lbl, inp, track] : [inp, track, lbl]);
  inp.addEventListener('change', (e) => { inp.setAttribute('aria-checked', inp.checked ? 'true' : 'false'); if (onChange) onChange(inp.checked, e); });
  node.input = inp;
  Object.defineProperty(node, 'checked', { get: () => inp.checked, set: (v) => { inp.checked = !!v; inp.setAttribute('aria-checked', inp.checked ? 'true' : 'false'); } });
  return node;
}

/** checkbox({ checked, onChange, label, disabled, name, id }) → <label class="checkbox"> dengan .checked */
export function checkbox(opts = {}) {
  const { checked = false, onChange, label, disabled = false, name, id, className, indeterminate = false } = opts;
  const inp = el('input', { type: 'checkbox', checked, disabled, name, id, indeterminate });
  const node = el('label', { class: classNames('checkbox', className) }, inp, label ? el('span', label) : null);
  inp.addEventListener('change', (e) => { if (onChange) onChange(inp.checked, e); });
  node.input = inp;
  Object.defineProperty(node, 'checked', { get: () => inp.checked, set: (v) => { inp.checked = !!v; } });
  return node;
}

/**
 * field({ label, input: Node, hint, error, required, inline, id }) → .field dengan .setError(msg|null), .input
 */
export function field(opts = {}) {
  const { label, input: inp, hint, error, required = false, inline = false, id, className } = opts;
  const control = inp || input({});
  const inner = control.input || (control.matches && control.matches('input, select, textarea') ? control : control.querySelector && control.querySelector('input, select, textarea'));
  const fid = id || (inner && inner.id) || (label ? `f-${Math.random().toString(36).slice(2, 8)}` : null);
  if (inner && fid && !inner.id) inner.id = fid;
  const errEl = el('div', { class: 'field-error', role: 'alert' });
  const node = el('div', { class: classNames('field', inline && 'field-inline', className) },
    label ? el('label', { class: 'field-label', for: inner ? fid : null }, label, required ? el('span', { class: 'field-required', 'aria-hidden': 'true' }, '*') : null) : null,
    control,
    hint ? el('div', { class: 'field-hint' }, hint) : null,
    errEl);
  node.input = inner || control;
  node.control = control;
  node.setError = (msg) => {
    errEl.replaceChildren();
    if (msg) { errEl.append(icon('alertCircle', { size: 14 }), msg); if (inner) inner.classList.add('is-invalid'); }
    else if (inner) inner.classList.remove('is-invalid');
    return node;
  };
  if (error) node.setError(error);
  if (inner) inner.addEventListener('input', () => { if (errEl.childNodes.length) node.setError(null); }, { once: false });
  return node;
}

/**
 * card({ title, subtitle, actions: Node|Node[], body: Node|string|Node[], tone:'light'|'dark'|'gradient'|'soft', flush, padding, footer, className, icon })
 * → .card dengan .body (elemen isi), .setBody(...), .header
 */
export function card(opts = {}) {
  const { title, subtitle, actions, body, tone = 'light', flush = false, footer, className, icon: ic, size, onClick } = opts;
  const bodyEl = el('div', { class: 'card-body' });
  append(bodyEl, body);
  const header = (title || subtitle || actions || ic) ? el('div', { class: 'card-header' },
    el('div', { class: 'row gap-3 min-w-0' },
      ic ? el('div', { class: classNames('icon-box', tone === 'gradient' && 'tone-glass') }, resolveIcon(ic, { size: 18 })) : null,
      el('div', { class: 'card-header-text' }, title ? el('div', { class: 'card-title' }, title) : null, subtitle ? el('div', { class: 'card-subtitle' }, subtitle) : null)),
    actions ? el('div', { class: 'card-actions' }, actions) : null) : null;
  const node = el('div', { class: classNames('card', tone === 'dark' && 'card-dark', tone === 'gradient' && 'card-gradient', tone === 'soft' && 'card-soft', flush && 'card-flush', size === 'sm' && 'card-sm', onClick && 'card-hover', className), onClick }, header, bodyEl, footer ? el('div', { class: 'card-footer' }, footer) : null);
  node.body = bodyEl;
  node.header = header;
  node.setBody = (...children) => { mount(bodyEl, ...children); return node; };
  return node;
}

/**
 * pageHeader({ title, subtitle, actions: Node|Node[], eyebrow, back:{ label, href }, meta:[Node|string] }) → .page-header
 */
export function pageHeader(opts = {}) {
  const { title, subtitle, actions, eyebrow, back, meta, className } = opts;
  return el('div', { class: classNames('page-header', className) },
    el('div', { class: 'page-header-text' },
      (back || eyebrow) ? el('div', { class: 'page-header-eyebrow' }, back ? el('a', { href: back.href || '#/' }, icon('arrowLeft', { size: 14 }), back.label || 'Kembali') : null, eyebrow) : null,
      el('h1', { class: 'page-title' }, title),
      subtitle ? el('p', { class: 'page-subtitle' }, subtitle) : null,
      meta && meta.length ? el('div', { class: 'page-meta' }, meta.map((m) => (m instanceof Node && m.classList && m.classList.contains('page-meta-item') ? m : el('span', m)))) : null),
    actions ? el('div', { class: 'page-actions' }, actions) : null);
}

/** kbd('Enter') → <kbd class="kbd"> */
export function kbd(text) { return el('kbd', { class: 'kbd' }, text); }

/**
 * alert({ tone:'info'|'success'|'warning'|'danger'|'neutral'|'primary', title, text, icon, actions: Node|Node[], dismissible, onDismiss }) → .alert
 */
export function alert(opts = {}) {
  const { tone = 'info', title, text, icon: ic, actions, dismissible = false, onDismiss, className } = opts;
  const defIcon = { success: 'checkCircle', warning: 'alert', danger: 'xCircle', info: 'info', neutral: 'info', primary: 'sparkles' }[tone] || 'info';
  const node = el('div', { class: classNames('alert', `alert-${tone}`, className), role: tone === 'danger' ? 'alert' : 'status' },
    el('div', { class: 'alert-icon' }, resolveIcon(ic || defIcon, { size: 20 })),
    el('div', { class: 'alert-body' }, title ? el('div', { class: 'alert-title' }, title) : null, text ? el('div', { class: 'alert-text' }, text) : null),
    actions ? el('div', { class: 'alert-actions' }, actions) : null,
    dismissible ? el('button', { class: 'alert-close', type: 'button', 'aria-label': 'Tutup', onClick: () => { node.remove(); if (onDismiss) onDismiss(); } }, icon('x')) : null);
  return node;
}

/**
 * dropdown({ trigger: Node, items:[{ label, icon, onClick, danger, disabled, divider:true, note:true, href }], header:{ title, sub }|Node, align:'right'|'left', width })
 * → .dropdown dengan .open() / .close() / .toggle()
 */
export function dropdown(opts = {}) {
  const { trigger, items = [], header, align = 'right', width, className, onOpen } = opts;
  const menu = el('div', { class: classNames('menu', align === 'left' && 'menu-left'), role: 'menu', hidden: true, style: width ? { minWidth: typeof width === 'number' ? `${width}px` : width } : null });
  const node = el('div', { class: classNames('dropdown', className) }, trigger, menu);
  const build = () => {
    menu.replaceChildren();
    if (header) menu.appendChild(header instanceof Node ? header : el('div', { class: 'menu-header' }, el('div', { class: 'menu-header-title' }, header.title), header.sub ? el('div', { class: 'menu-header-sub' }, header.sub) : null));
    const list = typeof items === 'function' ? items() : items;
    for (const it of list) {
      if (!it) continue;
      if (it.divider) { menu.appendChild(el('div', { class: 'menu-divider' })); continue; }
      if (it.note) { menu.appendChild(el('div', { class: 'menu-note' }, it.label)); continue; }
      if (it.node) { menu.appendChild(it.node); continue; }
      menu.appendChild(el(it.href ? 'a' : 'button', { class: classNames('menu-item', it.danger && 'is-danger'), type: it.href ? null : 'button', href: it.href, role: 'menuitem', disabled: it.disabled,
        onClick: (e) => { if (it.disabled) return; node.close(); if (it.onClick) it.onClick(e); } }, resolveIcon(it.icon, { size: 17 }), el('span', { class: 'flex-1' }, it.label)));
    }
  };
  const onDocClick = (e) => { if (!node.contains(e.target)) node.close(); };
  const onKey = (e) => { if (e.key === 'Escape') node.close(); };
  node.open = () => { build(); if (onOpen) onOpen(); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); setTimeout(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey); }, 0); };
  node.close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey); };
  node.toggle = () => (menu.hidden ? node.open() : node.close());
  node.isOpen = () => !menu.hidden;
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.addEventListener('click', (e) => { e.stopPropagation(); node.toggle(); });
  return node;
}

/**
 * listPanel({ items:[{ key, icon|avatar(name)|lead:Node, title, subtitle, badge:{text,tone}|status|Node, value, valueSub, onClick }], selectedKey, onSelect(item), empty, dense })
 * → .list-panel dengan .setSelected(key) / .update(items). Cocok di card({ tone:'dark' }) maupun kartu putih.
 */
export function listPanel(opts = {}) {
  const { onSelect, empty, dense = false, className } = opts;
  let selected = opts.selectedKey ?? null;
  const node = el('div', { class: classNames('list-panel', dense && 'list-panel-dense', className), role: onSelect ? 'listbox' : 'list' });
  const rowOf = (it) => {
    const key = it.key ?? it.title;
    const lead = it.lead instanceof Node ? it.lead : it.avatar !== undefined ? avatar({ name: it.avatar, size: 'md', tone: it.avatarTone || 'auto' }) : it.icon ? el('span', { class: 'list-row-icon' }, resolveIcon(it.icon, { size: 18 })) : null;
    let b = null;
    if (it.badge instanceof Node) b = it.badge;
    else if (typeof it.badge === 'string') b = badge({ status: it.badge });
    else if (it.badge && typeof it.badge === 'object') b = badge(it.badge);
    const clickable = !!(onSelect || it.onClick);
    const row = el('div', {
      class: classNames('list-row', clickable && 'is-clickable', selected !== null && String(key) === String(selected) && 'is-selected'), dataset: { key }, role: onSelect ? 'option' : 'listitem', tabindex: clickable ? 0 : null, 'aria-selected': onSelect ? String(String(key) === String(selected)) : null,
      onClick: clickable ? () => { if (it.onClick) it.onClick(it); if (onSelect) { node.setSelected(key); onSelect(it, key); } } : null,
      onKeydown: clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } } : null,
    },
      lead ? el('span', { class: 'list-row-lead' }, lead) : null,
      el('div', { class: 'list-row-main' }, el('div', { class: 'list-row-title' }, it.title), it.subtitle ? el('div', { class: 'list-row-sub' }, it.subtitle) : null),
      b ? el('span', { class: 'list-row-badge' }, b) : null,
      (it.value !== undefined && it.value !== null) || it.valueSub ? el('div', { class: 'list-row-end' }, it.value !== undefined && it.value !== null ? el('div', { class: 'list-row-value' }, typeof it.value === 'number' ? fmt.number(it.value) : it.value) : null, it.valueSub ? el('div', { class: 'list-row-value-sub' }, it.valueSub) : null) : null,
      it.chevron ? icon('chevronRight', { size: 16 }) : null);
    return row;
  };
  node.update = (items = []) => {
    node.replaceChildren();
    if (!items.length) { node.appendChild(empty instanceof Node ? empty : emptyState({ size: 'sm', title: typeof empty === 'string' ? empty : 'Tidak ada data', ...(typeof empty === 'object' && empty ? empty : {}) })); return node; }
    for (const it of items) node.appendChild(rowOf(it));
    return node;
  };
  node.setSelected = (key) => { selected = key; for (const r of node.querySelectorAll('.list-row')) { const on = key !== null && key !== undefined && r.dataset.key === String(key); r.classList.toggle('is-selected', on); if (onSelect) r.setAttribute('aria-selected', String(on)); } return node; };
  node.update(opts.items || []);
  return node;
}

/** glassTile({ label, value, sub, icon }) → tile kaca untuk panel gradien (card tone 'gradient') */
export function glassTile(opts = {}) {
  const { label, value, sub, icon: ic, className } = opts;
  return el('div', { class: classNames('glass-tile', className) },
    el('div', { class: 'glass-tile-label' }, resolveIcon(ic, { size: 14 }), label),
    el('div', { class: 'glass-tile-value' }, typeof value === 'number' ? fmt.number(value) : (value ?? '-')),
    sub ? el('div', { class: 'glass-tile-sub' }, sub) : null);
}

/** kv([{ label, value, mono? }] | [[label, value]], { stacked }) → <dl class="kv"> */
export function kv(rows = [], opts = {}) {
  const node = el('dl', { class: classNames('kv', opts.stacked && 'kv-stacked', opts.className) });
  for (const r of rows) {
    if (!r) continue;
    const item = Array.isArray(r) ? { label: r[0], value: r[1] } : r;
    node.appendChild(el('dt', item.label));
    const dd = el('dd', { class: classNames(item.mono && 'mono') });
    append(dd, item.value === null || item.value === undefined || item.value === '' ? '-' : item.value);
    node.appendChild(dd);
  }
  return node;
}

/** divider(label?) → garis pemisah (dengan teks opsional) */
export function divider(label) { return el('div', { class: 'divider', role: 'separator' }, label || null); }

/** copyable(text, { label }) → teks mono + tombol salin (toast "Disalin") */
export function copyable(text, opts = {}) {
  const value = String(text ?? '');
  return el('span', { class: classNames('copyable', opts.className) }, opts.label ?? value,
    el('button', { class: 'copyable-btn', type: 'button', title: 'Salin', 'aria-label': 'Salin', onClick: async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(value); toast.success('Disalin ke clipboard', { timeout: 1800 }); } catch { toast.error('Tidak bisa menyalin'); }
    } }, icon('copy', { size: 13 })));
}

/** iconBox({ icon, tone, size:'md'|'lg' }) → kotak ikon lembut */
export function iconBox(opts = {}) {
  const { icon: ic, tone, size = 'md', className } = opts;
  return el('span', { class: classNames('icon-box', tone && `tone-${tone}`, size === 'lg' && 'icon-box-lg', className) }, resolveIcon(ic, { size: size === 'lg' ? 22 : 18 }));
}

/**
 * pagination({ page, total, limit, onChange(page), showInfo=true, maxButtons=7 }) → .pagination dengan .set({ page, total, limit })
 */
export function pagination(opts = {}) {
  const { onChange, showInfo = true, maxButtons = 7, className, noun = 'data' } = opts;
  const state = { page: Math.max(1, opts.page || 1), total: Math.max(0, opts.total || 0), limit: Math.max(1, opts.limit || 20) };
  const info = el('div', { class: 'pagination-info' });
  const pages = el('div', { class: 'pagination-pages' });
  const node = el('div', { class: classNames('pagination', className), role: 'navigation', 'aria-label': 'Navigasi halaman' }, showInfo ? info : null, pages);
  const go = (p) => { const n = Math.min(Math.max(1, p), pageCount()); if (n === state.page) return; state.page = n; render(); if (onChange) onChange(n); };
  const pageCount = () => Math.max(1, Math.ceil(state.total / state.limit));
  const pbtn = (content, p, extra = {}) => el('button', { class: classNames('page-btn', extra.active && 'is-active'), type: 'button', disabled: extra.disabled, 'aria-label': extra.label, 'aria-current': extra.active ? 'page' : null, onClick: () => go(p) }, content);
  const render = () => {
    const pc = pageCount();
    const from = state.total ? (state.page - 1) * state.limit + 1 : 0;
    const to = Math.min(state.total, state.page * state.limit);
    info.textContent = state.total ? `Menampilkan ${fmt.number(from)}–${fmt.number(to)} dari ${fmt.number(state.total)} ${noun}` : `Tidak ada ${noun}`;
    pages.replaceChildren();
    pages.appendChild(pbtn(icon('chevronLeft'), state.page - 1, { disabled: state.page <= 1, label: 'Sebelumnya' }));
    let start = Math.max(1, state.page - Math.floor(maxButtons / 2));
    let end = Math.min(pc, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    if (start > 1) { pages.appendChild(pbtn('1', 1)); if (start > 2) pages.appendChild(el('span', { class: 'page-ellipsis' }, '…')); }
    for (let p = start; p <= end; p++) pages.appendChild(pbtn(String(p), p, { active: p === state.page }));
    if (end < pc) { if (end < pc - 1) pages.appendChild(el('span', { class: 'page-ellipsis' }, '…')); pages.appendChild(pbtn(String(pc), pc)); }
    pages.appendChild(pbtn(icon('chevronRight'), state.page + 1, { disabled: state.page >= pc, label: 'Berikutnya' }));
    node.hidden = state.total <= state.limit && !showInfo;
  };
  node.set = (patch = {}) => { Object.assign(state, { page: patch.page !== undefined ? Math.max(1, patch.page) : state.page, total: patch.total !== undefined ? Math.max(0, patch.total) : state.total, limit: patch.limit !== undefined ? Math.max(1, patch.limit) : state.limit }); render(); return node; };
  node.state = state;
  render();
  return node;
}

/** link({ href, label, icon, external }) → tautan bergaya tombol teks */
export function link(opts = {}) {
  const { href = '#', label, icon: ic, external = false, onClick, className } = opts;
  return el('a', { class: classNames('link-btn', className), href, target: external ? '_blank' : null, rel: external ? 'noopener' : null, onClick }, resolveIcon(ic, { size: 15 }), label, external ? icon('externalLink', { size: 13 }) : null);
}

/**
 * timeline([{ title, sub, tone, icon, time }]) → daftar kronologis vertikal (untuk riwayat run / aktivitas)
 */
export function timeline(items = [], opts = {}) {
  const node = el('div', { class: classNames('timeline', opts.className) });
  for (const it of items) {
    node.appendChild(el('div', { class: 'timeline-item' },
      el('div', { class: classNames('timeline-dot', it.tone && `tone-${it.tone}`) }, resolveIcon(it.icon || 'check', { size: 11 })),
      el('div', { class: 'flex-1 min-w-0' }, el('div', { class: 'timeline-title' }, it.title), it.sub ? el('div', { class: 'timeline-sub' }, it.sub) : null),
      it.time ? el('div', { class: 'text-sm text-muted nowrap' }, it.time) : null));
  }
  return node;
}

export const components = {
  button, iconButton, statCard, kpiChart, badge, pill, statusDot, avatar, spinner, skeleton, progressBar, tabs, emptyState, table, input, textarea, searchInput, select, toggle, checkbox, field, card, pageHeader, kbd, alert, dropdown, listPanel, glassTile, kv, divider, copyable, iconBox, pagination, link, timeline,
  icon, resolveIcon,
};
export default components;
