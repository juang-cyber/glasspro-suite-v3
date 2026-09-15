'use strict';
// Pembuatan PDF (pdf-lib): gabungan label AWB dengan halaman cover + stempel, dan Product List.
// Hanya memakai font standar (Helvetica) sehingga teks harus disaring ke WinAnsi (lihat sanitizeText).
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const A4 = { width: 595, height: 842 };
const INDIGO = rgb(0.36, 0.36, 0.84);
const INDIGO_SOFT = rgb(0.93, 0.94, 1);
const ORANGE = rgb(0.93, 0.32, 0.13);
const RED = rgb(0.86, 0.15, 0.15);
const TEXT = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const BORDER = rgb(0.85, 0.86, 0.9);
const ZEBRA = rgb(0.96, 0.96, 0.98);
const WHITE = rgb(1, 1, 1);

// Karakter yang bisa di-encode WinAnsi (dipakai StandardFonts). Selain ini diganti '?'.
const WINANSI = /^[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]$/;

// Ganti karakter di luar WinAnsi (emoji, CJK, dll) agar Helvetica tidak melempar error.
// Diakritik dinormalisasi (NFKD lalu tanda diakritik dibuang) supaya "café" tetap terbaca.
function sanitizeText(input, repl = '?') {
  if (input === null || input === undefined) return '';
  let str;
  try { str = String(input); } catch { return ''; }
  const out = [];
  for (const ch of str.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    if (ch === '\n' || WINANSI.test(ch)) { out.push(ch); continue; }
    let cand = '';
    try { cand = ch.normalize('NFKD').replace(/\p{M}+/gu, ''); } catch { cand = ''; }
    if (cand && [...cand].every((c) => WINANSI.test(c))) { out.push(cand); continue; }
    if (repl) out.push(repl);
  }
  return out.join('');
}

// ---------- helper teks ----------
function textWidth(font, text, size) {
  try { return font.widthOfTextAtSize(text, size); } catch { return text.length * size * 0.5; }
}

// Potong teks satu baris agar muat maxWidth (tambah '…' bila terpotong).
function ellipsize(font, size, text, maxWidth) {
  const t = sanitizeText(text).replace(/\n/g, ' ');
  if (textWidth(font, t, size) <= maxWidth) return t;
  const ell = '…';
  let s = t;
  while (s.length > 0 && textWidth(font, s + ell, size) > maxWidth) s = s.slice(0, -1);
  return s.trimEnd() + ell;
}

// Bungkus kata ke beberapa baris; maksimal maxLines (baris terakhir dipotong dengan '…').
function wrapLines(font, size, text, maxWidth, maxLines = 2) {
  const t = sanitizeText(text).replace(/\n/g, ' ').trim();
  if (!t) return [''];
  const words = t.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(font, candidate, size) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    // kata tunggal terlalu panjang -> patah paksa
    let w = word;
    while (textWidth(font, w, size) > maxWidth && w.length > 1) {
      let i = w.length;
      while (i > 1 && textWidth(font, w.slice(0, i), size) > maxWidth) i--;
      lines.push(w.slice(0, i));
      w = w.slice(i);
    }
    line = w;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines.length ? lines : [''];
  const kept = lines.slice(0, maxLines);
  const rest = lines.slice(maxLines - 1).join(' ');
  kept[maxLines - 1] = ellipsize(font, size, rest, maxWidth);
  return kept;
}

// ---------- label kode -> teks Indonesia ----------
const SHIP_LABEL = { instant: 'Instant / Same Day', regular: 'Regular' };
const CAT_LABEL = { tg: 'Tempered Glass (TG)', hg: 'Hydrogel (HG)', mix: 'Campuran (MIX)', review: 'Perlu Diperiksa' };
const WH_LABEL = { all: 'Semua Gudang', jkt: 'Jakarta', sby: 'Surabaya' };
const PART_LABEL = { p1: 'Part 1', p2: 'Part 2', p3: 'Part 3' };
const MP_LABEL = { shopee: 'Shopee', tiktok: 'TikTok' };

function labelOf(map, v, fallback = '-') {
  if (v === null || v === undefined || v === '') return fallback;
  const k = String(v).toLowerCase();
  return map[k] || String(v);
}

