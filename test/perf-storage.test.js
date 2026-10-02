// Uji regresi optimasi kecepatan & keandalan penyimpanan (1 Oktober 2026).
//
// Tanpa database (selalu jalan):
//   1. Simpan-sebelum-respons (mode Vercel): saat 201 diterima, reservasi
//      SUDAH ada di penyimpanan — dulu masih menunggu timer 200 ms yang bisa
//      dibekukan Vercel setelah respons terkirim.
//   2. Simpan gagal → 503, bukan 2xx palsu.
//   3. Header cache edge (Vercel CDN) hanya untuk endpoint publik, selalu
//      dengan `Vary: Origin`; endpoint admin tetap no-store.
//   4. exceljs/mysql2 tidak dimuat saat boot (cold start), ekspor Excel
//      tetap berfungsi.
//   5. Webhook WhatsApp mendaftarkan pekerjaan latar ke waitUntil Vercel.
//
// Dengan PostgreSQL sungguhan (TEST_PG_URL, seperti pg-multiinstance):
//   6. Bukti transfer disimpan di tabel app_blobs, BUKAN di blob state.
//   7. Bukti lama (inline) dimigrasikan otomatis saat simpan berikutnya.
//   8. Pindah database dari panel membawa bukti transfer.
//   9. Refresh bacaan tidak mengunduh blob bila rev tidak berubah.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_PG_URL = process.env.TEST_PG_URL || '';
const ADMIN = { email: 'admin@test.local', password: 'very-secure-test-password' };

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

function futureDate(days) {
  return new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
}

async function startServer(t, extraEnv = {}, nodeArgs = []) {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-perf-'));
  const env = { ...process.env };
  for (const k of ['DATABASE_URL', 'VERCEL', 'NODE_ENV', 'ALLOWED_ORIGINS', 'PERSIST_BEFORE_RESPONSE']) delete env[k];
  Object.assign(env, {
    PORT: String(port), DATA_FILE: path.join(tmp, 'state.json'),
    JWT_SECRET: 'perf-test-secret-lebih-dari-tiga-puluh-dua-karakter',
    ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password
  }, extraEnv);
  const child = spawn(process.execPath, [...nodeArgs, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server berhenti:\n' + logs);
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('server tidak siap:\n' + logs);
    await new Promise((r) => setTimeout(r, 80));
  }
  return { base, tmp, env, logs: () => logs, child };
}

async function login(base) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
  const j = await r.json();
  assert.ok(j.token, 'login admin: ' + JSON.stringify(j));
  return { Authorization: 'Bearer ' + j.token };
}

function reservationForm(name, time, proof) {
  const f = new FormData();
  f.set('patient_name', name); f.set('whatsapp', '0812' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'));
  f.set('address', 'Jl. Uji'); f.set('payment_method', proof ? 'Transfer' : 'COD');
  f.set('items', JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]));
  f.set('slots', JSON.stringify([{ date: futureDate(6), time }]));
  if (proof) f.append('proof', new Blob([proof], { type: 'image/png' }), 'bukti.png');
  return f;
}

function pngBytes(n) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
}

// ---------------------------------------------------------------------------

test('Simpan-sebelum-respons: saat 201 diterima reservasi SUDAH tersimpan', async (t) => {
  const s = await startServer(t, { PERSIST_BEFORE_RESPONSE: '1' });
  const r = await fetch(s.base + '/api/reservations', { method: 'POST', body: reservationForm('Bunda Persist', '09:00') });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  // Dibaca SEGERA — tanpa menunggu timer simpan.
  const state = JSON.parse(fs.readFileSync(path.join(s.tmp, 'state.json'), 'utf8'));
  assert.ok(state.reservations.some((x) => x.id === id && x.patient_name === 'Bunda Persist'), 'reservasi belum ada di penyimpanan saat respons diterima');
  // Tulisan admin juga.
  const H = await login(s.base);
  const p = await fetch(s.base + '/api/admin/reservations/' + id, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) });
  assert.equal(p.status, 200);
  const state2 = JSON.parse(fs.readFileSync(path.join(s.tmp, 'state.json'), 'utf8'));
  assert.equal(state2.reservations.find((x) => x.id === id).status, 'approved');
});

