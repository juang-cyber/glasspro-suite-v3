# Glass Pro Suite — Kontrak Modul (WAJIB DIIKUTI SEMUA AGENT)

Aplikasi web pemrosesan order Shopee untuk Glass Pro: sinkronisasi order dari Shopee Open Platform v2,
pengelompokan (Part / jenis pengiriman / kategori SKU / gudang), validasi tipe HP, preview + koreksi manual,
proses (arrange shipment + download label AWB), gabung PDF per kategori dengan cover, Product List, riwayat.

Bahasa UI: **Bahasa Indonesia**. Backend: Node ≥20, **CommonJS** (`require`), Express 4, better-sqlite3, pdf-lib,
bcryptjs, cookie-session. **Jangan menambah dependency lain** tanpa alasan kuat (tulis di laporan jika terpaksa).
Frontend: vanilla JS ES modules (tanpa build step), CSS custom, Google Fonts Inter.

Waktu: semua unix **detik**. Zona tampilan: Asia/Jakarta (WIB). Helper: `src/util/time.js`.

## 1. Struktur & kepemilikan file

```
src/
  index.js                 (SUDAH ADA) express app, mount route, static SPA, scheduler start
  config.js                (SUDAH ADA) env -> config
  settings-defaults.js     (SUDAH ADA) default semua setting (key -> value)
  db/index.js, schema.sql, repo.js   (SUDAH ADA) akses data — pakai repo.*, JANGAN SQL langsung di modul lain
  middleware/auth.js       (SUDAH ADA) attachUser, requireAuth, requireAdmin
  routes/auth.js           (SUDAH ADA) /api/auth/*
  util/time.js, log.js, errors.js    (SUDAH ADA)
  shopee/                  [AGENT SHOPEE] sign.js, client.js, auth.js, orders.js, logistics.js, shop.js, mock.js, index.js
  bridge/router.js         [AGENT SHOPEE] jembatan /bridge/shopee
  routes/shopee.js         [AGENT SHOPEE]
  engine/classify.js, validate.js, preview.js, naming.js, part.js   [AGENT ENGINE]
  engine/pdf.js, process.js          [AGENT PDFPROC]
  routes/process.js, routes/history.js   [AGENT PDFPROC]
  engine/sync.js           [AGENT SYNC]
  routes/sync.js, routes/orders.js, routes/dashboard.js, routes/settings.js   [AGENT SYNC]
public/
  index.html, css/*.css, js/core.js, js/api.js, js/router.js, js/fmt.js, js/components.js, js/layout.js, js/main.js, js/pages/login.js   [AGENT UICORE]
  js/pages/dashboard.js, process.js, orders.js, history.js, settings.js   [AGENT UI-PAGES, gelombang 2]
test/*.test.js             node:test, tiap agent buat test untuk modulnya
scripts/seed-mock.js       [AGENT SHOPEE] isi DB dengan data mock (opsional; mock transport sudah cukup)
```

Setiap agent **hanya menulis file miliknya**. Jika butuh perubahan di file milik orang lain (termasuk repo.js),
tulis di laporan akhir: file, fungsi, alasan. Pengecualian: menambah fungsi kecil di `repo.js` diperbolehkan
bila memang perlu — tambahkan di bagian bawah dengan komentar `// [ditambah oleh AGENT X]` dan export-nya.

## 2. Aturan bisnis (spesifikasi pemilik)

