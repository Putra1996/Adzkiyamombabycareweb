# 🤖 Panduan Setting AI & Mendapatkan Token WhatsApp

Panduan ini memakai **nama kolom persis** yang ada di panel admin:
**`/admin` → login → ⚙️ Pengaturan → kartu 🤖 AI Booking Assistant**

Ada **dua hal terpisah** di kartu itu:

| Bagian | Untuk apa | Wajib? |
|---|---|---|
| **🔑 API Keys** (Gemini / OpenRouter) | Chat widget AI di beranda + otak auto-reply WhatsApp | Ya, kalau mau AI jalan |
| **📱 WhatsApp Business API** | Auto-reply pesan WhatsApp masuk | Opsional |

> **Penting:** tanpa WhatsApp API, fitur WhatsApp yang sudah ada tetap jalan
> (tombol **💬 Chat**, **📢 Broadcast WA**, **⏰ Ingatkan via WA**) karena memakai
> link `wa.me` — yang butuh token hanya **auto-reply 24/7**.
> Sebaliknya, AI chat widget di beranda **hanya** butuh API key, tidak butuh WhatsApp.

---

## BAGIAN A — Setting AI (5 menit, gratis)

### A1. Ambil kunci Google Gemini (disarankan, ada kuota gratis)

1. Buka **https://aistudio.google.com/apikey** → login dengan akun Google.
2. Klik **Create API key** → pilih project (atau buat baru) → **Create**.
3. **Copy** kuncinya — bentuknya diawali `AIzaSy...`
   (simpan sementara di catatan aman; jangan kirim lewat WhatsApp/email).

### A2. (Opsional) Ambil kunci OpenRouter sebagai cadangan

Berguna kalau kuota Gemini habis — sistem otomatis pindah ke OpenRouter.

