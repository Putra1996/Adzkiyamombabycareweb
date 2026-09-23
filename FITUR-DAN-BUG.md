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
  `CRON_SECRET` & `ALLOWED_ORIGINS=https://putra1996.github.io`.
  Panduan lengkap: `DEPLOYMENT.md` §0.
- **Ganti password admin** bila pernah memakai password lama yang sama dengan
  akun di `data/app.db` yang sempat ter-commit (hash bcrypt password 8 karakter
  umum). Data reservasi di berkas itu adalah data contoh Juni 2026, tetap
  hapus dari riwayat Git bila dianggap sensitif.
