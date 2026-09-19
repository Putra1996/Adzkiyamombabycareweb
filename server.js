// Adzkiya Mom Baby Care - Backend v2.2
// Single-host deployment: Express serves both the public/admin frontend
// (from public/ or docs/) and the API (/api/*), backed by PostgreSQL
// (Neon) or MySQL. Same-origin, so no CORS, no separate API hostname.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool: PostgresPool } = require('pg');
// pdf-parse v2 has heavy transitive deps (pdfjs-dist + worker). Load it
// lazily inside the /api/admin/receipts/import-pdf handler so a broken
// pdf-parse install never crashes the boot of the rest of the API.
let _pdfParse = null;
async function getPdfParse() {
  if (!_pdfParse) {
    const mod = require('pdf-parse');
    _pdfParse = mod.PDFParse || mod.default || mod;
  }
  return _pdfParse;
}


// fetchWithTimeout: like fetch() but aborts after `timeoutMs` so a
// slow upstream (Gemini / OpenRouter / Meta Graph) can't hang our
// route forever. Without this, one stuck AI provider would tie up an
// Express worker indefinitely and degrade into the dreaded
// "Railway 502" after a few minutes.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION) app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'adzkiya_local_development_secret';
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_KIND = DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://')
  ? 'postgres'
  : (DATABASE_URL ? 'mysql' : 'file');

if (IS_PRODUCTION && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET production wajib diisi minimal 32 karakter');
}

// ---- DATA LAYER ----
// Production supports PostgreSQL (Neon, Railway Postgres, etc.) and MySQL/TiDB.
// Local development uses JSON.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let DB = {
  admins: [],
  reservations: [],
  receipts: [],
  broadcasts: [],
  expenses: [],
  settings: null,
  _seq: { admins: 0, reservations: 0, receipts: 0, broadcasts: 0, expenses: 0 }
};

let pool = null;
let saveTimer = null;
let saveChain = Promise.resolve();

function normalizeState() {
  DB._seq = DB._seq || { admins: 0, reservations: 0, receipts: 0, broadcasts: 0, expenses: 0 };
  ['admins', 'reservations', 'receipts', 'broadcasts', 'expenses'].forEach((key) => { DB[key] = DB[key] || []; });
  // share_tokens is the persistent mirror of shareTokenMap. Older
  // data.json files won't have this key — initialize to {}.
  DB.share_tokens = DB.share_tokens || {};
}

async function initStorage() {
  if (DATABASE_KIND === 'postgres') {
    // Cap the pool at 5 connections. Neon Free plan allows 10k via
    // the pooler, but each connection holds RAM on the Railway side.
    // 5 is enough for ~50 concurrent users (queueing) on this app.
    let pgOk = false;
    try {
      pool = new PostgresPool({
        connectionString: DATABASE_URL,
        ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      // Verify the connection up front. If Neon is unreachable (cold
      // start, network glitch, expired credentials, wrong URL) we fall
      // back to file storage instead of crashing the process. File
      // mode loses data on every redeploy but keeps the service
      // reachable so the admin can still log in and fix DATABASE_URL.
      await pool.query('SELECT 1');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
      if (result.rows.length) DB = result.rows[0].data;
      pgOk = true;
    } catch (err) {
      console.error('[storage] Postgres unreachable, falling back to file mode: ' + err.message);
      pool = null;
    }
    if (!pgOk) {
      try {
        if (fs.existsSync(DATA_FILE)) DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (e) { /* ignore */ }
    }
  } else if (DATABASE_KIND === 'mysql') {
    pool = mysql.createPool(DATABASE_URL);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INT PRIMARY KEY,
        data LONGTEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    const [rows] = await pool.execute('SELECT data FROM app_state WHERE id = 1');
    if (rows.length) DB = JSON.parse(rows[0].data);
  } else {
    try {
      if (fs.existsSync(DATA_FILE)) DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (error) {
      console.error('[storage] Gagal membaca file lokal:', error.message);
    }
  }

  normalizeState();
  console.log(`[storage] ${DATABASE_KIND}: ${DB.reservations.length} reservasi, ${DB.receipts.length} kwitansi`);
}

async function persistSnapshot(json) {
  if (DATABASE_KIND === 'postgres' && pool) {
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
      [json]
    );
  } else if (DATABASE_KIND === 'mysql' && pool) {
    await pool.execute(
      'INSERT INTO app_state (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
      [json]
    );
  } else {
    await fs.promises.writeFile(DATA_FILE, json);
  }
}

function queueSave() {
  const json = JSON.stringify(DB);
  saveChain = saveChain
    .then(() => persistSnapshot(json))
    .catch((error) => console.error(`[storage] ${DATABASE_KIND} save gagal:`, error.message));
  return saveChain;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    queueSave();
  }, 200);
}

async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    queueSave();
  }
  await saveChain;
}

let server;
async function shutdown() {
  await flush();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function nextId(t) { DB._seq[t] = (DB._seq[t] || 0) + 1; return DB._seq[t]; }

// Mirror a kwitansi (receipt) into a corresponding reservation so that
// the receipt's amount counts toward the monthly Rekap Bulanan
// totalOmzet (which only sums reservations with payment_status='lunas').
//
// The reservation is created with:
//   • status='approved' (the service was rendered — that's why a
//     receipt exists)
//   • payment_status='lunas' (paid in full — that's why a receipt
//     exists with a total > 0)
//   • reservation_date = service_date (the kwitansi's service date)
//   • reservation_time = '09:00' by default (kwitansi doesn't carry a
//     time; admin can edit the reservation later to set the real
//     session time)
//   • items copied as-is
//
// De-duplication: if a matching reservation already exists for the
// same patient + service_date + total (within 1 rupiah), we skip
// creating a duplicate. This protects against the same PDF being
// imported twice.
function syncReceiptToReservation(receipt) {
  if (!receipt || !receipt.patient_name || !receipt.service_date) return null;
  // Skip if a matching reservation already exists.
  const existing = DB.reservations.find((r) =>
    r.patient_name === receipt.patient_name &&
    r.reservation_date === receipt.service_date &&
    Math.abs((r.total || 0) - (receipt.total || 0)) <= 1
  );
  if (existing) return null;
  const items = Array.isArray(receipt.items) ? receipt.items : [];
  if (!items.length) return null;
  // Use the receipt's service_time if it's a valid HH:MM, otherwise
  // default to 09:00. PDFs from "Buat Kwitansi Baru" already carry the
  // time, and the ARINA e-receipt layout has a "Waktu/Jam :" field.
  // Build slots: prefer service_slots (array of {date, time}), fall back
  // to service_times (array of HH:MM), then service_time (single HH:MM),
  // then '09:00'. Each entry becomes one session in the mirrored
  // reservation so multi-waktu kwitansi show up correctly in Rekap
  // Bulanan as a multi-sesi reservation.
  const times = [];
  if (Array.isArray(receipt.service_slots) && receipt.service_slots.length) {
    for (const s of receipt.service_slots) {
      if (s && s.time && /^\d{1,2}:\d{2}$/.test(s.time)) {
        times.push({ date: s.date || receipt.service_date, time: s.time });
      }
    }
  }
  if (!times.length && Array.isArray(receipt.service_times) && receipt.service_times.length) {
    for (const t of receipt.service_times) {
      if (t && /^\d{1,2}:\d{2}$/.test(t)) times.push({ date: receipt.service_date, time: t });
    }
  }
  if (!times.length && receipt.service_time && /^\d{1,2}:\d{2}$/.test(receipt.service_time)) {
    times.push({ date: receipt.service_date, time: receipt.service_time });
  }
  if (!times.length) times.push({ date: receipt.service_date, time: '09:00' });
  // Always include at least one slot
  const slots = times;
  const firstSlot = slots[0];
  const id = nextId('reservations');
  const rec = {
    id,
    patient_name: receipt.patient_name,
    whatsapp: receipt.whatsapp || '',
    address: receipt.address || '',
    items,
    slots,
    item_total: receipt.subtotal || items.reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0),
    total: receipt.total,
    service_name: items.map((it) => it.name).join(', '),
    service_price: receipt.subtotal || items.reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0),
    qty: slots.length,
    reservation_date: receipt.service_date,
    reservation_time: firstSlot.time,
    payment_method: 'Transfer',           // kwitansi implies non-COD
    proof_mime: null,
    proof_b64: null,
    notes: `Auto-generated from kwitansi ${receipt.invoice_no || ''}`.trim(),
    status: 'approved',
    payment_status: 'lunas',
    created_at: receipt.created_at || new Date().toISOString()
  };
  DB.reservations.push(rec);
  return rec;
}

function seedAdmin() {
  const configuredEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  const email = configuredEmail || (IS_PRODUCTION ? '' : 'admin@adzkiya.id');
  const password = configuredPassword || (IS_PRODUCTION ? '' : 'admin123');

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL dan ADMIN_PASSWORD wajib diisi pada production');
  }
  if (IS_PRODUCTION && password.length < 12) {
    throw new Error('ADMIN_PASSWORD production wajib minimal 12 karakter');
  }

  const existing = DB.admins.find((admin) => admin.email.toLowerCase() === email);
  if (!existing) {
    DB.admins.push({
      id: nextId('admins'),
      email,
      password_hash: bcrypt.hashSync(password, 12),
      name: process.env.ADMIN_NAME || 'Tasya Hanifah',
      role: 'super',
      created_at: new Date().toISOString()
    });
  } else if (configuredPassword && process.env.RESET_ADMIN_PASSWORD === 'true') {
    existing.password_hash = bcrypt.hashSync(configuredPassword, 12);
  }
}

function seedSettings() {
  if (DB.settings) return;
  let logo_b64 = null;
  try {
    const p = path.join(__dirname, 'seed-logo.b64');
    if (fs.existsSync(p)) logo_b64 = fs.readFileSync(p, 'utf8').trim();
  } catch (e) {}
  DB.settings = {
    business_name: 'Adzkiya Mom Baby Care',
    tagline: 'Layanan Kesehatan Ibu & Anak Terpercaya',
    address: 'Dusun Klumprit Kulon No. 217, RT 1 RW 1 Klumprit, Nusawungu, Cilacap 53283',
    phone: '085887018194',
    area: 'Nusawungu, Cilacap',
    type: 'Home Service',
    practitioner: 'Tasya Hanifah Pramesti, A.Md. Keb., CBME',
    // Owner signature (bidan/pemilik) — saved once, auto-embedded into
    // every kwitansi's "Hormat kami," block so the admin doesn't have
    // to sign by hand on every printout. Stored as base64 PNG/WebP so
    // we can <img>-embed it without re-encoding on the print path.
    // method records HOW the admin got the signature in here:
    //   'langsung' — drawn on a canvas in the Settings UI
    //   'upload'   — uploaded an image file
    //   'barcode'  — scanned from a QR code that encodes the image
    //   'ocr'      — extracted from a phone-camera OCR/scan
    // via records the human-readable source (e.g. "QR Scanner app",
    // "Google Lens", "Adobe Scan") for audit. at is the ISO date the
    // signature was captured — useful to detect "needs re-capture"
    // after a year, since ink and stamp impressions fade.
    owner_signature_b64: null,
    owner_signature_mime: null,
    owner_signature_method: null,
    owner_signature_via: null,
    owner_signature_at: null,
    logo_b64,
    logo_mime: logo_b64 ? 'image/png' : null,
    hero_b64: null,
    hero_mime: null,
    qris_b64: null,
    qris_mime: null,
    qris_link: '',
    bank_accounts: [
      { bank: 'BSI', number: '7000000000', name: 'Tasya Hanifah Pramesti' }
    ],
    instagram: '',
    transport_fee_default: 0,
    primary_color: '#ee5a8a',
    accent_color: '#ffb979',
    socials: [
      { platform: 'Instagram', url: '', icon: '📷' },
      { platform: 'TikTok',    url: '', icon: '🎵' },
      { platform: 'Facebook',  url: '', icon: '📘' },
      { platform: 'YouTube',   url: '', icon: '▶️' }
    ],
    reminder_hours_before: 2,
    notif_sound: true,
    gmaps_url: 'https://maps.app.goo.gl/V5RcUDQbep3T5ryp7',
    gmaps_embed: '',
    hours: [
      { day: 'Senin',  open: '08:00', close: '20:00', closed: false },
      { day: 'Selasa', open: '08:00', close: '20:00', closed: false },
      { day: 'Rabu',   open: '08:00', close: '20:00', closed: false },
      { day: 'Kamis',  open: '08:00', close: '20:00', closed: false },
      { day: 'Jumat',  open: '08:00', close: '20:00', closed: false },
      { day: 'Sabtu',  open: '08:00', close: '20:00', closed: false },
      { day: 'Minggu', open: '09:00', close: '17:00', closed: false }
    ],
    testimonials: [
      { name: 'Bunda Rina', rating: 5, text: 'Pelayanan sangat ramah, bidan Tasya profesional sekali. Pijat ibu hamil di rumah bikin rileks total. Recommended banget!', source: 'Google Maps' },
      { name: 'Bunda Dewi', rating: 5, text: 'Pijat laktasi sangat membantu, ASI jadi lancar lagi. Datang tepat waktu dan sangat sabar. Terima kasih Adzkiya!', source: 'Google Maps' },
      { name: 'Bunda Sari', rating: 5, text: 'Baby massage anak saya jadi tidur lebih nyenyak. Bidannya sabar dan telaten. Pasti repeat order lagi!', source: 'Google Maps' },
      { name: 'Bunda Putri', rating: 5, text: 'Newborn care nya sangat membantu di masa nifas. Bidan datang ke rumah, jadi tidak perlu repot keluar. Worth it!', source: 'Google Maps' },
      { name: 'Bunda Lina', rating: 5, text: 'Mom spa nya bikin badan segar setelah melahirkan. Tempat tidak perlu jauh-jauh, semua di rumah. Recommended!', source: 'Google Maps' }
    ],
    // Blackout dates — tanggal libur/admin OFF. Pasien tidak bisa pilih
    // tanggal ini di form reservasi, kalender publik, dan admin tidak
    // bisa input kwitansi dengan tanggal layanan ini. Format YYYY-MM-DD.
    blackout_dates: [],
    // Keterangan per tanggal (opsional), untuk ditampilkan ke pasien.
    // { '2026-12-25': 'Libur Natal', '2026-01-01': 'Tahun Baru' }
    blackout_notes: {},
    // Public services slugs — array of strings. Each becomes a
    // URL in /sitemap.xml so Google can index every bookable
    // service. Admin manages this via PUT /api/admin/settings.
    public_services_slugs: [],
    // WhatsApp Blast templates — admin kirim pesan broadcast ke banyak
    // pasien via wa.me (deep-link, tanpa API eksternal). Tiap template
    // punya placeholder yang di-substitute per recipient: {{nama}},
    // {{tanggal}}, {{jam}}, {{layanan}}, {{total}}, {{invoice_no}}.
    whatsapp_templates: [
      {
        id: 'tpl_reminder_h1',
        name: '⏰ Pengingat H-1',
        category: 'reminder',
        body: 'Halo {{nama}}, ini pengingat untuk jadwal layanan besok ({{tanggal}} jam {{jam}}). Sampai jumpa di rumah Anda. Jika ada perubahan, balas WA ini ya. Terima kasih 🌸 - Adzkiya Mom Baby Care'
      },
      {
        id: 'tpl_thanks',
        name: '🙏 Terima Kasih Post-Treatment',
        category: 'followup',
        body: 'Halo {{nama}}, terima kasih sudah mempercayakan perawatan {{layanan}} kepada kami hari ini. Semoga Bunda & si kecil nyaman. Kalau ada keluhan, jangan sungkan hubungi kami ya 🌸'
      },
      {
        id: 'tpl_payment_reminder',
        name: '💰 Pengingat Pembayaran',
        category: 'reminder',
        body: 'Halo {{nama}}, ini pengingat untuk invoice {{invoice_no}} ({{total}}). Jika sudah transfer mohon kirim bukti pembayarannya. Terima kasih! - Adzkiya'
      }
    ]
  };
}

function ensureNewSettings() {
  if (!DB.settings) return;
  if (!DB.settings.hours) DB.settings.hours = [
    { day: 'Senin',  open: '08:00', close: '20:00', closed: false },
    { day: 'Selasa', open: '08:00', close: '20:00', closed: false },
    { day: 'Rabu',   open: '08:00', close: '20:00', closed: false },
    { day: 'Kamis',  open: '08:00', close: '20:00', closed: false },
    { day: 'Jumat',  open: '08:00', close: '20:00', closed: false },
    { day: 'Sabtu',  open: '08:00', close: '20:00', closed: false },
    { day: 'Minggu', open: '09:00', close: '17:00', closed: false }
  ];
  if (!DB.settings.testimonials) DB.settings.testimonials = [];
  if (!('gmaps_url' in DB.settings)) DB.settings.gmaps_url = 'https://maps.app.goo.gl/V5RcUDQbep3T5ryp7';
  if (!('gmaps_embed' in DB.settings)) DB.settings.gmaps_embed = '';
  if (!DB.settings.socials) DB.settings.socials = [
    { platform: 'Instagram', url: DB.settings.instagram || '', icon: '📷' },
    { platform: 'TikTok',    url: '', icon: '🎵' },
    { platform: 'Facebook',  url: '', icon: '📘' },
    { platform: 'YouTube',   url: '', icon: '▶️' }
  ];
  if (typeof DB.settings.reminder_hours_before !== 'number') DB.settings.reminder_hours_before = 2;
  if (typeof DB.settings.notif_sound !== 'boolean') DB.settings.notif_sound = true;
  // Blackout dates — older data.json files won't have these keys.
  // Always coerce to plain JSON-safe values (no Date objects etc.) so
  // the public endpoint can return them as-is.
  if (!Array.isArray(DB.settings.blackout_dates)) DB.settings.blackout_dates = [];
  if (!DB.settings.blackout_notes || typeof DB.settings.blackout_notes !== 'object') DB.settings.blackout_notes = {};
  // Drop any non-ISO entries that may have leaked in from manual edits.
  DB.settings.blackout_dates = DB.settings.blackout_dates
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  // WhatsApp templates — array of {id,name,category,body}. Initialize
  // to the defaults if older data.json doesn't have the key.
  if (!Array.isArray(DB.settings.whatsapp_templates)) {
    DB.settings.whatsapp_templates = [];
  }
  // Each template gets a stable id (tpl_<slug>) so admins can rename
  // labels without breaking the template ID link in old broadcasts.
  if (DB.settings.whatsapp_templates.length === 0) {
    DB.settings.whatsapp_templates = [
      { id: 'tpl_reminder_h1', name: '⏰ Pengingat H-1', category: 'reminder',
        body: 'Halo {{nama}}, ini pengingat untuk jadwal layanan besok ({{tanggal}} jam {{jam}}). Sampai jumpa di rumah Anda. Jika ada perubahan, balas WA ini ya. Terima kasih 🌸 - Adzkiya Mom Baby Care' },
      { id: 'tpl_thanks', name: '🙏 Terima Kasih Post-Treatment', category: 'followup',
        body: 'Halo {{nama}}, terima kasih sudah mempercayakan perawatan {{layanan}} kepada kami hari ini. Semoga Bunda & si kecil nyaman. Kalau ada keluhan, jangan sungkan hubungi kami ya 🌸' },
      { id: 'tpl_payment_reminder', name: '💰 Pengingat Pembayaran', category: 'reminder',
        body: 'Halo {{nama}}, ini pengingat untuk invoice {{invoice_no}} ({{total}}). Jika sudah transfer mohon kirim bukti pembayarannya. Terima kasih! - Adzkiya' }
    ];
  }
  // Public service slugs — array of strings. Older data.json doesn't
  // have this key; default to empty (admin can populate via the
  // Settings page).
  if (!Array.isArray(DB.settings.public_services_slugs)) DB.settings.public_services_slugs = [];
  // Owner signature migration. Older data.json files won't have the
  // owner_signature_* keys — initialize them to null so the rest of
  // the API can safely check `if (s.owner_signature_b64) ...`.
  if (DB.settings.owner_signature_b64 === undefined) DB.settings.owner_signature_b64 = null;
  if (DB.settings.owner_signature_mime === undefined) DB.settings.owner_signature_mime = null;
  if (DB.settings.owner_signature_method === undefined) DB.settings.owner_signature_method = null;
  if (DB.settings.owner_signature_via === undefined) DB.settings.owner_signature_via = null;
  if (DB.settings.owner_signature_at === undefined) DB.settings.owner_signature_at = null;
}

