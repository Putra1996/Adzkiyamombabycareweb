# Fitur Baru yang Sudah Di-Deploy & Saran Berikutnya

**Commit:** `69aa821` di `arena/01a02a82-adzkiyamombabycareweb` + `main`
**Status:** ✅ Deployed ke Railway (commit status pending di GitHub, tapi web sudah live dengan semua fitur)

---

## ✅ Yang Berhasil Di-Deploy

### Fitur Baru Besar
1. **📄 Restore Kwitansi dari PDF** — Upload banyak PDF kwitansi Adzkiya, server extract otomatis, admin review & import.
2. **📥 Import Kwitansi dari JSON** — Restore dari backup atau paste JSON dari spreadsheet. Mendukung multi-waktu & multi-tanggal.
3. **🪞 Auto-Sync Kwitansi → Reservasi** — Setiap kwitansi yang dibuat/di-import otomatis dibuatkan "reservasi mirror" (status=approved, payment=lunas) supaya muncul di Rekap Bulanan.
4. **📊 Laporan Keuangan (Range Multi-Bulan)** — Pilih 1/3/6/12 bulan terakhir, breakdown per bulan + ringkasan printable PDF.
5. **🗓️ Multi-Slot Kwitansi (Date+Time)** — Bisa bikin kwitansi untuk beberapa tanggal & jam sekaligus.
6. **🔐 Edit Profil Admin** — Admin bisa ganti email & password sendiri (dengan current password confirmation).
7. **🖼️ Upload Foto Profil Medsos** — Setiap Instagram/TikTok/FB bisa punya foto profil custom (max 500 KB).
8. **📱 Kalender Admin Privat** — Detail reservasi cuma tampil ID ter-mask (#…0042) + item layanan, tanpa nama/HP.
9. **🛡️ Rate Limiting** — Login max 20 attempt/15min/IP, API max 240 req/min/IP. Anti-scripted attack.
10. **🌐 CORS Allowlist** — Optional `ALLOWED_ORIGINS` env untuk lock down cross-origin API.
11. **💾 Backup/Restore Lebih Pintar** — Restore auto-sync kwitansi → reservasi mirror, dedup by patient+date+total.
12. **📊 Excel Multi-Month** — Export XLSX multi-bulan sekarang ada sheet "Ringkasan" di depan + 1 sheet per bulan.
13. **📋 Laporan Keuangan Printable** — Tombol "📑 Laporan" di Rekap membuka layout printable/PDF-ready.
14. **🎨 Chart.js Multi-CDN Fallback** — Kalau CDN utama diblokir, dashboard otomatis fallback ke HTML tables.
15. **🖱️ Touch Detection** — Mobile Safari/Chrome dengan "Situs desktop" toggle tetap render card-mode.

### Mobile UX Improvements (paling penting untuk Bunda di HP)
- Cart-row vertical stack (layanan <select> tidak lagi kepotong)
- Form-row wrap (alamat/nama/HP tidak overflow)
- Stat-grid auto-fit dengan min 140px
- Calendar cells lebih kecil di phone
- Modal max-height 95vh
- Toast max-width pakai calc() supaya tidak overflow di phone kecil
- Bank/social/testi rows stack di mobile
- Invoice printable layout responsive

### Performance & Security
- gzip compression aktif (saves ~70% bandwidth)
- 7-day immutable cache untuk JS/CSS/font
- HTTP security headers (X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS)
- ETag enabled
- Lazy pdf-parse load (kalau broken, tidak crash boot)
- Graceful Postgres fallback ke file mode (kalau Neon down, web tetap hidup)
- Postgres pool capped di 5 conn (aman untuk Neon Free)

---

## 🐛 Bug yang Saya Temukan & Belum Diperbaiki

### Minor (tidak urgent tapi bagus untuk di-fix)

1. **`/api/admin/receipts/import` UX confusing** — Kalau admin paste JSON single receipt (bukan array), server malah ambil `payload.items` sebagai rows karena fallback heuristic. Solusi: tambah clear error message "expected array, got object" di awal.
   - Lokasi: `server.js` line ~1435
   - Severity: Low (admin masih bisa import pakai file backup/array)

2. **`data.json` masih di-track di git index** (waktu ada di remote) — sekarang sudah saya exclude via `.gitignore`. Sudah aman.

3. **Admin login screen belum di-style dark-mode** — kalau admin pakai tema gelap, tombol login masih putih.

4. **Tidak ada `meta name="theme-color"`** di HTML — Safari/Chrome address bar masih default, bukan pink.

5. **Service Worker belum ada** — kalau user offline, web mati total. Bisa tambah basic SW untuk cache homepage + settings + JS bundle.

6. **Cache busting pakai `?v=` masih manual** — Kalau deploy, kadang user dapet JS lama. Belum ada auto-bust (kalau hash dari file ada di query).

---

## 💡 Saran Fitur Lanjutan (Berdasarkan Existing Stack)

### Prioritas Tinggi (paling impactful)

1. **🔍 Search & Filter di Reservasi** — Search by nama/HP, filter by date range, sort by total/tanggal. Saat ini hanya filter status & bayar.

2. **💬 WhatsApp Auto-Reminder Cron** — Kirim WA otomatis H-1 ke pasien via WhatsApp Business API (bukan cuma "Ingatkan via WA" manual dari admin).

3. **📊 Trend Chart dengan Perbandingan** — Dashboard chart omzet 14 hari, tambah line "minggu lalu" untuk trend comparison.

4. **🧾 Digital Signature di Kwitansi** — Bisa minta pasien sign di layar HP (canvas signature) sebelum simpan kwitansi, supaya lebih legal.

5. **📤 Share Kwitansi Link** — Generate tokenized public URL untuk share kwitansi dengan pasien (read-only) tanpa login admin.

### Prioritas Sedang

6. **🔄 Recurring Reservations** — "Pijat laktasi 7x" bisa di-set sekali, otomatis bikin 7 jadwal seminggu sekali.

7. **🏷️ Tag/Kategori di Reservasi** — Bisa tag "VIP", "Paket", "Repeat Customer" untuk segmentasi marketing.

8. **📅 Blackout Dates** — Admin bisa set tanggal "Tidak Bisa Layanan" (misal: hari raya, cuti) — pasien tidak bisa pilih tanggal itu.

9. **💰 Diskon Kode** — Bikin kode voucher (misal "IBUHAMIL20" untuk -20%) yang bisa di-input pasien saat reservasi.

10. **📱 Push Notification (PWA)** — Add manifest.json + service worker supaya pasien bisa "install" web ke home screen & dapat push notif.

### Prioritas Rendah (nice-to-have)

11. **🌙 Dark Mode Toggle Persistence** — Sudah ada toggle tapi belum sync ke localStorage (cek), mungkin sudah ada.
12. **🌐 Multi-Bahasa** — Toggle ID/EN (misal untuk pasien WNA/ekspatriat).
13. **📊 Export PDF langsung dari Rekap** (bukan lewat print browser).
14. **🗂️ Arsip Reservasi Lama** — Auto-archive reservasi > 1 tahun ke tabel terpisah, supaya query lebih cepat.

---

## 🔧 Quick Wins (15 menit each)

- Tambah `meta name="theme-color" content="#ee5a8a"` di semua HTML
- Tambah `meta name="apple-mobile-web-app-capable" content="yes"` untuk iOS fullscreen
- Tambah `aria-label` di icon-only buttons untuk accessibility
- Add `loading="lazy"` ke semua `<img>` di bawah fold (logo hero, dll)
- Add `decoding="async"` ke img supaya tidak block render

---

## ⚠️ Yang Belum Dikerjakan (Sesuai History)

User sebelumnya minta (tapi tidak jadi / di-defer):
- ❌ **Scrape Google Maps untuk auto-sync testimoni** — user bilang "tidak jadi"
- ❌ **Auto-detect pembayaran (Duitku/email-parse/cash 1-klik)** — tetap di-note, belum dikerjakan
- ❌ **Integrasi WhatsApp Business API** untuk notif otomatis — masih pakai toast manual

Kalau user mau salah satu fitur di atas atau punya ide lain, tinggal bilang saja!

---

**File:** `FITUR-DAN-BUG.md` (root repo, bukan di public/ jadi tidak ter-deploy)

## Audit menyeluruh semua fitur (ronde terakhir)

Dijalankan dengan `tools/audit-integration.js` (86 pemeriksaan) dan
`tools/audit-features.js` (36 pemeriksaan) terhadap server yang berjalan —
lihat `tools/README.md`. Hasil akhir: **122 pemeriksaan lulus, 0 masalah**.

### Bug yang ditemukan & diperbaiki
1. **Nomor kwitansi dipakai ulang.** Dulu nomor dihitung dari jumlah kwitansi
   hari itu, jadi setelah satu kwitansi dihapus, kwitansi berikutnya mendapat
   nomor yang sama (mis. `INV-20260922-002` dipakai dua dokumen berbeda).
   Impor/restore yang mendeteksi duplikat lewat `invoice_no` bisa salah
   melewati data sah. Sekarang ada penghitung per hari (`DB.invoice_counters`)
   yang hanya naik, juga menghormati nomor hasil impor/restore, dan tidak
   direset saat "Hapus Semua".
2. **Pesan WhatsApp masuk hilang dari log.** Pencatatan percakapan dilakukan
   setelah pengiriman balasan; kalau pengiriman gagal (token kedaluwarsa atau
   kredensial belum diisi), percakapan pelanggan tidak tercatat sama sekali.
   Sekarang percakapan dicatat lebih dulu, pengiriman dibungkus try/catch,
   kegagalannya dilaporkan ke panel, dan saat kredensial belum lengkap kuota
   AI tidak dibuang (pesan tetap tercatat dengan penanda).

### Bukan bug (sempat dicurigai)
- Pengeluaran bulan lalu tidak muncul di ringkasan P&L 3 bulan — memang
  di luar rentang; pengeluaran bulan berjalan sudah benar mengurangi profit.
- Nomor `INV-...-003` setelah impor `INV-...-010` — berbeda tanggal, jadi
  urutan per hari sudah benar.

## Fitur baru: penjadwalan, paket sesi, pengingat, PWA

Ditambahkan tiga fitur beserta auditnya (`test/scheduling.test.js` 14 tes +
`tools/audit-features.js` bagian [22]).

### Bug yang ditemukan saat pengembangan fitur
1. **Jeda perjalanan tidak bisa diset 0 menit.** `parseInt(nilai) || default`
   mengubah 0 menjadi nilai default (30 menit), sehingga layanan yang
   sesinya berurutan di satu rumah tetap dianggap butuh perjalanan.
   → `schedConf()` memakai `Number.isFinite()` agar 0 dihormati.
2. **Key `notes` duplikat** pada objek reservasi publik (yang kedua menimpa
   yang pertama) → digabung menjadi satu catatan (catatan pelanggan +
   peringatan jadwal bentrok).
3. **False positive di skrip audit:** pengecekan "pengeluaran mengurangi
   profit" memakai tanggal bulan tetap (Desember) sehingga di luar rentang
   P&L. Skrip diperbaiki memakai bulan berjalan (WIB).

### Hasil audit
- Audit menyeluruh: **86 + 49 = 135 pemeriksaan, 0 masalah**.
- `npm test`: 88 lulus (3 dilewati karena jsdom tidak terpasang).


## Fitur baru: Buku Stok & Bahan (bahan habis pakai)

Ditambahkan halaman **📦 Buku Stok** (menu setelah Akunting) beserta auditnya
(`test/stock.test.js` 14 tes + `tools/audit-features.js` bagian [23] +
`tools/audit-integration.js` bagian [14]).

### Yang bisa dilakukan
1. **Barang & sisa stok** — nama, kategori, satuan (pcs/botol/ml/…), batas minimum,
   harga beli, supplier + nomor WA supplier. Stok awal tetap tercatat di riwayat.
2. **Riwayat masuk / keluar / penyesuaian** — setiap perubahan mencatat angka
   sebelum → sesudah, tanggal, catatan, dan (kalau ada) pengeluaran yang tertaut.
   Salah input bisa dibatalkan; pembatalan yang membuat stok minus ditolak.
3. **Sambungan ke uang** — restok bisa sekaligus menjadi Pengeluaran (kategori
   Supplies), jadi P&L otomatis benar. Batalkan restok = pengeluaran itu ikut hilang.
   Pemakaian bahan **tidak** menambah beban baru (sudah dibeli) agar tidak dihitung ganda.
4. **Resep bahan per layanan (HPP)** — bahan per 1 sesi → biaya bahan per sesi.
   Tombol “🧪 Pakai Bahan” mengurangi stok sesuai resep (semua-atau-tidak-sama-sekali)
   dan mencatat HPP, termasuk dari reservasi (sekali klik, anti-dobel).
5. **Peringatan stok menipis** — muncul di dasbor + halaman stok, bisa dikirim
   otomatis via WhatsApp Business API (maks. sekali per 24 jam, bisa diatur)
   atau sekali klik lewat wa.me. Teks pesan bisa diedit.
6. **Daftar belanja** — barang di bawah minimum + saran jumlah (2× minimum − sisa),
   dikelompokkan per supplier, ada tautan WA per supplier dan export Excel
   (sheet Stok, Riwayat, HPP per Layanan).
7. **Laporan HPP & margin per layanan** — omzet layanan (reservasi lunas) vs bahan
   terpakai, bahan per sesi, margin & persennya; plus pemakaian per barang 30 hari
   (terpakai berapa, untuk berapa sesi, per sesi berapa) untuk melihat kebocoran.

### Keputusan desain yang disengaja
- **Stok tidak pernah ditulis langsung.** Semua perubahan (termasuk dari form edit)
  lewat satu pintu `recordSupplyMove()` sehingga selalu ada jejak sebelum → sesudah.
- **Pemakaian bersifat semua-atau-tidak.** Kalau satu bahan kurang, tidak ada stok
  yang berubah dan admin dapat rincian kekurangannya.
- **HPP tidak ditambahkan ke Total Beban.** Pembelian sudah dicatat sebagai
  pengeluaran saat restok; menambahkan HPP lagi akan membuat laba terlihat lebih
  kecil dari sebenarnya. Angka HPP tampil terpisah di Akunting & laporan stok.
- **Restore tidak memulihkan tautan pengeluaran** (`expense_id` dikosongkan) karena
  daftar pengeluaran tidak ikut di file restore — tautan menggantung bisa menghapus
  entri yang salah saat riwayat dibatalkan.

### Hasil audit
- Audit menyeluruh: **96 + 137 = 233 pemeriksaan, 0 masalah**.
- `npm test`: 102 lulus (3 dilewati karena jsdom tidak terpasang; dengan jsdom
  terpasang halaman Buku Stok ikut diuji render penuh di DOM).
- Uji E2E tambahan memakai jsdom **melawan server sungguhan** (bukan fixture):
  24 pemeriksaan, 0 masalah — halaman render, peringatan menipis, resep & HPP,
  pemakaian dari reservasi, riwayat, daftar belanja ke supplier, kartu
  pengaturan stok, dan nol error runtime saat semua aksi dijalankan.
- Dua temuan awal saat menulis skrip audit (bukan bug aplikasi): pencarian barang
  juga menjangkau kategori (kata "lotion"/"minyak" ada di nama kategori bawaan),
  dan pembatalan restok yang sudah terpakai memang harus ditolak — skrip uji
  diperbaiki memakai barang khusus untuk uji pembatalan.

### Bug lain yang ketemu saat audit buku stok (di luar stok, ikut diperbaiki)

1. **Tiga kartu halaman stok tertinggal di tulisan "Memuat…".**
   `isLatestRender()` mensyaratkan token render = `RENDER_SEQ` global, jadi saat
   kartu "Menunggu Pencatatan Bahan", "Resep Bahan", dan "Laporan HPP" dimuat
   bersamaan, hanya kartu terakhir yang lolos pemeriksaan — dua lainnya dibuang
   diam-diam. → ketiga kartu sekarang memakai token halaman stok (satu token),
   tetap otomatis batal bila admin pindah halaman. Ditemukan lewat uji E2E
   jsdom ↔ server sungguhan.

2. **Pendapatan yang sudah diterima bisa hilang dari Rekap & P&L.**
   Bila pelanggan sudah punya reservasi di tanggal itu (mis. booking lewat web),
   lalu dibayar dan dibuatkan kwitansi, `syncReceiptToReservation()` berhenti
   tanpa melakukan apa pun karena "reservasi sudah ada". Karena kwitansi tidak
   dihitung terpisah di ringkasan P&L (dianggap sudah diwakili reservasi mirror),
   uang yang benar-benar diterima tidak muncul di omzet sampai admin menandai
   lunas manual. → kwitansi sekarang menandai reservasi yang cocok menjadi
   **lunas + approved** dan mencatat jejak "Pembayaran diterima via kwitansi
   INV-…" di catatan reservasi. Reservasi berstatus **rejected tidak diubah**,
   dan tidak ada dokumen kedua yang dibuat (`test/api.test.js` + audit [21]).

---

## Audit deployment: vercel.app "banyak fitur yang hilang" (23 September 2026)

Laporan: situs `https://adzkiyamombabycareweb.vercel.app` kehilangan banyak
fitur — kartu layanan kosong, testimoni "Loading reviews…", jam operasional
"Loading…", media sosial kosong, logo mati, reservasi tidak bisa dikirim,
kalender kosong, panel admin & chat AI mati, PWA mati.

### Akar masalah (semuanya terkait deployment, bukan hilangnya kode)

1. **Vercel hanya menyajikan `public/` sebagai situs statis.** Repo tidak punya
   `vercel.json` maupun folder `api/`, dan `server.js` tidak diekspor sebagai
   aplikasi (hanya `app.listen()` di dalam async IIFE) sehingga deteksi Express
   Vercel tidak jalan. Akibatnya SEMUA rute dinamis (`/api/*`, `/health`,
   `/manifest.webmanifest`, `/sitemap.xml`, `/robots.txt`, `/admin`,
   `/kwitansi/*`) balas 404 — backend tidak pernah berjalan di vercel.app.
2. **Backend Railway yang dirujuk `js/api-config.js` sudah mati.** Domain
   `adzkiyamombabycareweb-production.up.railway.app` membalas halaman
   "The train has not arrived at the station" (deployment Railway terakhir
   2026-09-22, status selanjutnya `inactive`). Jadi mirror GitHub Pages pun
   rusak dengan gejala yang sama, dan situs statis Vercel ikut memanggil host
   mati itu.
3. **Kesalahan konfigurasi repo membuat Vercel salah mengira ini proyek
   statis:** ada folder `public/` (konvensi output statis Vercel) tanpa
   kandidat entrypoint yang dikenali.

### Perbaikan deployment

- **`api/index.js`** — entry Vercel Function (Fluid compute): memastikan
  `NODE_ENV=production` terisi di runtime Vercel (tanpa itu SSL Neon mati &
  server jatuh ke mode file), memicu `ensureBooted()` (muat DB + seed admin &
  pengaturan) saat request pertama, lalu meneruskan request ke aplikasi
  Express dari `server.js`.
- **`server.js`** kini bisa dijalankan dua cara: server biasa (Railway/lokal,
  perilaku lama persis sama) dan mode Vercel (`VERCEL=1`: TIDAK `app.listen()`,
  diekspor lewat `module.exports`, boot dipicu manual). Timer latar
  (pengingat, peringatan stok, pemanasan AI) dipisah ke
  `startBackgroundJobs()` yang idempoten. File state mode file di Vercel
  diarahkan ke `/tmp` (filesystem root read-only).
- **`vercel.json`** — rewrite `/api/*`, `/health`, `/manifest.webmanifest`,
  `/sitemap.xml`, `/robots.txt`, `/kwitansi/*`, `/kwitansi-share.html` ke
  function; `/admin` → `/admin.html` (statis) dengan header keamanan
  (X-Robots-Tag noindex, X-Frame-Options DENY, CSP frame-ancestors);
  cache header CSS/JS; cron pengingat `/api/cron/reminders`
  (paket Hobby = 1×/hari; H-2 tepat waktu butuh paket Pro per jam).
- **`public/js/api-config.js`** — memilih API otomatis: vercel.app & localhost
  = same-origin; github.io = API Vercel (bukan lagi Railway yang mati);
  override manual tetap didukung.
- **`kwitansi-share.html`** — fetch kwitansi & logo kini lewat API base
  (sebelumnya path absolut, mati di semua host non-Railway).
- **`build-gh-pages.js` + `docs/`** — mirror GitHub Pages kini membawa
  `kwitansi-share.html`, manifest PWA statis (`docs/manifest.webmanifest`,
  ikon `img/logo.png`, `start_url './'`), `robots.txt` tanpa Sitemap ke host
  mati, dan registrasi service worker relatif (`sw.js`). Blok "embedded data"
  yang mati (penanda `SERVICES_DATA` tidak pernah ada) dihapus.

### Bug serius yang ditemukan & diperbaiki di lapisan data

4. **Multi-instance = reservasi pasien bisa HILANG (last-write-wins).**
   State disimpan sebagai satu blob JSON (`app_state`). Dua instance
   (di Vercel hal ini normal) yang sama-sama menyimpan akan saling menimpa:
   dibuktikan dengan 2 proses + 1 PostgreSQL — reservasi instance A lenyap
   begitu instance B menyimpan (bahkan mendapat ID kembar). Sekarang:
   - tabel `app_state` diberi kolom `rev` (**optimistic locking**): tulisan
     hanya lolos bila revisi masih sama; bila kalah, state terbaru dimuat,
     **digabungkan dengan dedupe** (`mergeTransactionalState`), ID ganda
     dinomori ulang, lalu ditulis ulang (maks 6 percobaan);
   - GET `/api/*` me-refresh state dari DB maksimal sekali per 5 detik agar
     instance tua tetap melihat data terbaru;
   - hasil gabungan dimuat balik ke memori secara in-place (referensi lama
     tetap sah);
   - settings/admin ikut aturan "yang berubah sejak muatan terakhir menang".
   Terkunci oleh `test/pg-multiinstance.test.js` (aktif bila env
   `TEST_PG_URL` diisi; dilewati otomatis tanpa PostgreSQL).

### Bug kecil yang ikut diperbaiki

5. **Batas unggah di Vercel.** Platform membatasi body request 4,5 MB;
   batas server diturunkan otomatis menjadi 4 MB saat `VERCEL` aktif agar
   pengguna menerima pesan jelas dari server, bukan 413 misterius.
6. **`seed-logo.b64` tidak ikut bundle Vercel** (pembacaan `fs` tidak
   ditelusuri Node File Trace) → `/api/logo` bisa 404 di function. Kini ada
   `seed-logo.js` (logo yang sama sebagai modul `require()`, yang pasti
   ditelusuri), plus `includeFiles: "**"` di `vercel.json` untuk file
   statis lain yang dibaca `sendFile`.
7. **Timer level-modul menahan proses test/tool** yang me-`require`
   `server.js` tanpa listen — `setInterval` kebersihan kini `unref()`.
8. **Repo kotor & bocor data lama:** ±1.400 berkas isi `node_modules`
   ter-commit di root repo (glob/, semver/, jszip/, typings/ mysql2, dsb.),
   `data.json` (197 KB) dan `data/app.db*` (SQLite Juni 2026 berisi 1 akun
   admin + 2 reservasi contoh) ter-track walau di-`.gitignore`. Semuanya
   dikeluarkan dari Git; `data.json` dulu dipakai logo oleh build Pages —
   kini logo cukup dari `seed-logo` (docs/img/logo.png tetap ada).

### Verifikasi

- `npm test`: **110 tes — 106 lulus, 0 gagal, 4 dilewati** (3 menunggu jsdom,
  1 menunggu `TEST_PG_URL`).
- Audit menyeluruh: **96 + 137 = 233 pemeriksaan, 0 masalah** (server segar +
  `tools/audit-ai-stub.js`, sesuai `tools/README.md`).
- Uji baru `test/deployment.test.js`: vercel.json menutup semua rute dinamis,
  cron aman Hobby, mode `VERCEL=1` tidak `listen()` saat require dan aplikasi
  penuh (health, katalog, reservasi, login admin, cron, halaman statis)
  berfungsi setelah `ensureBooted()`.
- Simulasi 2 instance + PostgreSQL sungguhan: tulisan A tidak tertimpa B,
  kedua instance melihat kedua reservasi, ID unik, tanpa "save gagal".

### Yang perlu dilakukan pemilik (di luar repo)

- Di Vercel Project Settings → Environment Variables, isi: `DATABASE_URL`
  (wajib), `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, opsional
  `CRON_SECRET`. (`ALLOWED_ORIGINS` TIDAK perlu diisi — lihat bagian
  "Bug CORS" di bawah.)
  Panduan lengkap: `DEPLOYMENT.md` §0.
- **Ganti password admin** bila pernah memakai password lama yang sama dengan
  akun di `data/app.db` yang sempat ter-commit (hash bcrypt password 8 karakter
  umum). Data reservasi di berkas itu adalah data contoh Juni 2026, tetap
  hapus dari riwayat Git bila dianggap sensitif.

## Audit lanjutan: mode zero-config — fitur publik selalu hidup (30 September 2026)

Gejala: setelah PR #5, `https://adzkiyamombabycareweb.vercel.app/api/health`
(dan SEMUA `/api/*`) membalas
`{"error":"Server belum siap ...","detail":"ADMIN_EMAIL dan ADMIN_PASSWORD wajib diisi pada production"}`.
Beranda statis tampil, tetapi katalog, formulir reservasi, kalender, dan
pengaturan publik mati — terlihat seperti "banyak fitur hilang".

### Akar masalah & perbaikan

1. **Boot "wajib env"** — `seedAdmin()` melempar error bila
   `ADMIN_EMAIL`/`ADMIN_PASSWORD` kosong, dan `JWT_SECRET` kosong melempar
   error saat modul dimuat. Sekarang:
   - `JWT_SECRET` berjenjang: env → turunan HMAC `DATABASE_URL` (stabil
     antar instance) → acak per proses. Di Vercel dengan kunci acak, **login
     admin ditutup 503** dengan pesan jelas (token tidak aman antar
     instance) — perilaku yang benar, bukan bug. `JWT_SECRET` yang diisi tapi
     **<32 karakter tetap gagal keras**.
   - `seedAdmin()` tidak pernah mematikan situs: pakai akun admin lama bila
     ada; bila tidak, buat akun **sementara** dengan password acak yang hanya
     tercetak di log deployment. `ADMIN_PASSWORD` <12 karakter diabaikan +
     peringatan. Flag `temporary` hilang setelah password diganti.
2. **MySQL tak terjangkau mematikan boot** (tanpa try/catch, beda dengan
   Postgres) → kini jatuh ke mode file + probe berkala.
3. **SSL dipaksakan ke PostgreSQL lokal** di production → gagal connect lalu
   diam-diam mode file. `pgSslFor()` tidak memaksa SSL untuk host lokal /
   `sslmode=disable`.
4. **`/api/health` tidak ada** (hanya `/health`) → ditambahkan alias, plus
   `warnings`, `admin_login`, `jwt_secret_source`.
5. **Tanpa database, pasien tidak diberi tahu** → respons reservasi memuat
   `storage_warning`, ditampilkan di `public/reservasi.html` &
   `docs/reservasi.html` (di-escape). `schedule_warning` (jadwal berdekatan)
   yang dulu dikirim server tapi tidak pernah ditampilkan kini juga tampil.
6. `api/index.js`: bila `server.js` gagal dimuat (hanya kasus JWT_SECRET
   pendek), balas JSON yang menjelaskan cara memperbaiki — bukan crash
   generik Vercel.

### Bug lain yang ketemu saat audit (ikut diperbaiki)

- **Formulir publik menerima tanggal yang sudah lewat** (`/api/reservations`),
  padahal jalur booking AI menolaknya → kini ditolak 400 menurut tanggal WIB.
- **Panel admin — Rekap:** `loadRecap()` tidak mengecek ulang setelah
  `await` kedua; bila admin pindah halaman saat kwitansi dimuat, muncul
  `TypeError: Cannot set properties of null` (unhandled rejection). Hal sama
  pada kartu error Dashboard (`statGrid`) & Kwitansi (`kwList`). Pesan error
  kini juga di-escape.
- **`test/admin-dom.test.js` tidak pernah selesai** — interval polling
  jsdom menahan proses Node (`node --test` menggantung selamanya bila jsdom
  terpasang); bug Rekap di atas tersembunyi karenanya. Timer kini dilacak
  dan dibersihkan.
- **Tanggal hard-code kedaluwarsa** di `tools/audit-features.js`
  (`2026-09-29` → audit gagal sejak 30 Sep), `tools/audit-integration.js`
  (Desember 2026), dan `test/api.test.js` → diganti tanggal relatif.
- Timer latar (`startBackgroundJobs`) kini `.unref()`.

### Verifikasi

- `node --test test/*.test.js`: **120 tes — 117 lulus, 0 gagal, 3 dilewati**
  (butuh `TEST_PG_URL`). Dengan jsdom + PostgreSQL embedded:
  **120/120 lulus**.
- `TEST_PG_URL=… node --test test/pg-multiinstance.test.js`: **3/3** —
  termasuk uji konflik tulisan **deterministik** (tulisan instance lain
  disuntikkan langsung ke DB; A wajib merge tanpa kehilangan data) dan
  zero-config dengan hanya `DATABASE_URL` (kunci JWT turunan sama antar
  instance, admin sementara dipakai ulang).
- Uji baru `test/vercel-zeroconfig.test.js` (8 tes): tanpa env apa pun
  situs hidup & login 503; admin sementara; akun lama dipakai; password
  pendek tidak mematikan situs; JWT_SECRET pendek tetap gagal keras;
  `pgSslFor`; formulir menampilkan peringatan.
- Audit menyeluruh: **96 + 137 = 233 pemeriksaan, 0 masalah**.

## Bug CORS: "Origin tidak diizinkan" saat login admin di vercel.app (30 September 2026)

Gejala: setelah env `ALLOWED_ORIGINS=https://putra1996.github.io` diisi di
Vercel (mengikuti saran dokumentasi lama), login `/admin` dan kirim
reservasi di `adzkiyamombabycareweb.vercel.app` gagal dengan
`❌ Origin tidak diizinkan` (HTTP 403).

Akar masalah: browser SELALU mengirim header `Origin` pada POST/PUT/PATCH/
DELETE, termasuk permintaan same-origin. Middleware CORS menolak semua
origin yang tidak ada di `ALLOWED_ORIGINS` — termasuk domain situs itu
sendiri.

Perbaikan (`server.js`):
- Permintaan same-origin (host di `Origin` = `Host`/`X-Forwarded-Host`)
  selalu diizinkan.
- Domain deployment Vercel sendiri (`VERCEL_URL`, `VERCEL_BRANCH_URL`,
  `VERCEL_PROJECT_PRODUCTION_URL`) dan GitHub Pages selalu diizinkan walau
  `ALLOWED_ORIGINS` diisi.
- Origin asing tetap ditolak 403.

Solusi instan tanpa deploy kode: hapus env `ALLOWED_ORIGINS` di Vercel lalu
Redeploy (GitHub Pages sudah diizinkan bawaan).

Tes regresi: `test/vercel-zeroconfig.test.js` → "ALLOWED_ORIGINS diisi:
POST same-origin dari situs sendiri TIDAK boleh ditolak 403".

## Audit mendalam: dependensi & XSS (1 Oktober 2026)

### Kerentanan dependensi (`npm audit`: 7 → 0)
- **multer ≤2.3.0 (HIGH)**: 5 advisory DoS / bypass batas upload. Terkena
  langsung karena `POST /api/reservations` (upload bukti) terbuka publik.
  Diperbarui ke **2.4.0**. Uji upload nyata setelah upgrade: PNG valid
  diterima; PNG palsu (isi HTML), SVG, file >5 MB, dan dua file ditolak;
  `/api/proof/:id` tetap wajib token.
- **express 4.22.2 → 4.22.3** (qs 6.16.0, body-parser 1.20.8).
- **ip-address → 10.7.2** (lewat express-rate-limit).
- **brace-expansion**: override lama `minimatch → brace-expansion 1.1.18`
  justru memaksa versi yang rentan DAN salah mayor ke minimatch@5. Diganti
  override `brace-expansion@1 → 1.1.21`; override `readdir-glob` dihapus.
- `engines.node` = `22.x` → peringatan build Vercel soal `>=20` hilang.
- Peringatan `npm warn deprecated` (rimraf@2, glob@7, inflight, fstream,
  lodash.isequal) berasal dari dependensi internal **exceljs 4.4.0** (versi
  terbaru). Tidak berbahaya, bukan kerentanan; hanya hilang bila exceljs
  diganti.

### XSS (ditemukan & diperbaiki)
- **Gambar tersimpan disajikan dengan mime bebas** (`/api/logo`, `/api/hero`,
  `/api/qris`, `/api/social-icon/:idx`): mime berasal dari data yang bisa
  diisi lewat `PUT /api/admin/settings` atau **file backup yang di-restore**.
  `text/html`/`image/svg+xml` → halaman berskrip di origin panel admin
  (token admin di localStorage). Kini mime dipaksa ke PNG/JPEG/WebP/GIF +
  CSP `sandbox`. `/api/proof/:id` juga dibatasi ke gambar/PDF (dibuka lewat
  `blob:` yang mewarisi origin admin).
- **reservasi.html**: pesan error server dimasukkan mentah ke `innerHTML`,
  padahal server memantulkan input (`layanan "<nama>" tidak ada di
  katalog`). Catatan tanggal libur juga mentah. Keduanya di-escape.
- **Beranda (main.js)**: nama/kategori layanan mentah ke `innerHTML` dan
  `onclick="goReserve('…')"` hanya meng-escape `'`. Laten (katalog statis),
  diperbaiki: escape + event listener. Grid tidak crash lagi bila
  `/api/services` mengembalikan objek error (429/500).
- **admin.js**: 4 pesan error mentah ke `innerHTML` → `esc()`.
- `kwitansi-share.html`: `esc()` kini juga meng-escape `'`.
- `/api/health` memperingatkan bila token WhatsApp terisi tetapi App Secret
  kosong (webhook menerima pesan palsu).

### Verifikasi
- Tes baru `test/xss-admin.test.js` (butuh jsdom): server sungguhan + AI
  tiruan yang membeo-kan HTML penyerang; payload lewat formulir reservasi,
  chat AI, dan webhook WhatsApp; SEMUA halaman panel admin + modal log AI
  dirender di jsdom dan diperiksa tidak ada elemen/atribut aktif. Diuji
  tajam: menghapus satu `esc()` / whitelist mime / main.js lama → tes gagal.
- `npm run check` OK; `node --test test/*.test.js`: 125 tes, 122 lulus,
  0 gagal, 3 dilewati; audit 96/0 + 137/0; `npm audit`: 0 kerentanan.

## Kecepatan & audit fitur (1 Oktober 2026)

### Penyimpanan & server (diukur di PostgreSQL lokal, data lama 60 reservasi / 40 bukti 300 KB)

| Ukuran | Sebelum | Sesudah |
|---|---|---|
| Blob state (dibaca/ditulis tiap perubahan) | 16.225 KB | **38 KB** |
| Boot instance | 1.669 ms | 819 ms |
| `/api/calendar` setelah TTL 5 dtk | 190 ms | **21 ms** |
| Buka bukti transfer | 254 ms | 10 ms |
| Tulisan admin (stabil, TERMASUK tulis DB) | 16 ms (belum tersimpan!) | 5–19 ms (sudah tersimpan) |
| `require('server.js')` (cold start) | 332–477 ms | 152–156 ms |

- **Bukti transfer & gambar pengaturan (logo/hero/QRIS) pindah ke tabel
  `app_blobs`**; state hanya menyimpan rujukan (`proof_ref`, `logo_ref`, …).
  Data lama dimigrasikan otomatis saat simpan berikutnya (10 bukti per simpan).
  Mode file tetap inline. Backup tetap memuat gambar (di-inline-kan ulang) dan
  pindah database dari panel membawa bukti + gambar. Gambar lama dibersihkan
  otomatis (> 24 jam, tidak dirujuk).
- **Refresh bacaan** hanya membaca kolom `rev` (0,4 ms); blob diunduh hanya
  bila instance lain benar-benar menulis.
- **Boot tidak lagi menulis ulang seluruh state** di setiap cold start (dulu
  rev naik setiap boot → tulisan sia-sia + semua instance lain mengunduh ulang).
- **Simpan sebelum respons di Vercel** (`PERSIST_BEFORE_RESPONSE`, otomatis di
  Vercel): dulu 201 dikirim lalu simpan menunggu timer 200 ms yang bisa
  dibekukan Vercel → RISIKO data hilang. Kini gagal simpan → 503 (bukan 2xx
  palsu). Webhook WhatsApp memakai `waitUntil` Vercel.
- **Cache CDN Vercel** untuk endpoint publik (`/api/services` 1 hari,
  pengaturan/kalender 10 dtk + stale-while-revalidate, gambar 60 dtk), selalu
  `Vary: Origin`; endpoint admin tetap `no-store`; error tidak di-cache.
- exceljs & mysql2 dimuat saat dipakai saja.
- Konflik tulis: pemindahan gambar ke `app_blobs` tidak dianggap "perubahan
  pengaturan", jadi tidak menimpa pengaturan yang diubah instance lain.

### Frontend
- **Logo bawaan 1024×1280 (145 KB) → 512×640 (21 KB)**; logo lama di
  database otomatis dilayani versi baru. Dimuat di setiap halaman + favicon.
- **Panel admin: Chart.js diunduh DUA KALI** setiap dibuka (skrip cadangan
  inline selalu jalan sebelum skrip utama) dan URL cadangan
  `chart.umd.min.js` tidak ada di paket npm (unpkg 404). Kini dimuat sekali,
  setelah login, dengan SRI; halaman login tidak lagi menunggu CDN.
- **Panel admin: pembukaan 4 langkah berantai → paralel** (stats juga tidak
  diambil dua kali).
- Beranda: Google Fonts tidak memblokir render; `main.js` defer; gambar
  logo `decoding=async`; service worker `adzkiya-v2`.

### Bug yang ditemukan audit fitur (diperbaiki)
1. **GitHub Pages: halaman reservasi tidak berfungsi** — `<script defer>`
   inline diabaikan browser, sehingga basis API dibaca sebelum
   `api-config.js` jalan → layanan dimuat & reservasi dikirim ke
   `github.io/api` (404). Juga race `fmtRp is not defined`.
2. **GitHub Pages: beranda tidak pernah memuat pengaturan** (masalah urutan
   yang sama) dan gambar hero rusak.
3. **Tautan kwitansi kosong/tidak valid macet di "Memuat..."** (`window.t`
   dipanggil sebelum i18n.js dimuat).
4. **Logo 404 di reservasi & panel admin (Vercel)** — `img/logo.png` tidak
   ada di `public/`.
5. **Rating testimoni di luar 1–5 membuat seluruh pengaturan beranda gagal
   dirender** (RangeError) — kini dibatasi 1–5.

### Verifikasi
- Tes baru: `test/perf-storage.test.js` (12; 7 butuh `TEST_PG_URL`) dan
  `test/frontend-perf.test.js` (7; simulasi GitHub Pages di jsdom). Diuji
  tajam: versi lama reservasi/beranda/merge settings → tes gagal.
- `node --test test/*.test.js`: 144 tes, 135 lulus, 0 gagal, 9 dilewati;
  dengan PostgreSQL: perf-storage 12/12 + pg-multiinstance 3/3 (juga dengan
  `PERSIST_BEFORE_RESPONSE=1`); audit 96/0 + 137/0 (dua mode); `npm audit` 0;
  sapuan jsdom semua halaman + 14 menu admin: 0 error runtime.

### Belum diperbaiki (risiko rendah, perlu keputusan)
- ~~Edit yang kalah konflik antar instance hilang~~ dan ~~reservasi yang
  dihapus muncul lagi~~ — **sudah diperbaiki** dengan three-way merge, lihat
  "Audit stabilitas" di bawah.

## Audit stabilitas (1 Oktober 2026)

Diuji dengan: fuzzer semua rute (`tools/audit-robustness.js`, 112 rute,
±2.700 request input rusak + cek integritas data), dua instance pada
PostgreSQL sungguhan, database dimatikan/dibekukan saat server berjalan,
soak 90 detik (20 koneksi paralel), dan simulasi API gagal di semua halaman.

### Crash & hang (diperbaiki)
- **Proses mati saat koneksi database idle diputus** (Neon/Supabase rutin
  melakukannya): pool `pg` tidak punya listener `'error'` → "Unhandled 'error'
  event" → seluruh server mati. Kini koneksi putus dibuang, query berikutnya
  membuka koneksi baru (diuji: koneksi diputus paksa, server tetap hidup).
- **Query database tanpa batas waktu**: koneksi "setengah putus" bisa menahan
  request sampai dibunuh platform. Kini `query_timeout` 20 dtk
  (`PG_QUERY_TIMEOUT_MS`) + TCP keepalive; refresh bacaan menunggu maks 2,5 dtk
  lalu menyajikan dari memori (diuji: semua proses PostgreSQL di-SIGSTOP →
  GET tetap 200, tulisan 503 jelas, pulih otomatis setelah SIGCONT).
- **Error async Express 4** (handler `async` yang melempar) dulu membuat
  request menggantung/proses crash → kini diteruskan ke error handler (500 rapi).
- **Tanpa penanganan level proses**: kini `unhandledRejection` dicatat,
  `uncaughtException` dicatat lalu shutdown rapi; shutdown idempoten dengan
  batas paksa 10 dtk (tidak menggantung).

### Input rusak (diperbaiki — dulu 500 / crash / data rusak)
- JSON rusak → **400**, body terlalu besar → **413** (dulu 500).
- Kwitansi dengan item rusak (`items` bukan daftar, harga teks, qty 0) dulu
  crash atau menyimpan total `NaN` → kini divalidasi (400).
- **Restore backup rusak dengan mode "replace" MENGHAPUS SEMUA DATA lalu
  crash** di elemen `null` → kini divalidasi SEBELUM data diubah.
- Pengaturan bertipe salah (objek di `phone`, teks di `testimonials`/
  `blackout_dates`) tersimpan dan merusak beranda/kalender → kini wajib sejenis
  dengan nilai lama (400); kolom internal `*_ref` tidak bisa ditulis; rating
  testimoni dijepit 1–5; tanggal libur yang tidak valid dibuang.
- Kirim peringatan stok tanpa barang menipis: 500 → 400.

### Integritas data antar instance (diperbaiki)
Merge lama berbasis gabungan (union) tanpa titik acuan. Terbukti di
PostgreSQL dengan dua instance:
- reservasi yang **dihapus hidup lagi**,
- reservasi yang **dipindah jadwalnya menjadi dobel**,
- perubahan dari instance yang kalah konflik **hilang** padahal sudah dijawab
  "berhasil" (juga dua admin mengubah reservasi berbeda bersamaan).

Kini **three-way merge per ID** terhadap isi database yang terakhir dilihat
instance (`syncedBase`): hanya yang berubah sejak itu yang dihitung; dua sisi
mengubah item yang sama → digabung per kolom; hapus vs ubah → yang mengubah
menang (tidak ada data hilang diam-diam); dua item baru dengan ID sama →
keduanya disimpan dan rujukan kwitansi ikut dipindah. Memori juga tidak lagi
ditimpa snapshot lama setelah simpan (perubahan yang masuk SELAMA penulisan
tetap ada). Refresh kini juga berjalan sebelum tulisan (instance basi tidak
menerima booking di slot yang sudah terisi), dan bacaan yang lebih tua dari
rev yang dipegang diabaikan. Hasil uji: 9/9 skenario (hapus, pindah jadwal,
ubah bersamaan, 25 tulisan serentak satu instance, 30 tulisan serentak dua
instance → semua tersimpan tepat sekali, tanpa ID ganda), mode biasa & Vercel.

### Reservasi dobel setelah gangguan (diperbaiki)
Saat database gangguan, pelanggan menerima 503 "belum tersimpan, coba lagi" —
padahal reservasinya tetap tersimpan begitu database pulih. Kirim ulang =
reservasi dobel. Kini kiriman **identik** (nama, WhatsApp, layanan, jadwal)
dalam 30 menit mengembalikan reservasi yang sama (`duplicate: true`), juga di
mode "block" (dulu ditolak karena "bentrok" dengan dirinya sendiri).

### Privasi (diperbaiki)
- **Nama pasien lain bocor ke publik**: saat jadwal bentrok, respons
  `POST /api/reservations` (tanpa login) memuat nama pasien yang sudah booking
  di jam itu (`schedule_warning`, dan di mode "block" seluruh daftar
  `conflicts` berisi nama + ID). Begitu juga teks yang dikirim ke asisten AI
  publik. Kini respons publik tanpa nama/ID; admin tetap melihatnya di catatan.
- Daftar bentrok yang disimpan tumbuh kuadratik di slot ramai (±18 KB per
  reservasi pada uji soak) → dibatasi 10 entri / 5 baris teks.

### Frontend saat API gagal (diperbaiki)
Diuji 5 halaman × 4 mode (jaringan putus, 500, 503 halaman HTML, 200 `null`):
- `reservasi.html` crash (TypeError) bila pengaturan `null` → form mati.
- `kalender.html` diam-diam menampilkan **semua tanggal kosong** saat gagal
  memuat → pelanggan mengira semua jadwal tersedia. Kini muncul peringatan +
  tombol "Coba lagi".
- `kwitansi-share.html` menyebut "link tidak valid/kadaluarsa" saat server
  gangguan dan judul tetap "Memuat kwitansi..." → kini "Server sedang
  gangguan, kwitansi Anda aman" + tombol "Coba lagi".
Hasil: 0 error JavaScript, semua halaman menampilkan pesan yang jelas.

### Memori & beban
Soak 90 dtk (20 koneksi, ±25.500 request campuran publik/admin/booking):
0 error, 0 respons 5xx, server tetap hidup. Bacaan saja (144.000 request):
heap setelah GC tetap 12 MB → **tidak ada kebocoran**. Dengan tulisan, heap
naik sebanding data yang memang bertambah.

### Alat & tes baru
- `tools/audit-robustness.js` — fuzzer semua rute + cek integritas data
  (`node --require ./tools/audit-no-ratelimit.js server.js` lalu
  `BASE=… node tools/audit-robustness.js`); `tools/audit-no-ratelimit.js`
  hanya untuk audit (mematikan rate limit agar fuzzer tidak berhenti di 429).
- `test/stability.test.js` (input rusak, restore, pengaturan, privasi, dedupe),
  `test/merge-threeway.test.js` (8 tes unit merge),
  `test/frontend-resilience.test.js` (jsdom), dan tes PostgreSQL baru di
  `test/pg-multiinstance.test.js`. Diuji tajam: tes frontend gagal 3/3 pada
  versi lama; skenario multi-instance gagal 4/7 pada merge lama.

### Verifikasi
- `npm run check` OK; `node --test test/*.test.js`: 157 tes — 147 lulus,
  0 gagal, 10 dilewati; **dengan PostgreSQL: 157/157 lulus**.
- `tools/audit-integration.js` 96/0, `tools/audit-features.js` 137/0 (server &
  data segar), fuzzer 0 masalah, `npm audit` 0 kerentanan.