1. Buka **https://openrouter.ai** → **Sign in**.
2. Menu **Keys** (https://openrouter.ai/keys) → **Create Key** → beri nama `adzkiya` → **Create**.
3. **Copy** kunci (diawali `sk-or-v1-...`).
   Sebagian model gratis tidak perlu saldo; kalau mau model lebih cepat/berat, isi kredit dulu di menu **Credits**.

### A3. Tempel di panel admin

1. Buka **https://adzkiyamombabycareweb-production.up.railway.app/admin** → login.
2. Sidebar → **⚙️ Pengaturan** → gulir ke kartu **🤖 AI Booking Assistant**.
3. Centang **☑️ Aktifkan AI Assistant**.
4. Tempel kunci di kolom **🤖 Google Gemini API Key** (dan/atau **🌐 OpenRouter API Key**).
5. Klik **💾 Simpan Konfigurasi AI** → tunggu pesan "✅ Tersimpan!".
6. Badge di judul kartu berubah menjadi **🟢 ACTIVE**.
   (Kolom kunci otomatis dikosongkan lagi setelah simpan — itu normal;
   placeholder `•••••••• (set, kosongkan untuk tetap)` menandakan kunci tersimpan.)

### A4. Tes AI

1. Buka beranda **https://adzkiyamombabycareweb-production.up.railway.app**
2. Klik tombol chat 🌸 di kanan bawah → tulis mis. *"halo, harga pijat bayi berapa?"*
3. Balasan muncul dalam beberapa detik. Riwayat percakapan bisa dilihat/dihapus lewat
   tombol **📋 Log Percakapan** di kartu yang sama.

**Mengubah gaya jawaban:** isi kolom **🎭 Custom Persona Prompt**, contoh:

```
Selalu sebut promo paket 7 sesi dan tawarkan jadwal sore.
Jawab maksimal 3 kalimat, ramah, pakai sapaan "Bunda".
```

**Catatan privasi:** 200 percakapan terakhir disimpan untuk konteks & peninjauan
(hanya nama panggilan/pertanyaan pelanggan, tanpa data pembayaran). Hapus kapan saja
dari tombol **🗑️ Hapus Semua Log**.

---

## BAGIAN B — WhatsApp Business API (dapat Phone Number ID + Token)

Butuh: akun Facebook + **Meta Business** (gratis). Nomor WA untuk bisnis sebaiknya
nomor terpisah, karena nomor yang sudah dipakai di aplikasi WhatsApp biasa
tidak bisa langsung dipakai di API.

### B1. Buat App di Meta for Developers

1. Buka **https://developers.facebook.com/apps** → **Create App**.
2. Pilih tipe **Business** → beri nama, mis. `Adzkiya WA Bot` → **Create App**.
3. Di halaman app: **Add Product** → cari **WhatsApp** → **Set up**.

### B2. Ambil Phone Number ID & Access Token (token uji 24 jam)

1. Masuk menu **WhatsApp → API Setup**.
2. Catat **Phone number ID** (deretan angka, mis. `123456789012345`).
3. Di bagian **Access token**, klik **Copy** → itu *temporary token* (berlaku **24 jam**).
   Untuk produksi, ganti ke token permanen di langkah **B5**.
4. Di bagian **To**, tambahkan nomor WA Anda sebagai penerima uji → **verifikasi kode**
   yang dikirim Meta. (Nomor uji Meta hanya boleh mengirim ke nomor terverifikasi.)

### B3. Isi di panel admin

1. Panel → **⚙️ Pengaturan** → **🤖 AI Booking Assistant** → buka **📱 WhatsApp Business API**.
2. Isi:
   - **Phone Number ID** → dari langkah B2
   - **Access Token (permanent)** → tempel token (sementara boleh token 24 jam dulu)
   - **Webhook Verify Token** → ketik string acak **buatan Anda sendiri**, mis.
     `adzkiya-verify-2026-7h3k` (catat, nanti dipakai di Meta)
3. Klik **💾 Simpan Konfigurasi AI**.
4. **Copy nilai di kolom 📍 Webhook URL** (panjangnya seperti
   `https://adzkiyamombabycareweb-production.up.railway.app/api/webhook/whatsapp`).
   URL ini diambil dari server, jadi **jangan mengetik manual**.

### B4. Sambungkan webhook di Meta (supaya pesan masuk diteruskan ke AI)

1. Meta App → **WhatsApp → Configuration**.
2. Bagian **Webhook** → **Edit**:
   - **Callback URL** → tempel nilai Webhook URL dari panel (harus `https://` dan berakhiran `/api/webhook/whatsapp`)
   - **Verify token** → tempel **persis sama** dengan yang Anda isi di panel (huruf besar/kecil & spasi ikut dihitung)
   - Klik **Verify and save** → kalau gagal, ulangi berhati-hati menyalin (lihat troubleshooting)
3. Di bawahnya, bagian **Webhook fields** → **Manage** → centang **messages** → **Subscribe**.
   *(Tanpa langkah ini, pesan masuk tidak pernah dikirim ke server, jadi AI tidak membalas.)*

### B5. Buat token PERMANEN (agar tidak mati tiap 24 jam)

1. Buka **https://business.facebook.com/settings** → **Users → System Users**.
2. **Add** → nama mis. `adzkiya-bot` → role **Admin** → **Create System User**.
3. Klik **Assign Assets** → tab **Apps** → pilih app WhatsApp Anda → aktifkan **Full control** → **Save**.
4. Klik **Generate New Token**:
   - App: pilih app WhatsApp Anda
   - Token expiration: **Never**
   - Centang permission: **`whatsapp_business_messaging`** dan **`whatsapp_business_management`**
   - **Generate Token** → **copy SEKARANG** (nilai ini hanya tampil sekali; kalau hilang harus buat ulang)
5. Tempel token itu di panel → kolom **Access Token (permanent)** → **💾 Simpan Konfigurasi AI**.

### B6. Amankan webhook (App Secret)

1. Meta App → **Settings → Basic** → **App Secret** → **Show** → copy.
2. Tempel di panel → kolom **🔐 App Secret** → **💾 Simpan Konfigurasi AI**.
3. Setelah terisi, setiap request webhook **wajib** membawa tanda tangan `X-Hub-Signature-256`
   yang valid — pesan palsu dari orang lain otomatis ditolak (403).
   Status proteksinya tampil di hasil tes koneksi.

### B7. Verifikasi

1. Panel → kartu AI → klik **🔍 Tes Koneksi WhatsApp**.
   Anda akan melihat checklist 6 poin, contoh hasil sehat:
   - ✅ AI Assistant diaktifkan
   - ✅ Kunci AI tersedia
   - ✅ Webhook Verify Token diisi
   - ✅ Phone Number ID & Access Token WhatsApp diisi
   - ✅ **Kredensial WhatsApp diterima Meta — Terhubung ke nomor +62…**
   - ✅ App Secret diisi (webhook terlindungi)
2. Tes nyata: kirim WhatsApp ke nomor bisnis Anda → AI membalas otomatis
   (butuh **Aktifkan AI Assistant** tercentang + kunci AI terisi).

---

## Troubleshooting cepat

| Yang terlihat | Penyebab & tindakan |
|---|---|
| Tes AI: OpenRouter gagal **402 Insufficient credits** | Wajar bila akun belum beli kredit — sistem otomatis memakai model gratis (`:free`). Untuk model terbaik, tambah kredit di openrouter.ai/credits lalu matikan centang "hanya pakai model gratis". |
| Tes AI: OpenRouter gagal **401** | Kunci salah/dicabut → buat kunci baru di openrouter.ai/keys, tempel ulang di panel. |
| Bot **selalu** menjawab "Maaf, saya sedang gangguan 😅…" | Klik **🤖 Tes AI** di panel AI — pesan galat asli dari Google/OpenRouter akan tampil. Penyebab paling umum: **model AI yang dipakai sudah dihentikan Google** (mis. `gemini-1.5-flash` → 404). Sistem sekarang memilih model otomatis (lihat catatan di bawah), jadi kalau masih gagal biasanya kunci salah atau kuota habis. |
| Panel menampilkan "Kunci Gemini belum diisi" | Isi **🤖 Google Gemini API Key** lalu simpan. Kolom dikosongkan otomatis setelah simpan — itu normal (nilai tetap tersimpan). |
| Badge tetap ⚪ OFF / chat beranda bilang "hubungi admin via WhatsApp" | **Aktifkan AI Assistant** belum dicentang, atau kunci AI belum tersimpan |
| Chat menjawab "AI provider belum dikonfigurasi" | Kunci Gemini/OpenRouter kosong/typo — isi ulang lalu simpan |
| Tes koneksi: **Meta menolak kredensial (code 190)** | Token kedaluwarsa/dicabut → buat token baru (B5) |
| Tes koneksi: **Phone number not registered / belum terverifikasi** | Nomor belum selesai setup di Meta → API Setup → verifikasi nomor |
| Meta: **"The callback URL or verify token couldn't be validated"** | Verify token di Meta ≠ yang di panel, ada spasi/enter tersisa, URL bukan `https://…/api/webhook/whatsapp`, atau belum disimpan di panel sebelum ditekan Verify |
| Pesan WA masuk tapi tidak ada balasan | (a) field **messages** belum di-Subscribe (B4.3), (b) AI Assistant belum aktif, (c) kuota/periode percakapan WhatsApp habis |
| Balasan WA berhenti setelah 24 jam | Anda masih memakai token sementara → ganti ke token permanen (B5) |
| Broadcast WA berhenti/tidak jalan | Broadcast memakai `wa.me`, tidak butuh token — pastikan nomor pelanggan benar saja |

## 🗓️ Jadwal bentrok, 🎟️ paket sesi, ⏰ pengingat otomatis, 📲 PWA

### Jadwal bentrok & jarak antar-jadwal
Bidan tidak bisa hadir di dua rumah pada jam yang sama dan butuh waktu
perjalanan. Sistem kini memeriksanya otomatis saat reservasi dibuat
(form publik, kwitansi, maupun lewat AI).

Atur di **Pengaturan → 🗓️ Penjadwalan & Pengingat**:
- **Durasi 1 sesi (menit)** — default 60
- **Jeda perjalanan antar rumah (menit)** — default 30 (boleh 0 bila sesi
  berurutan di satu rumah)
- **Batas sesi per hari** — default 4 (dipakai juga oleh kalender)
- **Bila jadwal bentrok** → *Izinkan + beri peringatan* (default) atau
  *Tolak* (pelanggan diminta pilih jam lain)

Form reservasi mengambil **jam yang masih kosong** dari `/api/availability`
sehingga pelanggan diarahkan ke slot yang aman. Reservasi yang diberi
peringatan ditandai ⚠️ di panel agar admin mengeceknya.

### Paket sesi & sisa sesi
Layanan paket (mis. *Newborn Care 5 Days*, *Gentle Flow Package (5x)*)
otomatis dibuatkan **catatan paket** saat kwitansi/reservasi dibuat —
termasuk menghitung jumlah sesi dari nama layanan (5 Days → 5 sesi, (7x) → 7).

Buka menu **🎟️ Paket Sesi**: daftar paket aktif, sisa sesi, tombol
**✅ Pakai 1 Sesi** (dengan tanggal & jam), **↩️ Batalkan** bila salah klik,
serta **➕ Tambah Paket Manual** untuk paket yang dibeli di luar sistem.
Jumlah sesi bisa diatur khusus per layanan lewat `settings.package_sizes`.

### Pengingat otomatis
Menu **⏰ Pengingat** menampilkan pengingat yang **jatuh tempo** (default
**24 jam** dan **2 jam** sebelum jadwal; bisa diubah).

- Jika **WhatsApp Business API** sudah dikonfigurasi → pengingat
  **dikirim otomatis** oleh server (dicek tiap 5 menit), dan tidak dikirim
  dua kali untuk jadwal yang sama.
- Jika belum → kirim manual **sekali klik** lewat tombol 💬 (wa.me), lalu
  tandai ✔️ *Sudah dikirim*.

Teks pengingat bisa diubah di Pengaturan, mendukung placeholder
`{nama}`, `{layanan}`, `{tanggal}`, `{jam}`, `{total}`.

### 📲 PWA: bisa dipasang seperti aplikasi + notifikasi
- Pelanggan melihat tombol **⬇️ Pasang App** di beranda (muncul bila browser
  mendukung). Setelah dipasang, situs terbuka seperti aplikasi.
- Panel admin meminta izin notifikasi, lalu **reservasi baru** dan
  **pengingat jatuh tempo** muncul sebagai **notifikasi HP/desktop** walau tab
  tidak sedang dibuka (selama panel pernah dibuka).
- Data API (reservasi, kwitansi, pengaturan) **tidak pernah di-cache** oleh
  service worker — hanya aset statis seperti CSS/JS.

## 📝 Reservasi otomatis dari chat AI

Fitur ini membuat AI **langsung membuat reservasi** setelah percakapan
lengkap — jadi data masuk ke panel admin tanpa calon pasien harus mengisi
form lagi.

**Apa yang dikumpulkan AI (6 data):**
1. Nama lengkap pasien → 2) Nomor WhatsApp → 3) Alamat lengkap →
4) Layanan (harus ada di katalog) → 5) Tanggal `YYYY-MM-DD` → 6) Jam `HH:MM`.