test('Simpan-sebelum-respons: simpan gagal → 503 (bukan 2xx palsu)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-perf-bad-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Induk DATA_FILE berupa FILE biasa → penulisan pasti gagal (ENOTDIR).
  fs.writeFileSync(path.join(tmp, 'bukan-folder'), 'x');
  const s = await startServer(t, { PERSIST_BEFORE_RESPONSE: '1', DATA_FILE: path.join(tmp, 'bukan-folder', 'state.json') });
  const r = await fetch(s.base + '/api/reservations', { method: 'POST', body: reservationForm('Bunda Gagal', '10:00') });
  const body = await r.json();
  assert.equal(r.status, 503, JSON.stringify(body));
  assert.match(body.error, /belum tersimpan/);
  // GET tidak terpengaruh.
  assert.equal((await fetch(s.base + '/api/services')).status, 200);
});

test('Cache edge Vercel: hanya endpoint publik, selalu Vary: Origin; admin tetap no-store', async (t) => {
  const s = await startServer(t);
  const H = await login(s.base);
  // Logo agar /api/logo tersedia.
  const f = new FormData();
  f.set('kind', 'logo');
  f.append('file', new Blob([pngBytes(64)], { type: 'image/png' }), 'logo.png');
  assert.equal((await fetch(s.base + '/api/admin/settings/upload', { method: 'POST', headers: H, body: f })).status, 200);
  for (const ep of ['/api/services', '/api/public-settings', '/api/business', '/api/calendar', '/api/logo']) {
    for (const origin of [null, 'https://putra1996.github.io']) {
      const r = await fetch(s.base + ep, origin ? { headers: { Origin: origin } } : {});
      assert.equal(r.status, 200, ep);
      assert.match(r.headers.get('vercel-cdn-cache-control') || '', /s-maxage=\d+, stale-while-revalidate=\d+/, ep + ' tanpa cache edge');
      assert.match(r.headers.get('vary') || '', /\bOrigin\b/i, ep + ' wajib Vary: Origin (origin=' + origin + ')');
      assert.doesNotMatch(r.headers.get('cache-control') || '', /private|no-store/, ep);
      if (origin) assert.equal(r.headers.get('access-control-allow-origin'), origin, ep + ' CORS GitHub Pages');
    }
  }
  // Pengaturan publik cepat segar (≤ 10 dtk di edge), katalog statis lama.
  assert.match((await fetch(s.base + '/api/public-settings')).headers.get('vercel-cdn-cache-control'), /s-maxage=10,/);
  assert.match((await fetch(s.base + '/api/services')).headers.get('vercel-cdn-cache-control'), /s-maxage=86400,/);
  // Data pribadi TIDAK PERNAH di-cache edge.
  for (const ep of ['/api/admin/reservations', '/api/admin/settings', '/api/admin/stats']) {
    const r = await fetch(s.base + ep, { headers: H });
    assert.equal(r.status, 200, ep);
    assert.equal(r.headers.get('vercel-cdn-cache-control'), null, ep);
    assert.match(r.headers.get('cache-control') || '', /no-store/, ep);
  }
  // Respons error tidak di-cache.
  const nf = await fetch(s.base + '/api/hero');
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('vercel-cdn-cache-control'), null);
});

test('Cold start: exceljs & mysql2 tidak dimuat saat boot; ekspor Excel tetap jalan', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-perf-req-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const probe = path.join(tmp, 'probe.js');
  fs.writeFileSync(probe, `
    process.env.DATA_FILE = ${JSON.stringify(path.join(tmp, 's.json'))};
    process.env.JWT_SECRET = 'x'.repeat(40); process.env.PORT = '0';
    delete process.env.DATABASE_URL; delete process.env.VERCEL;
    require(${JSON.stringify(path.join(ROOT, 'server.js'))});
    const loaded = Object.keys(require.cache).filter((k) => /node_modules[\\\\/](exceljs|mysql2)[\\\\/]/.test(k));
    console.log('LOADED=' + JSON.stringify(loaded.length));
    process.exit(0);
  `);
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [probe], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
    c.on('exit', () => resolve(o));
  });
  assert.match(out, /LOADED=0/, 'exceljs/mysql2 dimuat saat boot:\n' + out);

  const s = await startServer(t);
  const H = await login(s.base);
  const r = await fetch(s.base + '/api/admin/recap.xlsx', { headers: H });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'berkas xlsx (zip) valid');
});

