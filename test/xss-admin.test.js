// Uji XSS DINAMIS end-to-end: data berbahaya dari pintu masuk PUBLIK harus
// tampil sebagai teks biasa di panel admin (token admin ada di
// localStorage — satu celah stored-XSS = pengambilalihan akun admin).
//
// Alur:
//   1. Server sungguhan dinyalakan dengan AI tiruan yang MEMBEO-kan pesan
//      pengguna (skenario terburuk prompt-injection: AI membalas HTML
//      penyerang apa adanya).
//   2. Payload disuntikkan lewat: formulir reservasi (nama, alamat,
//      catatan), chat AI publik, dan webhook WhatsApp (nama profil + teks).
//   3. Panel admin (public/admin.html + skrip aslinya) dimuat di jsdom
//      dengan fetch diteruskan ke server sungguhan, lalu SETIAP halaman
//      dirender.
//   4. DOM diperiksa: tidak boleh ada elemen/atribut dari payload.
//
// Butuh jsdom (npm install --no-save jsdom); tanpa itu tes dilewati.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* opsional */ }

const MARK = 'xssprobe';
// Beragam konteks: elemen, atribut, URL javascript:, template literal.
const PAYLOADS = [
  `<img src=x id=${MARK}1 onerror=alert(1)>`,
  `"><svg id=${MARK}2 onload=alert(1)>`,
  `'><a id=${MARK}3 href=javascript:alert(1)>klik</a>`,
  `\${alert(1)}<b id=${MARK}4>tebal</b>`
];

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// AI tiruan: membalas PERSIS pesan pengguna (termasuk HTML).
const ECHO_STUB = `
const realFetch = global.fetch;
const resp = (st, body) => ({ ok: st < 300, status: st, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async function (url, options) {
  const t = String(url);
  if (t.includes('generativelanguage.googleapis.com')) {
    if (!/:generateContent/.test(t)) return resp(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    let userText = '';
    try {
      const body = JSON.parse((options && options.body) || '{}');
      const lastUser = (body.contents || []).slice().reverse().find((c) => c.role === 'user');
      userText = lastUser ? (lastUser.parts || []).map((pt) => pt.text).join(' ') : '';
    } catch (e) {}
    return resp(200, { candidates: [{ content: { parts: [{ text: 'Balasan: ' + userText + ' [link](javascript:alert(1)) **tebal**' }] } }] });
  }
  if (t.includes('openrouter.ai')) return resp(402, { error: { message: 'x' } });
  return realFetch(url, options);
};
`;

function findInjected(document) {
  const hits = [];
  for (let i = 1; i <= PAYLOADS.length; i++) {
    const el = document.getElementById(MARK + i);
    if (el) hits.push(`#${MARK}${i} <${el.tagName.toLowerCase()}>`);
  }
  for (const el of document.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      const v = String(attr.value || '');
      if (n.startsWith('on') && /alert\(1\)/.test(v)) hits.push(`atribut ${n}="${v.slice(0, 60)}" pada <${el.tagName.toLowerCase()}>`);
      if ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(v)) hits.push(`${n}="${v.slice(0, 60)}" pada <${el.tagName.toLowerCase()}>`);
    }
  }
  return hits;
}

