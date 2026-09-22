// Tes regresi INTEGRITAS DATA (temuan audit menyeluruh semua fitur).
//
// Dua bug nyata yang ditemukan & dikunci di sini:
//
// 1. NOMOR KWITANSI DIPAKAI ULANG.
//    Dulu nomor dihitung dari jumlah kwitansi hari itu (`count + 1`), jadi
//    setelah satu kwitansi dihapus, kwitansi berikutnya mendapat nomor yang
//    sama. Dua dokumen berbeda bisa beredar dengan nomor identik, dan
//    impor/restore (yang mendeteksi duplikat lewat invoice_no) bisa salah
//    melewati data sah. Sekarang ada penghitung per hari yang hanya naik.
//
// 2. PESAN WHATSAPP MASUK HILANG DARI LOG.
//    Pencatatan percakapan dilakukan SETELAH pengiriman balasan. Kalau
//    pengiriman gagal (token kedaluwarsa / kredensial belum diisi), fungsi
//    melempar error dan percakapan pelanggan tidak tercatat — admin tidak
//    tahu ada pelanggan yang bertanya.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function block(marker) {
  const i = serverSrc.indexOf(marker);
  assert.ok(i > 0, `blok "${marker}" tidak ada di server.js`);
  const end = serverSrc.indexOf('\n}\n', i);
  return serverSrc.slice(i, end + 3);
}

