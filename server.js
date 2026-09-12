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
  settings: null,
  _seq: { admins: 0, reservations: 0, receipts: 0 }
};

let pool = null;
let saveTimer = null;
let saveChain = Promise.resolve();

function normalizeState() {
  DB._seq = DB._seq || { admins: 0, reservations: 0, receipts: 0 };
  ['admins', 'reservations', 'receipts'].forEach((key) => { DB[key] = DB[key] || []; });
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
}

// Async boot — load persistent state, seed defaults, then start the API.
(async () => {
  try {
    await initStorage();
    seedAdmin();
    seedSettings();
    ensureNewSettings();
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
// Serve the frontend from public/ (single-host deployment). If a docs/
// directory exists (e.g. from `npm run build:pages`), it is also served
// as a fallback for any file public/ doesn't have, so the GitHub Pages
// build can be dropped into the same image.
// Cache static assets for 1 day at the CDN/browser, but never cache
// index.html (so deploys take effect immediately) or any /api path.
const staticOptions = {
  maxAge: '1d',
  setHeaders: (res, path) => {
    if (path.endsWith('.html') || path.endsWith('/')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
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
    socials: socialsPublic
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
      const when = new Date(`${s.date}T${s.time}:00`);
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
app.get('/api/admin/recap', auth, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = DB.reservations.filter(r => (r.reservation_date || '').slice(0, 7) === month)
    .sort((a, b) => a.reservation_date.localeCompare(b.reservation_date))
    .map(publicReservation);
  const totalReservasi = rows.length;
  const totalOmzet = rows.filter(r => r.payment_status === 'lunas')
    .reduce((s, r) => s + r.total, 0);
  // Count receipts whose EITHER created_at OR service_date falls in
  // this month. This matches the filter used by /api/admin/receipts so
  // the stat card and the receipts table stay consistent.
  const totalKwitansi = DB.receipts.filter(k =>
    (k.created_at && k.created_at.slice(0, 7) === month) ||
    (k.service_date && k.service_date.slice(0, 7) === month)
  ).length;
  res.json({ month, totalReservasi, totalOmzet, totalKwitansi, rows });
});

// XLSX export — professional formatting
app.get('/api/admin/recap.xlsx', auth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const monthRows = DB.reservations.filter(r => (r.reservation_date || '').slice(0, 7) === month)
      .sort((a, b) => a.reservation_date.localeCompare(b.reservation_date));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Adzkiya Mom Baby Care';
    wb.created = new Date();

    const ws = wb.addWorksheet('Rekap ' + month, {
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
      views: [{ showGridLines: false }]
    });

    // Header banner
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

    // Summary box
    const totalReservasi = monthRows.length;
    const totalOmzet = monthRows.filter(r => r.payment_status === 'lunas').reduce((s, r) => s + calcReservationTotal(r), 0);
    const totalKw = DB.receipts.filter(k => (k.created_at || '').slice(0, 7) === month).length;
    const pendingCnt = monthRows.filter(r => r.status === 'pending').length;
    const approvedCnt = monthRows.filter(r => r.status === 'approved').length;
    const lunasCnt = monthRows.filter(r => r.payment_status === 'lunas').length;

    const summaryRows = [
      ['Total Reservasi', totalReservasi, '', 'Total Omzet', { v: totalOmzet, t: 'rp' }],
      ['Total Kwitansi', totalKw, '', 'Status Pending', pendingCnt],
      ['Approved', approvedCnt, '', 'Lunas', lunasCnt]
    ];
    let rNum = 6;
    summaryRows.forEach(row => {
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

    // Table header
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

    // Data rows
    monthRows.forEach((r, idx) => {
      const items = r.items || [{ name: r.service_name, price: r.service_price, qty: r.qty }];
      const slots = r.slots || [{ date: r.reservation_date, time: r.reservation_time }];
      const itemsText = items.map(it => `• ${it.name} (×${it.qty}) — Rp${(it.price * it.qty).toLocaleString('id-ID')}`).join('\n');
      const slotsCount = slots.length;
      const total = calcReservationTotal(r);
      const dateText = slots.map(s => s.date).join('\n');
      const timeText = slots.map(s => s.time).join('\n');
      const row = ws.addRow([
        idx + 1, dateText, timeText, r.patient_name, r.whatsapp,
        itemsText, slotsCount, total, `${r.status} / ${r.payment_status}`
      ]);
      row.alignment = { vertical: 'top', wrapText: true };
      row.getCell(8).numFmt = '"Rp"#,##0';
      row.getCell(8).font = { bold: true };
      row.getCell(9).alignment = { ...row.alignment, horizontal: 'center' };
      // Status color
      const statusFill = r.payment_status === 'lunas' ? 'FFD9EFE1' : r.status === 'pending' ? 'FFFFF3D6' : 'FFFDE0E4';
      row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusFill } };
      // Zebra
      if (idx % 2 === 0) {
        for (let c = 1; c <= 9; c++) {
          const cell = row.getCell(c);
          if (!cell.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F8' } };
        }
      }
      row.eachCell(c => {
        c.border = { bottom: { style: 'thin', color: { argb: 'FFFFE0E8' } } };
      });
      // Auto-height by text
      const maxLines = Math.max(itemsText.split('\n').length, dateText.split('\n').length);
      row.height = Math.max(20, maxLines * 16);
    });

    // Total row
    const totalRow = ws.addRow(['', '', '', '', '', 'TOTAL OMZET', '', totalOmzet, '']);
    totalRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    for (let c = 1; c <= 9; c++) {
      totalRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE5A8A' } };
      totalRow.getCell(c).border = { top: { style: 'thick', color: { argb: 'FFEE5A8A' } } };
    }
    totalRow.getCell(8).numFmt = '"Rp"#,##0';
    totalRow.getCell(6).alignment = { horizontal: 'right' };
    totalRow.height = 26;

    // Column widths
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 14;
    ws.getColumn(3).width = 10;
    ws.getColumn(4).width = 22;
    ws.getColumn(5).width = 16;
    ws.getColumn(6).width = 45;
    ws.getColumn(7).width = 8;
    ws.getColumn(8).width = 16;
    ws.getColumn(9).width = 18;

    // Freeze
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: headerRow, showGridLines: false }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rekap-adzkiya-${month}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});

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
  // Don't return the giant base64 blobs — use flags + endpoints
  const { logo_b64, hero_b64, qris_b64, ...rest } = s;
  res.json({ ...rest, has_logo: !!logo_b64, has_hero: !!hero_b64, has_qris: !!qris_b64 });
});

app.put('/api/admin/settings', auth, (req, res) => {
  DB.settings = { ...DB.settings, ...req.body };
  save();
  res.json({ ok: true });
});

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

app.delete('/api/admin/settings/:kind', auth, (req, res) => {
  const k = req.params.kind;
  if (!['logo', 'hero', 'qris'].includes(k)) return res.status(400).json({ error: 'kind invalid' });
  DB.settings[`${k}_b64`] = null;
  DB.settings[`${k}_mime`] = null;
  save();
  res.json({ ok: true });
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

// ===== ADMIN — BACKUP / RESTORE =====
app.get('/api/admin/backup', auth, (req, res) => {
  res.json({
    exported_at: new Date().toISOString(),
    reservations: DB.reservations.map(r => { const { proof_b64, ...rest } = r; return rest; }),
    receipts: DB.receipts,
    settings: DB.settings
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

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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

