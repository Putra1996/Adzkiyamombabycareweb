// Adzkiya Mom Baby Care - Backend v2.2
// Split deployment: GitHub Pages frontend + Express API + PostgreSQL/MySQL persistence.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');
const { Pool: PostgresPool } = require('pg');

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
// Production supports PostgreSQL (Render) and MySQL/TiDB. Local development uses JSON.
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
    pool = new PostgresPool({
      connectionString: DATABASE_URL,
      ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const result = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (result.rows.length) DB = result.rows[0].data;
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
    // AI Booking Assistant (Fase 3) - WA Business API + Gemini/OpenRouter
    ai_assistant_enabled: false,
    ai_gemini_api_key: '',
    ai_openrouter_api_key: '',
    ai_assistant_phone_id: '',         // WhatsApp Business API phone_number_id
    ai_assistant_access_token: '',     // WA Business API access token (server-side stored)
    ai_assistant_verify_token: '',    // WA webhook verify token
    ai_assistant_base_prompt: '',     // custom instructions for the AI persona
    ai_assistant_conversations: [],   // log of recent chats (max 200)
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
  // AI Assistant defaults (Phase 3)
  if (typeof DB.settings.ai_assistant_enabled !== 'boolean') DB.settings.ai_assistant_enabled = false;
  if (typeof DB.settings.ai_gemini_api_key !== 'string') DB.settings.ai_gemini_api_key = '';
  if (typeof DB.settings.ai_openrouter_api_key !== 'string') DB.settings.ai_openrouter_api_key = '';
  if (typeof DB.settings.ai_assistant_phone_id !== 'string') DB.settings.ai_assistant_phone_id = '';
  if (typeof DB.settings.ai_assistant_access_token !== 'string') DB.settings.ai_assistant_access_token = '';
  if (typeof DB.settings.ai_assistant_verify_token !== 'string') DB.settings.ai_assistant_verify_token = '';
  if (typeof DB.settings.ai_assistant_base_prompt !== 'string') DB.settings.ai_assistant_base_prompt = '';
  if (!Array.isArray(DB.settings.ai_assistant_conversations)) DB.settings.ai_assistant_conversations = [];
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
      console.log(`Adzkiya Mom Baby Care v2.2 on 0.0.0.0:${PORT} (storage: ${DATABASE_KIND})`);
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

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://putra1996.github.io')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
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
  next();
});

const standardJsonParser = express.json({ limit: '2mb' });
const restoreJsonParser = express.json({ limit: '24mb' });
app.use((req, res, next) => {
  if (req.path === '/api/admin/restore') return next();
  standardJsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ===== PUBLIC =====
app.get('/health', (req, res) => res.json({ ok: true, storage: DATABASE_KIND }));
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
    socials: (s.socials || []).filter(x => x && x.url)
  });
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
app.post('/api/auth/login', (req, res) => {
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
  const totalKwitansi = DB.receipts.filter(k => (k.created_at || '').slice(0, 7) === month).length;
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
  const { patient_name, whatsapp, address, service_date, items, transport_fee, discount } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Items kosong' });
  const subtotal = items.reduce((s, it) => s + (it.price * it.qty), 0);
  const total = subtotal + (parseInt(transport_fee) || 0) - (parseInt(discount) || 0);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const count = DB.receipts.filter(k => (k.invoice_no || '').slice(4, 12) === today).length;
  const invoice_no = `INV-${today}-${String(count + 1).padStart(3, '0')}`;
  const id = nextId('receipts');
  DB.receipts.push({
    id, invoice_no, patient_name, whatsapp, address, service_date,
    items, transport_fee: parseInt(transport_fee) || 0,
    discount: parseInt(discount) || 0, subtotal, total,
    created_at: new Date().toISOString()
  });
  save();
  res.json({ ok: true, invoice_no, subtotal, total });
});

