// Entry point Vercel Function (Fluid compute) untuk seluruh aplikasi.
//
// server.js tidak boleh dipakai langsung sebagai export di sini karena dua
// hal:
//   1. NODE_ENV di runtime Vercel untuk proyek Express bisa TIDAK terisi —
//      padahal server.js mengandalkannya untuk `trust proxy`, header
//      keamanan (HSTS/CSP), dan `ssl: { rejectUnauthorized: false }` saat
//      membuka koneksi Postgres (Neon). Tanpa NODE_ENV=production, koneksi
//      database production bisa gagal dan server diam-diam jatuh ke mode
//      file (data tidak persisten).
//   2. State (DB.settings, seed admin, share tokens) hanya siap setelah
//      boot() selesai — boot dipicu sekali saat request pertama (atau saat
//      instance hangat menyala) lewat ensureBooted().
//
// Routing: berkas api/index.js ini melayani /api/index.js; vercel.json
// me-rewrite /api/*, /health, /manifest.webmanifest, /sitemap.xml,
// /robots.txt, dan /kwitansi/* ke sini. Path asli DIPERTAHANKAN oleh
// Vercel, jadi Express di server.js melihat req.url apa adanya.
if (process.env.VERCEL && !process.env.NODE_ENV) {
  // Preview deployment juga dianggap production supaya perilaku keamanan
  // (HSTS, X-Frame-Options, ssl Neon) konsisten dengan produksi.
  process.env.NODE_ENV = 'production';
}

// Muat server.js sekali. Bila gagal (satu-satunya kasus yang SENGAJA fatal:
// JWT_SECRET diisi tapi kurang dari 32 karakter), jangan biarkan Vercel
// menampilkan crash generik — balas JSON yang menjelaskan cara memperbaiki.
let app = null;
let loadError = null;
try {
  app = require('../server.js');
} catch (err) {
  loadError = err;
  console.error('[vercel] server.js gagal dimuat:', err && err.stack ? err.stack : err);
}

function sendJsonError(res, status, message, err) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    ok: false,
    error: message,
    detail: String((err && err.message) || err || '').slice(0, 300)
  }));
}

module.exports = async function handler(req, res) {
  if (!app) {
    sendJsonError(res, 500,
      'Konfigurasi server salah. Periksa env di Vercel (JWT_SECRET, bila diisi, wajib minimal 32 karakter) lalu Redeploy.',
      loadError);
    return;
  }
  try {
    await app.ensureBooted();
  } catch (err) {
    // Mode zero-config: boot praktis tidak pernah gagal lagi (database
    // yang tak terjangkau → mode file, env admin kosong → akun sementara).
    // Blok ini hanya jaring pengaman terakhir; boot dicoba ulang di
    // request berikutnya.
    console.error('[vercel] boot gagal:', err && err.stack ? err.stack : err);
    sendJsonError(res, 500, 'Boot server gagal sementara, silakan coba lagi sebentar.', err);
    return;
  }
  // Pengingat otomatis dsb. hanya berjalan saat instance hangat (Fluid
  // compute mempertahankan proses beberapa lama setelah request); idempoten.
  try { app.startBackgroundJobs(); } catch (e) { /* non-kritis */ }
  return app(req, res);
};