test('Webhook WhatsApp: pekerjaan setelah 200 didaftarkan ke waitUntil Vercel', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-perf-wu-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const logFile = path.join(tmp, 'waituntil.log');
  const hook = path.join(tmp, 'ctx.js');
  // Tiruan konteks request Vercel (sama dengan yang dibaca @vercel/functions).
  fs.writeFileSync(hook, `
    const fs = require('fs');
    globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({
      waitUntil: (p) => { fs.appendFileSync(${JSON.stringify(logFile)}, 'daftar\\n'); p.then(() => fs.appendFileSync(${JSON.stringify(logFile)}, 'selesai\\n')); }
    }) };
  `);
  const s = await startServer(t, {}, ['--require', hook]);
  const r = await fetch(s.base + '/api/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '6281200000001', type: 'text', text: { body: 'halo' } }] } }] }] })
  });
  assert.equal(r.status, 200);
  const deadline = Date.now() + 5000;
  let log = '';
  while (Date.now() < deadline) {
    log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (/selesai/.test(log)) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.match(log, /daftar/, 'webhook tidak memanggil waitUntil');
  assert.match(log, /selesai/, 'promise waitUntil tidak pernah selesai');
});

// ---------------------------------------------------------------------------
// PostgreSQL sungguhan
// ---------------------------------------------------------------------------
const pgSkip = TEST_PG_URL ? false : 'TEST_PG_URL tidak diisi (lihat pg-multiinstance.test.js)';

async function pgPool(url) {
  const { Pool } = require('pg');
  return new Pool({ connectionString: url });
}

async function resetPg(url) {
  const pool = await pgPool(url);
  await pool.query('DROP TABLE IF EXISTS app_state; DROP TABLE IF EXISTS app_blobs; DROP TABLE IF EXISTS share_tokens');
  return pool;
}

test('PG: bukti transfer disimpan di app_blobs, bukan di blob state; dibaca & dihapus benar', { skip: pgSkip, timeout: 60000 }, async (t) => {
  const pool = await resetPg(TEST_PG_URL);
  t.after(() => pool.end());
  const s = await startServer(t, { DATABASE_URL: TEST_PG_URL, PERSIST_BEFORE_RESPONSE: '1' });
  const proof = pngBytes(200 * 1024);
  const r = await fetch(s.base + '/api/reservations', { method: 'POST', body: reservationForm('Bunda Bukti', '11:00', proof) });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  const b64 = proof.toString('base64');
  const st = (await pool.query('SELECT data::text AS t FROM app_state WHERE id = 1')).rows[0].t;
  assert.ok(!st.includes(b64.slice(0, 2000)), 'bukti masih tersimpan di blob state');
  assert.ok(st.length < 60 * 1024, 'blob state tetap kecil (logo & bukti di app_blobs): ' + st.length);
  const res = JSON.parse(st).reservations.find((x) => x.id === id);
  assert.match(res.proof_ref, /^proof_/);
  assert.equal(res.proof_b64, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_blobs WHERE k = $1', [res.proof_ref])).rows[0].n, 1);
  const H = await login(s.base);
  const list = await (await fetch(s.base + '/api/admin/reservations', { headers: H })).json();
  assert.equal(list.find((x) => x.id === id).proof_file, '/api/proof/' + id, 'panel tetap melihat tautan bukti');
  const pf = await fetch(s.base + '/api/proof/' + id, { headers: H });
  assert.equal(pf.status, 200);
  assert.equal(pf.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await pf.arrayBuffer()).equals(proof), 'isi bukti identik');
  assert.equal((await fetch(s.base + '/api/proof/' + id)).status, 401);
  assert.equal((await fetch(s.base + '/api/admin/reservations/' + id, { method: 'DELETE', headers: H })).status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_blobs WHERE k = $1', [res.proof_ref])).rows[0].n, 0, 'blob ikut terhapus');
});

test('PG: bukti lama (inline di blob) dimigrasikan otomatis dan tetap bisa dibuka', { skip: pgSkip, timeout: 60000 }, async (t) => {
  const pool = await resetPg(TEST_PG_URL);
  t.after(() => pool.end());
  // Boot sekali untuk membuat tabel + seed, lalu sisipkan 12 bukti inline
  // (seperti data sebelum perbaikan).
  let s = await startServer(t, { DATABASE_URL: TEST_PG_URL });
  s.child.kill('SIGTERM');
  await new Promise((r) => s.child.once('exit', r));
  const st = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  const proofs = {};
  for (let i = 1; i <= 12; i++) {
    const buf = pngBytes(50 * 1024);
    proofs[i] = buf;
    st.reservations.push({ id: i, patient_name: 'Lama ' + i, whatsapp: '0812', address: 'x', items: [{ name: 'Massage Ibu Hamil', price: 80000, qty: 1 }],
      slots: [{ date: '2026-01-0' + (1 + (i % 9)), time: '09:00' }], reservation_date: '2026-01-0' + (1 + (i % 9)), reservation_time: '09:00',
      total: 80000 + i, payment_method: 'Transfer', status: 'approved', payment_status: 'lunas', created_at: new Date().toISOString(),
      proof_mime: 'image/png', proof_b64: buf.toString('base64') });
  }
  st._seq = { ...(st._seq || {}), reservations: 12 };
  await pool.query('UPDATE app_state SET data = $1::jsonb, rev = rev + 1 WHERE id = 1', [JSON.stringify(st)]);
  s = await startServer(t, { DATABASE_URL: TEST_PG_URL, PERSIST_BEFORE_RESPONSE: '1' });
  const H = await login(s.base);
  // Sebelum migrasi pun bukti bisa dibuka (jalur lama).
  assert.ok(Buffer.from(await (await fetch(s.base + '/api/proof/3', { headers: H })).arrayBuffer()).equals(proofs[3]));
  // Dua tulisan → dua batch migrasi (10 + 2).
  for (const st2 of ['pending', 'approved']) {
    assert.equal((await fetch(s.base + '/api/admin/reservations/1', { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: st2 }) })).status, 200);
  }
  const after = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  assert.equal(after.reservations.filter((x) => x.proof_b64).length, 0, 'masih ada bukti inline');
  assert.equal(after.reservations.filter((x) => x.proof_ref).length, 12);
  for (const i of [1, 7, 12]) {
    const pf = await fetch(s.base + '/api/proof/' + i, { headers: H });
    assert.equal(pf.status, 200);
    assert.ok(Buffer.from(await pf.arrayBuffer()).equals(proofs[i]), 'bukti #' + i + ' identik setelah migrasi');
  }
});

