# Deployment Adzkiya Mom & Baby Care

Aplikasi memakai arsitektur terpisah:

- **Frontend publik + admin:** GitHub Pages dari folder `docs/`
- **API:** Node.js/Express di Render
- **Database:** PostgreSQL terkelola di Render

URL produksi yang diharapkan:

- Website: <https://putra1996.github.io/Adzkiyamombabycareweb/>
- Admin: <https://putra1996.github.io/Adzkiyamombabycareweb/admin.html>
- API: <https://adzkiya-mom-baby-care-api-putra1996.onrender.com>
- Health check: <https://adzkiya-mom-baby-care-api-putra1996.onrender.com/health>

> Admin GitHub Pages tidak menyimpan data sendiri. Login, reservasi, kalender, bukti pembayaran, kwitansi, pengaturan, backup, dan rekap semuanya memakai API dan database yang sama.

## 1. Deploy frontend di GitHub Pages

1. Merge perubahan ke branch `main`.
2. Buka repository **Settings → Pages**.
3. Pilih **Deploy from a branch**.
4. Pilih branch **main** dan folder **/docs**.
5. Simpan dan tunggu deployment Pages selesai.

Folder `docs/` sudah berisi `admin.html` dan konfigurasi API di `docs/js/api-config.js`.

Jika Render memberikan hostname yang berbeda, ubah satu baris berikut lalu deploy ulang Pages:

```js
window.ADZKIYA_API_BASE = 'https://HOSTNAME-API.onrender.com';
```

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

## 6. Keamanan dan operasi

- Jangan commit `ADMIN_PASSWORD`, `JWT_SECRET`, atau `DATABASE_URL`.
- Render hanya menerima CORS dari `https://putra1996.github.io` secara default.
- Jika memakai custom domain Pages, tambahkan origin tersebut ke `ALLOWED_ORIGINS` di Render, dipisahkan koma.
- Upload dibatasi satu file maksimal 5 MB dan hanya menerima PNG, JPEG, WebP, atau PDF yang valid.
- Download backup JSON secara berkala dari menu **Backup/Restore**.
- Pantau log Render dan endpoint `/health` jika admin menampilkan error koneksi.