function fmtPart(c) {
  if (!c) return '-';
  const key = String(c.part || '').toLowerCase();
  const base = c.part_label || PART_LABEL[key] || (c.part ? String(c.part) : '-');
  return key && c.part_label ? `${base} (${key})` : base;
}

// ---------- cover ----------
// Gambar halaman cover A4 potret dengan judul, blok info dua kolom, garis aksen, dan catatan kaki.
function drawCover(doc, fonts, { title, subtitle, cover, extraRows, footNote }) {
  const page = doc.addPage([A4.width, A4.height]);
  const { bold, regular } = fonts;
  const c = cover || {};
  const M = 50;
  let y = A4.height - 70;

  // Pita aksen di tepi atas
  page.drawRectangle({ x: 0, y: A4.height - 14, width: A4.width, height: 14, color: INDIGO });
  // Nama aplikasi kecil
  page.drawText(sanitizeText('GLASS PRO SUITE'), { x: M, y, size: 10, font: bold, color: INDIGO });
  y -= 34;
  // Judul besar (dibagi baris bila perlu)
  const titleLines = wrapLines(bold, 26, title, A4.width - 2 * M, 2);
  for (const line of titleLines) {
    page.drawText(line, { x: M, y, size: 26, font: bold, color: TEXT });
    y -= 32;
  }
  if (subtitle) {
    page.drawText(ellipsize(regular, 12, subtitle, A4.width - 2 * M), { x: M, y, size: 12, font: regular, color: MUTED });
    y -= 20;
  }
  // Garis aksen indigo
  y -= 6;
  page.drawRectangle({ x: M, y, width: A4.width - 2 * M, height: 2.5, color: INDIGO });
  y -= 30;

  // Blok info dua kolom
  const rows = [
    ['Part', fmtPart(c)],
    ['Jenis pengiriman', labelOf(SHIP_LABEL, c.ship_type)],
    ['Kategori', labelOf(CAT_LABEL, c.sku_category)],
    ['Gudang', c.warehouse_name ? `${c.warehouse_name} (${String(c.warehouse_code || '-')})` : labelOf(WH_LABEL, c.warehouse_code)],
    ['Tanggal proses', c.date_text || '-'],
    ['Jumlah order', c.order_count === null || c.order_count === undefined ? '-' : String(c.order_count)],
    ['Marketplace', labelOf(MP_LABEL, c.marketplace, 'Shopee')],
    ['Dibuat oleh', c.generated_by || '-'],
    ['Waktu dibuat', c.generated_at_text || '-'],
    ['Nama file', c.file_name || '-'],
    ...(extraRows || []),
  ];
  const colW = (A4.width - 2 * M - 20) / 2;
  const boxH = 54;
  const boxGap = 12;
  const boxTop = y;
  rows.forEach((row, i) => {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x = M + col * (colW + 20);
    const top = boxTop - rowIdx * (boxH + boxGap);
    page.drawRectangle({ x, y: top - boxH, width: colW, height: boxH, color: INDIGO_SOFT, borderColor: BORDER, borderWidth: 0.5 });
    page.drawRectangle({ x, y: top - boxH, width: 3, height: boxH, color: INDIGO });
    page.drawText(sanitizeText(String(row[0]).toUpperCase()), { x: x + 14, y: top - 18, size: 8, font: bold, color: MUTED });
    const val = ellipsize(bold, 13, String(row[1] === null || row[1] === undefined ? '-' : row[1]), colW - 28);
    page.drawText(val, { x: x + 14, y: top - 38, size: 13, font: bold, color: TEXT });
  });
  y = boxTop - Math.ceil(rows.length / 2) * (boxH + boxGap) - 10;

  // Catatan kaki
  const note = footNote || 'PDF berhasil dibuat bukan berarti order sudah dikirim. Pastikan status pengiriman di marketplace.';
  page.drawRectangle({ x: M, y: 60, width: A4.width - 2 * M, height: 0.8, color: BORDER });
  const noteLines = wrapLines(regular, 9.5, note, A4.width - 2 * M, 3);
  let ny = 44;
  for (const line of noteLines) {
    page.drawText(line, { x: M, y: ny, size: 9.5, font: regular, color: MUTED });
    ny -= 13;
  }
  return page;
}

