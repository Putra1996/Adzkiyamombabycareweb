# 🧪 Skrip audit manual

Skrip di folder ini dipakai untuk **audit menyeluruh** terhadap server yang
SEDANG berjalan (bukan unit test). Cocok dipakai sebelum rilis besar atau
setelah mengubah banyak fitur.

## Cara pakai

```bash
# 1) Jalankan server dengan provider AI tiruan (agar audit bisa jalan offline)
DATA_FILE=/tmp/audit.json PORT=3600 \
ADMIN_EMAIL=a@b.id ADMIN_PASSWORD=password12345 \
JWT_SECRET=$(printf 'x%.0s' {1..48}) \
node --require ./tools/audit-ai-stub.js server.js

# 2) (opsional) aktifkan AI supaya bagian AI ikut teruji
curl -s -X PUT http://127.0.0.1:3600/api/admin/settings \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"ai_assistant_enabled":true,"ai_gemini_api_key":"AIza-dummy"}'

# 3) Jalankan audit (dua bagian)
BASE=http://127.0.0.1:3600 node tools/audit-integration.js
BASE=http://127.0.0.1:3600 node tools/audit-features.js
```

**Kredensial akun uji:** `a@b.id` / `password12345` (dipakai skrip audit).
Kalau server Anda memakai akun lain, **jangan** ubah skripnya — set env saja:

```bash
BASE=http://127.0.0.1:3600 AUDIT_EMAIL=admin@contoh.id AUDIT_PASSWORD=rahasia \
  node tools/audit-integration.js
```

Dulu README menyuruh membuat akun `admin@contoh.id` sementara skrip login sebagai
`a@b.id`, sehingga audit langsung berhenti dengan "Login gagal".

Jalankan tiap skrip pada **server yang baru di-restart** (batas API 240 permintaan/menit; bila tercapai, skrip menandai pemeriksaan sebagai "dilewati karena rate limit" alih-alih gagal).

Keluaran berupa daftar `OK` / `!!` per pemeriksaan, lalu ringkasan
`Lulus: N | Masalah: M` beserta daftar masalahnya.

## Cakupan

- **audit-integration.js** (107 pemeriksaan): halaman publik, reservasi form
  (validasi harga/jadwal/hari libur), admin CRUD reservasi, kwitansi + link
  publik, rekap & Excel, akunting & pengeluaran, broadcast WA & template,
  CRM/RFM, notifikasi, pengaturan, backup & restore terenkripsi, AI
  (status/config/diagnosa/tes/chat), webhook WA, keamanan token, status
  penyimpanan.
- **audit-features.js** (167 pemeriksaan): impor kwitansi JSON, hapus massal,
  unggahan berkas & TTD pemilik, kategori pengeluaran, CRM tepi, **reservasi
  otomatis dari AI**, webhook WA sungguhan, dan integrasi
  kwitansi → reservasi mirror → rekap.

Catatan: `audit-ai-stub.js` hanya tiruan untuk pengujian (tidak dipakai di
produksi) dan **tidak boleh** menggantikan pengujian dengan API asli.