// Async boot — load persistent state, seed defaults, then start the API.
(async () => {
  try {
    await initStorage();
    seedAdmin();
    seedSettings();
    ensureNewSettings();
    // Rehydrate share-tokens from disk/DB so links generated before the
    // last restart still resolve. Done after settings are seeded (so
    // DB.share_tokens is initialized) but before the HTTP server
    // starts accepting requests.
    await loadShareTokens();
    // Schedule periodic pruning of expired tokens so the map and
    // database don't grow forever.
    setInterval(() => { pruneShareTokens().catch(() => {}); }, 6 * 60 * 60 * 1000);
    await queueSave();
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Adzkiya Mom Baby Care v2.2 on 0.0.0.0:${PORT} (storage: ${pool ? DATABASE_KIND : 'file'})`);
    });
  } catch (error) {
    console.error('FATAL boot:', error);
    process.exit(1);
  }
})();

// ---- SERVICES CATALOG ----
const SERVICES = [
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
  { cat: 'Baby Treatment (0–12 Bulan)', items: [
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
  { cat: 'Toddler Treatment (1–3 Tahun)', items: [
    { name: 'Toddler - Sleepwell Massage', price: 65000 },
    { name: 'Toddler - Pijat Bapil', price: 70000 },
    { name: 'Toddler - Pijat Diare', price: 70000 },
    { name: 'Toddler - Pijat Sembelit', price: 70000 },
    { name: 'Toddler - Pijat Tuina', price: 70000 },
    { name: 'Toddler - Therapy Bapil', price: 85000 },
  ]},
  { cat: 'Kids Treatment (4–5 Tahun)', items: [
    { name: 'Kids - Sleepwell Massage', price: 65000 },
    { name: 'Kids - Pijat Bapil', price: 70000 },
    { name: 'Kids - Pijat Diare', price: 70000 },
    { name: 'Kids - Pijat Sembelit', price: 70000 },
    { name: 'Kids - Therapy Bapil', price: 85000 },
  ]},
];

const SERVICE_PRICE_BY_NAME = new Map(
  SERVICES.flatMap((category) => category.items.map((item) => [item.name, item.price]))
);

// ---- MIDDLEWARE ----
app.disable('x-powered-by');
// gzip all responses >=1 KB. Saves ~70% bandwidth on the public HTML
// pages and JSON APIs, which directly reduces Railway egress costs.
app.use(compression({ threshold: 1024 }));
// Light, IP-based rate limit on auth endpoints. Without this, a
// scripted attacker can keep slamming /api/auth/login to consume
// bcrypt CPU (which is the single most expensive thing this app does).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan login. Coba lagi 15 menit lagi.' }
});
// General API rate limit (looser): keeps a single client from issuing
// hundreds of requests/second and starving other users.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 240,                  // 240 requests/min/IP ≈ 4 req/s sustained
  standardHeaders: true,
  legacyHeaders: false
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth')) {
    res.setHeader('Cache-Control', 'private, no-store');
  }
  next();
});

// ALLOWED_ORIGINS is optional. If unset, the API allows any origin (fine
// for single-host where the frontend and API share the same URL — no
// cross-origin requests happen at all). Set it to a comma-separated list
// of origins only if you actually serve the frontend from a different
// host (e.g. GitHub Pages) and want to lock the API down.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? new Set(
      process.env.ALLOWED_ORIGINS
        .split(',')
        .map((origin) => origin.trim().replace(/\/$/, ''))
        .filter(Boolean)
    )
  : null;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins) {
    if (!origin) {
      // Same-origin / no Origin header: allow.
      return next();
    }
    const normalized = origin.replace(/\/$/, '');
    const localOrigin = !IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
    if (!allowedOrigins.has(normalized) && !localOrigin) {
      return res.status(403).json({ error: 'Origin tidak diizinkan' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

const standardJsonParser = express.json({ limit: '2mb' });
const restoreJsonParser = express.json({ limit: '24mb' });
app.use((req, res, next) => {
  if (req.path === '/api/admin/restore') return next();
  standardJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Legacy /kwitansi-share.html?t=<token> — must be registered BEFORE
// express.static so it wins over the static file. Without this, old
// share links pasted into WhatsApp months ago would land on the empty
// client-side template (whose kwitansi only renders after JS fetches
// /api/public/receipt/..., which the print pipeline skips — hence the
// "blank PDF" bug). We redirect to the new server-rendered route that
// always returns a populated page.
//
// The route is intentionally minimal: it does NOT call verifyShareToken
// here (the redirect target does that). It just parses the token out
// of `?t=` (or `?token=`) and 308s to /kwitansi/<token>.
// 308 = permanent redirect that preserves the method, so browsers
// treat it like a URL rewrite rather than a navigation event.
app.get('/kwitansi-share.html', (req, res) => {
  const params = new URLSearchParams(req.query || {});
  const token = params.get('t') || params.get('token') || '';
  if (!token) {
    // No token — let the static handler render the page (it has its
    // own "Token kosong" error message in JS).
    return res.redirect(308, '/kwitansi-share.html' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
  }
  res.redirect(308, '/kwitansi/' + encodeURIComponent(token));
});

// Serve the frontend from public/ (single-host deployment). If a docs/
// directory exists (e.g. from `npm run build:pages`), it is also served
// as a fallback for any file public/ doesn't have, so the GitHub Pages
// build can be dropped into the same image.
// Cache static assets. HTML stays no-cache (so deploys take effect
// immediately) and any /api path is never cached. JS/CSS/IMG/fonts get
// a 7-day cache with `immutable` so repeat visitors don't re-download.
// The version query string (e.g. style.css?v=42) busts the cache when
// a new deploy ships. Compression middleware below takes care of gzip,
// and the ETag header (sent automatically by express.static) lets
// returning browsers do a 304 Not Modified round-trip instead of
// re-downloading unchanged assets.
const staticOptions = {
  maxAge: '7d',
  immutable: true,
  setHeaders: (res, path) => {
    if (path.endsWith('.html') || path.endsWith('/')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
  }
};
app.use(express.static(path.join(__dirname, 'public'), staticOptions));
const docsDir = path.join(__dirname, 'docs');
if (fs.existsSync(docsDir)) {
  app.use(express.static(docsDir, staticOptions));
}

const ALLOWED_UPLOAD_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!ALLOWED_UPLOAD_MIMES.has(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    callback(null, true);
  }
});
// Bulk PDF upload for kwitansi restore: up to 50 PDFs at once, 5 MB each.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 50 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype !== 'application/pdf') {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    callback(null, true);
  }
});

function validFileSignature(file) {
  if (!file || !file.buffer || file.buffer.length < 4) return false;
  const b = file.buffer;
  if (file.mimetype === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (file.mimetype === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimetype === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  if (file.mimetype === 'application/pdf') return b.subarray(0, 5).toString() === '%PDF-';
  return false;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET, { issuer: 'adzkiya-api' }); next(); }
  catch (e) { return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' }); }
}

// Compute reservation total: sum(items × price) × slots count
function calcReservationTotal(r) {
  const itemSum = (r.items || []).reduce((s, it) => s + (it.price || 0) * (it.qty || 1), 0);
  const slotCount = Math.max(1, (r.slots || []).length);
  return itemSum * slotCount;
}

// ---- ROUTE PLACEHOLDERS (filled in below) ----
// Public catalog & settings
// Public reservations & calendar & proof
// Auth
// Admin CRUD reservations
// Admin stats, charts, recap, xlsx
// Admin receipts
// Admin settings get/put + upload
// Admin backup/restore

// Apply the general API rate limit to every /api/* route. Public
// HTML/static are served above and are not affected.
app.use('/api/', apiLimiter);

// ===== PUBLIC =====
app.get('/health', (req, res) => res.json({ ok: true, storage: pool ? DATABASE_KIND : 'file' }));

// SEO: sitemap.xml. We emit a static-ish URL list — public pages
// only (admin & kwitansi-share excluded). service pages are dynamic
// (one per service slug), so we include them when the admin enables
// it via DB.settings.public_services_slugs. lastmod is the build
// deploy timestamp; for a single-host deployment that's good
// enough signal for Googlebot.
function getPublicBaseUrl(req) {
  // Prefer X-Forwarded-Proto + Host (Railway sets both) so sitemap
  // links are absolute and reachable. Fall back to PUBLIC_BASE_URL
  // env var (handy for staging) and finally to localhost.
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'adzkiyamombabycareweb-production.up.railway.app';
  return proto + '://' + host;
}
app.get('/sitemap.xml', (req, res) => {
  const base = getPublicBaseUrl(req);
  const staticUrls = [
    { loc: '/', priority: '1.0', changefreq: 'weekly' },
    { loc: '/kalender.html', priority: '0.8', changefreq: 'daily' },
    { loc: '/reservasi.html', priority: '0.9', changefreq: 'weekly' },
    { loc: '/?lang=id', priority: '0.9', changefreq: 'weekly' },
    { loc: '/?lang=en', priority: '0.6', changefreq: 'monthly' },
  ];
  const services = (DB.settings && Array.isArray(DB.settings.public_services_slugs))
    ? DB.settings.public_services_slugs
    : Object.values(SERVICE_PRICE_BY_NAME).length ? Object.keys(SERVICE_PRICE_BY_NAME).map((n) => '/reservasi.html?service=' + encodeURIComponent(n)) : [];
  const today = new Date().toISOString().slice(0, 10);
  const urls = staticUrls.concat(services.map((s) => ({ loc: s, priority: '0.7', changefreq: 'monthly' })));
  const body = urls.map((u) => `  <url>
    <loc>${base}${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`);
});

// robots.txt — served from public/ if present, otherwise a dynamic
// fallback. We keep a public/robots.txt in production; this handler
// covers static-less environments.
app.get('/robots.txt', (req, res) => {
  const base = getPublicBaseUrl(req);
  res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin.html
Disallow: /api/
Disallow: /api/admin/
Sitemap: ${base}/sitemap.xml
`);
});
app.get('/api/services', (req, res) => res.json(SERVICES));

app.get('/api/business', (req, res) => {
  const s = DB.settings || {};
  res.json({
    name: s.business_name, tagline: s.tagline, address: s.address, phone: s.phone,
    area: s.area, type: s.type, practitioner: s.practitioner, instagram: s.instagram
  });
});

app.get('/api/public-settings', (req, res) => {
  const s = DB.settings || {};
  // Strip huge base64 blobs from socials; the frontend will fetch each
  // social's icon image from /api/social-icon/:idx if it has one.
  const socialsPublic = (s.socials || []).filter(x => x && x.url).map((x, i) => ({
    platform: x.platform,
    icon: x.icon,
    url: x.url,
    has_icon: !!x.icon_b64,
    icon_url: x.icon_b64 ? `/api/social-icon/${i}` : null
  }));
  res.json({
    business_name: s.business_name, tagline: s.tagline, address: s.address, phone: s.phone,
    area: s.area, type: s.type, practitioner: s.practitioner, instagram: s.instagram,
    has_logo: !!s.logo_b64, has_hero: !!s.hero_b64, has_qris: !!s.qris_b64,
    qris_link: s.qris_link || '',
    bank_accounts: s.bank_accounts || [],
    primary_color: s.primary_color, accent_color: s.accent_color,
    gmaps_url: s.gmaps_url || '',
    gmaps_embed: s.gmaps_embed || '',
    hours: s.hours || [],
    testimonials: s.testimonials || [],
    socials: socialsPublic,
    // Blackout dates (tanggal libur) — dipakai form reservasi & kalender
    // publik untuk disable tanggal. Format YYYY-MM-DD. Kosong = tidak ada.
    blackout_dates: Array.isArray(s.blackout_dates) ? s.blackout_dates : [],
    blackout_notes: (s.blackout_notes && typeof s.blackout_notes === 'object') ? s.blackout_notes : {}
  });
});

// Public social icon image (no auth — used by the public site to render
// the IG/TT/FB avatar next to the platform name). The index is the
// position of the social in DB.settings.socials after filtering for
// having a URL; we re-derive it the same way public-settings does.
app.get('/api/social-icon/:idx', (req, res) => {
  const target = parseInt(req.params.idx, 10);
  if (isNaN(target) || target < 0) return res.status(400).end();
  const visible = (DB.settings?.socials || []).filter(x => x && x.url);
  const item = visible[target];
  if (!item || !item.icon_b64) return res.status(404).end();
  res.setHeader('Content-Type', item.icon_mime || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(item.icon_b64, 'base64'));
});

app.get('/api/logo', (req, res) => {
  const s = DB.settings; if (!s || !s.logo_b64) return res.status(404).end();
  res.setHeader('Content-Type', s.logo_mime || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(s.logo_b64, 'base64'));
});
app.get('/api/hero', (req, res) => {
  const s = DB.settings; if (!s || !s.hero_b64) return res.status(404).end();
  res.setHeader('Content-Type', s.hero_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(Buffer.from(s.hero_b64, 'base64'));
});
app.get('/api/qris', (req, res) => {
  const s = DB.settings; if (!s || !s.qris_b64) return res.status(404).end();
  res.setHeader('Content-Type', s.qris_mime || 'image/png');
  res.send(Buffer.from(s.qris_b64, 'base64'));
});

// ===== RESERVATIONS (PUBLIC) =====
app.post('/api/reservations', upload.single('proof'), (req, res) => {
  try {
    const b = req.body;
    const required = ['patient_name', 'whatsapp', 'address', 'payment_method'];
    for (const field of required) {
      if (!String(b[field] || '').trim()) return res.status(400).json({ error: `Field ${field} wajib diisi` });
    }
    if (!['COD', 'Transfer', 'QRIS'].includes(b.payment_method)) {
      return res.status(400).json({ error: 'Metode pembayaran tidak valid' });
    }
    if (req.file && !validFileSignature(req.file)) {
      return res.status(400).json({ error: 'Format atau isi bukti pembayaran tidak valid' });
    }

    let requestedItems;
    let slots;
    try { requestedItems = JSON.parse(b.items || '[]'); }
    catch { return res.status(400).json({ error: 'items invalid' }); }
    try { slots = JSON.parse(b.slots || '[]'); }
    catch { return res.status(400).json({ error: 'slots invalid' }); }

    if (!Array.isArray(requestedItems) || requestedItems.length < 1 || requestedItems.length > 20) {
      return res.status(400).json({ error: 'Pilih 1 sampai 20 layanan' });
    }
    if (!Array.isArray(slots) || slots.length < 1 || slots.length > 14) {
      return res.status(400).json({ error: 'Pilih 1 sampai 14 jadwal' });
    }

    // Never trust browser-submitted prices. Resolve every item against the server catalog.
    const items = requestedItems.map((item) => {
      const name = String(item.name || '').trim().slice(0, 200);
      const price = SERVICE_PRICE_BY_NAME.get(name);
      const qty = Math.min(20, Math.max(1, parseInt(item.qty, 10) || 1));
      return { name, price, qty };
    });
    if (!items.every((item) => item.name && Number.isFinite(item.price))) {
      return res.status(400).json({ error: 'Terdapat layanan yang tidak valid' });
    }

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    slots = slots.map((slot) => ({
      date: String(slot.date || '').slice(0, 10),
      time: String(slot.time || '').slice(0, 5)
    }));
    if (!slots.every((slot) => datePattern.test(slot.date) && timePattern.test(slot.time))) {
      return res.status(400).json({ error: 'Jadwal tidak valid' });
    }

    // Reject reservations that fall on a blackout date. Defense-in-depth:
    // the form already disables these dates, but if a request bypasses
    // the form (custom script, replayed payload) we still want to
    // refuse — and tell the client which date is the problem so the
    // form can highlight it.
    const blackoutSet = new Set((DB.settings && DB.settings.blackout_dates) || []);
    const blackoutConflict = slots.find((s) => blackoutSet.has(s.date));
    if (blackoutConflict) {
      const note = (DB.settings.blackout_notes && DB.settings.blackout_notes[blackoutConflict.date]) || '';
      return res.status(400).json({
        error: `Tanggal ${blackoutConflict.date} termasuk hari libur${note ? ` (${note})` : ''}. Silakan pilih tanggal lain.`,
        field: 'slot.date',
        conflicting_date: blackoutConflict.date
      });
    }

    const id = nextId('reservations');
    const itemSum = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const total = itemSum * slots.length;
    const rec = {
      id,
      patient_name: String(b.patient_name).trim().slice(0, 150),
      whatsapp: String(b.whatsapp).trim().slice(0, 30),
      address: String(b.address).trim().slice(0, 1000),
      items,
      slots,
      item_total: itemSum,
      total,
      service_name: items.map((item) => item.name).join(', '),
      service_price: itemSum,
      qty: slots.length,
      reservation_date: slots[0].date,
      reservation_time: slots[0].time,
      payment_method: b.payment_method,
      proof_mime: req.file ? req.file.mimetype : null,
      proof_b64: req.file ? req.file.buffer.toString('base64') : null,
      notes: String(b.notes || '').trim().slice(0, 2000),
      status: 'pending',
      payment_status: 'unpaid',
      created_at: new Date().toISOString()
    };
    DB.reservations.push(rec);
    save();
    res.status(201).json({ ok: true, id, total });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Gagal menyimpan reservasi' });
  }
});

app.get('/api/calendar', (req, res) => {
  // Flatten slots from approved reservations
  const out = [];
  DB.reservations.filter(r => r.status === 'approved').forEach(r => {
    (r.slots || [{ date: r.reservation_date, time: r.reservation_time }]).forEach(s => {
      out.push({
        id: r.id,
        service_name: (r.items && r.items.length > 1) ? `${r.items[0].name} +${r.items.length - 1}` : r.service_name,
        reservation_date: s.date,
        reservation_time: s.time,
        status: r.status
      });
    });
  });
  out.sort((a, b) => (a.reservation_date + a.reservation_time).localeCompare(b.reservation_date + b.reservation_time));
  res.json(out);
});

app.get('/api/proof/:id', auth, (req, res) => {
  const reservation = DB.reservations.find((item) => item.id === parseInt(req.params.id, 10));
  if (!reservation || !reservation.proof_b64) return res.status(404).send('Bukti tidak ditemukan');
  res.setHeader('Content-Type', reservation.proof_mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(reservation.proof_b64, 'base64'));
});

// ===== AUTH =====
const loginAttempts = new Map();
// Bersihkan entri login-attempts yang sudah lewat window-nya secara
// berkala supaya Map tidak tumbuh tanpa batas (memory leak) saat banyak
// IP berbeda gagal login sekali lalu tidak pernah kembali.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (!val || val.resetAt < now) loginAttempts.delete(key);
  }
}, 30 * 60 * 1000);
app.post('/api/auth/login', authLimiter, (req, res) => {
  const key = req.ip;
  const now = Date.now();
  const current = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > current.resetAt) Object.assign(current, { count: 0, resetAt: now + 15 * 60 * 1000 });
  if (current.count >= 10) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const admin = DB.admins.find((item) => item.email.toLowerCase() === email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    current.count += 1;
    loginAttempts.set(key, current);
    return res.status(401).json({ error: 'Email atau password salah' });
  }

  loginAttempts.delete(key);
  const token = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role },
    JWT_SECRET,
    { expiresIn: '12h', issuer: 'adzkiya-api' }
  );
  res.json({ token, user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
});

// ===== ADMIN — RESERVATIONS =====
function publicReservation(r) {
  return {
    id: r.id, patient_name: r.patient_name, whatsapp: r.whatsapp, address: r.address,
    items: r.items || [{ name: r.service_name, price: r.service_price, qty: r.qty }],
    slots: r.slots || [{ date: r.reservation_date, time: r.reservation_time }],
    service_name: r.service_name, service_price: r.service_price, qty: r.qty,
    reservation_date: r.reservation_date, reservation_time: r.reservation_time,
    total: r.total || calcReservationTotal(r),
    payment_method: r.payment_method, proof_file: r.proof_b64 ? `/api/proof/${r.id}` : null,
    notes: r.notes, status: r.status, payment_status: r.payment_status, created_at: r.created_at
  };
}

app.get('/api/admin/reservations', auth, (req, res) => {
  const { status, payment_status, from, to } = req.query;
  let rows = DB.reservations.slice();
  if (status) rows = rows.filter(r => r.status === status);
  if (payment_status) rows = rows.filter(r => r.payment_status === payment_status);
  if (from) rows = rows.filter(r => r.reservation_date >= from);
  if (to) rows = rows.filter(r => r.reservation_date <= to);
  rows.sort((a, b) => (b.reservation_date + b.reservation_time).localeCompare(a.reservation_date + a.reservation_time));
  res.json(rows.map(publicReservation));
});

app.patch('/api/admin/reservations/:id', auth, (req, res) => {
  const r = DB.reservations.find(x => x.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (req.body.status) r.status = req.body.status;
  if (req.body.payment_status) r.payment_status = req.body.payment_status;
  // Allow editing the time slots (multi-waktu + multi-tanggal).
  //
  // When slots change:
  //   • If admin is editing a kwitansi-mirror reservation (note
  //     starts with "Auto-generated from kwitansi"), preserve r.total
  //     as-is. The receipt total is independent of how many sesi the
  //     admin wants to schedule.
  //   • Otherwise (a real public reservation), recompute r.total via
  //     calcReservationTotal() so the new slot count is reflected.
  let slotsChanged = false;
  if (Array.isArray(req.body.service_slots) && req.body.service_slots.length) {
    const slots = req.body.service_slots
      .map((s) => ({
        date: String(s?.date || r.reservation_date || '').slice(0, 10),
        time: String(s?.time || '').slice(0, 5)
      }))
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{1,2}:\d{2}$/.test(s.time));
    if (slots.length) {
      r.slots = slots;
      r.reservation_date = slots[0].date;
      r.reservation_time = slots[0].time;
      r.qty = slots.length;
      slotsChanged = true;
    }
  } else if (Array.isArray(req.body.service_times) && req.body.service_times.length) {
    const times = req.body.service_times
      .map((t) => String(t || '').trim())
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    if (times.length) {
      r.slots = times.map((time) => ({ date: r.reservation_date, time }));
      r.reservation_time = times[0];
      r.qty = r.slots.length;
      slotsChanged = true;
    }
  } else if (req.body.service_time && /^\d{1,2}:\d{2}$/.test(req.body.service_time)) {
    if (r.slots && r.slots.length) {
      r.slots[0].time = req.body.service_time;
      r.reservation_time = req.body.service_time;
      slotsChanged = true;
    } else {
      r.slots = [{ date: r.reservation_date, time: req.body.service_time }];
      r.reservation_time = req.body.service_time;
      r.qty = 1;
      slotsChanged = true;
    }
  }
  // Only recompute total when this is a real public reservation
  // (not a kwitansi mirror). The kwitansi total is a single fixed
  // number regardless of how many sesi are scheduled.
  if (slotsChanged && !(r.notes && r.notes.startsWith('Auto-generated from kwitansi'))) {
    r.total = calcReservationTotal(r);
  }
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/reservations/:id', auth, (req, res) => {
  DB.reservations = DB.reservations.filter(x => x.id !== parseInt(req.params.id));
  save();
  res.json({ ok: true });
});

