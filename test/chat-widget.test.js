// Tes regresi widget chat AI (beranda).
//
// Latar belakang bug: model (Gemini/OpenRouter) kadang menjawab dengan HTML,
// mis. `<a href="https://wa.me/0858..." target="_blank" rel="noopener">…</a>`.
// Fungsi linkifyAndEscape() melakukan tiga .replace() berurutan; markup <a>
// yang dibuat pass kedua dipindai ulang pass ketiga dan regex `wa\.me\/\d+[^\s<]*`
// yang rakus menelan tanda kutip. Hasilnya pembaca melihat potongan tag:
//     wa.me/085887018194" target="_blank" rel="noopener">https://…
//
// Dua lapis perbaikan yang dikunci tes ini:
//   1) server.js → sanitizeAIReply(): tag dibuang, <a href=X>Label</a> menjadi
//      "Label (X)" sehingga tautan tidak hilang, markdown jadi teks biasa.
//   2) public/index.html → linkifyAndEscape(): tag dari model dibuang lebih
//      dulu, lalu tautan dibuat dalam SATU pass (satu regex + callback).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------- helper: ambil fungsi dari file ----------
function grabFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, `fungsi ${name} tidak ditemukan`);
  // Fungsi di server.js sejajar kolom 0 ("}"), sedangkan di index.html
  // berada di dalam IIFE (ter-indent dua spasi). Cari penutup yang sesuai.
  const endTop = src.indexOf('\n}\n', i);
  const endIndented = src.indexOf('\n  }\n', i);
  let end = -1;
  if (endTop > 0 && endIndented > 0) end = Math.min(endTop, endIndented);
  else end = Math.max(endTop, endIndented);
  assert.ok(end > 0, `penutup fungsi ${name} tidak ditemukan`);
  // Sertakan kurung penutupnya (satu karakter setelah posisi baris penutup).
  const close = src.indexOf('}', end);
  assert.ok(close > end, `kurung penutup fungsi ${name} tidak ditemukan`);
  return src.slice(i, close + 1);
}

// ---------- helper: panggil linkifyAndEscape seperti di browser ----------
function runLinkify(html) {
  const scriptStart = html.indexOf('(function() {');
  const scriptEnd = html.indexOf('</script>', scriptStart);
  const code = html.slice(scriptStart, scriptEnd);
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(grabFunction(code, 'escapeHtml'), sandbox);
  vm.runInContext(grabFunction(code, 'linkifyAndEscape'), sandbox);
  return (text) => vm.runInContext('linkifyAndEscape(' + JSON.stringify(text) + ')', sandbox);
}

// ---------- helper: panggil sanitizeAIReply dari server ----------
function runSanitize() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(grabFunction(serverSrc, 'sanitizeAIReply'), sandbox);
  return (text) => vm.runInContext('sanitizeAIReply(' + JSON.stringify(text) + ')', sandbox);
}

const IMAGE_BUG_INPUT = '<a href="https://wa.me/085887018194" target="_blank" rel="noopener">https://wa.me/085887018194</a>';

test('Server: tautan WhatsApp memakai format internasional (bukan 08xx)', () => {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(grabFunction(serverSrc, 'waNumberFor'), sandbox);
  const num = (p) => vm.runInContext('waNumberFor(' + JSON.stringify(p) + ", '6285887018194')", sandbox);
  assert.equal(num('085887018194'), '6285887018194', 'nomor lokal 08xx tidak diubah ke 628xx');
  assert.equal(num('6285887018194'), '6285887018194');
  assert.equal(num('85887018194'), '6285887018194', 'nomor tanpa 0/62 tidak dinormalkan');
  assert.equal(num(''), '6285887018194', 'tanpa nomor harus memakai fallback');
  // Konstruksi lama (tempel nomor apa adanya) tidak boleh kembali dipakai.
  assert.ok(
    !/fallback_wa:\s*'https:\/\/wa\.me\/'\s*\+/.test(serverSrc),
    'masih ada pembentukan tautan wa.me yang menempelkan nomor mentah'
  );
  assert.ok(
    !/wa\.me\/'\s*\+\s*\(DB\.settings\.phone/.test(serverSrc),
    'nomor pengaturan masih ditempel langsung ke wa.me'
  );
});

test('Chat widget: balasan ber-HTML dari AI tidak lagi tampil sebagai potongan tag', () => {
  const linkify = runLinkify(indexHtml);
  const out = linkify(IMAGE_BUG_INPUT);
  const textOnly = out.replace(/<a [^>]*>|<\/a>/g, '');
  assert.ok(!/target=/.test(textOnly), 'potongan atribut (target=) masih tampil sebagai teks');
  assert.ok(!/rel=/.test(textOnly), 'potongan atribut (rel=) masih tampil sebagai teks');
  assert.equal((out.match(/<a /g) || []).length, 1, 'tautan harus tepat satu');
  assert.match(out, /href="https:\/\/wa\.me\/085887018194"/);
});