test('XSS: data publik berbahaya tampil sebagai teks di SEMUA halaman panel admin', { timeout: 120000, skip: JSDOM ? false : 'jsdom tidak terpasang (npm install --no-save jsdom)' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adzkiya-xss-'));
  const stubFile = path.join(tmp, 'echo-stub.js');
  fs.writeFileSync(stubFile, ECHO_STUB);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const k of ['DATABASE_URL', 'VERCEL', 'NODE_ENV', 'ALLOWED_ORIGINS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), DATA_FILE: path.join(tmp, 'state.json'),
    JWT_SECRET: 'xss-test-secret-lebih-dari-tiga-puluh-dua-karakter',
    ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'very-secure-test-password'
  });
  const child = spawn(process.execPath, ['--require', stubFile, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + '/health')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('server tidak siap:\n' + logs);
    await new Promise((r) => setTimeout(r, 100));
  }

  const login = await (await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'very-secure-test-password' })
  })).json();
  assert.ok(login.token, 'login admin');
  const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  const put = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ai_assistant_enabled: true, ai_gemini_api_key: 'AIza-dummy' }) });
  assert.equal(put.status, 200);

  // --- Gambar tersimpan dengan mime berbahaya (PUT settings / restore) ---
  const htmlB64 = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
  const putImg = await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({
    logo_b64: htmlB64, logo_mime: 'text/html', hero_b64: svgB64, hero_mime: 'image/svg+xml',
    qris_b64: htmlB64, qris_mime: 'TEXT/HTML; charset=utf-8',
    socials: [{ platform: 'ig', url: 'https://instagram.com/x', icon_b64: svgB64, icon_mime: 'image/svg+xml' }]
  }) });
  assert.equal(putImg.status, 200);
  for (const [ep, want] of [['/api/logo', 'image/png'], ['/api/hero', 'image/jpeg'], ['/api/qris', 'image/png'], ['/api/social-icon/0', 'image/png']]) {
    const r = await fetch(base + ep);
    assert.equal(r.status, 200, ep);
    assert.equal(r.headers.get('content-type').split(';')[0], want, ep + ' wajib disajikan sebagai gambar, bukan HTML/SVG');
    assert.match(r.headers.get('content-security-policy') || '', /sandbox/, ep + ' wajib CSP sandbox');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', ep);
  }
  // Mime gambar yang sah tetap dihormati.
  await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ logo_mime: 'image/webp' }) });
  assert.equal((await fetch(base + '/api/logo')).headers.get('content-type'), 'image/webp');

  // --- Suntikkan payload lewat semua pintu masuk publik ---
  const date = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const times = ['09:00', '11:00', '13:00', '15:00'];
  let created = 0;
  for (let i = 0; i < PAYLOADS.length; i++) {
    const r = await fetch(base + '/api/reservations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_name: 'Bunda ' + PAYLOADS[i], whatsapp: '08120000' + String(1000 + i),
        address: 'Jl. ' + PAYLOADS[(i + 1) % PAYLOADS.length], notes: PAYLOADS[(i + 2) % PAYLOADS.length],
        payment_method: 'COD',
        items: JSON.stringify([{ name: 'Massage Ibu Hamil', qty: 1 }]),
        slots: JSON.stringify([{ date, time: times[i] }])
      })
    });
    if (r.status === 201) created++;
  }
  assert.ok(created >= 1, 'minimal satu reservasi berpayload diterima (atau semuanya ditolak validasi)');
  // Setujui satu supaya ikut ke kalender, rekap, CRM, pengingat.
  const list = await (await fetch(base + '/api/admin/reservations', { headers: H })).json();
  if (list[0]) await fetch(base + '/api/admin/reservations/' + list[0].id, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'approved', payment_status: 'lunas' }) });

  for (const p of PAYLOADS) {
    await fetch(base + '/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: p, session_id: 'xss-' + Math.random().toString(36).slice(2) }) });
  }
  await fetch(base + '/api/webhook/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: {
      messages: [{ from: '6281200009999', type: 'text', text: { body: PAYLOADS.join(' ') } }],
      contacts: [{ wa_id: '6281200009999', profile: { name: PAYLOADS[0] } }]
    } }] }] })
  });
  await new Promise((r) => setTimeout(r, 400));

  // Webhook tanpa App Secret menerima pesan palsu (seperti di atas) →
  // /api/health wajib memperingatkan saat token WA terisi.
  const warnOf = async () => (await (await fetch(base + '/api/health')).json()).warnings.join(' | ');
  assert.doesNotMatch(await warnOf(), /App Secret/);
  await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ai_assistant_access_token: 'EAAG-dummy' }) });
  assert.match(await warnOf(), /WhatsApp App Secret belum diisi/);
  await fetch(base + '/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ai_assistant_app_secret: 'rahasia-app' }) });
  assert.doesNotMatch(await warnOf(), /App Secret/);

  // --- Panel admin di DOM sungguhan, fetch diteruskan ke server ---
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: base + '/admin.html' });
  const { window } = dom;
  const timers = [];
  const origSI = window.setInterval.bind(window);
  window.setInterval = (...a) => { const id = origSI(...a); timers.push(id); return id; };
  t.after(() => { for (const id of timers) window.clearInterval(id); });
  window.localStorage.setItem('adm_token', login.token);
  window.localStorage.setItem('adm_user', JSON.stringify(login.user));
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  window.fetch = async (url, opts) => {
    const u = new URL(String(url), base);
    const r = await fetch(base + u.pathname + u.search, opts);
    const buf = await r.arrayBuffer();
    const text = Buffer.from(buf).toString('utf8');
    return { ok: r.ok, status: r.status, headers: { get: (k) => r.headers.get(k) }, json: async () => JSON.parse(text), text: async () => text, blob: async () => new window.Blob([buf]), arrayBuffer: async () => buf };
  };
  const alerts = [];
  window.alert = (m) => { alerts.push(String(m)); };
  window.confirm = () => false;
  window.prompt = () => null;
  window.URL.createObjectURL = () => 'blob:uji';
  for (const rel of ['public/js/api-config.js', 'public/js/i18n.js', 'public/js/main.js', 'public/js/admin.js']) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    window.document.head.appendChild(el);
  }
  await new Promise((r) => setTimeout(r, 800));

  const pages = {
    dashboard: 'renderDashboard', reservations: 'renderReservations', notifications: 'renderNotifications',
    calendar: 'renderCalendarAdmin', receipts: 'renderReceipts', recap: 'renderRecap',
    broadcast: 'renderBroadcast', customers: 'renderCustomers', accounting: 'renderAccounting',
    stock: 'renderStock', packages: 'renderPackages', reminders: 'renderReminders',
    backup: 'renderBackup', settings: 'renderSettings'
  };
  const findings = [];
  let sawPayloadText = false;
  for (const [page, fn] of Object.entries(pages)) {
    await window.eval(`(async () => { CURRENT_PAGE = ${JSON.stringify(page)}; if (typeof ${fn} === 'function') await ${fn}(); })()`);
    await new Promise((r) => setTimeout(r, 150));
    for (const h of findInjected(window.document)) findings.push(page + ': ' + h);
    if ((window.document.body.textContent || '').includes(MARK)) sawPayloadText = true;
  }
  // Log percakapan AI + WhatsApp: tombol di Pengaturan → Asisten AI
  // membuka modal berisi pesan mentah pengunjung dan balasan AI.
  await window.eval(`(async () => { CURRENT_PAGE = 'settings'; await renderSettings(); })()`);
  await new Promise((r) => setTimeout(r, 200));
  const logsBtn = window.document.getElementById('aiAssistantLogsBtn');
  assert.ok(logsBtn, 'tombol log AI ada');
  logsBtn.click();
  await new Promise((r) => setTimeout(r, 500));
  const modalText = window.document.body.textContent || '';
  assert.ok(/Log Percakapan AI/.test(modalText), 'modal log AI terbuka: ' + alerts.join(' | '));
  assert.ok(modalText.includes('WHATSAPP') && modalText.includes('WEB'), 'log memuat percakapan web DAN WhatsApp');
  for (const h of findInjected(window.document)) findings.push('ai-log: ' + h);

  assert.deepEqual(findings, [], 'payload XSS tertanam sebagai HTML aktif di panel admin:\n' + findings.join('\n'));
  assert.deepEqual(alerts.filter((a) => a === '1'), [], 'alert(1) tereksekusi');
  assert.ok(sawPayloadText, 'payload harus tampil sebagai TEKS (bukti data benar-benar dirender)');
});

