// Tes regresi: RESERVASI OTOMATIS DARI CHAT AI.
//
// Fitur: saat percakapan AI sudah lengkap (nama, WhatsApp, alamat, layanan,
// tanggal, jam), AI menutup balasannya dengan blok [[BOOKING]]{...}[[/BOOKING]].
// Server memvalidasi ulang isinya lalu membuat reservasi sehingga langsung
// muncul di panel admin.
//
// Tes ini mengunci dua hal: fitur berjalan, DAN penyalahgunaan tertahan —
// teks dari AI/pengunjung TIDAK dipercaya (harga selalu dari katalog server,
// jadwal/hari libur dicek, ada batas jumlah booking per IP & per sesi).
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

// Sandbox berisi kode booking APA ADANYA dari server.js.
function makeSandbox(opts) {
  const o = opts || {};
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setInterval: () => {},
    DB: { reservations: [], settings: { blackout_dates: [], blackout_notes: {} }, _seq: { reservations: 0 } },
    save: () => {},
    nextId: (t) => { sandbox.DB._seq[t] = (sandbox.DB._seq[t] || 0) + 1; return sandbox.DB._seq[t]; },
    todayJakarta: () => o.today || '2026-09-21'
  };
  vm.createContext(sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const SERVICES = ['), serverSrc.indexOf('const SERVICE_PRICE_BY_NAME')), sandbox);
  vm.runInContext('const SERVICE_PRICE_BY_NAME = new Map(SERVICES.flatMap(c => c.items.map(i => [i.name, i.price])));', sandbox);
  vm.runInContext(block('function sanitizeAIReply'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const AI_BOOKING_MAX_PER_IP_PER_HOUR'), serverSrc.indexOf('function extractAISBooking')), sandbox);
  vm.runInContext(block('function aiBookingRateCheck'), sandbox);
  vm.runInContext(block('function extractAISBooking'), sandbox);
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('const AI_BOOKING_PLACEHOLDER_RE'), serverSrc.indexOf('function looksLikePlaceholderBooking')), sandbox);
  vm.runInContext(block('function looksLikePlaceholderBooking'), sandbox);
  // Fungsi penjadwalan dipakai validasi AI booking (mode 'block').
  vm.runInContext(serverSrc.slice(serverSrc.indexOf('function schedConf'), serverSrc.indexOf('function busySlots')), sandbox);
  vm.runInContext(block('function slotStartMinutes'), sandbox);
  vm.runInContext(block('function slotTime'), sandbox);
  vm.runInContext(block('function busySlots'), sandbox);
  vm.runInContext(block('function findScheduleConflicts'), sandbox);
  vm.runInContext(block('function describeConflicts'), sandbox);
  vm.runInContext(block('function minutesToTime'), sandbox);
  vm.runInContext(block('function buildReservationFromAIData'), sandbox);
  vm.runInContext(block('function processAISBooking'), sandbox);
  return sandbox;
}

const wrap = (o) => '[[BOOKING]]' + JSON.stringify(o) + '[[/BOOKING]]';
const valid = () => ({
  patient_name: 'Bunda Uji',
  whatsapp: '081234567890',
  address: 'Dusun Klumprit No. 5, Nusawungu, Cilacap',
  items: [{ name: 'Massage Ibu Hamil', qty: 1 }],
  slots: [{ date: '2026-11-10', time: '09:00' }]
});

test('Ekstraksi: blok booking diambil, balasan untuk pengunjung tetap bersih', () => {
  const sb = makeSandbox();
  const ex = vm.runInContext('extractAISBooking(' + JSON.stringify('Baik Bunda 🌸\n\n' + wrap(valid())) + ')', sb);
  assert.equal(ex.data.patient_name, 'Bunda Uji', 'blok tidak terbaca');
  assert.ok(!/BOOKING/.test(ex.clean), 'marker mesin masih tampil di balasan pengunjung');
  assert.match(ex.clean, /Baik Bunda/, 'teks balasan hilang');
  // Tanpa blok -> tidak ada data
  const none = vm.runInContext('extractAISBooking("halo")', sb);
  assert.equal(none.data, null);
  assert.equal(none.clean, 'halo');
  // JSON rusak -> dilaporkan sebagai error, bukan crash
  const broken = vm.runInContext('extractAISBooking("x [[BOOKING]]{bukan json}[[/BOOKING]] y")', sb);
  assert.equal(broken.data, null);
  assert.ok(broken.error, 'JSON rusak tidak dilaporkan');
  assert.ok(!/BOOKING/.test(broken.clean), 'marker rusak tidak dibersihkan');
});

test('Validasi: data lengkap -> reservasi pending dengan harga DARI KATALOG', () => {
  const sb = makeSandbox();
  const built = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(valid()) + ')', sb);
  assert.equal(built.ok, true, 'data valid ditolak: ' + built.error);
  const r = built.reservation;
  assert.equal(r.patient_name, 'Bunda Uji');
  assert.equal(r.status, 'pending', 'status awal harus pending (menunggu konfirmasi admin)');
  assert.equal(r.payment_status, 'unpaid');
  assert.equal(r.total, 80000, 'total tidak dihitung dari katalog server');
  assert.equal(r.items[0].price, 80000, 'harga tidak diambil dari katalog');
  assert.equal(r.source, 'ai_chat', 'penanda sumber reservasi hilang');
  assert.match(r.notes, /AI Assistant/i, 'catatan asal reservasi hilang');
});

