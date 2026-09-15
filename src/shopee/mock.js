'use strict';
// Transport simulasi Shopee (shopee.transport = 'mock'). Meniru bentuk respons Shopee v2 persis
// (envelope {error, message, request_id, response}) untuk semua endpoint yang dipakai client,
// termasuk siklus penuh: ship_order -> PROCESSED + resi, create/result/download dokumen -> PDF A6.
// Data ±45 order dibuat relatif terhadap waktu modul dimuat / reset().
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { now, partsInTz, startOfDay } = require('../util/time');

const SHOP_ID = 999001;
const SHOP_NAME = 'Glass Pro Official (Mock)';
const DAY = 86400;
const ORDER_COUNT = 45;
const DOC_READY_DELAY_MS = 120; // dokumen "diproses" dulu sebentar sebelum READY

const CARRIERS = [
  { name: 'GrabExpress Instant', channel_id: 80001, method: 'pickup', prefix: 'GRAB', extra_dropoff: false },
  { name: 'GoSend Same Day', channel_id: 80002, method: 'pickup', prefix: 'GSD', extra_dropoff: false },
  { name: 'SPX Instant', channel_id: 80003, method: 'pickup', prefix: 'SPXID', extra_dropoff: true },
  { name: 'SPX Standard', channel_id: 80004, method: 'dropoff', prefix: 'SPXID', extra_dropoff: false },
  { name: 'J&T Express', channel_id: 80005, method: 'pickup', prefix: 'JT', extra_dropoff: false },
  { name: 'JNE Reguler', channel_id: 80006, method: 'dropoff_branch', prefix: 'JNE', extra_dropoff: false },
];

const PRODUCTS = [
  { item_id: 100001, item_name: 'Glass Pro Tempered Glass Full Cover Anti Gores', item_sku: 'TG-IP15PM', model_id: 200001, model_name: 'iPhone 15 Pro Max', model_sku: 'TG-IP15PM-CLR', price: 35000, weight: 0.05 },
  { item_id: 100002, item_name: 'Glass Pro Tempered Glass Full Cover Anti Gores', item_sku: 'TG-IP14', model_id: 200002, model_name: 'iPhone 14', model_sku: 'TG-IP14-CLR', price: 30000, weight: 0.05 },
  { item_id: 100003, item_name: 'Glass Pro Hydrogel Screen Protector Matte', item_sku: 'HG-SAMS23U', model_id: 200003, model_name: 'Samsung S23 Ultra', model_sku: 'HG-SAMS23U-MAT', price: 45000, weight: 0.03 },
  { item_id: 100004, item_name: 'Glass Pro Hydrogel Screen Protector Clear', item_sku: 'HG-UNIV', model_id: 200004, model_name: 'Universal (tulis tipe di catatan)', model_sku: 'HG-UNIV-CLR', price: 40000, weight: 0.03 },
  { item_id: 100005, item_name: 'Glass Pro Tempered Glass Universal Custom', item_sku: 'TG-UNIV', model_id: 200005, model_name: 'Universal (tulis tipe di catatan)', model_sku: 'TG-UNIV-CLR', price: 32000, weight: 0.05 },
  { item_id: 100006, item_name: 'Paket Promo Glass Pro (Bonus Lap Microfiber)', item_sku: 'GP-UNIV-PROMO', model_id: 0, model_name: '', model_sku: '', price: 15000, weight: 0.02 },
  { item_id: 100007, item_name: 'Glass Pro Tempered Glass Privacy Anti Spy', item_sku: 'TG-XIA13', model_id: 200007, model_name: 'Xiaomi 13', model_sku: 'TG-XIA13-PRV', price: 38000, weight: 0.05 },
  { item_id: 100008, item_name: 'Glass Pro Hydrogel Back Protector', item_sku: 'HG-OPPOR8', model_id: 200008, model_name: 'Oppo Reno 8', model_sku: 'HG-OPPOR8-BCK', price: 42000, weight: 0.03 },
];