// ---------- stempel halaman label ----------
// Ruang "visual" halaman: menerjemahkan koordinat tampilan (setelah rotasi) ke koordinat mentah PDF.
function visualSpace(page) {
  let angle = 0;
  try { angle = Math.round(Number(page.getRotation().angle) || 0); } catch { angle = 0; }
  const rot = ((angle % 360) + 360) % 360;
  let box = null;
  try { box = page.getCropBox(); } catch { box = null; }
  if (!box || !(box.width > 0) || !(box.height > 0)) {
    let mb = { x: 0, y: 0 };
    try { mb = page.getMediaBox(); } catch { /* abaikan */ }
    const s = page.getSize();
    box = { x: mb.x || 0, y: mb.y || 0, width: s.width, height: s.height };
  }
  const { x: ox, y: oy, width: W, height: H } = box;
  const swap = rot === 90 || rot === 270;
  const toRaw = (vx, vy) => {
    if (rot === 90) return { x: ox + W - vy, y: oy + vx };
    if (rot === 180) return { x: ox + W - vx, y: oy + H - vy };
    if (rot === 270) return { x: ox + vy, y: oy + H - vx };
    return { x: ox + vx, y: oy + vy };
  };
  return { rotate: degrees(rot), toRaw, width: swap ? H : W, height: swap ? W : H };
}

// Stempel marketplace + order_sn (pojok kiri atas) dan pita "TIPE BELUM DITULIS" bila perlu.
function stampPage(page, fonts, { marketplace, order_sn, flags }) {
  const { bold, regular } = fonts;
  const v = visualSpace(page);
  const m = Math.max(6, Math.min(12, v.width * 0.03));
  const badgeText = sanitizeText(String(marketplace || 'shopee').toUpperCase());
  const bs = Math.max(7, Math.min(11, v.width * 0.035));
  const bw = textWidth(bold, badgeText, bs) + 10;
  const bh = bs + 6;
  const top = v.height - m;
  page.drawRectangle({ ...v.toRaw(m, top - bh), width: bw, height: bh, rotate: v.rotate, color: ORANGE });
  page.drawText(badgeText, { ...v.toRaw(m + 5, top - bh + 4), size: bs, font: bold, color: WHITE, rotate: v.rotate });
  const sn = sanitizeText(order_sn || '');
  if (sn) {
    const ss = Math.max(6, bs - 2);
    const maxW = v.width - m - (m + bw + 6);
    page.drawText(ellipsize(regular, ss, sn, Math.max(20, maxW)), { ...v.toRaw(m + bw + 6, top - bh + 4.5), size: ss, font: regular, color: MUTED, rotate: v.rotate });
  }
  if (flags && flags.tipe_belum_ditulis) {
    const text = 'TIPE BELUM DITULIS';
    let size = Math.max(10, Math.min(40, v.width * 0.075));
    const pad = 8;
    while (size > 6 && textWidth(bold, text, size) > v.width - 2 * pad) size -= 1;
    const rh = size + 12;
    const ry = top - bh - 6 - rh;
    page.drawRectangle({ ...v.toRaw(0, ry), width: v.width, height: rh, rotate: v.rotate, color: RED, opacity: 0.85 });
    const tw = textWidth(bold, text, size);
    page.drawText(text, { ...v.toRaw((v.width - tw) / 2, ry + 6), size, font: bold, color: WHITE, rotate: v.rotate });
  }
}