test('Validasi: harga dari AI diabaikan sepenuhnya', () => {
  const sb = makeSandbox();
  const data = valid();
  data.items = [{ name: 'Massage Ibu Hamil', qty: 1, price: 1, harga: 1 }];
  const built = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(data) + ')', sb);
  assert.equal(built.reservation.items[0].price, 80000, 'harga dari AI dipercaya (harus dari katalog)');
  assert.equal(built.reservation.total, 80000);
});

test('Validasi: layanan di luar katalog / data kurang / nomor & tanggal salah ditolak', () => {
  const sb = makeSandbox();
  const run = (d) => vm.runInContext('buildReservationFromAIData(' + JSON.stringify(d) + ')', sb);
  assert.match(run(Object.assign(valid(), { items: [{ name: 'Pijat Karangan', qty: 1 }] })).error || '', /tidak ada di katalog/);
  assert.match(run(Object.assign(valid(), { patient_name: 'A' })).error || '', /nama pasien/);
  assert.match(run(Object.assign(valid(), { whatsapp: '123' })).error || '', /WhatsApp/);
  assert.match(run(Object.assign(valid(), { address: 'x' })).error || '', /alamat/);
  assert.match(run(Object.assign(valid(), { slots: [] })).error || '', /tanggal/);
  assert.match(run(Object.assign(valid(), { slots: [{ date: '10-11-2026', time: '09:00' }] })).error || '', /format tanggal/);
  assert.match(run(Object.assign(valid(), { slots: [{ date: '2026-11-10', time: '25:99' }] })).error || '', /format tanggal/);
  assert.match(run(Object.assign(valid(), { slots: [{ date: '2020-01-01', time: '09:00' }] })).error || '', /sudah lewat/);
});

test('Validasi: hari libur (blackout) ditolak dengan menyebut tanggal & catatannya', () => {
  const sb = makeSandbox();
  sb.DB.settings.blackout_dates = ['2026-11-15'];
  sb.DB.settings.blackout_notes = { '2026-11-15': 'Libur test' };
  const built = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(Object.assign(valid(), { slots: [{ date: '2026-11-15', time: '09:00' }] })) + ')', sb);
  assert.equal(built.ok, false);
  assert.match(built.error, /2026-11-15/);
  assert.match(built.error, /Libur test/);
});

test('Validasi: nama layanan toleran kapitalisasi, tapi tetap harus cocok', () => {
  const sb = makeSandbox();
  const ok = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(Object.assign(valid(), { items: [{ name: 'massage ibu hamil', qty: 2 }] })) + ')', sb);
  assert.equal(ok.ok, true, 'nama layanan beda kapitalisasi ditolak: ' + ok.error);
  assert.equal(ok.reservation.total, 160000, 'qty tidak dihitung');
});

test('Total dihitung per sesi (jumlah slot)', () => {
  const sb = makeSandbox();
  const data = valid();
  data.slots = [{ date: '2026-11-10', time: '09:00' }, { date: '2026-11-11', time: '14:00' }];
  const built = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(data) + ')', sb);
  assert.equal(built.reservation.total, 160000, 'total 2 sesi salah');
  assert.equal(built.reservation.slots.length, 2);
});

test('Duplikat: reservasi sama pada waktu sama tidak dibuat dua kali', () => {
  const sb = makeSandbox();
  const first = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(valid()) + ')', sb);
  sb.DB.reservations.push(first.reservation);
  const second = vm.runInContext('buildReservationFromAIData(' + JSON.stringify(valid()) + ')', sb);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'duplicate');
  assert.equal(second.existing_id, first.reservation.id);
});

test('Blok contoh (placeholder) diabaikan tanpa pesan galat membingungkan', () => {
  const sb = makeSandbox();
  const contoh = { patient_name: 'Nama Lengkap', whatsapp: '0812xxxxxxx', address: 'Alamat lengkap', items: [{ name: 'Nama Layanan Sesuai Katalog', qty: 1 }], slots: [{ date: 'YYYY-MM-DD', time: 'HH:MM' }] };
  assert.equal(vm.runInContext('looksLikePlaceholderBooking(' + JSON.stringify(contoh) + ')', sb), true, 'contoh tidak dikenali sebagai placeholder');
  assert.equal(vm.runInContext('looksLikePlaceholderBooking(' + JSON.stringify(valid()) + ')', sb), false, 'data asli dianggap placeholder');
  const hasil = vm.runInContext('processAISBooking(' + JSON.stringify('mohon lengkapi data ya\n\n' + wrap(contoh)) + ', { ip: "1.1.1.1", sessionId: "s" })', sb);
  assert.equal(hasil.booking.created, false);
  assert.equal(hasil.booking.reason, 'data belum lengkap');
  assert.ok(!/BOOKING/.test(hasil.clean), 'marker contoh masih tampil ke pengunjung');
  assert.equal(sb.DB.reservations.length, 0, 'reservasi dibuat dari data contoh');
});

