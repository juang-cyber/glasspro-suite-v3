# Glass Pro Suite

Aplikasi web untuk memproses order Shopee Glass Pro: sinkronisasi otomatis dari Shopee Open Platform,
pengelompokan per Part / jenis pengiriman / kategori (TG, HG, Mix) / gudang, validasi tipe HP,
preview + koreksi manual, pembuatan PDF label per kategori (dengan cover dan stempel marketplace),
Product List, serta riwayat proses.

## Fitur utama

- **Sync otomatis** order `READY_TO_SHIP` & `PROCESSED` dari Shopee (tiap 5 menit, bisa manual).
- **Part 1 / 2 / 3** dengan jam WIB (Part 3 khusus Instant/Same Day).
- **Kelompok**: Instant/Same Day & Regular × TG / HG / Mix × Jakarta / Surabaya.
- **Validasi tipe HP** dengan pengecualian batas pembatalan < 5 jam (PDF diberi tanda *TIPE BELUM DITULIS*).
- **Preview & koreksi**: pindah kategori, keluarkan order, catatan, ubah gudang, paksa proses.
- **Proses**: arrange shipment (pickup / drop-off mengikuti Shopee), download label AWB, gabung PDF per kategori dengan cover, Product List.
- **Riwayat**: run, PDF, status per order, log sync, aktivitas user; PDF ditandai *tidak sesuai* bila order berubah/batal; buat ulang PDF gagal.
- **Duplikasi**: order yang sudah sukses tidak diproses ulang.
- **Mode**: `direct` (di VPS yang IP-nya di-whitelist), `bridge` (laptop → jembatan VPS → Shopee), `mock` (demo tanpa Shopee).

## Menjalankan

```
npm install
copy .env.example .env      # sesuaikan
npm start                   # http://localhost:3000
```
Login awal: `ADMIN_USER` / `ADMIN_PASSWORD` dari `.env` (default `admin` / `glasspro123` — segera ganti).

Demo tanpa Shopee: set `SHOPEE_TRANSPORT=mock`, lalu di Pengaturan klik *Hubungkan toko Shopee* (langsung terhubung ke toko simulasi) dan *Sync sekarang*.

Test: `npm test`.

## Deploy ke VPS

Lihat [DEPLOY.md](DEPLOY.md) (Coolify, ± 10 menit).

## Struktur

```
src/            backend Express (shopee/, engine/, routes/, db/)
public/         frontend SPA (vanilla JS + CSS)
docs/           CONTRACTS.md (spesifikasi modul), research/ (catatan API)
storage/        database SQLite + PDF (dibuat otomatis)
```

## Nama file PDF

`DDMMYYYY-p1-ins-tg-jkt.pdf` → tanggal proses, part (p1/p2/p3), ins/reg, tg/hg/mix, jkt/sby.
Product List: `DDMMYYYY-p1-productlist-jkt.pdf`.

## Keputusan yang masih terbuka (bisa diubah di Pengaturan)

- Jam Part 3 (default 15:00–16:00).
- Batas pembatalan: sumber waktu `ship_by_date` Shopee, ambang 5 jam.
- Filter "Semua gudang": PDF dipisah per gudang (`split`) atau digabung (`merge`).
- SKU tanpa kode TG/HG → *Perlu Diperiksa* (aturan pola SKU bisa ditambah).
- Regular yang terlambat di Part 3 menunggu Part 1 hari berikutnya.