// ===== ADMIN — STATS =====
app.get('/api/admin/stats', auth, (req, res) => {
  const pending = DB.reservations.filter(r => r.status === 'pending').length;
  const approved = DB.reservations.filter(r => r.status === 'approved').length;
  const lunas = DB.reservations.filter(r => r.payment_status === 'lunas').length;
  const omzet = DB.reservations.filter(r => r.payment_status === 'lunas')
    .reduce((s, r) => s + calcReservationTotal(r), 0);
  res.json({ pending, approved, lunas, omzet, total: DB.reservations.length });
});

// ===== ADMIN — MINI-CRM (Customer Profile + RFM) =====
// Aggregates per-phone customer view: total reservations, total
// spend, last visit, status breakdown, RFM-ish score (recency +
// frequency weighted). Useful for retention outreach and ranking
// "Pelanggan setia" without external CRM tools.
//
// RFM thresholds (relative to the cohort):
//   Recency:  tier A ≤ 30 days, B ≤ 90, C ≤ 180, D > 180
//   Frequency: A ≥ 5 bookings, B ≥ 3, C ≥ 2, D = 1
//   Monetary: A ≥ Rp 1.5jt, B ≥ Rp 500rb, C ≥ Rp 200rb, D < 200rb
// Score = concat(R-F-M). AAA = top tier, DDD = dorman.

// Day-of-week × hour heatmap: counts how many reservations fall
// into each slot. Helps the admin pick staffing hours.
function buildHeatmap(rows) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  rows.forEach((r) => {
    (r.slots || [{ date: r.reservation_date, time: r.reservation_time }]).forEach((s) => {
      if (!s.date || !s.time) return;
      const date = new Date(s.date + 'T00:00:00');
      if (isNaN(date)) return;
      const dow = (date.getDay() + 6) % 7; // 0=Mon for display
      const hour = parseInt(String(s.time).slice(0, 2), 10);
      if (isNaN(hour)) return;
      grid[dow][hour] += 1;
      if (grid[dow][hour] > max) max = grid[dow][hour];
    });
  });
  return { grid, max };
}

app.get('/api/admin/charts/heatmap', auth, (req, res) => {
  const { from, to } = req.query;
  let rows = DB.reservations.slice();
  if (from) rows = rows.filter((r) => (r.reservation_date || '') >= from);
  if (to) rows = rows.filter((r) => (r.reservation_date || '') <= to);
  const { grid, max } = buildHeatmap(rows);
  res.json({ grid, max, total: rows.length });
});

function buildCustomerList() {
  // Group reservations + receipts by phone number.
  const byPhone = new Map();
  function getCust(phone) {
    if (!byPhone.has(phone)) byPhone.set(phone, {
      phone, reservations: [], receipts: [], first_visit: null, last_visit: null,
      _reservations: [], _receipts: [],
    });
    return byPhone.get(phone);
  }
  DB.reservations.forEach((r) => {
    const phone = String(r.whatsapp || '').replace(/\D/g, '');
    if (!phone) return;
    const c = getCust(phone);
    c._reservations.push(r);
    // Track a denormalized "any" projection so the list endpoint is fast.
    c.reservations.push({ id: r.id, status: r.status, payment_status: r.payment_status, reservation_date: r.reservation_date, total: r.total });
  });
  DB.receipts.forEach((k) => {
    const phone = String(k.whatsapp || '').replace(/\D/g, '');
    if (!phone) return;
    const c = getCust(phone);
    c._receipts.push(k);
    c.receipts.push({ id: k.id, invoice_no: k.invoice_no, total: k.total, created_at: k.created_at });
  });

  const now = Date.now();
  const customers = [];
  for (const [phone, c] of byPhone) {
    const dates = c.reservations.map((r) => r.reservation_date).filter(Boolean).sort();
    const first_visit = dates[0] || null;
    const last_visit = dates[dates.length - 1] || null;
    const total_spent = c.reservations.reduce((s, r) => {
      return s + (r.payment_status === 'lunas' ? (r.total || calcReservationTotal(r)) : 0);
    }, 0);
    const total_reservations = c.reservations.length;
    const lastVisitAgeDays = last_visit ? Math.floor((now - new Date(last_visit).getTime()) / (24 * 3600 * 1000)) : 9999;

    // Use the most recent reservation's patient_name + address as the
    // customer name (probably the latest known value).
    const sortedR = c._reservations.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const last = sortedR[0] || {};
    const patient_name = last.patient_name || c._receipts.find((k) => k.patient_name)?.patient_name || '(tanpa nama)';
    const address = last.address || '';

    // RFM tiers
    const R = lastVisitAgeDays <= 30 ? 'A' : lastVisitAgeDays <= 90 ? 'B' : lastVisitAgeDays <= 180 ? 'C' : 'D';
    const F = total_reservations >= 5 ? 'A' : total_reservations >= 3 ? 'B' : total_reservations >= 2 ? 'C' : 'D';
    const M = total_spent >= 1500000 ? 'A' : total_spent >= 500000 ? 'B' : total_spent >= 200000 ? 'C' : 'D';
    const rfm = R + F + M;
    const rfm_score = ({AAA:100, AAB:90, AAC:80, AAD:70, ABA:85, ABB:75, ABC:65, ABD:55,
      ACA:70, ACB:60, ACC:55, ACD:45,
      BAA:80, BAB:70, BAC:60, BAD:50, BBA:75, BBB:65, BBC:60, BBD:50, BCA:70, BCB:60, BCC:55, BCD:45,
      CCC:35, CCD:25, DDD:10})[rfm] || 50;
    const statusBreakdown = c.reservations.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
    const hasOutstanding = c.reservations.some((r) => r.payment_status === 'unpaid' && r.status !== 'rejected');
    const lastLunasDate = c.reservations.filter((r) => r.payment_status === 'lunas').map((r) => r.reservation_date).sort().slice(-1)[0] || null;

    customers.push({
      phone,
      patient_name,
      address,
      first_visit, last_visit, last_visit_age_days: lastVisitAgeDays,
      total_reservations, total_spent, has_outstanding: hasOutstanding,
      rfm, rfm_score,
      status_breakdown: statusBreakdown,
      last_lunas_date: lastLunasDate,
      whatsapp_intl: phone.startsWith('0') ? '62' + phone.slice(1) : phone,
      // Keep raw lists around so the detail endpoint can build the
      // merged timeline without re-grouping from scratch. Strip
      // them from JSON output in /api/admin/customers via a
      // projection (see below); expose only in /:phone detail.
      _reservations: c._reservations,
      _receipts: c._receipts,
    });
  }
  return customers;
}

app.get('/api/admin/customers', auth, (req, res) => {
  const customers = buildCustomerList();
  // Sort by recency by default; admin can re-sort on the client.
  const sort = req.query.sort || 'recent';
  if (sort === 'spend') customers.sort((a, b) => b.total_spent - a.total_spent);
  else if (sort === 'frequency') customers.sort((a, b) => b.total_reservations - a.total_reservations);
  else if (sort === 'name') customers.sort((a, b) => String(a.patient_name).localeCompare(String(b.patient_name)));
  else if (sort === 'rfm') customers.sort((a, b) => b.rfm_score - a.rfm_score);
  else customers.sort((a, b) => (b.last_visit || '').localeCompare(a.last_visit || ''));
  // Strip the raw _reservations/_receipts from the JSON response —
  // they're only needed by the detail endpoint, and they would
  // balloon the list payload when the customer DB grows.
  const stripped = customers.map(({ _reservations, _receipts, ...rest }) => rest);
  res.json({ count: stripped.length, customers: stripped });
});

