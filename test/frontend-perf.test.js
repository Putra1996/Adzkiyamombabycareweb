// Uji regresi frontend: kecepatan muat & bug yang ditemukan saat audit
// 1 Oktober 2026.
//
//  - `<script defer>` INLINE diabaikan browser (defer hanya berlaku untuk
//    skrip ber-src). Skrip inline yang mengira dirinya "defer" jalan SEBELUM
//    api-config.js/main.js → di GitHub Pages reservasi dikirim ke
//    github.io/api (404) dan fmtRp belum ada (ReferenceError).
//  - Setiap aset relatif yang dirujuk HTML harus ada (dulu img/logo.png
//    tidak ada di public/ → logo 404 di Vercel).
//  - Logo bawaan kecil (≤ 512 px) dan tiga salinannya identik.
//  - Chart.js tidak diunduh ganda & memakai SRI.
//  - Simulasi GitHub Pages (jsdom): beranda & reservasi memanggil API
//    Vercel, bukan github.io.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
let JSDOM, ResourceLoader, VirtualConsole, requestInterceptor;
try { ({ JSDOM, ResourceLoader, VirtualConsole, requestInterceptor } = require('jsdom')); } catch { /* opsional */ }

const htmlFiles = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));

test('Tidak ada <script defer> inline (defer diabaikan untuk skrip tanpa src)', () => {
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(PUB, f), 'utf8');
    const bad = html.match(/<script\b(?![^>]*\bsrc=)[^>]*\bdefer\b[^>]*>/gi) || [];
    assert.deepEqual(bad, [], f + ': skrip inline ber-defer (jalan lebih awal dari yang dikira)');
  }
});