function toBytes(buf) {
  if (!buf) return null;
  if (Buffer.isBuffer(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (typeof buf === 'string') return Buffer.from(buf, 'base64');
  return null;
}

function shortError(e) {
  const msg = e && e.message ? String(e.message) : String(e || 'error');
  return msg.split('\n')[0].slice(0, 200);
}

/**
 * Gabungkan label AWB menjadi satu PDF dengan halaman cover dan stempel di tiap halaman label.
 * @returns {Promise<{ bytes: Uint8Array, page_count: number, failed: Array<{order_sn, error}> }>}
 */
async function buildLabelsPdf({ cover, labels } = {}) {
  const doc = await PDFDocument.create();
  const fonts = { bold: await doc.embedFont(StandardFonts.HelveticaBold), regular: await doc.embedFont(StandardFonts.Helvetica) };
  const c = cover || {};
  const list = Array.isArray(labels) ? labels : [];
  const orderCount = c.order_count === undefined || c.order_count === null ? list.length : c.order_count;
  drawCover(doc, fonts, {
    title: 'Glass Pro Suite — Label Pengiriman',
    subtitle: `${labelOf(SHIP_LABEL, c.ship_type)} • ${labelOf(CAT_LABEL, c.sku_category)} • ${labelOf(WH_LABEL, c.warehouse_code)}`,
    cover: { ...c, order_count: orderCount },
  });
  doc.setTitle(sanitizeText(c.file_name || 'Label Pengiriman'));
  doc.setProducer('Glass Pro Suite');
  doc.setCreator('Glass Pro Suite');

  const failed = [];
  for (const label of list) {
    const sn = label && label.order_sn ? String(label.order_sn) : '';
    try {
      const bytes = toBytes(label && label.buffer);
      if (!bytes || !bytes.length) throw new Error('Buffer label kosong');
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const indices = src.getPageIndices();
      if (!indices.length) throw new Error('Label tidak punya halaman');
      const pages = await doc.copyPages(src, indices);
      for (const p of pages) {
        doc.addPage(p);
        try {
          stampPage(p, fonts, { marketplace: label.marketplace || 'shopee', order_sn: sn, flags: label.flags || {} });
        } catch (e) {
          // Stempel gagal (halaman aneh) -> halaman tetap dimasukkan tanpa stempel
          failed.push({ order_sn: sn, error: `Stempel gagal: ${shortError(e)}`, page_added: true });
        }
      }
    } catch (e) {
      failed.push({ order_sn: sn, error: shortError(e) });
    }
  }
  const bytes = await doc.save();
  return { bytes, page_count: doc.getPageCount(), failed };
}

// ---------- product list ----------
const CAT_ORDER = { tg: 0, hg: 1 };
function catRank(c) { const k = String(c || '').toLowerCase(); return k in CAT_ORDER ? CAT_ORDER[k] : 2; }

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const ra = catRank(a.category); const rb = catRank(b.category);
    if (ra !== rb) return ra - rb;
    const sa = String(a.sku || ''); const sb = String(b.sku || '');
    if (sa !== sb) return sa.localeCompare(sb, 'en', { numeric: true, sensitivity: 'base' });
    return String(a.item_name || '').localeCompare(String(b.item_name || ''), 'en', { numeric: true, sensitivity: 'base' });
  });
}

/**
 * Product List: cover + tabel produk (No, Marketplace, SKU, Nama produk, Variasi, Kategori, Qty).
 * @returns {Promise<{ bytes: Uint8Array, page_count: number }>}
 */