app.get('/api/admin/customers/:phone', auth, (req, res) => {
  try {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ error: 'phone kosong' });
  const customers = buildCustomerList();
  const c = customers.find((x) => x.phone === phone);
  if (!c) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
  // Build full timeline merging reservations + receipts.
  const timeline = [
    ...c._reservations.map((r) => ({
      type: 'reservation',
      date: r.reservation_date,
      time: r.reservation_time,
      service_name: r.service_name || (r.items || []).map((it) => it.name).join(', '),
      items: r.items || [],
      total: r.total,
      status: r.status,
      payment_status: r.payment_status,
      notes: r.notes,
      id: r.id,
      created_at: r.created_at,
    })),
    ...c._receipts.map((k) => ({
      type: 'receipt',
      date: k.service_date || k.created_at?.slice(0, 10),
      time: k.service_time,
      service_name: (k.items || []).map((it) => it.name).join(', '),
      items: k.items || [],
      total: k.total,
      invoice_no: k.invoice_no,
      id: k.id,
      created_at: k.created_at,
    })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json({ ...c, timeline });
  } catch (e) {
    console.error('customers/:phone error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ===== ADMIN — NOTIFICATIONS (polling realtime) =====
// Returns: new reservations since <since> id + upcoming reminders within reminder window
app.get('/api/admin/notifications', auth, (req, res) => {
  const since = parseInt(req.query.since || '0') || 0;
  const newRes = DB.reservations
    .filter(r => r.id > since)
    .sort((a, b) => b.id - a.id)
    .slice(0, 50)
    .map(r => ({
      id: r.id,
      patient_name: r.patient_name,
      whatsapp: r.whatsapp,
      service_name: (r.items && r.items.length > 1) ? `${r.items[0].name} +${r.items.length - 1}` : r.service_name,
      reservation_date: r.reservation_date,
      reservation_time: r.reservation_time,
      total: calcReservationTotal(r),
      status: r.status,
      payment_status: r.payment_status,
      created_at: r.created_at
    }));

  const hoursBefore = parseInt(req.query.hours || DB.settings.reminder_hours_before || 2);
  const now = new Date();
  const windowEnd = new Date(now.getTime() + hoursBefore * 3600 * 1000);
  const reminders = [];
  DB.reservations.forEach(r => {
    if (r.status === 'rejected') return;
    (r.slots || [{ date: r.reservation_date, time: r.reservation_time }]).forEach(s => {
      if (!s.date || !s.time) return;
      // Bisnis ada di Cilacap (WIB = UTC+7). Tanggal/jam reservasi disimpan
      // sebagai waktu lokal Indonesia, jadi parse dengan offset +07:00 agar
      // perbandingan dgn 'now' (UTC server) akurat — kalau tidak, reminder
      // akan meleset 7 jam.
      const when = new Date(`${s.date}T${s.time}:00+07:00`);
      if (when >= now && when <= windowEnd) {
        const minsLeft = Math.round((when - now) / 60000);
        reminders.push({
          id: r.id,
          patient_name: r.patient_name,
          whatsapp: r.whatsapp,
          service_name: r.service_name,
          date: s.date,
          time: s.time,
          when_iso: when.toISOString(),
          mins_left: minsLeft,
          status: r.status,
          payment_status: r.payment_status
        });
      }
    });
  });
  reminders.sort((a, b) => a.mins_left - b.mins_left);

  res.json({
    server_time: now.toISOString(),
    last_id: DB.reservations.reduce((m, r) => Math.max(m, r.id), 0),
    new_count: newRes.length,
    new: newRes,
    reminder_hours: hoursBefore,
    reminders
  });
});

// ===== ADMIN — CHARTS =====
app.get('/api/admin/charts', auth, (req, res) => {
  // Last 14 days omzet trend
  const today = new Date();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const omzetByDay = days.map(d => {
    const sum = DB.reservations
      .filter(r => r.reservation_date === d && r.payment_status === 'lunas')
      .reduce((s, r) => s + calcReservationTotal(r), 0);
    const cnt = DB.reservations.filter(r => r.reservation_date === d).length;
    return { date: d, omzet: sum, count: cnt };
  });

  // Service popularity (count occurrences across items)
  const svcCount = {};
  DB.reservations.forEach(r => {
    (r.items || []).forEach(it => { svcCount[it.name] = (svcCount[it.name] || 0) + it.qty; });
  });
  const topServices = Object.entries(svcCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // Payment method distribution
  const payCount = {};
  DB.reservations.forEach(r => { payCount[r.payment_method] = (payCount[r.payment_method] || 0) + 1; });

  // Status distribution
  const statusCount = { pending: 0, approved: 0, rejected: 0 };
  DB.reservations.forEach(r => { statusCount[r.status] = (statusCount[r.status] || 0) + 1; });

  // Monthly omzet (last 6 months)
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const omzetByMonth = months.map(m => {
    const sum = DB.reservations
      .filter(r => (r.reservation_date || '').slice(0, 7) === m && r.payment_status === 'lunas')
      .reduce((s, r) => s + calcReservationTotal(r), 0);
    return { month: m, omzet: sum };
  });

  res.json({ omzetByDay, topServices, payCount, statusCount, omzetByMonth });
});

// ===== ADMIN — RECAP =====
// Compute list of months (YYYY-MM strings) covered by a range.
// months=1 → just [from]. months=3 → [from, from-1, from-2] etc.
// `from` defaults to the current month.
function computeMonthRange(month, months) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const out = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

app.get('/api/admin/recap', auth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const months = Math.max(1, Math.min(24, parseInt(req.query.months || '1', 10) || 1));
  const monthList = computeMonthRange(month, months);
  const monthSet = new Set(monthList);

  // Reservations whose reservation_date falls in any month of the range
  const rows = DB.reservations.filter((r) => monthSet.has((r.reservation_date || '').slice(0, 7)))
    .sort((a, b) => a.reservation_date.localeCompare(b.reservation_date))
    .map(publicReservation);
  const totalReservasi = rows.length;
  const totalOmzet = rows.filter((r) => r.payment_status === 'lunas')
    .reduce((s, r) => s + r.total, 0);
  // Count receipts whose EITHER created_at OR service_date falls in
  // any month of the range. This matches the filter used by
  // /api/admin/receipts so the stat card and the receipts table
  // stay consistent across the range view.
  const totalKwitansi = DB.receipts.filter((k) =>
    (k.created_at && monthSet.has(k.created_at.slice(0, 7))) ||
    (k.service_date && monthSet.has(k.service_date.slice(0, 7)))
  ).length;

  // Per-month breakdown — admin wants to compare months at a glance.
  const byMonth = monthList.map((m) => {
    const mRows = rows.filter((r) => (r.reservation_date || '').slice(0, 7) === m);
    const mOmzet = mRows.filter((r) => r.payment_status === 'lunas')
      .reduce((s, r) => s + r.total, 0);
    const mKw = DB.receipts.filter((k) =>
      (k.created_at && k.created_at.slice(0, 7) === m) ||
      (k.service_date && k.service_date.slice(0, 7) === m)
    ).length;
    return { month: m, totalReservasi: mRows.length, totalOmzet: mOmzet, totalKwitansi: mKw };
  });

  res.json({
    month, months, monthList,
    totalReservasi, totalOmzet, totalKwitansi,
    byMonth,
    rows
  });
});

// XLSX export — professional formatting. Supports ?months=N to
// export multiple months into one workbook (one sheet per month +
// a summary "Ringkasan" sheet at the front).
app.get('/api/admin/recap.xlsx', auth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const months = Math.max(1, Math.min(24, parseInt(req.query.months || '1', 10) || 1));
    const monthList = computeMonthRange(month, months);
    const monthSet = new Set(monthList);
    const monthRows = DB.reservations.filter((r) => monthSet.has((r.reservation_date || '').slice(0, 7)))
      .sort((a, b) => a.reservation_date.localeCompare(b.reservation_date));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Adzkiya Mom Baby Care';
    wb.created = new Date();

    // Build one sheet per month in the range. The latest requested
    // month always comes first so the user lands on it when opening
    // the workbook.
    monthList.slice().reverse().forEach((m) => {
      const rowsForMonth = monthRows.filter((r) => (r.reservation_date || '').slice(0, 7) === m);
      buildMonthSheet(wb, 'Rekap ' + m, m, rowsForMonth);
    });

    // Front sheet: ringkasan per bulan — handy for finance reports.
    if (months > 1) {
      const sum = wb.addWorksheet('Ringkasan', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
        views: [{ showGridLines: false }]
      });
      sum.mergeCells('A1:E1');
      sum.getCell('A1').value = '🌸 ADZKIYA MOM BABY CARE';
      sum.getCell('A1').font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
      sum.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };
      sum.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
      sum.getRow(1).height = 32;
      sum.mergeCells('A2:E2');
      sum.getCell('A2').value = `LAPORAN KEUANGAN — ${months} Bulan Terakhir (sampai ${month})`;
      sum.getCell('A2').font = { size: 12, bold: true, color: { argb: 'FF4A2533' } };
      sum.getCell('A2').alignment = { horizontal: 'center' };
      sum.getRow(2).height = 22;
      const sumHeaders = ['Bulan', 'Total Reservasi', 'Total Kwitansi', 'Omzet (Lunas)', 'Rata-rata/Reservasi'];
      sumHeaders.forEach((h, i) => {
        const cell = sum.getCell(4, i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      sum.getRow(4).height = 24;
      let sR = 5;
      monthList.slice().reverse().forEach((m) => {
        const mRows = monthRows.filter((r) => (r.reservation_date || '').slice(0, 7) === m);
        const mOmzet = mRows.filter((r) => r.payment_status === 'lunas').reduce((s, r) => s + calcReservationTotal(r), 0);
        const mKw = DB.receipts.filter((k) => (k.created_at || '').slice(0, 7) === m).length;
        const avg = mRows.length ? Math.round(mOmzet / mRows.length) : 0;
        const row = sum.addRow([m, mRows.length, mKw, mOmzet, avg]);
        row.getCell(4).numFmt = '"Rp"#,##0';
        row.getCell(5).numFmt = '"Rp"#,##0';
        if ((sR - 5) % 2 === 0) {
          for (let c = 1; c <= 5; c++) {
            const cell = row.getCell(c);
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F8' } };
          }
        }
        sR++;
      });
      const totRow = sum.addRow([
        'TOTAL',
        monthRows.length,
        monthList.reduce((s, m) => s + DB.receipts.filter((k) => (k.created_at || '').slice(0, 7) === m).length, 0),
        monthRows.filter((r) => r.payment_status === 'lunas').reduce((s, r) => s + calcReservationTotal(r), 0),
        monthRows.length ? Math.round(monthRows.filter((r) => r.payment_status === 'lunas').reduce((s, r) => s + calcReservationTotal(r), 0) / monthRows.length) : 0
      ]);
      totRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      for (let c = 1; c <= 5; c++) {
        totRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
      }
      totRow.getCell(4).numFmt = '"Rp"#,##0';
      totRow.getCell(5).numFmt = '"Rp"#,##0';
      totRow.height = 24;
      sum.getColumn(1).width = 14;
      sum.getColumn(2).width = 22;
      sum.getColumn(3).width = 18;
      sum.getColumn(4).width = 22;
      sum.getColumn(5).width = 24;
    }

    // File name: include range so admin knows it's a multi-month export
    const fname = months > 1
      ? `rekap-adzkiya-${monthList[monthList.length - 1]}_to_${month}.xlsx`
      : `rekap-adzkiya-${month}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});


// Helper: build one styled worksheet for a single month. Pulled out
// of recap.xlsx so the multi-month export can reuse the same
// formatting for each per-month sheet without copy-pasting 150 lines.
function buildMonthSheet(wb, sheetName, month, monthRows) {
  const ws = wb.addWorksheet(sheetName, {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    views: [{ showGridLines: false }]
  });
  ws.mergeCells('A1:I1');
  ws.getCell('A1').value = '🌸 ADZKIYA MOM BABY CARE';
  ws.getCell('A1').font = { name: 'Calibri', size: 22, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
  ws.getRow(1).height = 36;
  ws.mergeCells('A2:I2');
  ws.getCell('A2').value = 'Layanan Kesehatan Ibu & Anak Terpercaya · ' + (DB.settings.address || '');
  ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFB979' } };
  ws.getRow(2).height = 20;
  ws.mergeCells('A4:I4');
  ws.getCell('A4').value = `REKAPITULASI BULANAN — ${month}`;
  ws.getCell('A4').font = { size: 14, bold: true, color: { argb: 'FF4A2533' } };
  ws.getCell('A4').alignment = { horizontal: 'center' };
  ws.getRow(4).height = 24;

  const totalReservasi = monthRows.length;
  const totalOmzet = monthRows.filter((r) => r.payment_status === 'lunas').reduce((s, r) => s + calcReservationTotal(r), 0);
  const totalKw = DB.receipts.filter((k) => (k.created_at || '').slice(0, 7) === month).length;
  const pendingCnt = monthRows.filter((r) => r.status === 'pending').length;
  const approvedCnt = monthRows.filter((r) => r.status === 'approved').length;
  const lunasCnt = monthRows.filter((r) => r.payment_status === 'lunas').length;

  const summaryRows = [
    ['Total Reservasi', totalReservasi, '', 'Total Omzet', { v: totalOmzet, t: 'rp' }],
    ['Total Kwitansi', totalKw, '', 'Status Pending', pendingCnt],
    ['Approved', approvedCnt, '', 'Lunas', lunasCnt]
  ];
  let rNum = 6;
  summaryRows.forEach((row) => {
    ws.getCell(`A${rNum}`).value = row[0];
    ws.getCell(`A${rNum}`).font = { bold: true, color: { argb: 'FF8B6878' } };
    ws.getCell(`B${rNum}`).value = typeof row[1] === 'object' ? row[1].v : row[1];
    ws.getCell(`B${rNum}`).font = { bold: true, size: 12, color: { argb: 'FFEE5A8A' } };
    ws.getCell(`D${rNum}`).value = row[3];
    ws.getCell(`D${rNum}`).font = { bold: true, color: { argb: 'FF8B6878' } };
    ws.getCell(`E${rNum}`).value = typeof row[4] === 'object' ? row[4].v : row[4];
    ws.getCell(`E${rNum}`).font = { bold: true, size: 12, color: { argb: 'FFEE5A8A' } };
    if (typeof row[4] === 'object' && row[4].t === 'rp') {
      ws.getCell(`E${rNum}`).numFmt = '"Rp"#,##0';
    }
    rNum++;
  });

  const headerRow = rNum + 1;
  const headers = ['No', 'Tanggal', 'Jam', 'Pasien', 'WhatsApp', 'Layanan (Detail)', 'Sesi', 'Total', 'Status'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: { style: 'thin', color: { argb: 'FFEE5A8A' } }, bottom: { style: 'thin', color: { argb: 'FFEE5A8A' } } };
  });
  ws.getRow(headerRow).height = 28;

  monthRows.forEach((r, idx) => {
    const items = r.items || [{ name: r.service_name, price: r.service_price, qty: r.qty }];
    const slots = r.slots || [{ date: r.reservation_date, time: r.reservation_time }];
    const itemsText = items.map((it) => `• ${it.name} (×${it.qty}) — Rp${(it.price * it.qty).toLocaleString('id-ID')}`).join('\n');
    const slotsCount = slots.length;
    const total = calcReservationTotal(r);
    const dateText = slots.map((s) => s.date).join('\n');
    const timeText = slots.map((s) => s.time).join('\n');
    const row = ws.addRow([
      idx + 1, dateText, timeText, r.patient_name, r.whatsapp,
      itemsText, slotsCount, total, `${r.status} / ${r.payment_status}`
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(8).numFmt = '"Rp"#,##0';
    row.getCell(8).font = { bold: true };
    row.getCell(9).alignment = { ...row.alignment, horizontal: 'center' };
    const statusFill = r.payment_status === 'lunas' ? 'FFD9EFE1' : r.status === 'pending' ? 'FFFFF3D6' : 'FFFDE0E4';
    row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusFill } };
    if (idx % 2 === 0) {
      for (let c = 1; c <= 9; c++) {
        const cell = row.getCell(c);
        if (!cell.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F8' } };
      }
    }
    row.eachCell((c) => { c.border = { bottom: { style: 'thin', color: { argb: 'FFFFE0E8' } } }; });
    const maxLines = Math.max(itemsText.split('\n').length, dateText.split('\n').length);
    row.height = Math.max(20, maxLines * 16);
  });

  const totalRow = ws.addRow(['', '', '', '', '', 'TOTAL OMZET', '', totalOmzet, '']);
  totalRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  for (let c = 1; c <= 9; c++) {
    totalRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
    totalRow.getCell(c).border = { top: { style: 'thick', color: { argb: 'FFEE5A8A' } } };
  }
  totalRow.getCell(8).numFmt = '"Rp"#,##0';
  totalRow.getCell(6).alignment = { horizontal: 'right' };
  totalRow.height = 26;

  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 10;
  ws.getColumn(4).width = 22;
  ws.getColumn(5).width = 16;
  ws.getColumn(6).width = 45;
  ws.getColumn(7).width = 8;
  ws.getColumn(8).width = 16;
  ws.getColumn(9).width = 18;

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow, showGridLines: false }];
}

// ===== ADMIN — RECEIPTS =====
app.post('/api/admin/receipts', auth, (req, res) => {
  const { patient_name, whatsapp, address, service_date, service_time, service_times, service_slots, items, transport_fee, discount } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Items kosong' });
  const subtotal = items.reduce((s, it) => s + (it.price * it.qty), 0);
  // Normalize multi-waktu + multi-tanggal: prefer service_slots (array
  // of {date, time}) for the full flexibility. Fall back to
  // service_times[] (assume same date), then service_time (single).
  // Each slot represents one session the patient is paying for.
  let slots = [];
  if (Array.isArray(service_slots) && service_slots.length) {
    slots = service_slots
      .map((s) => ({
        date: String(s?.date || service_date || '').slice(0, 10),
        time: String(s?.time || '').slice(0, 5)
      }))
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{1,2}:\d{2}$/.test(s.time));
  }
  if (!slots.length && Array.isArray(service_times) && service_times.length) {
    slots = service_times
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
      .map((t) => ({ date: service_date, time: t }));
  }
  if (!slots.length && service_time && /^\d{1,2}:\d{2}$/.test(service_time)) {
    slots = [{ date: service_date, time: service_time }];
  }
  if (!slots.length) slots = [{ date: service_date, time: '09:00' }];
  // Dedupe by (date, time)
  slots = slots.filter((s, i) => slots.findIndex((x) => x.date === s.date && x.time === s.time) === i);

  // Reject kwitansi yang jatuh di hari libur. Admin biasanya sengaja
  // menandai blackout dates untuk hari besar / cuti, jadi tidak masuk
  // akal membuat kwitansi dengan tanggal layanan itu. Pesan error
  // menyebut tanggal yang konflik supaya admin tahu mana yang harus
  // dihapus atau dipindah.
  const blackoutSet = new Set((DB.settings && DB.settings.blackout_dates) || []);
  const blackoutConflict = slots.find((s) => blackoutSet.has(s.date));
  if (blackoutConflict) {
    const note = (DB.settings.blackout_notes && DB.settings.blackout_notes[blackoutConflict.date]) || '';
    return res.status(400).json({
      error: `Tanggal layanan ${blackoutConflict.date} termasuk hari libur${note ? ` (${note})` : ''}. Hapus dari daftar hitam atau pilih tanggal lain.`,
      conflicting_date: blackoutConflict.date
    });
  }
  // The kwitansi total is subtotal × number of sessions. Each session
  // is one (date, time) pair. This matches the auto-sync reservation
  // calculation so Rekap Bulanan stays accurate.
  const slotCount = slots.length;
  const total = subtotal * slotCount + (parseInt(transport_fee) || 0) - (parseInt(discount) || 0);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = DB.receipts.filter((k) => (k.invoice_no || '').slice(4, 12) === today).length;
  const invoice_no = `INV-${today}-${String(count + 1).padStart(3, '0')}`;
  const id = nextId('receipts');
  DB.receipts.push({
    id, invoice_no, patient_name, whatsapp, address,
    service_date: slots[0].date,
    service_time: slots[0].time,
    service_times: slots.map((s) => s.time),
    service_slots: slots,
    items, transport_fee: parseInt(transport_fee) || 0,
    discount: parseInt(discount) || 0, subtotal, total,
    created_at: new Date().toISOString()
  });
  // Mirror into a reservation so multi-waktu kwitansi otomatis muncul
  // di Rekap Bulanan dengan jumlah sesi yang sesuai. Skip when the
  // caller explicitly opts out via ?sync_reservations=0.
  const lastReceipt = DB.receipts[DB.receipts.length - 1];
  if (req.query.sync_reservations !== '0') {
    syncReceiptToReservation(lastReceipt);
  }
  save();
  res.json({ ok: true, invoice_no, subtotal, total, slot_count: slotCount });
});

app.get('/api/admin/receipts', auth, (req, res) => {
  // Optional ?month=YYYY-MM filter. When set, include receipts whose
  // EITHER created_at OR service_date falls in that month. The frontend
  // Rekap page uses this to show a list of all receipts for the chosen
  // month, regardless of which date field is more relevant.
  const month = req.query.month;
  let rows = DB.receipts.slice();
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    rows = rows.filter(r =>
      (r.created_at && r.created_at.slice(0, 7) === month) ||
      (r.service_date && r.service_date.slice(0, 7) === month)
    );
  }
  res.json(rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200));
});

app.get('/api/admin/receipts/:id', auth, (req, res) => {
  const r = DB.receipts.find(x => x.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// ===== SHARE-LINK (read-only public) =====
// Generates a signed token the admin can paste into WhatsApp/email
// so the customer can view their kwitansi without admin login.
// Token = HMAC-style signature of (invoice_no|created_at|total) with
// the JWT_SECRET so it can't be forged, plus a server-side map of
// recently issued tokens to id (capped, expires in 30 days). We use
// the JWT_SECRET for both signatures so we don't need to manage a
// second secret.
//
// Tokens are PERSISTED to disk (when in file-storage mode) so they
// survive server restarts. In Postgres mode the share_tokens table
// takes care of persistence. The in-memory `shareTokenMap` is still
// the hot path for fast lookups; we rehydrate from disk on boot.
const SHARE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const shareTokenMap = new Map(); // token -> { id, exp }
// Persistent storage of share tokens. Keys are token strings; values
// are { id, exp }. Saved alongside DB on every change when running
// in file-storage mode. Loaded back on boot.
let shareTokensDb = {}; // mirror of DB.share_tokens
async function loadShareTokens() {
  if (DATABASE_KIND === 'postgres' && pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS share_tokens (
          token TEXT PRIMARY KEY,
          receipt_id INTEGER NOT NULL,
          exp BIGINT NOT NULL
        )
      `);
      const result = await pool.query('SELECT token, receipt_id, exp FROM share_tokens WHERE exp > $1', [Date.now()]);
      for (const row of result.rows) {
        shareTokenMap.set(row.token, { id: row.receipt_id, exp: row.exp });
      }
      console.log(`[share-tokens] Loaded ${result.rows.length} tokens from postgres`);
    } catch (e) {
      console.error('[share-tokens] postgres load failed:', e.message);
    }
  } else if (DATABASE_KIND === 'mysql' && pool) {
    try {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS share_tokens (
          token VARCHAR(255) PRIMARY KEY,
          receipt_id INT NOT NULL,
          exp BIGINT NOT NULL
        )
      `);
      const [rows] = await pool.execute('SELECT token, receipt_id, exp FROM share_tokens WHERE exp > ?', [Date.now()]);
      for (const row of rows) {
        shareTokenMap.set(row.token, { id: row.receipt_id, exp: Number(row.exp) });
      }
      console.log(`[share-tokens] Loaded ${rows.length} tokens from mysql`);
    } catch (e) {
      console.error('[share-tokens] mysql load failed:', e.message);
    }
  } else {
    // File mode: tokens are persisted as DB.share_tokens and rehydrated
    // on the next queueSave() cycle.
    shareTokensDb = DB.share_tokens || {};
    for (const [tok, v] of Object.entries(shareTokensDb)) {
      if (v && v.exp && v.exp > Date.now()) shareTokenMap.set(tok, { id: v.id, exp: v.exp });
    }
    DB.share_tokens = shareTokensDb;
  }
}
async function saveShareToken(token, id, exp) {
  shareTokenMap.set(token, { id, exp });
  if (DATABASE_KIND === 'postgres' && pool) {
    try {
      await pool.query(
        'INSERT INTO share_tokens (token, receipt_id, exp) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET receipt_id = EXCLUDED.receipt_id, exp = EXCLUDED.exp',
        [token, id, exp]
      );
    } catch (e) {
      console.error('[share-tokens] postgres save failed:', e.message);
    }
  } else if (DATABASE_KIND === 'mysql' && pool) {
    try {
      await pool.execute(
        'INSERT INTO share_tokens (token, receipt_id, exp) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE receipt_id = VALUES(receipt_id), exp = VALUES(exp)',
        [token, id, exp]
      );
    } catch (e) {
      console.error('[share-tokens] mysql save failed:', e.message);
    }
  } else {
    shareTokensDb[token] = { id, exp };
    DB.share_tokens = shareTokensDb;
    save();
  }
}
async function pruneShareTokens() {
  // Remove tokens older than the TTL from the persistent store as well
  // as the in-memory map. Called periodically and after every save.
  const now = Date.now();
  const expired = [];
  for (const [k, v] of shareTokenMap) if (v.exp < now) expired.push(k);
  for (const k of expired) shareTokenMap.delete(k);
  if (!expired.length) return;
  if (DATABASE_KIND === 'postgres' && pool) {
    try { await pool.query('DELETE FROM share_tokens WHERE exp < $1', [now]); } catch {}
  } else if (DATABASE_KIND === 'mysql' && pool) {
    try { await pool.execute('DELETE FROM share_tokens WHERE exp < ?', [now]); } catch {}
  } else {
    for (const k of expired) delete shareTokensDb[k];
    DB.share_tokens = shareTokensDb;
    save();
  }
}

function makeShareToken(receipt) {
  const data = `${receipt.invoice_no}|${receipt.created_at}|${receipt.total}`;
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url').slice(0, 22);
  const ts = Date.now();
  // Token format: <base64-data>.<ts>.<sig>
  const payload = Buffer.from(data).toString('base64url');
  const token = `${payload}.${ts}.${sig}`;
  // Persist asynchronously (don't await — the caller doesn't need to
  // wait for the disk round-trip).
  saveShareToken(token, receipt.id, ts + SHARE_TOKEN_TTL_MS).catch((e) =>
    console.error('[share-tokens] save failed:', e.message)
  );
  // Periodically clean expired tokens to keep the map small.
  if (shareTokenMap.size > 5000) pruneShareTokens();
  return token;
}
function verifyShareToken(token) {
  if (!token || typeof token !== 'string') return null;
  const cached = shareTokenMap.get(token);
  if (cached) {
    if (cached.exp < Date.now()) { shareTokenMap.delete(token); return null; }
    return cached.id;
  }
  // Re-derive from token (so links survive server restart as long
  // as JWT_SECRET is the same and the receipt fields haven't changed).
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, ts, sig] = parts;
  const crypto = require('crypto');
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || tsNum + SHARE_TOKEN_TTL_MS < Date.now()) return null;
  let data;
  try { data = Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url').slice(0, 22);
  if (sig !== expectedSig) return null;
  const [invoice_no, created_at, total] = data.split('|');
  // Find the receipt with matching fields and remember its id.
  const r = DB.receipts.find((x) => x.invoice_no === invoice_no && x.created_at === created_at && Math.abs((x.total || 0) - parseFloat(total)) < 1);
  if (!r) return null;
  // Cache for next time. Persist in background so it survives restart.
  saveShareToken(token, r.id, tsNum + SHARE_TOKEN_TTL_MS).catch(() => {});
  return r.id;
}
app.post('/api/admin/receipts/:id/share', auth, (req, res) => {
  const r = DB.receipts.find(x => x.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  const token = makeShareToken(r);
  res.json({ token, expires_at: new Date(Date.now() + SHARE_TOKEN_TTL_MS).toISOString() });
});
// Public, read-only: render a kwitansi by token (no auth required).
app.get('/api/public/receipt/:token', (req, res) => {
  const id = verifyShareToken(req.params.token);
  if (!id) return res.status(404).json({ error: 'Link tidak valid atau sudah kadaluarsa' });
  const r = DB.receipts.find(x => x.id === id);
  if (!r) return res.status(404).json({ error: 'Kwitansi tidak ditemukan' });
  // Strip PII fields the customer doesn't need (proof image stays
  // private since they uploaded it themselves).
  const safe = { ...r };
  delete safe.proof_b64;
  delete safe.proof_mime;
  // Include business settings so the public page can render the
  // header/footer without an extra round-trip.
  const s = DB.settings || {};
  res.json({ receipt: safe, business: { business_name: s.business_name, tagline: s.tagline, address: s.address, phone: s.phone, practitioner: s.practitioner, primary_color: s.primary_color, accent_color: s.accent_color } });
});

// ===== Server-side rendered kwitansi page =====
//
// Why this exists: the previous client-only version of
// `kwitansi-share.html` hid the receipt behind a `display: none` until
// JS fetched `/api/public/receipt/:token` and rendered it. If the
// customer opened the link and immediately hit Ctrl+P (or right-click
// → Print, or used the Chrome print shortcut) before the fetch
// resolved, Chrome's print pipeline rendered the *initial* HTML —
// which was just the empty loading state — and produced a blank PDF
// titled only "Kwitansi — Adzkiya Mom Baby Care".
//
// This endpoint solves that by pre-rendering the invoice HTML on the
// server. The browser receives a complete document with the receipt
// data already inside, so any print/save-as-PDF command works on the
// very first paint. The CSS `@media print` rules in /css/style.css
// still apply, so the printed page looks identical to what the
// client-side render produced.
//
// Falls back gracefully: if the token is invalid, returns a clean
// error page (still 200 status so the browser shows the message
// instead of a generic error overlay).
//
// URL shape: `/kwitansi/<token>` — same token as the share link in
// WhatsApp/email. No query string needed (the token is in the path,
// so it survives copy-paste into PDFs/screenshots more reliably).
function renderKwitansiHtml({ receipt, business, error }) {
  // HTML-entity escape — defensive in case any field contains characters
  // like `<`, `>`, or `&`. The raw receipt fields come from the admin
  // form and are usually trusted, but the address/notes fields sometimes
  // contain free-form input. Quoting is cheap.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const fmtRp = (n) => 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }) : '-';
  if (error) {
    return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8"><title>Kwitansi tidak valid</title>
<meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/css/style.css">
</head>
<body class="kw-error">
<nav class="nav"><div class="nav-inner"><a href="/" class="brand"><div class="brand-logo" aria-hidden="true">🌸</div><div class="brand-text">Adzkiya Mom Baby Care<small>Kwitansi</small></div></a></div></nav>
<section class="section"><div class="container">
<div class="kwitansi-panel" style="max-width:560px;margin:40px auto;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:40px 24px;">
  <div style="font-size:3rem;margin-bottom:8px;">⚠️</div>
  <h2 style="margin-bottom:8px;">Kwitansi tidak dapat ditampilkan</h2>
  <p style="color:var(--text-soft);">${esc(error)}</p>
  <p style="margin-top:16px;"><a href="/" class="btn btn-primary">← Kembali ke Beranda</a></p>
</div>
</div></section>
</body></html>`;
  }
  const r = receipt;
  const biz = business || {};
  const times = (Array.isArray(r.service_times) && r.service_times.length)
    ? r.service_times
    : (r.service_time ? [r.service_time] : []);
  const items = Array.isArray(r.items) ? r.items : [];
  const timesHtml = times.length
    ? times.map((t) => `<span class="kwitansi-time-chip">⏰ ${esc(t)} WIB</span>`).join('')
    : '<span style="color:var(--text-soft);">—</span>';
  const sessionsLabel = times.length > 1 ? `<strong style="color:var(--primary);">${times.length} sesi</strong>` : '';
  const logoHtml = biz.has_logo
    ? '<img src="/api/logo" alt="">'
    : '<span style="font-size:2.4rem;">🌸</span>';
  const itemsRows = items.map((it) => `<tr>
    <td>${esc(it.name)}</td>
    <td class="num">${it.qty}</td>
    <td class="num">${fmtRp(it.price)}</td>
    <td class="num">${fmtRp(it.price * it.qty)}</td>
  </tr>`).join('');
  const transportRow = r.transport_fee ? `<div class="row"><span>Transportasi</span><span>${fmtRp(r.transport_fee)}</span></div>` : '';
  const discountRow  = r.discount ? `<div class="row"><span>Diskon</span><span>-${fmtRp(r.discount)}</span></div>` : '';
  const fullName = esc(biz.business_name || 'Adzkiya Mom Baby Care');
  const tagline  = esc(biz.tagline || 'Layanan Kesehatan Ibu & Anak Terpercaya');
  const address  = esc(biz.address || '');
  const phone    = esc(biz.phone || '085887018194');
  const practitioner = esc(biz.practitioner || 'Tasya Hanifah Pramesti, A.Md. Keb., CBME');

  // The page is structurally identical to the client-rendered
  // /kwitansi-share.html so the same @media print rules apply. The
  // key difference: the kwitansiPanel is rendered with `display:block`
  // from the start (no JS race), and the statusPanel is omitted
  // entirely. There is no async fetch, so Ctrl+P at any time produces
  // a populated PDF.
  return `<!DOCTYPE html>
<html lang="id" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kwitansi ${esc(r.invoice_no || '')} — Adzkiya Mom Baby Care</title>
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#ee5a8a" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1118" media="(prefers-color-scheme: dark)">
<meta name="description" content="Kwitansi ${esc(r.invoice_no || '')} atas nama ${esc(r.patient_name || '')} dari Adzkiya Mom Baby Care.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<link rel="stylesheet" href="/css/style.css">
<link rel="icon" href="/api/logo">
<style>
/* Server-rendered page: hide the action bar inside the print, since
   the customer is printing the receipt itself, not the page chrome. */
.kw-no-print { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
@media print { .kw-no-print { display: none !important; } }
/* If the user lands here, kwitansi is guaranteed ready — no loading
   state. Skip the body fade-in the client version uses. */
body { opacity: 1 !important; }
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="brand">
      <div class="brand-logo" aria-hidden="true">🌸</div>
      <div class="brand-text">Adzkiya Mom Baby Care<small>Kwitansi</small></div>
    </a>
    <a href="/" class="btn-nav" style="font-size:0.85rem;">← Beranda</a>
  </div>
</nav>

<section class="section" style="padding-top: 40px; padding-bottom: 30px;">
  <div class="container">
    <div class="section-head" style="margin-bottom: 20px;">
      <span class="section-eyebrow">Kwitansi Anda</span>
      <h2>🧾 Kwitansi ${esc(r.invoice_no || '')}</h2>
      <p>Hai ${esc(r.patient_name || 'Bunda')}, ini kwitansi layanan Anda. Tinggal print/save sebagai bukti pembayaran.</p>
    </div>

    <div class="kw-no-print">
      <button onclick="window.print()" class="btn btn-primary" type="button">🖨️ Cetak / Save PDF</button>
      <button onclick="kwShareWA()" class="btn btn-wa" type="button">💬 Share WhatsApp</button>
      <button onclick="kwCopyLink()" class="btn btn-outline" type="button">🔗 Copy Link</button>
    </div>

    <div class="invoice">
      <div class="invoice-header">
        <div class="invoice-brand">
          ${logoHtml}
          <div>
            <h2>${fullName}</h2>
            <small>${tagline}<br>${address}<br>WA: ${phone}</small>
          </div>
        </div>
        <div class="invoice-meta">
          <strong>KWITANSI</strong>
          <span class="invoice-meta-no">${esc(r.invoice_no || '')}</span>
          <small>${fmtDate(r.created_at)}</small>
        </div>
      </div>
      <div class="invoice-grid">
        <div class="invoice-block">
          <h4>Kepada</h4>
          <p class="invoice-block-body">
            <strong>${esc(r.patient_name || '-')}</strong><br>
            ${esc(r.whatsapp || '')}<br>
            ${esc(r.address || '')}
          </p>
        </div>
        <div class="invoice-block">
          <h4>Tanggal & Waktu Layanan ${sessionsLabel}</h4>
          <p class="invoice-block-body">
            ${r.service_date ? fmtDate(r.service_date) : '-'}
            <span class="kwitansi-time-row">${timesHtml}</span>
          </p>
        </div>
      </div>
      <table class="invoice-table">
        <thead><tr><th>Layanan</th><th class="num">Qty</th><th class="num">Harga</th><th class="num">Subtotal</th></tr></thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>${fmtRp(r.subtotal)}</span></div>
        ${transportRow}
        ${discountRow}
        <div class="row grand"><span>TOTAL</span><span>${fmtRp(r.total)}</span></div>
      </div>
      <div class="invoice-footer">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;text-align:left;">
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.82rem;color:var(--text-soft);">Penerima,</div>
            <div style="margin-top:50px;border-top:1px solid #2a1822;padding-top:6px;font-weight:700;">${esc(r.patient_name || '-')}</div>
            <div style="font-size:0.78rem;color:var(--text-soft);">Nama jelas & tanda tangan</div>
          </div>
          <div style="flex:1;min-width:200px;text-align:right;">
            <div style="font-size:0.82rem;color:var(--text-soft);">Hormat kami,</div>
            ${biz.has_owner_signature ? `<img id="ownerSigImg" src="/api/owner-signature" alt="Tanda tangan ${fullName}" style="display:block;max-height:60px;max-width:220px;margin:4px 0 4px auto;background:transparent;" />` : ''}
            <div id="ownerSigUnderline" style="${biz.has_owner_signature ? 'margin-top:6px;' : 'margin-top:50px;'}border-top:1px solid #2a1822;padding-top:6px;font-weight:700;"><em>${practitioner}</em></div>
            <div style="font-size:0.78rem;color:var(--text-soft);">${fullName}</div>
          </div>
        </div>
        <div style="margin-top:20px;padding-top:14px;border-top:1px dashed var(--pink-200);text-align:center;">
          <div style="font-size:0.92rem;">Terima kasih atas kepercayaan Anda 🌸</div>
          <div style="font-size:0.78rem;color:var(--text-soft);margin-top:4px;">Kwitansi ini sah dan diproses secara elektronik oleh sistem.</div>
        </div>
      </div>
    </div>

    <div class="kw-no-print" style="margin-top:24px;padding:14px 18px;background:var(--pink-50);border:1px dashed var(--pink-200);border-radius:12px;font-size:0.88rem;color:var(--text-soft);text-align:center;line-height:1.6;">
      🔒 <strong>Privasi:</strong> Link ini menggunakan token unik yang hanya diketahui oleh Anda &amp; admin Adzkiya. Jangan sebarkan ke orang lain.
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <div>© 2026 Adzkiya Mom Baby Care</div>
    <div><a href="/">Beranda</a></div>
  </div>
</footer>

<script>
// Keep the WA-share + Copy-link buttons working without depending on
// the legacy client bundle. These are tiny, self-contained, and never
// need a network round-trip — the receipt data is already in the DOM.
(function() {
  // SECURITY: escape '<' menjadi \u003c agar nilai (mis. patient_name)
  // yang memuat tag penutup script tidak bisa mengakhiri blok script ini
  // lebih awal lalu menyuntikkan HTML/script baru (XSS). JSON.stringify
  // tidak meng-escape '<', jadi kita tambahkan manual di sini.
  const receiptData = ${JSON.stringify({ invoice_no: r.invoice_no, patient_name: r.patient_name, whatsapp: r.whatsapp, total: r.total, service_date: r.service_date }).replace(/</g, '\\u003c')};
  window.kwReceiptData = receiptData;
  window.kwShareWA = function() {
    const r = receiptData;
    const fmtRp = (n) => 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
    const fmtDate = (s) => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }) : '-';
    const text = encodeURIComponent(
      'Halo Bunda ' + (r.patient_name || '') + ',\\n\\nIni kwitansi layanan Anda dari Adzkiya Mom Baby Care:\\n\\n📄 ' + (r.invoice_no || '') + '\\n💰 Total: ' + fmtRp(r.total) + '\\n📅 Layanan: ' + fmtDate(r.service_date) + '\\n\\nLihat detail & download di:\\n' + location.href + '\\n\\nTerima kasih 🌸'
    );
    const phone = (r.whatsapp || '').replace(/\\D/g, '');
    const base = phone ? 'https://wa.me/' + phone.replace(/^0/, '62') : 'https://wa.me/';
    window.open(base + '?text=' + text, '_blank');
  };
  window.kwCopyLink = function() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(
        () => alert('Link berhasil disalin!'),
        () => prompt('Salin link ini:', location.href)
      );
    } else {
      prompt('Salin link ini:', location.href);
    }
  };
})();
</script>
</body>
</html>`;
}

// Public, server-side rendered kwitansi page. Mounted at a *clean URL*
// (/kwitansi/<token>) so it's easy to copy/paste and so we don't
// collide with the legacy /kwitansi-share.html (which the old share
// links still point at — kept for backward compatibility, now falls
// back to the same render path).
//
// IMPORTANT: register this BEFORE express.static so the route wins
// over the file with the same name. express.static would otherwise
// serve /kwitansi/<anything> as a 404 (no such file in /public).
app.get(/^\/kwitansi\/([^/?#]+)\/?$/, (req, res) => {
  const token = req.params[0];
  const id = verifyShareToken(token);
  if (!id) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(renderKwitansiHtml({
      error: 'Link kwitansi ini tidak valid atau sudah kadaluarsa. Silakan minta admin mengirim ulang link yang baru.'
    }));
  }
  const r = DB.receipts.find((x) => x.id === id);
  if (!r) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(404).send(renderKwitansiHtml({ error: 'Kwitansi tidak ditemukan di sistem.' }));
  }
  const s = DB.settings || {};
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Don't cache — share links are personal and may change status.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(renderKwitansiHtml({
    receipt: r,
    business: {
      business_name: s.business_name,
      tagline: s.tagline,
      address: s.address,
      phone: s.phone,
      practitioner: s.practitioner,
      has_logo: !!s.logo_b64,
      has_owner_signature: !!s.owner_signature_b64
    }
  }));
});