const RECIPIENTS = [
  { name: 'Budi Santoso', phone: '628123456701', full_address: 'Jl. Jend. Sudirman No. 12, RT 03/RW 05', town: 'Karet Tengsin', district: 'Tanah Abang', city: 'Jakarta Pusat', state: 'DKI Jakarta', zipcode: '10220' },
  { name: 'Siti Rahmawati', phone: '628123456702', full_address: 'Perum Griya Asri Blok C7 No. 4', town: 'Cibubur', district: 'Ciracas', city: 'Jakarta Timur', state: 'DKI Jakarta', zipcode: '13720' },
  { name: 'Andi Wijaya', phone: '628123456703', full_address: 'Jl. Raya Darmo No. 88', town: 'Darmo', district: 'Wonokromo', city: 'Surabaya', state: 'Jawa Timur', zipcode: '60241' },
  { name: 'Dewi Lestari', phone: '628123456704', full_address: 'Jl. Kaliurang KM 5 No. 21', town: 'Caturtunggal', district: 'Depok', city: 'Sleman', state: 'DI Yogyakarta', zipcode: '55281' },
  { name: 'Rizky Pratama', phone: '628123456705', full_address: 'Apartemen Green Bay Tower B Lt. 12 Unit 08', town: 'Pluit', district: 'Penjaringan', city: 'Jakarta Utara', state: 'DKI Jakarta', zipcode: '14450' },
  { name: 'Maya Kusuma', phone: '628123456706', full_address: 'Jl. Ahmad Yani No. 5, Kel. Gayungan', town: 'Gayungan', district: 'Gayungan', city: 'Surabaya', state: 'Jawa Timur', zipcode: '60235' },
  { name: 'Fajar Nugroho', phone: '628123456707', full_address: 'Jl. Margonda Raya No. 300', town: 'Kemiri Muka', district: 'Beji', city: 'Depok', state: 'Jawa Barat', zipcode: '16423' },
  { name: 'Putri Ayu', phone: '628123456708', full_address: 'Jl. Setiabudi No. 17', town: 'Hegarmanah', district: 'Cidadap', city: 'Bandung', state: 'Jawa Barat', zipcode: '40141' },
  { name: 'Hendra Gunawan', phone: '628123456709', full_address: 'Jl. Gatot Subroto Kav. 21', town: 'Kuningan Timur', district: 'Setiabudi', city: 'Jakarta Selatan', state: 'DKI Jakarta', zipcode: '12950' },
  { name: 'Lina Marlina', phone: '628123456710', full_address: 'Ruko Mutiara Blok A2 No. 9', town: 'Rungkut Kidul', district: 'Rungkut', city: 'Surabaya', state: 'Jawa Timur', zipcode: '60293' },
  { name: 'Agus Salim', phone: '628123456711', full_address: 'Jl. Pemuda No. 45', town: 'Embong Kaliasin', district: 'Genteng', city: 'Surabaya', state: 'Jawa Timur', zipcode: '60271' },
  { name: 'Nur Aini', phone: '628123456712', full_address: 'Jl. Cempaka Putih Tengah No. 3', town: 'Cempaka Putih Timur', district: 'Cempaka Putih', city: 'Jakarta Pusat', state: 'DKI Jakarta', zipcode: '10510' },
];

const PHONES = ['Samsung A54', 'iPhone 13 Pro', 'Xiaomi Redmi Note 12', 'Oppo A78', 'Vivo V29', 'Infinix Hot 30', 'Realme 11', 'iPhone 11'];

const WAREHOUSES = [
  { warehouse_id: 30001, warehouse_name: 'Gudang Jakarta', warehouse_type: 1, location_id: 'JKT-001', address_id: 1001, region: 'ID', state: 'DKI Jakarta', city: 'Jakarta Barat', district: 'Kebon Jeruk', town: 'Kedoya Utara', address: 'Jl. Panjang No. 100, Kedoya', zipcode: '11520', state_code: 'JK', holiday_mode_state: 0 },
  { warehouse_id: 30002, warehouse_name: 'Gudang Surabaya', warehouse_type: 1, location_id: 'SBY-001', address_id: 1002, region: 'ID', state: 'Jawa Timur', city: 'Surabaya', district: 'Sukolilo', town: 'Keputih', address: 'Jl. Arief Rahman Hakim No. 55', zipcode: '60111', state_code: 'JI', holiday_mode_state: 0 },
];

const BRANCHES = [
  { branch_id: 70001, region: 'ID', state: 'DKI Jakarta', city: 'Jakarta Barat', district: 'Kebon Jeruk', town: 'Kedoya Utara', address: 'JNE Agen Panjang, Jl. Panjang No. 88', zipcode: '11520' },
  { branch_id: 70002, region: 'ID', state: 'Jawa Timur', city: 'Surabaya', district: 'Sukolilo', town: 'Keputih', address: 'JNE Agen Keputih, Jl. Keputih Tegal No. 2', zipcode: '60111' },
];

// ---------- state ----------
const state = {
  generated_at: 0,
  orders: new Map(), // order_sn -> objek internal
  tokens: new Set(), // access_token yang pernah diterbitkan (masih berlaku)
  refresh_tokens: new Set(),
  docs: new Map(), // `${order_sn}|${doc_type}` -> { status, ready_at }
  calls: {}, // path -> jumlah panggilan
  last_error_sn: null,
};

const rid = () => crypto.randomBytes(16).toString('hex');
const ok = (response) => ({ error: '', message: '', request_id: rid(), response });
const fail = (error, message) => ({ error, message, request_id: rid() });
const latency = () => new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 40)));
const numFromSn = (sn) => parseInt(crypto.createHash('md5').update(sn).digest('hex').slice(0, 10), 16);

