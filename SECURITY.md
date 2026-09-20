# 🔐 Keamanan & Kerahasiaan Data — Adzkiya Mom Baby Care

Dokumen ini merangkum **data apa yang disimpan**, **bagaimana dilindungi**,
dan **apa yang wajib dilakukan admin** supaya data pasien tidak bocor.

---

## 1. Data apa saja yang tersimpan

| Data | Isi | Sifat |
|---|---|---|
| `admins` | email, nama, **hash bcrypt** password (12 rounds) | Rahasia |
| `reservations` | nama pasien, nomor WhatsApp, alamat, layanan, jadwal, bukti transfer (base64) | **Pribadi (PII)** |
| `receipts` | nama, WhatsApp, alamat, rincian layanan, total | **Pribadi (PII)** |
| `expenses` | pengeluaran operasional | Internal |
| `broadcasts` | template pesan + daftar penerima | **Pribadi (PII)** |
| `settings` | profil usaha, rekening bank, QRIS, jam buka, TTD pemilik, kredensial AI/WA, log percakapan AI | Rahasia + publik (sebagian) |
| `share_tokens` | token tautan kwitansi (masa berlaku 30 hari) | Rahasia |

Prinsip yang dipakai: **data pribadi pasien hanya keluar lewat endpoint ber-token admin.**
Yang boleh publik hanya: katalog layanan, profil usaha, jam buka, tesimoni, rekening/QRIS
(memang perlu untuk transfer), dan tautan kwitansi bertoken.

---

## 2. Perlindungan yang sudah terpasang

**Autentikasi & sesi**
- Login dibatasi 3 lapis: rate limit per IP (20/15 menit), per akun (8 kegagalan/15 menit),
  dan `express-rate-limit` umum.
- JWT HS256, masa berlaku 12 jam; algoritma diverifikasi eksplisit (mencegah *algorithm confusion*).
- Token otomatis **dicabut** saat password/email diganti, dan mati bila akun admin dihapus.
- Password admin minimal 12 karakter (env) / 10 karakter (ganti lewat panel).
- Hash bcrypt cost 12; hash warisan ber-cost rendah otomatis di-upgrade saat login berikutnya.

**Endpoint**
- 100% endpoint `/api/admin/*` dan `/api/proof/:id` wajib token — diuji otomatis setiap `npm test`.
- Kunci AI (Gemini/OpenRouter), token WhatsApp, dan App Secret **tidak pernah** dikirim ulang ke
  klien — hanya flag `has_*`.
- `password_hash` tidak pernah ikut di respons login/profil.
- Kwitansi publik memakai token HMAC 132-bit, kedaluwarsa 30 hari, dan timestamp-nya tidak bisa
  diperpanjang (dimodifikasi → langsung ditolak).
- Tanda tangan pemilik tidak lagi punya endpoint publik (mencegah pemalsuan kwitansi);
  hanya bisa diambil dengan token admin, atau tampil inline di kwitansi milik pasien.

**Backup & pemulihan data**
- Backup bisa diunduh terenkripsi (AES-256-GCM, kunci dari scrypt + passphrase admin) sehingga file
  yang tersimpan di cloud/USB tidak bisa dibaca orang lain. Restore menolak passphrase salah
  (tag GCM) dan menolak file yang diubah.
- Server mendeteksi sendiri kalau database tidak bisa dihubungi, menampilkan banner + kartu status,
  mengecek ulang koneksi tiap menit, dan menyediakan tombol sinkronisasi yang **menggabungkan**
  data darurat ke database (tanpa menimpa data lama, tanpa menyentuh pengaturan aplikasi).
- Panel admin bisa menguji kredensial database **sebelum** dipakai (tes koneksi + saran perbaikan),
  memakai koneksi baru untuk sesi berjalan tanpa redeploy, dan memperingatkan bahwa koneksi itu
  belum permanen sampai disalin ke variabel environment.
- Akun admin selalu ikut dipindahkan saat berpindah penyimpanan; proses dibatalkan bila hasilnya
  akan menyisakan database tanpa akun admin (mencegah admin terkunci dari panelnya sendiri).
