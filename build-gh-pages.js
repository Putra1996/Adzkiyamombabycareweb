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

console.log('\n[build] ✅ Done! docs/ folder is ready for GitHub Pages.');
console.log('[build] Push to GitHub and enable Pages from /docs branch in Settings > Pages.');