- Sumber data: API Shopee (TikTok belum). Info pickup/drop-off/gudang mengikuti data marketplace.
- Gudang: `all` (Semua), `jkt` (Jakarta), `sby` (Surabaya). Mapping `product_location_id` item Shopee → kode gudang lewat setting `warehouses[].location_ids` / `warehouse_ids`. Jika tidak terpetakan: pakai gudang `is_default` **hanya jika** cuma ada 1 gudang dengan location_ids kosong; kalau tidak → `warehouse_code = null` → hold `WAREHOUSE_UNKNOWN` (masuk Perlu Diperiksa).
- Part: `p1` 08:00–10:00 (order kemarin belum diproses + order masuk sampai proses dimulai), `p2` 13:00–14:00 (sisa p1 + order baru), `p3` 15:00–16:00 **hanya Instant/Same Day**; Regular yang terlambat menunggu p1 besok (hold `REGULAR_WAIT_P1` di p3). Auto part: jam WIB < mulai p2 → p1; < mulai p3 → p2; selain itu p3. Selalu bisa override manual. Order sukses tidak boleh diproses ulang (`ALREADY_PROCESSED`).
- Jenis pengiriman: `instant` jika `shipping_carrier` (fallback `checkout_shipping_carrier`) mengandung salah satu `shipping_rules.instant_keywords` (case-insensitive), selain itu `regular`.
- Kategori SKU per item: `tg` (Tempered Glass) / `hg` (Hydrogel) berdasarkan `sku_rules` (cek `model_sku` lalu `item_sku`; mode `token`: kode harus jadi token terpisah oleh `-`, `_`, spasi, `/`, `.`; `contains`; `regex`). Order: semua item tg → `tg`; semua hg → `hg`; ada keduanya → `mix`; ada item tanpa kode / konflik → `review` (hold `SKU_UNKNOWN`).
- Tipe HP: item wajib tipe HP sesuai `sku_rules.require_phone_type` (`all` = semua item tg/hg). Sumber berurutan `phone_type_sources`: `model_name` (dipakai jika tidak kosong dan tidak mengandung `generic_variation_words`), `note`, `message_to_seller`. Jika kosong → hold `PHONE_TYPE_MISSING`, KECUALI sisa waktu ke batas pembatalan (`ship_by_date` − now) < `cancel_rule.threshold_hours` jam → tetap diproses, warning `DEADLINE_EXCEPTION`, flag `tipe_belum_ditulis: true` → PDF diberi tanda besar **TIPE BELUM DITULIS**.
- Status proses order (`proc_status`): `unprocessed` (Belum diproses), `processing` (Sedang diproses), `processed` (Sudah diproses), `failed` (Gagal), `review` (Perlu diperiksa), `cancelled` (Dibatalkan).
- Order Shopee yang diproses: `order_status` ∈ {`READY_TO_SHIP`, `PROCESSED`}. `PROCESSED` = shipment sudah di-arrange (skip ship_order, langsung dokumen). `CANCELLED`/`IN_CANCEL` → proc_status `cancelled` (+ tandai PDF stale jika sudah pernah diproses). `SHIPPED`/`COMPLETED` yang belum pernah diproses lewat app → tidak masuk preview (bukan hold, cukup disembunyikan: `STATUS_NOT_READY`).
- PDF per kategori (p1/p2): instant-tg, instant-hg, instant-mix, regular-tg, regular-hg, regular-mix, + productlist. p3: instant-tg, instant-hg, instant-mix + productlist. Hanya kelompok yang ada ordernya yang dibuat. Filter gudang `all` + `process.all_warehouses_mode='split'` → PDF terpisah per gudang.
- Nama file: `DDMMYYYY-p1-ins-tg-jkt.pdf` (tanggal proses WIB; part p1/p2/p3; ins/reg; tg/hg/mix; jkt/sby/all). Product list: `DDMMYYYY-p1-productlist-jkt.pdf`.
- Isi PDF label: halaman cover (part, jenis pengiriman, kategori, gudang, tanggal proses, jumlah order, marketplace, dibuat oleh) lalu halaman label AWB Shopee; **setiap halaman label diberi stempel marketplace** ("SHOPEE") + order_sn kecil; jika `tipe_belum_ditulis` → stempel merah besar "TIPE BELUM DITULIS". Product List: cover + tabel (marketplace, SKU, nama produk + variasi, jumlah) diurutkan per kategori & SKU, plus total.
- Duplikasi: order yang sudah ada di run sukses → skip `ALREADY_PROCESSED`; order yang `processing` di run lain yang masih jalan → skip `IN_PROGRESS`.
- Riwayat: simpan run (part, gudang, user, waktu, status, ringkasan), run_orders (stage/status/error per order), pdfs, sync_log, activity_log. "PDF berhasil ≠ order sudah dikirim" (tampilkan di UI).
- Perubahan setelah PDF: saat sync, jika order `processed` berubah (`content_hash` beda) atau batal → `pdf_stale=1` pada order + pdf `status='stale'` + reason. UI riwayat menampilkan "PDF tidak sesuai, perlu dibuat ulang" + tombol buat ulang.
- Error API: tampilkan marketplace yang gagal, waktu sync terakhir sukses, tombol coba lagi; **preview memblokir proses** (`blocked`) jika belum pernah ada sync sukses atau sync terakhir gagal DAN user tidak mencentang "tetap proses".
- Pemrosesan order baru vs regenerate PDF adalah run berbeda (`kind: 'process' | 'regenerate'`).

