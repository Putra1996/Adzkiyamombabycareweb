// Menentukan BASE URL API untuk semua halaman publik & panel admin.
// Dipakai js/main.js, js/kalender.js, js/admin.js, reservasi.html, dan
// kwitansi-share.html lewat window.ADZKIYA_API_BASE.
//
//  - Vercel (adzkiyamombabycareweb.vercel.app): backend Express berjalan di
//    domain yang SAMA (api/index.js + vercel.json) → base dikosongkan agar
//    semua fetch same-origin (tanpa CORS).
//  - GitHub Pages (putra1996.github.io): tidak ada backend → memakai API
//    produksi di Vercel. Dahulu menunjuk ke Railway, tetapi layanan Railway
//    sudah tidak aktif lagi (domain mati), jadi sekarang menunjuk Vercel.
//  - Localhost (npm start): same-origin.
//
// Override manual: set window.ADZKIYA_API_BASE SEBELUM file ini dimuat
// (mis. untuk staging atau development terhadap API lain).
(function () {
  if (window.ADZKIYA_API_BASE) return;
  var host = (window.location && window.location.hostname) || '';
  var isGithubPages = /(^|\.)github\.io$/i.test(host) || host === 'putra1996.github.io';
  if (isGithubPages) {
    window.ADZKIYA_API_BASE = 'https://adzkiyamombabycareweb.vercel.app';
  } else {
    // Vercel, localhost, dan domain kustom yang front-end+backend-nya
    // se-host: pakai same-origin. Semua pemanggil fetch sudah punya
    // penanganan error sendiri bila API tidak tersedia.
    window.ADZKIYA_API_BASE = '';
  }
})();
