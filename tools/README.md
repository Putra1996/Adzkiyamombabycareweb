# 🧪 Skrip audit manual

Skrip di folder ini dipakai untuk **audit menyeluruh** terhadap server yang
SEDANG berjalan (bukan unit test). Cocok dipakai sebelum rilis besar atau
setelah mengubah banyak fitur.

## Cara pakai

```bash
# 1) Jalankan server dengan provider AI tiruan (agar audit bisa jalan offline)
DATA_FILE=/tmp/audit.json PORT=3600 \
ADMIN_EMAIL=admin@contoh.id ADMIN_PASSWORD=password-rahasia \
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

Keluaran berupa daftar `OK` / `!!` per pemeriksaan, lalu ringkasan
`Lulus: N | Masalah: M` beserta daftar masalahnya.

## Cakupan

- **audit-integration.js** (86 pemeriksaan): halaman publik, reservasi form
  (validasi harga/jadwal/hari libur), admin CRUD reservasi, kwitansi + link
  publik, rekap & Excel, akunting & pengeluaran, broadcast WA & template,
  CRM/RFM, notifikasi, pengaturan, backup & restore terenkripsi, AI
  (status/config/diagnosa/tes/chat), webhook WA, keamanan token, status
  penyimpanan.
- **audit-features.js** (36 pemeriksaan): impor kwitansi JSON, hapus massal,
  unggahan berkas & TTD pemilik, kategori pengeluaran, CRM tepi, **reservasi
  otomatis dari AI**, webhook WA sungguhan, dan integrasi
  kwitansi → reservasi mirror → rekap.

Catatan: `audit-ai-stub.js` hanya tiruan untuk pengujian (tidak dipakai di
produksi) dan **tidak boleh** menggantikan pengujian dengan API asli.