## 3. Bentuk data

### OrderRow (hasil normalisasi Shopee → `repo.upsertOrder`)
```js
{
  order_sn, shop_id, marketplace: 'shopee', order_status, create_time, update_time, pay_time,
  ship_by_date, days_to_ship, shipping_carrier, checkout_shipping_carrier, buyer_username,
  recipient_name, recipient_phone, recipient_address /* string gabungan */, note, message_to_seller,
  cod: bool, total_amount, currency,
  items: [ OrderItem ], packages: [ { package_number, logistics_status, shipping_carrier, item_list } ],
  tracking_number /* dari package_list/get_tracking_number, boleh null */, package_number,
  raw: { ...detail Shopee lengkap }
}
// OrderItem
{ item_id, item_name, item_sku, model_id, model_name, model_sku, qty, price, product_location_id, order_item_id, image_url,
  category /* diisi engine: 'tg'|'hg'|null */, phone_type_required /* engine */, phone_type /* engine: string|null */ }
```
`repo.getOrder()` mengembalikan baris + `items`, `packages`, `phone_type`, `validation`, `overrides` sudah di-parse.

### Derived (engine.classify → `repo.setOrderDerived`)
```js
{ warehouse_code: 'jkt'|'sby'|null, ship_type: 'instant'|'regular', sku_category: 'tg'|'hg'|'mix'|'review',
  items: [OrderItem dengan category/phone_type terisi],
  phone_type: { value: string|null, source: 'model_name'|'note'|'message_to_seller'|null, required: bool, missing: bool },
  validation: { holds: [{code, message}], warnings: [{code, message}], flags: { tipe_belum_ditulis: bool, deadline_hours_left: number|null, needs_review: bool } } }
```
Kode hold: `PHONE_TYPE_MISSING`, `SKU_UNKNOWN`, `WAREHOUSE_UNKNOWN`, `ALREADY_PROCESSED`, `IN_PROGRESS`, `CANCELLED`, `STATUS_NOT_READY`, `REGULAR_WAIT_P1`, `EXCLUDED`, `WAREHOUSE_FILTER` (bukan gudang yang dipilih — tidak ditampilkan sebagai hold, hanya disaring).
Kode warning: `DEADLINE_EXCEPTION`, `DEADLINE_NEAR` (< 12 jam), `NOTE_PRESENT`, `COD`.

### Overrides (koreksi manual staf, `repo.setOverrides`)
```js
{ sku_category?: 'tg'|'hg'|'mix', warehouse_code?: 'jkt'|'sby', excluded?: bool, note?: string, force_process?: bool /* abaikan hold PHONE_TYPE_MISSING/SKU_UNKNOWN */, phone_type?: string }
```
Engine harus menghormati overrides: `sku_category`/`warehouse_code` override menggantikan hasil klasifikasi; `phone_type` override mengisi tipe HP; `force_process` menghapus hold PHONE_TYPE_MISSING & SKU_UNKNOWN (tetap warning); `excluded` → tidak masuk grup (hold `EXCLUDED`, tampil di tab "Dikeluarkan").