- Koneksi database dari panel tidak pernah ditulis ke disk, log, atau respons API; nilai yang
  tampil di UI hanya nama database/user yang aktif.

**Privasi di log & header**
- Log webhook WhatsApp hanya menulis nomor bertopeng (`6281****6789`) + panjang pesan — tanpa isi pesan.
- `/health` menyamarkan kredensial/nama user/host database.
- `/admin`, `/api/admin/*`, `/api/auth/*`: `X-Frame-Options: DENY` + `frame-ancestors 'none'`
  (anti-clickjacking) dan tidak diindeks mesin pencari.
- Halaman kwitansi & API publik receipt: `X-Robots-Tag: noindex, nofollow, noarchive`
  dan `Cache-Control: private, no-store`.
- Respons admin tidak pernah masuk cache browser/proxy (`no-store`).
- Header keamanan dasar: `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy`, HSTS di produksi.

**Penyalahgunaan & integritas data**
- Form reservasi publik dibatasi 12 kiriman/15 menit per IP (mencegah spam + penggembungan database
  dari unggahan bukti transfer).
- Endpoint AI dibatasi 20 pesan/menit; harga layanan selalu dihitung ulang dari katalog server.
- Unggahan diverifikasi dari magic bytes (bukan hanya `Content-Type`).
- `PUT /api/admin/settings` menolak key `__proto__`/`constructor`/`prototype` dan membatasi ukuran total.
- File backup (`/api/admin/backup`) tidak memuat kredensial apa pun, tanda tangan pemilik, log chat pasien,
  maupun foto bukti transfer — hanya data operasional yang memang diperlukan untuk restore.
- Respons login & profil hanya memuat `id/email/name/role` (tanpa hash password).
- Webhook WhatsApp memverifikasi `X-Hub-Signature-256` (HMAC-SHA256) bila App Secret diisi.

---

## 3. ✅ Yang WAJIB dilakukan admin (checklist)

1. **Ganti password admin sekarang.** Riwayat commit repo pernah memuat hash password bawaan
   (`admin123`). Hash itu masih tersimpan di riwayat Git publik, jadi password lama harus dianggap bocor.
   → Panel admin → **Pengaturan → Profil → Password Baru** (min. 10 karakter). Semua sesi lama otomatis logout.
2. **Pastikan database tersambung.** Buka panel admin → **Pengaturan → 🗄️ Status Penyimpanan**
   (atau `/health`):
   - `db_connected: true` → aman, data tersimpan di database.
   - `db_connected: false` → **MODE DARURAT**: data baru HANYA ada di file container dan hilang saat deploy.

   **Prosedur pemulihan (pilih salah satu, urutannya penting):**

   *Jalur cepat — database sudah bisa dihubungi lagi (tanpa redeploy):*
   1. **Pengaturan → 🗄️ Status Penyimpanan → ⬆️ Sinkronkan Data Darurat ke Database.**
      Proses ini *menggabungkan* (bukan menimpa) data darurat ke isi database, ikut membawa akun admin,
      dan **tidak** menyentuh pengaturan aplikasi (nama usaha, rekening, TTD, kunci AI) agar konfigurasi
      yang sudah benar di database tidak tertimpa.

   *Jalur perbaikan kredensial — kredensial database salah/berubah:*
   1. **Pengaturan → 🗄️ Status Penyimpanan → 🔧 Perbaiki / Ganti Koneksi Database**:
      tempel connection string baru (dari Neon/Railway/Supabase) → **🔌 Tes Koneksi**.
      Anda bisa mencoba berkali-kali di sini **tanpa deploy**; setiap kegagalan disertai saran perbaikan
      (password salah, host tidak ditemukan, SSL, dll). Kalau password memuat karakter `@ : / ? #`,
      pakai kolom terpisah supaya tidak perlu di-encode manual.
   2. Kalau tes berhasil → **✅ Gunakan Sekarang**: server langsung pindah ke database itu dan
      data darurat otomatis digabungkan (akun admin ikut dibawa supaya Anda tidak terkunci).
   3. **Langkah wajib terakhir:** salin connection string yang sama ke
      **Railway → Variables → DATABASE_URL**, lalu deploy, supaya otomatis terpakai lagi setelah restart.

   *Jalur cadangan — kalau kedua cara di atas belum bisa:*
   1. **Backup & Restore** → isi passphrase → **🔐 Download Backup Terenkripsi**
      (wajib dilakukan SEBELUM memperbaiki env var, karena memperbaiki env var memicu redeploy
      yang menghapus file darurat).
   2. Perbaiki `DATABASE_URL` di Railway → redeploy.
   3. **Backup & Restore** → pilih file tadi → **Restore** (mode *Append*) → masukkan passphrase.

   Data juga aman tanpa database bila Railway Volume dipasang: server otomatis memakai
   `RAILWAY_VOLUME_MOUNT_PATH` sebagai lokasi file state, sehingga data tetap ada antar deploy
   (status "Mode file persisten"). Set alternatifnya: `DATA_FILE=/data/adzkiya-state.json`.
   Peringatan di panel admin otomatis menyesuaikan: merah = data bisa hilang, kuning = aman tapi
   sebaiknya pakai database. Peringatan bisa ditutup, tapi muncul lagi setelah 24 jam selama
   kondisinya belum benar-benar aman.
