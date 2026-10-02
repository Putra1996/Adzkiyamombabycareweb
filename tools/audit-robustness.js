#!/usr/bin/env node
// Audit ketahanan (fuzzing) semua route server.
//
// Membaca daftar route langsung dari server.js, lalu mengirim input aneh ke
// SETIAP route — ID ngawur, JSON rusak, tipe data salah, body kosong,
// dengan & tanpa login admin. Yang dianggap masalah:
//   - status 5xx (server error karena input klien),
//   - tidak menjawab dalam 10 detik (request menggantung),
//   - server mati / /health tidak menjawab setelah suatu request.
//
// Pemakaian (server SEGAR, DATA_FILE SEGAR):
//   BASE=http://127.0.0.1:3000 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tools/audit-robustness.js
// Opsi: SERVER_LOG=/path/log-server (untuk menampilkan stack trace terkait).
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'a@b.id';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password12345';
const TIMEOUT_MS = Number(process.env.FUZZ_TIMEOUT_MS || 10000);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Rute yang sengaja dilewati: memanggil layanan luar sungguhan / sangat lambat
// secara desain. (Tetap diuji tanpa login — harus 401/403, bukan 5xx.)
const SKIP_WITH_AUTH = new Set([]);

const routes = [];
for (const m of SRC.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'(\/[^']*)'/g)) {
  routes.push({ method: m[1].toUpperCase(), path: m[2] });
}

// Rute yang tidak terbaca regex (array path / regex).
routes.push({ method: 'GET', path: '/health' }, { method: 'GET', path: '/kwitansi/:token' });

const PARAM_VALUES = ['1', '999999', 'abc', '-1', '0', '1e309', '%2e%2e%2f', "x'%22<", ''.padEnd(300, '9')];
const BODIES = [
  undefined,
  '{}',
  '[]',
  'null',
  '"teks"',
  '{"rusak":',               // JSON tidak valid
  '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}',
  JSON.stringify({ id: {}, status: ['x'], date: 123, time: {}, items: 'bukan-array', slots: 5, name: null, patient_name: [], whatsapp: {}, total: 'abc', amount: -1e309, qty: 'x', rating: 99, email: [], password: {}, settings: 'x', mode: {}, url: 5, confirm: [], text: { a: 1 }, message: [], messages: 'x', phone: {}, kind: [] }),
  JSON.stringify({ amount: 'abc', date: '2026-13-45', category: {}, note: {}, description: [], stock: 'x', min_stock: {}, unit: [], qty: {}, type: {}, status: 'approved', payment_status: {}, reservation_date: 'besok', reservation_time: [], total: 'abc', price: 'mahal', name: 'Uji', service_name: {}, total_sessions: 'x', used_sessions: -5 }),
  JSON.stringify({ amount: 1e308, date: '0000-00-00', name: ''.padEnd(5000, 'x'), stock: -1, price: -100, qty: 0, items: [{ name: 'A', price: 'x', qty: 'y' }], tagline: { x: 1 }, testimonials: 'x', blackout_dates: 'x', hours: {}, reminder_hours_before: 'abc', notif_sound: 'mungkin' }),
  JSON.stringify({ items: [null, 1, 'x', { name: {} }], slots: [null, { date: 'kemarin', time: 99 }], reservations: 'x', receipts: [null], supplies: [null, 1] })
];

function fill(p, v) {
  return p.replace(/:([A-Za-z_]+)(\([^)]*\))?\??/g, () => encodeURIComponent(v).replace(/%25/g, '%'));
}