### OrderSummary (dikirim ke UI, fungsi `toSummary(order)` ada di `engine/preview.js`, dipakai semua route)
```js
{ order_sn, marketplace, order_status, proc_status, create_time, update_time, ship_by_date, shipping_carrier, ship_type, sku_category,
  warehouse_code, buyer_username, recipient_name, recipient_phone, recipient_address, note, message_to_seller, cod, total_amount, currency,
  items: [{ item_name, model_name, item_sku, model_sku, qty, category, phone_type, image_url }], item_count, qty_total,
  phone_type, validation, overrides, pdf_stale, tracking_number, proc_run_id, processed_at, last_error, deadline_hours_left }
```

### Settings (lihat `src/settings-defaults.js` untuk key & default). `repo.getSettings()` → objek gabungan.

## 4. API modul backend

### `src/shopee/index.js` (AGENT SHOPEE) — `createShopee(deps)` → objek:
```js
const shopee = require('../shopee').create();   // singleton, baca setting dari repo tiap panggilan (partner id/key/transport)
shopee.getAuthUrl({ redirect })                       // string URL auth_partner
shopee.exchangeCode({ code, shop_id })                // -> simpan ke repo.upsertShop, return shop row
shopee.refreshToken(shop_id)                          // -> perbarui token, return shop row
shopee.ensureToken(shop_id)                           // refresh otomatis jika < 15 menit lagi kadaluarsa
shopee.call({ path, method:'GET'|'POST', query:{}, body:{}, shop_id, binary:false })  // low-level, sudah sign + refresh + transport (direct|bridge|mock). return JSON (atau Buffer jika binary). Throw ShopeeError {code, message, request_id, status}
shopee.getShopInfo(shop_id)                           // {shop_name, region, status, ...}
shopee.getWarehouses(shop_id)                         // [{warehouse_id, warehouse_name, location_id, address, ...}]
shopee.fetchOrders({ shop_id, statuses:['READY_TO_SHIP','PROCESSED'], time_from, time_to, time_range_field:'create_time'|'update_time', onProgress })  // -> [OrderRow] (list + detail batch 50, paging, rentang >15 hari dipecah)
shopee.fetchOrderDetails({ shop_id, order_sns })      // -> [OrderRow]
shopee.getShippingParameter({ shop_id, order_sn, package_number })
shopee.shipOrder({ shop_id, order_sn, package_number, pickup, dropoff, non_integrated })
shopee.getTrackingNumber({ shop_id, order_sn, package_number })     // -> string|null
shopee.createShippingDocument({ shop_id, order_list:[{order_sn, package_number, tracking_number, shipping_document_type}] })  // -> {result_list}
shopee.getShippingDocumentResult({ shop_id, order_list:[{order_sn, package_number, shipping_document_type}] })  // -> {result_list:[{order_sn, status:'READY'|'PROCESSING'|'FAILED', fail_message}]}
shopee.downloadShippingDocument({ shop_id, shipping_document_type, order_list:[{order_sn, package_number}] })  // -> Buffer PDF
shopee.arrangeShipment({ shop_id, order_sn, package_number, warehouse /* objek setting gudang */, settings })  // high-level: get_shipping_parameter → pilih pickup/dropoff sesuai process.delivery_method → ship_order. return { method:'pickup'|'dropoff', detail }
shopee.testConnection(shop_id)                        // -> { ok, shop_name, latency_ms } atau throw
shopee.status()                                       // { configured, transport, env, partner_id, shops:[{shop_id, shop_name, status, access_expire_at, refresh_expire_at, authorized_at}] }
```
Transport `mock`: `src/shopee/mock.js` mensimulasikan toko (shop_id 999001, nama "Glass Pro Official (Mock)") dengan ±45 order beragam: gudang jkt/sby (product_location_id 'JKT-001'/'SBY-001' agar user bisa mapping; mock warehouses mengembalikan location_id tsb), kurir instant/regular (GrabExpress Instant, GoSend Same Day, SPX Instant, SPX Standard, J&T Express, JNE Reguler), SKU `TG-IP15PM-CLR`, `HG-SAMS23U-MAT`, `GP-UNIV-PROMO` (tanpa kode → review), variasi berisi tipe HP atau "Universal (tulis tipe di catatan)" dengan/ tanpa note, beberapa dengan ship_by_date < 5 jam, beberapa status PROCESSED/CANCELLED/SHIPPED. Mock harus mendukung seluruh siklus: ship_order mengubah status menjadi PROCESSED + tracking number, create/result/download dokumen mengembalikan PDF label buatan (pdf-lib, ukuran A6 100×150 mm, berisi order_sn, nama penerima, kurir, barcode-ish garis). Mock juga bisa dipakai `exchangeCode` (code apa saja) dan `getAuthUrl` (mengembalikan URL ke `/api/shopee/callback?code=mock&shop_id=999001`).

