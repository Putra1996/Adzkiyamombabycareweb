'use strict';
// Halaman publik saat API gagal (database mati, 5xx, halaman error HTML
// dari platform, atau respons tak terduga). Dulu:
//   • reservasi.html crash (TypeError) bila /api/public-settings = null,
//   • kalender.html diam-diam menampilkan SEMUA tanggal kosong/tersedia,
//   • kwitansi-share.html menyebut "link tidak valid" saat server gangguan
//     dan judul tetap "Memuat kwitansi...".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM, VirtualConsole, requestInterceptor;
try { ({ JSDOM, VirtualConsole, requestInterceptor } = require('jsdom')); } catch { /* opsional */ }
const skip = (JSDOM && requestInterceptor) ? false : 'jsdom tidak terpasang (npm install --no-save jsdom)';

const ROOT = process.env.RESILIENCE_ROOT || path.resolve(__dirname, '..', 'public');
const BASE = 'https://adzkiya.test/';

function resp(status, body, type) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (/content-type/i.test(h) ? type : null) },
    json: async () => JSON.parse(body), text: async () => body };
}
const MODES = {
  network: () => Promise.reject(new TypeError('Failed to fetch')),
  html503: () => Promise.resolve(resp(503, '<!doctype html><h1>FUNCTION_INVOCATION_FAILED</h1>', 'text/html')),
  null200: () => Promise.resolve(resp(200, 'null', 'application/json'))
};

async function open(file, mode) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Could not load|Not implemented|Could not parse CSS/.test(e.message)) errors.push(e.message); });
  const onRej = (e) => errors.push('unhandled: ' + (e && e.message || e));
  process.on('unhandledRejection', onRej);
  const html = fs.readFileSync(path.join(ROOT, file.split('?')[0]), 'utf8');
  const dom = new JSDOM(html, {
    url: BASE + file, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    resources: { interceptors: [requestInterceptor((req) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url).pathname));
      return /\.js$/.test(p) && fs.existsSync(p) ? new Response(fs.readFileSync(p), { headers: { 'Content-Type': 'application/javascript' } }) : new Response('', { status: 404 });
    })] },
    beforeParse(w) {
      Object.defineProperty(w.navigator, 'language', { value: 'id-ID', configurable: true });
      w.localStorage.setItem('adz_lang', 'id');
      w.fetch = () => MODES[mode]();
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.addEventListener('error', (e) => errors.push('error: ' + (e.error && e.error.message || e.message)));
      w.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason && e.reason.message || e.reason)));
    }
  });
  await new Promise((r) => setTimeout(r, 1500));
  process.off('unhandledRejection', onRej);
  return { dom, doc: dom.window.document, errors };
}

test('reservasi.html tidak crash saat API gagal / respons null', { skip, timeout: 30000 }, async () => {
  for (const mode of Object.keys(MODES)) {
    const { dom, errors } = await open('reservasi.html', mode);
    assert.deepEqual(errors, [], `reservasi.html (${mode}) error JS`);
    dom.window.close();
  }
});

test('kalender.html memberi tahu bila jadwal gagal dimuat (bukan tampil kosong)', { skip, timeout: 30000 }, async () => {
  for (const mode of Object.keys(MODES)) {
    const { dom, doc, errors } = await open('kalender.html', mode);
    assert.deepEqual(errors, [], `kalender.html (${mode}) error JS`);
    const notice = doc.getElementById('calLoadNotice');
    assert.ok(notice, `kalender.html (${mode}) tidak menampilkan peringatan gagal muat`);
    assert.ok(notice.querySelector('button'), 'ada tombol coba lagi');
    dom.window.close();
  }
});

test('kwitansi-share.html: gangguan server ≠ link tidak valid', { skip, timeout: 30000 }, async () => {
  for (const mode of Object.keys(MODES)) {
    const { dom, doc, errors } = await open('kwitansi-share.html?t=a.b.c', mode);
    assert.deepEqual(errors, [], `kwitansi (${mode}) error JS`);
    const title = doc.getElementById('pageTitle').textContent;
    const detail = doc.getElementById('statusDetail').textContent;
    assert.ok(!/Memuat/.test(title), `kwitansi (${mode}) judul masih "${title}"`);
    assert.ok(!/kadaluarsa|tidak valid/i.test(detail), `kwitansi (${mode}) menyebut link tidak valid: ${detail}`);
    assert.ok(doc.querySelector('#statusDetail button'), `kwitansi (${mode}) tidak ada tombol coba lagi`);
    dom.window.close();
  }
});