function statusPlan(i) {
  if (i < 26) return 'READY_TO_SHIP';
  if (i < 32) return 'PROCESSED';
  if (i < 35) return 'CANCELLED';
  if (i < 38) return 'SHIPPED';
  if (i < 40) return 'UNPAID';
  if (i === 40) return 'IN_CANCEL';
  if (i === 41) return 'COMPLETED';
  return 'READY_TO_SHIP';
}

function trackingFor(carrier, sn) {
  return `${carrier.prefix}${String(numFromSn(sn) % 1e12).padStart(12, '0')}`;
}

function logisticsStatusFor(status) {
  switch (status) {
    case 'PROCESSED': return 'LOGISTICS_REQUEST_CREATED';
    case 'SHIPPED': return 'LOGISTICS_PICKUP_DONE';
    case 'COMPLETED': return 'LOGISTICS_DELIVERY_DONE';
    case 'CANCELLED': return 'LOGISTICS_INVALID';
    case 'IN_CANCEL': return 'LOGISTICS_READY';
    case 'UNPAID': return 'LOGISTICS_NOT_START';
    default: return 'LOGISTICS_READY';
  }
}

// Bangun ±45 order relatif terhadap waktu sekarang.
function generate() {
  const t = now();
  const p = partsInTz(t);
  const datePrefix = `${String(p.year).slice(2)}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`;
  state.generated_at = t;
  state.orders.clear();
  state.docs.clear();
  const start = t - 3 * DAY + 600;
  const step = Math.floor((3 * DAY - 1200) / ORDER_COUNT);
  for (let i = 0; i < ORDER_COUNT; i++) {
    const status = statusPlan(i);
    const carrier = CARRIERS[i % CARRIERS.length];
    const location_id = i % 3 === 0 ? 'SBY-001' : 'JKT-001';
    const products = [PRODUCTS[i % PRODUCTS.length]];
    if (i % 7 === 3) products.push(PRODUCTS[(i + 2) % PRODUCTS.length]);
    const qty = i % 4 === 0 ? 2 : 1;
    const create_time = start + i * step;
    const isLast = i === ORDER_COUNT - 1;
    const order_sn = isLast ? `${datePrefix}MKFAIL` : `${datePrefix}MK${String(i + 1).padStart(4, '0')}`;
    const isUniversal = products.some((pr) => /universal/i.test(pr.model_name));
    let note = '';
    let message_to_seller = '';
    if (isUniversal) {
      if (i % 2 === 0) note = `Tipe HP: ${PHONES[i % PHONES.length]}`;
      else if (i % 3 === 0) message_to_seller = `Tipe ${PHONES[(i + 1) % PHONES.length]} ya kak`;
    } else if (i % 5 === 0) {
      message_to_seller = 'Tolong packing bubble wrap yang tebal ya';
    } else if (i % 11 === 4) {
      note = 'Pelanggan langganan, kirim cepat';
    }
    let ship_by_date;
    if (i % 9 === 1) ship_by_date = t + 2 * 3600; // < 5 jam
    else if (i % 9 === 5) ship_by_date = t + 4 * 3600; // < 5 jam
    else if (i % 9 === 7) ship_by_date = t + 10 * 3600; // < 12 jam
    else ship_by_date = Math.max(create_time + 2 * DAY, t + DAY);
    const items = products.map((pr, k) => ({
      ...pr,
      qty: k === 0 ? qty : 1,
      order_item_id: pr.item_id,
      image_url: `https://cf.shopee.co.id/file/mock-${pr.item_id}`,
    }));
    const total_items = items.reduce((s, it) => s + it.price * it.qty, 0);
    const shipping_fee = /instant|same day/i.test(carrier.name) ? 25000 : 10000;
    const recipient = RECIPIENTS[i % RECIPIENTS.length];
    const shipped = ['PROCESSED', 'SHIPPED', 'COMPLETED'].includes(status);
    const order = {
      i,
      order_sn,
      order_status: status,
      carrier,
      location_id,
      items,
      recipient,
      note,
      message_to_seller,
      create_time,
      update_time: status === 'READY_TO_SHIP' ? create_time + 600 : Math.min(t - 60, create_time + 3600 * (1 + (i % 5))),
      pay_time: status === 'UNPAID' ? null : create_time + 300,
      ship_by_date,
      days_to_ship: 2,
      cod: i % 10 === 4,
      buyer_user_id: 5000000 + i,
      buyer_username: `pembeli_${String(i + 1).padStart(2, '0')}`,
      total_amount: total_items + shipping_fee,
      shipping_fee,
      package_number: `OFG${String(166300000000000 + i * 7919)}`,
      logistics_status: logisticsStatusFor(status),
      tracking_number: shipped ? trackingFor(carrier, order_sn) : '',
      cancel_by: status === 'CANCELLED' ? (i % 2 ? 'buyer' : 'system') : '',
      cancel_reason: status === 'CANCELLED' ? (i % 2 ? 'Need to change delivery address' : 'BACKEND_LOGISTICS_NOT_STARTED') : '',
      pickup_done_time: ['SHIPPED', 'COMPLETED'].includes(status) ? create_time + 5 * 3600 : 0,
      shipped_at: null,
      ship_method: null,
    };
    state.orders.set(order_sn, order);
  }
}

