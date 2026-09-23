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
