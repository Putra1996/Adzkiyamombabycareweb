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

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server berhenti dengan kode ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server tidak siap dalam 15 detik');
}

test('API menyimpan reservasi, menghitung harga server, dan melindungi admin', { timeout: 30000 }, async (t) => {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-api-'));
  const dataFile = path.join(tempDir, 'state.json');
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = '';

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_FILE: dataFile,
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      ADMIN_EMAIL: 'admin@test.local',
      ADMIN_PASSWORD: 'very-secure-test-password',
      ALLOWED_ORIGINS: 'https://putra1996.github.io'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.deepEqual(health, { ok: true, storage: 'file' });

    const blockedCors = await fetch(`${baseUrl}/api/services`, {
      headers: { Origin: 'https://example.invalid' }
    });
    assert.equal(blockedCors.status, 403);

    const servicesResponse = await fetch(`${baseUrl}/api/services`, {
      headers: { Origin: 'https://putra1996.github.io' }
    });
    assert.equal(servicesResponse.status, 200);
    assert.equal(servicesResponse.headers.get('access-control-allow-origin'), 'https://putra1996.github.io');

    const form = new FormData();
    form.set('patient_name', 'Bunda Test');
    form.set('whatsapp', '08123456789');
    form.set('address', 'Alamat pengujian');
    form.set('payment_method', 'COD');
    form.set('items', JSON.stringify([{ name: 'Massage Ibu Hamil', price: 1, qty: 1 }]));
    form.set('slots', JSON.stringify([{ date: '2026-09-01', time: '09:00' }]));

    const reservationResponse = await fetch(`${baseUrl}/api/reservations`, {
      method: 'POST',
      body: form,
      headers: { Origin: 'https://putra1996.github.io' }
    });
    assert.equal(reservationResponse.status, 201);
    const reservation = await reservationResponse.json();
    assert.equal(reservation.total, 80000, 'harga harus berasal dari katalog server');

    const proofResponse = await fetch(`${baseUrl}/api/proof/${reservation.id}`);
    assert.equal(proofResponse.status, 401, 'bukti pembayaran harus memerlukan JWT');

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    assert.ok(login.token);

    const reservationsResponse = await fetch(`${baseUrl}/api/admin/reservations`, {
      headers: { Authorization: `Bearer ${login.token}` }
    });
    assert.equal(reservationsResponse.status, 200);
    const reservations = await reservationsResponse.json();
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].total, 80000);
  } catch (error) {
    error.message += `\nServer logs:\n${logs}`;
    throw error;
  }
});
