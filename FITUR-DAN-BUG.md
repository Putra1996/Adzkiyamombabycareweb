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
- Audit menyeluruh: **96 + 137 = 233 pemeriksaan, 0 masalah** (ronde 1, sebelum merge).
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


## Audit mendalam ronde 2 (setelah PR #3 di-merge ke `main`)

Fokus: seluruh fitur buku stok yang baru, ditambah jalur pemulihan penyimpanan
yang dipakai saat database mati — karena itu jalur yang paling berisiko
kehilangan data produksi.

### 4 bug nyata yang ditemukan & diperbaiki

1. **Salah ketik angka bisa menghapus stok tanpa jejak.**
   `POST /supplies/:id/move` dengan `{type:"adjust", qty:"abc"}` dan
   `PATCH /supplies/:id` dengan `{stock:"abc"}` dijawab **200 sukses dengan stok
   menjadi 0** — nilai bukan angka dibaca sebagai 0 (dan `"  "` juga, karena
   `Number("  ") === 0`). Sekarang ditolak **400** dengan pesan jelas, stok tidak
   berubah, dan `parseNumberInput()` menolak `""`, spasi, `null`, `true/false`,
   array, serta objek.
2. **Harga beli mustahil merusak laporan.** `cost: 1e21` tersimpan apa adanya
   sehingga nilai persediaan, saran beli (2e27), HPP, dan margin mustahil.
   Ditambahkan `clampMoney()` dengan batas **Rp 1 miliar** per satuan (dan
   `Infinity`/`NaN` → 0, bukan angka raksasa).
3. **Resep yang bahannya sudah dihapus dianggap "berhasil".** `POST
   /supplies/use` membalas **200** dengan `total_cost: 0` dan **tanpa perubahan
   stok**, tetapi reservasinya tetap ditandai `stock_applied_at` — jadi setelah
   resep diperbaiki, pemakaiannya tidak bisa dicatat lagi. Sekarang **400**:
   "Resep ... tidak punya bahan tersisa", dan reservasi tidak ditandai.
4. **Daftar tunggu pemakaian bahan memuat booking yang ditolak.** Reservasi
   berstatus `rejected` tetap muncul sebagai pekerjaan, dan sekali klik bisa
   memotong stok untuk kunjungan yang dibatalkan. Sekarang `rejected` dilewati.

### 2 bug serius di jalur pemulihan penyimpanan (Neon/database mati)

Ini jalur yang dipakai saat muncul peringatan "Mode darurat (file)" lalu admin
menekan **⬆️ Sinkronkan Data Darurat ke Database**.

5. **ID bentrok setelah pemulihan.** Salinan memakai ID dari file darurat apa
   adanya, padahal file darurat selalu mulai dari id 1 — sama seperti isi
   database. Akibatnya dua reservasi/kwitansi/pengeluaran berbeda ber-ID sama
   (terbukti: reservasi `1:Pasien Lama` + `1:Pasien Darurat`). Efek nyatanya:
   tombol **Setujui/Tolak/Hapus bisa mengenai data yang salah**, dan pembatalan
   riwayat stok bisa menghapus pengeluaran milik transaksi lain. Sekarang
   **semua** jenis data (reservasi, kwitansi, pengeluaran, broadcast, paket,
   barang, riwayat stok, resep) disalin dengan **ID baru**, dan rujukan
   antar-data dipetakan ulang (termasuk tautan dua arah riwayat stok ↔
   pengeluaran, serta riwayat → reservasi). Riwayat tanpa barangnya dilewati.
6. **Paket sesi tidak ikut dipulihkan.** Sisa sesi yang tercatat selama database
   mati hilang begitu admin menekan Sinkronkan (tidak ada di laporan maupun
   salinan). Sekarang paket ikut disalin (dedupe: pasien + layanan + waktu
   dibuat) dengan rujukan ke kwitansi/reservasi hasil pemulihan, dan jumlahnya
   dilaporkan: "... , N paket sesi, M barang stok".

