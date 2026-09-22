// Tes regresi FITUR BARU:
//   1. Jadwal bentrok + jarak antar-jadwal (durasi sesi & jeda perjalanan)
//   2. Paket multi-sesi & sisa sesi
//   3. Pengingat otomatis (jadwal pengiriman, template, anti-kirim-ulang)
//   4. PWA (manifest, service worker, larangan cache data API)
//
// Kode yang diuji diambil APA ADANYA dari server.js lalu dijalankan di sandbox.
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

// ---------- sandbox penjadwalan ----------
function schedSandbox(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    todayJakarta: () => o.today || '2026-09-22',
    DB: {
      reservations: o.reservations || [],
      packages: o.packages || [],
      _seq: { packages: 0, reservations: 0, receipts: 0 },
      settings: Object.assign({
        session_duration_minutes: o.duration === undefined ? 60 : o.duration,
        travel_buffer_minutes: o.buffer === undefined ? 30 : o.buffer,
        scheduling_mode: o.mode || 'warn',
        max_sessions_per_day: o.maxPerDay === undefined ? 4 : o.maxPerDay
      }, o.settings || {})
    },
    save: () => {},
    nextId: (t) => { sandbox.DB._seq[t] = (sandbox.DB._seq[t] || 0) + 1; return sandbox.DB._seq[t]; }
  };
  vm.createContext(sandbox);
  vm.runInContext(block('function schedConf'), sandbox);
  vm.runInContext(block('function slotStartMinutes'), sandbox);
  vm.runInContext(block('function minutesToTime'), sandbox);
  vm.runInContext(block('function slotTime'), sandbox);
  vm.runInContext(block('function busySlots'), sandbox);
  vm.runInContext(block('function findScheduleConflicts'), sandbox);
  vm.runInContext(block('function describeConflicts'), sandbox);
  vm.runInContext(block('function packageSizeFor'), sandbox);
  vm.runInContext(block('function createPackageFromReceipt'), sandbox);
  vm.runInContext(block('function packageRemaining'), sandbox);
  return sandbox;
}

const rsv = (id, date, time, extra) => Object.assign({
  id, patient_name: 'Pasien ' + id, status: 'approved', payment_status: 'unpaid',
  slots: [{ date, time }], items: [{ name: 'Massage Ibu Hamil', price: 80000, qty: 1 }], total: 80000
}, extra || {});

test('Bentrok: satu sesi memblokir slot di dalam durasi + jeda perjalanan', () => {
  const sb = schedSandbox({ reservations: [rsv(1, '2026-10-05', '09:00')] });
  const c = (t) => vm.runInContext(`findScheduleConflicts([{date:"2026-10-05",time:"${t}"}])`, sb);
  assert.equal(c('09:00').length > 0, true, 'slot yang sama harus bentrok');
  assert.equal(c('09:30').length > 0, true, '30 menit setelahnya belum cukup (durasi 60 + jeda 30)');
  assert.equal(c('10:00').length > 0, true, 'tepat 1 jam masih di dalam durasi');
  assert.equal(c('10:20').length > 0, true, 'masih terdampak jeda perjalanan');
  assert.equal(c('10:30').length, 0, 'setelah durasi + jeda (10:30) seharusnya bebas');
  assert.equal(c('08:00').length > 0, true, 'sebelum jadwal pun perlu jeda perjalanan');
  assert.equal(c('07:30').length, 0, '07:30 harusnya bebas (jeda 30 menit)');
});

test('Bentrok: durasi & jeda mengikuti pengaturan admin', () => {
  const sb = schedSandbox({ reservations: [rsv(1, '2026-10-05', '09:00')], duration: 30, buffer: 0 });
  const c = (t) => vm.runInContext(`findScheduleConflicts([{date:"2026-10-05",time:"${t}"}])`, sb);
  assert.equal(c('09:30').length, 0, 'durasi 30 & jeda 0 -> 09:30 sudah bebas');
  assert.equal(c('09:15').length > 0, true, '09:15 masih di dalam durasi 30 menit');
});

test('Bentrok: batas sesi per hari', () => {
  const sb = schedSandbox({
    reservations: [rsv(1, '2026-10-06', '08:00'), rsv(2, '2026-10-06', '11:00')],
    maxPerDay: 2
  });
  const c = vm.runInContext('findScheduleConflicts([{date:"2026-10-06",time:"15:00"}])', sb);
  assert.ok(c.some((x) => x.type === 'daily_limit'), 'batas harian tidak terdeteksi');
});