### Bridge (`src/bridge/router.js`, AGENT SHOPEE)
`POST /bridge/shopee` header `x-bridge-token: <BRIDGE_TOKEN>` body `{ method, path, query, body, binary }` → relay ke `https://partner.shopeemobile.com` (atau test host) → `{ status, content_type, json?, base64? }`. Tolak 401 jika token kosong/salah; 503 jika `BRIDGE_TOKEN` tidak diset. `GET /bridge/ping` → `{ok:true}` (butuh token). Client transport `bridge` memakai `shopee.bridge_url` + `shopee.bridge_token`.

### `src/engine/*` (AGENT ENGINE)
```js
classify.detectShipType(carrier, settings) -> 'instant'|'regular'
classify.categorizeSku(sku, settings) -> 'tg'|'hg'|null|'conflict'
classify.mapWarehouse(locationIds:[], settings) -> 'jkt'|'sby'|null
classify.extractPhoneType(order, item, settings) -> { value, source }
classify.classifyOrder(order /* dari repo.getOrder */, settings) -> Derived (tanpa validation)
validate.validateOrder(order, derived, settings, ctx) -> validation   // ctx: { now, part:'p1'|'p2'|'p3', activeRunOrderSns:Set }
part.currentPart(settings, now) -> { part, label, window:{start,end}, in_window:bool, next:{part,start} }
part.partWindow(settings, part) -> {start,end,label}
naming.pdfFileName({ ts, part, ship_type, sku_category, warehouse_code, kind:'labels'|'productlist' }) -> string
naming.groupKey({ ship_type, sku_category, warehouse_code }) -> 'instant-tg-jkt'
preview.toSummary(order) -> OrderSummary
preview.buildPreview({ part:'auto'|'p1'|'p2'|'p3', warehouse:'all'|'jkt'|'sby', include_processed:false }, ctx) -> Preview   // ctx: { settings, repo, now, activeRunOrderSns }
preview.reclassifyAll(ctx) -> { count }   // jalankan classify+validate untuk semua order belum processed & simpan (repo.setOrderDerived); dipanggil setelah sync dan setelah setting berubah
```
Preview:
```js
{ part, part_auto: {part, in_window, ...}, warehouse, generated_at,
  sync: { ok: bool, last_ok_at, last_at, last_status, last_error, stale: bool /* > 2×interval */ },
  blocked: null | { code:'NO_SYNC'|'SYNC_FAILED'|'NOT_CONNECTED', message },
  totals: { orders, products /* total qty */, by_category:{tg,hg,mix}, by_ship_type:{instant,regular}, by_warehouse:{jkt,sby}, by_marketplace:{shopee}, held, review, excluded },
  groups: [ { key, ship_type, sku_category, warehouse_code, label, file_name, orders:[OrderSummary], qty_total } ],   // urut: instant sebelum regular; tg, hg, mix; jkt, sby
  held: [ { ...OrderSummary, reasons:[{code,message}] } ],       // hold selain SKU_UNKNOWN/EXCLUDED
  review: [ ... ],   // SKU_UNKNOWN / WAREHOUSE_UNKNOWN (Perlu Diperiksa)
  excluded: [ ... ], // overrides.excluded
  product_list: [ { marketplace, sku, item_name, model_name, category, qty, order_count } ] }
```