function reset() {
  generate();
  state.tokens.clear();
  state.refresh_tokens.clear();
  state.calls = {};
  state.last_error_sn = null;
}

// ---------- pembentuk respons ----------
function orderDetail(o) {
  const ra = o.recipient;
  const weight = o.items.reduce((s, it) => s + it.weight * it.qty, 0);
  return {
    order_sn: o.order_sn,
    region: 'ID',
    currency: 'IDR',
    cod: o.cod,
    total_amount: o.order_status === 'UNPAID' ? 0 : o.total_amount,
    order_status: o.order_status,
    shipping_carrier: o.carrier.name,
    checkout_shipping_carrier: o.carrier.name,
    payment_method: o.cod ? 'Cash on Delivery' : 'ShopeePay',
    estimated_shipping_fee: o.shipping_fee,
    message_to_seller: o.message_to_seller,
    create_time: o.create_time,
    update_time: o.update_time,
    pay_time: o.pay_time,
    days_to_ship: o.days_to_ship,
    ship_by_date: o.ship_by_date,
    buyer_user_id: o.buyer_user_id,
    buyer_username: o.buyer_username,
    recipient_address: {
      name: ra.name, phone: ra.phone, town: ra.town, district: ra.district, city: ra.city, state: ra.state, region: 'ID', zipcode: ra.zipcode,
      full_address: `${ra.full_address}, ${ra.town}, ${ra.district}, ${ra.city}, ${ra.state}, ${ra.zipcode}`,
    },
    actual_shipping_fee: o.shipping_fee,
    goods_to_declare: false,
    note: o.note,
    note_update_time: o.note ? o.create_time + 900 : 0,
    item_list: o.items.map((it) => ({
      item_id: it.item_id,
      item_name: it.item_name,
      item_sku: it.item_sku,
      model_id: it.model_id,
      model_name: it.model_name,
      model_sku: it.model_sku,
      model_quantity_purchased: it.qty,
      model_original_price: it.price + 5000,
      model_discounted_price: it.price,
      wholesale: false,
      weight: it.weight,
      add_on_deal: false,
      main_item: false,
      add_on_deal_id: 0,
      promotion_type: '',
      promotion_id: 0,
      order_item_id: it.order_item_id,
      promotion_group_id: 0,
      image_info: { image_url: it.image_url },
      product_location_id: [o.location_id], // sesuai sample resmi: array of string
    })),
    dropshipper: '',
    dropshipper_phone: '',
    split_up: false,
    buyer_cancel_reason: o.cancel_by === 'buyer' ? o.cancel_reason : '',
    cancel_by: o.cancel_by,
    cancel_reason: o.cancel_reason,
    actual_shipping_fee_confirmed: true,
    buyer_cpf_id: null,
    fulfillment_flag: 'fulfilled_by_local_seller',
    pickup_done_time: o.pickup_done_time,
    package_list: [
      {
        package_number: o.package_number,
        logistics_status: o.logistics_status,
        logistics_channel_id: o.carrier.channel_id,
        shipping_carrier: o.carrier.name,
        allow_self_design_awb: false,
        item_list: o.items.map((it) => ({
          item_id: it.item_id, model_id: it.model_id, model_quantity: it.qty, order_item_id: it.order_item_id, promotion_group_id: 0, product_location_id: o.location_id,
        })),
        parcel_chargeable_weight_gram: Math.round(weight * 1000) + 50,
        group_shipment_id: null,
      },
    ],
    invoice_data: null,
    reverse_shipping_fee: 0,
    order_chargeable_weight_gram: Math.round(weight * 1000) + 50,
    edt_from: o.ship_by_date + DAY,
    edt_to: o.ship_by_date + 3 * DAY,
  };
}

function timeSlots() {
  const today = startOfDay(now());
  const slots = [];
  for (const d of [today, today + DAY]) {
    slots.push({ date: d, time_text: '09:00 - 12:00', pickup_time_id: `${SHOP_ID}-${d}-1` });
    slots.push({ date: d, time_text: '13:00 - 17:00', pickup_time_id: `${SHOP_ID}-${d}-2` });
  }
  return slots;
}

function addressList() {
  return WAREHOUSES.map((w, idx) => ({
    address_id: w.address_id,
    region: w.region,
    state: w.state,
    city: w.city,
    district: w.district,
    town: w.town,
    address: w.address,
    zipcode: w.zipcode,
    address_flag: idx === 0 ? ['default_address', 'pickup_address', 'return_address'] : ['pickup_address'],
    time_slot_list: timeSlots(),
  }));
}

