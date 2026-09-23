# Deployment Adzkiya Mom & Baby Care

**Produksi saat ini: Vercel** — frontend statis (`public/`) dan API Express
(`api/index.js` membungkus `server.js`) berjalan dalam SATU domain:

- Website & API: <https://adzkiyamombabycareweb.vercel.app>
- Health check: <https://adzkiyamombabycareweb.vercel.app/health>
- Admin: <https://adzkiyamombabycareweb.vercel.app/admin>
- Cermin statis (GitHub Pages, memanggil API Vercel):
  <https://putra1996.github.io/Adzkiyamombabycareweb/>

> Admin GitHub Pages tidak menyimpan data sendiri. Login, reservasi, kalender, bukti pembayaran, kwitansi, pengaturan, backup, dan rekap semuanya memakai API dan database yang sama.

Riwayat: produksi pernah berjalan di Render (blueprint `render.yaml`) lalu
Railway (`…railway.app`) — keduanya sudah tidak aktif. Panduan lama tetap
dibiarkan di bawah sebagai referensi.

## 0. Produksi di Vercel (saat ini)

### 0.1 Cara kerjanya

- `public/` dilayani sebagai situs statis oleh CDN Vercel.
- `vercel.json` me-rewrite `/api/*`, `/health`, `/manifest.webmanifest`,
  `/sitemap.xml`, `/robots.txt`, `/kwitansi/*`, dan `/kwitansi-share.html` ke
  Vercel Function `api/index.js` (path asli dipertahankan, jadi Express di
  `server.js` bekerja persis seperti di Railway).
- `api/index.js` memicu boot (muat database, seed admin & pengaturan) saat
  request pertama, lalu meneruskan request ke aplikasi Express.
- `/admin` di-redirect ke `/admin.html` (statis) dengan header keamanan dari
  `vercel.json → headers`.
- Cron pengingat otomatis: `vercel.json → crons` memanggil
  `/api/cron/reminders` (dilindungi env `CRON_SECRET`).

### 0.2 Environment variables yang WAJIB diisi di Vercel

Project Settings → Environment Variables (semua environment):

| Variabel | Nilai |
|---|---|
| `DATABASE_URL` | Connection string **Postgres/MySQL** (mis. Neon). WAJIB — filesystem Vercel tidak persisten, tanpa ini data hilang. |
| `JWT_SECRET` | Minimal 32 karakter acak (menandatangani token admin & link kwitansi). |
| `ADMIN_EMAIL` | Email login admin. |
| `ADMIN_PASSWORD` | Password awal admin, minimal 12 karakter. Ganti lewat panel setelah login pertama. |
| `ADMIN_NAME` | (opsional) Nama admin. |
| `CRON_SECRET` | (opsional tapi disarankan) Kunci untuk `/api/cron/reminders`; Vercel mengirimkannya sebagai `Authorization: Bearer <nilai>`. |
| `ALLOWED_ORIGINS` | (opsional) Isi `https://putra1996.github.io` bila ingin mengunci CORS untuk cermin GitHub Pages. Same-origin Vercel tidak butuh CORS. |
| `NODEJS_HELPERS` | (opsional) Isi `0` bila terjadi masalah parsing body pada upload/multipart — mematikan "helpers" bawaan runtime Node Vercel. |

### 0.3 Batas platform yang perlu diketahui

- **Body request maks 4,5 MB.** Batas unggah bukti transfer otomatis
  diturunkan menjadi 4 MB saat berjalan di Vercel (`UPLOAD_MAX_BYTES` di
  `server.js`) supaya pengguna menerima pesan server yang jelas, bukan 413.
- **Cron paket Hobby hanya 1×/hari.** Jadwal di `vercel.json`
  (`3 2 * * *` ≈ 09.03 WIB) cukup untuk pengingat H-24, tetapi pengingat H-2
  bisa terlambat beberapa jam. Naik ke paket Pro lalu ubah jadwal menjadi
  per jam untuk pengingat tepat waktu.
- **Waktu eksekusi function** default cukup untuk seluruh endpoint termasuk
  chat AI & export Excel.