async function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
    const body = await r.text().catch(() => '');
    return { status: r.status, body: body.slice(0, 200), ms: Date.now() - started };
  } catch (e) {
    return { status: e.name === 'AbortError' ? 'HANG' : 'NETERR', body: e.message, ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

async function alive() {
  const r = await timedFetch(BASE + '/health', {});
  return r.status === 200;
}

(async () => {
  const lr = await timedFetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  let token = '';
  try { token = JSON.parse(lr.body).token || ''; } catch {}
  if (!token) { try { token = JSON.parse((await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) })).text())).token || ''; } catch {} }
  if (!token) { console.error('Login admin gagal — audit dibatalkan.'); process.exit(2); }

  const problems = [];
  let total = 0;
  for (const rt of routes) {
    // Jangan mengganti kredensial/logout di tengah audit.
    if (/\/api\/auth\/(login|logout|change-password)|\/api\/admin\/(admins|account|password)/.test(rt.path) && rt.method !== 'GET') continue;
    const hasParam = rt.path.includes(':');
    const urls = hasParam ? PARAM_VALUES.map((v) => fill(rt.path, v)) : [rt.path];
    for (const auth of [false, true]) {
      if (auth && SKIP_WITH_AUTH.has(rt.path)) continue;
      for (const u of urls) {
        const bodies = (rt.method === 'GET' || rt.method === 'DELETE') ? [undefined] : BODIES;
        for (const b of bodies) {
          total++;
          const headers = {};
          if (auth) headers.Authorization = 'Bearer ' + token;
          if (b !== undefined) headers['Content-Type'] = 'application/json';
          const r = await timedFetch(BASE + u + (rt.method === 'GET' ? '?from=x&to=%00&q[]=1&limit=-5' : ''), { method: rt.method, headers, body: b });
          const bad = r.status === 'HANG' || r.status === 'NETERR' || (typeof r.status === 'number' && r.status >= 500 && r.status !== 503);
          if (bad) {
            problems.push({ route: rt.method + ' ' + rt.path, url: u, auth, body: b === undefined ? '(kosong)' : b.slice(0, 60), status: r.status, resp: r.body.slice(0, 120) });
            if (!(await alive())) {
              problems.push({ route: rt.method + ' ' + rt.path, url: u, auth, body: String(b).slice(0, 60), status: 'SERVER MATI', resp: '' });
              console.log(JSON.stringify({ total, problems }, null, 1));
              process.exit(1);
            }
          }
        }
      }
    }
  }
  // Integritas data: input aneh tidak boleh TERSIMPAN sebagai data rusak.
  const bk = await timedFetch(BASE + '/api/admin/backup', { headers: { Authorization: 'Bearer ' + token } });
  let data = null;
  try { data = JSON.parse((await (await fetch(BASE + '/api/admin/backup', { headers: { Authorization: 'Bearer ' + token } })).text())); } catch {}
  const integrity = [];
  if (!data) integrity.push('backup tidak bisa dibaca (status ' + bk.status + ')');
  else {
    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const isText = (v) => v == null || typeof v === 'string';
    const checkItems = (where, items) => {
      if (!Array.isArray(items)) return integrity.push(where + ': items bukan daftar');
      items.forEach((it, i) => {
        if (!it || typeof it !== 'object') return integrity.push(where + ': item #' + i + ' bukan objek');
        if (typeof it.name !== 'string' || !it.name) integrity.push(where + ': item #' + i + ' nama tidak valid');
        if (!isNum(Number(it.price)) || it.price === null || it.price === '') integrity.push(where + ': item #' + i + ' harga tidak valid (' + JSON.stringify(it.price) + ')');
      });
    };
    for (const r of data.reservations || []) {
      const w = 'reservasi #' + r.id;
      if (!isNum(r.total)) integrity.push(w + ': total ' + JSON.stringify(r.total));
      if (!isDate(r.reservation_date)) integrity.push(w + ': tanggal ' + JSON.stringify(r.reservation_date));
      for (const f of ['patient_name', 'whatsapp', 'address', 'status', 'payment_method']) if (!isText(r[f])) integrity.push(w + ': ' + f + ' bukan teks');
      checkItems(w, r.items);
    }
    for (const k of data.receipts || []) {
      const w = 'kwitansi #' + k.id;
      if (!isNum(k.total)) integrity.push(w + ': total ' + JSON.stringify(k.total));
      if (!isDate(k.service_date)) integrity.push(w + ': tanggal ' + JSON.stringify(k.service_date));
      for (const f of ['patient_name', 'whatsapp', 'address']) if (!isText(k[f])) integrity.push(w + ': ' + f + ' bukan teks');
      checkItems(w, k.items);
    }
    for (const e of data.expenses || []) {
      const w = 'pengeluaran #' + e.id;
      if (!isNum(e.amount)) integrity.push(w + ': jumlah ' + JSON.stringify(e.amount));
      if (!isDate(e.date)) integrity.push(w + ': tanggal ' + JSON.stringify(e.date));
      for (const f of ['category', 'note', 'description']) if (!isText(e[f])) integrity.push(w + ': ' + f + ' bukan teks');
    }
    for (const sp of data.supplies || []) {
      const w = 'stok #' + sp.id;
      if (typeof sp.name !== 'string' || !sp.name) integrity.push(w + ': nama tidak valid');
      for (const f of ['stock', 'min_stock']) if (sp[f] != null && !isNum(sp[f])) integrity.push(w + ': ' + f + ' ' + JSON.stringify(sp[f]));
    }
    const st = data.settings || {};
    for (const f of ['business_name', 'tagline', 'address', 'phone']) if (!isText(st[f])) integrity.push('settings.' + f + ' bukan teks (' + JSON.stringify(st[f]).slice(0, 40) + ')');
    for (const f of ['testimonials', 'socials', 'bank_accounts', 'blackout_dates']) if (st[f] != null && !Array.isArray(st[f])) integrity.push('settings.' + f + ' bukan daftar (' + JSON.stringify(st[f]).slice(0, 40) + ')');
  }
  console.log('Integritas data: ' + (integrity.length ? integrity.length + ' pelanggaran' : 'OK'));
  for (const x of [...new Set(integrity)].slice(0, 40)) console.log('   ! ' + x);

  // Ringkas per rute.
  const byRoute = new Map();
  for (const p of problems) {
    const k = p.route + ' → ' + p.status;
    if (!byRoute.has(k)) byRoute.set(k, { ...p, count: 0 });
    byRoute.get(k).count++;
  }
  console.log('Rute: ' + routes.length + ' | Request: ' + total + ' | Masalah: ' + problems.length + ' (' + byRoute.size + ' jenis)');
  for (const [k, p] of byRoute) console.log(' - ' + k + ' ×' + p.count + ' | contoh url=' + p.url + ' auth=' + p.auth + ' body=' + p.body + ' | ' + p.resp);
  console.log((await alive()) ? 'Server tetap hidup.' : 'SERVER MATI di akhir audit.');
  process.exit(problems.length || integrity.length ? 1 : 0);
})();