test('XSS: balasan AI berbahaya di widget chat publik tampil sebagai teks', { timeout: 60000, skip: JSDOM ? false : 'jsdom tidak terpasang' }, async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const evil = PAYLOADS.join(' ') + ' [klik](javascript:alert(1)) [<img src=x id=' + MARK + '9 onerror=alert(1)>](https://wa.me/62812)';
  const json = (b) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => b, text: async () => JSON.stringify(b) });
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://contoh.vercel.app/',
    beforeParse(window) {
      window.adzkiyaApiUrl = (p) => p;
      window.t = (k, fb) => (typeof fb === 'string' ? fb : k);
      if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/api/ai/chat')) return json({ reply: evil, booking: { created: true, id: 1, patient_name: PAYLOADS[0], service_name: PAYLOADS[1], slots: [{ date: PAYLOADS[2], time: '09:00' }], total: 1, payment_method: PAYLOADS[3] } });
        if (u.includes('/api/ai/status')) return json({ ready: false, message: PAYLOADS[0], wa_link: 'javascript:alert(1)' });
        if (u.includes('/api/public-settings')) return json({ business_name: PAYLOADS[0], phone: '0858' + PAYLOADS[1], hours: [{ day: PAYLOADS[2], open: '08:00', close: '20:00' }], testimonials: [{ name: PAYLOADS[0], text: PAYLOADS[1], rating: 5 }], socials: [{ platform: PAYLOADS[3], url: 'javascript:alert(1)' }], gmaps_url: 'javascript:alert(1)' });
        return json({});
      };
    }
  });
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 200));
  window.document.getElementById('aiChatFab').click();
  await new Promise((r) => setTimeout(r, 200));
  window.document.getElementById('aiChatText').value = 'halo';
  window.document.getElementById('aiChatSend').click();
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(calls.some((u) => u.includes('/api/ai/chat')), 'pesan chat benar-benar terkirim');
  const text = window.document.getElementById('aiChatMessages').textContent;
  assert.ok(text.includes('klik'), 'balasan AI dirender');
  assert.ok(text.includes(MARK), 'data kartu booking tampil sebagai teks');
  const hits = findInjected(window.document);
  window.close();
  assert.deepEqual(hits, [], 'HTML aktif tertanam di beranda:\n' + hits.join('\n'));
});

