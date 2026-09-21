// Adzkiya Mom Baby Care - Backend v2.2
// Single-host deployment: Express serves both the public/admin frontend
// (from public/ or docs/) and the API (/api/*), backed by PostgreSQL
// (Neon) or MySQL. Same-origin, so no CORS, no separate API hostname.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
// Modul crypto di-require eksplisit: Node >=19 punya global `crypto`
// versi Web Crypto yang TIDAK punya randomBytes/createCipheriv.
const crypto = require('crypto');
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
async function fetchWithTimeout(url, options, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Bila pemanggil ingin membatalkan (mis. provider lain sudah menjawab
  // lebih dulu), batalkan request ini juga supaya tidak ada kuota terbuang.
  const onAbort = () => { try { controller.abort(); } catch { /* sudah selesai */ } };
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) { try { externalSignal.removeEventListener('abort', onAbort); } catch {} }
  }
}

// ---- TANGGAL ZONA WIB (Asia/Jakarta) ----
// Railway (dan hampir semua container) berjalan dengan TZ=UTC, sedangkan
// bisnis ini ada di Cilacap (WIB, UTC+7). Semua tanggal/bulan yang
// bersifat bisnis (nomor invoice, default bulan Rekap, bucket grafik,
// lastmod sitemap) HARUS memakai kalender WIB. Tanpa helper ini:
//   • invoice yang dibuat pukul 00:00–06:59 WIB memakai tanggal kemarin
//     (mis. INV-20260919-001 padahal sudah 20 September)
//   • grafik 14 hari kehilangan bucket "hari ini"
//   • pada tanggal 1 pukul 00:00–06:59 WIB, Rekap & P&L default ke bulan lalu
const JAKARTA_TZ = 'Asia/Jakarta';
let _jakartaDateFmt = null;
function jakartaDateStr(date) {
  const d = date || new Date();
  try {
    if (!_jakartaDateFmt) {
      _jakartaDateFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: JAKARTA_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
      });
    }
    // en-CA → YYYY-MM-DD
    return _jakartaDateFmt.format(d);
  } catch (e) {
    // Fallback: kalau ICU/runtime tidak mendukung timeZone, pakai offset
    // tetap +7 jam dari UTC (Indonesia tidak memakai DST).
    return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }
}
function todayJakarta() { return jakartaDateStr(new Date()); }
function monthJakarta(date) { return jakartaDateStr(date).slice(0, 7); }
// Geser string tanggal 'YYYY-MM-DD' sebanyak delta hari. Aritmetika
// memakai UTC supaya bebas DST/perubahan zona.
function shiftDateStr(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  const base = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}
// Geser string bulan 'YYYY-MM' sebanyak deltaMonths.
function shiftMonthStr(monthStr, deltaMonths) {
  const [y, m] = String(monthStr || '').split('-').map(Number);
  const base = new Date(Date.UTC(y || 1970, (m || 1) - 1 + deltaMonths, 1));
  return base.toISOString().slice(0, 7);
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION) app.set('trust proxy', 1);
const JWT_SECRET = process.env.JWT_SECRET || 'adzkiya_local_development_secret';
// .trim(): nilai env yang di-paste dari dashboard sering membawa
// spasi/newline tak terlihat, yang membuat deteksi jenis DB gagal.
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const DATABASE_KIND = DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://')
  ? 'postgres'
  : (DATABASE_URL ? 'mysql' : 'file');

if (IS_PRODUCTION && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET production wajib diisi minimal 32 karakter');
}

// ---- DATA LAYER ----
// Production supports PostgreSQL (Neon, Railway Postgres, etc.) and MySQL/TiDB.
// Local development uses JSON.
// Lokasi file state saat storage = file.
//
// PENTING untuk keamanan data: container Railway bersifat ephemeral —
// file di dalamnya hilang setiap deploy. Kalau Railway Volume dipasang
// (Railway otomatis menyuntikkan RAILWAY_VOLUME_MOUNT_PATH), kita pakai
// volume itu supaya data file-mode IKUT SELAMAT antar deploy. Tanpa
// volume, kita beri tanda "tidak persisten" agar UI bisa memperingatkan
// dengan tepat.
function detectDataFile() {
  const explicit = (process.env.DATA_FILE || '').trim();
  if (explicit) {
    // Path di luar folder aplikasi (mis. /data/...) dianggap persisten.
    const persistent = path.isAbsolute(explicit) && !explicit.startsWith(__dirname);
    return { file: explicit, source: 'DATA_FILE env', persistent };
  }
  const volumePath = (process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.RAILWAY_VOLUME_MOUNT_DIR || '').trim();
  if (volumePath) {
    const dir = volumePath.replace(/\/+$/, '');
    return { file: path.join(dir, 'adzkiya-state.json'), source: 'Railway volume (' + dir + ')', persistent: true };
  }
  return { file: path.join(__dirname, 'data.json'), source: 'filesystem container', persistent: false };
}
const DATA_FILE_INFO = detectDataFile();
const DATA_FILE = DATA_FILE_INFO.file;
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
// Pesan error terakhir saat mencoba connect ke DB (disanitasi — tanpa
// URL/kredensial). Ditampilkan di /health supaya kasus "DATABASE_URL
// ada tapi gagal connect" bisa didiagnosa tanpa buka log Railway.
let dbConnectError = null;
function sanitizeDbError(err) {
  // Pesan ini muncul di /health (dapat diakses publik) — jangan sampai
  // membocorkan host, kredensial, nama user, atau nama database internal.
  return redactSecrets((err && err.message) || err || 'unknown');
}
let saveTimer = null;
let saveChain = Promise.resolve();

function normalizeStateObject(state) {
  const out = state && typeof state === 'object' ? state : {};
  out._seq = out._seq || { admins: 0, reservations: 0, receipts: 0, broadcasts: 0, expenses: 0 };
  ['admins', 'reservations', 'receipts', 'broadcasts', 'expenses'].forEach((key) => { out[key] = Array.isArray(out[key]) ? out[key] : []; });
  // share_tokens is the persistent mirror of shareTokenMap. Older
  // data.json files won't have this key — initialize to {}.
  out.share_tokens = out.share_tokens && typeof out.share_tokens === 'object' ? out.share_tokens : {};
  out.settings = out.settings && typeof out.settings === 'object' ? out.settings : null;
  return out;
}
function normalizeState() {
  normalizeStateObject(DB);
}

// ---- Deteksi & pemulihan koneksi database ----
// Kondisi yang ditangani: server boot SAAT database tidak bisa dihubungi
// (password Neon berubah, kuota habis, jaringan putus). Selama itu semua
// tulisan hanya masuk file container — hilang setiap deploy. Dua hal yang
// dilakukan di sini:
//   1) probe berkala (1 menit) supaya status "database sudah bisa
//      dihubungi lagi" diketahui tanpa redeploy,
//   2) endpoint admin untuk MENGGABUNG data darurat ke database, karena
//      berpindah storage otomatis akan membuang data salah satu sisi.
let dbReachable = null; // null = belum pernah diprobe
let dbProbeTimer = null;
// Connection string yang di-APPLY dari panel admin. Dipakai saat DATABASE_URL
// env masih salah/tidak bisa dihubungi — supaya admin bisa memperbaiki,
// menguji, memindahkan data, dan memverifikasi tanpa harus deploy berkali-kali.
// Nilai ini HANYA ada di memori proses (tidak pernah ditulis ke disk/log/
// respons) dan hilang saat redeploy — karena itu UI tetap menyuruh admin
// menyalinnya ke Railway → Variables. Kalau env sudah benar, env dipakai.
let runtimeDatabaseUrl = null;
let runtimeDatabaseKind = null;
function activeDatabaseUrl() { return runtimeDatabaseUrl || DATABASE_URL; }
function activeDatabaseKind() { return runtimeDatabaseKind || DATABASE_KIND; }

async function probeDatabase() {
  if (activeDatabaseKind() === 'file') return { ok: false, error: 'DATABASE_URL belum diset (mode file)' };
  if (activeDatabaseKind() === 'postgres') {
    let testPool = null;
    try {
      testPool = new PostgresPool({
        connectionString: activeDatabaseUrl(),
        ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
        max: 1,
        connectionTimeoutMillis: 8000
      });
      await testPool.query('SELECT 1');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: sanitizeDbError(e) };
    } finally {
      if (testPool) { try { await testPool.end(); } catch {} }
    }
  }
  if (activeDatabaseKind() === 'mysql') {
    let conn = null;
    try {
      conn = await mysql.createConnection(activeDatabaseUrl());
      await conn.query('SELECT 1');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: sanitizeDbError(e) };
    } finally {
      if (conn) { try { await conn.end(); } catch {} }
    }
  }
  return { ok: false, error: 'Jenis database tidak dikenali' };
}

// Buka pool permanen + pastikan tabel app_state ada + baca state yang
// tersimpan. Dipakai saat admin menyinkronkan data darurat ke database.
async function openDbPoolAndReadState(connStr, kindOverride) {
  const kind = kindOverride || activeDatabaseKind();
  const conn = connStr || activeDatabaseUrl();
  if (kind === 'postgres') {
    const newPool = new PostgresPool({
      connectionString: conn,
      ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    await newPool.query('SELECT 1');
    await newPool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const result = await newPool.query('SELECT data FROM app_state WHERE id = 1');
    return { pool: newPool, state: result.rows.length ? result.rows[0].data : null };
  }
  if (kind === 'mysql') {
    const newPool = mysql.createPool(conn);
    await newPool.execute(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INT PRIMARY KEY,
        data LONGTEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    const [rows] = await newPool.execute('SELECT data FROM app_state WHERE id = 1');
    let state = null;
    if (rows.length) {
      try { state = JSON.parse(rows[0].data); } catch { state = null; }
    }
    return { pool: newPool, state };
  }
  return { pool: null, state: null };
}

// Gabungkan data transaksional dari state "darurat" (file) ke state
// database. SENGAJA tidak menyalin `settings`: state darurat dimulai dari
// pengaturan bawaan saat boot, jadi menyalinnya bisa menimpa pengaturan
// usaha yang sudah benar di database (nama, rekening, TTD, dsb).
function mergeTransactionalState(dbStateInput, liveStateInput) {
  const target = normalizeStateObject(JSON.parse(JSON.stringify(dbStateInput || {})));
  const live = normalizeStateObject(JSON.parse(JSON.stringify(liveStateInput || {})));
  const report = {
    reservations_added: 0, receipts_added: 0, expenses_added: 0,
    broadcasts_added: 0, expense_categories_copied: false, admins_added: 0,
    db_before: {
      reservations: target.reservations.length,
      receipts: target.receipts.length,
      expenses: target.expenses.length
    },
    live: {
      reservations: live.reservations.length,
      receipts: live.receipts.length,
      expenses: live.expenses.length
    }
  };

  // Kwitansi: kunci unik = invoice_no (kalau kosong pakai nama+tanggal).
  const receiptKey = (k) => (k.invoice_no ? 'inv:' + k.invoice_no : 'nm:' + (k.patient_name || '') + '|' + (k.service_date || ''));
  const receiptKeys = new Set(target.receipts.map(receiptKey));
  for (const k of live.receipts) {
    const key = receiptKey(k);
    if (receiptKeys.has(key)) continue;
    receiptKeys.add(key);
    target.receipts.push(k);
    report.receipts_added++;
  }

  // Reservasi: dedupe sama seperti /api/admin/restore (nama + tanggal +
  // total dalam toleransi 1 rupiah).
  const resKey = (r) => (r.patient_name || '') + '|' + (r.reservation_date || '') + '|' + Math.round(r.total || 0);
  const resKeys = new Set(target.reservations.map(resKey));
  for (const r of live.reservations) {
    const key = resKey(r);
    if (resKeys.has(key)) continue;
    resKeys.add(key);
    target.reservations.push(r);
    report.reservations_added++;
  }

  // Pengeluaran: dedupe tanggal + kategori + jumlah + keterangan.
  const expKey = (e) => (e.date || '') + '|' + (e.category || '') + '|' + (e.amount || 0) + '|' + (e.description || '');
  const expKeys = new Set(target.expenses.map(expKey));
  for (const e of live.expenses) {
    const key = expKey(e);
    if (expKeys.has(key)) continue;
    expKeys.add(key);
    target.expenses.push(e);
    report.expenses_added++;
  }

  // Broadcast: riwayat kampanye WhatsApp.
  const bcKey = (b) => (b.created_at || '') + '|' + (b.name || '') + '|' + (b.recipient_count || 0);
  const bcKeys = new Set(target.broadcasts.map(bcKey));
  for (const b of live.broadcasts) {
    const key = bcKey(b);
    if (bcKeys.has(key)) continue;
    bcKeys.add(key);
    target.broadcasts.push(b);
    report.broadcasts_added++;
  }

  // Kategori pengeluaran & token kwitansi: hanya disalin kalau database
  // belum punya (tidak menimpa apa pun).
  if ((!target.expense_categories || !target.expense_categories.length) && live.expense_categories && live.expense_categories.length) {
    target.expense_categories = live.expense_categories;
    report.expense_categories_copied = true;
  }
  for (const [tok, val] of Object.entries(live.share_tokens || {})) {
    if (!target.share_tokens[tok]) target.share_tokens[tok] = val;
  }

  // AKUN ADMIN — kritis.
  // Database yang masih baru/kosong (mis. Neon yang baru dibuat) tidak
  // punya akun admin sama sekali. Kalau kita pindah ke database itu tanpa
  // menyalin akun dari state darurat, admin yang sedang bekerja langsung
  // TERKUNCI dan tidak bisa login lagi. Jadi:
  //   • akun yang sudah ada di database dipertahankan apa adanya
  //     (versinya paling baru, termasuk hash password terakhir),
  //   • akun yang hanya ada di state darurat ikut disalin (dedupe per email).
  const adminEmails = new Set(target.admins.map((a) => String(a && a.email || '').toLowerCase()));
  for (const a of live.admins) {
    const email = String(a && a.email || '').toLowerCase();
    if (!email || adminEmails.has(email)) continue;
    target.admins.push(a);
    adminEmails.add(email);
    report.admins_added = (report.admins_added || 0) + 1;
  }

  // Perbaiki penomoran supaya ID berikutnya tidak bertabrakan.
  const maxId = (arr) => arr.reduce((m, x) => Math.max(m, x && x.id ? x.id : 0), 0);
  const liveSeq = live._seq || {};
  target._seq.reservations = Math.max(target._seq.reservations || 0, liveSeq.reservations || 0, maxId(target.reservations));
  target._seq.receipts = Math.max(target._seq.receipts || 0, liveSeq.receipts || 0, maxId(target.receipts));
  target._seq.expenses = Math.max(target._seq.expenses || 0, liveSeq.expenses || 0, maxId(target.expenses));
  target._seq.broadcasts = Math.max(target._seq.broadcasts || 0, liveSeq.broadcasts || 0, maxId(target.broadcasts));
  target._seq.admins = Math.max(target._seq.admins || 0, liveSeq.admins || 0, maxId(target.admins));

  report.db_after = {
    reservations: target.reservations.length,
    receipts: target.receipts.length,
    expenses: target.expenses.length
  };
  return { state: target, report };
}

// Probe berkala: kalau database kembali bisa dihubungi, catat di status
// (tidak otomatis memindahkan penyimpanan — lihat catatan di atas).
function startDbRetryLoop() {
  if (dbProbeTimer) return;
  dbProbeTimer = setInterval(async () => {
    if (pool || activeDatabaseKind() === 'file') return;
    const before = dbConnectError;
    const result = await probeDatabase();
    dbReachable = result.ok;
    dbConnectError = result.ok ? null : result.error;
    if (result.ok && before) {
      console.log('[storage] ✅ Database kembali dapat dihubungi. Data darurat belum dipindahkan — gunakan Pengaturan → Status Penyimpanan → Sinkronkan.');
    }
  }, 60 * 1000);
  if (dbProbeTimer.unref) dbProbeTimer.unref();
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
      console.error('[storage] Postgres unreachable, falling back to file mode: ' + sanitizeDbError(err));
      console.error('[storage] ⚠️  Data yang ditulis sekarang HANYA masuk file sementara — perbaiki DATABASE_URL / Neon lalu redeploy.');
      dbConnectError = sanitizeDbError(err);
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
  // Peringatan keras: di production, storage 'file' berarti seluruh data
  // (reservasi, kwitansi, pengaturan, TTD pemilik) HANYA tersimpan di
  // filesystem container — hilang setiap redeploy/rebuild di Railway.
  // Set DATABASE_URL (Postgres/MySQL) atau mount volume agar data aman.
  if (IS_PRODUCTION && DATABASE_KIND === 'file') {
    if (DATA_FILE_INFO.persistent) {
      console.warn('[storage] File storage PERSISTEN (' + DATA_FILE_INFO.source + ') — data tetap ada antar deploy.');
      console.warn('[storage] Disarankan tetap set DATABASE_URL agar data terkelola dan bisa dipulihkan otomatis.');
    } else {
      console.warn('[storage] ⚠️  PERINGATAN: DATABASE_URL belum diset — data disimpan di file');
      console.warn('[storage] ⚠️  File ini ikut ter-reset setiap deploy. Set DATABASE_URL, atau pasang Railway Volume lalu set DATA_FILE ke dalam volume itu.');
    }
  }
  if (IS_PRODUCTION && DATABASE_KIND !== 'file' && !pool) {
    console.warn(`[storage] ⚠️  DATABASE_URL (${DATABASE_KIND}) tidak bisa dihubungi saat boot — sementara pakai file.`);
    if (dbConnectError) console.warn(`[storage] ⚠️  Penyebab: ${dbConnectError}`);
  }
  // Cek ulang tiap menit: outage sesaat tidak perlu redeploy manual.
  if (DATABASE_KIND !== 'file' && !pool) startDbRetryLoop();
}

async function persistSnapshot(json) {
  // activeDatabaseKind() — bukan DATABASE_KIND — supaya tulisan mengikuti
  // koneksi yang sedang dipakai (termasuk koneksi yang dipasang dari panel).
  const kind = activeDatabaseKind();
  if (kind === 'postgres' && pool) {
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
      [json]
    );
  } else if (kind === 'mysql' && pool) {
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
    .catch((error) => console.error(`[storage] ${activeDatabaseKind()} save gagal:`, error.message));
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
  if (existing) {
    const rounds = parseInt(String(existing.password_hash || '').split('$')[2], 10) || 0;
    if (rounds > 0 && rounds < 12) {
      console.warn(`[auth] ⚠️  Hash password admin memakai bcrypt cost ${rounds} (disarankan 12). ` +
        'Akan otomatis di-upgrade saat login berhasil — atau ganti password sekarang.');
    }
    if (!existing.password_changed_at) {
      console.warn('[auth] ⚠️  Password admin belum pernah diganti sejak dibuat. Ganti lewat menu Pengaturan → Profil.');
    }
  }
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
      console.log(`Adzkiya Mom Baby Care v2.2 on 0.0.0.0:${PORT} (storage: ${pool ? activeDatabaseKind() : 'file'})`);
      // Pemanasan AI (tidak memblokir boot): siapkan daftar model & prompt
      // sistem di latar belakang supaya pesan pertama pengunjung tidak
      // menanggung biaya tambahan apa pun.
      if (DB.settings && DB.settings.ai_gemini_api_key) {
        setTimeout(() => {
          try {
            buildAISystemPrompt();
            resolveGeminiModel(DB.settings.ai_gemini_api_key, { force: true })
              .then((m) => { if (m) console.log('[ai] Model siap dipakai: ' + m); })
              .catch((e) => console.warn('[ai] Pemanasan model gagal: ' + sanitizeAIError(e)));
          } catch (e) { /* pemanasan bersifat opsional */ }
        }, 2000);
      }
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
// Rate limit khusus endpoint AI & webhook. Endpoint ini memanggil API
// berbayar (Gemini/OpenRouter/Meta Graph), jadi jangan sampai bisa
// di-spam. Limiter global /api/ (240 req/menit) terlalu longgar untuk
// endpoint yang memicu biaya per request.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 pesan/menit/IP — cukup untuk percakapan normal
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak pesan. Tunggu sebentar ya.' }
});
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
// Form reservasi publik = satu-satunya endpoint yang bisa MENULIS data
// tanpa login, dan tiap kiriman membawa bukti transfer (maks 5 MB, masuk
// sebagai base64 ke state). Limiter global 240/menit jauh terlalu longgar:
// cukup beberapa menit untuk menggelembungkan database/kuota. Batasi per
// IP, tapi tetap longgar untuk pemakaian wajar (satu keluarga bisa kirim
// beberapa kali karena salah pilih jadwal).
const reservationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak pengiriman reservasi dari jaringan ini. Coba lagi beberapa menit lagi atau hubungi admin via WhatsApp.' }
});