### `src/engine/pdf.js` (AGENT PDFPROC)
```js
pdf.buildLabelsPdf({ cover:{ part, part_label, ship_type, sku_category, warehouse_code, warehouse_name, date_text, order_count, marketplace:'Shopee', generated_by, generated_at_text, file_name },
                     labels:[{ order_sn, marketplace:'shopee', buffer:Buffer, flags:{ tipe_belum_ditulis } }] }) -> Promise<{ bytes:Uint8Array, page_count }>
pdf.buildProductListPdf({ cover:{...}, rows:[{ marketplace, sku, item_name, model_name, category, qty, order_count }], summary:{ orders, qty } }) -> Promise<{ bytes, page_count }>
pdf.sanitizeText(str) -> string  // ganti karakter di luar WinAnsi agar Helvetica tidak error
```
### `src/engine/process.js` (AGENT PDFPROC)
```js
process.startRun({ part, warehouse, order_sns /* opsional subset */, note, user, ignore_sync_block }, ctx) -> Promise<{ run_id }>   // validasi + buat run + jalankan async (jangan await selesai)
process.getProgress(run_id) -> { run_id, status, stage, done, total, current:{order_sn, stage}, errors:[...], pdfs:[...], finished:bool, started_at, finished_at, summary }
process.regenerate({ run_id, only_failed:bool, pdf_ids:[], user }, ctx) -> Promise<{ run_id }>   // run baru kind 'regenerate', source_run_id
process.cancelRun(run_id) -> bool   // set flag agar berhenti setelah order berjalan selesai
```
Tahapan per order: `queued → shipping (ship_order jika READY_TO_SHIP) → doc_requested → doc_ready → downloaded → merged`, gagal → `failed` + error (order lain lanjut). Pakai `process.concurrency` untuk paralel per order. Simpan progress di memori (Map) + `repo.upsertRunOrder`. Setelah semua order selesai: buat PDF per grup (hanya order sukses), simpan file ke `config.PDF_DIR/<run_id>/<file_name>`, `repo.createPdf`, set `proc_status='processed'`, `processed_at`, `proc_run_id`, `pdf_stale=0` untuk order sukses; `failed` untuk gagal. Run status: `done` (semua ok), `partial` (ada gagal), `failed` (tidak ada yang ok / error fatal). `repo.logActivity`.

### `src/engine/sync.js` (AGENT SYNC)
```js
sync.runSync({ trigger:'auto'|'manual', user }) -> Promise<{ sync_log_id, status, fetched, created, updated, changed_processed:[order_sn], error }>  // guard overlap (kalau sedang jalan, return {already_running:true, sync_log_id})
sync.getStatus() -> { running, enabled, interval_minutes, next_at, last, last_ok, marketplaces:{ shopee:{ connected, status:'ok'|'failed'|'never', last_ok_at, last_error } } }
sync.startScheduler() / sync.stopScheduler()
```
Sync: untuk tiap shop terhubung → `shopee.fetchOrders` status READY_TO_SHIP & PROCESSED (create_time lookback_days) + (jika `include_recent_updates`) update_time 2 hari terakhir semua status (untuk deteksi CANCELLED/SHIPPED) → `repo.upsertOrder` → untuk order berubah yang `proc_status='processed'` → `repo.markOrdersPdfStale` → set `proc_status='cancelled'` bila status CANCELLED/IN_CANCEL → `preview.reclassifyAll`. Catat sync_log. Kegagalan API tidak boleh crash server.

