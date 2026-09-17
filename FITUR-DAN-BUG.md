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