// Tutupi sebagian besar digit nomor telepon untuk keperluan log:
// '628123456789' -> '6281****6789'.
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length <= 6) return '***';
  return d.slice(0, 4) + '****' + d.slice(-4);
}

// Buang kredensial/identitas internal dari pesan error DB sebelum
// ditampilkan di /health atau log.
function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/\/\/[^@\s/]+@/g, '//***@')                      // user:password@host
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '***')                 // token/ID panjang
    .replace(/(user|username|role|database)\s+["'][^"']+["']/gi, '$1 ***') // user 'x'
    .replace(/\b(user|username|role|database)\s+[^\s,'"]+/gi, '$1 ***')   // user x
    .replace(/\b[a-z0-9-]{2,}\.[a-z0-9-]{3,}\.[a-z]{2,}\b/gi, '***')     // host internal
    .slice(0, 240);
}

// Bandingkan dua string dengan waktu konstan (hindari timing attack saat
// memverifikasi token/signature webhook).
function safeCompare(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  try { return require('crypto').timingSafeEqual(ba, bb); } catch { return false; }
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth')) {
    res.setHeader('Cache-Control', 'private, no-store');
  }
  // Jangan biarkan panel admin & data API di-embed di situs lain
  // (clickjacking: admin mengira sedang mengetik di situsnya sendiri).
  // Hanya aktif di production supaya preview/iframe lokal tetap jalan.
  if (IS_PRODUCTION && (req.path === '/admin' || req.path.startsWith('/api/admin') || req.path.startsWith('/api/auth'))) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  // Halaman kwitansi memuat nama, alamat, dan nomor WhatsApp pasien.
  // Jangan biarkan mesin pencari mengindeksnya walau link-nya tersebar,
  // dan jangan simpan di cache publik mana pun.
  if (req.path.startsWith('/kwitansi/') || req.path.startsWith('/api/public/receipt/') || req.path.startsWith('/api/owner-signature')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'private, no-store');
  }
  if (req.path === '/admin' || req.path === '/admin.html') {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
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
// Origin frontend tambahan yang selalu boleh (tanpa perlu set env):
// cermin GitHub Pages repo ini. Tanpa ini, ALLOWED_ORIGINS yang tidak diisi
// berarti TIDAK ada header CORS sama sekali, sehingga cermin GH Pages
// (docs/) tidak bisa memanggil API Railway — halaman tampil tanpa layanan,
// kalender kosong, dsb. Hanya origin milik repo ini + localhost (dev).
const DEFAULT_ALLOWED_ORIGINS = new Set(['https://putra1996.github.io']);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!allowedOrigins && origin) {
    const normalized = origin.replace(/\/$/, '');
    const isDefaultAllowed = DEFAULT_ALLOWED_ORIGINS.has(normalized.toLowerCase());
    const isLocal = !IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
    if (isDefaultAllowed || isLocal) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  }
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