app.get('/api/admin/receipts', auth, (req, res) => {
  res.json(DB.receipts.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200));
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

// ===== ADMIN — SETTINGS =====
app.get('/api/admin/settings', auth, (req, res) => {
  const s = DB.settings || {};
  // Don't return giant base64 blobs or AI secrets — use flags + dedicated endpoints.
  // The admin UI gets has_X flags and a separate GET /api/admin/ai/config
  // for AI status (without leaking keys).
  const {
    logo_b64, hero_b64, qris_b64,
    ai_gemini_api_key, ai_openrouter_api_key,
    ai_assistant_access_token,
    ...rest
  } = s;
  res.json({
    ...rest,
    has_logo: !!logo_b64, has_hero: !!hero_b64, has_qris: !!qris_b64,
    has_ai_gemini: !!ai_gemini_api_key,
    has_ai_openrouter: !!ai_openrouter_api_key,
    has_ai_wa_token: !!ai_assistant_access_token
  });
});

app.put('/api/admin/settings', auth, (req, res) => {
  const body = { ...req.body };
  // Don't overwrite AI secret keys with empty strings — admin might leave
  // them blank when editing other settings. Only overwrite if explicitly
  // sent with a non-empty value.
  ['ai_gemini_api_key', 'ai_openrouter_api_key', 'ai_assistant_access_token'].forEach(k => {
    if (body[k] === '' || body[k] === null) delete body[k];
  });
  DB.settings = { ...DB.settings, ...body };
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
  const { reservations = [], receipts = [], settings, mode = 'append' } = req.body;
  if (mode === 'replace') {
    DB.reservations = []; DB.receipts = [];
    DB._seq.reservations = 0; DB._seq.receipts = 0;
  }
  for (const r of reservations) DB.reservations.push({ ...r, id: nextId('reservations') });
  for (const k of receipts) {
    if (DB.receipts.find(x => x.invoice_no === k.invoice_no)) continue;
    DB.receipts.push({ ...k, id: nextId('receipts') });
  }
  if (settings && mode === 'replace') DB.settings = settings;
  save();
  res.json({ ok: true, imported: { reservations: reservations.length, receipts: receipts.length } });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));


// ===== AI BOOKING ASSISTANT =====
// Dual-provider design: Gemini first (free tier available, fast),
// fallback to OpenRouter if Gemini fails (or is not configured).
// Used by:
//   1. The chat widget on the public landing page
//   2. The WhatsApp Business API webhook (auto-reply)
//
// The AI persona is "Adzkiya Assistant" — friendly Indonesian-speaking
// helper that knows the service catalog, hours, and address. It can
// help customers pick a service, suggest time slots, and pre-fill the
// reservation form. It NEVER takes payment — it generates a deep-link
// to WhatsApp for the customer to finalize with a human.

const AI_DEFAULT_PERSONA = `Kamu adalah Adzkiya Assistant, customer service AI untuk klinik home-service Adzkiya Mom Baby Care di Cilacap.\n\nTugas kamu:\n1. Menyapa customer dengan hangat dalam Bahasa Indonesia\n2. Membantu memilih layanan yang sesuai dari katalog\n3. Memberi info harga, jam operasional, dan area layanan\n4. Membantu booking: tanyakan tanggal & jam yang diinginkan, lalu arahkan customer untuk konfirmasi via WhatsApp ke admin\n\nAturan penting:\n- Jawab singkat (max 3-4 kalimat per pesan)\n- Gunakan emoji secukupnya (🌸 untuk sapaan, ✅ untuk konfirmasi)\n- SELALU akhiri dengan pertanyaan untuk lanjutkan percakapan\n- JANGAN sebut harga detail kecuali customer tanya\n- JANGAN janjikan booking tanpa admin confirmation\n- Untuk finalisasi booking, arahkan ke WhatsApp admin`;

function buildAISystemPrompt() {
  const s = DB.settings || {};
  const servicesList = SERVICES.map(cat => {
    const items = cat.items.map(i => `- ${i.name}: Rp${i.price.toLocaleString('id-ID')}`).join('\\n');
    return `${cat.cat}:\\n${items}`;
  }).join('\\n\\n');
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
    `- Customer sudah memilih untuk chat dengan AI, jadi layani dengan ramah\n- Jika customer minta booking, kumpulkan: nama layanan, tanggal (YYYY-MM-DD), jam (HH:MM), nama customer, WhatsApp, alamat.\n- Setelah dapat semua info, balas dengan ringkasan + link WhatsApp: https://wa.me/${(s.phone || '6285887018194').replace(/[^\\d]/g, '')}?text=<encoded message>\n- JANGAN mengarang harga custom. Pakai harga dari katalog di atas.\n- JANGAN menerima pembayaran. Booking selalu difinalkan via WhatsApp admin.`,
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
    })
  });
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
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
  });
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
        fallback_wa: 'https://wa.me/' + (DB.settings.phone || '6285887018194').replace(/[^\\d]/g, '')
      });
    }
    if (!DB.settings.ai_gemini_api_key && !DB.settings.ai_openrouter_api_key) {
      return res.status(503).json({
        error: 'AI provider belum dikonfigurasi. Hubungi admin via WhatsApp.',
        fallback_wa: 'https://wa.me/' + (DB.settings.phone || '6285887018194').replace(/[^\\d]/g, '')
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
      fallback_wa: 'https://wa.me/' + (DB.settings.phone || '6285887018194').replace(/[^\\d]/g, '')
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
  const formattedPhone = toPhone.replace(/[^\\d]/g, '');
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const r = await fetch(url, {
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
  });
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