## 5. Route HTTP (semua JSON; error `{error, message, details?}`; 401 jika belum login)

Sudah ada: `POST /api/auth/login {username,password}` → `{user}`; `POST /api/auth/logout`; `GET /api/auth/me` → `{user}`; `POST /api/auth/change-password`; `GET /api/health`.

**/api/shopee** (AGENT SHOPEE): `GET /status` → shopee.status() + `{ last_sync }`; `GET /auth-url` → `{url}` (login wajib); `GET /callback?code&shop_id` (tanpa login; tukar code → redirect `/#/settings?connected=<shop_id>` atau `/#/settings?error=...`); `POST /connect-manual {callback_url|code, shop_id}`; `POST /refresh/:shop_id`; `POST /disconnect/:shop_id`; `POST /test` → testConnection; `GET /warehouses` → live dari Shopee; `GET /shop-info`.

**/api/sync** (AGENT SYNC): `POST /now` → hasil runSync (manual); `GET /status`; `GET /logs?limit`.

**/api/orders** (AGENT SYNC): `GET /?order_status&proc_status&warehouse&ship_type&category&q&page&limit&sort&dir&stale` → `{items:[OrderSummary], total, page, limit, counts}`; `GET /:sn` → `{order:OrderSummary, raw, run_orders:[...], pdfs:[...]}`; `PATCH /:sn/overrides` body Overrides → `{order}` (re-classify + re-validate order itu, simpan); `POST /:sn/reset` (admin; kembalikan ke unprocessed, hapus proc_run_id); `POST /:sn/reclassify`.

**/api/process** (AGENT PDFPROC): `GET /preview?part=auto&warehouse=all` → Preview; `POST /run {part, warehouse, order_sns?, note?, ignore_sync_block?}` → `{run_id}` (409 jika ada run `process` yang masih berjalan); `GET /runs/:id` → `{run, progress, orders:[run_orders + summary], pdfs}`; `GET /runs/:id/progress` → progress ringan (polling 1–2 detik); `POST /runs/:id/regenerate {only_failed?, pdf_ids?}` → `{run_id}`; `POST /runs/:id/cancel`; `GET /active` → `{run_id|null}`.

**/api/history** (AGENT PDFPROC): `GET /runs?page&limit&kind&status` → listRuns; `GET /runs/:id` → sama dengan /api/process/runs/:id; `GET /pdfs/:id/download` → file PDF (Content-Disposition attachment, nama file); `GET /pdfs/:id/view` → inline; `GET /pdfs/recent?limit`; `GET /activity?limit`; `GET /sync-logs?limit`.

**/api/dashboard** (AGENT SYNC): `GET /` → `{ kpis:{ unprocessed, review, held, processed_today, failed, instant_pending, stale_pdf }, sync:getStatus(), shopee:{connected, shop_name}, parts:[{ key, label, start, end, status:'done'|'active'|'upcoming', processed_count, run_ids }], recent_runs:[...5], orders_per_day:[{date, orders, processed}], by_category:{tg,hg,mix,review}, by_ship_type:{instant,regular}, by_warehouse:{jkt,sby,unknown}, recent_activity:[...10] }`.

**/api/settings** (AGENT SYNC): `GET /` → semua setting (`shopee.partner_key` di-mask `shpk****786f` untuk non-admin, admin dapat penuh) + `{ meta:{ warehouses_live:null } }`; `PUT /` body `{ key: value, ... }` (admin; validasi key ada di DEFAULTS; setelah simpan → `preview.reclassifyAll`) → `{settings}`; `GET /users` (admin) ; `POST /users {username,password,name,role}`; `PATCH /users/:id {name,role,active,password}`; `DELETE /users/:id` (tidak boleh hapus diri sendiri).