// Simpan raw body untuk endpoint webhook WhatsApp saja — dipakai untuk
// memverifikasi header X-Hub-Signature-256 dari Meta (HMAC-SHA256 atas
// body mentah). Route lain tidak menyimpan body mentah supaya memori
// tetap hemat.
const standardJsonParser = express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/webhook/whatsapp')) {
      req.rawBody = buf && buf.length ? Buffer.from(buf) : Buffer.alloc(0);
    }
  }
});
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
app.get('/kwitansi-share.html', (req, res, next) => {
  const params = new URLSearchParams(req.query || {});
  const token = params.get('t') || params.get('token') || '';
  if (!token) {
    // Tanpa token: serahkan ke express.static supaya file aslinya
    // dilayani (halaman itu punya pesan sendiri "Token kosong").
    //
    // BUG LAMA: di sini route mem-redirect ke dirinya sendiri
    // ('/kwitansi-share.html'), sehingga membuka URL tanpa token
    // menghasilkan infinite redirect loop (ERR_TOO_MANY_REDIRECTS)
    // dan halaman tidak pernah tampil.
    return next();
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
  let payload;
  try {
    // algorithms dibatasi ke HS256 — mencegah serangan algorithm confusion
    // (mis. token yang mengaku ditandatangani dengan 'none' atau RSA).
    payload = jwt.verify(token, JWT_SECRET, { issuer: 'adzkiya-api', algorithms: ['HS256'] });
  } catch (e) {
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa' });
  }
  // Token harus milik akun admin yang MASIH ADA. Kalau admin dihapus dari
  // DB tetapi token lama masih beredar (mis. token dicuri), token itu
  // otomatis mati.
  const admin = DB.admins.find((a) => a.id === payload.id);
  if (!admin) return res.status(401).json({ error: 'Akun tidak ditemukan. Silakan login ulang.' });
  // Cabut token yang diterbitkan SEBELUM password terakhir diubah: kalau
  // password diganti karena token suspect bocor, token lama tidak bisa
  // dipakai lagi sampai masa berlakunya habis.
  if (admin.password_changed_at) {
    // Nilai iat pada JWT hanya presisi DETIK, sedangkan password_changed_at
    // presisi milidetik. Tanpa pembulatan ke bawah, token yang baru saja
    // diterbitkan (detik yang sama saat ganti password) ikut dianggap
    // "terbitan lama" dan langsung ditolak — user terjebak tidak bisa apa-apa
    // walau baru saja login dengan password baru.
    const changedMs = Math.floor(new Date(admin.password_changed_at).getTime() / 1000) * 1000;
    const issuedMs = (payload.iat || 0) * 1000;
    if (Number.isFinite(changedMs) && changedMs > 0 && issuedMs && issuedMs < changedMs) {
      return res.status(401).json({ error: 'Sesi lama sudah tidak berlaku. Silakan login ulang.' });
    }
  }
  req.user = payload;
  req.admin = admin;
  next();
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
// Health check. `storage` = storage yang SEDANG dipakai (file /
// postgres / mysql). Tambahan `configured_storage` + `db_connected`
// supaya bisa dibedakan antara "memang pakai file" dan "DATABASE_URL
// diisi tapi DB gagal connect saat boot" — dulu keduanya tampil
// sebagai "file", yang bikin data hilang tanpa jejak sulit ditelusuri.
app.get('/health', (req, res) => res.json({
  ok: true,
  storage: pool ? activeDatabaseKind() : 'file',
  configured_storage: DATABASE_KIND,
  db_connected: !!pool,
  db_reachable: pool ? true : dbReachable,
  db_error: pool ? null : dbConnectError,
  data_file: DATABASE_KIND === 'file' ? path.basename(DATA_FILE) : null,
  // Apakah file state selamat antar deploy (volume persisten)?
  file_persistent: !!DATA_FILE_INFO.persistent,
  using_runtime_connection: !!runtimeDatabaseUrl,
  time: new Date().toISOString(),
  today_wib: todayJakarta()
}));

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
  // Daftar URL layanan. Admin bisa mengisi settings.public_services_slugs
  // (array path/slug). Kalau kosong, generate satu URL per layanan dari
  // katalog server.
  //
  // BUG LAMA: baris ini memakai Object.values(SERVICE_PRICE_BY_NAME) —
  // itu SELALU [] karena SERVICE_PRICE_BY_NAME adalah Map (bukan objek
  // biasa). Akibatnya sitemap tidak pernah memuat halaman layanan.
  const slugs = DB.settings && DB.settings.public_services_slugs;
  let serviceUrls = [];
  if (Array.isArray(slugs) && slugs.length) {
    serviceUrls = slugs
      .map((s) => String(s == null ? '' : s).trim())
      .filter(Boolean)
      .map((s) => (/^\//.test(s) || /^https?:\/\//i.test(s) ? s : '/reservasi.html?service=' + encodeURIComponent(s)));
  } else if (SERVICE_PRICE_BY_NAME.size) {
    serviceUrls = Array.from(SERVICE_PRICE_BY_NAME.keys())
      .map((n) => '/reservasi.html?service=' + encodeURIComponent(n));
  }
  const today = todayJakarta();
  // Escape XML: base URL berasal dari header Host / X-Forwarded-Host
  // yang bisa dikendalikan client, jadi jangan pernah disisipkan mentah.
  const xmlEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const urls = staticUrls.concat(serviceUrls.map((s) => ({ loc: s, priority: '0.7', changefreq: 'monthly' })));
  const body = urls.map((u) => `  <url>
    <loc>${xmlEsc(base + u.loc)}</loc>
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
app.post('/api/reservations', reservationLimiter, upload.single('proof'), (req, res) => {
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
    // Buang jadwal duplikat (tanggal + jam sama). Total reservasi dihitung
    // sebagai itemSum × jumlah slot, jadi kalau form mengirim slot yang
    // sama dua kali (mis. user menambah baris lalu mengisi tanggal/jam
    // yang identik) pasien akan tertagih dua kali untuk satu sesi.
    const beforeDedupe = slots.length;
    slots = slots.filter((s, i) => slots.findIndex((x) => x.date === s.date && x.time === s.time) === i);
    if (slots.length !== beforeDedupe && !slots.length) {
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
// Throttle KEDUA per akun, bukan hanya per IP. Penyerang bisa memakai
// banyak IP/proxy (atau jaringan bergantian) supaya batas per-IP tidak
// pernah tercapai, lalu menebak password satu akun tanpa henti. Dengan
// pembatas per-email, satu akun tetap terkunci setelah beberapa kali gagal
// walau IP-nya selalu berubah.
const loginAttemptsByAccount = new Map();
// Bersihkan entri login-attempts yang sudah lewat window-nya secara
// berkala supaya Map tidak tumbuh tanpa batas (memory leak) saat banyak
// IP berbeda gagal login sekali lalu tidak pernah kembali.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (!val || val.resetAt < now) loginAttempts.delete(key);
  }
  for (const [key, val] of loginAttemptsByAccount) {
    if (!val || val.resetAt < now) loginAttemptsByAccount.delete(key);
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
  // Kunci per akun memakai hash email (tidak menyimpan email di memori/log).
  const acctKey = require('crypto').createHash('sha256').update(email).digest('hex').slice(0, 16);
  const acct = loginAttemptsByAccount.get(acctKey) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > acct.resetAt) Object.assign(acct, { count: 0, resetAt: now + 15 * 60 * 1000 });
  if (acct.count >= 8) {
    return res.status(429).json({ error: 'Akun ini terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi 15 menit lagi.' });
  }

  const admin = DB.admins.find((item) => item.email.toLowerCase() === email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    current.count += 1;
    loginAttempts.set(key, current);
    acct.count += 1;
    loginAttemptsByAccount.set(acctKey, acct);
    return res.status(401).json({ error: 'Email atau password salah' });
  }

  loginAttempts.delete(key);
  loginAttemptsByAccount.delete(acctKey);
  // Kalau hash lama dibuat dengan biaya bcrypt lebih rendah (mis. data.json
  // warisan dengan cost 10), naikkan diam-diam ke 12 begitu password
  // terbukti benar. Tidak mengubah password user sama sekali.
  try {
    const rounds = parseInt(String(admin.password_hash || '').split('$')[2], 10) || 0;
    if (rounds > 0 && rounds < 12) {
      admin.password_hash = bcrypt.hashSync(password, 12);
      admin.password_rounds_upgraded_at = new Date().toISOString();
      save();
      console.log('[auth] Hash password di-upgrade ke bcrypt cost 12');
    }
  } catch (e) { /* upgrade bersifat opsional */ }
  const token = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role },
    JWT_SECRET,
    { expiresIn: '12h', issuer: 'adzkiya-api' }
  );
  res.json({
    token,
    user: {
      id: admin.id, email: admin.email, name: admin.name, role: admin.role,
      // Dipakai panel admin untuk mengingatkan kalau password default
      // belum pernah diganti (null = belum pernah).
      password_changed_at: admin.password_changed_at || null
    }
  });
});

// ===== ADMIN — RESERVATIONS =====
function publicReservation(r) {
  return {
    // `source` dipakai panel untuk menandai reservasi yang dibuat otomatis
    // oleh AI Assistant (bukan dari form/webhook lain).
    source: r.source || null,
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

// Nilai status yang dikenal seluruh aplikasi (badge, filter, statistik,
// kalender publik). Tanpa validasi ini, nilai sembarang dari client
// (mis. hasil typo atau payload jahat) tersimpan apa adanya sehingga
// badge tampil rusak, filter status tidak menemukan data, dan hitungan
// dashboard jadi salah.
const RESERVATION_STATUSES = ['pending', 'approved', 'rejected'];
const PAYMENT_STATUSES = ['unpaid', 'lunas'];

app.patch('/api/admin/reservations/:id', auth, (req, res) => {
  const r = DB.reservations.find(x => x.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (req.body.status !== undefined && req.body.status !== null && req.body.status !== '') {
    if (!RESERVATION_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `Status harus salah satu dari: ${RESERVATION_STATUSES.join(', ')}` });
    }
    r.status = req.body.status;
  }
  if (req.body.payment_status !== undefined && req.body.payment_status !== null && req.body.payment_status !== '') {
    if (!PAYMENT_STATUSES.includes(req.body.payment_status)) {
      return res.status(400).json({ error: `Status pembayaran harus salah satu dari: ${PAYMENT_STATUSES.join(', ')}` });
    }
    r.payment_status = req.body.payment_status;
  }
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
  // Omzet trend 14 hari terakhir. Bucket harian dihitung dari tanggal
  // WIB "hari ini" — bukan UTC — supaya data hari ini tidak hilang /
  // bergeser ke kolom kemarin antara pukul 00:00–06:59 WIB.
  const todayStr = todayJakarta();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    days.push(shiftDateStr(todayStr, -i));
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

  // Monthly omzet (last 6 months) — basis bulan WIB.
  const curMonth = monthJakarta();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    months.push(shiftMonthStr(curMonth, -i));
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
  // Default bulan = bulan berjalan menurut WIB (bukan UTC).
  const month = req.query.month || monthJakarta();
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
    const month = req.query.month || monthJakarta();
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
  // Nomor invoice memakai tanggal WIB — bukan UTC. Kalau pakai UTC,
  // kwitansi yang dibuat pagi hari (00:00–06:59 WIB) akan bernomor
  // tanggal kemarin.
  const today = todayJakarta().replace(/-/g, '');
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
  // Filter ?month=YYYY-MM (created_at ATAU service_date di bulan itu),
  // pencarian ?q= (nama / invoice / WhatsApp), lalu pagination
  // ?limit= & ?offset=.
  //
  // PENTING: dulu endpoint ini selalu memotong 200 baris terbaru tanpa
  // cara mengambil sisanya, sehingga kwitansi lama tidak bisa dilihat
  // maupun dicari lagi dari halaman Kwitansi (kwitansi = dokumen bukti
  // bayar, jadi ini masalah nyata begitu jumlahnya lewat 200).
  const month = req.query.month;
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let rows = DB.receipts.slice();
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    rows = rows.filter(r =>
      (r.created_at && r.created_at.slice(0, 7) === month) ||
      (r.service_date && r.service_date.slice(0, 7) === month)
    );
  }
  if (q) {
    rows = rows.filter(r =>
      String(r.patient_name || '').toLowerCase().includes(q) ||
      String(r.invoice_no || '').toLowerCase().includes(q) ||
      String(r.whatsapp || '').toLowerCase().includes(q)
    );
  }
  rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  res.setHeader('X-Total-Count', String(rows.length));
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
  res.json(rows.slice(offset, offset + limit));
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
  if (activeDatabaseKind() === 'postgres' && pool) {
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
  } else if (activeDatabaseKind() === 'mysql' && pool) {
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
  if (activeDatabaseKind() === 'postgres' && pool) {
    try {
      await pool.query(
        'INSERT INTO share_tokens (token, receipt_id, exp) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET receipt_id = EXCLUDED.receipt_id, exp = EXCLUDED.exp',
        [token, id, exp]
      );
    } catch (e) {
      console.error('[share-tokens] postgres save failed:', e.message);
    }
  } else if (activeDatabaseKind() === 'mysql' && pool) {
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
  if (activeDatabaseKind() === 'postgres' && pool) {
    try { await pool.query('DELETE FROM share_tokens WHERE exp < $1', [now]); } catch {}
  } else if (activeDatabaseKind() === 'mysql' && pool) {
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
  // SECURITY: `ts` tidak ikut ditandatangani (signature hanya menutup
  // payload), jadi tanpa batas atas siapa pun bisa mengubah ts menjadi
  // tahun 3000 dan membuat link kwitansi yang sudah bocor berlaku
  // SELAMANYA. Tolak timestamp yang berada di masa depan (toleransi 5
  // menit untuk selisih jam antar server).
  if (!Number.isFinite(tsNum) || tsNum + SHARE_TOKEN_TTL_MS < Date.now()) return null;
  if (tsNum > Date.now() + 5 * 60 * 1000) return null;
  let data;
  try { data = Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url').slice(0, 22);
  if (sig !== expectedSig) return null;
  const [invoice_no, created_at, total] = data.split('|');
  // Find the receipt with matching fields and remember its id.
  const r = DB.receipts.find((x) => x.invoice_no === invoice_no && x.created_at === created_at && Math.abs((x.total || 0) - parseFloat(total)) < 1);
  if (!r) return null;
  // Cache for next time. Persist in background so it survives restart.
  // Batas masa berlaku tetap dihitung dari ts yang sudah divalidasi.
  saveShareToken(token, r.id, Math.min(tsNum, Date.now()) + SHARE_TOKEN_TTL_MS).catch(() => {});
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
            ${biz.has_owner_signature ? `<img id="ownerSigImg" src="${ownerSignatureDataUrl() || ''}" alt="Tanda tangan ${fullName}" style="display:block;max-height:60px;max-width:220px;margin:4px 0 4px auto;background:transparent;" />` : ''}
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
// Nomor Indonesia -> format internasional untuk wa.me.
// BUG: sebelumnya dipakai `phone.replace(/\D/g,'')` apa adanya, sehingga
// nomor lokal seperti "085887018194" menghasilkan https://wa.me/085887018194
// — WhatsApp mengharapkan nomor tanpa angka 0 di depan (6285887018194).
// Tautan seperti itu bisa gagal dibuka atau salah arah.
function waNumberFor(phone, fallback) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) digits = String(fallback || '6285887018194').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);       // 08xx -> 628xx
  else if (digits.startsWith('620')) digits = '62' + digits.slice(3); // salah tulis 620xx
  else if (!digits.startsWith('62') && digits.length <= 12) digits = '62' + digits; // 8xx -> 628xx
  return digits;
}
function waLinkFor(phone, fallback) {
  return 'https://wa.me/' + waNumberFor(phone, fallback);
}

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
  // Build list of last N months including current — basis bulan WIB,
  // supaya pada tanggal 1 pukul 00:00–06:59 WIB tidak mundur ke bulan lalu.
  const monthList = [];
  for (let i = months - 1; i >= 0; i--) {
    monthList.push(shiftMonthStr(monthJakarta(), -i));
  }
  const monthSet = new Set(monthList);

  // Income per month — sum of total where reservation_date is in
  // the month AND payment_status = 'lunas'. We compute it server-side
  // to keep the dashboard snappy even on slow connections.
  const incomeByMonth = Object.fromEntries(monthList.map((m) => [m, 0]));
  const expenseByMonth = Object.fromEntries(monthList.map((m) => [m, 0]));
  const expensesByCategory = {};
  DB.reservations.forEach((r) => {
    const m = (r.reservation_date || '').slice(0, 7);
    if (!m || !monthSet.has(m)) return;
    if (r.payment_status === 'lunas') {
      incomeByMonth[m] = (incomeByMonth[m] || 0) + (r.total || calcReservationTotal(r));
    }
  });
  // Kwitansi TIDAK ditambahkan terpisah di sini: syncReceiptToReservation()
  // sudah memirror setiap kwitansi ke DB.reservations (payment_status
  // 'lunas'), jadi menambahkannya lagi akan menghitung omzet dua kali.
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
        service_date = todayJakarta();
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
  // Frontend mengambilnya lewat /api/admin/settings/owner-signature
  // (ber-token) hanya saat mau menampilkan preview / membuat PDF.
  //
  // SECURITY: also strip the AI secret keys (Gemini / OpenRouter API
  // keys and the WhatsApp Business access token). These must never be
  // echoed back to the client — the frontend only needs to know
  // WHETHER a key is set (has_* flags), not the value itself. The
  // admin re-enters a key only when rotating it.
  const {
    logo_b64, hero_b64, qris_b64, owner_signature_b64,
    ai_gemini_api_key, ai_openrouter_api_key, ai_assistant_access_token, ai_assistant_app_secret,
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
  ['ai_gemini_api_key', 'ai_openrouter_api_key', 'ai_assistant_access_token', 'ai_assistant_app_secret'].forEach((k) => {
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
  // Buang key yang bisa merusak objek settings / prototype pollution.
  // (Frontend tidak pernah mengirimnya; ini murni pertahanan terhadap
  // payload tangan yang dibuat manual.)
  ['__proto__', 'constructor', 'prototype'].forEach((k) => { delete body[k]; });
  // Batasi ukuran total supaya settings tidak bisa dipakai menjejalkan
  // data besar (menggembungkan state + backup + biaya storage).
  if (JSON.stringify({ ...DB.settings, ...body }).length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: 'Pengaturan terlalu besar (>4MB). Kurangi ukuran gambar yang diunggah.' });
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

// Tanda tangan bidan/pemilik HANYA boleh keluar lewat jalur berizin.
//
// SEBELUMNYA endpoint ini PUBLIK (tanpa auth), jadi siapa pun yang tahu
// URL-nya bisa mengunduh gambar tanda tangan asli lalu memakainya untuk
// memalsukan kwitansi. Sekarang:
//   * admin  -> GET /api/admin/settings/owner-signature (pakai token)
//   * halaman kwitansi publik -> tanda tangan disisipkan langsung sebagai
//     data URL di HTML yang dirender server (lihat renderKwitansiHtml)
//   * print/PDF panel admin -> data URL diambil lebih dulu via endpoint
//     admin, lalu di-inject ke halaman cetak
// Route lama tetap ada sebagai 404 eksplisit supaya tidak jatuh ke catch-all.
function ownerSignatureDataUrl() {
  const s = DB.settings || {};
  if (!s.owner_signature_b64) return null;
  return 'data:' + (s.owner_signature_mime || 'image/png') + ';base64,' + s.owner_signature_b64;
}
app.get('/api/owner-signature', (req, res) => res.status(404).json({ error: 'Endpoint tidak tersedia' }));

// Admin-only: ambil tanda tangan sebagai data URL (untuk preview, print,
// dan PDF). Tidak ikut otomatis di payload /api/admin/settings supaya
// respons itu tetap ringan dan data ini tidak beredar tanpa perlu.
app.get('/api/admin/settings/owner-signature', auth, (req, res) => {
  const s = DB.settings || {};
  if (!s.owner_signature_b64) {
    return res.json({ ok: true, has_signature: false, mime: null, data_url: null });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    ok: true,
    has_signature: true,
    mime: s.owner_signature_mime || 'image/png',
    data_url: ownerSignatureDataUrl(),
    at: s.owner_signature_at || null
  });
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

// ===== ADMIN — STATUS & PEMULIHAN PENYIMPANAN =====

// Bangun connection string dari bagian-bagian terpisah dengan encoding
// yang BENAR. Ini penting: password Neon/Postgres sering memuat karakter
// seperti @ : / ? # — kalau ditempel mentah ke dalam URL, hasil parsing
// rusak dan login ke database gagal dengan pesan "password authentication
// failed" yang membingungkan. Dengan input terpisah, kita yang meng-encode.
function buildConnectionString(input) {
  const b = input || {};
  const raw = String(b.url || '').trim();
  if (raw) {
    if (/^postgres(ql)?:\/\//i.test(raw) || /^mysql2?:\/\//i.test(raw)) return { conn: raw, kind: /^mysql/i.test(raw) ? 'mysql' : 'postgres' };
    if (/^postgres(ql)?:/i.test(raw) || /^mysql/i.test(raw)) return { conn: raw, kind: /^mysql/i.test(raw) ? 'mysql' : 'postgres' };
    return { error: 'Format connection string tidak dikenali. Harus diawali postgresql:// atau mysql://.' };
  }
  const host = String(b.host || '').trim();
  const user = String(b.user || '').trim();
  if (!host || !user) return { error: 'Isi DATABASE_URL lengkap, atau minimal host + user.' };
  const kind = String(b.kind || 'postgres').toLowerCase() === 'mysql' ? 'mysql' : 'postgres';
  const scheme = kind === 'mysql' ? 'mysql' : 'postgresql';
  const port = String(b.port || '').trim() || (kind === 'mysql' ? '3306' : '5432');
  const database = String(b.database || '').trim() || (kind === 'mysql' ? '' : 'postgres');
  const password = String(b.password == null ? '' : b.password);
  const needsSsl = b.ssl !== false;
  const auth = encodeURIComponent(user) + (password ? ':' + encodeURIComponent(password) : '') + '@';
  const dbPart = database ? '/' + encodeURIComponent(database) : '';
  const query = needsSsl ? (kind === 'mysql' ? '?ssl=true' : '?sslmode=require') : '';
  return { conn: scheme + '://' + auth + host + ':' + port + dbPart + query, kind };
}

// Terjemahkan error koneksi menjadi langkah perbaikan yang bisa dikerjakan.
// Pesan error asli tetap disertakan (tanpa kredensial) supaya admin bisa
// mencocokkan dengan dokumentasi penyedia database.
function connectionHint(err, input) {
  const msg = String((err && err.message) || err || '');
  const lower = msg.toLowerCase();
  if (lower.includes('password authentication failed') || lower.includes('access denied')) {
    return 'Password di connection string tidak cocok. Buka konsol database → Reset password / Copy connection string, lalu tempel ulang. (Kalau password memuat karakter @ : / ? #, pakai kolom terpisah di bawah supaya tidak perlu di-encode manual.)';
  }
  if (lower.includes('role') && lower.includes('does not exist')) return 'Nama user salah. Cek bagian user pada connection string.';
  if (lower.includes('database') && lower.includes('does not exist')) return 'Nama database salah. Cek bagian nama database di akhir connection string.';
  if (lower.includes('enotfound') || lower.includes('eai_again')) return 'Host tidak ditemukan. Pastikan host (mis. ep-xxx-pooler.xxx.aws.neon.tech) tersalin lengkap tanpa spasi/baris baru.';
  if (lower.includes('econnrefused') || lower.includes('etimedout') || lower.includes('timeout')) return 'Host tidak bisa dihubungi. Cek jaringan/port, dan pastikan SSL diaktifkan (Neon mewajibkan SSL).';
  if (lower.includes('ssl') || lower.includes('self-signed') || lower.includes('certificate')) return 'Masalah SSL. Coba aktifkan opsi SSL, atau pakai connection string yang menyertakan sslmode=require.';
  if (lower.includes('too many connections') || lower.includes('remaining connection slots')) {
    return 'Koneksi ke database penuh. Tutup tool lain yang terhubung (SQL editor/psql), lalu coba lagi.';
  }
  if (lower.includes('quota') || lower.includes('exceeded')) return 'Kuota database habis/terlampaui. Cek dashboard penyedia database.';
  const raw = String((input && input.url) || '');
  if (raw.includes('%')) return 'Perhatian: connection string memuat karakter persen (%) — pastikan itu memang bagian password yang ter-encode, bukan hasil generasi ganda.';
  return 'Periksa kembali host, port, nama database, user, dan password.';
}

// Tes koneksi TANPA mengubah apa pun. Dipakai panel admin sebelum admin
// menempelkan URL ke Railway, supaya tidak perlu deploy hanya untuk tahu
// apakah kredensialnya benar.
app.post('/api/admin/storage/test-connection', auth, async (req, res) => {
  const built = buildConnectionString(req.body);
  if (built.error) return res.status(400).json({ ok: false, error: built.error });
  const started = Date.now();
  try {
    if (built.kind === 'postgres') {
      const testPool = new PostgresPool({
        connectionString: built.conn,
        ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : (req.body && req.body.ssl === false ? undefined : { rejectUnauthorized: false }),
        max: 1,
        connectionTimeoutMillis: 10000
      });
      try {
        // WAJIB: query ini menentukan hasil tes. Harus dijalankan lebih dulu
        // dan TANPA try/catch — kalau host mati, password salah, atau SSL
        // ditolak, error di sini yang dipakai untuk melaporkan kegagalan.
        // (Pernah salah: semua query dibungkus try/catch sehingga host mati
        // tetap dilaporkan "berhasil".)
        await testPool.query('SELECT 1');

        // Informasi tambahan (versi server, isi tabel) bersifat opsional:
        // sebagian database/user terbatas tidak mengizinkan query ini, dan
        // kegagalannya tidak boleh menutupi keberhasilan koneksi.
        let serverVersion = null;
        try {
          const version = await testPool.query('SHOW server_version');
          serverVersion = (version.rows[0] && version.rows[0].server_version) || null;
        } catch (e) {
          try {
            const alt = await testPool.query('SELECT version() AS v');
            serverVersion = String((alt.rows[0] && alt.rows[0].v) || '').split(' ').slice(0, 2).join(' ') || null;
          } catch (e2) { /* opsional */ }
        }
        let hasTable = null;
        let counts = null;
        try {
          const tableCheck = await testPool.query(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_state' LIMIT 1"
          );
          hasTable = tableCheck.rows.length > 0;
        } catch (e) { /* opsional */ }
        if (hasTable) {
          try {
            const rows = await testPool.query('SELECT data FROM app_state WHERE id = 1');
            if (rows.rows.length) {
              const state = normalizeStateObject(rows.rows[0].data);
              counts = {
                reservations: state.reservations.length,
                receipts: state.receipts.length,
                expenses: state.expenses.length
              };
            }
          } catch (e) { /* opsional */ }
        }
        return res.json({
          ok: true,
          kind: 'postgres',
          latency_ms: Date.now() - started,
          server_version: serverVersion,
          has_app_state_table: hasTable,
          db_counts: counts
        });
      } finally {
        try { await testPool.end(); } catch {}
      }
    }
    const conn = await mysql.createConnection(built.conn);
    try {
      await conn.query('SELECT 1');
      let rows = null;
      try { [rows] = await conn.query('SELECT data FROM app_state WHERE id = 1'); } catch (e) { /* opsional */ }
      let counts = null;
      if (rows && rows.length) {
        try {
          const state = normalizeStateObject(JSON.parse(rows[0].data));
          counts = { reservations: state.reservations.length, receipts: state.receipts.length, expenses: state.expenses.length };
        } catch {}
      }
      return res.json({ ok: true, kind: 'mysql', latency_ms: Date.now() - started, has_app_state_table: !!(rows && rows.length), db_counts: counts });
    } finally {
      try { await conn.end(); } catch {}
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: sanitizeDbError(e), hint: connectionHint(e, req.body) });
  }
});

// Pindah ke database memakai connection string tertentu.
// Dipakai oleh: tombol "Gunakan koneksi ini sekarang" (apply) dan
// "Sinkronkan Data Darurat ke Database" (memakai koneksi aktif).
async function switchStorageToDatabase(connStr, kindOverride, opts) {
  const kind = kindOverride || activeDatabaseKind();
  const opened = await openDbPoolAndReadState(connStr, kind);
  if (!opened || !opened.pool) throw new Error('Tidak bisa membuka koneksi database');
  const { state: merged, report } = mergeTransactionalState(opened.state || {}, DB);

  // PENGAMAN TERAKHIR: pastikan selalu ada akun admin setelah pindah.
  // Tanpa ini, memindahkan data ke database kosong akan mengunci admin keluar
  // dari panel — dan pemulihannya butuh akses deploy. Kalau admin yang
  // sedang login diketahui (opts.ensureAdmin), akun itu dipastikan ada.
  const ensure = opts && opts.ensureAdmin;
  if (ensure && ensure.email) {
    const exists = merged.admins.some((a) => String(a && a.email || '').toLowerCase() === String(ensure.email).toLowerCase());
    if (!exists) {
      merged.admins.push(ensure);
      report.admins_added = (report.admins_added || 0) + 1;
    }
  }
  if (!merged.admins.length) {
    try { await opened.pool.end(); } catch {}
    throw new Error('Dibatalkan: database tujuan tidak punya akun admin, dan menyalin akun admin dari data darurat tidak memungkinkan. Login ke panel ini dulu (dengan akun dari penyimpanan lama), lalu ulangi prosesnya.');
  }
  // Urutan penting: aktifkan pool dulu supaya persistSnapshot menulis ke
  // database, bukan ke file.
  const previousPool = pool;
  pool = opened.pool;
  // Tutup pool lama (bila ada) supaya koneksi ke database sebelumnya tidak
  // menggantung setelah berpindah — penting saat admin mengganti koneksi
  // (mis. dari kredensial lama yang salah ke yang baru).
  if (previousPool && previousPool !== pool) {
    try { await previousPool.end(); } catch { /* sudah tidak dipakai */ }
  }
  if (connStr) {
    runtimeDatabaseUrl = connStr;
    runtimeDatabaseKind = kind;
  }
  DB = merged;
  normalizeState();
  saveShareTokensMirror();
  dbConnectError = null;
  dbReachable = true;
  await persistSnapshot(JSON.stringify(DB));
  return report;
}

// Gunakan connection string baru SEKARANG (tanpa menunggu redeploy), lalu
// gabungkan data darurat dari file ke database itu. Connection string tetap
// harus disalin ke Railway → Variables supaya bertahan setelah deploy.
app.post('/api/admin/storage/apply-connection', auth, async (req, res) => {
  const built = buildConnectionString(req.body);
  if (built.error) return res.status(400).json({ ok: false, error: built.error });
  if (String((req.body && req.body.confirm) || '').trim().toUpperCase() !== 'PAKAI') {
    return res.status(400).json({ ok: false, error: 'Konfirmasi diperlukan: kirim { "confirm": "PAKAI" }' });
  }
  try {
    const report = await switchStorageToDatabase(built.conn, built.kind, { ensureAdmin: req.admin });
    console.log('[storage] Koneksi database baru dipakai (runtime). Ingat: set DATABASE_URL di Railway agar permanen.');
    res.json({
      ok: true,
      message: 'Server sekarang memakai database ini. Data darurat dari file sudah digabungkan.',
      runtime_only: true,
      report
    });
  } catch (e) {
    const reason = sanitizeDbError(e);
    res.status(400).json({ ok: false, error: reason, hint: connectionHint(e, req.body) });
  }
});

// Query diagnostik dari database: jumlah baris + user/host tampil apa
// adanya TANPA mengembalikan kredensial apa pun.
async function readActiveDbInfo() {
  if (!pool) return null;
  const info = { kind: activeDatabaseKind() };
  try {
    if (activeDatabaseKind() === 'postgres') {
      // Query gabungan dulu; kalau versi/konfigurasi database tertentu tidak
      // mendukung salah satu fungsi, jatuh ke query yang lebih sederhana
      // supaya nama database tetap bisa ditampilkan.
      try {
        const q = await pool.query("SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS host, version() AS ver");
        const row = q.rows[0] || {};
        info.database = row.db || null;
        info.user = row.usr || null;
        info.host = row.host || null;
        info.version = String(row.ver || '').split(' ').slice(0, 2).join(' ');
      } catch (e) {
        try {
          const q2 = await pool.query('SELECT current_database() AS db, current_user AS usr');
          info.database = (q2.rows[0] && q2.rows[0].db) || null;
          info.user = (q2.rows[0] && q2.rows[0].usr) || null;
        } catch (e2) {
          info.error = sanitizeDbError(e);
        }
      }
    } else {
      try {
        const [rows] = await pool.query('SELECT DATABASE() AS db, CURRENT_USER() AS usr');
        info.database = rows[0] && rows[0].db;
        info.user = rows[0] && rows[0].usr;
      } catch (e) { /* opsional */ }
    }
  } catch (e) {
    info.error = sanitizeDbError(e);
  }
  return info;
}

// Panel admin memakai ini untuk melihat: storage mana yang AKTIF, apakah
// database bisa dihubungi, dan berapa banyak data darurat yang belum
// masuk database. Tanpa ini, satu-satunya cara sadar adalah melihat data
// hilang setelah deploy berikutnya.
app.get('/api/admin/storage/status', auth, async (req, res) => {
  const payload = {
    configured_storage: DATABASE_KIND,
    active_storage: pool ? activeDatabaseKind() : 'file',
    db_connected: !!pool,
    db_reachable: pool ? true : (dbReachable === null ? null : dbReachable),
    db_error: pool ? null : dbConnectError,
    data_file: DATABASE_KIND === 'file' || pool ? null : path.basename(DATA_FILE),
    // Apakah file state selamat antar deploy? (volume Railway / DATA_FILE
    // di luar folder aplikasi = ya). Dipakai UI untuk memilih tingkat
    // peringatan yang jujur: merah = data bisa hilang, kuning = aman tapi
    // lebih baik pakai database.
    file_storage_persistent: !!DATA_FILE_INFO.persistent,
    file_storage_source: DATA_FILE_INFO.source,
    // True bila koneksi database yang dipakai datang dari panel admin
    // (bukan dari env DATABASE_URL) — artinya akan hilang saat redeploy,
    // jadi admin masih perlu menyalinnya ke Railway → Variables.
    using_runtime_connection: !!runtimeDatabaseUrl,
    live_counts: {
      reservations: DB.reservations.length,
      receipts: DB.receipts.length,
      expenses: DB.expenses.length,
      broadcasts: DB.broadcasts.length
    },
    can_sync: DATABASE_KIND !== 'file' && !pool,
    // Kwitansi yang dibuat setelah boot hanya ada di file darurat, jadi
    // umurnya penting: makin lama, makin banyak data berisiko.
    uptime_seconds: Math.round(process.uptime())
  };
  if (payload.db_connected) {
    payload.db_info = await readActiveDbInfo();
  }
  // Kalau database bisa dihubungi, tampilkan juga isi database supaya
  // admin tahu berapa banyak data yang akan digabungkan.
  if (payload.can_sync && (dbReachable === null || dbReachable === true)) {
    try {
      const opened = await openDbPoolAndReadState();
      if (opened.pool) {
        const dbState = normalizeStateObject(opened.state || {});
        payload.db_counts = {
          reservations: dbState.reservations.length,
          receipts: dbState.receipts.length,
          expenses: dbState.expenses.length
        };
        payload.db_reachable = true;
        dbReachable = true;
        dbConnectError = null;
      }
      if (opened.pool) { try { await opened.pool.end(); } catch {} }
    } catch (e) {
      payload.db_reachable = false;
      payload.db_error = sanitizeDbError(e);
      dbReachable = false;
      dbConnectError = payload.db_error;
    }
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(payload);
});

// Pindahkan data darurat (file) ke database: gabung, bukan timpa.
// Butuh konfirmasi eksplisit supaya tidak terklik tanpa sengaja.
app.post('/api/admin/storage/sync-to-db', auth, async (req, res) => {
  if (DATABASE_KIND === 'file') {
    return res.status(400).json({ error: 'Server ini memang memakai file storage (DATABASE_URL belum diset), jadi tidak ada database tujuan.' });
  }
  if (pool) {
    return res.status(400).json({ error: 'Server sudah memakai database — data sudah tersimpan di sana.' });
  }
  if (String((req.body && req.body.confirm) || '').trim().toUpperCase() !== 'SINKRON') {
    return res.status(400).json({ error: 'Konfirmasi diperlukan: kirim { "confirm": "SINKRON" }' });
  }
  try {
    const report = await switchStorageToDatabase(null, null, { ensureAdmin: req.admin });
    console.log(`[storage] Sinkron ke database selesai: +${report.reservations_added} reservasi, +${report.receipts_added} kwitansi, +${report.expenses_added} pengeluaran`);
    res.json({
      ok: true,
      message: 'Data darurat sudah digabungkan ke database. Mulai sekarang semua perubahan disimpan ke database.',
      report
    });
  } catch (e) {
    const reason = sanitizeDbError(e);
    console.error('[storage] sync ke database gagal:', reason);
    // Beda antara "server error" dan "database masih tidak bisa dihubungi":
    // yang kedua berarti admin harus memperbaiki DATABASE_URL dulu.
    const unreachable = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|terminated|authentication|password|timeout|EAI_AGAIN/i.test(reason);
    return res.status(unreachable ? 503 : 500).json({
      error: unreachable
        ? 'Database masih belum bisa dihubungi: ' + reason + '. Perbaiki DATABASE_URL / status database lalu redeploy, setelah itu sinkronkan lagi.'
        : 'Gagal menyinkronkan ke database: ' + reason
    });
  }
});

// Salin peta token kwitansi dari DB state ke penampung persisten, supaya
// token yang dibawa dari mode file tetap bisa diverifikasi setelah
// berpindah ke database.
function saveShareTokensMirror() {
  shareTokensDb = DB.share_tokens || {};
  for (const [tok, v] of Object.entries(shareTokensDb)) {
    if (v && v.exp && v.exp > Date.now()) shareTokenMap.set(tok, { id: v.id, exp: v.exp });
  }
}

// ===== ADMIN — BACKUP / RESTORE =====
//
// ITEM KEAMANAN: file backup berisi SELURUH data pasien (nama, alamat,
// nomor WhatsApp, riwayat layanan) dalam bentuk teks polos. File seperti
// itu biasanya diunduh, dikirim ke diri sendiri, atau disimpan di cloud —
// sekali bocor, semua data pasien ikut bocor.
//
// Karena itu backup sekarang bisa (dan secara default di UI) diunduh
// TERENKRIPSI: AES-256-GCM dengan kunci turunan scrypt dari passphrase
// yang hanya diketahui admin. Formatnya tetap satu file .json sehingga
// nyaman disimpan, tapi isinya tidak bisa dibaca tanpa passphrase.
const BACKUP_ENC_FORMAT = 'adzkiya-backup-enc-v1';
const BACKUP_KDF = { N: 16384, r: 8, p: 1, keylen: 32 };

function encryptBackupPayload(payload, passphrase) {
  const pass = String(passphrase || '');
  if (pass.length < 8) throw new Error('Passphrase minimal 8 karakter');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, BACKUP_KDF.keylen, {
    N: BACKUP_KDF.N, r: BACKUP_KDF.r, p: BACKUP_KDF.p
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: BACKUP_ENC_FORMAT,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdf_params: BACKUP_KDF,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
    exported_at: new Date().toISOString(),
    // Info non-rahasia supaya admin tahu file mana ini saat restore.
    meta: {
      app: 'adzkiya-mom-baby-care',
      counts: {
        reservations: (payload.reservations || []).length,
        receipts: (payload.receipts || []).length,
        expenses: (payload.expenses || []).length
      }
    }
  };
}

function decryptBackupEnvelope(envelope, passphrase) {
  if (!envelope || envelope.format !== BACKUP_ENC_FORMAT) {
    throw new Error('Format backup terenkripsi tidak dikenali');
  }
  const pass = String(passphrase || '');
  if (!pass) throw new Error('Passphrase wajib diisi untuk membuka backup terenkripsi');
  const params = envelope.kdf_params || BACKUP_KDF;
  const salt = Buffer.from(String(envelope.salt || ''), 'base64');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const key = crypto.scryptSync(pass, salt, params.keylen || BACKUP_KDF.keylen, {
    N: params.N || BACKUP_KDF.N, r: params.r || BACKUP_KDF.r, p: params.p || BACKUP_KDF.p
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(Buffer.from(String(envelope.data || ''), 'base64')), decipher.final()]);
  } catch (e) {
    // GCM menolak saat tag tidak cocok = passphrase salah atau file diubah.
    throw new Error('Passphrase salah atau file backup rusak/tidak utuh');
  }
  let parsed;
  try { parsed = JSON.parse(plaintext.toString('utf8')); }
  catch (e) { throw new Error('Isi backup tidak valid setelah didekripsi'); }
  return parsed;
}

// Kumpulkan payload backup. Rahasia (kunci AI, token WA, TTD pemilik, log
// chat) dan foto bukti transfer sengaja TIDAK ikut — lihat penjelasan di
// endpoint /api/admin/backup.
function buildBackupPayload() {
  return {
    exported_at: new Date().toISOString(),
    reservations: DB.reservations.map((r) => {
      const { proof_b64, ...rest } = r;
      return rest;
    }),
    receipts: DB.receipts,
    expenses: DB.expenses,
    expense_categories: DB.expense_categories,
    broadcasts: DB.broadcasts.map((b) => ({
      id: b.id, name: b.name, body: b.body, recipient_count: b.recipient_count,
      filter: b.filter, created_at: b.created_at
    })),
    settings: (() => {
      const {
        ai_gemini_api_key, ai_openrouter_api_key, ai_assistant_access_token,
        ai_assistant_app_secret, ai_assistant_verify_token,
        owner_signature_b64, owner_signature_mime,
        ai_assistant_conversations,
        ai_last_error, ai_last_error_at, ai_openrouter_free_only, ai_openrouter_free_only_at,
        ...rest
      } = (DB.settings || {});
      return rest;
    })()
  };
}

app.get('/api/admin/backup', auth, (req, res) => {
  // PENTING: respons ini berisi data pasien dalam teks polos. Hanya
  // dipakai oleh tombol "JSON biasa" (opsional) dan proses restore lama.
  // Untuk pemakaian sehari-hari pakai /api/admin/backup/encrypted.
  console.warn('[backup] Backup POLOS (tidak terenkripsi) diunduh oleh ' + (req.user && req.user.email ? req.user.email : 'admin'));
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(buildBackupPayload());
});

// Backup terenkripsi AES-256-GCM. Dipakai tombol utama di panel admin.
app.post('/api/admin/backup/encrypted', auth, (req, res) => {
  try {
    const passphrase = String((req.body && req.body.passphrase) || '');
    if (passphrase.length < 8) {
      return res.status(400).json({ error: 'Passphrase minimal 8 karakter (semakin panjang semakin aman).' });
    }
    const envelope = encryptBackupPayload(buildBackupPayload(), passphrase);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(envelope);
  } catch (e) {
    console.error('[backup] enkripsi gagal:', e.message);
    res.status(500).json({ error: 'Gagal membuat backup terenkripsi: ' + e.message });
  }
});

app.post('/api/admin/restore', auth, restoreJsonParser, (req, res) => {
  try {
    // Backup terenkripsi: buka dulu dengan passphrase yang dikirim klien.
    // Salt/IV/tag/ciphertext tidak bisa dipalsukan (GCM), dan passphrase
    // salah akan ditolak di sini sebelum data apa pun disentuh.
    let body = req.body || {};
    if (body && body.format === BACKUP_ENC_FORMAT) {
      try {
        const decrypted = decryptBackupEnvelope(body, body.passphrase);
        // Mode & opsi dikirim di sisi luar envelope supaya file tetap bisa
        // dipakai lintas versi.
        decrypted.mode = body.mode || decrypted.mode;
        decrypted.sync_reservations = body.sync_reservations;
        body = decrypted;
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    const { reservations = [], receipts = [], settings, mode = 'append', sync_reservations } = body;
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
      // Password admin = satu-satunya kunci ke data pasien (nama, alamat,
      // nomor WhatsApp, bukti transfer). Minimal 10 karakter.
      if (new_password.length < 10) {
        return res.status(400).json({ error: 'Password baru minimal 10 karakter' });
      }
      if (bcrypt.compareSync(new_password, admin.password_hash)) {
        return res.status(400).json({ error: 'Password baru tidak boleh sama dengan yang lama' });
      }
      updates.password_hash = bcrypt.hashSync(new_password, 12);
      updates.password_changed_at = new Date().toISOString();
    }

    if (!Object.keys(updates).length) {
      // JANGAN kirim objek admin mentah — di dalamnya ada password_hash.
      // Kirim hanya field yang boleh dilihat klien.
      return res.json({
        ok: true,
        changed: false,
        user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }
      });
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
      // Ganti email ATAU password sama-sama mengharuskan login ulang:
      // sesi lama otomatis dicabut oleh middleware auth.
      requires_relogin: !!(updates.email || updates.password_hash)
    });
  } catch (e) {
    console.error('profile update error:', e);
    res.status(500).json({ error: 'Gagal update profil: ' + e.message });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));



// ===== AI BOOKING ASSISTANT =====
// Rapikan balasan AI sebelum dikirim ke klien / WhatsApp.
//
// Kenapa perlu: model (Gemini/OpenRouter) kadang menjawab dengan HTML —
// mis. `<a href="https://wa.me/0858...">https://wa.me/0858...</a>`. Di
// widget chat HTML itu ter-escape lalu dirusak oleh linkifier sehingga
// pembaca melihat potongan tag (`wa.me/0858..." target="_blank"...`),
// dan di WhatsApp tag HTML memang tidak didukung sama sekali.
//
// Di sini tag dibuang dan teks dikembalikan ke bentuk polos; URL tetap
// utuh sehingga klien bisa menjadikannya tautan dan WhatsApp tetap
// menampilkannya sebagai teks yang bisa diketuk.
function sanitizeAIReply(text) {
  return String(text == null ? '' : text)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\u2022 ')
    // <a href="X">Label</a> -> "Label (X)" supaya tautan tidak hilang saat
    // tag dibuang (mis. <a href="https://wa.me/628...">WhatsApp</a>).
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const clean = String(label).replace(/<[^>]*>/g, '').trim();
      const url = String(href).trim();
      if (clean && clean !== url) return clean + ' (' + url + ')';
      return clean || url;
    })
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const AI_DEFAULT_PERSONA = `Kamu adalah Adzkiya Assistant, customer service AI untuk klinik home-service Adzkiya Mom Baby Care di Cilacap.\n\nTugas kamu:\n1. Menyapa customer dengan hangat dalam Bahasa Indonesia\n2. Membantu memilih layanan yang sesuai dari katalog\n3. Memberi info harga, jam operasional, dan area layanan\n4. Membantu booking: tanyakan tanggal & jam yang diinginkan, lalu arahkan customer untuk konfirmasi via WhatsApp ke admin\n\nAturan penting:\n- Jawab singkat (max 3-4 kalimat per pesan)\n- Gunakan emoji secukupnya (🌸 untuk sapaan, ✅ untuk konfirmasi)\n- SELALU akhiri dengan pertanyaan untuk lanjutkan percakapan\n- JANGAN sebut harga detail kecuali customer tanya\n- JANGAN janjikan booking tanpa admin confirmation\n- Untuk finalisasi booking, arahkan ke WhatsApp admin\n\nFormat jawaban (WAJIB):\n- Tulis TEKS BIASA saja, JANGAN pakai HTML atau tag apa pun\n  (jangan tulis <a href=\"...\">, <br>, <b>, dan sejenisnya)\n- Tulis tautan apa adanya, contoh: https://wa.me/6285887018194\n- JANGAN pakai format markdown seperti [teks](tautan)\n\n
Kalau customer ingin booking, kumpulkan 6 data ini (satu per satu, ramah): NAMA lengkap pasien, NOMOR WhatsApp, ALAMAT lengkap, LAYANAN yang diinginkan (harus ada di katalog), TANGGAL layanan (format YYYY-MM-DD), dan JAM layanan (format HH:MM).\n\nSetelah KEENAM data benar-benar lengkap dan customer setuju, tulis ringkasan singkat lalu akhiri balasan dengan satu blok data yang dibuka dengan [[BOOKING]] dan ditutup dengan [[/BOOKING]].\nIsi blok itu HANYA berupa JSON satu baris dengan kunci: patient_name, whatsapp, address, items (daftar objek berisi name dan qty), dan slots (daftar objek berisi date dan time).\nWAJIB: seluruh nilai diisi data ASLI dari percakapan — jangan pernah menulis contoh, kata sandi, atau teks seperti Nama Lengkap / 0812xxxxxxx / YYYY-MM-DD / HH:MM / Nama Layanan.\nKalau ada data yang belum lengkap, JANGAN kirim blok itu; tanyakan dulu yang kurang.- Kalau ada data yang belum lengkap, JANGAN kirim blok; tanyakan yang kurang.`;

// Ringkas harga: 80000 -> "80rb" (hemat token, tetap jelas bagi model).
function shortPrice(v) {
  const n = Number(v) || 0;
  if (n >= 1000000) return (n / 1000000).toString().replace('.', ',') + 'jt';
  if (n >= 1000) return Math.round(n / 1000) + 'rb';
  return String(n);
}

// Cache prompt sistem. Dibangun ulang hanya bila data yang dipakai berubah,
// sehingga permintaan berikutnya tidak perlu menyusun ulang string besar.
let _aiPromptCache = { sig: null, text: '' };
function aiPromptSignature(s) {
  return JSON.stringify([
    s.ai_assistant_base_prompt || '',
    s.business_name || '', s.address || '', s.phone || '',
    Array.isArray(s.hours) ? s.hours : [],
    SERVICES.length,
    SERVICES[0] && SERVICES[0].items ? SERVICES[0].items.length : 0
  ]);
}

// Riwayat yang dikirim ke model: hanya beberapa pesan terakhir dan
// dipotong pendek. Semakin sedikit token masuk, semakin cepat jawaban.
const AI_HISTORY_MAX = 6;
const AI_HISTORY_CHAR_LIMIT = 400;
function trimAIHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-AI_HISTORY_MAX)
    .map(h => ({
      role: h && h.role === 'assistant' ? 'assistant' : 'user',
      content: String((h && h.content) || '').slice(0, AI_HISTORY_CHAR_LIMIT)
    }))
    .filter(m => m.content);
}

// ===== RESERVASI OTOMATIS DARI CHAT AI =====
//
// Cara kerja: persona AI diinstruksikan mengumpulkan data booking (nama,
// WhatsApp, alamat, layanan, tanggal, jam). Setelah lengkap, AI menutup
// balasannya dengan blok mesin-terbaca:
//
//   [[BOOKING]]{"patient_name":"...","whatsapp":"...","address":"...",
//               "items":[{"name":"Massage Ibu Hamil","qty":1}],
//               "slots":[{"date":"2026-09-25","time":"09:00"}]}[[/BOOKING]]
//
// Server mem-parsing blok itu, MEMVALIDASI ulang seluruh isinya (harga selalu
// diambil dari katalog server, jadwal & hari libur dicek, identitas wajib),
// lalu membuat reservasi sehingga langsung muncul di panel admin.
//
// Prinsip keamanan yang dipegang:
//   • Teks dari AI TIDAK dipercaya. Semua nilai divalidasi seperti form publik.
//   • Harga tidak pernah dari AI — selalu dari SERVICE_PRICE_BY_NAME.
//   • Ada batas jumlah booking per IP dan per sesi, jadi tidak bisa dipakai
//     untuk membanjiri data admin (spam).
//   • Blok mentah dibuang dari balasan yang dilihat pengunjung.
const AI_BOOKING_MAX_PER_IP_PER_HOUR = 3;
const AI_BOOKING_MAX_PER_SESSION = 3;
const aiBookingHits = new Map(); // key -> { count, resetAt }

function aiBookingRateCheck(key, max) {
  const now = Date.now();
  const cur = aiBookingHits.get(key);
  if (!cur || now > cur.resetAt) {
    aiBookingHits.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return { ok: true };
  }
  if (cur.count >= max) {
    return { ok: false, retryAfterMin: Math.max(1, Math.ceil((cur.resetAt - now) / 60000)) };
  }
  cur.count += 1;
  return { ok: true };
}
// Bersihkan peta pembatas berkala supaya tidak tumbuh tanpa batas.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of aiBookingHits) if (v.resetAt < now) aiBookingHits.delete(k);
}, 30 * 60 * 1000);

// Ambil blok booking dari balasan AI. Mengembalikan { clean, data|raw, error }.
function extractAISBooking(reply) {
  const text = String(reply == null ? '' : reply);
  const re = /\[\[BOOKING\]\]([\s\S]*?)\[\[\/BOOKING\]\]/i;
  const m = text.match(re);
  if (!m) return { clean: text, data: null, error: null };
  // Balasan untuk pengunjung tanpa blok mesin + tanpa baris kosong berlebih.
  const clean = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim() || text.replace(re, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(String(m[1]).trim());
  } catch (e) {
    return { clean, data: null, error: 'blok booking tidak bisa dibaca (JSON tidak valid)' };
  }
  return { clean, data: parsed, error: null };
}

// Deteksi nilai contoh (placeholder) di dalam blok booking.
//
// Kenapa perlu: model bahasa kadang menyalin teks contoh dari instruksinya.
// Tanpa penyaring ini, server mencoba membuat reservasi dengan data palsu
// seperti "Nama Lengkap"/"0812xxxxxxx" lalu menampilkan pesan galat yang
// membingungkan ke pengunjung. Blok seperti itu cukup diabaikan.
const AI_BOOKING_PLACEHOLDER_RE = /(nama lengkap|alamat lengkap|nama layanan|x{4,}|yyyy-mm-dd|hh:mm|nomor_wa|contoh|example|placeholder|\[\])/i;
function looksLikePlaceholderBooking(obj) {
  let text = '';
  try { text = JSON.stringify(obj || {}); } catch (e) { return true; }
  return AI_BOOKING_PLACEHOLDER_RE.test(text);
}

// Validasi + bangun data reservasi dari isi blok. Mengembalikan
// { ok: true, reservation } atau { ok: false, error }.
function buildReservationFromAIData(data) {
  if (!data || typeof data !== 'object') return { ok: false, error: 'data booking kosong' };

  const patient_name = String(data.patient_name || data.nama || '').trim().slice(0, 150);
  if (patient_name.length < 2) return { ok: false, error: 'nama pasien belum lengkap' };

  const whatsapp = String(data.whatsapp || data.wa || data.phone || '').replace(/[^\d+\-\s()]/g, '').trim().slice(0, 30);
  const waDigits = whatsapp.replace(/\D/g, '');
  if (waDigits.length < 9 || waDigits.length > 15) return { ok: false, error: 'nomor WhatsApp tidak valid (butuh 9-15 angka)' };

  const address = String(data.address || data.alamat || '').trim().slice(0, 1000);
  if (address.length < 5) return { ok: false, error: 'alamat belum lengkap' };

  // Layanan: nama dicocokkan ke katalog server (toleran terhadap spasi/huruf
  // besar-kecil). Harga SELALU dari katalog, bukan dari AI.
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (!rawItems.length) return { ok: false, error: 'layanan belum dipilih' };
  const items = [];
  for (const it of rawItems.slice(0, 20)) {
    const name = String((it && (it.name || it.layanan)) || '').trim();
    if (!name) continue;
    let price = SERVICE_PRICE_BY_NAME.get(name);
    if (!Number.isFinite(price)) {
      const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const target = norm(name);
      for (const [catName, catPrice] of SERVICE_PRICE_BY_NAME) {
        if (norm(catName) === target) { price = catPrice; break; }
      }
      // Pencocokan sebagian: hanya bila unik, supaya tidak salah layanan.
      if (!Number.isFinite(price)) {
        const hits = [...SERVICE_PRICE_BY_NAME.entries()].filter(([n]) => norm(n).includes(target) || target.includes(norm(n)));
        if (hits.length === 1) price = hits[0][1];
      }
    }
    if (!Number.isFinite(price)) return { ok: false, error: 'layanan "' + name + '" tidak ada di katalog' };
    const qty = Math.min(20, Math.max(1, parseInt(it && it.qty, 10) || 1));
    items.push({ name, price, qty });
  }
  if (!items.length) return { ok: false, error: 'layanan belum dipilih' };

  // Jadwal: minimal 1, format tanggal & jam ketat, tidak boleh masa lalu.
  const rawSlots = Array.isArray(data.slots) ? data.slots : (Array.isArray(data.jadwal) ? data.jadwal : []);
  if (!rawSlots.length) return { ok: false, error: 'tanggal/jam belum ditentukan' };
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  let slots = rawSlots.slice(0, 14).map((sl) => ({
    date: String((sl && sl.date) || '').slice(0, 10).trim(),
    time: String((sl && sl.time) || '').slice(0, 5).trim()
  }));
  if (!slots.every((sl) => datePattern.test(sl.date) && timePattern.test(sl.time))) {
    return { ok: false, error: 'format tanggal/jam tidak valid (YYYY-MM-DD dan HH:MM)' };
  }
  slots = slots.filter((sl, i) => slots.findIndex((x) => x.date === sl.date && x.time === sl.time) === i);
  const todayJak = todayJakarta();
  if (slots.some((sl) => sl.date < todayJak)) {
    return { ok: false, error: 'tanggal sudah lewat, minta pelanggan memilih tanggal berikutnya' };
  }
  const blackoutSet = new Set((DB.settings && DB.settings.blackout_dates) || []);
  const blackout = slots.find((sl) => blackoutSet.has(sl.date));
  if (blackout) {
    const note = (DB.settings.blackout_notes && DB.settings.blackout_notes[blackout.date]) || '';
    return { ok: false, error: 'tanggal ' + blackout.date + ' hari libur' + (note ? ' (' + note + ')' : '') };
  }

  // Cegah reservasi kembar untuk orang yang sama pada waktu yang sama.
  const dupe = DB.reservations.find((r) =>
    String(r.patient_name || '').toLowerCase() === patient_name.toLowerCase() &&
    (r.reservation_date || '') === slots[0].date &&
    (r.reservation_time || '') === slots[0].time &&
    (r.status || '') !== 'rejected'
  );
  if (dupe) return { ok: false, error: 'duplicate', existing_id: dupe.id };

  const itemSum = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const total = itemSum * slots.length;
  const id = nextId('reservations');
  const method = ['COD', 'Transfer', 'QRIS'].includes(data.payment_method) ? data.payment_method : 'COD';
  const rec = {
    id,
    patient_name,
    whatsapp,
    address,
    items,
    slots,
    item_total: itemSum,
    total,
    service_name: items.map((it) => it.name).join(', '),
    service_price: itemSum,
    qty: slots.length,
    reservation_date: slots[0].date,
    reservation_time: slots[0].time,
    payment_method: method,
    proof_mime: null,
    proof_b64: null,
    notes: String(data.notes || '').slice(0, 500) || 'Dibuat otomatis oleh AI Assistant',
    status: 'pending',
    payment_status: 'unpaid',
    created_at: new Date().toISOString(),
    // Penanda asal data supaya admin tahu ini bukan dari form publik.
    source: 'ai_chat'
  };
  return { ok: true, reservation: rec };
}

// Ekstraksi + validasi + simpan. Dipakai chat web DAN webhook WhatsApp.
// Mengembalikan { clean, booking } — booking berisi ringkasan untuk klien/log.
function processAISBooking(rawReply, ctx) {
  const extracted = extractAISBooking(rawReply);
  const clean = extracted.clean;
  if (!extracted.data) {
    return {
      clean,
      booking: extracted.error
        ? { created: false, reason: extracted.error }
        : null
    };
  }
  if (looksLikePlaceholderBooking(extracted.data)) {
    // Salinan contoh/placeholder -> abaikan tanpa pesan galat ke pengunjung.
    return { clean, booking: { created: false, reason: 'data belum lengkap' } };
  }
  const built = buildReservationFromAIData(extracted.data);
  if (!built.ok) {
    console.warn('[ai-booking] ditolak:', built.error);
    return { clean, booking: { created: false, reason: built.error, existing_id: built.existing_id || null } };
  }
  const context = ctx || {};
  const ipKey = 'ip:' + (context.ip || 'unknown');
  const sessionKey = 'ses:' + (context.sessionId || 'unknown');
  const ipOk = aiBookingRateCheck(ipKey, AI_BOOKING_MAX_PER_IP_PER_HOUR);
  if (!ipOk.ok) {
    return { clean, booking: { created: false, reason: 'batas booking per jam tercapai', retry_after_min: ipOk.retryAfterMin } };
  }
  const sesOk = aiBookingRateCheck(sessionKey, AI_BOOKING_MAX_PER_SESSION);
  if (!sesOk.ok) {
    return { clean, booking: { created: false, reason: 'batas booking per percakapan tercapai', retry_after_min: sesOk.retryAfterMin } };
  }

  const rec = built.reservation;
  rec.channel = context.channel || 'web';
  DB.reservations.push(rec);
  save();
  console.log(`[ai-booking] reservasi #${rec.id} dibuat via ${rec.channel} (${rec.patient_name}, ${rec.slots.length} sesi, Rp${rec.total})`);
  return {
    clean,
    booking: {
      created: true,
      id: rec.id,
      patient_name: rec.patient_name,
      whatsapp: rec.whatsapp,
      service_name: rec.service_name,
      slots: rec.slots,
      total: rec.total,
      payment_method: rec.payment_method,
      channel: rec.channel
    }
  };
}

function buildAISystemPrompt() {
  const s = DB.settings || {};
  const sig = aiPromptSignature(s);
  if (_aiPromptCache.sig === sig) return _aiPromptCache.text;

  // Katalog dipadatkan: satu baris per kategori (bukan satu baris per
  // layanan) supaya prompt lebih pendek tanpa kehilangan info harga.
  const servicesList = SERVICES.map(cat => {
    const items = cat.items.map(i => `${i.name} ${shortPrice(i.price)}`).join('; ');
    return `${cat.cat}: ${items}`;
  }).join('\n');
  const hours = (s.hours || []).map(h => `${h.day}: ${h.closed ? 'Tutup' : `${h.open}-${h.close}`}`).join(', ');
  const userPrompt = (DB.settings.ai_assistant_base_prompt || '').trim();
  const waNumber = waNumberFor(s.phone, '6285887018194');

  const text = [
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
    `- Jawab SINGKAT: maksimal 2 kalimat (maksimal 40 kata). Jangan bertele-tele.\n- Jika customer minta booking, kumpulkan: nama layanan, tanggal (YYYY-MM-DD), jam (HH:MM), nama customer, WhatsApp, alamat.\n- Setelah lengkap, balas ringkasan singkat + link WhatsApp: https://wa.me/${waNumber}\n- JANGAN mengarang harga. Pakai harga dari katalog di atas (mis. 80rb = Rp80.000).\n- JANGAN menerima pembayaran. Booking selalu difinalkan via WhatsApp admin.`
  ].join('\n');

  _aiPromptCache = { sig, text };
  return text;
}
// --- Provider: Google Gemini ---
// Kandidat model Gemini, diurutkan dari yang paling diinginkan.
// Dipakai bila pencarian model otomatis (ListModels) tidak bisa dijalankan.
// Model akan terus berganti dari waktu ke waktu — itulah alasan daftar ini
// ada dan kenapa 404 TIDAK boleh langsung dianggap gagal total.
const GEMINI_MODEL_CANDIDATES = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];
const GEMINI_LIST_TTL_MS = 6 * 60 * 60 * 1000;
let geminiModelCache = { key: null, model: null, at: 0, available: null, lastError: null };