// Legacy /kwitansi-share.html?t=<token> — keep working by transparently
// redirecting to the new server-rendered route. We can't fully drop the
// old file (already shared links in WhatsApp history), but the file
// itself would now render empty since it depends on JS that was being
// skipped by print pipelines. 308 preserves the method + body so this
// is safe for the GET that the browser makes when opening the page.


// Delete single receipt
app.delete('/api/admin/receipts/:id', auth, (req, res) => {
  const id = parseInt(req.params.id);
  const before = DB.receipts.length;
  DB.receipts = DB.receipts.filter(x => x.id !== id);
  save();
  res.json({ ok: true, deleted: before - DB.receipts.length });
});

// Bulk delete receipts: body { ids: [1,2,3] }
app.post('/api/admin/receipts/bulk-delete', auth, (req, res) => {
  const ids = (req.body.ids || []).map(n => parseInt(n)).filter(n => !isNaN(n));
  if (!ids.length) return res.status(400).json({ error: 'No ids' });
  const before = DB.receipts.length;
  DB.receipts = DB.receipts.filter(x => !ids.includes(x.id));
  save();
  res.json({ ok: true, deleted: before - DB.receipts.length });
});

// Delete ALL receipts
app.delete('/api/admin/receipts', auth, (req, res) => {
  const n = DB.receipts.length;
  DB.receipts = [];
  DB._seq.receipts = 0;
  save();
  res.json({ ok: true, deleted: n });
});

// ===== WHATSAPP BROADCAST =====
// Sends the SAME message to N patients at once via wa.me deep links.
// We don't call the WA API — instead we generate per-recipient links
// the admin clicks one-by-one (wa.me opens the WA app pre-filled).
// This keeps the app free + works on Railway without paid WA API.
//
// Recipient selection: filter by query params — same shape as
// /api/admin/reservations so admins can reuse familiar filters.
//   ?status=pending           → only pending reservations
//   ?status=approved          → only approved ones
//   ?payment_status=lunas     → only paid
//   ?from=2026-09-01&to=...   → date range (reservation_date)
//   ?limit=50                 → cap recipients per blast
//
// Each recipient is deduplicated by WhatsApp number (we'll never
// message the same person twice in the same blast even if they have
// multiple reservations matching the filter).

// Substitute {{placeholder}} tokens in a message body with per-row
// values. Unknown placeholders stay literal so the admin sees the
// gap (e.g. he forgot to use {{alamat}}).
function renderTemplate(body, row) {
  if (!body || !row) return body || '';
  return String(body).replace(/\{\{\s*([\w_]+)\s*\}\}/g, (m, key) => {
    // Friendly aliases so admin doesn't have to memorize every name.
    const aliases = {
      nama: row.patient_name,
      nama_pasien: row.patient_name,
      tanggal: row.reservation_date || row.service_date,
      tanggal_layanan: row.reservation_date || row.service_date,
      jam: row.reservation_time,
      waktu: row.reservation_time,
      layanan: row.service_name || (Array.isArray(row.items) ? row.items.map((it) => it.name).join(', ') : ''),
      total: typeof row.total === 'number' ? 'Rp ' + row.total.toLocaleString('id-ID') : (row.total || ''),
      invoice_no: row.invoice_no || '',
      wa: row.whatsapp || '',
      alamat: row.address || '',
    };
    const v = aliases[key] != null ? aliases[key] : (row[key] != null ? row[key] : m);
    return String(v);
  });
}

