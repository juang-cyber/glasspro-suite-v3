# Panduan Deploy Glass Pro Suite ke VPS (Coolify)

Panel VPS kamu adalah **Coolify** (`https://panel.glassprosuite.tech`). Domain `suite.glasspro.co.id`
sudah mengarah ke IP VPS (147.93.81.145), jadi tinggal daftarkan aplikasi ini di Coolify.
Karena aplikasi jalan langsung di VPS yang IP-nya sudah di-whitelist Shopee, mode `direct` dipakai
(tidak perlu jembatan). Jembatan (`/bridge/shopee`) tetap tersedia kalau nanti mau menjalankan
aplikasi di laptop.

Waktu yang dibutuhkan: ± 10 menit klik-klik.

## 1. Kode sudah ada di GitHub

Repo privat: `https://github.com/juang-cyber/glasspro-suite-v3` (branch `main`).
Coolify butuh akses ke repo privat lewat salah satu cara:

- **GitHub App (disarankan):** Coolify → *Sources* → *+ Add* → *GitHub App* → ikuti wizard
  (install app di akun `juang-cyber`, pilih repo `glasspro-suite-v3`). Dengan ini *Auto Deploy* saat push aktif otomatis.
- **Deploy Key:** Coolify → *Keys & Tokens* → *+ Add* → salin public key → GitHub repo → *Settings → Deploy keys → Add* (read-only).

## 2. Buat aplikasi

1. Coolify → *Projects* → pilih/buat project (mis. `Glass Pro`) → environment `production` → **+ New**.
2. Pilih **Private Repository (with GitHub App)** atau **Private Repository (with Deploy Key)** sesuai langkah 1.
3. Repository: `juang-cyber/glasspro-suite-v3`, branch `main`, pilih server VPS.
4. **Build Pack: `Dockerfile`**. Base Directory `/`, Dockerfile Location `/Dockerfile`.
5. **Ports Exposes: `3000`**. Ports Mappings dikosongkan.
6. **Domains: `https://suite.glasspro.co.id`** (pakai `https://` supaya sertifikat Let's Encrypt dibuat otomatis).
7. Simpan (*Save*).

## 3. Persistent Storage (WAJIB, supaya database & PDF tidak hilang saat redeploy)

*Configuration → Persistent Storage → + Add → Volume Mount*

| Field | Nilai |
|---|---|
| Name | `storage` |
| Source Path | (kosongkan) |
| Destination Path | `/app/storage` |

## 4. Environment Variables

*Configuration → Environment Variables* → tambah satu per satu (jangan centang "Build Variable"):

```
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
STORAGE_DIR=/app/storage
APP_URL=https://suite.glasspro.co.id
SESSION_SECRET=<string acak panjang, mis. hasil: openssl rand -hex 32>
ADMIN_USER=admin
ADMIN_PASSWORD=<password admin pertama>
ADMIN_NAME=Admin Glass Pro
SHOPEE_PARTNER_ID=2010826
SHOPEE_PARTNER_KEY=<Live API Partner Key dari open.shopee.com>
SHOPEE_ENV=live
SHOPEE_REDIRECT_URL=https://suite.glasspro.co.id/api/shopee/callback
SHOPEE_TRANSPORT=direct
BRIDGE_TOKEN=<string acak, hanya perlu kalau mau pakai jembatan dari laptop>
```

Nilai persis untuk akun kamu ada di file lokal `deploy/ENV-COOLIFY.local.txt` (tidak ikut ke git).

## 5. Deploy

Klik **Deploy**. Tunggu log build selesai (± 2–4 menit pertama kali). Health check memakai `/api/health`.
Buka `https://suite.glasspro.co.id` → login dengan `ADMIN_USER` / `ADMIN_PASSWORD`.

## 6. Hubungkan toko Shopee

1. Di aplikasi: **Pengaturan → Koneksi Shopee → Hubungkan toko Shopee**.
2. Login sebagai pemilik toko di halaman Shopee, setujui otorisasi (pilih masa berlaku 365 hari).
3. Shopee mengarahkan kembali ke `https://suite.glasspro.co.id/api/shopee/callback` → status berubah "Terhubung".
4. **Pengaturan → Gudang**: klik *Ambil daftar gudang dari Shopee* lalu petakan gudang Shopee ke Jakarta / Surabaya.
5. Klik **Sync sekarang** → order mulai masuk. Sync otomatis tiap 5 menit.

Catatan: pastikan IP VPS ada di whitelist Shopee (*App → IP Whitelist*). Cek IP keluar container dari tab
*Terminal* di Coolify: `curl -s https://api.ipify.org`.

## 7. Update aplikasi

Setiap `git push` ke `main` → Coolify redeploy otomatis (GitHub App). Tanpa GitHub App: tombol **Redeploy**.

## Menjalankan di laptop (opsional, mode jembatan)

```
copy .env.example .env
```
Isi `.env`: `SHOPEE_TRANSPORT=bridge`, `SHOPEE_BRIDGE_URL=https://suite.glasspro.co.id/bridge/shopee`,
`SHOPEE_BRIDGE_TOKEN=<sama dengan BRIDGE_TOKEN di VPS>`, lalu:

```
npm install
npm start
```
Buka `http://localhost:3000`. Untuk demo tanpa Shopee: `SHOPEE_TRANSPORT=mock`.

## Deploy tanpa Coolify (cadangan)

```
git clone https://github.com/juang-cyber/glasspro-suite-v3 && cd glasspro-suite
cp .env.example .env   # isi nilai
docker compose up -d --build
```