// Sandbox berisi fungsi penomoran kwitansi apa adanya dari server.js.
function makeInvoiceSandbox(existing) {
  const sandbox = {
    console,
    todayJakarta: () => '2026-09-22',
    DB: { receipts: (existing || []).map((n) => ({ invoice_no: n })), invoice_counters: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(block('function nextInvoiceNumber'), sandbox);
  vm.runInContext(block('function noteInvoiceNumber'), sandbox);
  return sandbox;
}

test('Nomor kwitansi: berurutan dan tidak dipakai ulang setelah dihapus', () => {
  const sb = makeInvoiceSandbox();
  const a = vm.runInContext('nextInvoiceNumber("20260922")', sb);
  assert.equal(a, 'INV-20260922-001');
  // Kwitansi dihapus -> tidak ada di DB.receipts, tetapi nomornya sudah terpakai
  const b = vm.runInContext('nextInvoiceNumber("20260922")', sb);
  assert.equal(b, 'INV-20260922-002', 'nomor dipakai ulang setelah penghapusan');
  const c = vm.runInContext('nextInvoiceNumber("20260922")', sb);
  assert.equal(c, 'INV-20260922-003');
});

test('Nomor kwitansi: tetap aman walau penghitung hilang (data lama)', () => {
  // Simulasi file data lama: kwitansi -001..-003 sudah ada tetapi
  // invoice_counters kosong (mis. hasil restore manual). Nomor berikutnya
  // boleh mulai dari awal SELAMA tidak menabrak nomor yang sudah terpakai.
  const sb = makeInvoiceSandbox(['INV-20260922-001', 'INV-20260922-002', 'INV-20260922-003']);
  const next = vm.runInContext('nextInvoiceNumber("20260922")', sb);
  assert.equal(next, 'INV-20260922-004', 'nomor menabrak kwitansi yang sudah ada: ' + next);
  // Dan tetap unik pada pemanggilan berikutnya
  assert.equal(vm.runInContext('nextInvoiceNumber("20260922")', sb), 'INV-20260922-005');
});

test('Nomor kwitansi: melompati nomor yang diimpor dari luar', () => {
  const sb = makeInvoiceSandbox();
  vm.runInContext('noteInvoiceNumber("INV-20260922-010")', sb);
  const next = vm.runInContext('nextInvoiceNumber("20260922")', sb);
  assert.equal(next, 'INV-20260922-011', 'penomoran tidak melanjutkan dari nomor impor');
  // Nomor dari luar dengan format berbeda tidak boleh merusak penghitung
  vm.runInContext('noteInvoiceNumber("BUKAN-INVOICE")', sb);
  vm.runInContext('noteInvoiceNumber("")', sb);
  assert.equal(vm.runInContext('nextInvoiceNumber("20260922")', sb), 'INV-20260922-012');
});

test('Nomor kwitansi: tiap hari punya urutan sendiri', () => {
  const sb = makeInvoiceSandbox();
  assert.equal(vm.runInContext('nextInvoiceNumber("20260922")', sb), 'INV-20260922-001');
  assert.equal(vm.runInContext('nextInvoiceNumber("20260923")', sb), 'INV-20260923-001');
  assert.equal(vm.runInContext('nextInvoiceNumber("20260922")', sb), 'INV-20260922-002');
});

test('Server memakai penghitung: POST, impor, restore, dan hapus-semua', () => {
  // POST kwitansi memakai nextInvoiceNumber (bukan hitungan jumlah)
  assert.match(serverSrc, /const invoice_no = nextInvoiceNumber\(todayJakarta\(\)/, 'POST kwitansi tidak memakai penghitung');
  assert.ok(!/String\(count \+ 1\)\.padStart\(3, '0'\)/.test(serverSrc), 'masih ada penomoran lama berbasis jumlah');
  // Impor: nomor otomatis + catat nomor eksplisit
  assert.match(serverSrc, /invoice_no = nextInvoiceNumber\(service_date\.replace\(\/-\/g, ''\)\)/, 'impor tidak memakai penghitung');
  assert.match(serverSrc, /noteInvoiceNumber\(invoice_no\)/, 'nomor impor tidak dicatat');
  // Restore juga mencatat nomor
  assert.match(serverSrc, /noteInvoiceNumber\(k\.invoice_no\)/, 'restore tidak mencatat nomor kwitansi');
  // Hapus semua TIDAK mereset penghitung
  const delAll = serverSrc.slice(serverSrc.indexOf("app.delete('/api/admin/receipts'"), serverSrc.indexOf("app.delete('/api/admin/receipts'") + 900);
  assert.ok(!/invoice_counters = \{\}/.test(delAll), 'hapus semua mereset penghitung kwitansi');
  // State lama dinormalisasi
  assert.match(serverSrc, /out\.invoice_counters = out\.invoice_counters && typeof out\.invoice_counters === 'object'/, 'normalisasi invoice_counters hilang');
});

test('Webhook WhatsApp: percakapan dicatat SEBELUM balasan dikirim', () => {
  const waSection = serverSrc.slice(serverSrc.indexOf("app.post('/api/webhook/whatsapp'"), serverSrc.indexOf('// ADMIN: get AI conversation logs'));
  const iPush = waSection.indexOf("DB.settings.ai_assistant_conversations.push({");
  const iSend = waSection.indexOf('await sendWAReply(');
  assert.ok(iPush > 0 && iSend > 0, 'bagian webhook tidak lengkap');
  assert.ok(iPush < iSend, 'pencatatan percakapan masih dilakukan setelah pengiriman balasan (data bisa hilang)');
  // Pengiriman dibungkus try/catch supaya kegagalan tidak menghapus catatan
  const afterPush = waSection.slice(iPush);
  assert.match(afterPush, /try \{\s*await sendWAReply\(/, 'pengiriman balasan tidak dibungkus try/catch');
  assert.match(afterPush, /catch \(sendErr\) \{[\s\S]{0,200}recordAIError\(sendErr\)/, 'kegagalan kirim tidak dicatat untuk admin');
});

test('Webhook WhatsApp: kredensial belum lengkap -> pesan tetap dicatat, kuota AI tidak dibuang', () => {
  const waSection = serverSrc.slice(serverSrc.indexOf("app.post('/api/webhook/whatsapp'"), serverSrc.indexOf('// ADMIN: get AI conversation logs'));
  assert.match(waSection, /const waCanReply = !!\(DB\.settings\.ai_assistant_phone_id && DB\.settings\.ai_assistant_access_token\)/, 'tidak ada pemeriksaan kredensial WA');
  assert.match(waSection, /if \(waCanReply\) \{/, 'pemanggilan AI tidak dijaga oleh kredensial WA');
  assert.match(waSection, /\[tidak dibalas: kredensial WhatsApp Business API belum lengkap\]/, 'tidak ada penanda di log saat balasan tidak terkirim');
  assert.match(waSection, /Kredensial WA belum lengkap — pesan dicatat, balasan tidak dikirim/, 'tidak ada peringatan di log server');
  // Pesan yang gagal dibalas tetap memicu catatan galat untuk panel admin
  assert.match(waSection, /recordAIError\(new Error\('Kredensial WhatsApp Business API belum lengkap/, 'galat kredensial tidak dilaporkan ke panel');
});

test('Integritas lain: pengeluaran & P&L memakai bulan WIB', () => {
  // Pengeluaran divalidasi: jumlah harus > 0 dan tanggal berformat YYYY-MM-DD
  assert.match(serverSrc, /amount harus angka > 0/, 'validasi jumlah pengeluaran hilang');
  assert.match(serverSrc, /date harus YYYY-MM-DD/, 'validasi tanggal pengeluaran hilang');
  // Ringkasan P&L memakai bulan WIB (monthJakarta), bukan UTC
  const acct = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/accounting/summary'"), serverSrc.indexOf("app.get('/api/admin/accounting/summary'") + 1200);
  assert.match(acct, /shiftMonthStr\(monthJakarta\(\), -i\)/, 'P&L tidak memakai bulan WIB');
  // Pada rentang bulan, pengeluaran hanya dihitung bila masuk daftar bulan
  assert.match(acct, /if \(!m \|\| !monthSet\.has\(m\)\) return;/, 'pengeluaran tidak difilter per bulan');
});
