// Uji deployment Vercel (api/index.js + vercel.json + mode VERCEL di server.js).
//
// Latar: sebelum perbaikan ini, Vercel hanya menyajikan public/ secara statis
// (tidak ada function, tidak ada API) sehingga semua fitur dinamis hilang di
// vercel.app. Tes ini mengunci perbaikannya:
//   1. vercel.json me-rewrite SEMUA rute dinamis ke function api/index.js.
//   2. Cron di vercel.json aman untuk paket Hobby (1x/hari) dan routenya ada.
//   3. require('./server.js') dengan VERCEL=1 TIDAK memanggil app.listen(),
//      boot dipicu manual lewat ensureBooted(), dan aplikasi tetap berfungsi
//      penuh (health, katalog, reservasi, login admin, cron) saat dipasang
//      ke port secara manual — persis cara api/index.js memakainya.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('vercel.json valid & mengarahkan semua rute dinamis ke api/index.js', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.rewrites) && cfg.rewrites.length >= 7, 'rewrites minimal 7');
  for (const src of [
    '/api/(.*)',
    '/health',
    '/manifest.webmanifest',
    '/sitemap.xml',
    '/robots.txt',
    '/kwitansi/(.*)',
    '/kwitansi-share.html'
  ]) {
    const hit = cfg.rewrites.find((r) => r.source === src);
    assert.ok(hit, 'rewrite untuk ' + src + ' harus ada');
    assert.equal(hit.destination, '/api/index.js', src + ' harus menuju function');
  }
  // /admin diarahkan ke halaman statis (bukan function) dengan header keamanan.
  assert.ok((cfg.redirects || []).some((r) => r.source === '/admin' && r.destination === '/admin.html'),
    '/admin harus di-redirect ke /admin.html');
  const adminHeaders = (cfg.headers || []).find((h) => h.source === '/admin.html');
  assert.ok(adminHeaders, 'header keamanan /admin.html harus ada');
  const headerMap = Object.fromEntries(adminHeaders.headers.map((h) => [h.key, h.value]));
  assert.match(headerMap['X-Robots-Tag'] || '', /noindex/);
  assert.equal(headerMap['X-Frame-Options'], 'DENY');
});

test('cron vercel.json aman untuk Hobby (1x/hari) & routenya ada di server.js', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(Array.isArray(cfg.crons) && cfg.crons.length >= 1, 'minimal satu cron');
  for (const c of cfg.crons) {
    assert.ok(c.path.startsWith('/'), 'path cron harus absolut');
    assert.ok(serverSrc.includes(`'${c.path}'`), 'route cron ' + c.path + ' harus terdaftar di server.js');
    const f = String(c.schedule).trim().split(/\s+/);
    assert.equal(f.length, 5, 'ekspresi cron 5 field: ' + c.schedule);
    // Hobby melarang ekspresi yang berjalan >1x/hari.
    assert.equal(f[2], '*', 'day-of-month harus * (' + c.schedule + ')');
    assert.equal(f[3], '*', 'bulan harus * (' + c.schedule + ')');
    assert.equal(f[4], '*', 'day-of-week harus * (' + c.schedule + ')');
    assert.notEqual(f[0], '*', 'menit harus eksplisit (' + c.schedule + ')');
    assert.notEqual(f[1], '*', 'jam harus eksplisit — 1x/hari (' + c.schedule + ')');
  }
});

test('api/index.js & server.js punya pengait mode Vercel', () => {
  const entry = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(entry, /require\('\.\.\/server\.js'\)/, 'entry harus me-require server.js');
  assert.match(entry, /ensureBooted/, 'entry harus memicu ensureBooted');
  assert.match(entry, /NODE_ENV\s*=\s*'production'/, 'NODE_ENV harus dijamin terisi di Vercel');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /module\.exports = app;/, 'server.js harus mengekspor app');
  assert.match(serverSrc, /if \(RUNNING_ON_VERCEL\)/, 'auto-boot harus dilindungi guard VERCEL');
  assert.match(serverSrc, /RUNNING_ON_VERCEL \? 4 \* 1024 \* 1024 : 5 \* 1024 \* 1024/,
    'batas unggah harus mengikuti batas body 4,5 MB Vercel');
  assert.match(serverSrc, /adzkiya-state\.json/, 'fallback file Vercel harus ke /tmp');
});