// Skor urutan model Gemini.
//
// Aturan yang dipakai (penting, pernah salah): VERSI terbaru lebih diutamakan
// daripada daftar preferensi statis — kalau tidak, model lawas di daftar
// (mis. gemini-1.5-flash) akan mengalahkan model baru yang benar-benar
// tersedia, dan kita kembali ke masalah 404.
//   • model yang tidak mendukung generateContent (embedding/imagen/tts/…): 0
//   • versi X.Y  -> 100 + X*10 + Y      (3.6 → 136, 2.5 → 125)
//   • alias "latest" tanpa versi        -> 130
//   • flash lebih dipilih daripada pro (lebih cepat & murah): +5 / +0
//   • varian "lite" sedikit di bawah     : -4
//   • preview/exp lebih di bawah stabil  : -15
//   • daftar preferensi hanya sebagai penentu seri: + (8 - posisi)
function scoreGeminiModel(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 0;
  if (/embedding|aqa|imagen|veo|tts|image|native-audio|learnlm|gemma/i.test(n)) return 0;
  if (!/flash|pro|gemini/i.test(n)) return 0;
  let score = 0;
  const ver = n.match(/(\d+)(?:\.(\d+))?/);
  if (ver) score = 100 + parseInt(ver[1], 10) * 10 + parseInt(ver[2] || '0', 10);
  else if (/latest/.test(n)) score = 130;      // alias ke model stabil terbaru
  else score = 90;
  if (/flash/.test(n)) score += 5;
  // Kecepatan: varian "lite" jauh lebih responsif. Default mengutamakan
  // kecepatan (bisa dimatikan lewat pengaturan ai_prefer_fast_model=false).
  const preferFast = (DB.settings && DB.settings.ai_prefer_fast_model) !== false;
  if (/lite/.test(n)) score += preferFast ? 12 : -4;
  if (/preview|exp/.test(n)) score -= 15;
  const explicit = GEMINI_MODEL_CANDIDATES.indexOf(name);
  if (explicit >= 0) score += 8 - explicit;    // hanya penentu seri
  return score;
}
function pickGeminiModel(available) {
  if (!Array.isArray(available) || !available.length) return null;
  // Buang model yang tidak layak (skor 0 = bukan model teks: embedding,
  // imagen, tts, dsb.) supaya tidak pernah dipilih sebagai model chat.
  const usable = available.filter((m) => scoreGeminiModel(m) > 0);
  if (!usable.length) return null;
  return usable.sort((a, b) => scoreGeminiModel(b) - scoreGeminiModel(a))[0];
}

