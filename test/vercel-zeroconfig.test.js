// Uji mode zero-config Vercel: situs HARUS tetap hidup tanpa env apa pun.
//
// LATAR BUG: versi sebelumnya "wajib env" — tanpa JWT_SECRET/ADMIN_EMAIL/
// ADMIN_PASSWORD, boot() melempar error sehingga api/index.js membalas
// {"error":"Server belum siap..."} untuk SEMUA rute /api/* di vercel.app.
// Katalog, reservasi, kalender, dan pengaturan publik ikut mati — terlihat
// seperti "banyak fitur hilang".
//
// Setiap skenario dijalankan di proses Node terpisah (env dibaca saat
// server.js dimuat) dan memakai api/index.js persis seperti Vercel:
// VERCEL=1, NODE_ENV kosong (api/index.js mengisinya 'production').
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// Jalankan api/index.js di balik http.createServer — tiruan runtime Vercel.
const RUNNER = `
const http = require('http');
const handler = require(${JSON.stringify(path.join(ROOT, 'api', 'index.js'))});
const srv = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((e) => { res.statusCode = 500; res.end(String(e)); });
});
srv.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('RUNNER_READY'));
`;

// Env yang harus dibersihkan supaya tes tidak ikut env mesin pengembang.
const CLEAN_KEYS = ['JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'DATABASE_URL', 'DATA_FILE',
  'NODE_ENV', 'RAILWAY_VOLUME_MOUNT_PATH', 'RAILWAY_VOLUME_MOUNT_DIR', 'RESET_ADMIN_PASSWORD'];

async function startVercel(t, extraEnv) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-zc-'));
  const env = { ...process.env };
  for (const k of CLEAN_KEYS) delete env[k];
  const port = await freePort();
  Object.assign(env, { VERCEL: '1', PORT: String(port), TMPDIR: tmp, TMP: tmp, TEMP: tmp }, extraEnv || {});
  const child = spawn(process.execPath, ['-e', RUNNER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const deadline = Date.now() + 20000;
  while (!logs.includes('RUNNER_READY')) {
    if (child.exitCode !== null) throw new Error('runner berhenti:\n' + logs);
    if (Date.now() > deadline) throw new Error('runner tidak siap:\n' + logs);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { base: `http://127.0.0.1:${port}`, logs: () => logs, tmp };
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}

function reservationBody(name, wa, time) {
  const date = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return JSON.stringify({
    patient_name: name, whatsapp: wa, address: 'Jl. Uji Zero Config 1, Cilacap',
    payment_method: 'COD',
    items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]),
    slots: JSON.stringify([{ date, time }])
  });
}

test('Zero-config: TANPA env apa pun, fitur publik tetap hidup & login admin ditutup 503', { timeout: 60000 }, async (t) => {
  const s = await startVercel(t, {});

  // /api/health & /health: JSON ok (BUKAN lagi "Server belum siap").
  for (const p of ['/api/health', '/health']) {
    const h = await getJson(s.base + p);
    assert.equal(h.status, 200, p + ' harus 200: ' + JSON.stringify(h.body));
    assert.equal(h.body.ok, true);
    assert.ok(Array.isArray(h.body.warnings) && h.body.warnings.length >= 2, 'warnings harus menjelaskan env yang kurang');
    assert.ok(h.body.warnings.some((w) => /DATABASE_URL/.test(w)));
    assert.ok(h.body.warnings.some((w) => /JWT_SECRET/.test(w)));
    assert.equal(h.body.admin_login, 'disabled');
    assert.equal(h.body.jwt_secret_source, 'random');
    assert.equal(h.body.storage, 'file');
    assert.ok(!/password_hash|"password"\s*:/.test(JSON.stringify(h.body)), '/health tidak boleh memuat kredensial');
  }

  const svcs = await getJson(s.base + '/api/services');
  assert.equal(svcs.status, 200);
  assert.ok(Array.isArray(svcs.body) && svcs.body.length >= 8, 'katalog ≥8 layanan');

  const ps = await getJson(s.base + '/api/public-settings');
  assert.equal(ps.status, 200);
  assert.equal(ps.body.business_name, 'Adzkiya Mom Baby Care');

  const cal = await getJson(s.base + '/api/calendar');
  assert.equal(cal.status, 200);
  assert.ok(Array.isArray(cal.body));

  // Reservasi diterima + storage_warning (penyimpanan sementara).
  const post = await getJson(s.base + '/api/reservations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: reservationBody('Bunda Zero Config', '081200000031', '09:00')
  });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.equal(post.body.ok, true);
  assert.match(String(post.body.storage_warning || ''), /WhatsApp/);

  // Login admin: 503 dengan pesan jelas (kunci acak per proses tidak aman
  // antar instance) — ini perilaku yang BENAR, bukan bug.
  const login = await getJson(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@adzkiya.id', password: 'apa-saja-12345' })
  });
  assert.equal(login.status, 503);
  assert.equal(login.body.code, 'ADMIN_LOGIN_UNAVAILABLE');
  assert.match(login.body.error, /JWT_SECRET/);

  // Rute admin tetap terkunci.
  const adm = await getJson(s.base + '/api/admin/reservations');
  assert.equal(adm.status, 401);

  // Beranda utuh.
  const home = await fetch(s.base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Adzkiya Mom Baby Care/);
});