test('Batas penyalahgunaan: maksimal 3 booking per IP per jam', () => {
  const sb = makeSandbox();
  let created = 0;
  for (let i = 0; i < 5; i++) {
    const d = valid();
    d.patient_name = 'Pasien ' + i;
    d.slots = [{ date: '2026-11-' + String(10 + i).padStart(2, '0'), time: '09:00' }];
    const out = vm.runInContext('processAISBooking(' + JSON.stringify(wrap(d)) + ', { ip: "9.9.9.9", sessionId: "ses-' + i + '" })', sb);
    if (out.booking.created) created++;
    else assert.match(String(out.booking.reason), /batas booking/, 'penolakan bukan karena batas: ' + out.booking.reason);
  }
  assert.equal(created, 3, 'batas per IP tidak berlaku (dibuat ' + created + ')');
  assert.equal(sb.DB.reservations.length, 3);
});

test('Batas penyalahgunaan: maksimal 3 booking per percakapan (sesi)', () => {
  const sb = makeSandbox();
  let created = 0;
  for (let i = 0; i < 5; i++) {
    const d = valid();
    d.patient_name = 'Sesi ' + i;
    d.slots = [{ date: '2026-12-' + String(10 + i).padStart(2, '0'), time: '10:00' }];
    const out = vm.runInContext('processAISBooking(' + JSON.stringify(wrap(d)) + ', { ip: "8.8.8.' + i + '", sessionId: "satu-sesi" })', sb);
    if (out.booking.created) created++;
  }
  assert.equal(created, 3, 'batas per sesi tidak berlaku (dibuat ' + created + ')');
});

test('Permintaan normal: satu panggilan membuat satu reservasi + ringkasan untuk klien', () => {
  const sb = makeSandbox();
  const out = vm.runInContext('processAISBooking(' + JSON.stringify('Baik Bunda 🌸\n\n' + wrap(valid())) + ', { ip: "7.7.7.7", sessionId: "s1", channel: "ai_chat" })', sb);
  assert.equal(out.booking.created, true);
  assert.equal(out.booking.id, 1);
  assert.equal(out.booking.total, 80000);
  assert.equal(out.booking.patient_name, 'Bunda Uji');
  assert.equal(out.booking.channel, 'ai_chat');
  assert.equal(sb.DB.reservations[0].channel, 'ai_chat', 'kanal tidak dicatat di reservasi');
  assert.ok(!/BOOKING/.test(out.clean));
});

test('Server: terhubung ke chat web & webhook WhatsApp, serta tampil di panel', () => {
  // Chat web memproses blok sebelum menyusun respons
  assert.match(serverSrc, /processAISBooking\(result\.reply, \{[\s\S]{0,80}channel: 'ai_chat'/, 'chat web tidak memproses booking');
  // Webhook WA juga, dengan konfirmasi nomor reservasi
  assert.match(serverSrc, /processAISBooking\(result\.reply, \{[\s\S]{0,120}channel: 'ai_chat_wa'/, 'webhook WhatsApp tidak memproses booking');
  assert.match(serverSrc, /Reservasi #' \+ waBooking\.booking\.id \+ ' sudah masuk ke sistem/, 'konfirmasi WA tidak menyebut nomor reservasi');
  // Respons API memuat info booking untuk ditampilkan sebagai kartu
  assert.match(serverSrc, /booking: booking \? \{/, 'respons tidak memuat info booking');
  // Panel bisa menandai asal reservasi
  assert.match(serverSrc, /source: r\.source \|\| null/, 'publicReservation tidak meneruskan sumber');
  // Persona: TIDAK boleh memuat contoh blok JSON literal (bisa disalin model)
  const persona = serverSrc.slice(serverSrc.indexOf('const AI_DEFAULT_PERSONA'), serverSrc.indexOf('function shortPrice'));
  assert.ok(!/\[\[BOOKING\]\]\{/.test(persona), 'persona masih memuat contoh blok JSON literal');
  assert.match(persona, /\[\[BOOKING\]\]/, 'persona tidak memberi tahu marker blok');
});

test('Widget chat: kartu konfirmasi reservasi tersedia + info batas', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /function appendBookingCard/, 'kartu konfirmasi reservasi hilang');
  assert.match(html, /data\.booking && data\.booking\.created/, 'widget tidak menangani booking berhasil');
  assert.match(html, /duplicate/, 'widget tidak menangani kasus duplikat');
  assert.match(html, /batas booking/, 'widget tidak menjelaskan batas booking');
});

test('docs/ sinkron dengan public/ (cermin GitHub Pages)', () => {
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').includes('appendBookingCard'),
    fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8').includes('appendBookingCard'),
    'docs/index.html belum diperbarui — jalankan: node build-gh-pages.js'
  );
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs/js/admin.js'), 'utf8'),
    'docs/js/admin.js berbeda — jalankan: node build-gh-pages.js'
  );
});
