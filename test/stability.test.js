'use strict';
// Tes regresi audit stabilitas (Oktober 2026). Setiap kasus di sini dulu
// menghasilkan 500, crash, data rusak/hilang, atau kebocoran data pasien.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('Audit stabilitas: input rusak ditolak rapi, data tidak rusak, nama pasien tidak bocor', { timeout: 60000 }, async (t) => {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-stab-'));
  const dataFile = path.join(tempDir, 'state.json');
  const B = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_FILE: dataFile,
      DATABASE_URL: '',
      VERCEL: '',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'very-secure-test-password'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('server berhenti:\n' + logs);
    try { if ((await fetch(B + '/health')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('server tidak siap:\n' + logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = await (await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
  })).json();
  const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  const req = (method, p, body, headers = H) => fetch(B + p, { method, headers, body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body) });

  // 1) JSON rusak → 400 (dulu 500), body terlalu besar → 413.
  let r = await req('POST', '/api/admin/expenses', '{"amount": 1,,,');
  assert.equal(r.status, 400, 'JSON rusak harus 400');
  assert.match((await r.json()).error, /JSON/);
  r = await req('PUT', '/api/admin/settings', JSON.stringify({ tagline: 'x'.repeat(30 * 1024 * 1024) }));
  assert.equal(r.status, 413, 'body raksasa harus 413');

  // 2) Kwitansi dengan item rusak → 400, bukan crash/total NaN.
  for (const items of ['bukan-daftar', [null], [{ name: 'A', price: 'mahal', qty: 1 }], [{ name: 'A', price: 1000, qty: 0 }]]) {
    r = await req('POST', '/api/admin/receipts', { patient_name: 'Uji', items });
    assert.equal(r.status, 400, 'kwitansi items=' + JSON.stringify(items));
  }

  // 3) Pengaturan bertipe salah → 400 dan tidak tersimpan.
  r = await req('PUT', '/api/admin/settings', { phone: { x: 1 } });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/admin/settings', { testimonials: 'teks' });
  assert.equal(r.status, 400);
  r = await req('PUT', '/api/admin/settings', { logo_ref: 'proof_curian' });
  assert.equal(r.status, 200);
  r = await req('PUT', '/api/admin/settings', { testimonials: [{ name: 'A', text: 'Bagus', rating: 99 }, null], blackout_dates: ['2026-12-25', 'bukan-tanggal', 5], reminder_hours_before: '3' });
  assert.equal(r.status, 200);
  const st = await (await req('GET', '/api/admin/settings')).json();
  assert.equal(typeof st.phone, 'string');
  assert.equal(st.logo_ref, undefined, 'kolom internal tidak bisa ditulis');
  assert.deepEqual(st.testimonials.map((x) => x.rating), [5]);
  assert.deepEqual(st.blackout_dates, ['2026-12-25']);
  assert.equal(st.reminder_hours_before, 3);
  await req('PUT', '/api/admin/settings', { blackout_dates: [] });

  // 4) Pemulihan backup rusak tidak boleh menghapus data (dulu: mode replace
  //    mengosongkan data lalu crash di elemen null).
  const D = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
  const book = (name, time) => fetch(B + '/api/reservations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patient_name: name, whatsapp: '0812' + Math.floor(1e7 + Math.random() * 8e7), address: 'Jl. Uji', payment_method: 'COD',
      items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]), slots: JSON.stringify([{ date: D, time }]) })
  });
  assert.equal((await book('Pasien Rahasia', '09:00')).status, 201);
  r = await req('POST', '/api/admin/restore', { mode: 'replace', reservations: 'rusak', receipts: [] });
  assert.equal(r.status, 400);
  r = await req('POST', '/api/admin/restore', { mode: 'replace', reservations: [], receipts: [], settings: 'rusak' });
  assert.equal(r.status, 400);
  const list = await (await req('GET', '/api/admin/reservations')).json();
  assert.ok(list.some((x) => x.patient_name === 'Pasien Rahasia'), 'data tetap ada setelah restore ditolak');

  // 5) Bentrok jadwal: respons PUBLIK tidak memuat nama pasien lain.
  r = await book('Pengunjung', '09:30');
  assert.equal(r.status, 201);
  const warn = await r.json();
  assert.ok(warn.schedule_warning, 'ada peringatan bentrok');
  assert.ok(!JSON.stringify(warn).includes('Pasien Rahasia'), 'nama bocor di schedule_warning: ' + warn.schedule_warning);
  await req('PUT', '/api/admin/settings', { scheduling_mode: 'block' });
  r = await book('Pengunjung 2', '09:15');
  assert.equal(r.status, 409);
  const blocked = await r.json();
  assert.ok(!JSON.stringify(blocked).includes('Pasien Rahasia'), 'nama bocor di respons 409');
  assert.ok(blocked.conflicts.every((c) => c.with_id === undefined && c.patient_name === undefined));
  // Admin tetap melihat nama di catatan internal.
  const adminList = await (await req('GET', '/api/admin/reservations')).json();
  assert.match(adminList.find((x) => x.patient_name === 'Pengunjung').notes, /Pasien Rahasia/);

  // 6) Kiriman ulang IDENTIK (dobel klik / kirim ulang setelah 503) tidak
  //    membuat reservasi kedua — juga di mode 'block' (dulu ditolak 409
  //    karena "bentrok" dengan percobaan pertamanya sendiri).
  const D2 = new Date(Date.now() + 25 * 864e5).toISOString().slice(0, 10);
  const same = JSON.stringify({ patient_name: 'Bunda Dobel', whatsapp: '0812 7777 1234', address: 'Jl. Uji', payment_method: 'COD',
    items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]), slots: JSON.stringify([{ date: D2, time: '13:00' }]) });
  const post = (body) => fetch(B + '/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const first = await (await post(same)).json();
  r = await post(same);
  assert.equal(r.status, 201, 'kiriman ulang identik tetap 201');
  const second = await r.json();
  assert.equal(second.id, first.id, 'kiriman ulang mengembalikan reservasi yang sama');
  assert.equal(second.duplicate, true);
  const dobel = (await (await req('GET', '/api/admin/reservations')).json()).filter((x) => x.patient_name === 'Bunda Dobel');
  assert.equal(dobel.length, 1, 'reservasi tidak boleh dobel');

  // 7) Server tetap hidup & tidak ada error tak tertangani di log.
  assert.equal((await fetch(B + '/health')).status, 200);
  assert.ok(!/Uncaught|unhandledRejection|TypeError/.test(logs), 'log bersih:\n' + logs.slice(-1500));
});
