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
    // /health sekarang juga melaporkan storage yang dikonfigurasi +
    // status koneksi DB (dipakai untuk membedakan "memang file" vs
    // "DATABASE_URL diisi tapi gagal connect").
    assert.equal(health.ok, true);
    assert.equal(health.storage, 'file');
    assert.equal(health.configured_storage, 'file');
    assert.equal(health.db_connected, false);

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

    // ------------------------------------------------------------------
    // AUDIT KERAHASIAAN DATA — semua endpoint di bawah ini memuat data
    // pribadi pasien (nama, WhatsApp, alamat) atau rahasia internal
    // (kunci AI, token webhook, tanda tangan pemilik). Harus SELALU 401
    // tanpa token, dan tidak boleh muncul di endpoint publik.
    // ------------------------------------------------------------------
    const protectedGets = [
      '/api/admin/reservations',
      '/api/admin/stats',
      '/api/admin/charts',
      '/api/admin/charts/heatmap',
      '/api/admin/customers',
      '/api/admin/notifications',
      '/api/admin/recap',
      '/api/admin/receipts',
      '/api/admin/settings',
      '/api/admin/settings/owner-signature',
      '/api/admin/backup',
      '/api/admin/ai/config',
      '/api/admin/ai/conversations',
      '/api/admin/expenses',
      '/api/admin/broadcasts',
      '/api/admin/whatsapp/templates',
      '/api/admin/storage/status',
      '/api/admin/ai/diagnostics',
      '/api/proof/1'
    ];
    for (const path of protectedGets) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 401, `${path} bocor tanpa token (status ${res.status})`);
    }

    // Token rusak / ditandatangani kunci lain tidak boleh diterima.
    for (const bad of ['abc', 'a.b.c', login.token.slice(0, -3) + 'xyz']) {
      const res = await fetch(`${baseUrl}/api/admin/settings`, {
        headers: { Authorization: `Bearer ${bad}` }
      });
      assert.equal(res.status, 401, `token palsu "${bad.slice(0, 12)}" diterima server`);
    }

    // Endpoint publik tidak boleh memuat data pribadi pasien.
    for (const path of ['/api/calendar', '/api/public-settings', '/api/business', '/health']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      for (const leak of ['patient_name', 'Alamat pengujian', '08123456789', 'proof_b64', 'ai_gemini_api_key', 'owner_signature_b64', 'password_hash', 'ai_assistant_verify_token', 'ai_assistant_conversations']) {
        assert.ok(!body.includes(leak), `${path} membocorkan "${leak}"`);
      }
    }

    // Tanda tangan pemilik tidak boleh bisa diunduh publik.
    const sigPublic = await fetch(`${baseUrl}/api/owner-signature`);
    assert.equal(sigPublic.status, 404, 'tanda tangan pemilik masih bisa diunduh tanpa login');

    // Konfigurasi AI tidak boleh mengembalikan nilai kunci, hanya flag.
    const aiConfig = await (await fetch(`${baseUrl}/api/admin/ai/config`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    for (const key of ['gemini_api_key', 'openrouter_api_key', 'access_token', 'app_secret']) {
      assert.ok(!(key in aiConfig), `kunci rahasia "${key}" ikut terkirim ke klien`);
    }

    // Kwitansi: tautan publik harus memakai token bertanda tangan dan
    // tidak boleh membocorkan bukti transfer. Token yang dimanipulasi
    // (timestamp masa depan) juga harus ditolak.
    const receiptResponse = await fetch(`${baseUrl}/api/admin/receipts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Bunda Rahasia',
        whatsapp: '081200000000',
        address: 'Alamat rahasia',
        service_date: '2026-09-02',
        service_time: '10:00',
        items: [{ name: 'Massage Ibu Hamil', price: 80000, qty: 1 }]
      })
    });
    assert.equal(receiptResponse.status, 200);
    const receipt = await receiptResponse.json();

    const receipts = await (await fetch(`${baseUrl}/api/admin/receipts`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    const receiptId = receipts[0].id;
    const share = await (await fetch(`${baseUrl}/api/admin/receipts/${receiptId}/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    assert.ok(share.token, 'share token harus dibuat');

    const publicReceipt = await (await fetch(`${baseUrl}/api/public/receipt/${share.token}`)).json();
    assert.equal(publicReceipt.receipt.invoice_no, receipt.invoice_no);
    assert.ok(!('proof_b64' in publicReceipt.receipt), 'bukti transfer ikut terkirim di link publik');
    assert.ok(!('proof_mime' in publicReceipt.receipt), 'mime bukti transfer ikut terkirim di link publik');

    const parts = share.token.split('.');
    const forged = `${parts[0]}.${Date.now() + 50 * 365 * 24 * 3600 * 1000}.${parts[2]}`;
    const forgedRes = await fetch(`${baseUrl}/api/public/receipt/${forged}`);
    assert.equal(forgedRes.status, 404, 'masa berlaku token kwitansi bisa diperpanjang sembarangan');

    // Respons profil tidak boleh memuat hash password.
    const profileRes = await fetch(`${baseUrl}/api/admin/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', current_password: 'very-secure-test-password' })
    });
    assert.equal(profileRes.status, 200);
    const profileBody = await profileRes.text();
    assert.ok(!profileBody.includes('password_hash'), 'hash password ikut terkirim ke klien');
    assert.ok(!profileBody.includes('$2a$') && !profileBody.includes('$2b$'), 'hash bcrypt ikut terkirim ke klien');

    // File backup tidak boleh memuat kredensial / aset sensitif.
    await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ai_gemini_api_key: 'AIza-dummy-key',
        ai_assistant_app_secret: 'dummy-app-secret',
        ai_assistant_verify_token: 'dummy-verify-token'
      })
    });
    const backupText = await (await fetch(`${baseUrl}/api/admin/backup`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).text();
    for (const secret of ['ai_gemini_api_key', 'ai_openrouter_api_key', 'ai_assistant_access_token',
      'ai_assistant_app_secret', 'ai_assistant_verify_token', 'owner_signature_b64',
      'proof_b64', 'dummy-app-secret', 'dummy-verify-token']) {
      assert.ok(!backupText.includes(secret), `backup memuat "${secret}"`);
    }

    // Login response juga tidak boleh memuat hash.
    assert.ok(!JSON.stringify(login).includes('password_hash'), 'hash password ikut terkirim saat login');

    // ------------------------------------------------------------------
    // BACKUP: harus terenkripsi (tidak ada PII dalam bentuk teks polos),
    // tahan passphrase salah, dan bisa dipulihkan dengan passphrase benar.
    // ------------------------------------------------------------------
    const passphrase = 'passphrase-uji-yang-panjang';
    const encRes = await fetch(`${baseUrl}/api/admin/backup/encrypted`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase })
    });
    assert.equal(encRes.status, 200);
    const envelope = await encRes.json();
    assert.equal(envelope.format, 'adzkiya-backup-enc-v1');
    assert.equal(envelope.cipher, 'aes-256-gcm');
    assert.equal(envelope.kdf, 'scrypt');
    const envelopeText = JSON.stringify(envelope);
    for (const secret of ['Bunda Rahasia', 'Alamat rahasia', '081200000000', 'INV-']) {
      assert.ok(!envelopeText.includes(secret), `backup terenkripsi masih memuat "${secret}" polos`);
    }

    const shortPass = await fetch(`${baseUrl}/api/admin/backup/encrypted`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'abc' })
    });
    assert.equal(shortPass.status, 400, 'passphrase terlalu pendek harus ditolak');

    const wrongPass = await fetch(`${baseUrl}/api/admin/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, passphrase: 'passphrase-salah-sekali', mode: 'append' })
    });
    assert.equal(wrongPass.status, 400, 'backup terenkripsi terbuka dengan passphrase salah');

    const rightPass = await fetch(`${baseUrl}/api/admin/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, passphrase, mode: 'append', sync_reservations: false })
    });
    assert.equal(rightPass.status, 200, 'restore dengan passphrase benar gagal');

    // Backup juga tidak boleh bocor tanpa token.
    const encNoAuth = await fetch(`${baseUrl}/api/admin/backup/encrypted`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase })
    });
    assert.equal(encNoAuth.status, 401, 'backup terenkripsi bisa dibuat tanpa token');

    // ------------------------------------------------------------------
    // STORAGE: status hanya untuk admin, dan sinkronisasi wajib konfirmasi.
    // ------------------------------------------------------------------
    const storageStatus = await (await fetch(`${baseUrl}/api/admin/storage/status`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    assert.equal(storageStatus.configured_storage, 'file', 'tes ini berjalan di mode file');
    assert.equal(storageStatus.active_storage, 'file');
    assert.equal(storageStatus.can_sync, false);

    const syncNoConfirm = await fetch(`${baseUrl}/api/admin/storage/sync-to-db`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(syncNoConfirm.status, 400, 'sinkronisasi tanpa konfirmasi dijalankan');
    const syncInFileMode = await fetch(`${baseUrl}/api/admin/storage/sync-to-db`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'SINKRON' })
    });
    assert.equal(syncInFileMode.status, 400, 'sinkronisasi di mode file seharusnya ditolak');

    // ------------------------------------------------------------------
    // PEMULIHAN PENYIMPANAN: tes koneksi & apply wajib token, wajib
    // konfirmasi, dan tidak boleh mengubah apa pun saat gagal.
    // ------------------------------------------------------------------
    for (const path of ['/api/admin/storage/test-connection', '/api/admin/storage/apply-connection']) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      assert.equal(res.status, 401, `${path} bisa dipanggil tanpa token`);
    }

    const badConn = await fetch(`${baseUrl}/api/admin/storage/test-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'postgresql://user:rahasia@127.0.0.1:1/db' })
    });
    assert.equal(badConn.status, 400, 'koneksi ke host mati seharusnya dilaporkan gagal');
    const badConnBody = await badConn.json();
    assert.equal(badConnBody.ok, false);
    assert.ok(typeof badConnBody.hint === 'string' && badConnBody.hint.length > 10, 'tidak ada saran perbaikan');
    assert.ok(!JSON.stringify(badConnBody).includes('rahasia'), 'password ikut ter-echo di respons tes koneksi');

    const badFormat = await fetch(`${baseUrl}/api/admin/storage/test-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'bukan-url-sama-sekali' })
    });
    assert.equal(badFormat.status, 400);

    const applyNoConfirm = await fetch(`${baseUrl}/api/admin/storage/apply-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'postgresql://user:pw@127.0.0.1:1/db' })
    });
    assert.equal(applyNoConfirm.status, 400, 'apply tanpa konfirmasi dijalankan');

    const applyBadHost = await fetch(`${baseUrl}/api/admin/storage/apply-connection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'postgresql://user:pw@127.0.0.1:1/db', confirm: 'PAKAI' })
    });
    assert.equal(applyBadHost.status, 400, 'apply ke host mati seharusnya gagal rapi');

    // Setelah kegagalan, storage TIDAK boleh berubah & sesi tetap hidup.
    const afterFailedApply = await (await fetch(`${baseUrl}/api/admin/storage/status`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    assert.equal(afterFailedApply.active_storage, 'file', 'storage berubah walau apply gagal');
    assert.equal(afterFailedApply.using_runtime_connection, false, 'koneksi runtime tercatat walau apply gagal');
    assert.equal(typeof afterFailedApply.file_storage_persistent, 'boolean');

    const stillAlive = await fetch(`${baseUrl}/api/admin/reservations`, {
      headers: { Authorization: `Bearer ${login.token}` }
    });
    assert.equal(stillAlive.status, 200, 'sesi admin mati setelah percobaan apply yang gagal');

    // ------------------------------------------------------------------
    // DIAGNOSA AI/WHATSAPP: hanya admin, tanpa membocorkan kredensial.
    // ------------------------------------------------------------------
    const diagRes = await fetch(`${baseUrl}/api/admin/ai/diagnostics`, {
      headers: { Authorization: `Bearer ${login.token}` }
    });
    assert.equal(diagRes.status, 200);
    const diag = await diagRes.json();
    assert.ok(Array.isArray(diag.checklist) && diag.checklist.length >= 5, 'checklist diagnosa kosong');
    assert.ok(/^https?:\/\//.test(diag.webhook_url), 'URL webhook harus absolut');
    assert.ok(!/AIza|sk-or-v1|EAA[A-Za-z0-9]{10,}/.test(JSON.stringify(diag)), 'diagnosa membocorkan kredensial');

    const cfgRes = await (await fetch(`${baseUrl}/api/admin/ai/config`, {
      headers: { Authorization: `Bearer ${login.token}` }
    })).json();
    assert.ok(/^https?:\/\//.test(cfgRes.webhook_url), 'config webhook_url harus absolut');

    // Non-admin tidak bisa menembus lewat metode selain GET.
    for (const [method, path] of [['PUT', '/api/admin/settings'], ['DELETE', '/api/admin/receipts'], ['POST', '/api/admin/restore']]) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined
      });
      assert.equal(res.status, 401, `${method} ${path} tidak diproteksi`);
    }
  } catch (error) {
    error.message += `\nServer logs:\n${logs}`;
    throw error;
  }
});