// Build a wa.me link that opens WA Web / app with the recipient's
// chat pre-filled + the message in the input box.
//   wa.me/<intl-number-without-plus>?text=<urlencoded message>
// We strip every non-digit from the phone. Numbers that begin with
// "0" (Indonesian format) get rewritten to "62" so they're valid for
// wa.me.
function buildWaLink(phone, message) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  // Indonesian numbers: replace leading 0 with 62. If already starts
  // with 62 / 8 / international format, leave it.
  let intl = digits;
  if (intl.startsWith('0')) intl = '62' + intl.slice(1);
  // Trim leading country-code for numbers that came in already with
  // +62 — wa.me doesn't accept the + sign anyway.
  return `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
}

function collectBroadcastRecipients(filter) {
  let rows = DB.reservations.slice();
  // Normalize dedup: same patient + same WhatsApp = 1 recipient,
  // keep the EARLIEST reservation so the message reflects upcoming /
  // most recent activity.
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  if (filter.payment_status) rows = rows.filter((r) => r.payment_status === filter.payment_status);
  if (filter.from) rows = rows.filter((r) => (r.reservation_date || '') >= filter.from);
  if (filter.to) rows = rows.filter((r) => (r.reservation_date || '') <= filter.to);
  // Cap to limit (default 200 to keep browser happy)
  const limit = Math.max(1, Math.min(500, parseInt(filter.limit, 10) || 200));
  rows = rows.slice(0, limit);

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const phone = String(r.whatsapp || '').replace(/\D/g, '');
    if (!phone) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    out.push(r);
  }
  return out;
}

app.post('/api/admin/broadcasts/preview', auth, (req, res) => {
  const recipients = collectBroadcastRecipients(req.body || {});
  res.json({
    count: recipients.length,
    recipients: recipients.map((r) => ({
      id: r.id,
      patient_name: r.patient_name,
      whatsapp: r.whatsapp,
      service_name: r.service_name,
      reservation_date: r.reservation_date,
      reservation_time: r.reservation_time,
      total: r.total,
      status: r.status,
      payment_status: r.payment_status,
    })),
  });
});

// Send (i.e. generate) the broadcast — returns per-recipient wa.me links
// so the admin can click each or use a browser-extension / script
// to dispatch them. We persist the broadcast into DB.broadcasts so
// we have an audit trail + can re-show the message if admin clicks
// "kirim ulang".
app.post('/api/admin/broadcasts', auth, (req, res) => {
  try {
    const { template_id, body_override, filter, name } = req.body || {};
    if (!template_id && !body_override) {
      return res.status(400).json({ error: 'template_id atau body_override wajib diisi' });
    }
    // Resolve template from settings; fall back to the override body.
    const tpl = (DB.settings.whatsapp_templates || []).find((t) => t.id === template_id);
    const baseBody = body_override || (tpl && tpl.body);
    if (!baseBody) return res.status(404).json({ error: 'Template tidak ditemukan' });

    const recipients = collectBroadcastRecipients(filter || {});
    if (!recipients.length) return res.status(400).json({ error: 'Tidak ada recipient yang cocok dengan filter' });

    const messages = recipients.map((r) => {
      const text = renderTemplate(baseBody, r);
      const link = buildWaLink(r.whatsapp, text);
      return { id: r.id, name: r.patient_name, phone: r.whatsapp, text, link };
    });
    const skipped = collectBroadcastRecipients(filter || {}).filter((r) => !r.whatsapp || !String(r.whatsapp).replace(/\D/g, '')).length;

    const id = nextId('broadcasts');
    const broadcast = {
      id,
      name: String(name || (tpl ? tpl.name : 'Custom blast')).slice(0, 100),
      template_id: template_id || null,
      body: baseBody,
      filter: filter || {},
      recipient_count: messages.length,
      skipped_no_phone: skipped,
      messages,
      created_at: new Date().toISOString(),
      created_by: req.user && (req.user.email || req.user.name) || 'admin',
    };
    DB.broadcasts.push(broadcast);
    if (DB.broadcasts.length > 200) DB.broadcasts = DB.broadcasts.slice(-200); // keep last 200
    save();
    res.json({
      ok: true,
      id,
      recipient_count: messages.length,
      messages,
    });
  } catch (e) {
    console.error('broadcast error:', e);
    res.status(500).json({ error: 'Gagal membuat broadcast: ' + e.message });
  }
});

// Read individual broadcast for "view past" modal
app.get('/api/admin/broadcasts/:id', auth, (req, res) => {
  const b = DB.broadcasts.find((x) => x.id === parseInt(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

app.get('/api/admin/broadcasts', auth, (req, res) => {
  // Strip heavy messages[] from list view; only summary metadata.
  const list = DB.broadcasts
    .slice()
    .reverse()
    .map((b) => ({
      id: b.id,
      name: b.name,
      template_id: b.template_id,
      recipient_count: b.recipient_count,
      skipped_no_phone: b.skipped_no_phone,
      filter: b.filter,
      body: b.body,
      created_at: b.created_at,
      created_by: b.created_by,
    }));
  res.json(list);
});

app.delete('/api/admin/broadcasts/:id', auth, (req, res) => {
  const before = DB.broadcasts.length;
  DB.broadcasts = DB.broadcasts.filter((b) => b.id !== parseInt(req.params.id));
  save();
  res.json({ ok: true, deleted: before - DB.broadcasts.length });
});

// Template CRUD — keep them inside settings.whatsapp_templates so
// they're covered by the existing PUT /api/admin/settings flow, but
// also expose dedicated endpoints for nicer UX (no need to re-send
// the whole settings payload just to add a template).
app.get('/api/admin/whatsapp/templates', auth, (req, res) => {
  res.json(DB.settings.whatsapp_templates || []);
});
app.post('/api/admin/whatsapp/templates', auth, (req, res) => {
  const t = req.body || {};
  if (!t.name || !t.body) return res.status(400).json({ error: 'name & body wajib diisi' });
  const template = {
    id: 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(t.name).slice(0, 80),
    category: ['reminder', 'followup', 'promo', 'other'].includes(t.category) ? t.category : 'other',
    body: String(t.body).slice(0, 1600),
  };
  DB.settings.whatsapp_templates = DB.settings.whatsapp_templates || [];
  DB.settings.whatsapp_templates.push(template);
  save();
  res.json(template);
});
app.patch('/api/admin/whatsapp/templates/:id', auth, (req, res) => {
  const list = DB.settings.whatsapp_templates || [];
  const t = list.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Template tidak ditemukan' });
  if (typeof req.body.name === 'string') t.name = String(req.body.name).slice(0, 80);
  if (typeof req.body.body === 'string') t.body = String(req.body.body).slice(0, 1600);
  if (typeof req.body.category === 'string' && ['reminder', 'followup', 'promo', 'other'].includes(req.body.category)) t.category = req.body.category;
  save();
  res.json(t);
});
app.delete('/api/admin/whatsapp/templates/:id', auth, (req, res) => {
  const before = (DB.settings.whatsapp_templates || []).length;
  DB.settings.whatsapp_templates = (DB.settings.whatsapp_templates || []).filter((t) => t.id !== req.params.id);
  save();
  res.json({ ok: true, deleted: before - DB.settings.whatsapp_templates.length });
});

// ===== ACCOUNTING — EXPENSES + P&L =====
// Track operational expenses (gas, supplies, marketing, etc.) so we
// can compute real profit = income - expense. Income comes from
// reservations with payment_status='lunas' (matches the Rekap
// Bulanan "Omzet" number) so users see consistent figures across
// the dashboard.
//
// Categories live in DB.expense_categories — admin can edit them via
// the settings endpoint below. Default categories cover most home-
// service businesses.
const DEFAULT_EXPENSE_CATEGORIES = [
  { id: 'cat_bensin', name: '⛽ Bensin / Transport', color: '#ee5a8a' },
  { id: 'cat_supplies', name: '🧴 Supplies (minyak, lotion)', color: '#ffb979' },
  { id: 'cat_marketing', name: '📣 Marketing / Iklan', color: '#a070d8' },
  { id: 'cat_gaji', name: '💼 Gaji / Fee Bidan', color: '#5cb8b1' },
  { id: 'cat_sewa', name: '🏠 Sewa Tempat', color: '#ffa76a' },
  { id: 'cat_lain', name: '📌 Lainnya', color: '#7c8390' },
];
function ensureExpenseCategories() {
  if (!Array.isArray(DB.expense_categories) || DB.expense_categories.length === 0) {
    DB.expense_categories = DEFAULT_EXPENSE_CATEGORIES.slice();
  }
}
ensureExpenseCategories();

app.get('/api/admin/expense-categories', auth, (req, res) => {
  ensureExpenseCategories();
  res.json(DB.expense_categories);
});

app.put('/api/admin/expense-categories', auth, (req, res) => {
  ensureExpenseCategories();
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'body harus array' });
  // Light validation: each entry needs {id, name, color}.
  const cleaned = req.body
    .filter((c) => c && typeof c === 'object' && c.name)
    .map((c) => ({ id: String(c.id || 'cat_' + Math.random().toString(36).slice(2, 8)), name: String(c.name).slice(0, 60), color: /^#[0-9a-f]{3,6}$/i.test(c.color) ? c.color : '#7c8390' }));
  if (!cleaned.length) return res.status(400).json({ error: 'minimal 1 kategori' });
  DB.expense_categories = cleaned;
  save();
  res.json(cleaned);
});

app.get('/api/admin/expenses', auth, (req, res) => {
  let rows = DB.expenses.slice();
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    rows = rows.filter((e) => (e.date || '').slice(0, 7) === req.query.month);
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id - a.id));
  res.json(rows);
});

app.post('/api/admin/expenses', auth, (req, res) => {
  const { date, category, amount, description } = req.body || {};
  if (!date || !category || !amount) return res.status(400).json({ error: 'date, category, amount wajib diisi' });
  const amt = parseInt(amount, 10);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount harus angka > 0' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date harus YYYY-MM-DD' });
  const id = nextId('expenses');
  const exp = { id, date, category, amount: amt, description: String(description || '').slice(0, 200), created_at: new Date().toISOString() };
  DB.expenses.push(exp);
  save();
  res.json(exp);
});
app.patch('/api/admin/expenses/:id', auth, (req, res) => {
  const e = DB.expenses.find((x) => x.id === parseInt(req.params.id));
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (req.body.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) e.date = req.body.date;
  if (req.body.category) e.category = String(req.body.category).slice(0, 60);
  if (req.body.amount != null) {
    const amt = parseInt(req.body.amount, 10);
    if (Number.isFinite(amt) && amt > 0) e.amount = amt;
  }
  if (typeof req.body.description === 'string') e.description = req.body.description.slice(0, 200);
  save();
  res.json(e);
});
app.delete('/api/admin/expenses/:id', auth, (req, res) => {
  const before = DB.expenses.length;
  DB.expenses = DB.expenses.filter((e) => e.id !== parseInt(req.params.id));
  save();
  res.json({ ok: true, deleted: before - DB.expenses.length });
});

// Income + Expenses + Profit summary per month. Income is the same
// logic as Rekap Bulanan: sum of total of reservations whose
// payment_status = 'lunas' AND reservation_date falls in the month.
// We also count receipts.created_at as a secondary source if the
// admin imported kwitansi tanpa reservation. For the monthly charts we
// surface both series for the last 6 months.
app.get('/api/admin/accounting/summary', auth, (req, res) => {
  const months = Math.max(1, Math.min(24, parseInt(req.query.months || '6', 10) || 6));
  // Build list of last N months including current.
  const today = new Date();
  const monthList = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    monthList.push(d.toISOString().slice(0, 7));
  }
  const monthSet = new Set(monthList);

  // Income per month — sum of total where reservation_date is in
  // the month AND payment_status = 'lunas'. We compute it server-side
  // to keep the dashboard snappy even on slow connections.
  const incomeByMonth = Object.fromEntries(monthList.map((m) => [m, 0]));
  const expenseByMonth = Object.fromEntries(monthList.map((m) => [m, 0]));
  const expensesByCategory = {};
  DB.reservations.forEach((r) => {
    if ((r.reservation_date || '').slice(0, 7) !== monthSet.has((r.reservation_date || '').slice(0, 7)) ? '' : '') return;
    if (!(r.reservation_date || '').slice(0, 7) || !monthSet.has((r.reservation_date || '').slice(0, 7))) return;
    if (r.payment_status === 'lunas') {
      const m = (r.reservation_date || '').slice(0, 7);
      incomeByMonth[m] = (incomeByMonth[m] || 0) + (r.total || calcReservationTotal(r));
    }
  });
  // Backup signal: receipts created in the month (e.g. imported
  // via PDF/JSON).
  DB.receipts.forEach((k) => {
    if (!k.created_at) return;
    const m = k.created_at.slice(0, 7);
    if (!monthSet.has(m)) return;
    if (!incomeByMonth[m]) return; // skip if already counted via reservation
    // Only count if the reservation that mirrors this receipt
    // doesn't already cover it (heuristic). To keep it simple
    // we add it; admin can verify in the Reservations list.
    incomeByMonth[m] = (incomeByMonth[m] || 0) + 0; // disabled — already covered
  });
  // Expenses per month
  DB.expenses.forEach((e) => {
    if (!e.date) return;
    const m = (e.date || '').slice(0, 7);
    if (!monthSet.has(m)) return;
    expenseByMonth[m] = (expenseByMonth[m] || 0) + (e.amount || 0);
    expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + (e.amount || 0);
  });

  const byMonth = monthList.map((m) => ({
    month: m,
    income: incomeByMonth[m] || 0,
    expense: expenseByMonth[m] || 0,
    profit: (incomeByMonth[m] || 0) - (expenseByMonth[m] || 0),
  }));

  const totals = byMonth.reduce((s, m) => ({
    income: s.income + m.income,
    expense: s.expense + m.expense,
    profit: s.profit + m.profit,
  }), { income: 0, expense: 0, profit: 0 });

  res.json({
    months: monthList.length,
    monthList,
    totals,
    byMonth,
    expenses_by_category: expensesByCategory,
    expense_categories: DB.expense_categories,
  });
});

// Import kwitansi dari file JSON upload (atau JSON body).
// Accepts many shapes so the user can paste data from anywhere:
//   1. Bare array: [{invoice_no,patient_name,...}, ...]
//   2. Backup shape: {receipts:[...]}  (matches /api/admin/backup output)
//   3. Nested shape: {items:[...]}, {data:[...]}, {kwitansi:[...]}
//   4. Newline / comma-separated rows from a copy-paste spreadsheet
// Skips duplicates by invoice_no (or by patient_name+service_date when
// invoice_no missing). Auto-generates invoice_no when missing and
// resets the receipt counter so future auto-numbering doesn't collide.
app.post('/api/admin/receipts/import', auth, restoreJsonParser, (req, res) => {
  try {
    let payload = req.body;
    // Accept raw array body too (some clients send [...] directly)
    let rows;
    if (Array.isArray(payload)) {
      rows = payload;
    } else if (payload && typeof payload === 'object') {
      rows = payload.receipts || payload.items || payload.data || payload.kwitansi || payload.kwitansi_list || [];
      // If still nothing, try to take any nested arrays of objects
      if (!rows.length) {
        for (const v of Object.values(payload)) {
          if (Array.isArray(v) && v.length && typeof v[0] === 'object') { rows = v; break; }
        }
      }
    }
    if (!Array.isArray(rows)) rows = [];
    if (!rows.length) return res.status(400).json({ error: 'File kosong atau format tidak dikenali. Pastikan berisi array kwitansi.' });

    const skip = req.query.skip !== '0' && req.body?.skip_duplicates !== false; // default: skip duplicates
    const imported = [];
    const skipped = [];
    const failed = [];

    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') { failed.push({ row: raw, reason: 'bukan objek' }); continue; }

      // Normalize field names so users can paste from spreadsheets that
      // use Indonesian/English column headers.
      const get = (...keys) => {
        for (const k of keys) {
          if (raw[k] != null && raw[k] !== '') return raw[k];
          const norm = k.toLowerCase().replace(/[\s_-]+/g, '');
          for (const rk of Object.keys(raw)) {
            if (rk.toLowerCase().replace(/[\s_-]+/g, '') === norm && raw[rk] != null && raw[rk] !== '') return raw[rk];
          }
        }
        return null;
      };

      const patient_name = String(get('patient_name', 'pasien', 'nama', 'nama_pasien', 'name', 'customer') || '').trim().slice(0, 150);
      if (!patient_name) { failed.push({ row: raw, reason: 'nama pasien kosong' }); continue; }

      const whatsapp = String(get('whatsapp', 'wa', 'hp', 'no_hp', 'phone', 'telepon') || '').trim().slice(0, 30);
      const address  = String(get('address',  'alamat') || '').trim().slice(0, 1000);

      // service_date: accept YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY
      let service_date = String(get('service_date', 'tanggal', 'tgl_layanan', 'tgl', 'date') || '').slice(0, 10);
      if (service_date && /^\d{2}\/\d{2}\/\d{4}$/.test(service_date)) {
        const [d, m, y] = service_date.split('/');
        service_date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      if (!service_date || !/^\d{4}-\d{2}-\d{2}$/.test(service_date)) {
        service_date = new Date().toISOString().slice(0, 10);
      }

      // Items: accept items[] or a single "layanan" string + price+qty
      let items = raw.items || raw.layanan || raw.services;
      if (!Array.isArray(items) || !items.length) {
        const name  = get('item', 'layanan', 'service', 'nama_layanan', 'service_name');
        const price = parseInt(get('price', 'harga', 'nominal', 'amount') || 0, 10);
        const qty   = parseInt(get('qty', 'jumlah', 'quantity') || 1, 10);
        if (name && price > 0) items = [{ name: String(name).trim(), price, qty: Math.max(1, qty) }];
      }
      if (!Array.isArray(items) || !items.length) { failed.push({ row: raw, reason: 'items kosong' }); continue; }
      items = items.map((it) => ({
        name:  String(it.name || it.layanan || it.service || '').trim().slice(0, 200),
        price: parseInt(it.price ?? it.harga ?? it.nominal ?? 0, 10) || 0,
        qty:   Math.min(99, Math.max(1, parseInt(it.qty ?? it.jumlah ?? 1, 10) || 1))
      })).filter((it) => it.name);

      if (!items.length) { failed.push({ row: raw, reason: 'item tidak valid' }); continue; }

      const transport_fee = parseInt(get('transport_fee', 'transport', 'ongkir', 'fee') || 0, 10) || 0;
      const discount      = parseInt(get('discount', 'diskon', 'potongan') || 0, 10) || 0;
      // service_time(s) + service_slots: support multi-waktu &
      // multi-tanggal. Accepts either:
      //   • service_slots : [{date, time}, ...] (array, most flexible)
      //   • service_times : ["09:00","14:00"] (array of HH:MM)
      //   • service_time  : "09:00"             (single, legacy)
      //   • waktu / jam / time : "09:00" or CSV "09:00,14:00,19:00"
      let slots = [];
      if (Array.isArray(raw.service_slots) && raw.service_slots.length) {
        slots = raw.service_slots
          .map((s) => ({
            date: String(s?.date || service_date || '').slice(0, 10),
            time: String(s?.time || '').slice(0, 5)
          }))
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{1,2}:\d{2}$/.test(s.time));
      }
      let normalizedTimes = [];
      const arrTimes = raw.service_times || raw.times || raw.waktu_list;
      if (Array.isArray(arrTimes)) {
        normalizedTimes = arrTimes
          .map((t) => String(t || '').trim())
          .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
          .slice(0, 14);
      }
      if (!normalizedTimes.length) {
        const rawTimeStr = String(get('service_time', 'waktu', 'jam', 'time', 'waktu_jam') || '').trim();
        if (rawTimeStr) {
          // Split by comma, semicolon, or newline so users can paste
          // "09:00, 14:00, 19:00" from a spreadsheet.
          const parts = rawTimeStr.split(/[,;\n|]/).map((s) => s.trim()).filter(Boolean);
          normalizedTimes = parts
            .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
            .slice(0, 14);
        }
      }
      if (!slots.length) {
        slots = normalizedTimes.map((t) => ({ date: service_date, time: t }));
      }
      if (!slots.length) slots = [{ date: service_date, time: '09:00' }];
      // Dedupe by (date, time)
      slots = slots.filter((s, i) => slots.findIndex((x) => x.date === s.date && x.time === s.time) === i);
      normalizedTimes = slots.map((s) => s.time);
      const service_time = slots[0].time;

      // Recompute totals server-side (never trust input numbers).
      // Total = subtotal × jumlah slot (per-waktu pricing). User can
      // still adjust with transport_fee / discount on top.
      const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
      const total    = subtotal * slots.length + transport_fee - discount;

      // Invoice number: keep if present and unique, otherwise auto-generate.
      let invoice_no = String(get('invoice_no', 'invoice', 'no_kwitansi', 'nomor') || '').trim().slice(0, 40);
      const dupe = skip && DB.receipts.find((x) =>
        (invoice_no && x.invoice_no === invoice_no) ||
        (!invoice_no && x.patient_name === patient_name && x.service_date === service_date)
      );
      if (dupe) { skipped.push({ invoice_no: dupe.invoice_no, patient_name, reason: 'duplicate' }); continue; }
      if (!invoice_no) {
        const tag = service_date.replace(/-/g, '');
        const sameDay = DB.receipts.filter((x) => (x.invoice_no || '').slice(4, 12) === tag).length + imported.filter((x) => x.invoice_no.slice(4, 12) === tag).length;
        invoice_no = `INV-${tag}-${String(sameDay + 1).padStart(3, '0')}`;
      }

      const id = nextId('receipts');
      const rec = {
        id, invoice_no, patient_name, whatsapp, address,
        service_date: slots[0].date,
        service_time,
        service_times: normalizedTimes,
        service_slots: slots,
        items, transport_fee, discount, subtotal, total,
        created_at: get('created_at', 'tanggal_buat') || new Date().toISOString()
      };
      DB.receipts.push(rec);
      imported.push(rec);
      // Mirror into a reservation so this kwitansi counts toward the
      // monthly totalOmzet on the Rekap Bulanan page. Skip when the
      // caller explicitly opts out via ?sync_reservations=0.
      if (req.query.sync_reservations !== '0') {
        syncReceiptToReservation(rec);
      }
    }

    if (imported.length) {
      // Bump the counter so future auto-generated invoice numbers don't
      // collide with the ones we just imported.
      const maxId = imported.reduce((m, r) => Math.max(m, r.id || 0), 0);
      if (maxId > (DB._seq.receipts || 0)) DB._seq.receipts = maxId;
      save();
    }

    res.json({
      ok: true,
      imported: imported.length,
      skipped: skipped.length,
      failed: failed.length,
      imported_items: imported.map((r) => ({ id: r.id, invoice_no: r.invoice_no, patient_name: r.patient_name, total: r.total })),
      skipped_items: skipped,
      failed_items: failed
    });
  } catch (e) {
    console.error('import receipts error:', e);
    res.status(500).json({ error: 'Gagal import: ' + e.message });
  }
});

// ===== IMPORT KWITANSI DARI PDF =====
// Parses Adzkiya kwitansi PDFs (generated by /admin printReceipt) and
// extracts invoice_no, patient_name, whatsapp, address, service_date,
// items[], subtotal, transport_fee, discount, total. One upload = up to
// 50 PDFs. The endpoint returns the parsed receipts as JSON so the
// admin can review & confirm before they hit the live DB (the frontend
// then re-posts them through /api/admin/receipts/import).
//
// Robustness notes: PDF text extraction depends on the renderer that
// produced the PDF. The Adzkiya receipt is rendered via window.print()
// → "Save as PDF" in Chrome/Edge, which preserves reading order
// reliably. We rely on stable anchors ("KWITANSI", "Kepada",
// "Tanggal Layanan", the items table header, "TOTAL") and fall back
// to looser heuristics if a particular PDF is missing text.

// Indonesian & English month names → month number
const MONTHS_ID = {
  januari:1, februari:2, maret:3, april:4, mei:5, juni:6, juli:7,
  agustus:8, september:9, oktober:10, november:11, desember:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, agu:8, sep:9, okt:10, nov:11, des:12,
  january:1, february:2, march:3, june:6, july:7, august:8,
  october:10, november:11, december:12,
};

// Parse Indonesian-formatted number: "Rp 80.000" / "Rp 1.250.000" / "80,000" / "1.500.000"
function parseIdNumber(str) {
  if (str == null) return 0;
  const s = String(str).replace(/rp\s*/i, '').trim();
  // Strip thousand separators (.) and use , as decimal only if there's a single one
  // at the end with 1-2 digits. Otherwise treat comma as thousand separator too.
  let cleaned = s.replace(/\./g, '').replace(/rp/ig, '').trim();
  if (/,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Convert "5 September 2026" / "5 Sep 2026" / "September 5, 2026" → "2026-09-05"
function parseIdDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  // YYYY-MM-DD already
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  // DD/MM/YYYY or MM/DD/YYYY (assume DD/MM since Indonesian)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo <= 12) return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  // "5 September 2026" / "5 Sep 2026" / "September 5, 2026"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS_ID[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(parseInt(m[1],10)).padStart(2,'0')}`;
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS_ID[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(parseInt(m[2],10)).padStart(2,'0')}`;
  }
  return null;
}

// Split PDF text into normalised lines (collapse runs of whitespace,
// drop empty lines, but keep order). Items table cells often arrive as
// one item per line when reading-order is preserved by pdf.js.
function pdfLines(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Universal kwitansi parser.
//
// Accepts PDFs from multiple versions of the Adzkiya site plus any
// "looks like a kwitansi" PDF that has these fields somewhere on it:
//
//   • A header word proving it's a receipt (KWITANSI / TAGIHAN / INVOICE /
//     BUKTI PEMBAYARAN / RECEIPT / TANDA TERIMA)
//   • An invoice number (INV-XXX, No. XXX, No: XXX, #XXX, or just a
//     long digit string in the header area)
//   • A patient section (Kepada / Kepada Yth / Penerima / Bill To /
//     Pelanggan / Customer / Untuk / Yth.)
//   • A phone-shaped number anywhere in the patient block
//   • A date line (Tanggal Layanan / Tanggal Pelayanan / Tanggal / Tgl /
//     ISO date anywhere)
//   • A table with at least 3 of {Layanan|Item|Treatment|Jasa|Paket,
//     Qty|Jumlah, Harga|Price|Biaya, Subtotal|Total|Jumlah}
//   • A totals block with one or more of {Subtotal, Total, Grand Total,
//     Total Bayar, Tagihan, Jumlah} + transport/diskon variants
//
// Returns a normalised receipt object or null if the text doesn't look
// like a receipt at all.
function parseAdzkiyaKwitansi(text) {
  const lines = pdfLines(text);
  const fullText = lines.join('\n');

  // ===== DOCUMENT TYPE: must look like a receipt =====
  // Match a header word in ALL CAPS (or capitalised), appearing as a
  // standalone token. The whole point of this check is to distinguish
  // "KWITANSI / TAGIHAN / INVOICE" as a *header* from these words
  // appearing in regular prose. We require:
  //   • The line containing the word is short (< 80 chars) AND
  //   • The word itself starts with an uppercase letter
  // Special case: "KWITANSI ELEKTRONIK" (the e-receipt variant) is
  // accepted as a single token.
  const DOC_TYPE_WORDS = ['KWITANSI', 'TAGIHAN', 'INVOICE', 'RECEIPT'];
  const looksLikeReceipt = lines.some((line) => {
    if (line.length > 80) return false;
    if (/^KWITANSI\s+ELEKTRONIK$/i.test(line)) return true;
    return DOC_TYPE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(line))
      || /^BUKTI\s*PEMBAYARAN$/i.test(line)
      || /^TANDA\s*TERIMA$/i.test(line);
  });
  if (!looksLikeReceipt) return null;

  // ===== INVOICE NUMBER =====
  // We try several strategies, in order of reliability:
  //   1. Look for a line that looks like "Label : INV-..." (with colon)
  //   2. Fall back to scanning the whole text for INV-XXX
  //   3. Long digit string as last resort
  let invoice_no = null;
  // Require either an "INV-" prefix or an explicit colon (`:`/`：`)
  // before the value. This prevents "KWITANSI ELEKTRONIK" (where
  // KWITANSI is the doc-type label, not an invoice label) from matching
  // and capturing "ELEKTRONIK" as the invoice number.
  const invLineRe = /^(?:No\.?\s*)?(?:Invoice|Kwitansi\s*Elektronik|Invoice\s*Elektronik|No\.|Nomor|Inv|#)\s*[:：]\s*(INV[-_]?\S+|[A-Z0-9][\w-]{4,})/i;
  for (const line of lines) {
    const m = line.match(invLineRe);
    if (m) { invoice_no = (m[1] || m[0]).trim(); break; }
  }
  if (!invoice_no) {
    const invRegexes = [
      /\bINV[-_]?[\w-]+/i,
      /\b(\d{10,})\b/,
    ];
    for (const re of invRegexes) {
      const m = fullText.match(re);
      if (m) { invoice_no = (m[1] || m[0]).trim(); break; }
    }
  }

  // ===== PATIENT SECTION =====
  // Two layouts are supported:
  //   A. Label header + value lines (Adzkiya v1)
  //      "Kepada" / patient name / phone / address
  //   B. Per-field "Label : value" lines (Adzkiya e-receipt variant)
  //      "Nama Pasien : MOM ARINA" / "No. Telp/HP : 081xxx" / etc.
  // We unify both into a single {label, value} map then read the
  // fields we need from it.
  const PATIENT_LABELS = /^(Kepada(?:\s*Yth\.?)?|Penerima|Bill\s*To|Pelanggan|Customer|Untuk|Yth\.?|Kepada\s*:?)/i;
  const SECTION_BOUNDARIES = /^(Tanggal\s+(Layanan|Pelayanan)|Tanggal|Tgl|Date|Item|Layanan|Jumlah|Harga|Subtotal|Total|Grand\s*Total|Total\s*Bayar|Tagihan|Diskon|Transportasi|Biaya\s+Transportasi|No\s+Invoice|No\s+Telp|Waktu|Nama\s+Pasien|Alamat)/i;
  const phoneRe = /(\+?\d{1,3}[- ]?\d{2,4}[- ]?\d{2,4}[- ]?\d{2,4}|\b0\d{8,12}\b)/;

  let patient_name = null, whatsapp = null, address = null;
  // Detect layout B: "Label : value" lines. If present, read from these
  // directly — they're the most reliable source of patient info.
  // The label may end with `:` (Indonesian-style) or `:` followed by space.
  const LABEL_VALUE_RE = /^(Nama\s+Pasien|No\.?\s*Telp(?:\/HP)?|No\.?\s*HP|HP|WhatsApp|Telp|Telepon|Alamat|Waktu(?:\/Jam)?|No\.?\s*Invoice)\s*[:：]\s*(.*)$/i;
  const labelValues = [];
  for (const line of lines) {
    const m = line.match(LABEL_VALUE_RE);
    if (m) labelValues.push({ raw: line, label: m[1], value: m[2].trim() });
  }
  // Time (HH:MM) — read from "Waktu/Jam :", "Jam :", "Time :", or any
  // HH:MM token on the patient block. Many Adzkiya PDFs (e.g. the
  // ARINA e-receipt layout) include this so the mirror reservation
  // gets the real session time instead of the 09:00 default.
  let service_time = null;
  function normalizeTime(str) {
    if (!str) return null;
    const s = String(str).trim();
    // "09.00" or "09:00" or "9:00" — all OK
    let m = s.match(/^(\d{1,2})[:.](\d{2})$/);
    if (m) {
      const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (h >= 0 && h < 24 && mm >= 0 && mm < 60) {
        return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      }
    }
    return null;
  }
  if (labelValues.length) {
    for (const lv of labelValues) {
      const val = lv.value;
      if (!val || val === '-' || val === '—') continue;
      if (/nama\s*pasien/i.test(lv.label)) patient_name = val;
      else if (/telp|hp|whatsapp|telepon/i.test(lv.label)) {
        const ph = val.match(phoneRe);
        if (ph) whatsapp = ph[1].replace(/[\s\-]/g, '');
      }
      else if (/alamat/i.test(lv.label)) address = val;
      else if (/waktu|jam|^time$/i.test(lv.label)) {
        const t = normalizeTime(val);
        if (t) service_time = t;
      }
    }
  } else {
    // Layout A: block after the patient label
    let patientIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (PATIENT_LABELS.test(lines[i])) { patientIdx = i; break; }
    }
    if (patientIdx >= 0) {
      const block = [];
      for (let i = patientIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (SECTION_BOUNDARIES.test(l)) break;
        block.push(l);
      }
      const cleaned = block.map((l) => l.replace(/^(HP|WhatsApp|No\.?\s*HP|No\.?\s*WhatsApp)\s*[:：]\s*/i, '').trim());
      patient_name = cleaned[0] || null;
      for (const l of cleaned) {
        const m = l.match(phoneRe);
        if (m) { whatsapp = m[1].replace(/[\s\-]/g, ''); break; }
      }
      const addrCandidates = cleaned.filter((l, idx) => {
        if (idx === 0) return false;
        if (whatsapp && l.includes(whatsapp)) return false;
        if (phoneRe.test(l)) return false;
        return l.replace(/^Alamat\s*[:：]\s*/i, '').trim();
      }).map((l) => l.replace(/^Alamat\s*[:：]\s*/i, '').trim()).filter(Boolean);
      if (addrCandidates.length) address = addrCandidates.join(', ');
    }
  }

  // ===== SERVICE DATE =====
  // Try to find an explicit "Tanggal Layanan" / "Tanggal Pelayanan" /
  // "Tanggal" / "Tgl" / "Date" line first. The value may be on the
  // same line (after a `:`) or the next non-section line.
  let service_date = null;
  const DATE_LABELS = /^(Tanggal\s+(Layanan|Pelayanan|Layanan\s*:?|Pelayanan\s*:?)|Tanggal\s*[:：]|Tgl\s+(Layanan|Pelayanan)?\s*[:：]|Date\s*[:：]|Service\s*Date\s*[:：])/i;
  for (let i = 0; i < lines.length; i++) {
    if (DATE_LABELS.test(lines[i])) {
      const same = lines[i].match(/[:：]\s*(.+)$/);
      if (same) { service_date = parseIdDate(same[1]); if (service_date) break; }
      const next = lines[i + 1];
      if (next && !SECTION_BOUNDARIES.test(next)) {
        service_date = parseIdDate(next);
        if (service_date) break;
      }
    }
  }
  // Fallback: any date-looking string anywhere in the text.
  if (!service_date) {
    // Prefer Indonesian long-form dates first (less likely to be a
    // false positive like a phone or invoice number)
    const indo = fullText.match(/\b\d{1,2}\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4}\b/i);
    if (indo) service_date = parseIdDate(indo[0]);
    if (!service_date) {
      const indoShort = fullText.match(/\b\d{1,2}\s+(Jan|Feb|Februari|Mar|Apr|Mei|Jun|Jul|Agu|Agustus|Sep|Sep|Okt|Oktober|Nov|Des|Desember)\s+\d{4}\b/i);
      if (indoShort) service_date = parseIdDate(indoShort[0]);
    }
    if (!service_date) {
      const ddmmyyyy = fullText.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
      if (ddmmyyyy) {
        const [, d, m, y] = ddmmyyyy;
        if (parseInt(m, 10) <= 12) service_date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
    }
    if (!service_date) {
      const iso = fullText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (iso) service_date = iso[1];
    }
  }
  // Last resort: "Dicetak pada: <date>" gives us the created_at. We
  // use it as service_date so the kwitansi doesn't get pushed to
  // today's date. Many Adzkiya receipts are filled on the same day
  // they're printed.
  if (!service_date) {
    const printed = fullText.match(/Dicetak(?:\s+pada)?\s*[:：]?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i);
    if (printed) {
      const [, d, m, y] = printed;
      service_date = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
  }
  // Fallback for service_time: scan for any HH:MM token in the text
  // (after the first 8 lines, which usually contain the business
  // header without a time).
  if (!service_time) {
    const candidates = lines.slice(8);
    for (const l of candidates) {
      // Skip if it looks like a date (e.g. "11 September 2026")
      if (/\d{4}/.test(l) && /(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)/i.test(l)) continue;
      const t = normalizeTime(l.match(/\b(\d{1,2}[:.]\d{2})\b/)?.[1]);
      if (t) { service_time = t; break; }
    }
  }

  // ===== ITEMS TABLE =====
  const COL_NAMES = {
    name:  /Layanan|Item|Treatment|Jasa|Paket|Pelayanan|Service|Description|Nama\s+Layanan|Kategori/i,
    qty:   /\bQty\b|Jumlah|Quantity|No\b/i,           // some PDFs use "No" as row number (not qty)
    price: /Harga|Price|Biaya|Tarif|Rp/i,
    total: /Subtotal|Total|Jumlah|Nominal/i,
  };
  function headerScore(line) {
    let n = 0;
    for (const k of Object.keys(COL_NAMES)) if (COL_NAMES[k].test(line)) n++;
    return n;
  }
  // A real table header should match name + (qty OR price OR total).
  // Exclude lines that look like totals rows (start with "Subtotal",
  // "Total", "Grand Total" etc.) but NOT lines where these words
  // appear as a column header in the middle (e.g. "Layanan Qty
  // Harga Subtotal").
  function isPlausibleHeader(line) {
    if (/^(Subtotal(\s+Layanan)?|Grand\s*Total|Total\s*Bayar|TOTAL\s*BAYAR|Tagihan|Total)\s*[:：]/i.test(line)) return false;
    return true;
  }
  // Find the BEST header line: highest score wins. When scores are
  // tied, prefer the LATER occurrence — table headers almost always
  // appear after the patient/date blocks, never in the business
  // address section above.
  let itemsHeaderIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isPlausibleHeader(lines[i])) continue;
    const sc = headerScore(lines[i]);
    if (sc >= bestScore) { bestScore = sc; itemsHeaderIdx = i; }
  }
  // Require a minimum confidence (3 typical, 2 for 3-col tables)
  if (bestScore < 2) itemsHeaderIdx = -1;
  // Anchors that signal we've left the items table.
  // Lines starting with any totals / transport / discount label end the
  // items block (e.g. "Subtotal Layanan :", "Fee Transportasi :",
  // "Potongan Diskon :", "TOTAL BAYAR :").
  const TOTAL_INLINE = /^(Subtotal(\s+Layanan)?|(Fee\s+)?Transportasi|Potongan(\s+)?Diskon|Grand\s*Total|Total\s*Bayar|TOTAL\s*BAYAR|Tagihan|Total|TOTAL)\s*[:：]?\s/i;
  // Extract a "x<n>" or "×<n>" quantity suffix from a name and return
  // {name, qty}. Returns null if no suffix found.
  function extractQtySuffix(name) {
    const m = name.match(/\s+[x×]\s*(\d{1,3})\s*$/i);
    if (m) return { name: name.slice(0, m.index).trim(), qty: parseInt(m[1], 10) || 1 };
    return null;
  }
  let items = [];
  if (itemsHeaderIdx >= 0) {
    for (let i = itemsHeaderIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (TOTAL_INLINE.test(l)) break;
      if (DATE_LABELS.test(l) || PATIENT_LABELS.test(l)) break;
      const clean = l.replace(/\s+Rp\s*$/i, '').trim();
      // Pattern A: "<name> <qty> [Rp ]<price> [Rp ]<subtotal?>"
      let m = clean.match(/^(.+?)\s+(\d{1,3})\s+(?:Rp\s*)?([\d.,]+)(?:\s+(?:Rp\s*)?([\d.,]+))?\s*$/i);
      if (m) {
        const name = m[1].trim();
        const qty = parseInt(m[2], 10);
        const price = parseIdNumber(m[3]);
        if (name && qty > 0 && price > 0 && !COL_NAMES.name.test(name)) {
          items.push({ name, qty, price });
          continue;
        }
      }
      // Pattern B: "<name> [Rp ]<price>" (qty implicit 1) — 3-col tables
      m = clean.match(/^(.+?)\s+(?:Rp\s*)?([\d.,]+)\s*$/i);
      if (m) {
        let name = m[1].trim();
        const price = parseIdNumber(m[2]);
        if (name && !COL_NAMES.name.test(name) && !COL_NAMES.price.test(name) && price > 0) {
          // Try to pull qty from a "x1" / "×2" suffix in the name.
          const split = extractQtySuffix(name);
          const qty = split ? split.qty : 1;
          if (split) name = split.name;
          items.push({ name, qty, price });
          continue;
        }
      }
      // Pattern C: "<name> x<n>" with no price at all (PDF text got
      // truncated at the right margin). Capture name + qty so the row
      // is at least visible in the import preview; price stays 0.
      const split = extractQtySuffix(clean);
      if (split && split.name.length > 3) {
        // Strip leading "<rowNum> <category>" if present (e.g.
        // "1 UMUM Mom & Newborn Care 7 Days" → "Mom & Newborn Care 7
        // Days"). Keep at least the part after the first whitespace if
        // it looks like a category.
        let cleanName = split.name;
        const leadingParts = split.name.split(/\s+/);
        if (leadingParts.length >= 3
            && /^\d+$/.test(leadingParts[0])
            && /^[A-Z]{2,}$/.test(leadingParts[1])) {
          cleanName = leadingParts.slice(2).join(' ');
        }
        items.push({ name: cleanName, qty: split.qty, price: 0 });
      }
    }
  }
  items = items.filter((it) => it.name && (it.price > 0 || it.qty > 0));

  // ===== TOTALS =====
  function findValueAfter(anchorRegexes, maxLines = 6) {
    for (let i = 0; i < lines.length; i++) {
      if (anchorRegexes.some((re) => re.test(lines[i]))) {
        const same = lines[i].match(/Rp?\s*([\d.,]+)/i);
        if (same) { const v = parseIdNumber(same[1]); if (v > 0) return v; }
        for (let j = 1; j <= maxLines && i + j < lines.length; j++) {
          const v = parseIdNumber(lines[i + j]);
          if (v > 0) return v;
        }
      }
    }
    return 0;
  }
  // The line might also be "Subtotal Layanan :", "Fee Transportasi :",
  // "Potongan Diskon :", "TOTAL BAYAR :" — any of these "label-with-colon"
  // variants. The findValueAfter helper reads the value on the same
  // line (after the colon) so the regex just needs to match the start.
  const subtotal = findValueAfter([
    /Subtotal(\s+Layanan)?/i,
  ]);
  const transport_fee = findValueAfter([
    /(Fee\s+)?Transportasi/i,
  ]);
  const discount = findValueAfter([
    /(Potongan\s+)?Diskon/i,
  ]);
  // Total preference order:
  //   1. Explicit "Grand Total" / "Total Bayar" / "Tagihan" line
  //   2. Plain "TOTAL" / "Total" line
  //   3. Compute subtotal + transport - discount as last resort
  const grandTotal = findValueAfter([
    /^Grand\s*Total/i,
    /^Total\s*Bayar/i,
    /^TOTAL\s*BAYAR/i,
    /^Tagihan/i,
    /Total\s*Akhir|Total\s*Keseluruhan|Total\s*Tagihan/i,
  ]);
  const plainTotal = findValueAfter([/^TOTAL\b/, /^Total\s/i]);
  const computed = subtotal + transport_fee - discount;
  let total = grandTotal;
  if (!total && plainTotal) total = plainTotal;
  if (!total) total = computed;
  // PDF text often gets truncated at the right margin (e.g. "Rp 850"
  // instead of "Rp 850.000"). Heuristics to recover the real value:
  //   • If grandTotal looks like a truncated version of computed, try
  //     multiplying by 10/100/1000 and pick the one closest to computed
  //   • Likewise for plainTotal
  function repairTruncation(value, reference) {
    if (!value || !reference) return value;
    if (value >= reference) return value;
    // value is suspiciously smaller than reference. Try multiplying.
    const multipliers = [10, 100, 1000, 10000];
    let best = value, bestDelta = Math.abs(reference - value);
    for (const m of multipliers) {
      const v = value * m;
      const d = Math.abs(reference - v);
      // Accept the multiplier only if it gets us much closer AND the
      // result is in a reasonable range (not absurdly larger).
      if (d < bestDelta && v <= reference * 1.5) { best = v; bestDelta = d; }
    }
    return best;
  }
  if (total && computed > 0 && total < computed) total = repairTruncation(total, computed);
  // If grand total is suspiciously small compared to computed AND
  // we have no items (so computed is also wrong), prefer computed.
  if (total && computed === 0 && total < 100000) {
    // Nothing reliable to fall back on — keep parsed total as-is.
  }
  // Last resort: if grandTotal exists but items list is empty, the
  // grandTotal value itself might be right (no need to repair).

  if (!service_date && invoice_no) {
    const m = invoice_no.match(/(\d{4})(\d{2})(\d{2})/);
    if (m) service_date = `${m[1]}-${m[2]}-${m[3]}`;
  }

  return {
    invoice_no,
    patient_name,
    whatsapp: whatsapp ? whatsapp.replace(/[\s\-]/g, '') : null,
    address,
    service_date,
    service_time,
    items,
    subtotal,
    transport_fee,
    discount,
    total,
    _confidence: items.length && patient_name && invoice_no ? 'high' : (patient_name ? 'medium' : 'low'),
  };
}

app.post('/api/admin/receipts/import-pdf', auth, pdfUpload.array('files', 50), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Pilih minimal 1 file PDF' });

    // Lazy-load pdf-parse so a broken install doesn't crash the boot.
    let PDFParse;
    try { PDFParse = await getPdfParse(); }
    catch (e) { return res.status(500).json({ error: 'pdf-parse gagal dimuat: ' + e.message }); }

    const results = [];
    for (const f of files) {
      const filename = f.originalname || 'unknown.pdf';
      let parser = null;
      try {
        parser = new PDFParse({ data: new Uint8Array(f.buffer) });
        const data = await parser.getText();
        const text = (data && (data.text || (data.pages || []).map((p) => p.text).join('\n'))) || '';
        if (!text.trim()) {
          results.push({ filename, ok: false, error: 'PDF tidak berisi teks (mungkin hasil scan/gambar). OCR tidak didukung.' });
          continue;
        }
        const parsed = parseAdzkiyaKwitansi(text);
        if (!parsed) {
          results.push({ filename, ok: false, error: 'PDF bukan kwitansi Adzkiya (tidak ada kata "KWITANSI").' });
          continue;
        }
        if (!parsed.patient_name) {
          results.push({ filename, ok: false, error: 'Tidak menemukan nama pasien di PDF.', parsed });
          continue;
        }
        if (!parsed.items || !parsed.items.length) {
          results.push({ filename, ok: false, error: 'Tidak menemukan daftar layanan di PDF.', parsed });
          continue;
        }
        results.push({ filename, ok: true, receipt: parsed });
      } catch (e) {
        results.push({ filename, ok: false, error: 'Gagal parse PDF: ' + e.message });
      } finally {
        if (parser) { try { await parser.destroy(); } catch {} }
      }
    }

    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    res.json({
      ok: true,
      total: files.length,
      parsed: ok.length,
      failed: failed.length,
      results,
      // Convenience: pre-shaped array that the user can POST straight
      // to /api/admin/receipts/import to actually insert.
      receipts: ok.map((r) => r.receipt),
    });
  } catch (e) {
    console.error('import-pdf error:', e);
    res.status(500).json({ error: 'Gagal import PDF: ' + e.message });
  }
});

// ===== ADMIN — SETTINGS =====
app.get('/api/admin/settings', auth, (req, res) => {
  const s = DB.settings || {};
  // Don't return the giant base64 blobs — use flags + endpoints.
  // owner_signature_b64 is a base64 PNG that can also be huge for
  // high-DPI scans, so strip it the same way we do for logo/hero/qris.
  // The frontend fetches it via /api/owner-signature when needed.
  //
  // SECURITY: also strip the AI secret keys (Gemini / OpenRouter API
  // keys and the WhatsApp Business access token). These must never be
  // echoed back to the client — the frontend only needs to know
  // WHETHER a key is set (has_* flags), not the value itself. The
  // admin re-enters a key only when rotating it.
  const {
    logo_b64, hero_b64, qris_b64, owner_signature_b64,
    ai_gemini_api_key, ai_openrouter_api_key, ai_assistant_access_token,
    ...rest
  } = s;
  res.json({
    ...rest,
    has_logo: !!logo_b64,
    has_hero: !!hero_b64,
    has_qris: !!qris_b64,
    has_owner_signature: !!owner_signature_b64,
    has_ai_gemini: !!ai_gemini_api_key,
    has_ai_openrouter: !!ai_openrouter_api_key,
    has_ai_wa_token: !!ai_assistant_access_token
  });
});

app.put('/api/admin/settings', auth, (req, res) => {
  const body = req.body || {};
  // SECURITY/DATA-LOSS guard: jangan pernah menimpa AI secret keys
  // dengan string kosong. Saat admin mengedit setting lain, field key
  // dibiarkan kosong — itu TIDAK boleh menghapus key yang sudah
  // tersimpan. Hanya timpa jika nilai baru benar-benar terisi.
  ['ai_gemini_api_key', 'ai_openrouter_api_key', 'ai_assistant_access_token'].forEach((k) => {
    if (k in body && (body[k] === '' || body[k] === null || body[k] === undefined)) delete body[k];
  });
  // Validate owner_signature base64 if present. We accept either a
  // raw base64 string (no header) or a full data URL
  // (data:image/png;base64,...). Both are stripped down to the raw
  // base64 before saving so the read path is uniform.
  if (body.owner_signature_b64 !== undefined) {
    const result = sanitizeOwnerSignatureInput(
      body.owner_signature_b64,
      body.owner_signature_mime
    );
    if (!result) {
      return res.status(400).json({
        error: 'owner_signature_b64 harus berupa image/png, image/jpeg, atau image/webp (base64 / data URL valid)'
      });
    }
    body.owner_signature_b64 = result.b64;
    body.owner_signature_mime = result.mime;
    if (!body.owner_signature_at) body.owner_signature_at = new Date().toISOString();
  }
  // Normalize optional metadata fields.
  if (body.owner_signature_method !== undefined) {
    body.owner_signature_method = String(body.owner_signature_method || '').slice(0, 32) || null;
  }
  if (body.owner_signature_via !== undefined) {
    body.owner_signature_via = String(body.owner_signature_via || '').slice(0, 64) || null;
  }
  // Clear the signature when method is explicitly empty + b64 is empty.
  if (body.owner_signature_b64 === '' || body.owner_signature_b64 === null) {
    body.owner_signature_b64 = null;
    body.owner_signature_mime = null;
  }
  DB.settings = { ...DB.settings, ...body };
  save();
  res.json({ ok: true });
});

// Decode + validate an owner-signature payload coming in via PUT /settings
// or POST /owner-signature. Returns { b64, mime } on success or null on
// bad input. We re-check the magic bytes (not just the data URL prefix)
// so a malicious admin can't smuggle an HTML payload via the signature
// field and have it rendered as <img> in the printed kwitansi.
function sanitizeOwnerSignatureInput(input, mimeHint) {
  if (input == null) return null;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let mime = null;
  let b64 = null;
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(trimmed);
  if (dataUrlMatch) {
    mime = dataUrlMatch[1].toLowerCase();
    b64 = dataUrlMatch[2].replace(/\s+/g, '');
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 32) {
    b64 = trimmed.replace(/\s+/g, '');
    mime = (mimeHint || 'image/png').toLowerCase();
  } else {
    return null;
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
    return null;
  }
  let raw;
  try { raw = Buffer.from(b64, 'base64'); } catch { return null; }
  if (raw.length < 16) return null;
  // Re-check the binary header. PNG starts with 89 50 4E 47 0D 0A 1A 0A,
  // JPEG with FF D8 FF, WebP with RIFF....WEBP, GIF with GIF8.
  const head = raw.subarray(0, 8);
  let okMagic = false;
  if (mime === 'image/png' && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) okMagic = true;
  else if (mime === 'image/jpeg' && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) okMagic = true;
  else if (mime === 'image/webp' && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') okMagic = true;
  else if (mime === 'image/gif' && head.subarray(0, 3).toString() === 'GIF') okMagic = true;
  if (!okMagic) return null;
  // Cap at ~1.5 MB base64 (≈1.1 MB binary) to keep DB state from
  // bloating. High-DPI scans rarely need more than that for a TTD.
  if (raw.length > 1.5 * 1024 * 1024) return null;
  return { b64, mime };
}

app.post('/api/admin/settings/upload', auth, upload.single('file'), (req, res) => {
  const kind = req.body.kind;
  if (!['logo', 'hero', 'qris'].includes(kind)) return res.status(400).json({ error: 'kind invalid' });
  if (!req.file) return res.status(400).json({ error: 'file missing' });
  if (!req.file.mimetype.startsWith('image/') || !validFileSignature(req.file)) {
    return res.status(400).json({ error: 'File harus berupa PNG, JPEG, atau WebP yang valid' });
  }
  DB.settings[`${kind}_b64`] = req.file.buffer.toString('base64');
  DB.settings[`${kind}_mime`] = req.file.mimetype;
  save();
  res.json({ ok: true });
});

// ----- OWNER SIGNATURE (bidan / pemilik) -----
// Save once, embed in every kwitansi's "Hormat kami," block so the
// admin doesn't have to sign each printed receipt by hand. Three input
// modes are accepted via three endpoints (or just PUT /api/admin/settings
// with the raw base64):
//
//   POST /api/admin/settings/owner-signature   (multipart file upload)
//   POST /api/admin/settings/owner-signature/scan (JSON {b64, mime?, via?})
//   DELETE /api/admin/settings/owner-signature   (clear)
//
// The same sanitizer runs on every path so we never store a
// non-image payload in the signature field.
const ownerSigUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1.5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    callback(null, true);
  }
});

app.post('/api/admin/settings/owner-signature', auth, ownerSigUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file missing' });
  const b64 = req.file.buffer.toString('base64');
  const result = sanitizeOwnerSignatureInput(b64, req.file.mimetype);
  if (!result) {
    return res.status(400).json({
      error: 'File signature harus PNG, JPEG, atau WebP (signature tidak valid atau terlalu besar >1.5MB)'
    });
  }
  DB.settings.owner_signature_b64 = result.b64;
  DB.settings.owner_signature_mime = result.mime;
  DB.settings.owner_signature_method = 'upload';
  DB.settings.owner_signature_via = req.body && req.body.via ? String(req.body.via).slice(0, 64) : null;
  DB.settings.owner_signature_at = new Date().toISOString();
  save();
  res.json({
    ok: true,
    method: DB.settings.owner_signature_method,
    mime: DB.settings.owner_signature_mime,
    bytes: Math.floor(result.b64.length * 3 / 4),
    at: DB.settings.owner_signature_at
  });
});

// Save a signature from a data URL / base64 payload. Used for:
//   - "langsung"   mode (canvas.toDataURL from the Settings UI)
//   - "barcode"    mode (paste base64 decoded from a QR code that
//                    encoded the signature image)
//   - "ocr"        mode (paste base64 of a signature image extracted
//                    from a phone-camera scan / OCR app)
// The frontend just hands us the base64 + which method it used; we
// validate the bytes, normalize the mime, and store.
app.post('/api/admin/settings/owner-signature/scan', auth, (req, res) => {
  const body = req.body || {};
  const result = sanitizeOwnerSignatureInput(body.b64, body.mime);
  if (!result) {
    return res.status(400).json({
      error: 'b64 harus berupa image/png, image/jpeg, atau image/webp (base64 / data URL valid, max 1.5MB)'
    });
  }
  const allowedMethods = ['langsung', 'barcode', 'ocr', 'upload'];
  const method = allowedMethods.includes(body.method) ? body.method : 'ocr';
  DB.settings.owner_signature_b64 = result.b64;
  DB.settings.owner_signature_mime = result.mime;
  DB.settings.owner_signature_method = method;
  DB.settings.owner_signature_via = body.via ? String(body.via).slice(0, 64) : null;
  DB.settings.owner_signature_at = new Date().toISOString();
  save();
  res.json({
    ok: true,
    method: DB.settings.owner_signature_method,
    mime: DB.settings.owner_signature_mime,
    bytes: Math.floor(result.b64.length * 3 / 4),
    at: DB.settings.owner_signature_at
  });
});

app.delete('/api/admin/settings/owner-signature', auth, (req, res) => {
  DB.settings.owner_signature_b64 = null;
  DB.settings.owner_signature_mime = null;
  DB.settings.owner_signature_method = null;
  DB.settings.owner_signature_via = null;
  DB.settings.owner_signature_at = null;
  save();
  res.json({ ok: true });
});

// Public: serve the saved signature image so the print-preview HTML
// and the server-rendered kwitansi page can <img src='/api/owner-signature'>
// without needing the admin token. Cached aggressively because the
// file never changes once saved (only when the admin re-saves).
app.get('/api/owner-signature', (req, res) => {
  const s = DB.settings;
  if (!s || !s.owner_signature_b64) return res.status(404).end();
  res.setHeader('Content-Type', s.owner_signature_mime || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(s.owner_signature_b64, 'base64'));
});

// Upload an icon image for one social media entry (Instagram, TikTok, etc.).
// Body: kind=social-icon, idx=<position in SETTINGS.socials>, file=<image>
app.post('/api/admin/socials/icon', auth, upload.single('file'), (req, res) => {
  const idx = parseInt(req.body.idx, 10);
  DB.settings.socials = DB.settings.socials || [];
  if (isNaN(idx) || idx < 0 || idx >= DB.settings.socials.length) {
    return res.status(400).json({ error: 'idx invalid' });
  }
  if (!req.file) return res.status(400).json({ error: 'file missing' });
  if (!req.file.mimetype.startsWith('image/') || !validFileSignature(req.file)) {
    return res.status(400).json({ error: 'File harus berupa PNG, JPEG, atau WebP yang valid' });
  }
  // Cap icon size at 500 KB after base64 encode to keep the JSON state small.
  if (req.file.size > 500 * 1024) {
    return res.status(400).json({ error: 'Ukuran foto profil maksimal 500 KB. Kompres dulu atau crop jadi kecil.' });
  }
  DB.settings.socials[idx].icon_b64 = req.file.buffer.toString('base64');
  DB.settings.socials[idx].icon_mime = req.file.mimetype;
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/socials/icon/:idx', auth, (req, res) => {
  const idx = parseInt(req.params.idx, 10);
  DB.settings.socials = DB.settings.socials || [];
  if (isNaN(idx) || idx < 0 || idx >= DB.settings.socials.length) {
    return res.status(400).json({ error: 'idx invalid' });
  }
  delete DB.settings.socials[idx].icon_b64;
  delete DB.settings.socials[idx].icon_mime;
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/settings/:kind', auth, (req, res) => {
  const k = req.params.kind;
  if (!['logo', 'hero', 'qris'].includes(k)) return res.status(400).json({ error: 'kind invalid' });
  DB.settings[`${k}_b64`] = null;
  DB.settings[`${k}_mime`] = null;
  save();
  res.json({ ok: true });
});

// ===== ADMIN — BACKUP / RESTORE =====
app.get('/api/admin/backup', auth, (req, res) => {
  res.json({
    exported_at: new Date().toISOString(),
    reservations: DB.reservations.map(r => { const { proof_b64, ...rest } = r; return rest; }),
    receipts: DB.receipts,
    expenses: DB.expenses,
    expense_categories: DB.expense_categories,
    broadcasts: DB.broadcasts.map(b => ({ id: b.id, name: b.name, body: b.body, recipient_count: b.recipient_count, filter: b.filter, created_at: b.created_at })),
    // SECURITY: buang AI secret keys dari backup. File backup sering
    // dibagikan/diunduh, jadi API key tidak boleh ikut terbawa.
    settings: (() => {
      const { ai_gemini_api_key, ai_openrouter_api_key, ai_assistant_access_token, ...s } = (DB.settings || {});
      return s;
    })()
  });
});

app.post('/api/admin/restore', auth, restoreJsonParser, (req, res) => {
  try {
    const { reservations = [], receipts = [], settings, mode = 'append', sync_reservations } = req.body;
    const errors = [];
    if (mode === 'replace') {
      DB.reservations = []; DB.receipts = [];
      DB._seq.reservations = 0; DB._seq.receipts = 0;
    }
    let reservationsImported = 0, reservationsSkipped = 0;
    for (const r of reservations) {
      if (!r || !r.patient_name || !r.reservation_date) {
        reservationsSkipped++;
        continue;
      }
      // Dedup: skip if same patient + same date + same total already
      // exists in DB. Prevents double-restoring the same backup.
      const dupe = DB.reservations.find((x) =>
        x.patient_name === r.patient_name &&
        x.reservation_date === r.reservation_date &&
        Math.abs((x.total || 0) - (r.total || 0)) <= 1
      );
      if (dupe) { reservationsSkipped++; continue; }
      DB.reservations.push({ ...r, id: nextId('reservations') });
      reservationsImported++;
    }
    let receiptsImported = 0, receiptsSkipped = 0;
    for (const k of receipts) {
      if (!k || !k.patient_name) { receiptsSkipped++; continue; }
      if (DB.receipts.find(x => x.invoice_no && x.invoice_no === k.invoice_no)) {
        receiptsSkipped++;
        continue;
      }
      DB.receipts.push({ ...k, id: nextId('receipts') });
      receiptsImported++;
      // Auto-sync restored receipts to reservations so the Rekap
      // Bulanan page picks them up. Default ON. Pass
      // sync_reservations=false to opt out.
      if (sync_reservations !== false) {
        syncReceiptToReservation(k);
      }
    }
    // Bump the receipt counter so the next auto-generated invoice
    // number doesn't collide with the ones we just restored.
    const maxReceiptId = receipts.reduce((m, r) => Math.max(m, r.id || 0), 0);
    if (maxReceiptId > (DB._seq.receipts || 0)) DB._seq.receipts = maxReceiptId;
    const maxResvId = reservations.reduce((m, r) => Math.max(m, r.id || 0), 0);
    if (maxResvId > (DB._seq.reservations || 0)) DB._seq.reservations = maxResvId;
    if (settings && mode === 'replace') {
      // Don't blindly replace — merge: keep the settings the user
      // currently has for sensitive fields (admins, etc) but apply
      // restored values for business_name, address, bank_accounts,
      // etc. To fully replace, use a separate "Reset all" action.
      DB.settings = { ...DB.settings, ...settings };
    }
    save();
    res.json({
      ok: true,
      imported: {
        reservations: reservationsImported,
        receipts: receiptsImported,
        reservations_skipped: reservationsSkipped,
        receipts_skipped: receiptsSkipped
      },
      mode
    });
  } catch (e) {
    console.error('restore error:', e);
    res.status(500).json({ error: 'Gagal restore: ' + e.message });
  }
});

// ===== ADMIN — PROFILE (email & password update) =====
// Update the currently logged-in admin's email and/or password. Requires
// the current password as confirmation (defense against an attacker who
// got a hold of an open browser session). All fields are optional —
// callers can update email only, password only, or both.
app.put('/api/admin/profile', auth, (req, res) => {
  try {
    const { email, current_password, new_password } = req.body || {};
    const admin = DB.admins.find((a) => a.id === req.user.id);
    if (!admin) return res.status(404).json({ error: 'Akun admin tidak ditemukan' });

    // Validate current password unless we're in a recovery flow
    // (recovery handled separately by setting RESET_ADMIN_PASSWORD env
    // and restarting the service — see seedAdmin above). For the
    // everyday case, requiring the current password keeps the flow
    // safe.
    const wantsChange = !!(email || new_password);
    if (!wantsChange) return res.status(400).json({ error: 'Tidak ada perubahan yang diminta' });

    if (!current_password || !bcrypt.compareSync(String(current_password), admin.password_hash)) {
      return res.status(401).json({ error: 'Password saat ini salah' });
    }

    const updates = {};

    // Email change — must be unique, must look like an email.
    if (email && typeof email === 'string') {
      const trimmed = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'Format email tidak valid' });
      }
      const dup = DB.admins.find((a) => a.id !== admin.id && a.email.toLowerCase() === trimmed);
      if (dup) return res.status(409).json({ error: 'Email sudah dipakai admin lain' });
      if (trimmed !== admin.email) {
        updates.email = trimmed;
      }
    }

    // Password change — require 8+ chars (admin password is the gate
    // to patient data; we want a reasonable minimum without being
    // annoying). Reject if new_password equals current.
    if (new_password && typeof new_password === 'string') {
      if (new_password.length < 8) {
        return res.status(400).json({ error: 'Password baru minimal 8 karakter' });
      }
      if (bcrypt.compareSync(new_password, admin.password_hash)) {
        return res.status(400).json({ error: 'Password baru tidak boleh sama dengan yang lama' });
      }
      updates.password_hash = bcrypt.hashSync(new_password, 12);
      updates.password_changed_at = new Date().toISOString();
    }

    if (!Object.keys(updates).length) {
      return res.json({ ok: true, user: admin, changed: false });
    }

    Object.assign(admin, updates);
    save();

    // Return the updated admin record so the client can refresh its
    // local copy. After an email change, the user must log in again
    // with the new email — we surface this in the response so the
    // frontend can show a "please log in again" toast if needed.
    res.json({
      ok: true,
      changed: true,
      email_changed: !!updates.email,
      password_changed: !!updates.password_hash,
      user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
      requires_relogin: !!updates.email
    });
  } catch (e) {
    console.error('profile update error:', e);
    res.status(500).json({ error: 'Gagal update profil: ' + e.message });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));



// ===== AI BOOKING ASSISTANT =====
const AI_DEFAULT_PERSONA = `Kamu adalah Adzkiya Assistant, customer service AI untuk klinik home-service Adzkiya Mom Baby Care di Cilacap.\n\nTugas kamu:\n1. Menyapa customer dengan hangat dalam Bahasa Indonesia\n2. Membantu memilih layanan yang sesuai dari katalog\n3. Memberi info harga, jam operasional, dan area layanan\n4. Membantu booking: tanyakan tanggal & jam yang diinginkan, lalu arahkan customer untuk konfirmasi via WhatsApp ke admin\n\nAturan penting:\n- Jawab singkat (max 3-4 kalimat per pesan)\n- Gunakan emoji secukupnya (🌸 untuk sapaan, ✅ untuk konfirmasi)\n- SELALU akhiri dengan pertanyaan untuk lanjutkan percakapan\n- JANGAN sebut harga detail kecuali customer tanya\n- JANGAN janjikan booking tanpa admin confirmation\n- Untuk finalisasi booking, arahkan ke WhatsApp admin`;

function buildAISystemPrompt() {
  const s = DB.settings || {};
  const servicesList = SERVICES.map(cat => {
    const items = cat.items.map(i => `- ${i.name}: Rp${i.price.toLocaleString('id-ID')}`).join('\n');
    return `${cat.cat}:\n${items}`;
  }).join('\n\n');
  const hours = (s.hours || []).map(h => `${h.day}: ${h.closed ? 'Tutup' : `${h.open}-${h.close}`}`).join(', ');
  const userPrompt = (DB.settings.ai_assistant_base_prompt || '').trim();
  return [
    userPrompt || AI_DEFAULT_PERSONA,
    `\n\n=== INFO BISNIS ===`,
    `Nama: ${s.business_name || 'Adzkiya Mom Baby Care'}`,
    `Alamat: ${s.address || ''}`,
    `WhatsApp admin: ${s.phone || ''}`,
    `Jam operasional: ${hours || '08.00-20.00'}`,
    `Metode pembayaran: COD, Transfer, QRIS`,
    `\n=== KATALOG LAYANAN ===`,
    servicesList,
    `\n=== INSTRUKSI TEKNIS ===`,
    `- Customer sudah memilih untuk chat dengan AI, jadi layani dengan ramah\n- Jika customer minta booking, kumpulkan: nama layanan, tanggal (YYYY-MM-DD), jam (HH:MM), nama customer, WhatsApp, alamat.\n- Setelah dapat semua info, balas dengan ringkasan + link WhatsApp: https://wa.me/${(s.phone || '6285887018194').replace(/\D/g, '')}?text=<encoded message>\n- JANGAN mengarang harga custom. Pakai harga dari katalog di atas.\n- JANGAN menerima pembayaran. Booking selalu difinalkan via WhatsApp admin.`,
  ].join('\n');
}