test('Bentrok: dua slot berdekatan dalam SATU pengiriman juga terdeteksi', () => {
  const sb = schedSandbox();
  const c = vm.runInContext('findScheduleConflicts([{date:"2026-10-07",time:"09:00"},{date:"2026-10-07",time:"09:30"}])', sb);
  assert.ok(c.some((x) => x.type === 'self'), 'bentrok antar slot sendiri tidak terdeteksi');
});

test('Bentrok: reservasi rejected tidak dianggap terpakai', () => {
  const sb = schedSandbox({ reservations: [rsv(1, '2026-10-08', '09:00', { status: 'rejected' })] });
  assert.equal(vm.runInContext('findScheduleConflicts([{date:"2026-10-08",time:"09:00"}]).length', sb), 0);
});

test('Bentrok: pesan konflik menyebut tanggal, jam, dan kebutuhan jeda', () => {
  const sb = schedSandbox({ reservations: [rsv(1, '2026-10-09', '09:00')] });
  const msg = vm.runInContext('describeConflicts(findScheduleConflicts([{date:"2026-10-09",time:"09:30"}]))', sb);
  assert.match(msg, /2026-10-09/);
  assert.match(msg, /09:30/);
  assert.match(msg, /09:00/);
  assert.match(msg, /jeda/i);
});

test('Paket: ukuran sesi dikenali dari nama layanan & bisa dioverride admin', () => {
  const sb = schedSandbox();
  const size = (n) => vm.runInContext('packageSizeFor(' + JSON.stringify(n) + ')', sb);
  assert.equal(size('Mom & Newborn Care 5 Days'), 5);
  assert.equal(size('Newborn Care 14 Days'), 14);
  assert.equal(size('Gentle Flow Package (5x)'), 5);
  assert.equal(size('Mom\'s Relief Package (3x)'), 3);
  assert.equal(size('Senity Bump Package'), 3, 'paket tanpa angka dianggap 3 sesi');
  assert.equal(size('Massage Ibu Hamil'), 1, 'layanan biasa = 1 sesi');
  // Override dari pengaturan menang
  sb.DB.settings.package_sizes = { 'Massage Ibu Hamil': 4 };
  assert.equal(vm.runInContext('packageSizeFor("Massage Ibu Hamil")', sb), 4);
});

test('Paket: dibuat dari kwitansi multi-sesi, qty dikalikan, sisa sesi akurat', () => {
  const sb = schedSandbox();
  const pkg = vm.runInContext('createPackageFromReceipt(' + JSON.stringify({
    id: 7, patient_name: 'Bunda Paket', whatsapp: '0812', items: [{ name: 'Newborn Care 5 Days', qty: 1 }]
  }) + ', { source: "kwitansi" })', sb);
  assert.equal(pkg.total_sessions, 5);
  assert.equal(vm.runInContext('packageRemaining(' + JSON.stringify(pkg) + ')', sb), 5);
  pkg.used_sessions.push({ date: '2026-10-01' });
  assert.equal(vm.runInContext('packageRemaining(' + JSON.stringify(pkg) + ')', sb), 4);
  // Sisa tidak pernah negatif walau data aneh
  pkg.used_sessions = [1, 2, 3, 4, 5, 6, 7].map(() => ({ date: '2026-10-01' }));
  assert.equal(vm.runInContext('packageRemaining(' + JSON.stringify(pkg) + ')', sb), 0);
  // qty = 2 paket 5 hari -> 10 sesi
  const p2 = vm.runInContext('createPackageFromReceipt(' + JSON.stringify({
    id: 8, patient_name: 'B', items: [{ name: 'Newborn Care 5 Days', qty: 2 }]
  }) + ', {})', sb);
  assert.equal(p2.total_sessions, 10);
});

test('Paket: layanan biasa tidak membuat catatan paket', () => {
  const sb = schedSandbox();
  const p = vm.runInContext('createPackageFromReceipt(' + JSON.stringify({
    id: 9, patient_name: 'B', items: [{ name: 'Massage Ibu Hamil', qty: 1 }]
  }) + ', {})', sb);
  assert.equal(p, null);
});

