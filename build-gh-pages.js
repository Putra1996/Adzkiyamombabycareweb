#!/usr/bin/env node
/**
 * Build script for GitHub Pages static site.
 * Reads data.json and generates static HTML/JS files in docs/ folder.
 *
 * Usage: node build-gh-pages.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'docs');
const DATA_FILE = path.join(ROOT, 'data.json');

// Ensure directories exist
['docs', 'docs/css', 'docs/js', 'docs/img', 'docs/data'].forEach(dir => {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

// Load data
let data = {};
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.warn('[build] Warning: Could not read data.json, using defaults');
}

const settings = data.settings || {};
const logoB64 = settings.logo_b64 || '';

// Save logo if available
if (logoB64) {
  const logoBuf = Buffer.from(logoB64, 'base64');
  fs.writeFileSync(path.join(DOCS, 'img', 'logo.png'), logoBuf);
  console.log('[build] Logo saved (' + logoBuf.length + ' bytes)');
} else if (fs.existsSync(path.join(ROOT, 'seed-logo.png'))) {
  // data.json tidak ada (mis. clone segar) — pakai logo bawaan repo supaya
  // docs/img/logo.png tidak pernah hilang dari mirror Pages.
  fs.copyFileSync(path.join(ROOT, 'seed-logo.png'), path.join(DOCS, 'img', 'logo.png'));
  console.log('[build] Logo dari seed-logo.png (data.json tidak dibaca)');
}

// Build public settings (mimicking /api/public-settings endpoint)
const publicSettings = {

  business_name: settings.business_name || 'Adzkiya Mom Baby Care',
  tagline: settings.tagline || '',
  address: settings.address || '',
  phone: settings.phone || '',
  area: settings.area || '',
  type: settings.type || '',
  practitioner: settings.practitioner || '',
  instagram: settings.instagram || '',
  has_logo: !!settings.logo_b64,
  has_hero: !!settings.hero_b64,
  has_qris: !!settings.qris_b64,
  qris_link: settings.qris_link || '',
  bank_accounts: settings.bank_accounts || [],
  primary_color: settings.primary_color,
  accent_color: settings.accent_color,
  gmaps_url: settings.gmaps_url || '',
  gmaps_embed: settings.gmaps_embed || '',
  hours: settings.hours || [],
  testimonials: settings.testimonials || [],
  socials: (settings.socials || []).filter(function(x) { return x && x.url; })
};

// Build calendar data (only approved reservations)
const calendarEvents = [];
(data.reservations || []).filter(function(r) { return r.status === 'approved'; }).forEach(function(r) {
  (r.slots || []).forEach(function(s) {
    calendarEvents.push({
      id: r.id,
      service_name: (r.items && r.items.length > 1) ? r.items[0].name + ' +' + (r.items.length - 1) : (r.items && r.items[0] ? r.items[0].name : r.service_name),
      reservation_date: s.date,
      reservation_time: s.time
    });
  });
});

// Save calendar data
fs.writeFileSync(path.join(DOCS, 'data', 'calendar.json'), JSON.stringify(calendarEvents));
console.log('[build] Calendar data saved (' + calendarEvents.length + ' events)');

// Copy CSS
fs.copyFileSync(
  path.join(ROOT, 'public', 'css', 'style.css'),
  path.join(DOCS, 'css', 'style.css')
);
console.log('[build] CSS copied');

// Keep the GitHub Pages admin and reservation clients in sync with their maintained sources.
fs.copyFileSync(path.join(ROOT, 'public', 'admin.html'), path.join(DOCS, 'admin.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'reservasi.html'), path.join(DOCS, 'reservasi.html'));
fs.copyFileSync(path.join(ROOT, 'public', 'js', 'admin.js'), path.join(DOCS, 'js', 'admin.js'));
console.log('[build] Admin and reservation clients copied');

// CATATAN: data layanan & pengaturan TIDAK ditanam ke docs/js/main.js.
// Mirror GitHub Pages memanggil API produksi (Vercel) lewat js/api-config.js;
// dulu ada blok "embedded data" yang mencari penanda SERVICES_DATA/
// SETTINGS_DATA di main.js — penanda itu sudah tidak ada sehingga blok itu
// tidak pernah melakukan apa-apa (dead code) dan kini dihapus.

// ===== MIRROR public/ -> docs/ DENGAN PATH RELATIF =====
//
// GitHub Pages menyajikan repo ini dari SUB-FOLDER
// (https://putra1996.github.io/Adzkiyamombabycareweb/), jadi referensi
// root-absolut seperti /css/style.css, /js/main.js, /api/logo, atau
// /reservasi.html akan menuju root domain github.io dan berakhir 404 —
// halaman tampil tanpa CSS/JS. Di langkah ini file dari public/ disalin
// ke docs/ dan referensi tsb diubah menjadi relatif.
//
// public/ SENDIRI TIDAK DIUBAH sedikit pun, karena Railway menyajikan
// folder itu dari root domain (path absolut di sana justru yang benar).
//
// Jalankan `npm run build:pages` setiap kali file di public/ berubah,
// lalu commit folder docs/.
const PAGES_COPY = [
  'index.html', 'kalender.html', 'reservasi.html', 'admin.html', '404.html', 'kwitansi-share.html',
  'css/style.css', 'sw.js',
  'js/api-config.js', 'js/i18n.js', 'js/main.js', 'js/kalender.js', 'js/admin.js',
];
// robots.txt TIDAK lagi disalin dari public/ (file itu dihapus dari repo —
// server Express punya handler dinamis dengan host yang benar). Untuk
// GitHub Pages versi statisnya dibuat di bawah.

// Aset statis dari data.json (agar <img src="/api/logo"> tetap tampil di
// GitHub Pages yang tidak punya endpoint /api/*).
function writeStaticAsset(settingKey, fileName) {
  const b64 = settings[settingKey];
  if (!b64) return false;
  try {
    fs.writeFileSync(path.join(DOCS, 'img', fileName), Buffer.from(b64, 'base64'));
    return true;
  } catch (e) {
    console.warn('[build] Gagal menulis docs/img/' + fileName + ': ' + e.message);
    return false;
  }
}
const hasLogoAsset = writeStaticAsset('logo_b64', 'logo.png') || fs.existsSync(path.join(DOCS, 'img', 'logo.png'));
const hasQrisAsset = writeStaticAsset('qris_b64', 'qris.png');
const hasHeroAsset = writeStaticAsset('hero_b64', 'hero.png');

function rewriteForPages(content) {
  let out = content;
  // 1) Endpoint gambar -> file statis lokal (kalau asetnya ada).
  if (hasLogoAsset) out = out.replace(/(href|src|content)="\/api\/logo"/g, '$1="img/logo.png"');
  if (hasQrisAsset) out = out.replace(/(href|src|content)="\/api\/qris"/g, '$1="img/qris.png"');
  if (hasHeroAsset) out = out.replace(/(href|src|content)="\/api\/hero"/g, '$1="img/hero.png"');
  // 2) Path absolut halaman/aset -> relatif.
  //    "/" dan "/#anchor" menunjuk beranda; "/admin" halaman login admin.
  out = out.replace(/(href|src|action|content)="\/([^"]*)"/g, (match, attr, rest) => {
    if (/^api\//.test(rest)) return match; // endpoint API: dibiarkan (ditangani js/api-config.js)
    let target;
    if (rest === '' || rest.startsWith('#') || rest.startsWith('?')) target = 'index.html' + rest;
    else if (rest === 'admin' || rest === 'admin/') target = 'admin.html';
    else target = rest;
    return attr + '="' + target + '"';
  });
  // 3) Referensi absolut di dalam script/style inline: '/js/...', '/css/...'.
  out = out.replace(/(["'(])\/(js|css|img|data)\//g, '$1$2/');
  // 4) Service worker diregistrasi lewat JS inline: register('/sw.js') —
  //    GitHub Pages menyajikan repo di sub-folder, jadi harus relatif.
  out = out.replace(/(["'(])\/sw\.js/g, '$1sw.js');
  return out;
}

let mirrorCount = 0;
for (const rel of PAGES_COPY) {
  const src = path.join(ROOT, 'public', rel);
  if (!fs.existsSync(src)) { console.warn('[build] Lewati (tidak ada): public/' + rel); continue; }
  const dest = path.join(DOCS, rel);
  let content = fs.readFileSync(src, 'utf8');
  if (/\.(html)$/.test(rel)) content = rewriteForPages(content);
  fs.writeFileSync(dest, content);
  mirrorCount++;
}
console.log('[build] Mirror public/ -> docs/ selesai (' + mirrorCount + ' file, path relatif)');

// ===== PWA manifest statis =====
// Di Vercel/Railway, /manifest.webmanifest dilayani dinamis oleh server
// (ikon dari /api/logo). GitHub Pages tidak punya backend, jadi manifest
// dibuat statis dengan ikon img/logo.png dan start_url './' (sub-folder).
const ghPagesManifest = {
  name: (settings.business_name || 'Adzkiya Mom Baby Care') + ' — Reservasi & Layanan',
  short_name: 'Adzkiya',
  description: settings.tagline || 'Layanan kesehatan ibu & anak, home service Cilacap.',
  start_url: './?pwa=1',
  scope: './',
  display: 'standalone',
  background_color: '#fffafc',
  theme_color: settings.primary_color || '#ee5a8a',
  lang: 'id',
  icons: [
    { src: 'img/logo.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'img/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'img/logo.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ],
  shortcuts: [
    { name: 'Reservasi', url: './reservasi.html' },
    { name: 'Kalender', url: './kalender.html' },
    { name: 'Chat AI', url: './index.html?chat=1' }
  ]
};
fs.writeFileSync(path.join(DOCS, 'manifest.webmanifest'), JSON.stringify(ghPagesManifest, null, 2));
console.log('[build] manifest.webmanifest ditulis (statis, ikon img/logo.png)');

// ===== robots.txt statis =====
// URL sitemap produksi dikelola server (dinamis per host); di GitHub Pages
// cukup aturan izin/crawl tanpa baris Sitemap.
fs.writeFileSync(path.join(DOCS, 'robots.txt'), [
  '# Adzkiya Mom Baby Care — robots.txt (GitHub Pages)',
  'User-agent: *',
  'Allow: /',
  'Disallow: /admin',
  'Disallow: /admin.html',
  'Disallow: /api/',
  'Disallow: /kwitansi-share.html',
  ''
].join('\n'));
console.log('[build] robots.txt ditulis (statis, tanpa Sitemap)');

console.log('\n[build] ✅ Done! docs/ folder is ready for GitHub Pages.');
console.log('[build] Push to GitHub and publish GitHub Pages from the main branch /docs folder.');