// Tanya ke Google model apa saja yang tersedia untuk kunci ini.
async function listGeminiModels(apiKey) {
  const r = await fetchWithTimeout(
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey),
    {}, 15000
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Gemini ListModels ' + r.status + ': ' + t.slice(0, 160));
  }
  const data = await r.json();
  return (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
}

// Model yang akan dicoba lebih dulu (hasil pencarian otomatis / cache / settings).
let geminiListInflight = null;
async function refreshGeminiModelList(apiKey) {
  // Satu permintaan ListModels saja walau beberapa chat datang bersamaan.
  if (geminiListInflight && geminiListInflight.key === apiKey) return geminiListInflight.promise;
  const promise = listGeminiModels(apiKey)
    .then((available) => {
      const model = pickGeminiModel(available);
      geminiModelCache = { key: apiKey, model, at: Date.now(), available, lastError: null };
      return model;
    })
    .catch((e) => {
      geminiModelCache = { ...geminiModelCache, key: apiKey, lastError: sanitizeDbError(e) };
      return null;
    })
    .finally(() => { geminiListInflight = null; });
  geminiListInflight = { key: apiKey, promise };
  return promise;
}

// Model pertama yang akan dicoba. JALUR CEPAT: kalau kita sudah tahu model
// yang berhasil sebelumnya (memori atau pengaturan), langsung pakai itu —
// tanpa panggilan ListModels, sehingga tidak ada latensi tambahan.
async function resolveGeminiModel(apiKey, opts) {
  const now = Date.now();
  const force = !!(opts && opts.force);
  if (!force) {
    if (geminiModelCache.key === apiKey && geminiModelCache.model && (now - geminiModelCache.at) < GEMINI_LIST_TTL_MS) {
      return geminiModelCache.model;
    }
    const saved = DB.settings && DB.settings.ai_gemini_model;
    if (saved) return saved;
  }
  const discovered = await refreshGeminiModelList(apiKey);
  return discovered || (DB.settings && DB.settings.ai_gemini_model) || GEMINI_MODEL_CANDIDATES[0];
}

