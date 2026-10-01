// Uji multi-instance terhadap PostgreSQL sungguhan (simulasi platform
// serverless seperti Vercel, di mana beberapa instance bisa hidup bersamaan).
//
// LATAR BUG: state aplikasi disimpan sebagai SATU blob JSON (app_state).
// Dulu setiap instance menimpa blob apa adanya (last-write-wins) — reservasi
// yang diterima instance A bisa HILANG begitu instance B menyimpan datanya.
// Sekarang: tulisan mensyaratkan nomor revisi (optimistic locking); bila
// kalah, state terbaru dimuat ulang + digabungkan (dedupe) lalu ditulis ulang.
// GET juga di-refresh dari DB (TTL 5 detik) supaya instance tua tetap melihat
// data terbaru.
//
// Tes ini dijalankan HANYA bila env TEST_PG_URL menunjuk ke PostgreSQL uji:
//   TEST_PG_URL=postgresql://postgres:password@127.0.0.1:55432/adzkiya \
//     node --test test/pg-multiinstance.test.js
// Tanpa TEST_PG_URL, seluruh tes dilewati (npm test tetap hijau di mana pun).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const TEST_PG_URL = process.env.TEST_PG_URL || '';

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function waitForHealth(url, child, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server ${label} berhenti dengan kode ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server ${label} tidak siap dalam 20 detik`);
}

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: TEST_PG_URL,
      PORT: String(port),
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'very-secure-test-password',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  child._logs = () => logs;
  return child;
}

test('Dua instance PostgreSQL: tulisan A tidak tertimpa tulisan B (dan sebaliknya)', { timeout: 90000, skip: !TEST_PG_URL && 'butuh env TEST_PG_URL (PostgreSQL uji)' }, async (t) => {
  // Bersihkan blob state supaya mulai dari database kosong.
  const { Client } = require(TEST_PG_URL.includes('postgresql') ? 'pg' : 'pg');
  const cleaner = new Client({ connectionString: TEST_PG_URL });
  await cleaner.connect();
  await cleaner.query('DROP TABLE IF EXISTS app_state');
  await cleaner.query('DROP TABLE IF EXISTS share_tokens');
  await cleaner.end();

  const portA = await freePort();
  const portB = await freePort();
  const baseA = `http://127.0.0.1:${portA}`;
  const baseB = `http://127.0.0.1:${portB}`;
  const a = startServer(portA, { DATA_FILE: '' });
  const b = startServer(portB, { DATA_FILE: '' });
  t.after(async () => {
    for (const c of [a, b]) {
      if (c.exitCode === null) {
        c.kill('SIGTERM');
        await Promise.race([new Promise((r) => c.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
      }
    }
  });

  const hA = await waitForHealth(baseA, a, 'A');
  assert.equal(hA.storage, 'postgres');
  await waitForHealth(baseB, b, 'B');

  // Admin login di masing-masing instance (seed admin dari env yang sama).
  async function login(base) {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
    });
    assert.equal(r.status, 200);
    return (await r.json()).token;
  }
  const tokenA = await login(baseA);
  const tokenB = await login(baseB);

  const date = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  async function reserve(base, name, wa, time) {
    const r = await fetch(base + '/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: name, whatsapp: wa, address: 'Jl. Uji Multi 1',
        payment_method: 'COD',
        items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]),
        slots: JSON.stringify([{ date, time }])
      })
    });
    assert.equal(r.status, 201, 'reservasi ' + name + ' diterima');
    return r.json();
  }

  // 1) Tulis lewat A, pastikan tersimpan.
  await reserve(baseA, 'Bunda Dari A', '081200000011', '09:00');
  const listA1 = await (await fetch(baseA + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + tokenA } })).json();
  assert.equal(listA1.length, 1);

  // 2) Instance B yang MATI-update (belum pernah refresh) menerima tulisan —
  //    dulu titik kritis: tulisan B MENIMPA data A. Sekarang merge-retry
  //    menyelamatkan keduanya.
  await reserve(baseB, 'Bunda Dari B', '081200000022', '10:00');

  // 3) Kedua instance harus akhirnya melihat KEDUA reservasi.
  async function waitForCount(base, token, min) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const rows = await (await fetch(base + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + token } })).json();
      const names = rows.map((r) => r.patient_name).sort();
      if (rows.length >= min && names.includes('Bunda Dari A') && names.includes('Bunda Dari B')) return names;
      await new Promise((r) => setTimeout(r, 400));
    }
    const rows = await (await fetch(base + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + token } })).json();
    return rows.map((r) => r.patient_name).sort();
  }
  const namesA = await waitForCount(baseA, tokenA, 2);
  const namesB = await waitForCount(baseB, tokenB, 2);
  assert.deepEqual(namesA, ['Bunda Dari A', 'Bunda Dari B'], 'instance A melihat keduanya');
  assert.deepEqual(namesB, ['Bunda Dari A', 'Bunda Dari B'], 'instance B melihat keduanya');

  // 4) ID tidak boleh berbenturan di database (dua-duanya id 1 = bug lama).
  const all = await (await fetch(baseA + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + tokenA } })).json();
  const ids = all.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ID reservasi unik: ' + JSON.stringify(all.map((r) => [r.id, r.patient_name])));

  // 5) Tidak boleh ada 'save gagal' di log kedua instance.
  assert.ok(!/save gagal/.test(a._logs()), 'log A bersih:\n' + a._logs().slice(-800));
  assert.ok(!/save gagal/.test(b._logs()), 'log B bersih:\n' + b._logs().slice(-800));
});