- `includeFiles: "**"` pada `vercel.json → functions` memastikan `public/`
  (404.html dsb.) ikut ke dalam bundle function. Bila Vercel menolak properti
  itu di masa depan, hapus barisnya — Node File Trace umumnya sudah
  menelusuri file yang dibaca `server.js`.

### 0.4 Cek kesehatan setelah deploy

1. `GET /health` → `{"ok":true,"storage":"postgres",...}` (bukan `"file"`).
2. `GET /api/services` → katalog layanan terisi.
3. Buka `/` → kartu layanan, testimoni, jam operasional tampil.
4. Buka `/admin` → login dengan `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## 1. Deploy frontend di GitHub Pages

1. Merge perubahan ke branch `main`.
2. Buka repository **Settings → Pages**.
3. Pilih **Deploy from a branch**.
4. Pilih branch **main** dan folder **/docs**.
5. Simpan dan tunggu deployment Pages selesai.

Folder `docs/` sudah berisi `admin.html` dan konfigurasi API di `docs/js/api-config.js`.

`js/api-config.js` memilih API otomatis: origin `github.io` memakai
`https://adzkiyamombabycareweb.vercel.app`, host lain memakai same-origin.
Untuk API lain, override satu baris berikut lalu deploy ulang Pages:

```js
window.ADZKIYA_API_BASE = 'https://HOSTNAME-API.contoh.dev';
```

Setiap kali `public/` berubah, jalankan `npm run build:pages` lalu commit
folder `docs/` (file `manifest.webmanifest` dan `robots.txt` statis untuk
GitHub Pages juga dibuat oleh skrip ini).

## 2. Provision API dan PostgreSQL di Render

File `render.yaml` adalah Render Blueprint yang membuat:

- satu Node web service di region Singapore;
- satu PostgreSQL database terkelola di region Singapore;
- `DATABASE_URL` yang terhubung otomatis;
- `JWT_SECRET` yang dibuat otomatis oleh Render;
- health check `/health`;
- CORS yang hanya mengizinkan origin GitHub Pages.

Buka Blueprint untuk repository ini:

<https://render.com/deploy?repo=https://github.com/Putra1996/Adzkiyamombabycareweb>

Kemudian:

1. Hubungkan akun GitHub jika diminta.
2. Pastikan Blueprint menggunakan branch `main` yang sudah berisi perubahan ini.
3. Isi secret yang diminta:
   - `ADMIN_EMAIL` — email login admin;
   - `ADMIN_PASSWORD` — password awal minimal 12 karakter.
4. Periksa biaya yang ditampilkan Render.
5. Klik **Apply/Deploy Blueprint**.
6. Tunggu database dan web service berstatus **Live**.
7. Buka endpoint `/health`; respons yang benar berbentuk:

```json
{"ok":true,"storage":"postgres"}
```

Blueprint memakai web plan `starter` dan PostgreSQL plan `basic-256mb`. Database berbayar dipilih agar data produksi persisten; database gratis/temporer tidak cocok untuk penyimpanan reservasi jangka panjang.

## 3. Login pertama

Buka:

<https://putra1996.github.io/Adzkiyamombabycareweb/admin.html>

Masuk dengan `ADMIN_EMAIL` dan `ADMIN_PASSWORD` yang diisi di Render. Kredensial tidak disimpan di Git dan tidak boleh ditambahkan ke file frontend.

Admin awal dibuat hanya saat database belum memiliki akun dengan email tersebut. Untuk merotasi password:

1. ubah `ADMIN_PASSWORD` di Render;
2. tambahkan sementara `RESET_ADMIN_PASSWORD=true`;
3. deploy ulang dan pastikan login baru berhasil;
4. ubah `RESET_ADMIN_PASSWORD` kembali menjadi `false` atau hapus variabelnya.

## 4. Alur data produksi