// Daftar model yang akan dicoba berurutan (tanpa duplikat).
//
// Urutan penting: hasil deteksi LANGSUNG dari API didahulukan, karena itulah
// model yang benar-benar tersedia untuk kunci ini. Daftar statis hanya
// cadangan terakhir — kalau statis dipakai lebih dulu, model yang sudah
// dihentikan (mis. gemini-1.5-flash) akan dicoba lagi dan mengulang 404.
function geminiCandidates(primary) {
  const live = (geminiModelCache.available || [])
    .slice()
    .sort((a, b) => scoreGeminiModel(b) - scoreGeminiModel(a));
  const list = [];
  [primary, ...live, DB.settings && DB.settings.ai_gemini_model, ...GEMINI_MODEL_CANDIDATES]
    .forEach((m) => { if (m && list.indexOf(m) < 0) list.push(m); });
  return list;
}

// Redaksi khusus pesan galat provider AI: buang kredensial (parameter key,
// Bearer token, connection string) TANPA mengubah nama model. sanitizeDbError
// terlalu agresif untuk teks ini — nama seperti "gemini-flash-lite-latest"
// (24 karakter) ikut berubah jadi "***" sehingga pesan galat tidak informatif.
function sanitizeAIError(err) {
  return String((err && err.message) || err || 'unknown')
    .replace(/([?&]key=)[^&\s]+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/\/\/[^@\s/]+@/g, '//***@')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}\b/g, 'AIza***')
    .replace(/\bsk-or-v1-[A-Za-z0-9-]{8,}\b/g, 'sk-or-v1-***')
    .replace(/\bEAA[A-Za-z0-9]{20,}\b/g, 'EAA***')
    .slice(0, 240);
}

function isModelUnavailable(status, message) {
  const text = String(message || '').toLowerCase();
  if (status === 404) return true;
  return /not found|no longer available|is not supported|does not exist|deprecat|retire|unsupported model/.test(text);
}

// Timeout per percobaan model. Lebih pendek dari sebelumnya (30s) karena
// permintaan chat yang menggantung lama membuat pengunjung mengira bot mati;
// kalau model pertama lambat, kandidat berikutnya diambil alih.
const AI_GEMINI_TIMEOUT_MS = 15000;
// Batas token keluaran. Jawaban CS cukup pendek; token keluaran adalah
// penyumbang terbesar waktu tunggu (model menulis token satu per satu).
const AI_MAX_OUTPUT_TOKENS = 320;

async function callGemini(systemPrompt, messages, opts) {
  const apiKey = DB.settings.ai_gemini_api_key;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const signal = opts && opts.signal;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  // Always prepend system prompt as first user+model exchange
  contents.unshift({ role: 'user', parts: [{ text: systemPrompt }] });
  contents.unshift({ role: 'model', parts: [{ text: 'Siap membantu customer Adzkiya.' }] });

  const primary = await resolveGeminiModel(apiKey);
  const candidates = geminiCandidates(primary).slice(0, 6);
  const errors = [];
  let sawUnavailable = false;

  for (const model of candidates) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    let r, text = '';
    try {
      r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.55,
            topP: 0.9,
            maxOutputTokens: AI_MAX_OUTPUT_TOKENS
          }
        })
      }, AI_GEMINI_TIMEOUT_MS, signal);
    } catch (e) {
      if (signal && signal.aborted) throw new Error('dibatalkan (provider lain sudah menjawab)');
      errors.push(model + ': ' + sanitizeAIError(e));
      continue;
    }
    if (!r.ok) {
      text = await r.text().catch(() => '');
      errors.push(model + ' (' + r.status + '): ' + text.slice(0, 120));
      if (isModelUnavailable(r.status, text)) sawUnavailable = true;
      // Model dihentikan / tidak dikenal -> coba kandidat berikutnya.
      // Kuota/layanan penuh (429/503) juga dicoba ke model lain.
      if (isModelUnavailable(r.status, text) || r.status === 429 || r.status === 503) continue;
      continue;
    }
    const data = await r.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    // Balasan kosong / hanya berisi tag HTML setelah dibersihkan diperlakukan
    // sebagai kegagalan: kalau diteruskan, pengunjung melihat gelembung chat
    // kosong (dan di WhatsApp, pesan kosong) tanpa penjelasan.
    const cleanReply = sanitizeAIReply(reply);
    if (!cleanReply) { errors.push(model + ': balasan kosong'); continue; }
    // Ingat model yang berhasil supaya permintaan berikutnya langsung tepat.
    if (geminiModelCache.model !== model) {
      geminiModelCache = { ...geminiModelCache, key: apiKey, model, at: Date.now() };
    }
    if (DB.settings.ai_gemini_model !== model) {
      DB.settings.ai_gemini_model = model;
      save();
    }
    return { reply: cleanReply, model };
  }

  // Semua kandidat 404 (model lama dihentikan, katalog berubah?): ambil
  // daftar terbaru dari API SEKALI, lalu coba model teratasnya.
  if (sawUnavailable) {
    const fresh = await refreshGeminiModelList(apiKey);
    if (fresh && candidates.indexOf(fresh) < 0) {
      try {
        const url2 = 'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(fresh) + ':generateContent?key=' + encodeURIComponent(apiKey);
        const r2 = await fetchWithTimeout(url2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.55, topP: 0.9, maxOutputTokens: AI_MAX_OUTPUT_TOKENS }
          })
        }, AI_GEMINI_TIMEOUT_MS, signal);
        if (r2.ok) {
          const d2 = await r2.json();
          const reply2 = sanitizeAIReply(d2.candidates?.[0]?.content?.parts?.[0]?.text);
          if (reply2) {
            if (DB.settings.ai_gemini_model !== fresh) { DB.settings.ai_gemini_model = fresh; save(); }
            return { reply: reply2, model: fresh };
          }
        } else {
          errors.push(fresh + ' (' + r2.status + ', daftar terbaru)');
        }
      } catch (e) {
        errors.push(fresh + ': ' + sanitizeAIError(e));
      }
    }
  }
  throw new Error('Semua model Gemini gagal — ' + errors.join(' | '));
}

// --- Provider: OpenRouter (fallback) ---
// Kandidat model OpenRouter (diurutkan). Sama seperti Gemini: nama model
// bisa dihentikan penyedia, jadi 404 tidak boleh dianggap gagal total.
// ===== OPENROUTER =====
//
// Model berbayar pertama (kualitas terbaik) lalu — bila akun belum punya
// kredit — otomatis pindah ke model GRATIS.
//
// Kenapa: OpenRouter membalas HTTP 402 "Insufficient credits. This account
// never purchased credits." untuk semua model berbayar bila akun belum pernah
// membeli kredit. Sebelumnya itu membuat OpenRouter selalu gagal sehingga
// perannya sebagai cadangan Gemini tidak pernah berfungsi. OpenRouter
// menyediakan banyak model berakhiran `:free` yang bisa dipakai tanpa kredit
// (dengan batas laju lebih ketat).
const OPENROUTER_MODEL_CANDIDATES = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.0-flash-001',
  'openrouter/auto'
];

// Cadangan statis bila daftar model dari API tidak bisa diambil.
// (Daftar model gratis OpenRouter berubah dari waktu ke waktu, jadi ini hanya
//  jaring terakhir — sumber utamanya adalah hasil pemindaian API.)
const OPENROUTER_FREE_FALLBACKS = [
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-3.2-24b-instruct:free'
];

// Keluarga model yang biasanya paling baik untuk CS berbahasa Indonesia.
const OPENROUTER_FREE_PREFERRED = ['gemini', 'llama-3.3', 'llama-3.1', 'deepseek', 'qwen', 'mistral', 'phi'];

function isOpenRouterFree(model) {
  const id = String((model && model.id) || model || '');
  if (/:free$/i.test(id)) return true;
  const p = (model && model.pricing) || null;
  if (!p) return false;
  const zero = (v) => v === 0 || v === '0' || parseFloat(v) === 0;
  return zero(p.prompt) && zero(p.completion);
}

