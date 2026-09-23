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

const app = require('../server.js');

module.exports = async function handler(req, res) {
  try {
    await app.ensureBooted();
  } catch (err) {
    console.error('[vercel] boot gagal:', err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'Server belum siap: periksa env DATABASE_URL / JWT_SECRET / ADMIN_EMAIL / ADMIN_PASSWORD lalu coba lagi.',
      detail: String((err && err.message) || err || 'boot gagal').slice(0, 300)
    }));
    return;
  }
  // Pengingat otomatis dsb. hanya berjalan saat instance hangat (Fluid
  // compute mempertahankan proses beberapa lama setelah request); idempoten.
  try { app.startBackgroundJobs(); } catch (e) { /* non-kritis */ }
  return app(req, res);
};