Setelah keenam data lengkap dan pelanggan setuju, AI menutup balasannya
dengan blok data khusus. Server memvalidasi ulang lalu menyimpan reservasi.

**Hasilnya di panel admin:**
- Reservasi muncul di menu **📅 Reservasi** dengan status **pending** &
  pembayaran **unpaid**, lengkap dengan badge **🤖 AI** (berarti dibuat otomatis
  dari chat, bukan dari form publik).
- **🔔 Notifikasi** admin otomatis memberi tahu reservasi baru.
- Catatan reservasi bertuliskan "Dibuat otomatis oleh AI Assistant".
- Admin tinggal konfirmasi jadwal ke pelanggan via WhatsApp.

**Pengaman yang sudah terpasang** (penting, karena ini jalur yang bisa
menyimpan data):

| Pengaman | Perilaku |
|---|---|
| Validasi ulang server | Nama, WhatsApp (9–15 angka), alamat, tanggal & jam (format ketat) wajib benar |
| Harga dari katalog server | Harga/total yang "disebut AI" **diabaikan** — selalu dihitung dari katalog |
| Layanan harus nyata | Nama layanan di luar katalog → ditolak |
| Jadwal dicek | Tanggal lampau & **hari libur (blackout)** ditolak, lengkap dengan alasannya |
| Anti-duplikat | Reservasi sama (nama + tanggal + jam) tidak dibuat dua kali |
| Batas penyalahgunaan | Maksimal **3 reservasi per jam per IP** dan **3 per percakapan** — mencegah pembanjiran data admin |
| Data contoh diabaikan | Bila AI hanya menyalin contoh format, server mengabaikan (tidak membuat reservasi) |
| Blok mentah disembunyikan | Pelanggan tidak melihat teks teknis blok data; yang tampil kartu ringkasan rapi |

