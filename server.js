// Adzkiya Mom Baby Care - Backend v2.1 (persistent via TiDB/MySQL)
// Features: multi-items, multi-slots, settings (logo/hero/QRIS/bank), charts, xlsx export, notifications, persistence
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const mysql = require('mysql2/promise');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'adzkiya-mom-baby-care-secret-key-2026';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---- DATA LAYER ----
// Use TiDB/MySQL when DATABASE_URL is set (production). Falls back to local data.json otherwise.
const DATA_FILE = path.join(__dirname, 'data.json');
let DB = {
  admins: [],
  reservations: [],
  receipts: [],
  settings: null,
  _seq: { admins: 0, reservations: 0, receipts: 0 }
};

let pool = null;
let usingMysql = false;
let saveTimer = null;
let savePromise = null;

async function initStorage() {
  if (DATABASE_URL) {
    pool = mysql.createPool(DATABASE_URL);
    // Single-row blob table — simple, atomic, idempotent for app size (small).
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INT PRIMARY KEY,
        data LONGTEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    const [rows] = await pool.execute('SELECT data FROM app_state WHERE id=1');
    if (rows.length) {
      try {
        DB = JSON.parse(rows[0].data);
        DB._seq = DB._seq || { admins: 0, reservations: 0, receipts: 0 };
        ['admins','reservations','receipts'].forEach(k => { DB[k] = DB[k] || []; });
        console.log(`[storage] Loaded from MySQL: ${DB.reservations.length} reservasi, ${DB.receipts.length} kwitansi`);
      } catch (e) { console.error('[storage] parse err', e); }
    } else {
      console.log('[storage] Fresh MySQL — seeding defaults');
    }
    usingMysql = true;
  } else {
    // Local dev fallback
    try {
      if (fs.existsSync(DATA_FILE)) {
        DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        DB._seq = DB._seq || { admins: 0, reservations: 0, receipts: 0 };
        ['admins','reservations','receipts'].forEach(k => { DB[k] = DB[k] || []; });
      }
    } catch (e) { console.error('load err', e); }
    console.log('[storage] Using local data.json (no DATABASE_URL)');
  }
}

function save() {
  // Debounce 200ms; writes a single LONGTEXT blob to the DB.
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const json = JSON.stringify(DB);
    if (usingMysql && pool) {
      try {
        savePromise = pool.execute(
          'INSERT INTO app_state (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)',
          [json]
        );
        await savePromise;
      } catch (e) { console.error('[storage] mysql save err', e.message); }
    } else {
      try { fs.writeFileSync(DATA_FILE, json); }
      catch (e) { console.error('save err', e); }
    }
  }, 200);
}

// Force-flush on shutdown
async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const json = JSON.stringify(DB);
  if (usingMysql && pool) {
    try {
      await pool.execute(
        'INSERT INTO app_state (id, data) VALUES (1, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)',
        [json]
      );
    } catch (e) { console.error('[flush] mysql err', e.message); }
  } else {
    try { fs.writeFileSync(DATA_FILE, json); } catch (e) {}
  }
}
process.on('SIGTERM', async () => { await flush(); process.exit(0); });
process.on('SIGINT',  async () => { await flush(); process.exit(0); });

function nextId(t) { DB._seq[t] = (DB._seq[t] || 0) + 1; return DB._seq[t]; }

function seedAdmin() {
  if (!DB.admins.find(a => a.email === 'admin@adzkiya.id')) {
    DB.admins.push({
      id: nextId('admins'),
      email: 'admin@adzkiya.id',
      password_hash: bcrypt.hashSync('admin123', 10),
      name: 'Tasya Hanifah',
      role: 'super',
      created_at: new Date().toISOString()
    });
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

// Async boot — load from MySQL/file, seed defaults, start server
(async () => {
  try {
    await initStorage();
    seedAdmin();
    seedSettings();
    ensureNewSettings();
    save();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Adzkiya Mom Baby Care v2.1 on 0.0.0.0:${PORT} (storage: ${usingMysql ? 'MySQL' : 'JSON file'})`);
    });
  } catch (e) {
    console.error('FATAL boot:', e);
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

// ---- MIDDLEWARE ----
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
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
    const required = ['patient_name','whatsapp','address','payment_method'];
    for (const f of required) if (!b[f]) return res.status(400).json({ error: 'Field ' + f + ' wajib diisi' });

    let items, slots;
    try { items = JSON.parse(b.items || '[]'); } catch { return res.status(400).json({ error: 'items invalid' }); }
    try { slots = JSON.parse(b.slots || '[]'); } catch { return res.status(400).json({ error: 'slots invalid' }); }
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Minimal pilih 1 layanan' });
    if (!Array.isArray(slots) || !slots.length) return res.status(400).json({ error: 'Minimal pilih 1 jadwal' });
    items = items.map(it => ({ name: String(it.name||'').slice(0, 200), price: parseInt(it.price)||0, qty: parseInt(it.qty)||1 }));
    slots = slots.map(s => ({ date: String(s.date||'').slice(0, 10), time: String(s.time||'').slice(0, 5) })).filter(s => s.date && s.time);
    if (!items.every(i => i.name && i.price > 0)) return res.status(400).json({ error: 'Layanan tidak valid' });
    if (!slots.length) return res.status(400).json({ error: 'Jadwal tidak valid' });

    const id = nextId('reservations');
    const itemSum = items.reduce((s, it) => s + it.price * it.qty, 0);
    const total = itemSum * slots.length;

    const rec = {
      id,
      patient_name: b.patient_name,
      whatsapp: b.whatsapp,
      address: b.address,
      items,
      slots,
      item_total: itemSum,
      total,
      // Backward-compat first-slot/first-item summary fields
      service_name: items.map(i => i.name).join(', '),
      service_price: itemSum,
      qty: slots.length,
      reservation_date: slots[0].date,
      reservation_time: slots[0].time,
      payment_method: b.payment_method,
      proof_mime: req.file ? req.file.mimetype : null,
      proof_b64: req.file ? req.file.buffer.toString('base64') : null,
      notes: b.notes || '',
      status: 'pending',
      payment_status: 'unpaid',
      created_at: new Date().toISOString()
    };
    DB.reservations.push(rec);
    save();
    res.json({ ok: true, id, total });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
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

app.get('/api/proof/:id', (req, res) => {
  const r = DB.reservations.find(x => x.id === parseInt(req.params.id));
  if (!r || !r.proof_b64) return res.status(404).send('No proof');
  res.setHeader('Content-Type', r.proof_mime || 'application/octet-stream');
  res.send(Buffer.from(r.proof_b64, 'base64'));
});

// ===== AUTH =====
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const admin = DB.admins.find(a => a.email === email);
  if (!admin) return res.status(401).json({ error: 'Email tidak ditemukan' });
  if (!bcrypt.compareSync(password, admin.password_hash)) return res.status(401).json({ error: 'Password salah' });
  const token = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET, { expiresIn: '7d' });
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
app.get('/api/admin/recap.xlsx', async (req, res) => {
  try {
    // Allow token in query for download
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).send('Unauthorized'); }
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
  const kind = req.body.kind; // 'logo' | 'hero' | 'qris'
  if (!['logo', 'hero', 'qris'].includes(kind)) return res.status(400).json({ error: 'kind invalid' });
  if (!req.file) return res.status(400).json({ error: 'file missing' });
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

app.post('/api/admin/restore', auth, (req, res) => {
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