## 6. Frontend (AGENT UICORE lalu AGENT UI-PAGES)

Routing hash: `#/login`, `#/` (dashboard), `#/process`, `#/orders`, `#/orders/:sn`, `#/history`, `#/history/:runId`, `#/settings`, `#/dev/gallery`.
`public/js/core.js` mengekspor: `api` (`get/post/patch/del(path, body)` → JSON, throw `ApiError{status,code,message,details}`, 401 → redirect `#/login`), `router` (`register(pattern, page)`, `navigate(hash)`, `current()`), `el(tag, attrs, ...children)` pembuat DOM (attrs: class, dataset, on* handler, style objek), `html` (tagged template → DocumentFragment, escape otomatis; `html.raw()` untuk trusted), `store` (state global `{user, settings, sync}` + `subscribe`), `toast.success/error/info/warn(msg)`, `modal.open({title, body:Node|string, actions:[{label, kind, onClick}], size})`, `modal.confirm({title, message, confirmLabel, danger}) -> Promise<bool>`, `fmt` (`date, time, datetime, relative, number, currency, part(p), shipType(t), category(c), warehouse(w), procStatus(s), orderStatus(s)` → label Indonesia), `components` (`statCard({label, value, delta, icon, tone}), badge({text, tone}), table({columns, rows, rowKey, onRowClick, empty}), tabs({items, active, onChange}), emptyState({icon, title, text, action}), skeleton(rows), progressBar({value, max, tone}), pill, avatar, spinner, searchInput, select({options,value,onChange}), pagination({page,total,limit,onChange})`).
Setiap halaman di `public/js/pages/<nama>.js` mengekspor `{ render(container, params, ctx) , destroy?() }` dan mendaftar lewat `router.register`. `layout.js` merender shell (top bar: logo "Glass Pro Suite", nav pill: Overview / Process Order / Pesanan / Riwayat / Pengaturan; kanan: indikator sync (dot hijau/merah + waktu), tombol "Sync", avatar user + menu logout) dan container halaman.

Desain (ikuti referensi dashboard "FINNOVA"): latar `#F4F5FA`, kartu putih radius 20px bayangan lembut, warna utama indigo `#5B5BD6` (hover `#4F46E5`, lembut `#EEF0FF`), panel gelap navy `#1C1E32` untuk daftar (baris terpilih berlatar indigo), panel detail gradien indigo dengan tile kaca (`rgba(255,255,255,.12)`), aksen hijau `#10B981`, kuning `#F59E0B`, merah `#EF4444`, teks `#111827`, muted `#6B7280`, border `#E9EAF2`. Font Inter. Nav pill di top bar gelap bulat. KPI tile dengan ikon bulat dan mini chart (SVG inline sederhana). Token CSS di `public/css/tokens.css` (variabel `--color-*`, `--radius-*`, `--shadow-*`, `--space-*`). Responsif ≥ 1024px penuh, tablet 768 menumpuk, mobile tetap terpakai.

## 7. Konvensi

- Error di route: `throw badRequest('pesan')` dari `src/util/errors.js`; bungkus handler async dengan `wrap()`.
- Logging: `const log = require('../util/log').make('nama')`.
- Test: `test/<modul>.test.js` dengan `node:test` + `node:assert/strict`; gunakan DB sementara: set `process.env.STORAGE_DIR` ke folder temp **sebelum** require modul, atau panggil `require('../src/db').open(path)`.
- Semua string UI dan pesan error: Bahasa Indonesia, sopan, singkat.
- Jangan pernah mencetak partner key/token ke log.
- Semua path file yang diunduh harus divalidasi berasal dari `config.PDF_DIR` (cegah path traversal).