test('PG: pindah database dari panel membawa bukti transfer (app_blobs)', { skip: pgSkip, timeout: 60000 }, async (t) => {
  const pool = await resetPg(TEST_PG_URL);
  t.after(() => pool.end());
  // Database tujuan kedua di server PostgreSQL yang sama.
  const u = new URL(TEST_PG_URL);
  const targetDb = u.pathname.slice(1) + '_pindah';
  try { await pool.query('CREATE DATABASE ' + targetDb); } catch (e) { /* sudah ada */ }
  const u2 = new URL(TEST_PG_URL); u2.pathname = '/' + targetDb;
  const pool2 = await resetPg(u2.toString());
  t.after(() => pool2.end());
  const s = await startServer(t, { DATABASE_URL: TEST_PG_URL, PERSIST_BEFORE_RESPONSE: '1' });
  const proof = pngBytes(80 * 1024);
  const r = await fetch(s.base + '/api/reservations', { method: 'POST', body: reservationForm('Bunda Pindah', '13:00', proof) });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  const H = await login(s.base);
  const ap = await fetch(s.base + '/api/admin/storage/apply-connection', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u2.toString(), confirm: 'PAKAI' }) });
  assert.equal(ap.status, 200, await ap.clone().text());
  // Satu tulisan lagi agar bukti dipindah ke app_blobs database baru.
  await fetch(s.base + '/api/admin/reservations/' + id, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) });
  const pf = await fetch(s.base + '/api/proof/' + id, { headers: H });
  assert.equal(pf.status, 200);
  assert.ok(Buffer.from(await pf.arrayBuffer()).equals(proof), 'bukti hilang setelah pindah database');
  const st2 = (await pool2.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  const rec = st2.reservations.find((x) => x.patient_name === 'Bunda Pindah');
  assert.ok(rec && rec.proof_ref, 'reservasi + rujukan bukti ada di database baru');
  assert.equal((await pool2.query('SELECT count(*)::int AS n FROM app_blobs WHERE k = $1', [rec.proof_ref])).rows[0].n, 1, 'bukti tersimpan di app_blobs database baru');
});

