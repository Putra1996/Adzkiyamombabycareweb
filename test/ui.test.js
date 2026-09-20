// Tes regresi TATA LETAK (tanpa browser).
//
// Latar belakang: tombol .btn berbentuk pil (border-radius: 999px). Saat
// label panjang dipaksa masuk ke ruang sempit (mis. flex:1 pada layar HP),
// teks membungkus jadi 2–3 baris dan tampak menonjol keluar dari bentuk
// tombol — persis bug "Simpan Konfigurasi AI" di panel AI.
//
// Tes ini mengunci perbaikan tersebut supaya tidak bisa hilang tanpa
// disadari: aturan CSS wajib ada, dan markup tidak boleh lagi memakai
// kombinasi berbahaya (.btn + gaya flex:1/width:100% tanpa pelindung).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const css = read('public/css/style.css');
const adminJs = read('public/js/admin.js');

test('CSS: tombol tidak bisa lagi meluber keluar bentuknya', () => {
  // 1. .btn wajib boleh membungkus teks & membelah kata panjang.
  assert.match(css, /\.btn\s*\{[^}]*flex-wrap:\s*wrap/, '.btn harus flex-wrap: wrap');
  assert.match(css, /\.btn\s*\{[^}]*min-width:\s*0/, '.btn harus min-width: 0');
  assert.match(css, /\.btn\s*\{[^}]*overflow-wrap:\s*anywhere/, '.btn harus overflow-wrap: anywhere');
  assert.match(css, /\.btn\s*\{[^}]*min-height:\s*4[0-9]px/, '.btn harus punya tinggi minimum nyaman disentuh');

  // 2. Tombol lentur / selebar penuh memakai sudut sedang, bukan pil 999px.
  assert.match(
    css,
    /\.btn\[style\*="flex:1"\][^{]*\{[^}]*border-radius:\s*14px/,
    'tombol .btn dengan flex:1 wajib memakai border-radius: 14px (bukan 999px)'
  );
  assert.match(
    css,
    /\.btn\[style\*="width:100%"\][^{]*\{[^}]*border-radius:\s*14px/,
    'tombol .btn selebar penuh wajib memakai border-radius: 14px'
  );

  // 3. Utility baris tombol wajib ada dan menumpuk di layar kecil.
  assert.match(css, /\.btn-row\s*\{[^}]*display:\s*flex/, '.btn-row harus flex container');
  assert.match(css, /\.btn-row\s*>\s*\.btn[^{]*\{[^}]*flex:\s*1 1 220px/, 'anak .btn-row harus punya lebar minimum');
  assert.match(css, /\.btn-row\s*>\s*\.btn[^{]*\{[^}]*border-radius:\s*14px/, 'anak .btn-row harus memakai sudut sedang');
  assert.match(
    css,
    /\.btn-row\s*>\s*\.btn[^{]*\{[^}]*white-space:\s*normal/,
    'anak .btn-row harus boleh membungkus teks'
  );
  assert.match(
    css,
    /@media[^{]*\{[^@]*\.btn-row\s*>\s*\.btn[^{]*\{[^}]*flex:\s*1 1 100%/,
    'di layar kecil tombol dalam .btn-row harus selebar kartu'
  );

  // 4. Teks teknis panjang (connection string, nama file) harus boleh membungkus.
  assert.match(css, /code,\s*kbd,\s*samp\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('CSS: kontrol form 16px pada perangkat sentuh (iOS tidak auto-zoom)', () => {
  assert.match(
    css,
    /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*\{[^@]*input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px/,
    'input/select/textarea harus 16px di perangkat sentuh'
  );
});

test('Markup admin: tidak ada tombol pil lentur yang bisa meluber', () => {
  // Pola berbahaya: class="btn ..." dengan gaya flex:1 ATAU width:100%,
  // TANPA berada di dalam .btn-row dan TANPA border-radius pengaman.
  const buttonRe = /<button([^>]*)>/g;
  let m;
  const offenders = [];
  while ((m = buttonRe.exec(adminJs))) {
    const attrs = m[1];
    const isBtn = /class="btn\b/.test(attrs) || /class="btn btn/.test(attrs);
    if (!isBtn) continue;
    const flexible = /flex:\s*1/.test(attrs);
    if (!flexible) continue;
    const before = adminJs.slice(Math.max(0, m.index - 600), m.index);
    const insideRow = before.lastIndexOf('btn-row') > before.lastIndexOf('</div>');
    const hasRadius = /border-radius/.test(attrs);
    if (!insideRow && !hasRadius) {
      offenders.push(attrs.trim().slice(0, 90));
    }
  }
  assert.deepEqual(offenders, [], 'tombol .btn dengan flex:1 harus berada dalam .btn-row (atau punya border-radius sendiri)');
});

test('Markup admin: baris tombol panel AI memakai .btn-row', () => {
  assert.match(
    adminJs,
    /<div class="btn-row" style="margin-top:12px;">\s*<button type="button" id="aiAssistantSaveBtn"/,
    'tombol Simpan Konfigurasi AI harus berada dalam .btn-row'
  );
  assert.match(adminJs, /id="aiAssistantDiagBtn"[^>]*>🔍 Tes Koneksi WhatsApp</, 'tombol Tes Koneksi WhatsApp hilang');
  assert.match(adminJs, /id="aiAssistantLogsBtn"[^>]*>📋 Log Percakapan</, 'tombol Log Percakapan hilang');
});

test('Tidak ada teks di bawah 0.76rem (≈12px) pada panel admin', () => {
  // 0.7rem ≈ 11px terlalu kecil untuk dibaca di HP, termasuk untuk badge
  // status & label kecil. Batas bawah yang dipakai: 0.76rem.
  // Hanya menandai yang BENAR-BENAR di bawah 0.76rem (0.6x / 0.7x / 0.75),
  // bukan 0.76rem ke atas (0.78rem, 0.8rem, ...).
  const tooSmall = adminJs.match(/font-size:0\.[0-6]\d?rem|font-size:0\.7[0-5]rem|font-size:0\.7rem/g) || [];
  assert.deepEqual(tooSmall, [], `ada ${tooSmall.length} teks < 0.76rem: ${tooSmall.slice(0, 5).join(', ')}`);
});

test('Mirror GitHub Pages (docs/) selalu sama dengan sumber di public/', () => {
  for (const rel of ['js/admin.js', 'js/main.js', 'js/kalender.js', 'js/i18n.js', 'js/api-config.js', 'css/style.css']) {
    const a = read(path.join('public', rel));
    const b = read(path.join('docs', rel));
    assert.equal(a, b, `docs/${rel} berbeda dari public/${rel} — jalankan: node build-gh-pages.js`);
  }
});