// --- Provider: Google Gemini ---
async function callGemini(systemPrompt, messages) {
  const apiKey = DB.settings.ai_gemini_api_key;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  // Always prepend system prompt as first user+model exchange
  contents.unshift({ role: 'user', parts: [{ text: systemPrompt }] });
  contents.unshift({ role: 'model', parts: [{ text: 'Siap membantu customer Adzkiya.' }] });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
    })
  }, 30000);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('Gemini ' + r.status + ': ' + text.slice(0, 200));
  }
  const data = await r.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) throw new Error('Gemini: empty response');
  return reply;
}

// --- Provider: OpenRouter (fallback) ---
async function callOpenRouter(systemPrompt, messages) {
  const apiKey = DB.settings.ai_openrouter_api_key;
  if (!apiKey) throw new Error('OpenRouter API key not configured');
  const oaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'HTTP-Referer': 'https://putra1996.github.io/Adzkiyamombabycareweb',
      'X-Title': 'Adzkiya Mom Baby Care'
    },
    body: JSON.stringify({
      model: 'google/gemini-flash-1.5',
      messages: oaMessages,
      max_tokens: 500,
      temperature: 0.7
    })
  }, 30000);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('OpenRouter ' + r.status + ': ' + text.slice(0, 200));
  }
  const data = await r.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error('OpenRouter: empty response');
  return reply;
}

