'use strict';
// Test engine/pdf.js (AGENT PDFPROC): label gabungan + cover + stempel, product list, sanitizeText.
const path = require('path');
const fs = require('fs');
const TMP = path.resolve(__dirname, '..', '.tmp', `pdfproc-pdf-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
process.env.STORAGE_DIR = TMP;

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');
const pdf = require('../src/engine/pdf');

// Label palsu A6 (100x150 mm = 283x425 pt), opsional rotasi & jumlah halaman.
async function fakeLabel(sn, { rotate = 0, pages = 1 } = {}) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([283, 425]);
    p.drawText(`LABEL ${sn} hal ${i + 1}`, { x: 20, y: 380, size: 14, font: f });
    if (rotate) p.setRotation(degrees(rotate));
  }
  return Buffer.from(await d.save());
}

const cover = {
  part: 'p1', part_label: 'Part 1', ship_type: 'instant', sku_category: 'tg', warehouse_code: 'jkt', warehouse_name: 'Jakarta',
  date_text: '15/09/2026', order_count: 3, marketplace: 'Shopee', generated_by: 'Admin Glass Pro', generated_at_text: '15/09/2026 09:30 WIB',
  file_name: '15092026-p1-ins-tg-jkt.pdf',
};

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* abaikan */ } });

describe('pdf.sanitizeText', () => {
  test('mengganti karakter non-WinAnsi dan membuang diakritik', () => {
    assert.equal(pdf.sanitizeText('Halo 🚀'), 'Halo ?');
    assert.equal(pdf.sanitizeText('中文'), '??');
    assert.equal(pdf.sanitizeText('café'), 'café', 'é ada di WinAnsi, dipertahankan');
    assert.equal(pdf.sanitizeText('Việt'), 'Viet', 'diakritik di luar WinAnsi dibuang');
    assert.equal(pdf.sanitizeText('Ｆull ﬁ'), 'Full fi', 'NFKD: fullwidth & ligatur');
    assert.equal(pdf.sanitizeText('a\tb\r\nc'), 'a b\nc');
    assert.equal(pdf.sanitizeText('No. 26091… — €'), 'No. 26091… — €');
  });
  test('tidak crash untuk null/undefined/angka/objek', () => {
    assert.equal(pdf.sanitizeText(null), '');
    assert.equal(pdf.sanitizeText(undefined), '');
    assert.equal(pdf.sanitizeText(123), '123');
    assert.equal(pdf.sanitizeText({ a: 1 }), '[object Object]');
  });
});

describe('pdf.buildLabelsPdf', () => {
  test('cover + semua halaman label, label rusak dilewati', async () => {
    const labels = [
      { order_sn: 'SN-A', marketplace: 'shopee', buffer: await fakeLabel('SN-A'), flags: { tipe_belum_ditulis: true } },
      { order_sn: 'SN-B', marketplace: 'shopee', buffer: await fakeLabel('SN-B', { rotate: 90 }), flags: { tipe_belum_ditulis: false } },
      { order_sn: 'SN-C', marketplace: 'shopee', buffer: await fakeLabel('SN-C', { pages: 2 }), flags: {} },
      { order_sn: 'SN-RUSAK', marketplace: 'shopee', buffer: Buffer.from('bukan pdf'), flags: {} },
      { order_sn: 'SN-KOSONG', marketplace: 'shopee', buffer: null },
    ];
    const res = await pdf.buildLabelsPdf({ cover, labels });
    assert.ok(res.bytes instanceof Uint8Array && res.bytes.length > 1000);
    assert.equal(Buffer.from(res.bytes.slice(0, 5)).toString(), '%PDF-');
    assert.equal(res.page_count, 1 + 1 + 1 + 2, 'cover + 4 halaman label');
    assert.equal(res.failed.length, 2);
    assert.deepEqual(res.failed.map((f) => f.order_sn).sort(), ['SN-KOSONG', 'SN-RUSAK']);
    assert.ok(res.failed.every((f) => typeof f.error === 'string' && f.error.length));

    // hasil bisa dibaca kembali
    const doc = await PDFDocument.load(res.bytes);
    assert.equal(doc.getPageCount(), 5);
    const pages = doc.getPages();
    assert.equal(Math.round(pages[0].getWidth()), 595, 'cover A4 potret');
    assert.equal(Math.round(pages[0].getHeight()), 842);
    assert.equal(Math.round(pages[1].getWidth()), 283, 'label A6');
    assert.equal(Math.round(pages[1].getHeight()), 425);
    assert.equal(pages[2].getRotation().angle, 90, 'rotasi halaman label dipertahankan');
    assert.equal(Math.round(pages[4].getWidth()), 283);
    // halaman label sudah punya konten tambahan (stempel) -> font Helvetica ada di resource halaman
    const fontDict = pages[1].node.Resources() && pages[1].node.Resources().lookup(require('pdf-lib').PDFName.of('Font'));
    assert.ok(fontDict, 'resource font ada di halaman label (stempel digambar)');
  });

  test('stempel benar-benar tergambar: SN + marketplace di tiap halaman, TIPE BELUM DITULIS hanya bila diflag, rotasi 90° diikuti', async () => {
    const zlib = require('zlib');
    const { PDFArray, PDFName } = require('pdf-lib');
    // Content stream halaman (inflate bila FlateDecode). Stempel ditambahkan pdf-lib sebagai stream TERAKHIR
    // (stream asli label tetap utuh di depannya).
    const pageStreams = (doc, page) => {
      const c = page.node.Contents();
      const refs = c instanceof PDFArray ? c.asArray() : [c];
      return refs.map((ref) => {
        const stream = doc.context.lookup(ref);
        let bytes = Buffer.from(stream.contents);
        const filter = stream.dict.get(PDFName.of('Filter'));
        if (filter && String(filter).includes('FlateDecode')) bytes = zlib.inflateSync(bytes);
        return bytes.toString('latin1');
      });
    };
    const pageContent = (doc, page) => pageStreams(doc, page).join('\n');
    const stampContent = (doc, page) => { const s = pageStreams(doc, page); return s[s.length - 1]; };
    const hex = (s) => Buffer.from(s, 'latin1').toString('hex');
    const has = (content, text) => content.includes(`(${text})`) || content.toLowerCase().includes(hex(text));
    // Matriks teks (Tm): kumpulkan (a,b,c,d) yang dipakai
    const textMatrices = (content) => [...content.matchAll(/(-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?) (-?[\d.]+(?:e-?\d+)?) Tm/g)]
      .map((m) => m.slice(1, 5).map(Number));

    const res = await pdf.buildLabelsPdf({
      cover,
      labels: [
        { order_sn: 'SN-TIPE', marketplace: 'shopee', buffer: await fakeLabel('SN-TIPE'), flags: { tipe_belum_ditulis: true } },
        { order_sn: 'SN-ROT', marketplace: 'shopee', buffer: await fakeLabel('SN-ROT', { rotate: 90 }), flags: {} },
        { order_sn: 'SN-180', marketplace: 'tiktok', buffer: await fakeLabel('SN-180', { rotate: 180 }), flags: { tipe_belum_ditulis: false } },
      ],
    });
    const doc = await PDFDocument.load(res.bytes);
    const pages = doc.getPages();
    assert.equal(pages.length, 4);
    const cTipe = pageContent(doc, pages[1]);
    const cRot = pageContent(doc, pages[2]);
    const c180 = pageContent(doc, pages[3]);
    // konten label asli tetap ada (stream asli tidak disentuh, stempel ditambahkan sebagai stream baru)
    assert.ok(has(cTipe, 'LABEL SN-TIPE hal 1'), 'isi label asli dipertahankan');
    assert.ok(pageStreams(doc, pages[1]).length >= 2, 'stempel berupa stream terpisah');
    assert.ok(!has(stampContent(doc, pages[1]), 'LABEL SN-TIPE'), 'stream stempel tidak memuat isi label asli');
    // stempel SN + marketplace di setiap halaman label
    assert.ok(has(cTipe, 'SN-TIPE') && has(cTipe, 'SHOPEE'));
    assert.ok(has(cRot, 'SN-ROT') && has(cRot, 'SHOPEE'));
    assert.ok(has(c180, 'SN-180') && has(c180, 'TIKTOK'), 'nama marketplace mengikuti label');
    // TIPE BELUM DITULIS hanya pada halaman yang diflag
    assert.ok(has(cTipe, 'TIPE BELUM DITULIS'));
    assert.ok(!has(cRot, 'TIPE BELUM DITULIS'));
    assert.ok(!has(c180, 'TIPE BELUM DITULIS'));
    // halaman tanpa rotasi: semua teks stempel tegak (a=1,b=0); halaman /Rotate 90: teks diputar (b=1,c=-1); 180: (a=-1,d=-1)
    const round = (v) => Math.round(v);
    const stampTipe = textMatrices(stampContent(doc, pages[1]));
    assert.ok(stampTipe.length >= 3, `ada >= 3 teks stempel (dapat ${stampTipe.length})`);
    assert.ok(stampTipe.every(([a, b]) => round(a) === 1 && round(b) === 0));
    const stampRot = textMatrices(stampContent(doc, pages[2]));
    assert.ok(stampRot.length >= 2);
    assert.ok(stampRot.every(([, b, c]) => round(b) === 1 && round(c) === -1), `rotasi 90 dipakai: ${JSON.stringify(stampRot)}`);
    const stamp180 = textMatrices(stampContent(doc, pages[3]));
    assert.ok(stamp180.length >= 2);
    assert.ok(stamp180.every(([a, , , d]) => round(a) === -1 && round(d) === -1), `rotasi 180 dipakai: ${JSON.stringify(stamp180)}`);
    // halaman cover memuat info penting
    const cCover = pageContent(doc, pages[0]);
    for (const t of ['GLASS PRO SUITE', 'Part 1 (p1)', 'Jakarta (jkt)', '15/09/2026', 'Admin Glass Pro', '15092026-p1-ins-tg-jkt.pdf', 'Shopee']) assert.ok(has(cCover, t), `cover memuat "${t}"`);
  });

  test('tanpa label -> hanya cover', async () => {
    const res = await pdf.buildLabelsPdf({ cover: { ...cover, order_count: 0 }, labels: [] });
    assert.equal(res.page_count, 1);
    assert.deepEqual(res.failed, []);
  });

  test('cover dengan data tidak lengkap tidak crash', async () => {
    const res = await pdf.buildLabelsPdf({ cover: { part: null, generated_by: 'Budi 🚀 中文' }, labels: [{ order_sn: null, buffer: await fakeLabel('X') }] });
    assert.equal(res.page_count, 2);
    const res2 = await pdf.buildLabelsPdf({});
    assert.equal(res2.page_count, 1);
  });
});

describe('pdf.buildProductListPdf', () => {
  test('60 baris -> beberapa halaman, header berulang, nomor halaman', async () => {
    const rows = [];
    for (let i = 0; i < 60; i++) {
      rows.push({
        marketplace: 'shopee', sku: `${i % 3 === 0 ? 'HG' : 'TG'}-IP${i}-CLR`,
        item_name: `Tempered Glass Full Cover Anti Gores Premium ${i} Ultra Clear untuk semua tipe HP 中文 🚀 nama sangat panjang sekali`,
        model_name: i % 4 === 0 ? 'Universal (tulis tipe di catatan)' : `iPhone ${i} Pro Max`, category: i % 3 === 0 ? 'hg' : 'tg', qty: 1 + (i % 3), order_count: 1,
      });
    }
    rows.push({ marketplace: 'shopee', sku: 'GP-UNIV-PROMO', item_name: 'Promo', model_name: '', category: null, qty: 2, order_count: 2 });
    const res = await pdf.buildProductListPdf({
      cover: { part: 'p1', part_label: 'Part 1', warehouse_code: 'jkt', warehouse_name: 'Jakarta', date_text: '15/09/2026', order_count: 40, generated_by: 'Admin', generated_at_text: '15/09/2026 09:30 WIB', file_name: '15092026-p1-productlist-jkt.pdf' },
      rows, summary: { orders: 40, qty: 122 },
    });
    assert.ok(res.page_count >= 3, `cover + >= 2 halaman tabel (dapat ${res.page_count})`);
    const doc = await PDFDocument.load(res.bytes);
    assert.equal(doc.getPageCount(), res.page_count);
    for (const p of doc.getPages()) { assert.equal(Math.round(p.getWidth()), 595); assert.equal(Math.round(p.getHeight()), 842); }
  });

  test('urutan baris: tg -> hg -> lainnya lalu SKU (natural)', () => {
    const sorted = pdf.sortRows([
      { sku: 'HG-2', category: 'hg' }, { sku: 'GP-1', category: null }, { sku: 'TG-10', category: 'tg' }, { sku: 'TG-2', category: 'tg' }, { sku: 'HG-1', category: 'hg' },
    ]);
    assert.deepEqual(sorted.map((r) => r.sku), ['TG-2', 'TG-10', 'HG-1', 'HG-2', 'GP-1']);
  });

  test('rows kosong / null tetap menghasilkan PDF', async () => {
    const res = await pdf.buildProductListPdf({ cover: {}, rows: null });
    assert.ok(res.page_count >= 2);
  });
});

describe('pdf.wrapLines', () => {
  test('maksimal 2 baris lalu dipotong dengan …', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = pdf.wrapLines(font, 9, 'kata '.repeat(60).trim(), 100, 2);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].endsWith('…'));
    assert.ok(font.widthOfTextAtSize(lines[1], 9) <= 100);
    assert.deepEqual(pdf.wrapLines(font, 9, '', 100), ['']);
    const hard = pdf.wrapLines(font, 9, 'A'.repeat(200), 50, 3);
    assert.equal(hard.length, 3);
  });
});