function shippingParameter(o) {
  const info_needed = {};
  const dropoff = { branch_list: null, slug_list: null };
  const pickup = { address_list: null };
  const m = o.carrier.method;
  if (m === 'pickup') {
    info_needed.pickup = ['address_id', 'pickup_time_id'];
    pickup.address_list = addressList();
    if (o.carrier.extra_dropoff) info_needed.dropoff = [];
  } else if (m === 'dropoff') {
    info_needed.dropoff = [];
  } else if (m === 'dropoff_branch') {
    info_needed.dropoff = ['branch_id'];
    dropoff.branch_list = BRANCHES;
  }
  return { info_needed, dropoff, pickup };
}

function validPickupTimeIds() {
  return new Set(timeSlots().map((s) => s.pickup_time_id));
}

// ---------- PDF label A6 ----------
const mm = (v) => (v * 72) / 25.4;
function san(s) {
  return String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}
function wrap(font, text, size, maxWidth) {
  const words = san(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(cand, size) <= maxWidth) cur = cand;
    else {
      if (cur) lines.push(cur);
      let piece = w;
      while (font.widthOfTextAtSize(piece, size) > maxWidth && piece.length > 1) {
        let cut = piece.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > maxWidth) cut--;
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      cur = piece;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function buildLabelPdf(orders, docType = 'NORMAL_AIR_WAYBILL') {
  const doc = await PDFDocument.create();
  doc.setTitle('Mock Shopee AWB');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const W = mm(100);
  const H = mm(150);
  const M = mm(6);
  for (const o of orders) {
    const page = doc.addPage([W, H]);
    // header kurir
    page.drawRectangle({ x: 0, y: H - mm(16), width: W, height: mm(16), color: rgb(0.11, 0.12, 0.2) });
    page.drawText(san(o.carrier.name), { x: M, y: H - mm(10.5), size: 14, font: bold, color: rgb(1, 1, 1) });
    page.drawText(san(docType === 'THERMAL_AIR_WAYBILL' ? 'THERMAL' : 'NORMAL'), { x: W - M - reg.widthOfTextAtSize('THERMAL', 7), y: H - mm(10.5), size: 7, font: reg, color: rgb(0.8, 0.8, 0.9) });
    page.drawText('MOCK LABEL - BUKAN RESI ASLI', { x: M, y: H - mm(14.5), size: 6, font: reg, color: rgb(0.9, 0.6, 0.6) });
    let y = H - mm(24);
    page.drawText('No. Pesanan', { x: M, y, size: 7, font: reg, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(san(o.order_sn), { x: M + mm(22), y, size: 9, font: bold });
    y -= mm(6);
    page.drawText('No. Resi', { x: M, y, size: 7, font: reg, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(san(o.tracking_number || '-'), { x: M + mm(22), y, size: 11, font: bold });
    y -= mm(4);
    // "barcode" garis-garis
    const bx = M;
    const bw = W - 2 * M;
    const bh = mm(18);
    y -= bh;
    page.drawRectangle({ x: bx, y, width: bw, height: bh, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.5 });
    const seed = numFromSn(o.tracking_number || o.order_sn);
    let x = bx + mm(2);
    let k = 0;
    while (x < bx + bw - mm(2)) {
      const wBar = 0.6 + ((seed >> (k % 24)) & 3) * 0.5;
      if (k % 2 === 0) page.drawRectangle({ x, y: y + mm(2), width: wBar, height: bh - mm(4), color: rgb(0, 0, 0) });
      x += wBar + 0.7;
      k++;
    }
    y -= mm(6);
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) });
    y -= mm(5);
    page.drawText('PENERIMA', { x: M, y, size: 7, font: bold, color: rgb(0.4, 0.4, 0.4) });
    y -= mm(5);
    page.drawText(san(o.recipient.name), { x: M, y, size: 11, font: bold });
    y -= mm(4.5);
    page.drawText(san(o.recipient.phone), { x: M, y, size: 9, font: reg });
    y -= mm(5);
    const addr = `${o.recipient.full_address}, ${o.recipient.town}, ${o.recipient.district}, ${o.recipient.city}, ${o.recipient.state} ${o.recipient.zipcode}`;
    for (const line of wrap(reg, addr, 8, W - 2 * M)) {
      page.drawText(line, { x: M, y, size: 8, font: reg });
      y -= mm(3.8);
    }
    y -= mm(2);
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.3, 0.3, 0.3) });
    y -= mm(5);
    page.drawText('PENGIRIM', { x: M, y, size: 7, font: bold, color: rgb(0.4, 0.4, 0.4) });
    y -= mm(4.5);
    page.drawText(san(SHOP_NAME), { x: M, y, size: 9, font: bold });
    y -= mm(6);
    page.drawText(`Produk: ${o.items.length} jenis, ${o.items.reduce((s, it) => s + it.qty, 0)} pcs${o.cod ? '  |  COD' : ''}`, { x: M, y, size: 8, font: reg });
    y -= mm(4);
    const first = o.items[0];
    for (const line of wrap(reg, `${first.item_name}${first.model_name ? ` - ${first.model_name}` : ''} x${first.qty}`, 7, W - 2 * M).slice(0, 2)) {
      page.drawText(line, { x: M, y, size: 7, font: reg });
      y -= mm(3.5);
    }
    page.drawText(`Gudang ${o.location_id}`, { x: M, y: mm(5), size: 6, font: reg, color: rgb(0.5, 0.5, 0.5) });
    // halaman kedua (daftar barang) untuk sebagian order
    if (o.items.length > 1 || o.i % 5 === 0) {
      const p2 = doc.addPage([W, H]);
      p2.drawText('DAFTAR BARANG', { x: M, y: H - mm(12), size: 12, font: bold });
      p2.drawText(san(o.order_sn), { x: M, y: H - mm(17), size: 8, font: reg });
      let yy = H - mm(26);
      for (const it of o.items) {
        for (const line of wrap(reg, `${it.qty}x ${it.item_name} - ${it.model_name || '-'} [${it.model_sku || it.item_sku}]`, 8, W - 2 * M)) {
          p2.drawText(line, { x: M, y: yy, size: 8, font: reg });
          yy -= mm(4);
        }
        yy -= mm(2);
      }
      if (o.note) {
        yy -= mm(2);
        for (const line of wrap(reg, `Catatan: ${o.note}`, 8, W - 2 * M)) { p2.drawText(line, { x: M, y: yy, size: 8, font: bold }); yy -= mm(4); }
      }
    }
  }
  return Buffer.from(await doc.save());
}