test('XSS: nama layanan berbahaya di grid beranda tampil sebagai teks + tombol tetap berfungsi', { timeout: 30000, skip: JSDOM ? false : 'jsdom tidak terpasang' }, async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*src="js\/main\.js"[^>]*><\/script>/, ''); // disuntik manual di bawah
  const evilName = `Pijat');alert(1);//"><img src=x id=${MARK}7 onerror=alert(1)>\\`;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://contoh.vercel.app/',
    beforeParse(window) {
      window.adzkiyaApiUrl = (p) => p;
      window.t = (k, fb) => (typeof fb === 'string' ? fb : k);
      if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      const catalog = [{ cat: '<b id=' + MARK + '8>Kat</b>', items: [{ name: evilName, price: 80000 }] }];
      window.fetch = async (u) => {
        const body = String(u).includes('/api/services') ? catalog : {};
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
      };
    }
  });
  const { window } = dom;
  const el = window.document.createElement('script');
  el.textContent = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8') + '\n;loadServices();';
  window.document.head.appendChild(el);
  await new Promise((r) => setTimeout(r, 300));
  const grid = window.document.getElementById('serviceGrid');
  assert.ok(grid.textContent.includes(evilName), 'nama layanan tampil utuh sebagai teks');
  const hits = findInjected(window.document);
  assert.deepEqual(hits, [], 'HTML aktif tertanam di grid layanan:\n' + hits.join('\n'));
  // Tombol "Pilih" tetap membawa nama asli ke halaman reservasi.
  let target = null;
  window.eval('goReserve = function (n, p) { window.__target = [n, p]; }');
  grid.querySelector('.order-btn').click();
  target = window.__target;
  window.close();
  assert.deepEqual(Array.from(target), [evilName, 80000]);
});

test('XSS: pesan error server di formulir reservasi di-escape (nama layanan dipantulkan server)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/reservasi.html'), 'utf8');
  assert.match(html, /alert-error">❌ \$\{esc\(err\.message\)\}/, 'err.message wajib esc()');
  assert.match(html, /<em>\(\$\{esc\(note\)\}\)<\/em>/, 'catatan libur wajib esc()');
  assert.doesNotMatch(html, /innerHTML = `[^`]*\$\{err\.message\}/, 'tidak ada err.message mentah ke innerHTML');
  const admin = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  const raw = admin.split('\n').filter((l) => /innerHTML/.test(l) && /(\$\{(e|err)\.message\}|\+ (e|err)\.message \+)/.test(l));
  assert.deepEqual(raw, [], 'admin.js: pesan error mentah ke innerHTML');
});