### Yang diperiksa dan terbukti AMAN (bukan bug)

- **Injeksi HTML (XSS) dari data stok.** Nama `'<img src=x onerror=…>'`, supplier
  `'</div><script>…</script>'`, dan catatan berisi `<iframe>` disimpan server,
  lalu dirender panel: **tidak ada satu pun skrip yang jalan** (5 payload diuji),
  semuanya tampil sebagai teks. `showToast()` juga meng-escape judul & isi.
- **Injeksi formula Excel.** Barang bernama `=1+1` dan `+SUM(A1:A9)` diekspor ke
  Excel sebagai **teks** (tidak ada sel bertipe formula) — tidak bisa dijadikan
  senjata ke akuntan/bank.
- **Hapus pengeluaran restok dari tab Akunting**, lalu batalkan restoknya:
  dibalas `ok: true`, stok kembali, `expense_removed: 0`, dan total beban tidak
  ikut berubah (tidak ada pengeluaran yang salah terhapus).
- **Tanpa token**: 12 endpoint buku stok membalas 401; data stok tidak muncul di
  `/api/public-settings`; endpoint stok tidak menyentuh kredensial.
- **`data.json` di repo publik**: 0 admin, 0 reservasi, 0 kwitansi, 0 data stok,
  tidak ada data sensitif.
- **Rate limit**: seluruh endpoint stok berada di belakang `apiLimiter` global
  (`app.use('/api/', apiLimiter)` dipasang sebelum bagian BUKU STOK).

### Catatan operasional (sengaja, bukan bug)

- **Menghapus barang tidak menghapus pengeluaran restoknya.** Uang benar-benar
  keluar, jadi beban itu tetap tercatat di P&L; yang hilang hanya riwayat stok &
  keanggotaan resep (pesannya menyebutkan ini di konfirmasi panel).
- **Restore dari file backup tidak memulihkan tautan `expense_id`** pada riwayat
  stok (daftar pengeluaran tidak ikut di file restore), supaya "Batalkan" tidak
  menghapus entri yang salah.

### Hasil audit ronde 2

- Audit menyeluruh: **102 + 149 = 251 pemeriksaan, 0 masalah**.
- `npm test`: **107 lulus / 3 dilewati** (jsdom tidak terpasang). Dengan jsdom
  terpasang, halaman Buku Stok ikut diuji render penuh di DOM.
- `test/stock.test.js` bertambah 5 tes (19 total): validasi angka, batas harga,
  resep kosong, ID baru pada pemulihan storage, dan pemulihan berulang.
- E2E jsdom ↔ server sungguhan: **20 pemeriksaan, 0 masalah** (termasuk 5 payload
  injeksi HTML dan validasi angka dari sisi panel).
- Bukti bug disimpan sebagai tes regresi: `parseNumberInput`, `clampMoney`,
  `supplyUsePlan(...).ok`, serta skenario ID bentrok pada `mergeTransactionalState`
  (dua reservasi/kwitansi/pengeluaran ber-ID sama sebelum perbaikan).


## Audit mendalam ronde 3 (lanjutan, setelah ronde 2)

Fokus: perilaku sehari-hari yang belum diuji — barang yang sudah tidak dipakai,
salah ketik jumlah sesi, dan pesan galat yang bisa menyesatkan admin.

### 5 bug/perilaku menyesatkan yang ditemukan & diperbaiki

1. **Field `active` barang tidak dipakai di mana pun.** Barang bisa ditandai
   nonaktif (mis. produk yang sudah tidak dijual lagi), tetapi **tetap** memicu
   peringatan "stok menipis", masuk daftar belanja, dan dihitung di dasbor —
   artinya bot bisa mengirim peringatan WhatsApp tiap 24 jam untuk barang yang
   tidak akan dibeli lagi, tanpa cara mematikannya. Sekarang: peringatan,
   daftar belanja, jumlah "menipis", dan laporan **hanya** memakai barang aktif
   (`lowStockSupplies()`), sedangkan daftar barang tetap menampilkan barang
   nonaktif lengkap dengan badge 🚫 + tombol **♻️ Aktifkan / 🚫 Nonaktifkan**
   (sebelumnya tidak ada cara mengubahnya dari panel sama sekali).