test('Semua aset relatif yang dirujuk HTML benar-benar ada di public/', () => {
  for (const f of htmlFiles) {
    // Hanya markup: isi skrip inline & komentar dibuang (tag <script src> tetap).
    const html = fs.readFileSync(path.join(PUB, f), 'utf8')
      .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const m of html.matchAll(/\b(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
      const u = m[1];
      if (/^(https?:|data:|mailto:|tel:|javascript:|\/\/)/i.test(u)) continue;
      if (/^\/?(api|health|kwitansi|receipt)\b/.test(u) || /manifest\.webmanifest$/.test(u)) continue; // rute server
      if (u.includes('${')) continue; // template literal di skrip
      if (u === '/' || u.endsWith('/')) continue;
      const p = path.join(PUB, u.replace(/^\//, ''));
      assert.ok(fs.existsSync(p) || fs.existsSync(p + '.html'), `${f} merujuk "${u}" yang tidak ada (404)`);
    }
  }
});

test('Logo bawaan kecil (≤ 512 px lebar, < 40 KB) dan ketiga salinannya identik', () => {
  const png = fs.readFileSync(path.join(ROOT, 'seed-logo.png'));
  assert.equal(png.slice(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16);
  assert.ok(width <= 512, 'lebar logo ' + width + ' px');
  assert.ok(png.length < 40 * 1024, 'ukuran logo ' + png.length + ' byte');
  const b64 = fs.readFileSync(path.join(ROOT, 'seed-logo.b64'), 'utf8').trim();
  assert.equal(b64, png.toString('base64'), 'seed-logo.b64 ≠ seed-logo.png');
  delete require.cache[require.resolve(path.join(ROOT, 'seed-logo.js'))];
  assert.equal(String(require(path.join(ROOT, 'seed-logo.js'))).trim(), b64, 'seed-logo.js ≠ seed-logo.png');
});

test('Beranda: font tidak memblokir render, skrip defer berurutan', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<link\b[^>]*fonts\.googleapis\.com\/css[^>]*>/gi)) {
    if (/<noscript>[^]*$/.test(html.slice(0, m.index)) && !/<\/noscript>/.test(html.slice(html.lastIndexOf('<noscript>', m.index), m.index))) continue;
    assert.match(m[0], /media="print"/, 'stylesheet Google Fonts memblokir render: ' + m[0]);
  }
  const order = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const idx = (n) => order.findIndex((s) => s.endsWith(n));
  assert.ok(idx('api-config.js') > -1 && idx('api-config.js') < idx('main.js'), 'api-config.js harus sebelum main.js');
});

test('Panel admin: Chart.js tidak dimuat di <head>, dimuat sekali dengan SRI', () => {
  const html = fs.readFileSync(path.join(PUB, 'admin.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]*chart\.umd/i, 'Chart.js di admin.html (menunda admin.js & diunduh ganda)');
  const js = fs.readFileSync(path.join(PUB, 'js', 'admin.js'), 'utf8');
  assert.match(js, /CHARTJS_SRI = 'sha384-[A-Za-z0-9+/=]{64}'/);
  assert.doesNotMatch(js, /chart\.umd\.min\.js/, 'chart.umd.min.js tidak ada di paket npm (unpkg 404)');
  assert.match(js, /cdn\.jsdelivr\.net\/npm\/chart\.js@4\.4\.0\/dist\/chart\.umd\.js/);
});

// ---------------------------------------------------------------------------
// Simulasi GitHub Pages (docs/ di putra1996.github.io)
// ---------------------------------------------------------------------------
const PAGES = 'https://putra1996.github.io/Adzkiyamombabycareweb/';
const VERCEL = 'https://adzkiyamombabycareweb.vercel.app';

function pagesFile(url) {
  if (!url.startsWith(PAGES)) return null;
  const rel = decodeURIComponent(new URL(url).pathname.replace('/Adzkiyamombabycareweb/', ''));
  const p = path.join(ROOT, 'docs', rel);
  return /\.js$/.test(rel) && fs.existsSync(p) ? fs.readFileSync(p) : null;
}
// Skrip docs/ dilayani dari disk; gambar/CSS/CDN tidak dimuat.
function makeResources() {
  if (requestInterceptor) {
    return { interceptors: [requestInterceptor((request) => {
      const buf = pagesFile(request.url);
      return buf ? new Response(buf, { headers: { 'Content-Type': 'application/javascript' } }) : new Response('', { status: 404 });
    })] };
  }
  return new (class extends ResourceLoader {
    fetch(url) { const buf = pagesFile(url); return buf ? Promise.resolve(buf) : null; }
  })();
}

async function openPagesDoc(file) {
  const calls = [];
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Could not load|Not implemented|Could not parse CSS/.test(e.message)) errors.push(e.message); });
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));
  const html = fs.readFileSync(path.join(ROOT, 'docs', file), 'utf8');
  const services = [{ cat: 'Ibu Hamil', items: [{ name: 'Massage Ibu Hamil', price: 80000 }] }]; // format /api/services
  const dom = new JSDOM(html, {
    url: PAGES + file, runScripts: 'dangerously', resources: makeResources(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async (u) => {
        const url = new URL(String(u), PAGES + file).toString();
        calls.push(url);
        const body = /\/api\/services/.test(url) ? services : /\/api\/calendar/.test(url) ? [] : { business_name: 'Adzkiya', has_logo: true, socials: [], testimonials: [] };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      };
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.message || e.message)));
      w.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
    }
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !calls.some((c) => /\/api\/(public-settings|services)/.test(c))) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  dom.window.close();
  return { calls, errors };
}

const jsdomSkip = JSDOM ? false : 'jsdom tidak terpasang (npm install --no-save jsdom)';

for (const file of ['index.html', 'reservasi.html']) {
  test(`GitHub Pages: ${file} memanggil API Vercel (bukan github.io) tanpa error`, { skip: jsdomSkip }, async () => {
    const { calls, errors } = await openPagesDoc(file);
    const api = calls.filter((c) => /\/api\//.test(c));
    assert.ok(api.length > 0, 'tidak ada panggilan API sama sekali');
    for (const c of api) assert.ok(c.startsWith(VERCEL + '/api/'), `${file} memanggil ${c}`);
    assert.deepEqual(errors, [], `${file} error runtime`);
  });
}