test('Zero-config: JWT_SECRET ada, admin env kosong → akun admin sementara (password hanya di log)', { timeout: 60000 }, async (t) => {
  const s = await startVercel(t, { JWT_SECRET: 'zeroconfig-test-secret-lebih-dari-32-karakter' });
  const h = await getJson(s.base + '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.jwt_secret_source, 'env');
  assert.equal(h.body.admin_login, 'temporary');
  assert.ok(h.body.warnings.some((w) => /sementara/.test(w)));

  const m = s.logs().match(/password : (\S+)/);
  assert.ok(m, 'password sementara harus tercetak di log deployment:\n' + s.logs());
  assert.ok(m[1].length >= 12, 'password sementara cukup panjang');
  assert.ok(!JSON.stringify(h.body).includes(m[1]), 'password TIDAK boleh bocor di /health');

  const bad = await getJson(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@adzkiya.id', password: 'admin123' })
  });
  assert.equal(bad.status, 401, 'password bawaan lokal TIDAK boleh berlaku di production');

  const ok = await getJson(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@adzkiya.id', password: m[1] })
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
  const rows = await getJson(s.base + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + ok.body.token } });
  assert.equal(rows.status, 200);
});

test('Zero-config: admin env kosong tapi akun sudah tersimpan → akun lama dipakai', { timeout: 60000 }, async (t) => {
  const bcrypt = require('bcryptjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-zc-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'state.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    admins: [{ id: 1, email: 'pemilik@adzkiya.id', password_hash: bcrypt.hashSync('password-lama-aman-123', 4), name: 'Pemilik', role: 'super' }],
    _seq: { admins: 1 }
  }));
  const s = await startVercel(t, { JWT_SECRET: 'zeroconfig-test-secret-lebih-dari-32-karakter', DATA_FILE: dataFile });
  const h = await getJson(s.base + '/api/health');
  assert.equal(h.body.admin_login, 'existing');
  assert.ok(!/password : /.test(s.logs()), 'tidak boleh membuat akun sementara bila akun lama ada');
  const ok = await getJson(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pemilik@adzkiya.id', password: 'password-lama-aman-123' })
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('Zero-config: ADMIN_PASSWORD pendek tidak mematikan situs (diabaikan + peringatan)', { timeout: 60000 }, async (t) => {
  const s = await startVercel(t, {
    JWT_SECRET: 'zeroconfig-test-secret-lebih-dari-32-karakter',
    ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'pendek'
  });
  const h = await getJson(s.base + '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.admin_login, 'temporary');
  assert.ok(h.body.warnings.some((w) => /12 karakter/.test(w)));
  const weak = await getJson(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'pendek' })
  });
  assert.equal(weak.status, 401, 'password lemah dari env TIDAK boleh bisa dipakai login');
});

test('JWT_SECRET pendek di production TETAP gagal keras (dengan pesan JSON jelas)', { timeout: 60000 }, async (t) => {
  const s = await startVercel(t, { JWT_SECRET: 'terlalu-pendek' });
  const h = await getJson(s.base + '/api/health');
  assert.equal(h.status, 500);
  assert.equal(h.body.ok, false);
  assert.match(h.body.error, /32 karakter/);
  assert.match(h.body.detail, /JWT_SECRET/);
  const svcs = await getJson(s.base + '/api/services');
  assert.equal(svcs.status, 500, 'salah konfigurasi berbahaya tidak boleh dilayani diam-diam');
});

test('Env lengkap: admin_login=env, tanpa peringatan admin/JWT', { timeout: 60000 }, async (t) => {
  const s = await startVercel(t, {
    JWT_SECRET: 'zeroconfig-test-secret-lebih-dari-32-karakter',
    ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'very-secure-test-password'
  });
  const h = await getJson(s.base + '/api/health');
  assert.equal(h.body.admin_login, 'env');
  assert.equal(h.body.jwt_secret_source, 'env');
  assert.ok(!h.body.warnings.some((w) => /JWT_SECRET|ADMIN_/.test(w)), JSON.stringify(h.body.warnings));
  // Tanpa DATABASE_URL tetap diingatkan soal penyimpanan.
  assert.ok(h.body.warnings.some((w) => /DATABASE_URL/.test(w)));
  const ok = await getJson(s.base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
  });
  assert.equal(ok.status, 200);
});

test('pgSslFor: SSL tidak dipaksakan ke PostgreSQL lokal / sslmode=disable', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = src.indexOf('function pgSslFor(');
  assert.ok(start > 0, 'pgSslFor harus ada di server.js');
  const end = src.indexOf('\n}\n', start);
  const fnSrc = src.slice(start, end + 3);
  function load(isProd) {
    const sandbox = { IS_PRODUCTION: isProd, URL };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nthis.pgSslFor = pgSslFor;', sandbox);
    return sandbox.pgSslFor;
  }
  const prod = load(true);
  assert.equal(prod('postgresql://u:p@127.0.0.1:5432/db'), false);
  assert.equal(prod('postgresql://u:p@localhost/db'), false);
  assert.equal(prod('postgresql://u:p@[::1]:5432/db'), false);
  assert.equal(prod('postgresql://u:p@db.example.com/db?sslmode=disable'), false);
  assert.deepEqual({ ...prod('postgresql://u:p@ep-x.neon.tech/db?sslmode=require') }, { rejectUnauthorized: false });
  const dev = load(false);
  assert.equal(dev('postgresql://u:p@ep-x.neon.tech/db'), undefined);
  assert.equal(dev('postgresql://u:p@127.0.0.1/db'), false);
});

test('Formulir reservasi menampilkan storage_warning & schedule_warning (ter-escape)', () => {
  for (const f of ['public/reservasi.html', 'docs/reservasi.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(html, /data\.storage_warning/, f + ' harus menampilkan storage_warning');
    assert.match(html, /data\.schedule_warning/, f + ' harus menampilkan schedule_warning');
    assert.match(html, /escHtml\(data\.storage_warning\)/, f + ' harus meng-escape pesan server');
  }
});