test('PG: refresh bacaan tidak mengunduh blob bila rev tidak berubah', { skip: pgSkip, timeout: 60000 }, async (t) => {
  const pool = await resetPg(TEST_PG_URL);
  t.after(() => pool.end());
  const s = await startServer(t, { DATABASE_URL: TEST_PG_URL });
  // Hitung query lewat pg_stat_statements tidak tersedia di semua server —
  // cukup ukur lewat statistik tabel: seq/idx scan tetap terjadi untuk SELECT
  // rev, jadi yang dibandingkan adalah BYTE yang dikirim: pakai
  // pg_stat_activity tidak praktis. Pendekatan: ganti isi blob langsung di DB
  // TANPA menaikkan rev → instance TIDAK boleh melihatnya (bukti bahwa blob
  // tidak diunduh); lalu naikkan rev → perubahan terlihat.
  const st = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  st.settings.business_name = 'Nama Diam-diam';
  await pool.query('UPDATE app_state SET data = $1::jsonb WHERE id = 1', [JSON.stringify(st)]);
  await new Promise((r) => setTimeout(r, 5300)); // lewati TTL refresh
  assert.notEqual((await (await fetch(s.base + '/api/public-settings')).json()).business_name, 'Nama Diam-diam', 'blob diunduh walau rev sama');
  await pool.query('UPDATE app_state SET rev = rev + 1 WHERE id = 1');
  await new Promise((r) => setTimeout(r, 5300));
  assert.equal((await (await fetch(s.base + '/api/public-settings')).json()).business_name, 'Nama Diam-diam', 'perubahan instance lain tidak terlihat setelah rev naik');
});

test('PG: logo/hero/QRIS di app_blobs; backup tetap memuat gambar; hapus gambar bekerja', { skip: pgSkip, timeout: 60000 }, async (t) => {
  const pool = await resetPg(TEST_PG_URL);
  t.after(() => pool.end());
  const s = await startServer(t, { DATABASE_URL: TEST_PG_URL, PERSIST_BEFORE_RESPONSE: '1' });
  const H = await login(s.base);
  const hero = pngBytes(300 * 1024);
  const f = new FormData();
  f.set('kind', 'hero');
  f.append('file', new Blob([hero], { type: 'image/png' }), 'hero.png');
  assert.equal((await fetch(s.base + '/api/admin/settings/upload', { method: 'POST', headers: H, body: f })).status, 200);
  const st = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  assert.equal(st.settings.hero_b64, null);
  assert.equal(st.settings.logo_b64, null);
  assert.match(st.settings.hero_ref, /^img_hero_/);
  assert.match(st.settings.logo_ref, /^img_logo_/);
  assert.ok(JSON.stringify(st).length < 60 * 1024, 'blob state kecil: ' + JSON.stringify(st).length);
  // Dilayani identik; logo bawaan = seed-logo.png baru.
  const hr = await fetch(s.base + '/api/hero');
  assert.equal(hr.status, 200);
  assert.ok(Buffer.from(await hr.arrayBuffer()).equals(hero));
  const lg = Buffer.from(await (await fetch(s.base + '/api/logo')).arrayBuffer());
  assert.ok(lg.equals(fs.readFileSync(path.join(ROOT, 'seed-logo.png'))));
  // Instance KEDUA (memori kosong) juga bisa melayani dari app_blobs.
  const s2 = await startServer(t, { DATABASE_URL: TEST_PG_URL });
  assert.ok(Buffer.from(await (await fetch(s2.base + '/api/hero')).arrayBuffer()).equals(hero), 'instance lain tidak bisa membaca hero');
  const ps = await (await fetch(s2.base + '/api/public-settings')).json();
  assert.equal(ps.has_hero, true); assert.equal(ps.has_logo, true);
  const adm = await (await fetch(s.base + '/api/admin/settings', { headers: H })).json();
  assert.equal(adm.has_hero, true);
  assert.equal(adm.hero_ref, undefined, 'rujukan internal tidak dibocorkan');
  // Backup berisi gambar inline (bisa dipulihkan di database mana pun).
  const bk = await (await fetch(s.base + '/api/admin/backup', { headers: H })).json();
  assert.ok(Buffer.from(bk.settings.hero_b64, 'base64').equals(hero), 'backup kehilangan hero');
  assert.equal(bk.settings.hero_ref, undefined);
  assert.ok(bk.settings.logo_b64, 'backup kehilangan logo');
  // Hapus hero → 404 & has_hero false.
  assert.equal((await fetch(s.base + '/api/admin/settings/hero', { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await fetch(s.base + '/api/hero')).status, 404);
  assert.equal((await (await fetch(s.base + '/api/admin/settings', { headers: H })).json()).has_hero, false);
  // Pulihkan backup (mode replace) → hero kembali.
  const rs = await fetch(s.base + '/api/admin/restore', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bk, mode: 'replace' }) });
  assert.equal(rs.status, 200, await rs.clone().text());
  assert.ok(Buffer.from(await (await fetch(s.base + '/api/hero')).arrayBuffer()).equals(hero), 'hero tidak kembali setelah restore');
});