3. **Isi `ALLOWED_ORIGINS`** di Railway (mis. `https://adzkiyamombabycareweb-production.up.railway.app,https://putra1996.github.io`)
   atau biarkan kosong — default hanya origin GitHub Pages repo ini yang diizinkan.
4. **Aktifkan App Secret WhatsApp** (Meta → Settings → Basic → App Secret) lalu isikan di
   Pengaturan → AI Assistant → App Secret, supaya webhook tidak bisa dipalsukan orang lain.
   Setelah itu klik **🔍 Tes Koneksi WhatsApp** di panel yang sama: muncul checklist berisi
   status tiap kredensial, hasil tes langsung ke Meta (nomor WhatsApp mana yang terhubung),
   dan URL webhook yang benar untuk di-paste ke Meta.
5. **Pakai backup TERENKRIPSI** (menu **Backup & Restore** → isi passphrase →
   **🔐 Download Backup Terenkripsi**). Isi file tidak bisa dibaca tanpa passphrase (AES-256-GCM + scrypt),
   jadi aman disimpan di cloud/USB. Simpan passphrase di tempat terpisah — **file tidak bisa dipulihkan
   bila passphrase hilang**. Tombol "JSON polos" hanya untuk keperluan teknis (isinya teks biasa berisi
   seluruh data pasien) — pakai sesedikit mungkin dan jangan pernah dikirim lewat WhatsApp/email.
   Yang **tidak** ikut di file backup mana pun (harus diisi ulang setelah restore):
   kunci AI, token WhatsApp, App Secret, token verifikasi webhook, gambar tanda tangan pemilik,
   log percakapan AI, dan foto bukti transfer.
6. **Rotasi kunci AI** (`Gemini`/`OpenRouter`) bila pernah dikirim lewat chat/screenshot.
7. **Kelola akses Railway** seketika (log Railway bisa memuat metadata operasional);
   batasi anggota workspace hanya yang benar-benar perlu.

---

## 4. Cara memeriksa sendiri

```bash
npm test            # termasuk 17 endpoint admin harus 401 + uji anti-bocor PII
curl -s https://<domain>/health     # cek storage & koneksi DB
```

Uji manual cepat (harus **404**): `GET /api/owner-signature`
Uji manual cepat (harus **401**): `GET /api/admin/reservations` tanpa header Authorization.

---

## 5. Melaporkan masalah

Bila mencurigai kebocoran: ganti password admin segera (itu otomatis mencabut semua token),
rotasi kunci AI/WA, cek daftar reservasi & kwitansi untuk aktivitas asing, lalu unduh backup
untuk arsip sebelum melakukan perubahan besar.
