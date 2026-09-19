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

// Build main.js with embedded data
const servicesCode = `
// Embedded services data (from server.js SERVICES)
const SERVICES_DATA = [
  { cat: 'Basic Treatment Ibu', items: [
    { name: 'Massage Ibu Hamil', price: 80000 },
    { name: 'Massage Ibu Nifas', price: 80000 },
    { name: 'Massage Laktasi', price: 80000 },
    { name: 'Massage Induksi', price: 80000 },
  ]},
  { cat: 'Paket Spa Ibu Hamil', items: [
    { name: 'Serenity Bump Package', price: 115000 },
    { name: 'Blooming Mama Package', price: 125000 },
    { name: 'Adzkiya Glow Package', price: 135000 },
  ]},
  { cat: 'Basic Spa Untuk Ibu', items: [
    { name: 'Harmony Spa', price: 105000 },
    { name: 'Blooming Spa', price: 115000 },
  ]},
  { cat: 'Perawatan Ibu & Newborn', items: [
    { name: 'Mom & Newborn Care 5 Days', price: 550000 },
    { name: 'Mom & Newborn Care 7 Days', price: 750000 },
    { name: 'Mom & Newborn Care 14 Days', price: 1400000 },
    { name: 'Perawatan Luka Perineum', price: 100000 },
    { name: 'Perawatan Luka Post SC', price: 120000 },
  ]},
  { cat: 'Massage Laktasi (Paket)', items: [
    { name: "Mom's Relief Package (3x)", price: 230000 },
    { name: 'Gentle Flow Package (5x)', price: 350000 },
    { name: 'Lacta Bloom Package (7x)', price: 450000 },
  ]},
  { cat: 'Baby Treatment (0\u201312 Bulan)', items: [
    { name: 'Sleepwell Massage', price: 50000 },
    { name: 'Pijat Bapil', price: 60000 },
    { name: 'Pijat Diare', price: 60000 },
    { name: 'Pijat Sembelit / Konstipasi', price: 60000 },
    { name: 'Pijat Tuina', price: 60000 },
    { name: 'Stimulasi Berjalan', price: 60000 },
    { name: 'Therapy Bapil', price: 80000 },
    { name: 'Baby Gym', price: 70000 },
    { name: 'Baby Haircut / Cukur Gundul', price: 25000 },
  ]},
  { cat: 'Newborn Care', items: [
    { name: 'Newborn Care 3 Days', price: 255000 },
    { name: 'Newborn Care 5 Days', price: 425000 },
    { name: 'Newborn Care 7 Days', price: 595000 },
  ]},
  { cat: 'Toddler Treatment (1\u20133 Tahun)', items: [
    { name: 'Toddler - Sleepwell Massage', price: 65000 },
    { name: 'Toddler - Pijat Bapil', price: 70000 },
    { name: 'Toddler - Pijat Diare', price: 70000 },
    { name: 'Toddler - Pijat Sembelit', price: 70000 },
    { name: 'Toddler - Pijat Tuina', price: 70000 },
    { name: 'Toddler - Therapy Bapil', price: 85000 },
  ]},
  { cat: 'Kids Treatment (4\u20135 Tahun)', items: [
    { name: 'Kids - Sleepwell Massage', price: 65000 },
    { name: 'Kids - Pijat Bapil', price: 70000 },
    { name: 'Kids - Pijat Diare', price: 70000 },
    { name: 'Kids - Pijat Sembelit', price: 70000 },
    { name: 'Kids - Therapy Bapil', price: 85000 },
  ]},
];`;

const settingsCode = `
// Embedded settings data (from data.json)
const SETTINGS_DATA = ${JSON.stringify(publicSettings, null, 2)};`;

// Read the original main.js from docs and replace the data sections
let mainJs = fs.readFileSync(path.join(DOCS, 'js', 'main.js'), 'utf8');

// Replace SERVICES_DATA
const servicesMatch = mainJs.match(/\/\/ Embedded services data[\s\S]*?^];/m);
if (servicesMatch) {
  mainJs = mainJs.replace(servicesMatch[0], servicesCode.trim());
}

// Replace SETTINGS_DATA
const settingsMatch = mainJs.match(/\/\/ Embedded settings data[\s\S]*?^};/m);
if (settingsMatch) {
  mainJs = mainJs.replace(settingsMatch[0], settingsCode.trim());
}

fs.writeFileSync(path.join(DOCS, 'js', 'main.js'), mainJs);
console.log('[build] main.js updated with embedded data');

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
  'index.html', 'kalender.html', 'reservasi.html', 'admin.html', '404.html', 'robots.txt',
  'css/style.css',
  'js/api-config.js', 'js/i18n.js', 'js/main.js', 'js/kalender.js', 'js/admin.js',
];

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

console.log('\n[build] ✅ Done! docs/ folder is ready for GitHub Pages.');
console.log('[build] Push to GitHub and publish GitHub Pages from the main branch /docs folder.');