async function resetPg() {
  const { Client } = require('pg');
  const cleaner = new Client({ connectionString: TEST_PG_URL });
  await cleaner.connect();
  await cleaner.query('DROP TABLE IF EXISTS app_state');
  await cleaner.query('DROP TABLE IF EXISTS share_tokens');
  await cleaner.end();
}

async function stopAll(children) {
  for (const c of children) {
    if (c.exitCode === null) {
      c.kill('SIGTERM');
      await Promise.race([new Promise((r) => c.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}

function futureDate(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function postReservation(base, name, wa, date, time) {
  const r = await fetch(base + '/api/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      patient_name: name, whatsapp: wa, address: 'Jl. Uji Konflik 1',
      payment_method: 'COD',
      items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]),
      slots: JSON.stringify([{ date, time }])
    })
  });
  assert.equal(r.status, 201, 'reservasi ' + name + ' diterima');
  return r.json();
}

async function readBlob() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: TEST_PG_URL });
  await c.connect();
  try {
    const r = await c.query('SELECT data, rev FROM app_state WHERE id = 1');
    return r.rows.length ? { state: r.rows[0].data, rev: Number(r.rows[0].rev) } : null;
  } finally { await c.end(); }
}

async function waitForBlob(pred, label) {
  const deadline = Date.now() + 10000;
  let last = null;
  while (Date.now() < deadline) {
    last = await readBlob();
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timeout menunggu ' + label + ': ' + JSON.stringify(last && { rev: last.rev, n: (last.state.reservations || []).length }));
}

// Konflik DETERMINISTIK: tidak bergantung timing refresh/TTL. Tulisan
// "instance lain" disuntikkan langsung ke database (rev + 1) sementara
// memori instance A masih memegang rev lama. Tulisan A berikutnya PASTI
// ditolak conditional write (STORAGE_WRITE_CONFLICT) → A wajib memuat
// ulang, menggabungkan, dan menulis ulang tanpa kehilangan data siapa pun.
// Sekaligus membuktikan NODE_ENV=production bisa memakai PostgreSQL lokal
// tanpa SSL (dulu SSL dipaksakan → gagal connect → diam-diam mode file).
test('Konflik tulisan deterministik: tulisan instance lain tidak tertimpa (production + PG lokal tanpa SSL)', { timeout: 90000, skip: !TEST_PG_URL && 'butuh env TEST_PG_URL (PostgreSQL uji)' }, async (t) => {
  await resetPg();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const a = startServer(port, { DATA_FILE: '', NODE_ENV: 'production' });
  t.after(() => stopAll([a]));

  const h = await waitForHealth(base, a, 'A');
  assert.equal(h.storage, 'postgres', 'production harus tetap connect ke PG lokal: ' + JSON.stringify(h));
  assert.equal(h.db_connected, true);

  const date = futureDate(4);
  await postReservation(base, 'Bunda Pertama', '081200000041', date, '09:00');
  const before = await waitForBlob((b) => (b.state.reservations || []).some((r) => r.patient_name === 'Bunda Pertama'), 'reservasi pertama');

  // Suntikkan tulisan "instance lain" langsung ke database.
  const injected = before.state;
  injected._seq = injected._seq || {};
  const nextId = (injected._seq.reservations || 0) + 1;
  injected._seq.reservations = nextId;
  injected.reservations.push({
    id: nextId, patient_name: 'Bunda Instance Lain', whatsapp: '6281200000042', address: 'Jl. Lain',
    items: [{ name: 'Massage Ibu Hamil', price: 80000, qty: 1 }], slots: [{ date, time: '11:00' }],
    total: 80000, reservation_date: date, reservation_time: '11:00', payment_method: 'COD',
    status: 'pending', payment_status: 'unpaid', created_at: new Date().toISOString()
  });
  {
    const { Client } = require('pg');
    const c = new Client({ connectionString: TEST_PG_URL });
    await c.connect();
    const r = await c.query('UPDATE app_state SET data = $1::jsonb, rev = rev + 1 WHERE id = 1 AND rev = $2 RETURNING rev', [JSON.stringify(injected), before.rev]);
    await c.end();
    assert.equal(r.rowCount, 1, 'injeksi harus sukses');
  }
  const injectedRev = before.rev + 1;

  // A menulis dengan rev basi (POST tidak melewati refresh bacaan).
  await postReservation(base, 'Bunda Ketiga', '081200000043', date, '14:00');

  const after = await waitForBlob((b) => b.rev > injectedRev && (b.state.reservations || []).some((r) => r.patient_name === 'Bunda Ketiga'), 'tulisan A setelah konflik');
  const names = after.state.reservations.map((r) => r.patient_name).sort();
  assert.deepEqual(names, ['Bunda Instance Lain', 'Bunda Ketiga', 'Bunda Pertama'], 'tidak ada tulisan yang hilang');
  const ids = after.state.reservations.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ID unik setelah merge: ' + JSON.stringify(ids));
  assert.ok(after.state._seq.reservations >= Math.max(...ids), '_seq tidak mundur');

  // Memori A juga harus melihat tulisan instance lain (hasil merge dimuat balik).
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const rows = await (await fetch(base + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.deepEqual(rows.map((r) => r.patient_name).sort(), names);
  assert.ok(!/save gagal/.test(a._logs()), 'log A bersih:\n' + a._logs().slice(-800));
});

// Zero-config dengan HANYA DATABASE_URL (tanpa JWT_SECRET/ADMIN_*): kunci
// JWT diturunkan dari DATABASE_URL sehingga SAMA di semua instance, akun
// admin sementara dibuat sekali lalu dipakai ulang instance berikutnya,
// dan token dari instance A diterima instance B.
test('Zero-config + DATABASE_URL: kunci JWT turunan sama antar instance, admin sementara dipakai ulang', { timeout: 90000, skip: !TEST_PG_URL && 'butuh env TEST_PG_URL (PostgreSQL uji)' }, async (t) => {
  await resetPg();
  const noEnv = { DATA_FILE: '', NODE_ENV: 'production', JWT_SECRET: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '' };
  const portA = await freePort();
  const portB = await freePort();
  const baseA = `http://127.0.0.1:${portA}`;
  const baseB = `http://127.0.0.1:${portB}`;
  const a = startServer(portA, noEnv);
  t.after(() => stopAll([a]));
  const hA = await waitForHealth(baseA, a, 'A');
  assert.equal(hA.storage, 'postgres');
  assert.equal(hA.jwt_secret_source, 'database_url');
  assert.equal(hA.admin_login, 'temporary');
  const m = a._logs().match(/password : (\S+)/);
  assert.ok(m, 'password sementara tercetak di log A');

  // Instance B menyala SETELAH A menyimpan akun → memakai akun yang sama.
  const b = startServer(portB, noEnv);
  t.after(() => stopAll([b]));
  const hB = await waitForHealth(baseB, b, 'B');
  assert.equal(hB.jwt_secret_source, 'database_url');
  assert.equal(hB.admin_login, 'existing');
  assert.ok(!/password : /.test(b._logs()), 'B tidak boleh membuat akun sementara baru');

  const login = await fetch(baseA + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@adzkiya.id', password: m[1] })
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const onB = await fetch(baseB + '/api/admin/reservations', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(onB.status, 200, 'token dari A harus diterima B (kunci turunan sama)');

  // Reservasi di mode ini tersimpan permanen → tanpa storage_warning.
  const created = await postReservation(baseB, 'Bunda Zero Config DB', '081200000051', futureDate(5), '10:00');
  assert.equal(created.storage_warning, null);
});

// Three-way merge: hapus, pindah jadwal, dan perubahan bersamaan dari dua
// instance. Dulu (merge union) reservasi yang dihapus hidup lagi, pindah
// jadwal membuat dobel, dan perubahan instance yang kalah rev hilang.
test('Dua instance PostgreSQL: hapus/pindah jadwal/ubah bersamaan tidak hidup lagi, dobel, atau hilang', { timeout: 120000, skip: !TEST_PG_URL && 'butuh env TEST_PG_URL (PostgreSQL uji)' }, async (t) => {
  const { Client } = require('pg');
  const cleaner = new Client({ connectionString: TEST_PG_URL });
  await cleaner.connect();
  await cleaner.query('DROP TABLE IF EXISTS app_state');
  await cleaner.query('DROP TABLE IF EXISTS share_tokens');
  await cleaner.end();
  const portA = await freePort();
  const portB = await freePort();
  const A = `http://127.0.0.1:${portA}`;
  const B = `http://127.0.0.1:${portB}`;
  const a = startServer(portA, { DATA_FILE: '' });
  const b = startServer(portB, { DATA_FILE: '' });
  t.after(async () => {
    for (const c of [a, b]) {
      if (c.exitCode === null && c.signalCode === null) {
        c.kill('SIGTERM');
        await Promise.race([new Promise((r) => c.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
      }
    }
  });
  await waitForHealth(A, a, 'A');
  await waitForHealth(B, b, 'B');
  const login = async (base) => (await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
  })).json()).token;
  const ta = await login(A);
  const tb = await login(B);
  const H = (tok) => ({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' });
  let day = 30;
  async function reserve(base, name) {
    const date = new Date(Date.now() + (day++) * 864e5).toISOString().slice(0, 10);
    const r = await fetch(base + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient_name: name, whatsapp: '0812' + (30000000 + day), address: 'Jl. Uji', payment_method: 'COD',
        items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]), slots: JSON.stringify([{ date, time: '09:00' }]) })
    });
    assert.equal(r.status, 201, 'reservasi ' + name);
    return (await r.json()).id;
  }
  const list = async (base, tok) => (await fetch(base + '/api/admin/reservations', { headers: H(tok) })).json();
  async function dbRows() {
    const c = new Client({ connectionString: TEST_PG_URL });
    await c.connect();
    try { return (await c.query('SELECT data FROM app_state WHERE id = 1')).rows[0].data.reservations; } finally { await c.end(); }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const syncB = async () => { await sleep(5300); await list(B, tb); };

  const idX = await reserve(A, 'Hapus Saya');
  const idT = await reserve(A, 'Pindah Jadwal');
  const idU1 = await reserve(A, 'Ubah A');
  const idU2 = await reserve(A, 'Ubah B');
  await syncB(); // B kini mengenal keempatnya

  // 1) A menghapus X, B menulis dari memori basi → X tidak boleh hidup lagi.
  assert.equal((await fetch(`${A}/api/admin/reservations/${idX}`, { method: 'DELETE', headers: H(ta) })).status, 200);
  await sleep(400);
  await reserve(B, 'Tulisan B');
  await sleep(800);
  await syncB();
  let rows = await dbRows();
  assert.equal(rows.filter((r) => r.patient_name === 'Hapus Saya').length, 0, 'reservasi yang dihapus hidup lagi');
  assert.ok(!(await list(B, tb)).some((r) => r.patient_name === 'Hapus Saya'), 'B masih menampilkan reservasi yang dihapus');

  // 2) A memindah jadwal T → B tidak boleh menampilkan/menyimpan dobel.
  const newDate = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
  assert.equal((await fetch(`${A}/api/admin/reservations/${idT}`, { method: 'PATCH', headers: H(ta), body: JSON.stringify({ service_slots: [{ date: newDate, time: '10:00' }] }) })).status, 200);
  await sleep(500);
  await syncB();
  await reserve(B, 'Tulisan B2');
  await sleep(800);
  rows = await dbRows();
  assert.equal(rows.filter((r) => r.patient_name === 'Pindah Jadwal').length, 1, 'pindah jadwal membuat dobel di database');
  assert.equal((await list(B, tb)).filter((r) => r.patient_name === 'Pindah Jadwal').length, 1, 'pindah jadwal membuat dobel di B');

  // 3) A dan B mengubah reservasi BERBEDA bersamaan → keduanya tersimpan.
  await syncB();
  const [ra, rb] = await Promise.all([
    fetch(`${A}/api/admin/reservations/${idU1}`, { method: 'PATCH', headers: H(ta), body: JSON.stringify({ status: 'approved' }) }),
    fetch(`${B}/api/admin/reservations/${idU2}`, { method: 'PATCH', headers: H(tb), body: JSON.stringify({ status: 'rejected' }) })
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  await sleep(1500);
  rows = await dbRows();
  assert.equal(rows.find((r) => r.id === idU1).status, 'approved', 'perubahan A hilang');
  assert.equal(rows.find((r) => r.id === idU2).status, 'rejected', 'perubahan B hilang');
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'ID ganda di database');
  assert.ok(!/save gagal/.test(a._logs() + b._logs()), 'log bersih');
});