- Form `reservasi.html` mengirim multipart data ke `POST /api/reservations`.
- Harga dihitung ulang dari katalog server; harga dari browser tidak dipercaya.
- Reservasi baru langsung muncul di panel admin.
- Kalender publik membaca reservasi berstatus `approved` dari `/api/calendar`.
- Pengaturan publik, logo, hero, QRIS, rekening, jam, testimoni, dan sosial media dibaca dari API.
- Bukti pembayaran hanya dapat dibuka oleh admin dengan JWT aktif.
- Data aplikasi disimpan sebagai satu state JSON tertransaksi di PostgreSQL. Penulisan diserialkan agar snapshot lama tidak menimpa perubahan baru.

Data fallback tetap tertanam di Pages agar konten dasar tampil saat API sedang restart, tetapi perubahan dan reservasi live memerlukan API Render aktif.

## 5. Pengembangan lokal

Gunakan Node.js 20 atau lebih baru:

```bash
npm ci
ADMIN_EMAIL=admin@adzkiya.id \
ADMIN_PASSWORD='password-lokal-aman' \
JWT_SECRET='secret-lokal-minimal-32-karakter' \
npm start
```

Tanpa `DATABASE_URL`, server memakai `data.json`. Untuk memakai database, isi `DATABASE_URL` dengan URL PostgreSQL atau MySQL/TiDB.

Jalankan pemeriksaan:

```bash
npm run check
npm test
npm run build:pages
```

`npm run build:pages` memperbarui data fallback dan menyalin versi terbaru admin/reservasi ke `docs/`; file `docs/js/api-config.js` tetap menjadi konfigurasi khusus GitHub Pages.

## 5b. Penyimpanan data & pemulihan darurat

`DATABASE_URL` adalah satu-satunya penentu permanen data. Kalau server tidak bisa
menghubungi database, aplikasi tetap hidup tetapi menulis ke file container
(**mode darurat**) — data akan hilang pada deploy berikutnya.

Cek statusnya kapan saja di panel admin → **Pengaturan → 🗄️ Status Penyimpanan**
(atau `/health`: `db_connected` / `db_reachable` / `db_error`).

Kalau muncul mode darurat:

1. **Database masih/ sudah bisa dihubungi?** → **Pengaturan → 🗄️ Status Penyimpanan →
   ⬆️ Sinkronkan Data Darurat ke Database** (menggabungkan, tidak menimpa; akun admin ikut dibawa).
2. **Kredensial berubah/salah?** → di kartu yang sama, klik
   **🔧 Perbaiki / Ganti Koneksi Database** → tempel connection string baru → **🔌 Tes Koneksi**
   (bisa dicoba berulang tanpa deploy, lengkap dengan saran perbaikan) → **✅ Gunakan Sekarang**
   → lalu **salin connection string yang sama ke Railway → Variables → DATABASE_URL** dan deploy
   (langkah ini yang membuatnya permanen).
3. **Belum bisa juga?** → **Backup & Restore → 🔐 Download Backup Terenkripsi** (isi passphrase),
   SEBELUM memperbaiki `DATABASE_URL` — karena memperbaiki env var memicu redeploy yang menghapus
   file darurat. Setelah server hidup dengan database, gunakan **Restore** (mode *Append*).
4. Pastikan Status Penyimpanan kembali hijau (`db_connected: true`).

Alternatif tanpa database: pasang **Railway Volume**, lalu set
`DATA_FILE=/data/adzkiya-state.json` (atau biarkan server memakai `RAILWAY_VOLUME_MOUNT_PATH`
secara otomatis). Data file-mode akan tetap ada antar deploy.

## 6. Keamanan dan operasi

- Jangan commit `ADMIN_PASSWORD`, `JWT_SECRET`, atau `DATABASE_URL`.
- Render hanya menerima CORS dari `https://putra1996.github.io` secara default.
- Jika memakai custom domain Pages, tambahkan origin tersebut ke `ALLOWED_ORIGINS` di Render, dipisahkan koma.
- Upload dibatasi satu file maksimal 5 MB dan hanya menerima PNG, JPEG, WebP, atau PDF yang valid.
- Download backup JSON secara berkala dari menu **Backup/Restore**.
- Pantau log Render dan endpoint `/health` jika admin menampilkan error koneksi.