**Yang dilihat pelanggan:** setelah data lengkap, muncul **kartu hijau**
berisi nomor reservasi, layanan, jadwal, dan total — plus catatan bahwa admin
akan mengonfirmasi lewat WhatsApp.

**Kalau data belum lengkap**: AI tidak membuat reservasi, tetapi menanyakan
data yang kurang (satu per satu). Pelanggan juga bisa dilayani lewat WhatsApp —
percakapan WA memakai mekanisme yang sama, dan balasannya menambahkan
"✅ Reservasi #… sudah masuk ke sistem kami".

## 💸 OpenRouter tanpa kredit? Tetap bisa dipakai (mode model gratis)

OpenRouter membalas **HTTP 402 "Insufficient credits. This account never
purchased credits."** untuk **semua model berbayar** bila akun belum pernah
membeli kredit. Dulu ini membuat OpenRouter selalu gagal, sehingga tidak bisa
menjadi cadangan Gemini.

Sekarang sistem menanganinya otomatis:

1. **Deteksi 402** → sistem menandai akun ini tanpa kredit dan langsung
   berpindah ke **model gratis** (`:free`) yang tidak berbiaya.
2. **Daftar model gratis diambil dari API OpenRouter** (bukan daftar hardcode),
   disaring (model embedding/moderasi/audio dibuang) dan diberi peringkat
   (keluarga Gemini/Llama/DeepSeek/Qwen/Mistral + konteks besar diutamakan).
   Kalau API tidak bisa diakses, ada daftar cadangan statis.
