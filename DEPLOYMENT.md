# 🚀 Panduan Deploy ke GitHub Pages

Website Adzkiya Mom Baby Care sudah dikonversi menjadi **static site** agar bisa di-deploy di GitHub Pages.

## 📁 Struktur File untuk GitHub Pages

Semua file static ada di folder `docs/`:
```
docs/
├── index.html          # Halaman utama
├── reservasi.html      # Form reservasi (kirim via WhatsApp)
├── kalender.html       # Kalender treatment
├── 404.html            # Halaman error
├── css/style.css       # Styling
├── js/main.js          # JavaScript + data embedded
├── img/logo.png        # Logo
└── data/calendar.json  # Data kalender (JSON)
```

## 🌐 Cara Deploy ke GitHub Pages

### Opsi 1: Deploy via Settings (Paling Mudah)

1. Buka repository di GitHub: `https://github.com/Putra1996/Adzkiyamombabycareweb`
2. Masuk ke **Settings** → **Pages**
3. Pada bagian **Source**, pilih:
   - **Branch:** `main` (atau `arena/01a02a42-adzkiyamombabycareweb`)
   - **Folder:** `/docs`
4. Klik **Save**
5. Tunggu beberapa menit, website akan live di:
   `https://putra1996.github.io/Adzkiyamombabycareweb/`

### Opsi 2: Deploy via GitHub Actions (Otomatis)

1. Merge branch ini ke `main`
2. Tambahkan file `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Pages
        uses: actions/configure-pages@v5
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './docs'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

3. Push ke GitHub, dan deployment akan berjalan otomatis.

## 🔄 Cara Update Data

Jika ada perubahan data (layanan, testimoni, jam operasional, dll):

1. Edit file `data.json` di root repository
2. Jalankan build script:
   ```bash
   node build-gh-pages.js
   ```
3. Commit dan push perubahan:
   ```bash
   git add docs/ data.json
   git commit -m "update: perbarui data layanan"
   git push
   ```

## ⚠️ Perbedaan dengan Versi Server

Karena ini versi **static** (tanpa backend), ada beberapa perbedaan:

| Fitur | Versi Server | Versi GitHub Pages |
|-------|-------------|-------------------|
| Reservasi | Disimpan di database | Dikirim via WhatsApp |
| Admin Panel | Tersedia | Tidak tersedia |
| Kalender | Otomatis dari database | Manual (edit `data/calendar.json`) |
| Upload Bukti | Tersedia | Tidak tersedia |
| Testimoni | Editable via admin | Edit via `data.json` |

## 💬 Reservasi via WhatsApp

Form reservasi sekarang mengirim data langsung ke WhatsApp admin (`085887018194`). Pesan yang dikirim berisi:
- Nama pasien
- Nomor WhatsApp
- Alamat
- Daftar layanan + harga
- Jadwal yang diinginkan
- Metode pembayaran
- Total estimasi
- Catatan tambahan

Admin cukup konfirmasi langsung via WhatsApp, tanpa perlu login ke panel admin.

## 📝 Custom Domain (Opsional)

Jika ingin menggunakan domain sendiri (misalnya `adzkiya.com`):

1. Di GitHub: **Settings** → **Pages** → **Custom domain**
2. Masukkan domain Anda
3. Update DNS record domain ke GitHub Pages IP:
   - `185.199.108.153`
   - `185.199.109.153`
   - `185.199.110.153`
   - `185.199.111.153`
