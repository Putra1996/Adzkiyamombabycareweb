/* Service worker Adzkiya Mom Baby Care — PWA.
 *
 * Tujuan:
 *   1. Pelanggan bisa "Install"/"Tambah ke layar utama" dan membuka situs
 *      dengan cepat (aset statis dilayani dari cache).
 *   2. Notifikasi OS (Notification API) untuk pengingat jadwal: halaman
 *      admin mengirim pesan ke service worker ini, lalu sw menampilkan
 *      notifikasi walau tab sedang tidak fokus.
 *
 * Prinsip yang dipegang:
 *   • Data API (reservasi, kwitansi, pengaturan) TIDAK PERNAH di-cache —
 *     bisa memuat data pribadi pasien dan cepat berubah.
 *   • Hanya aset statis (CSS/JS/gambar) yang di-cache, dan selalu
 *     diperbarui di latar belakang (stale-while-revalidate).
 */
const VERSION = 'adzkiya-v1';
const STATIC_CACHE = VERSION + '-static';

const PRECACHE = [
  '/css/style.css',
  '/js/main.js',
  '/js/i18n.js',
  '/js/api-config.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // Kalau salah satu berkas gagal (mis. saat dev), instalasi tetap lanjut.
      .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Hanya tangani aset dari origin yang sama.
  if (url.origin !== self.location.origin) return;

  // JANGAN cache API, halaman HTML dinamis, manifest, dan sw itu sendiri.
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/kwitansi') ||
      url.pathname === '/sw.js' ||
      url.pathname === '/manifest.webmanifest' ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/') {
    return; // biarkan browser menangani langsung (selalu data segar)
  }

  event.respondWith(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        // stale-while-revalidate: tampilkan cache cepat, perbarui di latar.
        return cached || network;
      })
    )
  );
});

// Notifikasi dari halaman (panel admin): tampilkan notifikasi OS.
// Dipakai untuk "reservasi baru" dan "pengingat jadwal".
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'notify' && self.registration && self.registration.showNotification) {
    const title = String(data.title || 'Adzkiya Mom Baby Care').slice(0, 120);
    const body = String(data.body || '').slice(0, 240);
    self.registration.showNotification(title, {
      body,
      icon: '/api/logo',
      badge: '/api/logo',
      tag: data.tag || 'adzkiya',
      renotify: false,
      data: { url: data.url || '/admin' }
    });
  }
});

// Klik notifikasi -> buka/fokuskan panel admin.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) {
          client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