function scoreOpenRouterFree(model) {
  const id = String((model && model.id) || '').toLowerCase();
  // Bukan model teks (embedding/moderasi/audio/gambar) -> jangan dipakai chat.
  if (/embed|moderation|whisper|tts|audio|image|vision-only|rerank/.test(id)) return 0;
  let score = 50;
  const fam = OPENROUTER_FREE_PREFERRED.findIndex((f) => id.includes(f));
  if (fam >= 0) score += 40 - fam * 5;
  if (/instruct|chat/.test(id)) score += 10;
  const ctx = Number((model && model.context) || 0);
  if (ctx >= 1000000) score += 20;
  else if (ctx >= 128000) score += 15;
  else if (ctx >= 32000) score += 8;
  if (/70b|72b|32b|27b|24b|13b|12b/.test(id)) score += 6;
  return score;
}

// Daftar model OpenRouter (endpoint publik, tidak butuh kunci). Dipakai untuk
// menemukan model gratis yang sedang tersedia — pengganti daftar statis.
let orModelsCache = { at: 0, models: [], error: null };
let orModelsInflight = null;
async function listOpenRouterModels(force) {
  const now = Date.now();
  if (!force && orModelsCache.models && orModelsCache.models.length && (now - orModelsCache.at) < GEMINI_LIST_TTL_MS) {
    return orModelsCache.models;
  }
  if (orModelsInflight) return orModelsInflight;
  orModelsInflight = (async () => {
    try {
      const r = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {}, 12000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const models = (data && data.data ? data.data : []).map((m) => ({
        id: m.id,
        context: m.context_length || (m.top_provider && m.top_provider.context_length) || 0,
        free: isOpenRouterFree(m)
      }));
      orModelsCache = { at: Date.now(), models, error: null };
      return models;
    } catch (e) {
      orModelsCache = { ...orModelsCache, error: sanitizeAIError(e) };
      return orModelsCache.models || [];
    } finally {
      orModelsInflight = null;
    }
  })();
  return orModelsInflight;
}

async function openRouterFreeCandidates(limit) {
  const max = limit || 4;
  const models = await listOpenRouterModels();
  const discovered = models
    .filter((m) => m.free && scoreOpenRouterFree(m) > 0)
    .sort((a, b) => scoreOpenRouterFree(b) - scoreOpenRouterFree(a))
    .map((m) => m.id);
  const list = [];
  discovered.concat(OPENROUTER_FREE_FALLBACKS).forEach((m) => { if (m && list.indexOf(m) < 0) list.push(m); });
  return list.slice(0, max);
}

// Kesehatan OpenRouter (di memori, tidak perlu disimpan ke disk).
// Dipakai supaya hedging tidak memanggil provider yang jelas-jelas bermasalah.
let openRouterHealth = { status: 'unknown', at: 0, detail: null };
function markOpenRouter(status, detail) {
  openRouterHealth = { status, at: Date.now(), detail: detail ? sanitizeAIError(detail) : null };
}
function openRouterKeyUsable() {
  // Kunci ditolak (401) -> jangan buang waktu memanggil ulang beberapa menit.
  return !(openRouterHealth.status === 'bad_key' && Date.now() - openRouterHealth.at < 5 * 60 * 1000);
}

async function callOpenRouter(systemPrompt, messages, opts) {
  const apiKey = DB.settings.ai_openrouter_api_key;
  if (!apiKey) throw new Error('OpenRouter API key not configured');
  if (!openRouterKeyUsable()) {
    throw new Error('Kunci OpenRouter ditolak pada percobaan sebelumnya. Perbarui kunci di panel admin.');
  }

  const oaMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  // Mode hemat: dipakai saat akun OpenRouter belum punya kredit (402) atau
  // ketika admin menyalakan "hanya model gratis".
  //
  // PEMULIHAN OTOMATIS: bila mode hemat dinyalakan otomatis lebih dari 24 jam
  // lalu, coba lagi model berbayar sekali. Begitu admin menambah kredit di
  // OpenRouter, sistem kembali ke model terbaik dengan sendirinya tanpa harus
  // ingat mematikan centangnya. Kalau masih 402, mode hemat dinyalakan lagi.
  const saved = DB.settings.ai_openrouter_model || '';
  const freeOnlyFlagAt = DB.settings.ai_openrouter_free_only_at ? new Date(DB.settings.ai_openrouter_free_only_at).getTime() : 0;
  const freeOnlyStale = !!(freeOnlyFlagAt && (Date.now() - freeOnlyFlagAt) > 24 * 60 * 60 * 1000);
  const freeOnly = (DB.settings.ai_openrouter_free_only === true && !freeOnlyStale)
    || openRouterHealth.status === 'no_credits';

  const candidates = [];
  const add = (m) => { if (m && candidates.indexOf(m) < 0) candidates.push(m); };

  // Jalur cepat: model yang sudah terbukti berhasil dipakai lebih dulu
  // (tanpa memanggil daftar model) supaya latensi tetap rendah.
  if (saved && (!freeOnly || isOpenRouterFree(saved))) add(saved);
  if (!freeOnly) OPENROUTER_MODEL_CANDIDATES.forEach(add);
  // Model gratis selalu disiapkan sebagai cadangan (berbayar hanya sebagai
  // pilihan pertama ketika akun punya kredit).
  (await openRouterFreeCandidates(4)).forEach(add);

  const errors = [];
  for (const model of candidates.slice(0, 6)) {
    let r, text = '';
    try {
      r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'HTTP-Referer': 'https://putra1996.github.io/Adzkiyamombabycareweb',
          'X-Title': 'Adzkiya Mom Baby Care'
        },
        body: JSON.stringify({
          model,
          messages: oaMessages,
          max_tokens: AI_MAX_OUTPUT_TOKENS,
          temperature: 0.55,
          // Minta OpenRouter memilih penyedia dengan throughput tertinggi
          // (token/detik) supaya jawaban datang lebih cepat.
          provider: { sort: 'throughput' }
        })
      }, AI_GEMINI_TIMEOUT_MS, opts && opts.signal);
    } catch (e) {
      if (opts && opts.signal && opts.signal.aborted) throw new Error('dibatalkan (provider lain sudah menjawab)');
      errors.push(model + ': ' + sanitizeAIError(e));
      continue;
    }

    if (!r.ok) {
      text = await r.text().catch(() => '');
      errors.push(model + ' (' + r.status + '): ' + text.slice(0, 120));

      // 401 -> kunci salah/dicabut. Tidak ada gunanya mencoba model lain.
      if (r.status === 401) {
        markOpenRouter('bad_key', text);
        throw new Error('Kunci OpenRouter ditolak (401). Periksa/ Perbarui kunci di panel admin.');
      }
      // 402 -> akun belum punya kredit. Semua model BERBAYAR akan gagal, jadi
      // ingat kondisi ini dan lanjut ke model gratis.
      if (r.status === 402) {
        markOpenRouter('no_credits', text);
        if (!DB.settings.ai_openrouter_free_only || freeOnlyStale) {
          DB.settings.ai_openrouter_free_only = true;
          DB.settings.ai_openrouter_free_only_at = new Date().toISOString();
          console.log('[ai] OpenRouter tanpa kredit — memakai model gratis (:free). Model berbayar akan dicoba lagi dalam 24 jam.');
          save();
        }
        continue;
      }
      // 429 (batas laju model gratis) / 404 (model dihentikan) / 503:
      // coba kandidat berikutnya.
      continue;
    }

    const data = await r.json();
    const cleanReply = sanitizeAIReply(data.choices?.[0]?.message?.content);
    if (!cleanReply) { errors.push(model + ': balasan kosong'); continue; }

    markOpenRouter('ok');
    // Model berbayar berhasil -> kredit tersedia; kembali ke mode normal.
    if (!isOpenRouterFree(model) && DB.settings.ai_openrouter_free_only) {
      DB.settings.ai_openrouter_free_only = false;
      DB.settings.ai_openrouter_free_only_at = null;
      console.log('[ai] OpenRouter kembali memakai model berbayar (kredit tersedia).');
    }
    if (DB.settings.ai_openrouter_model !== model) {
      DB.settings.ai_openrouter_model = model;
      save();
    }
    return { reply: cleanReply, model, free: isOpenRouterFree(model) };
  }

  throw new Error('Semua model OpenRouter gagal — ' + errors.join(' | '));
}
// Try Gemini first, fall back to OpenRouter. Returns { reply, provider }.
async function callAIChat(systemPrompt, messages, opts) {
  const result = await callAIChatInner(systemPrompt, messages, opts);
  // Penjaga terakhir: jangan pernah mengirim balasan kosong ke pengunjung.
  if (!result || !String(result.reply || '').trim()) {
    throw new Error('Provider AI mengembalikan balasan kosong');
  }
  return result;
}