// Try Gemini first, fall back to OpenRouter. Returns { reply, provider }.
async function callAIChat(systemPrompt, messages) {
  const errors = [];
  // Try Gemini if key is set
  if (DB.settings.ai_gemini_api_key) {
    try {
      return { reply: await callGemini(systemPrompt, messages), provider: 'gemini' };
    } catch (e) { errors.push('Gemini: ' + e.message); }
  }
  // Fallback to OpenRouter if key is set
  if (DB.settings.ai_openrouter_api_key) {
    try {
      return { reply: await callOpenRouter(systemPrompt, messages), provider: 'openrouter' };
    } catch (e) { errors.push('OpenRouter: ' + e.message); }
  }
  throw new Error('Tidak ada AI provider yang berhasil: ' + errors.join(' | '));
}

// PUBLIC chat endpoint — used by the chat widget on the landing page
// and (optionally) by the WA webhook handler.
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history = [], session_id = 'web-' + Date.now() } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message wajib diisi' });
    }
    const trimmed = message.slice(0, 1000);
    if (!DB.settings.ai_assistant_enabled) {
      return res.status(503).json({
        error: 'AI assistant belum diaktifkan. Hubungi admin via WhatsApp untuk booking.',
        fallback_wa: 'https://wa.me/' + (DB.settings.phone || '6285887018194').replace(/\D/g, '')
      });
    }
    if (!DB.settings.ai_gemini_api_key && !DB.settings.ai_openrouter_api_key) {
      return res.status(503).json({
        error: 'AI provider belum dikonfigurasi. Hubungi admin via WhatsApp.',
        fallback_wa: 'https://wa.me/' + (DB.settings.phone || '6285887018194').replace(/\D/g, '')
      });
    }

    const systemPrompt = buildAISystemPrompt();
    const messages = [
      ...history.slice(-10).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 1000) })),
      { role: 'user', content: trimmed }
    ];
    const result = await callAIChat(systemPrompt, messages);

    // Log conversation (max 200 entries, ring buffer)
    if (!Array.isArray(DB.settings.ai_assistant_conversations)) DB.settings.ai_assistant_conversations = [];
    DB.settings.ai_assistant_conversations.push({
      session_id,
      channel: 'web',
      ts: new Date().toISOString(),
      user: trimmed,
      assistant: result.reply,
      provider: result.provider
    });
    if (DB.settings.ai_assistant_conversations.length > 200) {
      DB.settings.ai_assistant_conversations = DB.settings.ai_assistant_conversations.slice(-200);
    }
    save();

    res.json({
      reply: result.reply,
      provider: result.provider,
      session_id
    });
  } catch (e) {
    console.error('[ai/chat]', e);
    res.status(500).json({
      error: 'AI chat gagal: ' + (e.message || 'unknown error'),
      fallback_wa: 'https://wa.me/' + (DB.settings.phone || '6285887018194').replace(/\D/g, '')
    });
  }
});

// WA BUSINESS API WEBHOOK =====
// Enable once admin sets:
//   1. ai_assistant_enabled = true
//   2. ai_gemini_api_key or ai_openrouter_api_key
//   3. ai_assistant_phone_id + ai_assistant_access_token (from Meta Business Suite)
//   4. ai_assistant_verify_token (any random string, used to verify webhook URL)
//
// Verification: GET with ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
// Incoming messages: POST with { entry: [{ changes: [{ value: { messages: [...] } }] }] }

// Verify webhook (GET) - Meta requires echoing back the challenge
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = DB.settings.ai_assistant_verify_token || '';
  if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
    console.log('[wa-webhook] Verified successfully');
    return res.status(200).send(challenge);
  }
  console.log('[wa-webhook] Verification failed: mode=' + mode + ' tokenMatch=' + (token === expectedToken));
  res.status(403).send('Forbidden');
});

// Helper: send WA reply via Meta Graph API
async function sendWAReply(toPhone, text) {
  const phoneId = DB.settings.ai_assistant_phone_id;
  const token = DB.settings.ai_assistant_access_token;
  if (!phoneId || !token) throw new Error('WA Business API not configured');
  // Format: country code + number, no +, no spaces
  const formattedPhone = toPhone.replace(/\D/g, '');
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'text',
      text: { body: text }
    })
  }, 20000);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('WA send ' + r.status + ': ' + t.slice(0, 200));
  }
  return await r.json();
}

// Incoming messages (POST) - auto-reply via AI
app.post('/api/webhook/whatsapp', async (req, res) => {
  // Meta requires 200 OK within 5s or it retries
  res.status(200).send('OK');
  try {
    if (!DB.settings.ai_assistant_enabled) {
      console.log('[wa-webhook] AI disabled, ignoring incoming message');
      return;
    }
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const messages = change.value?.messages || [];
        const contacts = change.value?.contacts || [];
        for (const msg of messages) {
          if (msg.type !== 'text') continue;
          const fromPhone = msg.from;
          const userText = msg.text?.body || '';
          const senderName = contacts.find(c => c.wa_id === fromPhone)?.profile?.name || '';
          console.log('[wa-webhook] Incoming from ' + fromPhone + ': ' + userText.slice(0, 100));

          // Build history-aware context per sender
          const sessionId = 'wa-' + fromPhone;
          const priorHistory = (DB.settings.ai_assistant_conversations || [])
            .filter(c => c.session_id === sessionId)
            .slice(-6)
            .flatMap(c => [
              { role: 'user', content: c.user },
              { role: 'assistant', content: c.assistant }
            ]);
          const messages = [...priorHistory, { role: 'user', content: userText.slice(0, 1000) }];
          const systemPrompt = buildAISystemPrompt() +
            (senderName ? `\n\nCustomer ini bernama: ${senderName}` : '');
          const result = await callAIChat(systemPrompt, messages);

          // Reply via WA
          await sendWAReply(fromPhone, result.reply);

          // Log
          if (!Array.isArray(DB.settings.ai_assistant_conversations)) DB.settings.ai_assistant_conversations = [];
          DB.settings.ai_assistant_conversations.push({
            session_id: sessionId,
            channel: 'whatsapp',
            sender_name: senderName,
            from_phone: fromPhone,
            ts: new Date().toISOString(),
            user: userText,
            assistant: result.reply,
            provider: result.provider
          });
          if (DB.settings.ai_assistant_conversations.length > 200) {
            DB.settings.ai_assistant_conversations = DB.settings.ai_assistant_conversations.slice(-200);
          }
          save();
        }
      }
    }
  } catch (e) {
    console.error('[wa-webhook] Error:', e.message);
  }
});

// ADMIN: get AI conversation logs
app.get('/api/admin/ai/conversations', auth, (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 100);
  const channel = req.query.channel; // 'web' | 'whatsapp' | undefined
  let logs = DB.settings.ai_assistant_conversations || [];
  if (channel) logs = logs.filter(l => l.channel === channel);
  res.json(logs.slice(-limit).reverse());
});

// ADMIN: get AI config status (without leaking secrets)
app.get('/api/admin/ai/config', auth, (req, res) => {
  const s = DB.settings;
  res.json({
    enabled: !!s.ai_assistant_enabled,
    has_gemini: !!s.ai_gemini_api_key,
    has_openrouter: !!s.ai_openrouter_api_key,
    has_wa_phone_id: !!s.ai_assistant_phone_id,
    has_wa_token: !!s.ai_assistant_access_token,
    wa_verify_token: s.ai_assistant_verify_token || '',
    base_prompt: s.ai_assistant_base_prompt || '',
    conversation_count: (s.ai_assistant_conversations || []).length,
    webhook_url: '/api/webhook/whatsapp'
  });
});

// ADMIN: clear conversation logs
app.delete('/api/admin/ai/conversations', auth, (req, res) => {
  DB.settings.ai_assistant_conversations = [];
  save();
  res.json({ ok: true });
});

// Catch-all 404 — ditempatkan SETELAH semua route & static, SEBELUM
// error handler. Hanya jalan untuk request yang tidak cocok dengan
// route manapun. Untuk path /api/* kembalikan JSON 404; untuk halaman
// HTML sajikan public/404.html agar pengguna melihat halaman ramah
// (bukan "Cannot GET /..." default Express).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint tidak ditemukan' });
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const nf = path.join(__dirname, 'public', '404.html');
    if (fs.existsSync(nf)) return res.status(404).sendFile(nf);
  }
  res.status(404).send('404 Not Found');
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Ukuran file maksimal 5 MB'
      : 'File tidak didukung atau jumlah file berlebih';
    return res.status(400).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: 'Terjadi kesalahan pada server' });
});