3. **Mode hemat diingat** sehingga permintaan berikutnya tidak membuang waktu
   mencoba model berbayar. Centang **💸 OpenRouter: hanya pakai model gratis**
   di panel bisa dinyalakan/dimatikan manual.
4. **Pemulihan otomatis 24 jam**: setelah 24 jam, sistem mencoba model berbayar
   sekali lagi — jadi begitu Anda menambah kredit di
   [openrouter.ai/credits](https://openrouter.ai/credits), kualitas model
   terbaik kembali otomatis tanpa perlu mengubah pengaturan.
5. **Kunci salah (401)** dideteksi dan dihentikan cepat (tidak mencoba semua
   model), dengan pesan jelas di panel + saran membuat kunci baru.

**Pembagian tugas yang disarankan** (sudah berjalan otomatis):

| Kondisi | Yang menjawab |
|---|---|
| Normal | **Gemini** (paling cepat, ±0,1–0,7 detik) |
| Gemini lambat (>4 detik) | **OpenRouter** lebih dulu menjawab (hedging) |
| Gemini gagal/kuota habis | **OpenRouter model gratis** mengambil alih |
| Akun OpenRouter punya kredit | OpenRouter memakai model berbayar terbaik |

Catatan: model gratis punya **batas laju lebih ketat** (mis. beberapa
permintaan/menit). Kalau limit tercapai, OpenRouter dicoba ke model gratis
berikutnya; Gemini tetap menjadi penyedia utama sehingga pengunjung jarang
terdampak.

## ⚡ Membuat balasan AI lebih cepat

Ada beberapa hal yang memengaruhi cepat/lambatnya balasan, dan semuanya sudah
diatur otomatis (bisa disesuaikan di panel):

| Pengaturan | Efek |
|---|---|
| ☑️ **Utamakan jawaban cepat** (default aktif) | Memilih model varian **lite** yang lebih responsif dan membatasi jawaban ~2 kalimat. Matikan bila ingin jawaban lebih panjang/detail. |
| Jawaban dibatasi ±2 kalimat | Token keluaran adalah penyumbang waktu tunggu terbesar — jawaban pendek = balasan jauh lebih cepat. |
| **Hedging** dua provider (default aktif) | Bila Gemini belum menjawab dalam ±4 detik, OpenRouter otomatis ikut berjalan dan **yang menjawab lebih dulu** itulah yang dipakai. Pada kasus Gemini lambat, waktu tunggu turun dari ~10 detik menjadi ~0,5 detik. |
| Riwayat percakapan dipangkas (6 pesan terakhir, maks 400 karakter) | Mengurangi token masukan pada setiap pesan sehingga pemrosesan lebih cepat. |
| Timeout 15 detik per model | Model yang menggantung tidak lagi menahan pengunjung sampai 30 detik; kandidat berikutnya langsung dicoba. |
| Pemilihan model otomatis + cache | Model yang berhasil disimpan dan dipakai langsung pada pesan berikutnya (tanpa panggilan tambahan ke API). |
| Balasan dibatalkan bila pengunjung pergi | Kuota tidak terbuang untuk jawaban yang tidak akan dibaca. |

Cara mengukur di sistem Anda: buka **🤖 Tes AI** — di situ ditampilkan
**waktu balasan** (ms) dan model yang dipakai. Nilai wajar: **0,5–2 detik**.
Kalau konsisten di atas 5 detik: cek kuota/kunci provider, lalu coba matikan
"Utamakan jawaban cepat" untuk membandingkan.

Setiap jawaban juga dicatat di **📋 Log Percakapan** lengkap dengan
`provider/model` dan `latensi` (contoh: `[gemini/gemini-flash-lite-latest 850ms]`).

## Catatan penting soal model AI (agar tidak kena masalah yang sama lagi)

Google **menghentikan model lamanya dari waktu ke waktu**. Kasus nyata:
`gemini-1.5-flash` (yang dipakai versi awal sistem ini) dihentikan, sehingga
setiap permintaan dijawab `404 NOT_FOUND` dan bot selalu membalas
"Maaf, saya sedang gangguan 😅. Silakan chat langsung via WhatsApp ya: …".

Sistem sekarang menangani ini otomatis:

1. **Mendeteksi model yang benar-benar tersedia** untuk kunci Anda lewat
   `ListModels`, lalu memilih yang terbaru — contoh: `gemini-3.6-flash`
   mengalahkan `gemini-2.5-flash`; model embedding/gambar tidak pernah dipilih.
2. **Mencoba kandidat berikutnya otomatis** kalau satu model ditolak
   (404 / "no longer available" / 503 karena permintaan tinggi).
3. **Menyimpan model yang berhasil** (terlihat di **🤖 Tes AI** sebagai
   "Model tersimpan") sehingga permintaan berikutnya langsung tepat.
4. **OpenRouter juga mencoba beberapa model** (`google/gemini-2.5-flash`,
   `…-flash-lite`, `google/gemini-2.0-flash-001`, terakhir `openrouter/auto`).

Kalau suatu saat bot berhenti menjawab lagi, urutan pemeriksaannya:
klik **🤖 Tes AI** → baca pesan galat aslinya. Kalau tertulis "model … no
longer available", sistem biasanya sudah otomatis pindah ke model lain;
kalau semua kandidat gagal, biasanya kunci bermasalah/kuota habis — buat
kunci baru lalu simpan lagi.

## Aturan keamanan (penting)

- **Jangan pernah mengirim** API key, Access Token, atau App Secret lewat WhatsApp,
  email, atau chat — kalau pernah bocor, **buat ulang** lalu hapus yang lama.
- Panel **tidak pernah menampilkan** nilai kunci setelah disimpan (hanya tanda
  `•••••••• (set, kosongkan untuk tetap)`). Kosongkan kolom = nilai lama dipertahankan.
- File **backup** sengaja **tidak** memuat kunci AI, token WA, App Secret, TTD pemilik,
  maupun log chat — jadi setelah restore, isi ulang kolom-kolom kunci itu.
- Biaya WhatsApp Cloud API ditentukan Meta (ada kuota gratis terbatas; selanjutnya
  ditagih per percakapan). Cek **WhatsApp → Insights/Pricing** di dashboard Meta
  sebelum dipakai volume besar.

## Ringkasan mengisi panel

| Kolom di panel | Diambil dari |
|---|---|
| 🤖 Google Gemini API Key | aistudio.google.com/apikey |
| 🌐 OpenRouter API Key | openrouter.ai/keys |
| Phone Number ID | Meta App → WhatsApp → API Setup |
| Access Token (permanent) | Meta Business Settings → System Users → Generate Token (expiry **Never**) |
| Webhook Verify Token | **buatan sendiri**, apa saja (string acak) |
| 🔐 App Secret | Meta App → Settings → Basic → App Secret |
| 🔍 Tes Koneksi WhatsApp | tombol verifikasi di panel (cek semua di atas sekaligus) |
| 🤖 Tes AI | tombol uji di panel — mengirim satu pesan uji ke Gemini/OpenRouter dan menampilkan model yang dipakai atau pesan galat aslinya |