async function buildProductListPdf({ cover, rows, summary } = {}) {
  const doc = await PDFDocument.create();
  const fonts = { bold: await doc.embedFont(StandardFonts.HelveticaBold), regular: await doc.embedFont(StandardFonts.Helvetica) };
  const { bold, regular } = fonts;
  const c = cover || {};
  const list = sortRows(Array.isArray(rows) ? rows.filter(Boolean) : []);
  const totalQty = list.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const sum = { orders: summary && summary.orders !== undefined ? summary.orders : (c.order_count ?? '-'), qty: summary && summary.qty !== undefined ? summary.qty : totalQty };

  drawCover(doc, fonts, {
    title: 'Glass Pro Suite — Product List',
    subtitle: `Daftar produk yang harus disiapkan • ${labelOf(WH_LABEL, c.warehouse_code)}`,
    cover: { ...c, ship_type: c.ship_type || 'Semua', sku_category: c.sku_category || 'Semua', order_count: sum.orders },
    extraRows: [['Total qty', String(sum.qty)], ['Jumlah baris', String(list.length)]],
    footNote: 'Product List dibuat dari order yang berhasil diproses pada run ini. Periksa kembali jumlah fisik sebelum pengemasan.',
  });
  doc.setTitle(sanitizeText(c.file_name || 'Product List'));
  doc.setProducer('Glass Pro Suite');
  doc.setCreator('Glass Pro Suite');

  // Kolom tabel (total lebar = 523 pt, margin 36)
  const M = 36;
  const cols = [
    { key: 'no', label: 'No', w: 28, align: 'right' },
    { key: 'marketplace', label: 'Marketplace', w: 60 },
    { key: 'sku', label: 'SKU', w: 105 },
    { key: 'item_name', label: 'Nama produk', w: 165 },
    { key: 'model_name', label: 'Variasi', w: 95 },
    { key: 'category', label: 'Kategori', w: 40 },
    { key: 'qty', label: 'Qty', w: 30, align: 'right' },
  ];
  const size = 8.5;
  const lh = size * 1.3;
  const pad = 4;
  const headerH = 22;
  const bottom = 56;
  let page = null;
  let y = 0;

  const drawHeader = () => {
    page = doc.addPage([A4.width, A4.height]);
    y = A4.height - M;
    const heading = `Product List — ${fmtPart(c)} • ${labelOf(WH_LABEL, c.warehouse_code)} • ${c.date_text || ''}`;
    page.drawText(ellipsize(bold, 11, heading, A4.width - 2 * M), { x: M, y: y - 10, size: 11, font: bold, color: TEXT });
    y -= 22;
    page.drawRectangle({ x: M, y: y - headerH, width: A4.width - 2 * M, height: headerH, color: INDIGO });
    let x = M;
    for (const col of cols) {
      const tx = col.align === 'right' ? x + col.w - pad - textWidth(bold, col.label, size) : x + pad;
      page.drawText(col.label, { x: tx, y: y - headerH + 7, size, font: bold, color: WHITE });
      x += col.w;
    }
    y -= headerH;
  };
  drawHeader();

  list.forEach((r, i) => {
    const cells = {
      no: [String(i + 1)],
      marketplace: [labelOf(MP_LABEL, r.marketplace, 'Shopee')],
      sku: wrapLines(regular, size, r.sku || '-', cols[2].w - 2 * pad, 2),
      item_name: wrapLines(regular, size, r.item_name || '-', cols[3].w - 2 * pad, 2),
      model_name: wrapLines(regular, size, r.model_name || '-', cols[4].w - 2 * pad, 2),
      category: [String(r.category || '-').toUpperCase()],
      qty: [String(Number(r.qty) || 0)],
    };
    const lines = Math.max(...Object.values(cells).map((l) => l.length));
    const h = lines * lh + 2 * pad;
    if (y - h < bottom) drawHeader();
    if (i % 2 === 1) page.drawRectangle({ x: M, y: y - h, width: A4.width - 2 * M, height: h, color: ZEBRA });
    page.drawRectangle({ x: M, y: y - h, width: A4.width - 2 * M, height: 0.5, color: BORDER });
    let x = M;
    for (const col of cols) {
      const cl = cells[col.key];
      cl.forEach((line, li) => {
        const txt = sanitizeText(line);
        const tx = col.align === 'right' ? x + col.w - pad - textWidth(regular, txt, size) : x + pad;
        page.drawText(txt, { x: tx, y: y - pad - (li + 1) * lh + (lh - size) / 2 + 2, size, font: regular, color: TEXT });
      });
      x += col.w;
    }
    y -= h;
  });

  // Ringkasan total
  const sumH = 26;
  if (y - sumH - 8 < bottom) drawHeader();
  y -= 8;
  page.drawRectangle({ x: M, y: y - sumH, width: A4.width - 2 * M, height: sumH, color: INDIGO_SOFT, borderColor: INDIGO, borderWidth: 0.8 });
  page.drawText(sanitizeText(`Total order: ${sum.orders}    Total qty: ${sum.qty}    Baris: ${list.length}`), { x: M + 10, y: y - sumH + 9, size: 10, font: bold, color: TEXT });

  // Nomor halaman (diisi setelah semua halaman ada)
  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    const t = `Halaman ${idx + 1}/${pages.length}`;
    p.drawText(t, { x: A4.width - M - textWidth(regular, t, 8), y: 24, size: 8, font: regular, color: MUTED });
    p.drawText(sanitizeText(c.file_name || 'Product List'), { x: M, y: 24, size: 8, font: regular, color: MUTED });
  });

  const bytes = await doc.save();
  return { bytes, page_count: doc.getPageCount() };
}

module.exports = { buildLabelsPdf, buildProductListPdf, sanitizeText, wrapLines, ellipsize, sortRows, visualSpace, A4 };
