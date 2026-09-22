# 🌸 Adzkiya Mom Baby Care

Website reservasi + panel admin untuk layanan home-service ibu & anak
(Nusawungu, Cilacap). Frontend statis, backend Express, data di
PostgreSQL/MySQL (atau file untuk mode darurat).

- **Produksi (API + panel + situs):** https://adzkiyamombabycareweb-production.up.railway.app
- **Cermin GitHub Pages:** https://putra1996.github.io/Adzkiyamombabycareweb/
- **Panel admin:** `/admin` (akun dibuat dari env `ADMIN_EMAIL` / `ADMIN_PASSWORD`)

## 📚 Dokumentasi

| Dokumen | Isi |
|---|---|
| **[PANDUAN-AI-WA.md](PANDUAN-AI-WA.md)** | Cara setting AI (Gemini/OpenRouter) & mendapatkan token WhatsApp Business API |
| [SECURITY.md](SECURITY.md) | Perlindungan data pasien + checklist wajib admin |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploy Railway + GitHub Pages, penanganan penyimpanan |
| [FITUR-DAN-BUG.md](FITUR-DAN-BUG.md) | Catatan fitur, bug, & hasil audit |
| [tools/README.md](tools/README.md) | Skrip audit menyeluruh (233 pemeriksaan) untuk dijalankan sebelum rilis |

## ✨ Fitur

- **Reservasi online** multi-layanan & multi-jadwal, unggah bukti transfer, kalender ketersediaan, hari libur (blackout).
- **Panel admin**: dashboard & grafik, reservasi, notifikasi pengingat, kalender, kwitansi (PDF/cetak), rekap bulanan + export Excel, broadcast WhatsApp, CRM mini (RFM), akunting P&L, pengaturan situs.
- **Kwitansi**: nomor otomatis, multi-sesi, TTD bidan tersimpan, PDF A4/A5/F4/thermal, link kwitansi publik bertoken (30 hari).
- **AI Booking Assistant**: chat widget di beranda + auto-reply WhatsApp (Gemini primary, OpenRouter fallback) lengkap dengan tes koneksi dari panel — lihat [PANDUAN-AI-WA.md](PANDUAN-AI-WA.md).
- **Penjadwalan pintar**: deteksi jadwal bentrok + jeda perjalanan antar rumah, jam kosong otomatis di form.
- **Paket sesi**: pelacakan sisa sesi otomatis untuk layanan 5/7/14 hari dan paket laktasi 3x/5x/7x.
- **Buku stok (bahan habis pakai)**: sisa stok + batas minimum dengan peringatan (panel & WA otomatis), riwayat masuk/keluar tiap barang, restok otomatis masuk Pengeluaran/P&L, resep bahan per layanan → HPP & margin per layanan, daftar belanja ke supplier sekali klik, export Excel.
- **Pengingat otomatis**: H-24 jam & H-2 jam via WhatsApp API (atau kirim sekali klik) + notifikasi HP.
- **PWA**: bisa dipasang di layar utama & menerima notifikasi reservasi.
- **Keamanan**: token admin, rate limit, backup terenkripsi (AES-256-GCM + scrypt), tanda tangan webhook, dan pemulihan penyimpanan — lihat [SECURITY.md](SECURITY.md).

## 🧰 Teknologi

Node.js ≥ 20 · Express 4 · PostgreSQL (`pg`) / MySQL (`mysql2`) · JWT + bcrypt ·
ExcelJS · pdf-parse · frontend vanilla JS (tanpa build step) · Chart.js & jsPDF/html2canvas dari CDN.

## 🚀 Menjalankan lokal

```bash
npm install

# variabel wajib (lihat .env.example)
export ADMIN_EMAIL=admin@contoh.id
export ADMIN_PASSWORD=password-panjang-min-12
export JWT_SECRET=$(printf 'x%.0s' {1..48})   # min. 32 karakter
# opsional: DATABASE_URL=postgresql://... (tanpa ini data disimpan di data.json)
# opsional: DATA_FILE=/data/adzkiya-state.json

npm start            # http://localhost:3000  → panel di /admin
npm test             # uji API + uji tata letak/keamanan panel
npm run build:pages  # sinkronkan public/ → docs/ untuk GitHub Pages
```

## 🔐 Catatan operasional

- **Akun admin** hanya dibuat dari env (`ADMIN_EMAIL`, `ADMIN_PASSWORD`); ganti password
  lewat **Pengaturan → Profil** (semua sesi lama otomatis dicabut).
- **Data permanen butuh `DATABASE_URL`.** Kalau database tidak bisa dihubungi, server masuk
  **mode darurat** (data ke file container) dan panel menampilkan peringatan beserta
  langkah pemulihan — detail di [DEPLOYMENT.md](DEPLOYMENT.md) §5b.
- **Backup berisi data pasien** — selalu pakai tombol **🔐 Backup Terenkripsi**
  (butuh passphrase) dan jangan kirim file polos lewat WhatsApp/email.
- Setelah restore, isi ulang kredensial yang sengaja **tidak** ikut di backup:
  kunci AI, token WhatsApp, App Secret, token verifikasi webhook, TTD pemilik, dan log chat.

## 📄 Lisensi

Lihat [License](License). Proyek internal Adzkiya Mom Baby Care.