test('Chat widget: hanya menghasilkan tautan aman (tanpa tag mentah / javascript:)', () => {
  const linkify = runLinkify(indexHtml);
  const cases = [
    'Halo Bunda 🌸<br><br>Silakan chat via <a href="https://wa.me/6285887018194">WhatsApp</a>.',
    'klik [ini](javascript:alert(1))',
    'Klik <script>alert(1)</script> lalu <img src=x onerror=alert(2)>',
    'wa.me/6285887018194 dan https://adzkiya.id/harga.',
  ];
  for (const input of cases) {
    const out = linkify(input);
    assert.ok(!/<script|<img|onerror=/i.test(out), 'tag mentah lolos: ' + out);
    assert.ok(!/href="javascript:/i.test(out), 'href javascript: lolos: ' + out);
  }
});

test('Chat widget: tautan tetap utuh walau dibungkus tanda kurung / tanda baca', () => {
  const linkify = runLinkify(indexHtml);
  const out = linkify('Silakan chat langsung via WhatsApp (https://wa.me/6285887018194).');
  assert.match(out, /href="https:\/\/wa\.me\/6285887018194"/, 'URL kotor karena tanda baca/kurung');
  assert.ok(/\<\/a\>\)\./.test(out), 'tanda kurung & titik tidak dikembalikan ke luar tautan');
});

test('Server: sanitizeAIReply membuang tag tapi URL tetap ada', () => {
  const sanitize = runSanitize();
  assert.equal(sanitize(IMAGE_BUG_INPUT), 'https://wa.me/085887018194');
  assert.equal(sanitize('Chat via <a href="https://wa.me/6285887018194">WhatsApp</a> ya'),
    'Chat via WhatsApp (https://wa.me/6285887018194) ya');
  assert.equal(sanitize('Halo<br><br>Ada yang bisa dibantu?'), 'Halo\n\nAda yang bisa dibantu?');
  assert.equal(sanitize('tanpa tag <b>tebal</b>'), 'tanpa tag tebal');
  assert.ok(!sanitize('x <script>alert(1)</script> y').includes('<'),
    'sisa tag pada keluaran sanitizer');
  // markdown link jadi teks biasa supaya terbaca di WhatsApp juga
  assert.equal(sanitize('Cek [layanan](https://adzkiya.id)'), 'Cek layanan (https://adzkiya.id)');
});

test('Server: persona melarang HTML/markdown agar model tidak mengirim tag', () => {
  assert.match(serverSrc, /Format jawaban \(WAJIB\)/, 'aturan format jawaban hilang dari persona');
  assert.match(serverSrc, /JANGAN pakai HTML/, 'larangan HTML hilang');
  assert.match(serverSrc, /Tulis tautan apa adanya/, 'anjuran menulis tautan polos hilang');
});

test('Kedua provider AI memakai sanitizer (Gemini & OpenRouter)', () => {
  const gemini = serverSrc.slice(serverSrc.indexOf('async function callGemini'), serverSrc.indexOf('async function callOpenRouter'));
  const router = serverSrc.slice(serverSrc.indexOf('async function callOpenRouter'), serverSrc.indexOf('async function callAIChat'));
  // Kedua provider membersihkan balasan sebelum dikembalikan
  // (bentuknya kini: const cleanReply = sanitizeAIReply(...) lalu
  //  return { reply: cleanReply, model } — sekaligus menolak balasan kosong).
  assert.match(gemini, /sanitizeAIReply\(reply\)/, 'Gemini tidak membersihkan balasan');
  assert.match(gemini, /return \{ reply: cleanReply, model \}/, 'Gemini tidak mengembalikan balasan bersih');
  assert.match(router, /sanitizeAIReply\(data\.choices/, 'OpenRouter tidak membersihkan balasan');
  assert.match(router, /return \{ reply: cleanReply, model \}/, 'OpenRouter tidak mengembalikan balasan bersih');
  // Hanya dua provider ini yang boleh dipakai.
  assert.ok(!/anthropic|claude|openai\.com|groq\.com|cohere/i.test(serverSrc),
    'ada provider AI lain yang tidak seharusnya dipakai');
});

test('Placeholder kolom chat tidak lagi terpotong di HP', () => {
  // Placeholder panjang membungkus jadi 2 baris pada kolom 1 baris sehingga
  // tampak terpotong (lihat laporan pengguna).
  const i18n = fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8');
  const phId = i18n.match(/placeholder: '([^']*Ketik pesan[^']*)'/);
  const phEn = i18n.match(/placeholder: '([^']*Type a message[^']*)'/);
  assert.ok(phId, 'placeholder ID tidak ditemukan');
  assert.ok(phEn, 'placeholder EN tidak ditemukan');
  assert.ok(phId[1].length <= 30, 'placeholder ID masih terlalu panjang: ' + phId[1]);
  assert.ok(phEn[1].length <= 30, 'placeholder EN masih terlalu panjang: ' + phEn[1]);
  // tinggi minimum textarea supaya satu baris tidak menempel di tepi
  assert.match(indexHtml, /\.ai-chat-input textarea \{[^}]*min-height:\s*4[0-9]px/, 'textarea tanpa min-height');
});

test('docs/ selalu sinkron dengan public/ (cermin GitHub Pages)', () => {
  // File JS disalin apa adanya.
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'public/js/i18n.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs/js/i18n.js'), 'utf8'),
    'docs/js/i18n.js berbeda dari public/js/i18n.js — jalankan: node build-gh-pages.js'
  );
  // index.html di docs/ sengaja ditulis ulang (path absolut -> relatif),
  // jadi yang diperiksa: perbaikan linkifier ikut terbawa ke cermin.
  const docsIndex = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  assert.match(docsIndex, /LINK_RE/, 'docs/index.html belum memuat linkifier yang diperbaiki — jalankan: node build-gh-pages.js');
  assert.match(docsIndex, /min-height: 42px/, 'perbaikan tata letak kolom chat belum ikut ke docs/');
});