test('Pengingat: hanya yang masuk jendela waktu, tidak pernah kirim yang sudah lewat', () => {
  // Waktu "sekarang" di sandbox: 2026-09-22T09:00 WIB (02:00 UTC)
  const nowMs = Date.parse('2026-09-22T02:00:00Z');
  const jam = (hoursFromNow) => {
    const d = new Date(nowMs + hoursFromNow * 3600 * 1000);
    // tanggal & jam dalam WIB
    const wib = new Date(d.getTime() + 7 * 3600 * 1000);
    return { date: wib.toISOString().slice(0, 10), time: String(wib.getUTCHours()).padStart(2, '0') + ':00' };
  };
  const a = jam(3), b = jam(10), c = jam(30), lewat = jam(-2);
  const sandbox = {
    console,
    Date,
    todayJakarta: () => '2026-09-22',
    DB: {
      reservations: [
        rsv(1, a.date, a.time),
        rsv(2, b.date, b.time),
        rsv(3, c.date, c.time),
        rsv(4, lewat.date, lewat.time)
      ],
      packages: [], _seq: { packages: 0 },
      settings: { reminder_enabled: true, reminder_lead_hours: [24, 2] }
    },
    save: () => {},
    nextId: (t) => 1,
    buildWaLink: (phone, text) => 'https://wa.me/628123?text=' + encodeURIComponent(text)
  };
  vm.createContext(sandbox);
  vm.runInContext(block('function reminderLeadHours'), sandbox);
  vm.runInContext(block('function reminderTemplate'), sandbox);
  vm.runInContext(block('function renderReminderText'), sandbox);
  vm.runInContext(block('function dueReminders'), sandbox);
  // "Sekarang" dikunci lewat Date.now tiruan
  sandbox.Date = class extends Date { static now() { return nowMs; } };
  sandbox.Date.parse = Date.parse;

  const due = vm.runInContext('dueReminders()', sandbox);
  const ids = due.map((d) => d.reservation_id).sort();
  assert.deepEqual(Array.from(ids), [1, 2], 'hanya reservasi dalam 24 jam yang jatuh tempo: ' + JSON.stringify(ids));
  assert.ok(!due.some((d) => d.reservation_id === 3), 'reservasi 30 jam ke depan ikut dikirim (terlalu dini)');
  assert.ok(!due.some((d) => d.reservation_id === 4), 'reservasi yang sudah lewat ikut dikirim');
  // lead tertinggi dipakai (24 jam lebih dulu daripada 2 jam)
  const first = due.find((d) => d.reservation_id === 1);
  assert.equal(first.lead_hours, 24);
  assert.match(first.text, /Halo Bunda/);
  assert.ok(!/\{[a-z]+\}/.test(first.text), 'placeholder belum tergantikan: ' + first.text);
  assert.ok(/wa\.me\//.test(first.wa_link));
});

test('Pengingat: bisa dimatikan & menghormati kunci "sudah dikirim"', () => {
  const sandbox = {
    console,
    todayJakarta: () => '2026-09-22',
    DB: {
      reservations: [rsv(1, '2026-09-22', '15:00')],
      packages: [], _seq: {},
      settings: { reminder_enabled: false, reminder_lead_hours: [24] }
    },
    save: () => {}, nextId: () => 1,
    buildWaLink: () => 'https://wa.me/x'
  };
  vm.createContext(sandbox);
  vm.runInContext(block('function reminderLeadHours'), sandbox);
  vm.runInContext(block('function reminderTemplate'), sandbox);
  vm.runInContext(block('function renderReminderText'), sandbox);
  vm.runInContext(block('function dueReminders'), sandbox);
  assert.equal(vm.runInContext('dueReminders().length', sandbox), 0, 'pengingat aktif walau dimatikan');

  sandbox.DB.settings.reminder_enabled = true;
  const due = vm.runInContext('dueReminders()', sandbox);
  if (due.length) {
    sandbox.DB.settings.reminder_sent_keys = { [due[0].key]: new Date().toISOString() };
    const due2 = vm.runInContext('dueReminders()', sandbox);
    assert.equal(due2[0].already_sent, true, 'penanda sudah-dikirim tidak terbaca');
  }
});

test('Pengingat: jam ditampilkan apa adanya & template memakai placeholder resmi', () => {
  const sandbox = { console, todayJakarta: () => '2026-09-22', DB: { reservations: [], settings: {} }, save: () => {}, nextId: () => 1 };
  vm.createContext(sandbox);
  vm.runInContext(block('function reminderLeadHours'), sandbox);
  vm.runInContext(block('function reminderTemplate'), sandbox);
  vm.runInContext(block('function renderReminderText'), sandbox);
  const txt = vm.runInContext('renderReminderText(' + JSON.stringify({
    patient_name: 'Bunda Rina', total: 160000, items: [{ name: 'Massage Ibu Hamil' }]
  }) + ', ' + JSON.stringify({ date: '2026-09-23', time: '09:00' }) + ')', sandbox);
  assert.match(txt, /Bunda Rina/);
  assert.match(txt, /Massage Ibu Hamil/);
  assert.match(txt, /2026-09-23/);
  assert.match(txt, /09:00/);
  assert.ok(!/\{[a-z]+\}/.test(txt), 'placeholder tersisa: ' + txt);
  // Prioritas lead: daftar unik & terurut dari yang paling awal
  sandbox.DB.settings.reminder_lead_hours = [2, 24, 24, 999];
  const leads = Array.from(vm.runInContext('reminderLeadHours()', sandbox));
  assert.deepEqual(leads, [168, 24, 2], 'lead hours tidak unik/terurut/dibatasi: ' + JSON.stringify(leads));
});

test('PWA: manifest & service worker tersedia, API tidak di-cache', () => {
  // Manifest dilayani dari root dengan ikon & shortcut
  assert.match(serverSrc, /app\.get\('\/manifest\.webmanifest'/, 'route manifest hilang');
  assert.match(serverSrc, /app\.get\('\/sw\.js'/, 'route service worker hilang');
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/, 'SW tidak mengecualikan endpoint API');
  assert.match(sw, /startsWith\('\/kwitansi'\)/, 'SW bisa meng-cache halaman kwitansi (data pribadi)');
  assert.match(sw, /stale-while-revalidate|stale-while-revalidate/i, 'strategi cache tidak terdokumentasi');
  assert.match(sw, /notificationclick/, 'klik notifikasi tidak ditangani');
  assert.match(sw, /type === 'notify'/, 'SW tidak menerima perintah notifikasi');
  // Semua halaman publik mendaftarkan SW + manifest
  for (const f of ['public/index.html', 'public/kalender.html', 'public/reservasi.html', 'public/admin.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(html, /serviceWorker[\s\S]{0,80}register\('\/sw\.js'\)/, f + ' tidak mendaftarkan service worker');
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'), /manifest\.webmanifest/, 'beranda tidak menautkan manifest');
  // docs/ ikut sinkron
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8'),
    'docs/sw.js berbeda — jalankan: node build-gh-pages.js'
  );
});

test('Terhubung ke server: bentrok, paket, pengingat dipakai di endpoint yang tepat', () => {
  // Reservasi publik & AI booking memeriksa bentrok
  const pubSection = serverSrc.slice(serverSrc.indexOf("app.post('/api/reservations'"), serverSrc.indexOf("app.get('/api/calendar'"));
  assert.match(pubSection, /const conflicts = findScheduleConflicts\(slots\)/, 'reservasi publik tidak memeriksa bentrok');
  assert.match(pubSection, /sched\.mode === 'block'/, 'mode block tidak dipatuhi');
  assert.match(pubSection, /status\(409\)/, 'penolakan bentrok tidak memakai 409');
  assert.match(serverSrc, /const aiConflicts = findScheduleConflicts\(slots\)/, 'AI booking tidak memeriksa bentrok');
  // Paket otomatis dari kwitansi
  const kwSection = serverSrc.slice(serverSrc.indexOf("app.post('/api/admin/receipts'"), serverSrc.indexOf("app.get('/api/admin/receipts'"));
  assert.match(kwSection, /createPackageFromReceipt/, 'kwitansi tidak membuat catatan paket');
  // Endpoint paket & pengingat terpasang + wajib token
  for (const r of ["app.get('/api/admin/packages', auth", "app.post('/api/admin/packages', auth", "app.post('/api/admin/packages/:id/use', auth", "app.post('/api/admin/packages/:id/undo', auth", "app.delete('/api/admin/packages/:id', auth", "app.get('/api/admin/reminders', auth", "app.post('/api/admin/reminders/sent', auth", "app.post('/api/admin/reminders/send', auth"]) {
    assert.ok(serverSrc.includes(r), 'endpoint tidak terpasang atau tanpa auth: ' + r);
  }
  // Ketersediaan publik
  assert.match(serverSrc, /app\.get\('\/api\/availability'/, 'endpoint ketersediaan hilang');
  // Scheduler pengingat otomatis berjalan berkala
  assert.match(serverSrc, /setInterval\(autoSend, 5 \* 60 \* 1000\)/, 'scheduler pengingat tidak berjalan');
  // Tidak ada key notes duplikat pada objek reservasi publik
  const dupNotes = /notes: String\(b\.notes[\s\S]{0,400}?notes: \[String\(b\.notes/.test(pubSection);
  assert.equal(dupNotes, false, 'masih ada key notes duplikat di objek reservasi');
});