// ---------- handler endpoint ----------
function checkAuth(query) {
  const tok = query && query.access_token;
  if (!tok || !state.tokens.has(String(tok))) return fail('error_auth', 'Invalid access_token.');
  if (query.shop_id !== undefined && Number(query.shop_id) !== SHOP_ID) return fail('error_shop', 'shopid is invalid');
  return null;
}

function issueTokens() {
  const access_token = `mockat_${crypto.randomBytes(12).toString('hex')}`;
  const refresh_token = `mockrt_${crypto.randomBytes(12).toString('hex')}`;
  state.tokens.add(access_token);
  state.refresh_tokens.add(refresh_token);
  return { access_token, refresh_token, expire_in: 14400 };
}

function findOrder(sn) {
  return state.orders.get(String(sn || '')) || null;
}

const HANDLERS = {
  '/api/v2/auth/token/get': async (_q, body) => {
    if (!body || !body.code) return fail('invalid_code', 'The code is expired or used or invalid');
    const tok = issueTokens();
    if (body.main_account_id) return { error: '', message: '', request_id: rid(), ...tok, shop_id_list: [SHOP_ID], merchant_id_list: [] };
    if (Number(body.shop_id) !== SHOP_ID) return fail('invalid_shop_id', `shop_id ${body.shop_id} tidak dikenal di mock (pakai ${SHOP_ID})`);
    return { error: '', message: '', request_id: rid(), ...tok };
  },
  '/api/v2/auth/access_token/get': async (_q, body) => {
    if (!body || !body.refresh_token) return fail('error_auth', 'Invalid refresh_token.');
    if (String(body.refresh_token).startsWith('expired')) return fail('refresh_token_expired', 'Your refresh_token expired');
    if (Number(body.shop_id) !== SHOP_ID) return fail('error_auth', 'Invalid refresh_token.');
    const tok = issueTokens();
    return { error: '', message: '', request_id: rid(), partner_id: Number(body.partner_id) || 0, shop_id: SHOP_ID, ...tok };
  },
  '/api/v2/shop/get_shop_info': async () => ({
    error: '', message: '', request_id: rid(),
    shop_name: SHOP_NAME, region: 'ID', status: 'NORMAL', is_cb: false, is_sip: false, sip_affi_shops: [],
    auth_time: state.generated_at, expire_time: state.generated_at + 365 * DAY, merchant_id: null, is_upgraded_cbsc: false,
    shop_fulfillment_flag: 'Pure - 3PF Shop', is_main_shop: false, is_direct_shop: false, linked_main_shop_id: 0, linked_direct_shop_list: [],
  }),
  '/api/v2/shop/get_warehouse_detail': async () => ok(WAREHOUSES.map((w) => ({ ...w }))),
  '/api/v2/order/get_order_list': async (q) => {
    const field = q.time_range_field === 'update_time' ? 'update_time' : q.time_range_field === 'create_time' ? 'create_time' : null;
    if (!field) return fail('error_param', 'Wrong parameters, detail: time_range_field is invalid.');
    const from = Number(q.time_from);
    const to = Number(q.time_to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 15 * DAY) {
      return fail('order.order_list_invalid_time', 'Start time must be earlier than end time and diff in 15days.');
    }
    const size = Number(q.page_size);
    if (!Number.isFinite(size) || size < 1 || size > 100) return fail('error_param', 'Wrong parameters, detail: page_size must be between 1 and 100.');
    const offset = q.cursor ? parseInt(q.cursor, 10) || 0 : 0;
    let rows = [...state.orders.values()].filter((o) => o[field] >= from && o[field] <= to);
    if (q.order_status) rows = rows.filter((o) => o.order_status === q.order_status);
    rows.sort((a, b) => b[field] - a[field]);
    const slice = rows.slice(offset, offset + size);
    const more = offset + size < rows.length;
    const withStatus = String(q.response_optional_fields || '').split(',').includes('order_status');
    return ok({
      more,
      next_cursor: more ? String(offset + size) : '',
      order_list: slice.map((o) => (withStatus ? { order_sn: o.order_sn, order_status: o.order_status } : { order_sn: o.order_sn })),
    });
  },
  '/api/v2/order/get_order_detail': async (q) => {
    const sns = String(q.order_sn_list || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!sns.length || sns.length > 50) return fail('error_param', 'Wrong parameters, detail: order_sn_list limit [1,50].');
    const found = sns.map(findOrder).filter(Boolean);
    if (!found.length) return fail('error_not_found', 'Wrong parameters, detail: the order is not found.');
    const res = ok({ order_list: found.map(orderDetail) });
    const missing = sns.filter((s) => !findOrder(s));
    if (missing.length) res.warning = missing.map((s) => `order ${s} not found`);
    return res;
  },
  '/api/v2/logistics/get_shipping_parameter': async (q) => {
    const o = findOrder(q.order_sn);
    if (!o) return fail('logistics.package_not_found', 'Wrong parameters, detail: package not found.');
    if (q.package_number && q.package_number !== o.package_number) return fail('logistics.package_not_found', 'Wrong parameters, detail: package not found.');
    if (o.order_status !== 'READY_TO_SHIP') return fail('logistics.error_status_limit', `Order ${o.order_sn} berstatus ${o.order_status}, bukan READY_TO_SHIP.`);
    return ok(shippingParameter(o));
  },
  '/api/v2/logistics/ship_order': async (_q, body) => {
    const o = findOrder(body && body.order_sn);
    if (!o) return fail('logistics.package_not_found', 'Wrong parameters, detail: package not found.');
    if (body.package_number && body.package_number !== o.package_number) return fail('logistics.package_not_found', 'Wrong parameters, detail: package not found.');
    if (o.order_status !== 'READY_TO_SHIP') return fail('logistics.error_status_limit', `Order ${o.order_sn} berstatus ${o.order_status}, bukan READY_TO_SHIP.`);
    if (o.order_sn.endsWith('FAIL')) {
      state.last_error_sn = o.order_sn;
      return fail('logistics.invalid_error', 'Alamat pickup tidak dalam jangkauan kurir (simulasi kegagalan ship_order).');
    }
    const param = shippingParameter(o);
    const avail = Object.keys(param.info_needed);
    let method = null;
    if (body.pickup) {
      if (!avail.includes('pickup')) return fail('logistics.invalid_error', 'Pickup tidak tersedia untuk kurir ini.');
      const addr = param.pickup.address_list.find((a) => Number(a.address_id) === Number(body.pickup.address_id));
      if (!addr) return fail('logistics.invalid_error', 'Wrong parameters, detail: address_id is invalid.');
      if (param.info_needed.pickup.includes('pickup_time_id') && !validPickupTimeIds().has(String(body.pickup.pickup_time_id || ''))) {
        return fail('logistics.invalid_error', 'Wrong parameters, detail: pickup_time_id is invalid.');
      }
      method = 'pickup';
    } else if (body.dropoff) {
      if (!avail.includes('dropoff')) return fail('logistics.invalid_error', 'Dropoff tidak tersedia untuk kurir ini.');
      if (param.info_needed.dropoff.includes('branch_id') && !BRANCHES.some((b) => Number(b.branch_id) === Number(body.dropoff.branch_id))) {
        return fail('logistics.invalid_error', 'Wrong parameters, detail: branch_id is invalid.');
      }
      method = 'dropoff';
    } else if (body.non_integrated) {
      return fail('logistics.invalid_error', 'Kurir ini terintegrasi, non_integrated tidak diterima.');
    } else {
      return fail('error_param', 'Wrong parameters, detail: pickup/dropoff/non_integrated required.');
    }
    o.order_status = 'PROCESSED';
    o.logistics_status = 'LOGISTICS_REQUEST_CREATED';
    o.tracking_number = trackingFor(o.carrier, o.order_sn);
    o.update_time = now();
    o.shipped_at = now();
    o.ship_method = method;
    return ok({});
  },
  '/api/v2/logistics/get_tracking_number': async (q) => {
    const o = findOrder(q.order_sn);
    if (!o) return fail('logistics.package_not_found', 'Wrong parameters, detail: package not found.');
    return ok({
      order_sn: o.order_sn, package_number: o.package_number,
      tracking_number: o.tracking_number || '',
      hint: o.tracking_number ? '' : 'Nomor resi belum tersedia, silakan coba lagi nanti.',
    });
  },
  '/api/v2/logistics/get_shipping_document_parameter': async (_q, body) => {
    const list = (body && body.order_list) || [];
    return ok({
      result_list: list.map((e) => {
        const o = findOrder(e.order_sn);
        if (!o) return { order_sn: e.order_sn, package_number: e.package_number || '', fail_error: 'logistics.package_not_found', fail_message: 'package not found' };
        return { order_sn: o.order_sn, package_number: o.package_number, suggest_shipping_document_type: 'NORMAL_AIR_WAYBILL', selectable_shipping_document_type: ['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'] };
      }),
    });
  },
  '/api/v2/logistics/create_shipping_document': async (_q, body) => {
    const list = (body && body.order_list) || [];
    if (!list.length || list.length > 50) return fail('error_param', 'Wrong parameters, detail: order_list limit [1,50].');
    return ok({
      result_list: list.map((e) => {
        const o = findOrder(e.order_sn);
        if (!o) return { order_sn: e.order_sn, package_number: e.package_number || '', fail_error: 'logistics.package_not_found', fail_message: 'package not found' };
        if (!['PROCESSED', 'SHIPPED', 'COMPLETED'].includes(o.order_status)) {
          return { order_sn: o.order_sn, package_number: o.package_number, fail_error: 'logistics.package_can_not_print', fail_message: `Order berstatus ${o.order_status}, arrange shipment dulu.` };
        }
        const type = e.shipping_document_type || 'NORMAL_AIR_WAYBILL';
        state.docs.set(`${o.order_sn}|${type}`, { status: 'PROCESSING', ready_at: Date.now() + DOC_READY_DELAY_MS });
        return { order_sn: o.order_sn, package_number: o.package_number };
      }),
    });
  },
  '/api/v2/logistics/get_shipping_document_result': async (_q, body) => {
    const list = (body && body.order_list) || [];
    return ok({
      result_list: list.map((e) => {
        const o = findOrder(e.order_sn);
        const type = e.shipping_document_type || 'NORMAL_AIR_WAYBILL';
        if (!o) return { order_sn: e.order_sn, package_number: e.package_number || '', status: 'FAILED', fail_error: 'logistics.package_not_found', fail_message: 'package not found' };
        const d = state.docs.get(`${o.order_sn}|${type}`);
        if (!d) return { order_sn: o.order_sn, package_number: o.package_number, status: 'FAILED', fail_error: 'logistics.shipping_document_not_created', fail_message: 'Dokumen belum dibuat, panggil create_shipping_document dulu.' };
        if (Date.now() >= d.ready_at) d.status = 'READY';
        return { order_sn: o.order_sn, package_number: o.package_number, status: d.status };
      }),
    });
  },
  '/api/v2/logistics/download_shipping_document': async (_q, body) => {
    const list = (body && body.order_list) || [];
    if (!list.length || list.length > 50) return fail('error_param', 'Wrong parameters, detail: order_list limit [1,50].');
    const type = (body && body.shipping_document_type) || 'NORMAL_AIR_WAYBILL';
    const orders = [];
    for (const e of list) {
      const o = findOrder(e.order_sn);
      if (!o) return fail('logistics.package_not_found', `Wrong parameters, detail: package ${e.order_sn} not found.`);
      const d = state.docs.get(`${o.order_sn}|${type}`);
      if (!d) return fail('logistics.shipping_document_should_print_first', `Dokumen ${o.order_sn} belum dibuat (create_shipping_document).`);
      if (Date.now() < d.ready_at) return fail('logistics.shipping_document_not_ready', `Dokumen ${o.order_sn} masih diproses, coba lagi.`);
      d.status = 'READY';
      orders.push(o);
    }
    return buildLabelPdf(orders, type);
  },
};

// Titik masuk transport mock. Mengembalikan objek JSON (bentuk Shopee) atau Buffer (PDF).
async function handle({ path, method = 'GET', query = {}, body = {}, binary = false } = {}) {
  await latency();
  state.calls[path] = (state.calls[path] || 0) + 1;
  const h = HANDLERS[path];
  if (!h) return fail('error_not_found', `Endpoint mock tidak dikenal: ${String(method).toUpperCase()} ${path}`);
  if (!path.startsWith('/api/v2/auth/')) {
    const authErr = checkAuth(query || {});
    if (authErr) return authErr;
  }
  const res = await h(query || {}, body || {}, { binary });
  return res;
}

function listOrders() {
  return [...state.orders.values()];
}

if (!state.generated_at) generate();

module.exports = {
  SHOP_ID, SHOP_NAME, WAREHOUSES, CARRIERS, PRODUCTS,
  handle, reset, state, listOrders, getOrder: findOrder, orderDetail, buildLabelPdf,
};