test('PG: pemindahan gambar TIDAK menimpa perubahan pengaturan dari instance lain saat konflik', { skip: pgSkip, timeout: 60000 }, async (t) => {
  const pool = await resetPg(TEST_PG_URL);
  t.after(() => pool.end());
  // Siapkan state seperti SEBELUM perbaikan: logo inline di blob state.
  const s0 = await startServer(t, { DATABASE_URL: TEST_PG_URL });
  s0.child.kill('SIGTERM');
  await new Promise((r) => s0.child.once('exit', r));
  const seed = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  seed.settings.logo_b64 = fs.readFileSync(path.join(ROOT, 'seed-logo.b64'), 'utf8').trim();
  seed.settings.logo_ref = null;
  await pool.query('UPDATE app_state SET data = $1::jsonb, rev = rev + 1 WHERE id = 1', [JSON.stringify(seed)]);
  const a = await startServer(t, { DATABASE_URL: TEST_PG_URL, PERSIST_BEFORE_RESPONSE: '1' });
  const b = await startServer(t, { DATABASE_URL: TEST_PG_URL, PERSIST_BEFORE_RESPONSE: '1' });
  const st0 = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  assert.ok(st0.settings.logo_b64, 'prasyarat: logo masih inline');
  // B: admin mengganti tagline.
  const HB = await login(b.base);
  const up = await fetch(b.base + '/api/admin/settings', { method: 'PUT', headers: { ...HB, 'Content-Type': 'application/json' }, body: JSON.stringify({ tagline: 'Tagline dari B' }) });
  assert.equal(up.status, 200, await up.clone().text());
  // A (salinan lama, belum refresh): reservasi baru → A memindah logo
  // (settings berubah hanya karena itu) → konflik rev → gabung.
  const r = await fetch(a.base + '/api/reservations', { method: 'POST', body: reservationForm('Bunda Konflik', '14:00') });
  assert.equal(r.status, 201);
  const st = (await pool.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data;
  assert.equal(st.settings.tagline, 'Tagline dari B', 'perubahan pengaturan instance B tertimpa salinan lama A');
  assert.ok(st.reservations.some((x) => x.patient_name === 'Bunda Konflik'), 'reservasi A hilang');
  assert.equal((await fetch(a.base + '/api/logo')).status, 200);
});

test('Logo bawaan lama (145 KB) otomatis dilayani versi baru (21 KB)', async (t) => {
  let oldB64;
  try { oldB64 = require('node:child_process').execFileSync('git', ['show', '9b339b8:seed-logo.b64'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { t.skip('riwayat git (9b339b8) tidak tersedia'); return; }
  const s = await startServer(t);
  const file = path.join(s.tmp, 'state.json');
  // Tulis ulang state dengan logo lama, lalu boot ulang di berkas yang sama.
  s.child.kill('SIGKILL');
  await new Promise((r) => s.child.once('exit', r));
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.settings.logo_b64 = oldB64;
  fs.writeFileSync(file, JSON.stringify(st));
  const s2 = await startServer(t, { DATA_FILE: file });
  const lg = Buffer.from(await (await fetch(s2.base + '/api/logo')).arrayBuffer());
  assert.ok(lg.equals(fs.readFileSync(path.join(ROOT, 'seed-logo.png'))), 'logo lama masih dilayani: ' + lg.length + ' byte');
  assert.ok(lg.length < 40 * 1024);
});