async function callAIChatInner(systemPrompt, messages, opts) {
  const hasGemini = !!DB.settings.ai_gemini_api_key;
  // Kunci OpenRouter yang sudah ditolak (401) tidak dipakai untuk hedging —
  // percuma, dan hanya membuang waktu/kuota. Ia tetap dicoba sebagai
  // cadangan berurutan bila Gemini gagal (gagalnya cepat).
  const hasOpenRouter = !!DB.settings.ai_openrouter_api_key && openRouterKeyUsable();
  const errors = [];
  const signal = opts && opts.signal;

  // Hedging: jalankan OpenRouter sebagai pelari kedua kalau Gemini belum
  // menjawab setelah `ai_hedge_delay_ms` (default 4 detik). Ini memotong
  // waktu tunggu pada kasus Gemini lambat/kuota hampir penuh, tanpa
  // mengorbankan jawaban Gemini yang memang lebih dulu siap.
  if (hasGemini && hasOpenRouter && DB.settings.ai_hedge_openrouter !== false) {
    const hedgeDelay = Math.max(1000, Math.min(10000, parseInt(DB.settings.ai_hedge_delay_ms, 10) || 4000));
    return await new Promise((resolve, reject) => {
      let done = false;
      let active = 0;          // percobaan yang masih berjalan
      let canStart = 2;        // maksimal dua percobaan (Gemini lalu OpenRouter)
      const started = [];
      const timerHolder = { id: null };

      const finish = (provider, r) => {
        if (done) return;
        done = true;
        clearTimeout(timerHolder.id);
        // Batalkan permintaan yang belum selesai supaya kuota tidak terbuang.
        abortOthers(provider);
        resolve({ reply: r.reply, provider, model: r.model, hedged: started.length > 1 });
      };

      const fail = (provider, err) => {
        if (done) return;
        active -= 1;
        errors.push(provider + ': ' + sanitizeAIError(err));
        // Gemini gagal lebih dulu -> langsung jalankan OpenRouter tanpa
        // menunggu jadwal hedging.
        if (provider === 'gemini' && started.indexOf('openrouter') < 0 && canStart > 0) {
          startOpenRouter();
          return;
        }
        // Tolak HANYA bila tidak ada percobaan yang masih berjalan dan tidak
        // ada lagi yang bisa dijalankan. (Sebelumnya: satu kegagalan cepat
        // dari OpenRouter langsung mematikan permintaan walau Gemini masih
        // berjalan — itulah sebabnya pengunjung melihat pesan "gangguan".)
        if (active <= 0 && canStart <= 0) {
          done = true;
          clearTimeout(timerHolder.id);
          reject(new Error('Tidak ada AI provider yang berhasil: ' + errors.join(' | ')));
        }
      };

      const controllers = { gemini: null, openrouter: null };
      const abortOthers = (winner) => {
        Object.keys(controllers).forEach((k) => {
          if (k !== winner && controllers[k]) { try { controllers[k].abort(); } catch {} }
        });
      };

      const startOpenRouter = () => {
        if (started.indexOf('openrouter') >= 0 || done || canStart <= 0) return;
        canStart -= 1;
        active += 1;
        started.push('openrouter');
        controllers.openrouter = new AbortController();
        callOpenRouter(systemPrompt, messages, { signal: controllers.openrouter.signal })
          .then((r) => finish('openrouter', r))
          .catch((e) => fail('openrouter', e));
      };

      canStart -= 1;
      active += 1;
      started.push('gemini');
      controllers.gemini = new AbortController();
      callGemini(systemPrompt, messages, { signal: controllers.gemini.signal })
        .then((r) => finish('gemini', r))
        .catch((e) => fail('gemini', e));

      timerHolder.id = setTimeout(startOpenRouter, hedgeDelay);
    });
  }

  // Hanya satu provider tersedia (atau hedging dimatikan): urutan biasa.
  if (hasGemini) {
    try {
      const r = await callGemini(systemPrompt, messages, { signal });
      return { reply: r.reply, provider: 'gemini', model: r.model };
    } catch (e) { errors.push('Gemini: ' + sanitizeAIError(e)); }
  }
  if (hasOpenRouter) {
    try {
      const r = await callOpenRouter(systemPrompt, messages, { signal });
      return { reply: r.reply, provider: 'openrouter', model: r.model };
    } catch (e) { errors.push('OpenRouter: ' + sanitizeAIError(e)); }
  }
  throw new Error('Tidak ada AI provider yang berhasil: ' + errors.join(' | '));
}
// PUBLIC chat endpoint — used by the chat widget on the landing page
// and (optionally) by the WA webhook handler.
app.post('/api/ai/chat', aiLimiter, async (req, res) => {
  try {
    const { message, history = [], session_id = 'web-' + Date.now() } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message wajib diisi' });
    }
    const trimmed = message.slice(0, 1000);
    if (!DB.settings.ai_assistant_enabled) {
      return res.status(503).json({
        error: 'AI assistant belum diaktifkan. Hubungi admin via WhatsApp untuk booking.',
        fallback_wa: waLinkFor(DB.settings.phone, '6285887018194')
      });
    }
    if (!DB.settings.ai_gemini_api_key && !DB.settings.ai_openrouter_api_key) {
      return res.status(503).json({
        error: 'AI provider belum dikonfigurasi. Hubungi admin via WhatsApp.',
        fallback_wa: waLinkFor(DB.settings.phone, '6285887018194')
      });
    }

    const startedAt = Date.now();
    const systemPrompt = buildAISystemPrompt();
    const messages = [
      ...trimAIHistory(history),
      { role: 'user', content: trimmed }
    ];
    // Batalkan permintaan ke provider bila pengunjung benar-benar pergi.
    //
    // PENTING (pernah salah): jangan memakai `req.on('close')`. Pada Node,
    // event 'close' milik REQUEST menyala segera setelah body dibaca habis
    // (diukur: +0 ms, saat respons belum dikirim), sehingga pembatalan akan
    // mematikan setiap panggilan AI dan bot tidak pernah menjawab.
    // Yang benar: pantau 'close' pada RESPONSE, dan hanya batalkan bila
    // respons belum selesai dikirim (res.writableEnded === false) —
    // itulah tanda pengunjung menutup halaman di tengah proses.
    const clientSignal = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) { try { clientSignal.abort(); } catch {} }
    };
    if (typeof res.on === 'function') res.on('close', onClose);
    let result;
    try {
      result = await callAIChat(systemPrompt, messages, { signal: clientSignal.signal });
    } finally {
      if (typeof res.off === 'function') res.off('close', onClose);
    }
    const latencyMs = Date.now() - startedAt;
    console.log(`[ai/chat] ${result.provider}${result.model ? '/' + result.model : ''} ${latencyMs}ms${result.hedged ? ' (hedged)' : ''}`);

    // Reservasi otomatis: kalau AI sudah mengumpulkan seluruh data booking,
    // blok [[BOOKING]] di balasannya divalidasi ulang lalu disimpan sebagai
    // reservasi (muncul di panel admin dengan status "pending").
    const bookingResult = processAISBooking(result.reply, {
      ip: req.ip,
      sessionId: session_id,
      channel: 'ai_chat'
    });
    const cleanReply = bookingResult.clean;
    const booking = bookingResult.booking;
    if (booking && booking.created) {
      result.reply = cleanReply;
    } else if (cleanReply !== result.reply) {
      result.reply = cleanReply;
    }
    if (booking && !booking.created && booking.reason) {
      // Beri tahu admin kalau AI mengirim data yang ditolak validasi.
      if (booking.reason !== 'duplicate') {
        console.warn('[ai-booking] data booking dari AI ditolak:', booking.reason);
      }
    }
    // Berhasil -> bersihkan catatan kegagalan lama supaya panel tidak
    // menampilkan peringatan yang sudah tidak relevan.
    clearAIError();

    // Log conversation (max 200 entries, ring buffer)
    if (!Array.isArray(DB.settings.ai_assistant_conversations)) DB.settings.ai_assistant_conversations = [];
    DB.settings.ai_assistant_conversations.push({
      session_id,
      channel: 'web',
      ts: new Date().toISOString(),
      user: trimmed,
      assistant: result.reply,
      provider: result.provider,
      model: result.model || null,
      latency_ms: latencyMs,
      booking_id: booking && booking.created ? booking.id : null
    });
    if (DB.settings.ai_assistant_conversations.length > 200) {
      DB.settings.ai_assistant_conversations = DB.settings.ai_assistant_conversations.slice(-200);
    }
    save();

    res.json({
      reply: result.reply,
      provider: result.provider,
      model: result.model || null,
      latency_ms: latencyMs,
      hedged: !!result.hedged,
      booking: booking ? {
        created: !!booking.created,
        id: booking.id || null,
        total: booking.total || null,
        slots: booking.slots || null,
        service_name: booking.service_name || null,
        patient_name: booking.patient_name || null,
        reason: booking.created ? null : (booking.reason || null),
        retry_after_min: booking.retry_after_min || null
      } : null,
      session_id
    });
  } catch (e) {
    const detail = sanitizeAIError(e);
    console.error('[ai/chat] gagal:', detail);
    // Simpan alasan kegagalan agar bisa dilihat di panel admin.
    recordAIError(e);
    res.status(500).json({
      error: 'AI chat gagal: ' + (e.message || 'unknown error'),
      // Alasan teknis (tanpa kredensial) — dipakai panel admin & CLI untuk
      // diagnosa; widget hanya menampilkannya bila dibuka dengan ?debug_ai=1.
      detail,
      fallback_wa: waLinkFor(DB.settings.phone, '6285887018194')
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
app.get('/api/webhook/whatsapp', webhookLimiter, (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = DB.settings.ai_assistant_verify_token || '';
  if (mode === 'subscribe' && token && expectedToken && safeCompare(token, expectedToken)) {
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
app.post('/api/webhook/whatsapp', webhookLimiter, async (req, res) => {
  // SECURITY: kalau admin mengisi App Secret (Meta Dashboard → Settings →
  // Basic → App Secret), verifikasi header X-Hub-Signature-256. Tanpa ini
  // siapa pun yang tahu URL webhook bisa memalsukan pesan masuk,
  // menghabiskan kuota AI, dan memicu kiriman WA keluar ke nomor lain.
  const appSecret = DB.settings.ai_assistant_app_secret;
  if (appSecret) {
    const signature = req.headers['x-hub-signature-256'] || '';
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected = 'sha256=' + require('crypto').createHmac('sha256', appSecret).update(raw).digest('hex');
    if (!safeCompare(signature, expected)) {
      console.warn('[wa-webhook] Signature tidak valid — request ditolak');
      return res.status(403).send('Invalid signature');
    }
  }
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
          // PRIVASI: log Railway dapat dibaca orang lain (operator, pihak
          // ketiga, screenshot support). Jangan pernah menuliskan nomor
          // lengkap atau isi pesan pasien — cukup nomor bertopeng + panjang
          // pesan + nama kecil untuk penelusuran masalah.
          console.log('[wa-webhook] Pesan masuk dari ' + maskPhone(fromPhone) +
            ' (' + (senderName ? senderName.split(' ')[0] : 'tanpa nama') + '), ' + userText.length + ' karakter');

          // Build history-aware context per sender
          const sessionId = 'wa-' + fromPhone;
          const priorHistory = (DB.settings.ai_assistant_conversations || [])
            .filter(c => c.session_id === sessionId)
            .slice(-6)
            .flatMap(c => [
              { role: 'user', content: c.user },
              { role: 'assistant', content: c.assistant }
            ]);
          const messages = [...trimAIHistory(priorHistory), { role: 'user', content: userText.slice(0, 1000) }];
          const systemPrompt = buildAISystemPrompt() +
            (senderName ? `\n\nCustomer ini bernama: ${senderName}` : '');
          const result = await callAIChat(systemPrompt, messages);

          // Reservasi otomatis dari percakapan WhatsApp (data kunci divalidasi
          // sama seperti chat web).
          const waBooking = processAISBooking(result.reply, {
            ip: 'wa:' + fromPhone,
            sessionId,
            channel: 'ai_chat_wa'
          });
          let waReply = waBooking.clean;
          if (waBooking.booking && waBooking.booking.created) {
            waReply += '\n\n✅ Reservasi #' + waBooking.booking.id + ' sudah masuk ke sistem kami. Admin akan mengonfirmasi via WhatsApp ini. Terima kasih 🌸';
          } else if (waBooking.booking && !waBooking.booking.created && waBooking.booking.reason === 'duplicate') {
            waReply += '\n\nℹ️ Reservasi dengan jadwal yang sama sudah tercatat sebelumnya.';
          }
          result.reply = waReply;

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
    console.error('[wa-webhook] Error:', sanitizeAIError(e));
    recordAIError(e);
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

// URL webhook ABSOLUT. Nilai ini yang harus di-paste ke Meta, dan harus
// menunjuk ke server API (Railway) — bukan ke cermin GitHub Pages.
// Sebelumnya /api/admin/ai/config hanya mengirim path relatif dan panel
// admin menebak dari window.location, sehingga saat dibuka dari GitHub
// Pages admin menyalin URL yang SALAH
// (https://putra1996.github.io/Adzkiyamombabycareweb/api/webhook/whatsapp).
function absoluteWebhookUrl(req) {
  // PUBLIC_BASE_URL (kalau diset) selalu menang, lalu X-Forwarded-Host
  // yang dikirim Railway.
  return getPublicBaseUrl(req) + '/api/webhook/whatsapp';
}

// ADMIN: get AI config status (without leaking secrets)
app.get('/api/admin/ai/config', auth, (req, res) => {
  const s = DB.settings;
  res.json({
    enabled: !!s.ai_assistant_enabled,
    has_gemini: !!s.ai_gemini_api_key,
    has_openrouter: !!s.ai_openrouter_api_key,
    has_wa_phone_id: !!s.ai_assistant_phone_id,
    has_wa_token: !!s.ai_assistant_access_token,
    has_app_secret: !!s.ai_assistant_app_secret,
    wa_verify_token: s.ai_assistant_verify_token || '',
    base_prompt: s.ai_assistant_base_prompt || '',
    conversation_count: (s.ai_assistant_conversations || []).length,
    gemini_model: s.ai_gemini_model || null,
    openrouter_model: s.ai_openrouter_model || null,
    readiness: aiReadiness(),
    last_error: s.ai_last_error || null,
    last_error_at: s.ai_last_error_at || null,
    prefer_fast_model: s.ai_prefer_fast_model !== false,
    hedge_openrouter: s.ai_hedge_openrouter !== false,
    openrouter_free_only: s.ai_openrouter_free_only === true,
    openrouter_health: openRouterHealth.status,
    openrouter_health_detail: openRouterHealth.detail,
    openrouter_free_models_cached: (orModelsCache.models || []).filter((m) => m.free).length,
    max_output_tokens: AI_MAX_OUTPUT_TOKENS,
    history_limit: AI_HISTORY_MAX,
    webhook_url: absoluteWebhookUrl(req)
  });
});

// ADMIN: diagnosa koneksi WhatsApp/AI. Menjawab pertanyaan "kenapa
// auto-reply tidak jalan?" tanpa admin harus menebak-nebak:
//   • apakah tiap kredensial sudah diisi,
//   • apakah token Meta masih valid (dites langsung ke Graph API),
//   • apakah webhook sudah dilindungi signature.
// Tidak pernah mengembalikan nilai kredensial.
app.get('/api/admin/ai/diagnostics', auth, async (req, res) => {
  const s = DB.settings || {};
  const phoneId = s.ai_assistant_phone_id || '';
  const accessToken = s.ai_assistant_access_token || '';
  const result = {
    enabled: !!s.ai_assistant_enabled,
    webhook_url: absoluteWebhookUrl(req),
    has_verify_token: !!s.ai_assistant_verify_token,
    has_app_secret: !!s.ai_assistant_app_secret,
    has_gemini: !!s.ai_gemini_api_key,
    has_openrouter: !!s.ai_openrouter_api_key,
    has_phone_id: !!phoneId,
    has_access_token: !!accessToken,
    signature_enforced: !!s.ai_assistant_app_secret,
    conversation_count: (s.ai_assistant_conversations || []).length,
    graph: { checked: false }
  };

  // Tes langsung ke Meta: endpoint ini menjawab dengan nomor & nama bisnis
  // kalau token masih berlaku. Kalau token sudah dicabut/kedaluwarsa,
  // error Meta ditampilkan apa adanya (tanpa nilai token).
  if (phoneId && accessToken) {
    result.graph.checked = true;
    try {
      const r = await fetchWithTimeout(
        'https://graph.facebook.com/v18.0/' + encodeURIComponent(phoneId) +
          '?fields=display_phone_number,verified_name,quality_rating',
        { headers: { Authorization: 'Bearer ' + accessToken } },
        15000
      );
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        result.graph.ok = true;
        result.graph.display_phone_number = data.display_phone_number || null;
        result.graph.verified_name = data.verified_name || null;
      } else {
        result.graph.ok = false;
        result.graph.error = (data && data.error && data.error.message) || ('HTTP ' + r.status);
        result.graph.error_code = (data && data.error && data.error.code) || null;
        result.graph.error_subcode = (data && data.error && data.error.error_subcode) || null;
      }
    } catch (e) {
      result.graph.ok = false;
      result.graph.error = 'Tidak bisa menghubungi Graph API: ' + (e.message || 'network error');
    }
  }

  // Checklist siap tampil supaya admin tahu langkah berikutnya.
  result.checklist = [
    {
      ok: !!s.ai_assistant_enabled,
      label: 'AI Assistant diaktifkan',
      hint: 'Centang "Aktifkan AI Assistant" lalu simpan.'
    },
    {
      ok: !!(s.ai_gemini_api_key || s.ai_openrouter_api_key),
      label: 'Kunci AI tersedia (Gemini / OpenRouter)',
      hint: 'Ambil kunci gratis di aistudio.google.com/apikey lalu tempel di panel ini.'
    },
    {
      ok: !!s.ai_assistant_verify_token,
      label: 'Webhook Verify Token diisi',
      hint: 'Isi string acak apa saja, lalu tempel nilai yang sama di Meta → Webhooks → Verify token.'
    },
    {
      ok: !!phoneId && !!accessToken,
      label: 'Phone Number ID & Access Token WhatsApp diisi',
      hint: 'Ambil dari Meta → WhatsApp → API Setup.'
    },
    {
      ok: !!(result.graph.checked && result.graph.ok),
      label: 'Kredensial WhatsApp diterima Meta',
      hint: result.graph.checked
        ? (result.graph.ok
            ? ('Terhubung ke nomor ' + (result.graph.display_phone_number || '?'))
            : ('Ditolak Meta: ' + (result.graph.error || 'tidak diketahui') + ' — perbarui Access Token.'))
        : 'Isi Phone Number ID + Access Token dulu supaya bisa dites.'
    },
    {
      ok: !!s.ai_assistant_app_secret,
      label: 'App Secret diisi (webhook terlindungi dari pemalsuan)',
      hint: 'Tanpa App Secret, siapa pun yang tahu URL webhook bisa mengirim pesan palsu. Salin dari Meta → Settings → Basic → App Secret.'
    }
  ];

  res.setHeader('Cache-Control', 'private, no-store');
  res.json(result);
});

// ---- STATUS KESIAPAN AI (dipakai widget, panel, dan diagnosa) ----
// Alasan kegagalan terakhir disimpan supaya admin tidak perlu menebak:
// panel menampilkan pesan ini apa adanya (sudah dibersihkan dari kredensial).
function aiReadiness() {
  const s = DB.settings || {};
  if (!s.ai_assistant_enabled) {
    return { ready: false, reason: 'disabled', message: 'AI Assistant belum diaktifkan oleh admin.' };
  }
  if (!s.ai_gemini_api_key && !s.ai_openrouter_api_key) {
    return { ready: false, reason: 'no_provider', message: 'Kunci AI (Gemini/OpenRouter) belum diisi.' };
  }
  const orFree = s.ai_openrouter_free_only === true || openRouterHealth.status === 'no_credits';
  return {
    ready: true,
    reason: 'ok',
    message: 'AI siap.',
    gemini: !!s.ai_gemini_api_key,
    openrouter: !!s.ai_openrouter_api_key,
    openrouter_free_mode: !!s.ai_openrouter_api_key && orFree,
    openrouter_health: openRouterHealth.status
  };
}
let _lastAIErrorSaved = { msg: null, at: 0 };
function recordAIError(err) {
  if (!DB.settings) return;
  const msg = sanitizeAIError(err).slice(0, 300);
  const now = Date.now();
  // Throttle: kegagalan yang sama dalam 30 detik tidak ditulis ulang supaya
  // permintaan yang gagal beruntun tidak membebani database.
  if (_lastAIErrorSaved.msg === msg && now - _lastAIErrorSaved.at < 30000) return;
  _lastAIErrorSaved = { msg, at: now };
  DB.settings.ai_last_error = msg;
  DB.settings.ai_last_error_at = new Date(now).toISOString();
  save();
}
function clearAIError() {
  if (!DB.settings) return;
  if (DB.settings.ai_last_error) {
    DB.settings.ai_last_error = null;
    DB.settings.ai_last_error_at = null;
    save();
  }
}

// PUBLIK (tanpa login): apakah AI siap dipakai? Hanya mengembalikan flag &
// pesan ramah — tidak pernah membocorkan kredensial, model, atau galat teknis
// ke pengunjung. Dipakai widget chat supaya pengunjung (dan admin yang sedang
// menguji) langsung tahu kalau AI memang belum diaktifkan.
app.get('/api/ai/status', (req, res) => {
  const r = aiReadiness();
  // Selalu segar (status bisa berubah begitu admin menyimpan konfigurasi)
  // dan boleh dipanggil lintas-origin oleh cermin GitHub Pages.
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    enabled: !!DB.settings.ai_assistant_enabled,
    ready: r.ready,
    reason: r.reason,
    message: r.message,
    wa_link: waLinkFor(DB.settings.phone, '6285887018194')
  });
});

// ADMIN: uji AI langsung ke provider.
//
// Menjawab pertanyaan "kenapa bot hanya bilang sedang gangguan?" tanpa
// menebak: memanggil Gemini/OpenRouter dengan prompt sangat pendek, lalu
// melaporkan model yang dipakai, waktu respons, cuplikan balasan, atau
// pesan galat asli dari penyedia (mis. "model dihentikan/404").
app.post('/api/admin/ai/test', auth, async (req, res) => {
  const results = {};
  const prompt = 'Balas satu kata: OK';

  if (DB.settings.ai_gemini_api_key) {
    const started = Date.now();
    try {
      const r = await callGemini(prompt, [{ role: 'user', content: 'ping' }]);
      results.gemini = {
        ok: true, model: r.model, latency_ms: Date.now() - started,
        sample: String(r.reply || '').slice(0, 120)
      };
    } catch (e) {
      results.gemini = { ok: false, error: sanitizeAIError(e), latency_ms: Date.now() - started };
    }
  } else {
    results.gemini = { ok: false, error: 'Kunci Gemini belum diisi' };
  }

  if (DB.settings.ai_openrouter_api_key) {
    const started = Date.now();
    try {
      const r = await callOpenRouter(prompt, [{ role: 'user', content: 'ping' }]);
      results.openrouter = {
        ok: true, model: r.model, latency_ms: Date.now() - started,
        free_model: !!r.free,
        mode: r.free ? 'model gratis' : 'model berbayar',
        sample: String(r.reply || '').slice(0, 120)
      };
    } catch (e) {
      results.openrouter = {
        ok: false, error: sanitizeAIError(e), latency_ms: Date.now() - started,
        hint: /402|insufficient credits/i.test(sanitizeAIError(e))
          ? 'Akun OpenRouter belum membeli kredit. Sistem otomatis beralih ke model GRATIS (:free); bila masih gagal, model gratis sedang penuh/kena batas. Tambah kredit di openrouter.ai/credits untuk memakai model terbaik, atau biarkan Gemini sebagai penyedia utama.'
          : (/401/.test(sanitizeAIError(e))
            ? 'Kunci OpenRouter ditolak. Buat kunci baru di openrouter.ai/keys lalu tempel ulang di panel ini.'
            : null)
      };
    }
  } else {
    results.openrouter = { ok: false, error: 'Kunci OpenRouter belum diisi (opsional)' };
  }

  const working = Object.entries(results).filter(([, v]) => v && v.ok).map(([k, v]) => k + ' (' + v.model + ')');
  // Tes dianggap sumber kebenaran terbaru untuk diagnosa.
  if (working.length) {
    clearAIError();
  } else {
    const firstError = Object.values(results).map((v) => v && v.error).filter(Boolean)[0];
    if (firstError) recordAIError(new Error(firstError));
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    ok: working.length > 0,
    enabled: !!DB.settings.ai_assistant_enabled,
    working_providers: working,
    saved_models: {
      gemini: DB.settings.ai_gemini_model || null,
      openrouter: DB.settings.ai_openrouter_model || null
    },
    results
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