2. **Resep yang masih memuat bahan nonaktif dipakai diam-diam.** Pemakaian bahan
   akan memotong stok barang yang sudah dihentikan. Sekarang ditolak **400**
   dengan menyebut nama barangnya: "Resep ini masih memakai bahan yang sudah
   dinonaktifkan: X. Perbarui resepnya … atau aktifkan lagi barangnya."
   Rencana pemakaian juga menandai bahan nonaktif (`plan.inactive`), dan
   pemilih bahan/resep di panel memberi label "(nonaktif)".
3. **Jumlah sesi `0` / `"abc"` diam-diam menjadi 1 sesi.** HPP & pengurangan
   stok jadi tidak sesuai kenyataan. Sekarang **400**: "Jumlah sesi harus angka
   ≥ 1 (contoh: 1 atau 3)." (Nilai negatif juga ditolak.)
4. **Riwayat lama tanpa angka "stok sebelum" bisa mengosongkan stok.** Tombol
   Batalkan pada riwayat yang tidak menyimpan `before` (mis. hasil impor dari
   sumber lain) dulu menghitung `roundQty(undefined) = 0` sehingga stok barang
   lenyap tanpa peringatan. Sekarang **400** dengan saran memakai "⚖️ Sesuaikan".
   Diverifikasi dengan menyuntikkan riwayat semacam itu ke file data.
5. **Kegagalan pengiriman WhatsApp terbaca sebagai "AI bermasalah".** Catatan
   galat di panel dipakai bersama AI & pengiriman WA, jadi saat token WA
   bermasalah panel menyuruh admin "klik Tes AI untuk menguji ulang" — padahal
   AI-nya sehat. Sekarang galat diberi **sumber** (`ai`, `reminder`,
   `stock_alert`, `stock_order`) dan panel menampilkan label yang tepat:
   "❌ Kegagalan terakhir — 📦 Peringatan stok (WhatsApp)" + arahan ke halaman
   yang benar. Status kesiapan AI tetap `ready` (tidak lagi ikut diragukan).

### Peningkatan harness audit

- Skrip audit kini mengenali **HTTP 429** (batas 240 permintaan/menit) sebagai
  "dilewati karena rate limit", bukan kegagalan — supaya menjalankan dua skrip
  audit beruntun tidak menghasilkan temuan palsu. Cara paling rapi tetap: satu
  server segar per skrip audit.
- Pemeriksaan ronde 2 yang menonaktifkan barang uji kini mengaktifkannya lagi,
  karena sejak ronde 3 barang nonaktif memang tidak memicu peringatan.

### Hasil audit ronde 3

- Audit menyeluruh: **107 + 167 = 274 pemeriksaan, 0 masalah** (masing-masing
  pada server yang baru di-restart).
- `npm test`: **110 lulus / 3 dilewati** (jsdom tidak terpasang).
- `test/stock.test.js`: **22 tes** (3 tes baru: barang nonaktif, resep dengan
  bahan nonaktif, dan sumber galat AI vs WhatsApp).
- E2E jsdom ↔ server sungguhan: **9 pemeriksaan, 0 masalah** — termasuk menekan
  tombol Nonaktifkan/Aktifkan sungguhan lalu memeriksa badge, perubahan tombol,
  hilangnya barang dari daftar peringatan, dan label sumber galat di kartu AI.
- Diverifikasi tidak berubah: XSS data stok (5 payload), injeksi formula Excel,
  hapus pengeluaran lalu batal-restok, 12 endpoint stok 401 tanpa token.