test('Mode VERCEL=1: tidak listen saat require; aplikasi penuh jalan setelah ensureBooted', { timeout: 30000 }, async (t) => {
  process.env.VERCEL = '1';
  delete process.env.NODE_ENV;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-vercel-'));
  process.env.DATA_FILE = path.join(dir, 'state.json');
  process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters';
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'very-secure-test-password';

  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  let mod;
  try {
    mod = require('../server.js');
  } finally {
    console.log = origLog;
  }
  assert.equal(typeof mod.ensureBooted, 'function', 'ensureBooted harus diekspor');
  assert.equal(typeof mod.startBackgroundJobs, 'function', 'startBackgroundJobs harus diekspor');
  assert.ok(logs.some((l) => l.includes('Mode Vercel Function')), 'harus mencatat bahwa listen dilewati');
  assert.ok(!logs.some((l) => l.includes('on 0.0.0.0')), 'TIDAK boleh ada app.listen saat require');

  await mod.ensureBooted();

  const port = await freePort();
  const server = mod.listen(port, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;

  // Health: mode file ke DATA_FILE sementara (filesystem Vercel).
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.storage, 'file');
  assert.equal(health.data_file, 'state.json');

  // Katalog publik + pengaturan ter-seed.
  const svcs = await (await fetch(base + '/api/services')).json();
  assert.ok(Array.isArray(svcs) && svcs.length >= 8, 'katalog layanan terisi');
  const settings = await (await fetch(base + '/api/public-settings')).json();
  assert.equal(settings.business_name, 'Adzkiya Mom Baby Care');
  assert.ok(Array.isArray(settings.hours) && settings.hours.length === 7, 'jam operasional ter-seed');

  // Reservasi end-to-end (seperti dikirim form publik).
  const date = new Date(Date.now() + 26 * 3600 * 1000).toISOString().slice(0, 10);
  const post = await fetch(base + '/api/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient_name: 'Bunda Uji Vercel',
      whatsapp: '081200000001',
      address: 'Jl. Uji 1, Cilacap',
      payment_method: 'COD',
      items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]),
      slots: JSON.stringify([{ date, time: '09:00' }])
    })
  });
  assert.equal(post.status, 201, 'reservasi harus diterima');
  const created = await post.json();
  assert.ok(created.id >= 1);
  assert.equal(created.total, 80000);

  // Kalender publik menampilkan reservasi approved saja — masih kosong.
  const cal = await (await fetch(base + '/api/calendar')).json();
  assert.ok(Array.isArray(cal) && cal.length === 0);

  // Admin login + lihat reservasi (datanya milik proses yang sama).
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  const rows = await (await fetch(base + '/api/admin/reservations', {
    headers: { Authorization: 'Bearer ' + token }
  })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].patient_name, 'Bunda Uji Vercel');

  // State tersimpan ke DATA_FILE (persistSnapshot aman-/tmp).
  const saved = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  assert.equal(saved.reservations.length, 1, 'state harus ter-persist ke file');
  assert.equal(saved._seq.reservations, 1);

  // Endpoint cron merespons dengan benar (tanpa kredensial WA → dilewati).
  const cron = await (await fetch(base + '/api/cron/reminders')).json();
  assert.equal(cron.ok, true);
  assert.equal(cron.skipped, 'wa_credentials_missing');

  // Halaman statis utama dilayani dari function juga (fallback express.static).
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Adzkiya Mom Baby Care/);
});
