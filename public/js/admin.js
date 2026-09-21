// Admin SPA logic v2
// Pages: dashboard, reservations, calendar, receipts, recap, backup, settings
let TOKEN = localStorage.getItem('adm_token') || '';
let USER = JSON.parse(localStorage.getItem('adm_user') || 'null');
let SERVICES = [];
let SETTINGS = {};
let CURRENT_PAGE = 'dashboard';
let CHARTS = {};
const API_BASE = String(window.ADZKIYA_API_BASE || '').replace(/\/$/, '');
const PAGE_STYLESHEET = new URL('css/style.css', window.location.href).href;
const apiUrl = (path) => /^https?:\/\//i.test(path) ? path : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
// 'Hari ini' sebagai string YYYY-MM-DD memakai waktu LOKAL (bukan UTC via
// toISOString). Penting utk zona WIB (UTC+7): antara 00:00-07:00 WIB,
// toISOString() masih menghasilkan tanggal kemarin, sehingga default
// tanggal / highlight 'hari ini' bisa mundur satu hari.
function localTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Bulan berjalan (YYYY-MM) versi waktu LOKAL. Jangan pakai
// toISOString().slice(0,7): itu UTC, sehingga pada tanggal 1 pukul
// 00:00-06:59 WIB nilainya masih bulan lalu.
function localMonthStr() {
  return localTodayStr().slice(0, 7);
}

// Hitung 'YYYY-MM' mundur sebanyak count-1 bulan dari sebuah bulan
// 'YYYY-MM' (dipakai untuk dropdown filter bulan). Aritmetika memakai
// UTC supaya bebas DST.
function shiftMonthStr(monthStr, deltaMonths) {
  const [y, m] = String(monthStr || '').split('-').map(Number);
  const d = new Date(Date.UTC(y || 1970, (m || 1) - 1 + deltaMonths, 1));
  return d.toISOString().slice(0, 7);
}

// Escape nilai string supaya aman dipakai di dalam literal JS pada
// atribut HTML inline, mis. onclick="hapus('NILAI')".
//
// CATATAN PENTING: esc() saja TIDAK cukup di konteks ini. HTML akan
// men-decode entity lebih dulu (&#39; -> '), jadi nilai seperti
//  ');alert(1);//  tetap bisa keluar dari string JS. Karena itu kita
// backslash-escape tanda kutip & backslash DULU, baru HTML-escape.
function escJs(s) {
  return esc(String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, ' '));
}

// Detect touch-primary devices (phones, tablets). Even when the user
// has Chrome's "Situs desktop" toggle on, this still returns true —
// `pointer:coarse` + `hover:none` is independent of the reported
// viewport width. Combined with CSS media queries of the same name,
// this keeps the mobile-friendly layout active on touch devices
// regardless of what the viewport meta / desktop toggle lies about.
function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  // The matchMedia call works in all evergreen browsers; the inner
  // property checks are fallback for older mobile browsers that don't
  // expose the matchMedia query yet (rare these days).
  if (window.matchMedia) {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
      || window.matchMedia('(hover: none) and (pointer: coarse) and (max-width: 1024px)').matches;
  }
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

// isNarrowView() returns true when the viewport is narrow by either
// (a) physical width or (b) being a touch device with Chrome's
// "Situs desktop" toggle enabled (which inflates innerWidth to 980).
// Used by JS that needs to choose between rendering the table or the
// card list — CSS does the final swap via body[data-table-mode].
function isNarrowView() {
  if (window.innerWidth <= 720) return true;
  if (isTouchDevice() && window.innerWidth <= 1024) return true;
  return false;
}

// Set the body's data-table-mode attribute early so that even pages
// which never call setAttribute (e.g. dashboard before any list
// renders) pick the right CSS rule on touch devices. On desktop the
// attribute is a no-op (CSS hides the duplicate card list).
if (isNarrowView()) {
  try { document.body.setAttribute('data-table-mode', 'cards'); } catch {}
}
// And re-evaluate when the viewport changes (Chrome's "Situs desktop"
// toggle can flip at runtime when the user pulls down the menu).
window.addEventListener('resize', () => {
  if (isNarrowView()) {
    document.body.setAttribute('data-table-mode', 'cards');
  }
});

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(apiUrl(path), { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Sesi berakhir. Silakan masuk kembali.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function fetchProtectedBlob(path) {
  const res = await fetch(apiUrl(path), { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (res.status === 401) { logout(); throw new Error('Sesi berakhir. Silakan masuk kembali.'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.blob();
}

async function openProtectedAsset(path) {
  try {
    const blobUrl = URL.createObjectURL(await fetchProtectedBlob(path));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (error) {
    alert('Bukti tidak dapat dibuka: ' + error.message);
  }
}

async function downloadProtected(path, filename) {
  const blobUrl = URL.createObjectURL(await fetchProtectedBlob(path));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// Ambil tanda tangan pemilik sebagai data URL lewat endpoint ber-token.
// Hasilnya di-cache di memori selama sesi supaya print/PDF berulang tidak
// memanggil server terus. Tidak pernah ditulis ke localStorage.
let OWNER_SIG_CACHE = null; // { data_url, mime, at } | false
async function fetchOwnerSignatureDataUrl(force) {
  if (!force && OWNER_SIG_CACHE) return OWNER_SIG_CACHE.data_url || '';
  try {
    const res = await api('/api/admin/settings/owner-signature');
    OWNER_SIG_CACHE = res && res.has_signature ? res : { data_url: '' };
    return OWNER_SIG_CACHE.data_url || '';
  } catch (e) {
    console.warn('Gagal memuat tanda tangan:', e.message);
    return '';
  }
}

function logout() {
  localStorage.removeItem('adm_token'); localStorage.removeItem('adm_user');
  TOKEN = ''; USER = null; showLogin();
}
function showLogin() {
  document.getElementById('loginView').style.display = 'flex';
  document.getElementById('appView').style.display = 'none';
}
async function showApp() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('appView').style.display = 'block';
  initTheme(); setupNav();
  await loadCache();
  navigate('dashboard');
  startNotifPolling();
  checkStorageHealth();
  // Re-layout every Chart.js instance when the viewport changes — without
  // this charts can render at 0×0 inside their .chart-canvas-wrap after
  // the device rotates or Chrome's "Situs desktop" toggle inflates the
  // viewport. Debounced so we only resize once after a burst of events.
  let _chartResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_chartResizeTimer);
    _chartResizeTimer = setTimeout(() => {
      Object.values(CHARTS).forEach((c) => { try { c.resize(); } catch {} });
    }, 120);
  });
}
async function loadCache() {
  try {
    [SERVICES, SETTINGS] = await Promise.all([
      fetch(apiUrl('/api/services')).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
      api('/api/admin/settings')
    ]);
  } catch (e) {}
}

// Tampilkan banner peringatan kalau server TIDAK sedang memakai database
// yang dikonfigurasi (DATABASE_URL diisi tapi gagal connect → fallback ke
// file sementara). Dalam kondisi ini semua data baru (reservasi, kwitansi,
// pengaturan) bisa HILANG saat deploy berikutnya, jadi admin harus tahu.
// Kunci penyimpanan preferensi "banner sudah ditutup" di localStorage.
// Ditutup hanya menahan tampilannya selama 24 jam (bukan selamanya) supaya
// risiko kehilangan data tidak bisa dilupakan untuk waktu lama.
const STORAGE_BANNER_SNOOZE_KEY = 'adm_storage_banner_snoozed_until';

async function checkStorageHealth() {
  try {
    const h = await fetch(apiUrl('/health')).then(r => r.json());
    if (!h) return;
    const snoozedUntil = parseInt(localStorage.getItem(STORAGE_BANNER_SNOOZE_KEY) || '0', 10) || 0;
    if (Date.now() < snoozedUntil) return;

    let level = null; // 'danger' | 'warn'
    if (h.configured_storage !== 'file' && !h.db_connected) {
      // Database dikonfigurasi tapi tidak bisa dihubungi.
      // Kalau file-nya persisten (Railway Volume / DATA_FILE di luar app),
      // data TIDAK hilang saat deploy — jangan menakuti admin tanpa alasan.
      level = h.file_persistent ? 'warn' : 'danger';
    } else if (h.configured_storage === 'file' && !h.file_persistent) {
      // Memang mode file dan file-nya tidak persisten → data bisa hilang.
      level = 'danger';
    }
    if (!level) {
      // Aman: buang banner lama kalau ada (mis. admin baru saja
      // menyelesaikan perbaikan penyimpanan).
      const stale = document.getElementById('storageWarningBanner');
      if (stale) stale.remove();
      return;
    }

    // Buang banner sebelumnya DULU supaya tidak menumpuk saat fungsi ini
    // dipanggil ulang (login ulang tanpa reload, tombol "Cek Ulang", dll).
    const existing = document.getElementById('storageWarningBanner');
    if (existing) existing.remove();

    const danger = level === 'danger';
    const banner = document.createElement('div');
    banner.id = 'storageWarningBanner';
    banner.style.cssText = 'position:sticky;top:0;z-index:9999;padding:12px 44px 12px 16px;font-size:0.88rem;line-height:1.5;font-weight:600;color:white;background:' +
      (danger ? '#b91c1c' : '#b45309') + ';';
    const text = danger
      ? ('⚠️ <strong>Data berisiko hilang saat deploy:</strong> server tidak bisa memakai database (' +
         esc(h.configured_storage || 'file') + ') dan file penyimpanannya tidak persisten. ' +
         '<strong>Unduh backup terenkripsi</strong> (menu Backup &amp; Restore) lalu perbaiki penyimpanan di ' +
         '<strong>Pengaturan → 🗄️ Status Penyimpanan</strong>.')
      : ('ℹ️ <strong>Database belum terhubung</strong> (' + esc(h.configured_storage || 'db') + '), ' +
         'tapi file penyimpanan <strong>persisten</strong> — data tetap aman antar deploy. ' +
         'Sambungkan database agar data terkelola: <strong>Pengaturan → 🗄️ Status Penyimpanan</strong>.');
    banner.innerHTML = text
      + (h.db_error ? '<br><small style="font-weight:500;opacity:0.92;">Penyebab: ' + esc(h.db_error) + '</small>' : '')
      + '<button type="button" onclick="snoozeStorageBanner()" title="Sembunyikan 24 jam" style="position:absolute;top:6px;right:8px;background:none;border:none;color:white;font-size:1.2rem;cursor:pointer;font-weight:700;line-height:1;">×</button>';
    banner.style.position = 'sticky';
    document.body.insertBefore(banner, document.body.firstChild);
  } catch (e) { /* health check opsional */ }
}

function snoozeStorageBanner() {
  // Tahan 24 jam. Kalau kondisinya masih berbahaya setelah itu, banner
  // muncul lagi — pengingat keamanan data tidak boleh bisa dimatikan
  // permanen dari UI.
  localStorage.setItem(STORAGE_BANNER_SNOOZE_KEY, String(Date.now() + 24 * 3600 * 1000));
  const el = document.getElementById('storageWarningBanner');
  if (el) el.remove();
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const alertBox = document.getElementById('loginAlert');
  alertBox.innerHTML = '';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') })
    });
    TOKEN = data.token; USER = data.user;
    localStorage.setItem('adm_token', TOKEN);
    localStorage.setItem('adm_user', JSON.stringify(USER));
    showApp();
  } catch (err) {
    alertBox.innerHTML = `<div class="alert alert-error">❌ ${err.message}</div>`;
  }
});

function setupNav() {
  document.querySelectorAll('.admin-sidebar nav button').forEach(b => {
    b.onclick = () => navigate(b.dataset.page);
  });
}

// ---- Pengaman render bersamaan ----
// Beberapa halaman dirender ulang dari beberapa tempat: klik menu, tombol
// "Cek Ulang", simpan pengaturan, atau polling notifikasi. Karena setiap
// render menunggu permintaan API, dua render yang berjalan bersamaan bisa
// selesai tidak berurutan sehingga hasil LAMA menimpa hasil BARU (mis.
// admin menekan menu dua kali lalu data lama muncul kembali). Token di
// bawah memastikan hanya render terbaru untuk sebuah halaman yang boleh
// menulis ke DOM.
const RENDER_TOKENS = {};
let RENDER_SEQ = 0;
function renderToken(name) {
  // Nomor urut global: setiap render baru (halaman apa pun) membatalkan
  // render yang masih berjalan.
  RENDER_SEQ += 1;
  RENDER_TOKENS[name] = RENDER_SEQ;
  return RENDER_SEQ;
}
function isLatestRender(name, token) {
  // Dua syarat: token untuk halaman ini masih yang terakhir dipasang, DAN
  // tidak ada render lain (halaman lain) yang lebih baru. Syarat kedua
  // mencegah render lambat — mis. dashboard saat baru login, atau refresh
  // notifikasi periodik — menimpa halaman yang sedang dibuka admin.
  return RENDER_TOKENS[name] === token && token === RENDER_SEQ;
}

// Halaman gagal dimuat: tampilkan pesan + tombol coba lagi.
//
// Sebelumnya navigate() memanggil fungsi render tanpa menunggu dan tanpa
// menangkap error. Kalau permintaan API gagal (jaringan putus, server
// restart, token kedaluwarsa sebelum api() menanganinya), promise-nya
// ditolak tanpa jejak: admin hanya melihat halaman SEBELUMNYA yang tidak
// berubah — tampak seperti aplikasi "beku" tanpa penjelasan.
function renderPageError(page, err) {
  const c = document.getElementById('pageContent');
  if (!c) return;
  const pesan = (err && err.message) ? err.message : 'Tidak diketahui';
  c.innerHTML = `
    <div class="admin-header"><h1>⚠️ Gagal memuat halaman</h1></div>
    <div class="setting-card" style="border:1.5px solid #f0b4b4;background:#fff5f5;">
      <p style="font-size:0.92rem;line-height:1.6;color:#7f1d1d;margin:0 0 10px;">
        Halaman <strong>${esc(page)}</strong> tidak bisa dimuat: <em>${esc(pesan)}</em>
      </p>
      <p style="font-size:0.86rem;line-height:1.6;color:var(--text-soft);margin:0 0 12px;">
        Periksa koneksi internet, lalu coba lagi. Kalau tetap gagal, buka ulang halaman
        <code>/admin</code> dan login kembali.
      </p>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" onclick="navigate('${escJs(page)}')">🔄 Coba Lagi</button>
        <button type="button" class="btn btn-outline" onclick="location.reload()">↻ Muat Ulang Halaman</button>
      </div>
    </div>`;
}

async function navigate(page) {
  CURRENT_PAGE = page;
  // Batalkan render yang masih berjalan: hasilnya tidak relevan lagi
  // begitu admin pindah halaman.
  renderToken('__navigate__');
  document.querySelectorAll('.admin-sidebar nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  // Destroy old charts
  Object.values(CHARTS).forEach(c => { try { c.destroy(); } catch {} });
  CHARTS = {};
  const handlers = {
    dashboard: renderDashboard,
    reservations: renderReservations,
    notifications: renderNotifications,
    calendar: renderCalendarAdmin,
    receipts: renderReceipts,
    recap: renderRecap,
    backup: renderBackup,
    settings: renderSettings,
    broadcast: renderBroadcast,
    customers: renderCustomers,
    accounting: renderAccounting,
  };
  const handler = handlers[page] || renderDashboard;
  try {
    // Ditunggu supaya kegagalan async (fetch) ikut tertangkap di sini.
    await handler();
  } catch (e) {
    console.error('[navigate] halaman "' + page + '" gagal dimuat:', e);
    renderPageError(page, e);
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

// ---------- DASHBOARD ----------
async function renderDashboard() {
  const _tk_renderDashboard = renderToken('dashboard');
  if (!isLatestRender('dashboard', _tk_renderDashboard)) return;
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <div>
        <h1>👋 Halo, ${esc(USER?.name) || 'Admin'}</h1>
        <p style="color:var(--text-soft);">Ringkasan reservasi & pendapatan.</p>
      </div>
      <button onclick="renderDashboard()" class="btn btn-outline">🔄 Refresh</button>
    </div>

    <!-- Reservasi Terbaru — dipindah ke ATAS chart supaya di mobile
         (yang viewport-nya sempit) info ini tetap kelihatan tanpa harus
         scroll jauh ke bawah melwati chart. -->
    <div class="setting-card" id="recentCard" style="margin-bottom:18px;">
      <h3 style="margin-bottom:14px;display:flex;align-items:center;gap:8px;">📋 Reservasi Terbaru <small id="recentCount" style="color:var(--text-soft);font-weight:500;font-size:0.85rem;"></small></h3>
      <div id="recentSkeleton" style="display:grid;gap:8px;">
        <div class="notif-card" style="opacity:.5;">Memuat reservasi…</div>
      </div>
    </div>

    <div class="stat-grid" id="statGrid"><div class="notif-card" style="opacity:.5;">Memuat statistik…</div></div>
    <!-- Chart utama: omzet 14 hari. Semua chart tampil di semua device —
         layout & tinggi chart disesuaikan via CSS untuk layar kecil. -->
    <div class="chart-card" style="margin-bottom:14px;">
      <h3>📈 Omzet 14 Hari Terakhir</h3>
      <div class="chart-canvas-wrap"><canvas id="chOmzetDay"></canvas></div>
    </div>
    <div class="charts-grid">
      <div class="chart-card"><h3>📊 Status Reservasi</h3><div class="chart-canvas-wrap"><canvas id="chStatus"></canvas></div></div>
      <div class="chart-card"><h3>💰 Omzet 6 Bulan</h3><div class="chart-canvas-wrap"><canvas id="chOmzetMonth"></canvas></div></div>
    </div>
    <div class="charts-grid">
      <div class="chart-card"><h3>💳 Metode Pembayaran</h3><div class="chart-canvas-wrap"><canvas id="chPay"></canvas></div></div>
      <div class="chart-card"><h3>🏆 Layanan Terpopuler</h3><div class="chart-canvas-wrap" style="height:280px;"><canvas id="chServices"></canvas></div></div>
    </div>
  `;
  // Populate Reservasi Terbaru FIRST so it shows even before stats
  // resolve — at least the section is anchored at the top of the page.
  try {
    const rows = await api('/api/admin/reservations');
    renderRecentList(rows.slice(0, 8));
  } catch (e) {
    document.getElementById('recentSkeleton').innerHTML = '<div class="alert alert-error">' + e.message + '</div>';
  }
  try {
    const [stats, charts] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/charts')
    ]);
    document.getElementById('statGrid').innerHTML = `
      <div class="stat-card"><div class="label">Pending</div><div class="value">${stats.pending}</div></div>
      <div class="stat-card"><div class="label">Approved</div><div class="value">${stats.approved}</div></div>
      <div class="stat-card peach"><div class="label">Lunas</div><div class="value">${stats.lunas}</div></div>
      <div class="stat-card pink"><div class="label">Total Omzet</div><div class="value">${fmtRp(stats.omzet)}</div></div>
      <div class="stat-card"><div class="label">Total Reservasi</div><div class="value">${stats.total}</div></div>
    `;
    drawCharts(charts);
  } catch (e) { document.getElementById('statGrid').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

// Render the recent-reservations list in a card format. Shows a count
// pill next to the heading so the admin can see at-a-glance how many
// latest reservations are listed, even before scrolling into the list.
function renderRecentList(rows) {
  const skel = document.getElementById('recentSkeleton');
  const count = document.getElementById('recentCount');
  if (count) count.textContent = rows.length ? `(${rows.length} terbaru)` : '';
  if (!skel) return;
  if (!rows.length) {
    skel.innerHTML = '<p style="color:var(--text-soft);text-align:center;padding:14px;">Belum ada reservasi.</p>';
    return;
  }
  // On phones render compact card list, on desktop render the table.
  // Cards are mobile-first because they fit a 360px-wide viewport.
  skel.innerHTML = `
    <div class="card-list" aria-label="Reservasi terbaru (tampilan kartu untuk HP)">
      ${rows.map(r => `<div class="card-list-item">
        <div class="cli-head">${esc(r.patient_name || '-')} <small style="color:var(--text-soft);font-weight:500;font-size:0.82rem;">· #${r.id}</small></div>
        <div class="cli-meta">📅 ${(r.slots || []).map(s => `${s.date} ${s.time}`).join(', ') || '—'}</div>
        <div class="cli-row"><span class="cli-label">Layanan</span><span class="cli-value" style="text-align:left;font-weight:500;">${(r.items || []).map(it => `${esc(it.name)} ×${it.qty}`).join(', ') || '-'}</span></div>
        <div class="cli-row"><span class="cli-label">Status</span><span class="cli-value"><span class="badge badge-${r.status}">${r.status}</span></span></div>
        <div class="cli-row"><span class="cli-label">Bayar</span><span class="cli-value"><span class="badge badge-${r.payment_status}">${r.payment_status}</span></span></div>
        <div class="cli-row"><span class="cli-label">Total</span><span class="cli-value"><strong>${fmtRp(r.total)}</strong></span></div>
      </div>`).join('')}
    </div>
  `;
}

function renderItemsCompact(items) {
  if (!items || !items.length) return '-';
  const first = items[0];
  if (items.length === 1) return `${esc(first.name)} ×${first.qty}`;
  return `${esc(first.name)} ×${first.qty} <span class="tag">+${items.length - 1}</span>`;
}

function drawCharts(d) {
  // Fallback path: if Chart.js failed to load from both CDNs (mobile
  // networks sometimes block cdn.jsdelivr.net or unpkg), render the
  // same data as plain HTML tables. Functionally equivalent — every
  // chart the admin wants to see is still there as tabular data.
  if (typeof window.Chart !== 'function') {
    renderChartsAsTables(d);
    return;
  }
  const pinkColors = ['#ee5a8a', '#ffb979', '#ffa6bf', '#ffd3a8', '#ee7ea4', '#ff7ea4', '#d63f70', '#ffd6e2'];
  // Omzet by day - line
  CHARTS.day = new Chart(document.getElementById('chOmzetDay'), {
    type: 'line',
    data: {
      labels: d.omzetByDay.map(x => x.date.slice(5)),
      datasets: [{
        label: 'Omzet', data: d.omzetByDay.map(x => x.omzet),
        borderColor: '#ee5a8a', backgroundColor: 'rgba(238,90,138,0.15)',
        fill: true, tension: 0.35, borderWidth: 2.5, pointBackgroundColor: '#ee5a8a', pointRadius: 4
      }]
    },
    options: chartOpts({ y: { ticks: { callback: v => 'Rp' + (v/1000) + 'k' } } })
  });
  // Status pie
  CHARTS.status = new Chart(document.getElementById('chStatus'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(d.statusCount),
      datasets: [{ data: Object.values(d.statusCount), backgroundColor: ['#f4a83a', '#4caf85', '#e85a78'], borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
  // Monthly omzet
  CHARTS.month = new Chart(document.getElementById('chOmzetMonth'), {
    type: 'bar',
    data: {
      labels: d.omzetByMonth.map(x => x.month),
      datasets: [{ label: 'Omzet', data: d.omzetByMonth.map(x => x.omzet),
        backgroundColor: 'rgba(238,90,138,0.7)', borderRadius: 8 }]
    },
    options: chartOpts({ y: { ticks: { callback: v => 'Rp' + (v/1000) + 'k' } } })
  });
  // Payment pie
  CHARTS.pay = new Chart(document.getElementById('chPay'), {
    type: 'pie',
    data: {
      labels: Object.keys(d.payCount),
      datasets: [{ data: Object.values(d.payCount), backgroundColor: pinkColors, borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
  // Services bar
  CHARTS.svc = new Chart(document.getElementById('chServices'), {
    type: 'bar',
    data: {
      labels: d.topServices.map(s => s.name.length > 28 ? s.name.slice(0, 26) + '…' : s.name),
      datasets: [{ label: 'Booking', data: d.topServices.map(s => s.count),
        backgroundColor: pinkColors, borderRadius: 6 }]
    },
    options: { ...chartOpts({}), indexAxis: 'y', plugins: { legend: { display: false } } }
  });
}

// Replace any of the canvas-based chart cards that don't have a
// working chart with a plain HTML table of the same data. Called when
// Chart.js fails to load from every CDN we tried. Each branch keeps the
// data shape identical to the chart it replaces — only the visual
// rendering changes (table instead of canvas).
function renderChartsAsTables(d) {
  const omzetDayEl = document.getElementById('chOmzetDay');
  if (omzetDayEl) {
    const wrap = omzetDayEl.closest('.chart-card');
    if (wrap) wrap.innerHTML = '<h3>📈 Omzet 14 Hari Terakhir</h3>' +
      renderMiniTable([['Tanggal', 'Omzet']].concat(d.omzetByDay.map((x) => [x.date, fmtRp(x.omzet)])));
  }
  const statusEl = document.getElementById('chStatus');
  if (statusEl) {
    const wrap = statusEl.closest('.chart-card');
    if (wrap) wrap.innerHTML = '<h3>📊 Status Reservasi</h3>' +
      renderMiniTable([['Status', 'Jumlah']].concat(Object.entries(d.statusCount || {})));
  }
  const monthEl = document.getElementById('chOmzetMonth');
  if (monthEl) {
    const wrap = monthEl.closest('.chart-card');
    if (wrap) wrap.innerHTML = '<h3>💰 Omzet 6 Bulan</h3>' +
      renderMiniTable([['Bulan', 'Omzet']].concat(d.omzetByMonth.map((x) => [x.month, fmtRp(x.omzet)])));
  }
  const payEl = document.getElementById('chPay');
  if (payEl) {
    const wrap = payEl.closest('.chart-card');
    if (wrap) wrap.innerHTML = '<h3>💳 Metode Pembayaran</h3>' +
      renderMiniTable([['Metode', 'Jumlah']].concat(Object.entries(d.payCount || {})));
  }
  const svcEl = document.getElementById('chServices');
  if (svcEl) {
    const wrap = svcEl.closest('.chart-card');
    if (wrap) wrap.innerHTML = '<h3>🏆 Layanan Terpopuler</h3>' +
      renderMiniTable([['Layanan', 'Booking']].concat(d.topServices.map((x) => [x.name, x.count])));
  }
  // Optionally notify the admin that charts are in table mode (so
  // they understand why they don't look like usual charts).
  const banner = document.getElementById('chartFallbackBanner');
  if (!banner) {
    const b = document.createElement('div');
    b.id = 'chartFallbackBanner';
    b.style.cssText = 'background:var(--pink-50);border:1px dashed var(--border);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:0.85rem;color:var(--text-soft);';
    b.textContent = '⚠️ Mode tabel aktif — grafik Chart.js gagal dimuat (CDN diblokir/koneksi lambat). Data tetap lengkap, hanya tampil dalam bentuk tabel.';
    const header = document.querySelector('.admin-header');
    if (header && header.parentElement) {
      header.parentElement.insertBefore(b, header.nextSibling);
    }
  }
}

// Tiny helper used by renderChartsAsTables — return an HTML table
// from a 2D array of cells.
function renderMiniTable(rows) {
  if (!rows.length) return '<p style="color:var(--text-soft);padding:14px;text-align:center;">Tidak ada data.</p>';
  const headerRow = rows[0];
  const bodyRows = rows.slice(1);
  return '<div class="table-scroll" style="margin-top:8px;"><table class="data-table"><thead><tr>' +
    headerRow.map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' +
    bodyRows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}
function chartOpts(scales) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true, ...scales.y } }
  };
}

// ---------- RESERVATIONS ----------
// Cached list + filters so search/sort/date-range don't refetch the
// server on every keystroke. The server already supports from/to/
// status/payment_status query params, so for the heavier filters we
// re-query. For client-only tweaks (search text, sort order) we just
// re-filter the cached array.
let RES_CACHE = [];
let RES_FILTERS = { q: '', from: '', to: '', sort: 'date_desc' };
async function renderReservations() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <h1>📅 Reservasi</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <select id="filterStatus" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);">
          <option value="">Semua Status</option><option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select id="filterPay" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);">
          <option value="">Semua Bayar</option><option value="unpaid">Unpaid</option>
          <option value="lunas">Lunas</option>
        </select>
        <button onclick="loadReservations(true)" class="btn-sm btn-pay">🔄 Refresh</button>
      </div>
    </div>
    <div class="setting-card" style="margin-bottom:14px;padding:14px 16px;">
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px;align-items:end;">
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:var(--text-soft);">🔍 Cari Pasien / No. WA / Invoice</label>
          <input type="search" id="resSearch" placeholder="Ketik nama, HP, atau #ID..." style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;" autocomplete="off">
        </div>
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:var(--text-soft);">📅 Dari</label>
          <input type="date" id="resFrom" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
        </div>
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:var(--text-soft);">📅 Sampai</label>
          <input type="date" id="resTo" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
        </div>
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:var(--text-soft);">↕️ Urutkan</label>
          <select id="resSort" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
            <option value="date_desc">Tanggal Terbaru</option>
            <option value="date_asc">Tanggal Terlama</option>
            <option value="total_desc">Total Terbesar</option>
            <option value="total_asc">Total Terkecil</option>
            <option value="name_asc">Nama A-Z</option>
            <option value="name_desc">Nama Z-A</option>
            <option value="id_desc">ID Terbaru</option>
          </select>
        </div>
      </div>
      <div id="resCount" style="margin-top:10px;font-size:0.85rem;color:var(--text-soft);"></div>
    </div>
    <div id="reservationsList">Loading...</div>
  `;
  document.getElementById('filterStatus').onchange = () => loadReservations(true);
  document.getElementById('filterPay').onchange = () => loadReservations(true);
  // Client-side filters (search, sort) don't need a server refetch.
  document.getElementById('resSearch').oninput = () => { RES_FILTERS.q = document.getElementById('resSearch').value; renderFilteredReservations(); };
  document.getElementById('resSort').onchange = () => { RES_FILTERS.sort = document.getElementById('resSort').value; renderFilteredReservations(); };
  // Date range filters DO need a server refetch (server has the
  // index-friendly `from`/`to` query params).
  document.getElementById('resFrom').onchange = () => { RES_FILTERS.from = document.getElementById('resFrom').value; loadReservations(true); };
  document.getElementById('resTo').onchange = () => { RES_FILTERS.to = document.getElementById('resTo').value; loadReservations(true); };
  // Restore the previously-entered filter values (in case user
  // navigates away and back, we don't lose their search text).
  document.getElementById('resSearch').value = RES_FILTERS.q;
  document.getElementById('resSort').value = RES_FILTERS.sort;
  if (RES_FILTERS.from) document.getElementById('resFrom').value = RES_FILTERS.from;
  if (RES_FILTERS.to) document.getElementById('resTo').value = RES_FILTERS.to;
  await loadReservations(false);
}

async function loadReservations(refetch) {
  const _token342 = renderToken('reservations');
  // The first load (or an explicit "Refresh" button) refetches the
  // server. Subsequent toggles of search/sort just re-filter the
  // cached list to keep the UI snappy on slow networks.
  if (refetch || !RES_CACHE.length) {
    const status = document.getElementById('filterStatus').value;
    const pay = document.getElementById('filterPay').value;
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (pay) qs.set('payment_status', pay);
    if (RES_FILTERS.from) qs.set('from', RES_FILTERS.from);
    if (RES_FILTERS.to) qs.set('to', RES_FILTERS.to);
    try {
      RES_CACHE = await api('/api/admin/reservations?' + qs);
  // Render yang lebih baru sudah dimulai — jangan menimpa hasilnya.
  if (!isLatestRender('reservations', _token342)) return;
    } catch (e) {
      document.getElementById('reservationsList').innerHTML = `<div class="alert alert-error">${e.message}</div>`;
      return;
    }
  }
  renderFilteredReservations();
}

function renderFilteredReservations() {
  let rows = RES_CACHE.slice();
  const q = (RES_FILTERS.q || '').toLowerCase().trim();
  if (q) {
    rows = rows.filter((r) => {
      // Match by patient name, phone (digits-only), reservation id, or
      // any service item name. Most common admin searches are "what
      // came in from Bunda Rina" or "who booked Baby Sleepwell".
      const phoneDigits = String(r.whatsapp || '').replace(/\D/g, '');
      const qDigits = q.replace(/\D/g, '');
      return (
        String(r.patient_name || '').toLowerCase().includes(q) ||
        (qDigits && phoneDigits.includes(qDigits)) ||
        String(r.id).includes(qDigits || q) ||
        (r.items || []).some((it) => String(it.name || '').toLowerCase().includes(q)) ||
        String(r.address || '').toLowerCase().includes(q)
      );
    });
  }
  // Sort. Default is date_desc (newest first).
  rows.sort((a, b) => {
    switch (RES_FILTERS.sort) {
      case 'date_asc': return String(a.reservation_date || '').localeCompare(String(b.reservation_date || ''));
      case 'total_desc': return (b.total || 0) - (a.total || 0);
      case 'total_asc': return (a.total || 0) - (b.total || 0);
      case 'name_asc': return String(a.patient_name || '').localeCompare(String(b.patient_name || ''));
      case 'name_desc': return String(b.patient_name || '').localeCompare(String(a.patient_name || ''));
      case 'id_desc': return (b.id || 0) - (a.id || 0);
      case 'date_desc':
      default: return String(b.reservation_date || '').localeCompare(String(a.reservation_date || ''));
    }
  });

  const el = document.getElementById('reservationsList');
  document.body.setAttribute('data-table-mode', 'cards');
  // Update the visible count so admin knows how many rows match.
  const totalCount = RES_CACHE.length;
  const shownCount = rows.length;
  const countEl = document.getElementById('resCount');
  if (countEl) {
    countEl.innerHTML = shownCount === totalCount
      ? `📊 Total: <strong>${totalCount}</strong> reservasi`
      : `📊 Menampilkan <strong>${shownCount}</strong> dari <strong>${totalCount}</strong> reservasi${q ? ` (cari: "${esc(q)}")` : ''}`;
  }

  if (!rows.length) {
    el.innerHTML = `<p style="color:var(--text-soft);text-align:center;padding:40px;background:var(--card);border-radius:12px;">${q ? `Tidak ada reservasi yang cocok dengan "${esc(q)}".` : 'Tidak ada reservasi.'}</p>`;
    return;
  }
  const tableHtml = `<div class="data-table-wrap"><div class="table-scroll"><table class="data-table"><thead><tr>
      <th>#</th><th>Pasien</th><th>Layanan</th><th>Jadwal</th><th>Bayar</th><th>Total</th><th>Status</th><th>Aksi</th>
    </tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td>#${r.id}</td>
        <td><strong>${esc(r.patient_name)}</strong><br>
          <small><a href="https://wa.me/${r.whatsapp.replace(/\D/g,'')}" target="_blank">${esc(r.whatsapp)}</a></small><br>
          <small style="color:var(--text-soft)">${esc((r.address||'').slice(0,40))}${(r.address||'').length>40?'…':''}</small></td>
        <td><div class="items-list">${(r.items||[]).map(it => `<div class="item-line">• ${esc(it.name)} <small style="color:var(--text-soft)">×${it.qty}</small></div>`).join('')}</div></td>
        <td><div class="slots-list">${(r.slots||[]).map(s => `<span class="slot-line">${fmtDate(s.date)} ${s.time}</span>`).join(' ')}</div></td>
        <td>${esc(r.payment_method)}<br>${r.proof_file ? `<button type="button" onclick="openProtectedAsset('/api/proof/${r.id}')" class="link-button" style="font-size:0.78rem;">📎 Bukti</button><br>` : ''}<span class="badge badge-${r.payment_status}">${r.payment_status}</span></td>
        <td><strong>${fmtRp(r.total)}</strong></td>
        <td><span class="badge badge-${r.status}">${r.status}</span></td>
        <td style="white-space:nowrap;">
          ${r.status === 'pending' ? `<button class="btn-sm btn-approve" onclick="updateRes(${r.id}, 'approved', null)">✓</button>` : ''}
          ${r.payment_status === 'unpaid' ? `<button class="btn-sm btn-pay" onclick="updateRes(${r.id}, null, 'lunas')">💰</button>` : ''}
          <button class="btn-sm btn-view" onclick="viewRes(${r.id})">👁️</button>
          <button class="btn-sm btn-del" onclick="delRes(${r.id})">🗑️</button>
        </td>
      </tr>`).join('')}
    </tbody></table></div></div>`;
  const cardHtml = `<div class="card-list">
      ${rows.map(r => `<div class="card-list-item">
        <div class="cli-head">#${r.id} · ${esc(r.patient_name)}</div>
        <div class="cli-row"><span class="cli-label">WhatsApp</span><span class="cli-value"><a href="https://wa.me/${r.whatsapp.replace(/\D/g,'')}" target="_blank">${esc(r.whatsapp)}</a></span></div>
        <div class="cli-row"><span class="cli-label">Alamat</span><span class="cli-value" style="font-weight:500;">${esc((r.address||'').slice(0,60))}${(r.address||'').length>60?'…':''}</span></div>
        <div class="cli-row"><span class="cli-label">Layanan</span><span class="cli-value" style="text-align:left;font-weight:500;">${(r.items||[]).map(it => `• ${esc(it.name)} ×${it.qty}`).join('<br>')}</span></div>
        <div class="cli-row"><span class="cli-label">Jadwal</span><span class="cli-value" style="font-weight:500;">${(r.slots||[]).map(s => `${fmtDate(s.date)} ${s.time}`).join('<br>')}</span></div>
        <div class="cli-row"><span class="cli-label">Bayar</span><span class="cli-value">${esc(r.payment_method)}${r.proof_file ? `<br><button type="button" onclick="openProtectedAsset('/api/proof/${r.id}')" class="link-button" style="font-size:0.78rem;">📎 Bukti</button>` : ''}</span></div>
        <div class="cli-row"><span class="cli-label">Total</span><span class="cli-value">${fmtRp(r.total)}</span></div>
        <div class="cli-row"><span class="cli-label">Status</span><span class="cli-value"><span class="badge badge-${r.status}">${r.status}</span> <span class="badge badge-${r.payment_status}">${r.payment_status}</span></span></div>
        <div class="cli-actions">
          ${r.status === 'pending' ? `<button class="btn-sm btn-approve" onclick="updateRes(${r.id}, 'approved', null)">✓ Approve</button>` : ''}
          ${r.payment_status === 'unpaid' ? `<button class="btn-sm btn-pay" onclick="updateRes(${r.id}, null, 'lunas')">💰 Lunas</button>` : ''}
          <button class="btn-sm btn-view" onclick="viewRes(${r.id})">👁️ Detail</button>
          <button class="btn-sm btn-del" onclick="delRes(${r.id})">🗑️ Hapus</button>
        </div>
      </div>`).join('')}
    </div>`;
  el.innerHTML = tableHtml + cardHtml;
}

async function updateRes(id, status, payment_status) {
  const body = {};
  if (status) body.status = status;
  if (payment_status) body.payment_status = payment_status;
  await api('/api/admin/reservations/' + id, { method: 'PATCH', body: JSON.stringify(body) });
  loadReservations(true);
}
async function delRes(id) {
  if (!confirm('Hapus reservasi ini?')) return;
  await api('/api/admin/reservations/' + id, { method: 'DELETE' });
  loadReservations(true);
}
async function viewRes(id) {
  const rows = await api('/api/admin/reservations');
  const r = rows.find(x => x.id === id);
  if (!r) return;
  openModal(`
    <h3>Detail Reservasi #${r.id}</h3>
    <div style="margin-top:14px;display:grid;gap:8px;font-size:0.92rem;">
      <div><strong>Pasien:</strong> ${esc(r.patient_name)}</div>
      <div><strong>WhatsApp:</strong> <a href="https://wa.me/${r.whatsapp.replace(/\D/g,'')}" target="_blank">${esc(r.whatsapp)}</a></div>
      <div><strong>Alamat:</strong> ${esc(r.address)}</div>
      <div><strong>Layanan:</strong><div style="margin-top:4px;padding:8px;background:var(--pink-50);border-radius:8px;">${(r.items||[]).map(it => `<div>• ${esc(it.name)} <small>×${it.qty}</small> — ${fmtRp(it.price*it.qty)}</div>`).join('')}</div></div>
      <div><strong>Jadwal (${(r.slots||[]).length} sesi):</strong><div style="margin-top:4px;">${(r.slots||[]).map(s => `<span class="slot-line">${fmtDate(s.date)} ${s.time}</span>`).join(' ')}</div></div>
      <div><strong>Pembayaran:</strong> ${esc(r.payment_method)} — <span class="badge badge-${r.payment_status}">${r.payment_status}</span></div>
      <div><strong>Total:</strong> <span style="color:var(--primary);font-weight:800;font-size:1.1rem;">${fmtRp(r.total)}</span></div>
      <div><strong>Status:</strong> <span class="badge badge-${r.status}">${r.status}</span></div>
      <div><strong>Catatan:</strong> ${esc(r.notes) || '—'}</div>
      <div><strong>Dibuat:</strong> ${fmtDateTime(r.created_at)}</div>
      ${r.proof_file ? `<div><strong>Bukti pembayaran:</strong><br><button type="button" onclick="openProtectedAsset('/api/proof/${r.id}')" class="btn-sm btn-view" style="margin-top:6px;">📎 Buka bukti</button></div>` : ''}
    </div>
    <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn-sm btn-approve" onclick="quickMakeReceipt(${r.id})">🧾 Buat Kwitansi</button>
      <button class="btn-sm btn-view" onclick="closeModal()">Tutup</button>
    </div>
  `);
}
async function quickMakeReceipt(id) {
  const rows = await api('/api/admin/reservations');
  const r = rows.find(x => x.id === id);
  closeModal();
  navigate('receipts');
  setTimeout(() => prefillReceipt(r), 150);
}

// ---------- CALENDAR ADMIN ----------
// Compact mobile-friendly calendar. Cells pakai class .cal-compact
// dari stylesheet. Click tanggal → buka panel detail di bawah
// kalender yang menampilkan daftar (layanan, jam) per reservasi.
// Nama pasien & nomor HP di-mask ("Bunda A***") demi privasi —
// admin bisa buka Reservasi atau Kwitansi untuk lihat data lengkap.
let admCalDate = new Date();
let admCalEvents = []; // {date, time, items, status, reservation_id, items_count}
let admCalSelectedDate = null;
async function renderCalendarAdmin() {
  const _tk_renderCalendarAdmin = renderToken('calendar');
  if (!isLatestRender('calendar', _tk_renderCalendarAdmin)) return;
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <h1>🗓️ Kalender Realtime</h1>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:0.82rem;color:var(--text-soft);">📅 Lihat jadwal reservasi per hari</span>
        <button onclick="admRefresh()" class="btn-sm btn-pay">🔄 Refresh</button>
      </div>
    </div>
    <div class="calendar-wrap cal-compact">
      <div class="cal-header">
        <h3 id="admCalLabel">—</h3>
        <div class="cal-nav">
          <button onclick="admPrev()" title="Bulan sebelumnya">‹</button>
          <button onclick="admToday()">Hari ini</button>
          <button onclick="admNext()" title="Bulan berikutnya">›</button>
        </div>
      </div>
      <div class="cal-grid" id="admCalGrid"></div>
      <div class="cal-legend">
        <span><span class="swatch today"></span>Hari ini</span>
        <span><span class="swatch has-events"></span>Ada reservasi</span>
        <span style="color:var(--text-soft);font-size:0.78rem;">💡 Klik tanggal untuk lihat detail (nama pasien di-mask)</span>
      </div>
    </div>
    <div id="admCalDetail" style="display:none;margin-top:18px;background:var(--card);border-radius:12px;padding:18px;border:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="margin:0;" id="admCalDetailTitle">—</h3>
        <button onclick="closeAdmCalDetail()" class="btn-sm btn-view">Tutup</button>
      </div>
      <div id="admCalDetailContent"></div>
    </div>
  `;
  await admRefresh();
}
async function admRefresh() {
  try {
    const rows = await api('/api/admin/reservations');
    admCalEvents = [];
    rows.forEach(r => {
      const items = Array.isArray(r.items) ? r.items : [];
      (r.slots || []).forEach((s, idx) => {
        admCalEvents.push({
          reservation_id: r.id,
          date: s.date,
          time: s.time,
          status: r.status,
          payment_status: r.payment_status,
          // Items for this reservation — we display per-slot. Since
          // items are usually identical across slots of the same
          // reservation, we attach them on the FIRST slot only.
          items: idx === 0 ? items : [],
          items_total: r.total,
          // Private fields (name, whatsapp) are NOT loaded here. They
          // are masked out of the calendar entirely — admin opens
          // Reservasi / Kwitansi to see full PII.
        });
      });
    });
  } catch (e) {
    admCalEvents = [];
  }
  drawAdmCal();
}
function maskPatientId(id) {
  // Stable short mask of a numeric reservation id, e.g. #42 → "#…0042".
  // Doesn't reveal the real name/phone — just an opaque token so the
  // admin knows multiple slots at the same time belong to the same
  // reservation when looking at the detail panel.
  if (!id) return '';
  const tail = String(id).padStart(4, '0').slice(-4);
  return `Pasien #…${tail}`;
}
function drawAdmCal() {
  const y = admCalDate.getFullYear(), m = admCalDate.getMonth();
  const mn = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  document.getElementById('admCalLabel').textContent = `${mn[m]} ${y}`;
  const grid = document.getElementById('admCalGrid');
  grid.innerHTML = '';
  const today = localTodayStr();
  const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);

  ['Min','Sen','Sel','Rab','Kam','Jum','Sab'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'cal-cell head';
    h.textContent = d;
    grid.appendChild(h);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();

  for (let i = firstDay - 1; i >= 0; i--) {
    const c = document.createElement('div');
    c.className = 'cal-cell muted';
    c.innerHTML = `<span class="day-num">${prevDays - i}</span>`;
    grid.appendChild(c);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const cellDate = new Date(y, m, d);
    const isPast = cellDate < todayMidnight;
    const evs = admCalEvents.filter(e => e.date === ds);
    const c = document.createElement('div');
    let cls = 'cal-cell';
    if (ds === today) cls += ' today';
    if (evs.length && !isPast) cls += evs.length >= 4 ? ' full' : ' has-events';
    if (isPast) cls += ' past';
    c.className = cls;
    c.style.cursor = 'pointer';
    c.style.position = 'relative';
    c.title = `${d} ${mn[m]} ${y}${evs.length ? ` — ${evs.length} reservasi` : ''}`;
    // Use addEventListener + data-* instead of c.onclick. Some
    // desktop browsers detach the .onclick handler when innerHTML is
    // overwritten, leaving the cell visually clickable but
    // functionally dead. addEventListener survives and the data-*
    // attribute keeps the (date, events) pair around for the
    // handler to read directly.
    c.dataset.date = ds;
    c.dataset.idx = String(evs.length);
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      openAdmCalDetail(ds, evs);
    });
    let html = `<span class="day-num">${d}</span>`;
    if (evs.length && !isPast) {
      html += `<span class="count-badge" title="${evs.length} reservasi">${evs.length}</span>`;
    }
    c.innerHTML = html;
    grid.appendChild(c);
  }

  const cells = firstDay + daysInMonth;
  const trail = (7 - (cells % 7)) % 7;
  for (let i = 1; i <= trail; i++) {
    const c = document.createElement('div');
    c.className = 'cal-cell muted';
    c.innerHTML = `<span class="day-num">${i}</span>`;
    grid.appendChild(c);
  }
}
function openAdmCalDetail(dateStr, evs) {
  admCalSelectedDate = dateStr;
  const detail = document.getElementById('admCalDetail');
  const title = document.getElementById('admCalDetailTitle');
  const content = document.getElementById('admCalDetailContent');
  if (!detail) return;
  const dateLabel = new Date(dateStr + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  title.textContent = `📅 ${dateLabel}`;
  if (!evs.length) {
    content.innerHTML = `<p style="color:var(--text-soft);margin:6px 0 0;">Tidak ada reservasi di tanggal ini.</p>`;
  } else {
    const sorted = evs.slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const itemsByRes = sorted.reduce((m, e) => {
      // Aggregate items per reservation: items[] only on first slot.
      if (e.items && e.items.length) m[e.reservation_id] = e.items;
      return m;
    }, {});
    const list = sorted.map(e => {
      const items = itemsByRes[e.reservation_id] || [];
      const itemsHtml = items.length
        ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">${items.map((it) => `<span style="display:inline-block;padding:3px 9px;background:var(--pink-100);color:var(--primary);border-radius:999px;font-size:0.8rem;font-weight:600;">${esc(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ''}</span>`).join('')}</div>`
        : '<div style="margin-top:6px;color:var(--text-soft);font-size:0.8rem;font-style:italic;">(item layanan sudah ditampilkan di slot pertama)</div>';
      return `
        <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;margin-top:8px;background:var(--pink-50);border-radius:8px;border-left:4px solid ${e.status === 'approved' ? '#4caf85' : e.status === 'rejected' ? '#e85a78' : '#f4a83a'};">
          <div style="font-weight:700;color:var(--primary);min-width:54px;font-size:0.92rem;">${esc((e.time || '').slice(0,5))}</div>
          <div style="flex:1;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <strong style="font-size:0.88rem;">${maskPatientId(e.reservation_id)}</strong>
              <span class="badge badge-${e.status}" style="font-size:0.76rem;">${e.status}</span>
              <span class="badge badge-${e.payment_status}" style="font-size:0.76rem;">${e.payment_status}</span>
              <small style="color:var(--text-soft);">#${e.reservation_id}</small>
            </div>
            ${itemsHtml}
          </div>
        </div>`;
    }).join('');
    const note = `<p style="margin-top:12px;padding:10px 12px;background:var(--bg);border-radius:8px;color:var(--text-soft);font-size:0.82rem;line-height:1.5;">
      🔒 <strong>Privasi terjaga:</strong> Nama pasien & nomor WhatsApp tidak ditampilkan di sini. Buka menu <strong>Reservasi</strong> atau <strong>Kwitansi</strong> untuk lihat data lengkap.
    </p>`;
    content.innerHTML = `${list}${note}`;
  }
  detail.style.display = 'block';
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closeAdmCalDetail() {
  const detail = document.getElementById('admCalDetail');
  if (detail) detail.style.display = 'none';
  admCalSelectedDate = null;
}
function admPrev() { admCalDate.setMonth(admCalDate.getMonth() - 1); drawAdmCal(); closeAdmCalDetail(); }
function admNext() { admCalDate.setMonth(admCalDate.getMonth() + 1); drawAdmCal(); closeAdmCalDetail(); }
function admToday() { admCalDate = new Date(); drawAdmCal(); closeAdmCalDetail(); }

// ---------- RECEIPTS ----------
let receiptItems = [];
async function renderReceipts() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header"><h1>🧾 Kwitansi</h1></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" id="kwGrid">
      <div>
        <h3 style="margin-bottom:12px;">Buat Kwitansi Baru</h3>
        <div class="form-wrap" style="padding:24px;">
          <div class="form-group"><label>Nama Pasien</label><input type="text" id="kw_name"></div>
          <div class="form-row">
            <div class="form-group"><label>HP</label><input type="tel" id="kw_hp"></div>
            <div class="form-group"><label>Tanggal Layanan</label><input type="date" id="kw_date" value="${localTodayStr()}"></div>
          </div>
          <div class="form-group"><label>⏰ Waktu / Jam Layanan (multi-waktu)</label>
            <div id="kw_times" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;"></div>
            <button type="button" onclick="addKwTimePrompt()" class="btn-sm btn-pay" style="margin-top:6px;">+ Tambah Waktu</button>
            <small style="color:var(--text-soft);display:block;margin-top:4px;">Misal: satu pasien dengan 3 sesi (09:00, 14:00, 19:00). Masing-masing jadi 1 sesi di reservasi mirror.</small>
          </div>
          <div class="form-group"><label>Alamat</label><input type="text" id="kw_addr"></div>
          <hr style="margin:16px 0;border:none;border-top:1px dashed var(--border);">
          <h4 style="margin-bottom:10px;">Layanan</h4>
          <div id="kw_items"></div>
          <button onclick="addReceiptItem()" class="btn-sm btn-pay" style="margin-top:8px;">+ Tambah Layanan</button>
          <div class="form-row" style="margin-top:16px;">
            <div class="form-group"><label>Fee Transportasi</label><input type="number" id="kw_transport" value="0"></div>
            <div class="form-group"><label>Diskon</label><input type="number" id="kw_discount" value="0"></div>
          </div>
          <div class="summary-card" id="kw_summary">
            <div class="row"><span>Subtotal:</span><span id="kw_sub">Rp 0</span></div>
            <div class="row total"><span>Total:</span><span id="kw_total">Rp 0</span></div>
          </div>
          <button onclick="saveReceipt()" class="btn btn-primary" style="width:100%;justify-content:center;">💾 Simpan & Cetak Kwitansi</button>
        </div>
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <div>
            <h3 style="margin:0;">Riwayat Kwitansi</h3>
            <small style="color:var(--text-soft);">💡 Butuh restore data? Pakai tombol 📥 Import JSON atau 📄 Import PDF di kanan atas.</small>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="search" id="kwSearch" placeholder="Cari nama / invoice..." oninput="filterKwList()" class="kw-search">
            <button onclick="openImportKwitansiModal()" class="btn-sm btn-approve" title="Import dari JSON / spreadsheet">📥 Import JSON</button>
            <button onclick="openImportPdfKwitansiModal()" class="btn-sm" title="Restore kwitansi dari file PDF Adzkiya" style="background:#7c3aed;color:white;border:none;">📄 Import PDF</button>
            <details style="position:relative;display:inline-block;">
              <summary class="btn-sm" style="background:#0f766e;color:white;list-style:none;cursor:pointer;user-select:none;border:none;padding:6px 12px;border-radius:8px;font-size:0.8rem;font-weight:700;">📂 Cara Restore Lainnya ▾</summary>
              <div style="position:absolute;right:0;top:100%;margin-top:6px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;width:280px;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,0.15);font-size:0.85rem;line-height:1.5;">
                <strong style="display:block;margin-bottom:6px;">🔄 3 cara restore kwitansi:</strong>
                <div style="margin:4px 0;">📥 <strong>Import JSON</strong> — file backup .json dari sistem ini atau paste JSON langsung.</div>
                <div style="margin:4px 0;">📄 <strong>Import PDF</strong> — upload PDF kwitansi Adzkiya (yang dicetak dari sistem).</div>
                <div style="margin:4px 0;">🧾 <strong>Buat Manual</strong> — input 1 kwitansi via form di kolom kiri.</div>
                <div style="margin-top:8px;color:var(--text-soft);font-size:0.8rem;">
                  ⚠️ PDF hasil scan/foto tidak didukung (butuh OCR).
                </div>
              </div>
            </details>
          </div>
        </div>
        <div id="kwList">Loading...</div>
      </div>
    </div>
    <style>@media(max-width:920px),(hover:none) and (pointer:coarse) and (max-width:1024px){#kwGrid{grid-template-columns:1fr !important;}}</style>
  `;
  receiptItems = [];
  addReceiptItem();
  initKwTimes();
  // Reset state pencarian tiap kali halaman dibuka, supaya hasil yang
  // tampil selalu sinkron dengan isi kotak pencarian (yang baru dibuat
  // dalam keadaan kosong).
  KW_QUERY = '';
  clearTimeout(KW_SEARCH_TIMER);
  loadReceipts();
}

// Pencarian kwitansi. Kalau seluruh kwitansi sudah termuat di cache,
// filter lokal (instan) sudah cukup. Kalau masih ada halaman berikutnya
// di server, tanyakan ke server (debounce 300 ms) supaya kwitansi lama
// tetap bisa ditemukan.
function filterKwList() {
  const q = (document.getElementById('kwSearch')?.value || '').trim();
  KW_QUERY = q;
  clearTimeout(KW_SEARCH_TIMER);
  if (!q) { loadReceipts(); return; }
  if ((window._receiptsCache || []).length < KW_PAGE_SIZE) {
    kwFilterLoadedRows(q);
    return;
  }
  KW_SEARCH_TIMER = setTimeout(() => loadReceipts(), 300);
}

function kwFilterLoadedRows(q) {
  const needle = String(q).toLowerCase();
  const tbody = document.querySelector('#kwList tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr').forEach((tr) => {
    const text = tr.textContent.toLowerCase();
    const show = !needle || text.includes(needle);
    tr.style.display = show ? '' : 'none';
  });
}

function addReceiptItem(item) {
  const i = receiptItems.length;
  receiptItems.push(item || { name: '', price: 0, qty: 1 });
  rebuildReceiptItems();
}

function removeReceiptItem(idx) {
  receiptItems.splice(idx, 1);
  rebuildReceiptItems();
}

function rebuildReceiptItems() {
  const wrap = document.getElementById('kw_items');
  if (!wrap) return;
  wrap.innerHTML = '';
  receiptItems.forEach((item, i) => {
    const div = document.createElement('div');
    div.style.cssText = 'display:grid;grid-template-columns:1fr 90px 70px 32px;gap:8px;margin-bottom:8px;align-items:center;';
    div.innerHTML = `
      <select onchange="onReceiptServiceChange(${i}, this)">
        <option value="">— pilih layanan —</option>
        ${SERVICES.map(c => `<optgroup label="${esc(c.cat)}">${c.items.map(it => `<option value="${esc(it.name)}" data-price="${it.price}" ${item.name === it.name ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <div class="kw-price-tag" style="padding:8px 10px;background:var(--pink-50);border:1px solid var(--pink-100);border-radius:8px;font-weight:700;color:var(--pink-700);font-size:0.85rem;text-align:right;white-space:nowrap;">${fmtRp(item.price)}</div>
      <input type="number" placeholder="qty" value="${item.qty || 1}" min="1" oninput="receiptItems[${i}].qty=parseInt(this.value)||1;updateReceiptTotal();">
      <button onclick="removeReceiptItem(${i})" class="btn-sm btn-del" style="padding:6px;" title="Hapus baris">×</button>
    `;
    div.querySelectorAll('select, input').forEach(el => {
      el.style.cssText = (el.style.cssText || '') + ';padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;font-size:0.88rem;';
    });
    wrap.appendChild(div);
  });
  ['#kw_transport', '#kw_discount'].forEach(s => { const el = document.querySelector(s); if (el) el.oninput = updateReceiptTotal; });
  updateReceiptTotal();
}

function onReceiptServiceChange(idx, sel) {
  const opt = sel.options[sel.selectedIndex];
  const price = parseInt(opt.dataset.price) || 0;
  receiptItems[idx].name = sel.value;
  receiptItems[idx].price = price;
  rebuildReceiptItems();
}

function updateReceiptTotal() {
  const sub = receiptItems.reduce((s, it) => s + (it.price * it.qty), 0);
  const trans = parseInt(document.getElementById('kw_transport')?.value) || 0;
  const disc = parseInt(document.getElementById('kw_discount')?.value) || 0;
  const total = sub + trans - disc;
  if (document.getElementById('kw_sub')) document.getElementById('kw_sub').textContent = fmtRp(sub);
  if (document.getElementById('kw_total')) document.getElementById('kw_total').textContent = fmtRp(total);
}

function prefillReceipt(r) {
  document.getElementById('kw_name').value = r.patient_name;
  document.getElementById('kw_hp').value = r.whatsapp;
  document.getElementById('kw_addr').value = r.address;
  document.getElementById('kw_date').value = r.reservation_date;
  receiptItems = [];
  (r.items || []).forEach(it => receiptItems.push({ name: it.name, price: it.price, qty: it.qty }));
  if (!receiptItems.length) receiptItems.push({ name: '', price: 0, qty: 1 });
  rebuildReceiptItems();
  // Pre-fill slots from reservation (multi-waktu + multi-tanggal)
  if (r.slots && r.slots.length) {
    initKwSlots(r.slots.map((s) => ({ date: s.date, time: s.time })));
  }
}

// ===== MULTI-WAKTU + MULTI-TANGGAL (kwitansi manual) =====
// Each slot has a date AND a time. Total harga = subtotal × jumlah slot
// (per-waktu pricing) plus any transport_fee / discount. The
// auto-synced reservation gets one entry in `slots` per (date, time).
//
// Two forms share this UI:
//   • kwSlots — left side of /receipts page (manual kwitansi form)
//   • mkwSlots — modal "Buat Kwitansi Manual" in Rekap Bulanan
// Both are arrays of {date, time} objects (same shape as the API).
let kwSlots = [];
let mkwSlots = [];

function initKwTimes(initial) {
  // Legacy: support old kwTimes init by converting to slots. Prefer
  // initKwSlots when possible (date+time per slot).
  const today = localTodayStr();
  if (Array.isArray(initial) && initial.length && typeof initial[0] === 'string') {
    return initKwSlots([{ date: today, time: initial[0] }]);
  }
  return initKwSlots(initial);
}
function initMkwTimes(initial) {
  const today = localTodayStr();
  if (Array.isArray(initial) && initial.length && typeof initial[0] === 'string') {
    return initMkwSlots([{ date: today, time: initial[0] }]);
  }
  return initMkwSlots(initial);
}

// ===== Multi-date+time slots (newer, more flexible UI) =====

function normalizeSlot(s, fallbackDate) {
  if (!s || typeof s !== 'object') return null;
  const date = String(s.date || fallbackDate || '').slice(0, 10);
  const time = String(s.time || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  return { date, time };
}

function initKwSlots(initial) {
  const today = localTodayStr();
  const seed = (Array.isArray(initial) && initial.length)
    ? initial.map((s) => normalizeSlot(s, today)).filter(Boolean)
    : [{ date: today, time: '09:00' }];
  kwSlots = seed.length ? seed : [{ date: today, time: '09:00' }];
  renderKwSlots();
}

function addKwSlot(value) {
  const today = localTodayStr();
  const slot = normalizeSlot(value, today);
  if (!slot) return;
  if (kwSlots.find((x) => x.date === slot.date && x.time === slot.time)) return;
  kwSlots.push(slot);
  renderKwSlots();
}

function removeKwSlot(idx) {
  if (kwSlots.length <= 1) return; // keep at least one slot
  kwSlots.splice(idx, 1);
  renderKwSlots();
}

function getKwSlots() {
  const today = localTodayStr();
  return kwSlots.map((s) => normalizeSlot(s, today)).filter(Boolean);
}

function renderKwSlots() {
  const wrap = document.getElementById('kw_times');
  if (!wrap) return;
  const today = localTodayStr();
  if (!kwSlots.length) kwSlots = [{ date: today, time: '09:00' }];
  wrap.innerHTML = '';
  // Sort slots by date+time so the user sees them in chronological order
  const sorted = kwSlots.map((s, i) => ({ ...s, _origIdx: i }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  sorted.forEach((s) => {
    const realIdx = s._origIdx;
    const chip = document.createElement('span');
    chip.className = 'kw-time-chip';
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--pink-50);border:1px solid var(--pink-100);border-radius:999px;font-size:0.92rem;font-weight:600;color:var(--pink-700);';
    const dateLabel = s.date === today ? 'Hari ini' : new Date(s.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
    chip.innerHTML = `📅 ${dateLabel} &nbsp;⏰ ${s.time} <button type="button" onclick="removeKwSlot(${realIdx})" style="background:none;border:none;color:#c43050;cursor:pointer;font-weight:700;padding:0 2px;font-size:1rem;line-height:1;" title="Hapus jadwal">×</button>`;
    wrap.appendChild(chip);
  });
}

function initMkwSlots(initial) {
  const today = localTodayStr();
  const seed = (Array.isArray(initial) && initial.length)
    ? initial.map((s) => normalizeSlot(s, today)).filter(Boolean)
    : [{ date: today, time: '09:00' }];
  mkwSlots = seed.length ? seed : [{ date: today, time: '09:00' }];
  renderMkwSlots();
}

function mkwAddSlot(value) {
  const today = localTodayStr();
  const slot = normalizeSlot(value, today);
  if (!slot) return;
  if (mkwSlots.find((x) => x.date === slot.date && x.time === slot.time)) return;
  mkwSlots.push(slot);
  renderMkwSlots();
}

function removeMkwSlot(idx) {
  if (mkwSlots.length <= 1) return;
  mkwSlots.splice(idx, 1);
  renderMkwSlots();
}

function getMkwSlots() {
  const today = localTodayStr();
  return mkwSlots.map((s) => normalizeSlot(s, today)).filter(Boolean);
}

function renderMkwSlots() {
  const wrap = document.getElementById('mkw_times');
  if (!wrap) return;
  const today = localTodayStr();
  if (!mkwSlots.length) mkwSlots = [{ date: today, time: '09:00' }];
  wrap.innerHTML = '';
  const sorted = mkwSlots.map((s, i) => ({ ...s, _origIdx: i }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  sorted.forEach((s) => {
    const realIdx = s._origIdx;
    const chip = document.createElement('span');
    chip.className = 'kw-time-chip';
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--pink-50);border:1px solid var(--pink-100);border-radius:999px;font-size:0.92rem;font-weight:600;color:var(--pink-700);';
    const dateLabel = s.date === today ? 'Hari ini' : new Date(s.date).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
    chip.innerHTML = `📅 ${dateLabel} &nbsp;⏰ ${s.time} <button type="button" onclick="removeMkwSlot(${realIdx})" style="background:none;border:none;color:#c43050;cursor:pointer;font-weight:700;padding:0 2px;font-size:1rem;line-height:1;" title="Hapus jadwal">×</button>`;
    wrap.appendChild(chip);
  });
}

// Inline picker: pops a small date+time input + add button next to
// the chip row. Keeps the main UI tidy.
function addKwTimePrompt() {
  const wrap = document.getElementById('kw_times');
  if (!wrap) return;
  const existing = document.getElementById('kw_time_picker');
  if (existing) { existing.focus(); return; }
  const today = localTodayStr();
  const picker = document.createElement('span');
  picker.id = 'kw_time_picker';
  picker.className = 'kw-time-chip';
  picker.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:var(--card);border:2px solid var(--primary);border-radius:999px;flex-wrap:wrap;';
  picker.innerHTML = `<input type="date" id="kw_date_input" value="${today}" min="${today}" style="border:none;background:transparent;font-weight:600;color:var(--text);font-family:inherit;font-size:0.85rem;padding:0;width:130px;">
    <input type="time" id="kw_time_input" value="09:00" style="border:none;background:transparent;font-weight:600;color:var(--text);font-family:inherit;font-size:0.85rem;padding:0;width:80px;">
    <button type="button" onclick="commitKwTime()" style="background:var(--primary);color:white;border:none;cursor:pointer;font-weight:700;padding:2px 8px;border-radius:6px;font-size:0.85rem;">✓</button>
    <button type="button" onclick="cancelKwTimePicker()" style="background:none;border:none;color:var(--text-soft);cursor:pointer;font-weight:700;padding:0 2px;font-size:1rem;">×</button>`;
  wrap.appendChild(picker);
  document.getElementById('kw_date_input').focus();
}

function commitKwTime() {
  const date = document.getElementById('kw_date_input')?.value;
  const time = document.getElementById('kw_time_input')?.value;
  if (!date || !time) { cancelKwTimePicker(); return; }
  addKwSlot({ date, time });
  cancelKwTimePicker();
}

function cancelKwTimePicker() {
  document.getElementById('kw_time_picker')?.remove();
}

function addMkwTimePrompt() {
  const wrap = document.getElementById('mkw_times');
  if (!wrap) return;
  const existing = document.getElementById('mkw_time_picker');
  if (existing) { existing.focus(); return; }
  const today = localTodayStr();
  const picker = document.createElement('span');
  picker.id = 'mkw_time_picker';
  picker.className = 'kw-time-chip';
  picker.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:var(--card);border:2px solid var(--primary);border-radius:999px;flex-wrap:wrap;';
  picker.innerHTML = `<input type="date" id="mkw_date_input" value="${today}" min="${today}" style="border:none;background:transparent;font-weight:600;color:var(--text);font-family:inherit;font-size:0.85rem;padding:0;width:130px;">
    <input type="time" id="mkw_time_input" value="09:00" style="border:none;background:transparent;font-weight:600;color:var(--text);font-family:inherit;font-size:0.85rem;padding:0;width:80px;">
    <button type="button" onclick="commitMkwTime()" style="background:var(--primary);color:white;border:none;cursor:pointer;font-weight:700;padding:2px 8px;border-radius:6px;font-size:0.85rem;">✓</button>
    <button type="button" onclick="cancelMkwTimePicker()" style="background:none;border:none;color:var(--text-soft);cursor:pointer;font-weight:700;padding:0 2px;font-size:1rem;">×</button>`;
  wrap.appendChild(picker);
  document.getElementById('mkw_date_input').focus();
}

function commitMkwTime() {
  const date = document.getElementById('mkw_date_input')?.value;
  const time = document.getElementById('mkw_time_input')?.value;
  if (!date || !time) { cancelMkwTimePicker(); return; }
  mkwAddSlot({ date, time });
  cancelMkwTimePicker();
}

function cancelMkwTimePicker() {
  document.getElementById('mkw_time_picker')?.remove();
}

async function saveReceipt() {
  const items = receiptItems.filter(it => it.name && it.price > 0);
  if (!items.length) return alert('Tambahkan minimal 1 layanan');
  const slots = getKwSlots();
  if (!slots.length) return alert('Tambahkan minimal 1 jadwal');
  // If all slots are on the same date as the form's date input,
  // use the form's date. Otherwise the per-slot dates win.
  const formDate = document.getElementById('kw_date').value;
  const allSameDate = slots.every((s) => s.date === formDate);
  const body = {
    patient_name: document.getElementById('kw_name').value,
    whatsapp: document.getElementById('kw_hp').value,
    address: document.getElementById('kw_addr').value,
    service_date: allSameDate ? formDate : slots[0].date,
    service_slots: slots,
    items,
    transport_fee: parseInt(document.getElementById('kw_transport').value) || 0,
    discount: parseInt(document.getElementById('kw_discount').value) || 0
  };
  const res = await api('/api/admin/receipts', { method: 'POST', body: JSON.stringify(body) });
  printReceipt({ ...body, invoice_no: res.invoice_no, subtotal: res.subtotal, total: res.total, created_at: new Date().toISOString() });
  loadReceipts();
}

// Ukuran halaman daftar kwitansi. Server mengembalikan maksimum 200
// baris per request, jadi kalau hasilnya penuh kita tampilkan tombol
// "Muat lagi" — tanpa itu, kwitansi ke-201 dan seterusnya tidak akan
// pernah muncul (dan tidak bisa dicari) di halaman ini.
const KW_PAGE_SIZE = 200;
let KW_QUERY = '';        // kata kunci pencarian aktif (server-side)
let KW_SEARCH_TIMER = null;
async function loadReceipts(append) {
  const _token799 = renderToken('receipts');
  try {
    const cache = append ? (window._receiptsCache || []) : [];
    // Pencarian diteruskan ke server (?q=) supaya kwitansi lama yang
    // belum ada di cache tetap ketemu — filter lokal saja akan meleset
    // begitu jumlah kwitansi lebih dari satu halaman.
    const url = '/api/admin/receipts?limit=' + KW_PAGE_SIZE + '&offset=' + cache.length +
      (KW_QUERY ? '&q=' + encodeURIComponent(KW_QUERY) : '');
    const batch = await api(url);
  // Render yang lebih baru sudah dimulai — jangan menimpa hasilnya.
  if (!isLatestRender('receipts', _token799)) return;
    const rows = append ? cache.concat(batch) : batch;
    window._receiptsCache = rows;
    const hasMore = batch.length >= KW_PAGE_SIZE;
    const el = document.getElementById('kwList');
    // Enable the responsive card-list view for phones (<720px). The
    // CSS rule body[data-table-mode="cards"] hides the table on
    // small screens, so we render BOTH the table and the cards and
    // let CSS pick which one is visible.
    document.body.setAttribute('data-table-mode', 'cards');
    if (!rows.length) {
      el.innerHTML = KW_QUERY
        ? '<p style="color:var(--text-soft);padding:20px;text-align:center;">Tidak ada kwitansi yang cocok dengan pencarian.</p>'
        : '<p style="color:var(--text-soft);padding:20px;text-align:center;">Belum ada kwitansi.</p>';
      return;
    }
    el.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <label style="display:flex;gap:6px;align-items:center;font-size:0.88rem;cursor:pointer;">
          <input type="checkbox" id="kwSelectAll" onchange="toggleSelectAllReceipts(this.checked)"> Pilih semua
        </label>
        <span id="kwSelCount" style="font-size:0.82rem;color:var(--text-soft);"></span>
        <span style="flex:1;"></span>
        <button onclick="deleteSelectedReceipts()" class="btn-sm btn-del" id="kwBulkBtn" disabled style="padding:6px 14px;">🗑️ Hapus Terpilih</button>
        <button onclick="deleteAllReceipts()" class="btn-sm btn-del" style="padding:6px 14px;background:#b91c1c;">⚠️ Hapus Semua</button>
      </div>
      <div class="data-table-wrap">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th style="width:36px;"></th>
              <th>No. Invoice</th><th>Pasien</th><th>Total</th><th>Aksi</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `<tr data-rid="${r.id}">
                <td><input type="checkbox" class="kw-chk" value="${r.id}" onchange="updateKwSelCount()"></td>
                <td><strong>${esc(r.invoice_no || '')}</strong><br><small>${fmtDateTime(r.created_at)}</small></td>
                <td>${esc(r.patient_name || '-')}</td>
                <td><strong>${fmtRp(r.total)}</strong></td>
                <td style="white-space:nowrap;">
                  <button class="btn-sm btn-view" onclick="openKwitansiDetailModal(${r.id})" title="Lihat detail">👁️</button>
                  <button class="btn-sm" onclick='quickSavePDF(${r.id})' title="Download PDF langsung (pakai ukuran kertas tersimpan)" style="padding:6px 10px;background:#7c3aed;color:white;border:none;font-weight:700;">💾</button>
                  <button class="btn-sm btn-view" onclick='shareOrPrintKwitansi(${r.id})' title="Kirim/Cetak/Save PDF (buka menu)" aria-label="Kirim atau cetak kwitansi">📤</button>
                  <button class="btn-sm btn-del" onclick="deleteReceipt(${r.id}, '${escJs(r.invoice_no)}')" title="Hapus" style="padding:6px 10px;">🗑️</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="card-list" aria-label="Daftar kwitansi (tampilan kartu untuk HP)">
        ${rows.map(r => `<div class="card-list-item" data-rid="${r.id}">
          <div class="cli-head">${esc(r.invoice_no || '')}</div>
          <div class="cli-meta">📅 ${fmtDateTime(r.created_at)}</div>
          <div class="cli-row"><span class="cli-label">Pasien</span><span class="cli-value">${esc(r.patient_name || '-')}</span></div>
          <div class="cli-row"><span class="cli-label">Total</span><span class="cli-value">${fmtRp(r.total)}</span></div>
          <div class="cli-actions">
            <label style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--bg);border-radius:8px;font-size:0.78rem;font-weight:700;">
              <input type="checkbox" class="kw-chk" value="${r.id}" onchange="updateKwSelCount()"> Pilih
            </label>
            <button class="btn-sm btn-view" onclick="openKwitansiDetailModal(${r.id})" title="Lihat detail">👁️ Lihat</button>
            <button class="btn-sm" onclick='quickSavePDF(${r.id})' title="Download PDF langsung (pakai ukuran kertas tersimpan)" style="background:#7c3aed;color:white;border:none;font-weight:700;">💾 PDF</button>
            <button class="btn-sm btn-view" onclick='shareOrPrintKwitansi(${r.id})' title="Kirim/Cetak/Save PDF (buka menu)" aria-label="Kirim atau cetak kwitansi">📤 Menu</button>
            <button class="btn-sm btn-del" onclick="deleteReceipt(${r.id}, '${escJs(r.invoice_no)}')" title="Hapus">🗑️ Hapus</button>
          </div>
        </div>`).join('')}
      </div>
      ${hasMore ? `<div style="text-align:center;margin-top:14px;">
        <button type="button" class="btn-sm btn-view" onclick="loadReceipts(true)" style="padding:10px 20px;">⬇️ Muat ${KW_PAGE_SIZE} kwitansi lagi</button>
        <div style="font-size:0.78rem;color:var(--text-soft);margin-top:6px;">Menampilkan ${rows.length} kwitansi terbaru.</div>
      </div>` : `<div style="text-align:center;font-size:0.78rem;color:var(--text-soft);margin-top:12px;">Total ${rows.length} kwitansi.</div>`}`;
    updateKwSelCount();
  } catch (e) { document.getElementById('kwList').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

function printReceiptById(id) {
  const r = (window._receiptsCache || []).find(x => x.id === id);
  if (r) printReceipt(r);
}
// "Share to customer" — opens a small prompt to choose: share
// link (for WA/email) or print. Defaults to share-link since the
// admin is more often on a phone and wants to send a quick link.
// Direct Save PDF — used by both the modal's primary Download button
// and by any future inline "PDF" buttons on the kwitansi list.
// Wraps the async saveKwitansiAsPDF in a try/catch + alert so any
// failure shows a clear message instead of silently failing.
async function directSavePDF(r, paperSize, includeSignature) {
  try {
    await saveKwitansiAsPDF(r, paperSize, { includeSignature });
  } catch (e) {
    alert('Gagal membuat PDF: ' + (e.message || e));
    console.error('Save PDF failed:', e);
  }
}


// Quick save PDF (no modal) — uses the admin's saved paper size from
// localStorage. Called by inline 💾 buttons on the kwitansi list rows.
// Skips the share/print modal entirely for fastest one-click download.
async function quickSavePDF(id) {
  const r = (window._receiptsCache || RECAP_RECEIPTS || []).find(x => x.id === id);
  if (!r) return alert('Kwitansi tidak ditemukan.');
  const paperSize = localStorage.getItem('adm_kw_paper_size') || 'A5';
  // Read includeSignature preference (same default logic as modal).
  const hasSignature = !!(SETTINGS && SETTINGS.has_owner_signature);
  const stored = localStorage.getItem('adm_kw_pdf_include_signature');
  const includeSig = stored === null ? hasSignature : stored === 'true';
  // Baca preferensi "sembunyikan tanda tangan" (Penerima & Hormat kami).
  const hideSig = localStorage.getItem('adm_kw_pdf_hide_signatures') === 'true';
  try {
    await saveKwitansiAsPDF(r, paperSize, { includeSignature: includeSig, hideSignatures: hideSig });
  } catch (e) {
    alert('Gagal membuat PDF: ' + (e.message || e));
    console.error('Quick save PDF failed:', e);
  }
}

// Modal: "Kirim / Cetak / Save PDF Kwitansi" with Save PDF as the
// primary action. Restructured so the size selector + Download button
// are immediately visible at the top — fixes the bug where users had
// to click through other options to find the download.
function shareOrPrintKwitansi(id) {
  const r = (window._receiptsCache || RECAP_RECEIPTS || []).find(x => x.id === id);
  if (!r) return alert('Kwitansi tidak ditemukan.');
  // Default paper size = A5. Persisted per-admin in localStorage so
  // the choice survives across sessions.
  const paperSize = localStorage.getItem('adm_kw_paper_size') || 'A5';
  // Default "include signature" = true if admin has one saved, otherwise false.
  // Also persisted to localStorage so it survives across sessions.
  const hasSignature = !!(SETTINGS && SETTINGS.has_owner_signature);
  const includeSigDefault = localStorage.getItem('adm_kw_pdf_include_signature');
  const includeSig = includeSigDefault === null ? hasSignature : includeSigDefault === 'true';
  // Preferensi "sembunyikan blok tanda tangan (Penerima & Hormat kami)".
  // Default = tidak disembunyikan (perilaku lama). Disimpan di localStorage.
  const hideSig = localStorage.getItem('adm_kw_pdf_hide_signatures') === 'true';

  // Build size options for the dropdown
  const sizeOptions = Object.entries(KW_PAPER_SIZES)
    .map(([k, v]) => `<option value="${k}" ${paperSize === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`)
    .join('');

  openModal(`
    <h3>📤 Kwitansi <span style="color:var(--text-soft);font-size:0.85rem;font-weight:500;">${esc(r.invoice_no || '')}</span></h3>
    <p style="color:var(--text-soft);font-size:0.9rem;margin:6px 0 14px;">Pilih aksi untuk kwitansi atas nama <strong>${esc(r.patient_name || 'pasien')}</strong>:</p>

    <!-- SECTION 1: SAVE PDF (primary action, put at top so users find it instantly) -->
    <div style="padding:16px;background:linear-gradient(135deg,#fdf2f8,#fff5f0);border:2px solid #ee5a8a;border-radius:14px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <strong style="font-size:1rem;color:#2a1822;">💾 Save PDF — Langsung Download</strong>
        <span style="font-size:0.76rem;background:#ee5a8a;color:white;padding:3px 10px;border-radius:999px;font-weight:700;letter-spacing:0.5px;">PRIMARY</span>
      </div>

      <label style="display:block;font-size:0.82rem;color:var(--text-soft);margin-bottom:4px;font-weight:600;">📐 Ukuran Kertas</label>
      <select id="kwPdfSize" onchange="localStorage.setItem('adm_kw_paper_size', this.value);" style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-size:0.88rem;font-family:inherit;font-weight:600;margin-bottom:12px;">
        ${sizeOptions}
      </select>

      <!-- SIGNATURE TOGGLE — always visible (was conditional on hasSignature).
           Admin can choose to include OR hide the owner signature in the PDF.
           When admin has no signature saved, the option still shows but is
           disabled with a "Tambah dulu di pengaturan" hint. -->
      <div style="background:white;border:2px solid #ee5a8a;border-radius:10px;padding:10px 12px;margin-bottom:12px;">
        <label style="display:flex;align-items:center;gap:10px;cursor:${hasSignature ? 'pointer' : 'not-allowed'};">
          <input type="checkbox" id="kwPdfIncludeSig" ${includeSig ? 'checked' : ''} ${hasSignature ? '' : 'disabled'} onchange="localStorage.setItem('adm_kw_pdf_include_signature', this.checked);" style="width:20px;height:20px;cursor:${hasSignature ? 'pointer' : 'not-allowed'};accent-color:#ee5a8a;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.92rem;color:var(--text);font-weight:700;line-height:1.3;">✍️ Sertakan tanda tangan bidan/pemilik</div>
            <div style="font-size:0.78rem;color:var(--text-soft);margin-top:2px;line-height:1.4;">${hasSignature ? 'Centang untuk menampilkan gambar tanda tangan di blok "Hormat kami". Hapus centang untuk kwitansi tanpa tanda tangan.' : '<a href="javascript:void(0)" onclick=\"closeModal();navigate(\'settings\');\" style=\"color:#ee5a8a;font-weight:700;text-decoration:underline;\">Tambah tanda tangan dulu di Pengaturan</a> untuk mengaktifkan opsi ini.'}</div>
          </div>
        </label>
        ${hasSignature ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #ffd6e2;font-size:0.76rem;color:var(--text-soft);display:flex;align-items:center;gap:6px;">
          <span style="background:#fff5f8;padding:2px 6px;border-radius:6px;">📌 Disimpan: ${esc(SETTINGS.owner_signature_method || 'unknown')}${SETTINGS.owner_signature_via ? ' / ' + esc(SETTINGS.owner_signature_via) : ''}</span>
        </div>` : ''}
      </div>

      <!-- Toggle: sembunyikan blok tanda tangan (Penerima & Hormat kami) -->
      <div style="background:white;border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
          <input type="checkbox" id="kwPdfHideSig" ${hideSig ? 'checked' : ''} onchange="localStorage.setItem('adm_kw_pdf_hide_signatures', this.checked);" style="width:18px;height:18px;cursor:pointer;accent-color:#7c3aed;flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.9rem;color:var(--text);font-weight:700;line-height:1.3;">🙈 Sembunyikan blok tanda tangan (Penerima &amp; Hormat kami)</div>
            <div style="font-size:0.76rem;color:var(--text-soft);margin-top:2px;line-height:1.4;">Centang untuk menghapus kedua kolom tanda tangan dari PDF — kwitansi jadi lebih ringkas.</div>
          </div>
        </label>
      </div>

      <button id="kwDownloadBtn" type="button" class="btn btn-primary" style="width:100%;justify-content:center;padding:14px;background:#7c3aed;font-size:1rem;">
        <span>💾 Download ${esc(r.invoice_no || 'kwitansi')}.pdf</span>
        <small style="display:block;font-weight:500;font-size:0.78rem;opacity:0.85;margin-top:2px;">File langsung ter-download, ukuran kertas sudah tertanam</small>
      </button>
      <small style="display:block;margin-top:8px;color:var(--text-soft);line-height:1.5;font-size:0.78rem;">💡 PDF yang di-generate sudah tertanam ukuran kertas (A4/A5/F4/Thermal), jadi saat dibuka di laptop/HP → di-print → langsung sesuai tanpa harus setting ukuran kertas lagi di printer dialog.</small>
    </div>

    <!-- SECTION 2: Other options -->
    <div style="border-top:1px dashed var(--border);padding-top:12px;">
      <div style="font-size:0.76rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);font-weight:700;margin-bottom:8px;">Atau pilih opsi lain:</div>
      <div style="display:grid;gap:8px;">
        <button type="button" onclick="shareKwitansiById(${r.id});closeModal();" class="btn btn-outline" style="width:100%;justify-content:flex-start;padding:10px 14px;">
          💬 <span style="margin-left:4px;">Share Link via WhatsApp</span>
          <small style="margin-left:8px;color:var(--text-soft);font-size:0.76rem;">— buat link privat</small>
        </button>
        <button type="button" onclick="closeModal();printReceiptById(${r.id});" class="btn btn-outline" style="width:100%;justify-content:flex-start;padding:10px 14px;">
          🖨️ <span style="margin-left:4px;">Cetak + Tanda Tangan Pasien</span>
          <small style="margin-left:8px;color:var(--text-soft);font-size:0.76rem;">— print preview dengan signature pad</small>
        </button>
        <button type="button" onclick="downloadProtected('/api/proof/${r.id}', '${escJs(r.invoice_no)}.${escJs(r.proof_mime ? r.proof_mime.split('/')[1] : 'bin')}')" class="btn btn-outline" style="width:100%;justify-content:flex-start;padding:10px 14px;">
          📎 <span style="margin-left:4px;">Download Bukti Pembayaran</span>
        </button>
      </div>
    </div>
  `);

  // Wire up the Download button. We attach the click handler HERE
  // (after openModal renders the HTML) instead of using inline
  // onclick because we need to read the current checkbox state +
  // select value at click time, and we want to disable the button
  // while the PDF is being generated so the user can't double-click.
  // NOTE: the receipt is read straight from the closure `r` (always in
  // scope) — we deliberately do NOT stash it on a global, because a
  // global + a backdrop "cleanup" listener broke before: any click that
  // bubbled to the backdrop (e.g. changing the paper-size dropdown) ran
  // the cleanup and nulled the receipt, forcing the user to close &
  // reopen the modal before Download worked. Using the closure fixes that.
  const btn = document.getElementById('kwDownloadBtn');
  if (btn) {
    btn.addEventListener('click', async function onKwDownloadClick() {
      const sizeEl = document.getElementById('kwPdfSize');
      const sigEl = document.getElementById('kwPdfIncludeSig');
      const hideSigEl = document.getElementById('kwPdfHideSig');
      const size = sizeEl ? sizeEl.value : 'A5';
      const includeSig = sigEl ? sigEl.checked : true;
      const hideSig = hideSigEl ? hideSigEl.checked : false;
      if (!r) {
        alert('Kwitansi tidak ditemukan. Silakan coba lagi.');
        return;
      }
      // Disable button + show progress
      btn.disabled = true;
      const origText = btn.innerHTML;
      btn.innerHTML = '<span style="opacity:0.85;">⏳ Membuat PDF...</span>';
      try {
        await saveKwitansiAsPDF(r, size, { includeSignature: includeSig, hideSignatures: hideSig });
      } catch (e) {
        alert('Gagal membuat PDF: ' + (e.message || e));
        console.error('Save PDF failed:', e);
      } finally {
        // Re-enable for the next download attempt
        btn.disabled = false;
        btn.innerHTML = origText;
      }
    });
  }
}

function toggleSelectAllReceipts(checked) {
  document.querySelectorAll('.kw-chk').forEach(c => { c.checked = checked; });
  updateKwSelCount();
}

function updateKwSelCount() {
  const sel = document.querySelectorAll('.kw-chk:checked').length;
  const total = document.querySelectorAll('.kw-chk').length;
  const cEl = document.getElementById('kwSelCount');
  if (cEl) cEl.textContent = sel ? `(${sel} dari ${total} dipilih)` : '';
  const btn = document.getElementById('kwBulkBtn');
  if (btn) btn.disabled = sel === 0;
  const all = document.getElementById('kwSelectAll');
  if (all) all.checked = sel > 0 && sel === total;
}

async function deleteReceipt(id, invoice) {
  if (!confirm(`Hapus kwitansi ${invoice}?\nTindakan tidak dapat dibatalkan.`)) return;
  try {
    await api('/api/admin/receipts/' + id, { method: 'DELETE' });
    loadReceipts();
  } catch (e) { alert('Gagal: ' + e.message); }
}

async function deleteSelectedReceipts() {
  const ids = Array.from(document.querySelectorAll('.kw-chk:checked')).map(c => parseInt(c.value));
  if (!ids.length) return;
  if (!confirm(`Hapus ${ids.length} kwitansi terpilih?\nTindakan tidak dapat dibatalkan.`)) return;
  try {
    const res = await api('/api/admin/receipts/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    alert(`✅ ${res.deleted} kwitansi dihapus`);
    loadReceipts();
  } catch (e) { alert('Gagal: ' + e.message); }
}

async function deleteAllReceipts() {
  const rows = window._receiptsCache || [];
  if (!rows.length) return alert('Tidak ada kwitansi untuk dihapus.');
  // Hati-hati: daftar di layar hanya sebagian (maks. 200 per halaman),
  // sedangkan aksi ini menghapus SELURUH kwitansi di sistem. Sebutkan itu
  // supaya admin tidak salah sangka soal berapa data yang hilang.
  if (!confirm(`⚠️ HAPUS SEMUA kwitansi di sistem?\n\nDaftar di layar saat ini memuat ${rows.length} kwitansi (maksimal 200 per halaman), tetapi aksi ini menghapus SELURUH kwitansi termasuk yang belum dimuat.\n\nTindakan ini PERMANEN dan tidak dapat dibatalkan.\n\nLanjutkan?`)) return;
  const confirm2 = prompt('Ketik HAPUS SEMUA untuk konfirmasi:');
  if (confirm2 !== 'HAPUS SEMUA') return alert('Dibatalkan.');
  try {
    const res = await api('/api/admin/receipts', { method: 'DELETE' });
    alert(`✅ ${res.deleted} kwitansi dihapus.`);
    loadReceipts();
  } catch (e) { alert('Gagal: ' + e.message); }
}

// ===== DIGITAL SIGNATURE PAD =====
// Render an inline <canvas> signature pad into a target element.
// Supports both mouse (PC) and touch (mobile/tablet) input. The
// signature is exported as a base64 PNG and inlined into the kwitansi
// HTML so it prints as part of the receipt. Optional — admin can
// choose to skip the signature if the customer signed on paper.
function attachSignaturePad(canvasId, wrapId) {
  const canvas = document.getElementById(canvasId);
  const wrap = document.getElementById(wrapId);
  if (!canvas || !wrap) return;
  // Size the canvas to its CSS box. Devicepixelratio handling ensures
  // the captured signature is crisp when printed.
  function sizeCanvas() {
    const r = wrap.getBoundingClientRect();
    canvas.width = r.width * window.devicePixelRatio;
    canvas.height = 140 * window.devicePixelRatio;
    canvas.style.width = r.width + 'px';
    canvas.style.height = '140px';
    const ctx = canvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2a1822';
  }
  sizeCanvas();
  const ctx2d = canvas.getContext('2d');
  let drawing = false, last = null;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function start(e) {
    e.preventDefault();
    drawing = true;
    last = pos(e);
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx2d.beginPath();
    ctx2d.moveTo(last.x, last.y);
    ctx2d.lineTo(p.x, p.y);
    ctx2d.stroke();
    last = p;
  }
  function end(e) {
    if (!drawing) return;
    e.preventDefault();
    drawing = false;
    last = null;
  }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
  // Expose helper methods on the canvas DOM node so the print
  // button can clear / extract.
  canvas._clearSig = () => {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  };
  canvas._getSigDataUrl = () => {
    if (isCanvasBlank(canvas)) return null;
    return canvas.toDataURL('image/png');
  };
}
function isCanvasBlank(canvas) {
  // Quick way to detect whether the user actually drew something.
  // Empty canvases return all-zeros when read with getImageData.
  // For privacy we avoid reading pixels (large canvas on retina
  // can be slow) — instead just compare the toDataURL hash.
  const blank = document.createElement('canvas');
  blank.width = canvas.width;
  blank.height = canvas.height;
  return canvas.toDataURL() === blank.toDataURL();
}
function clearSignaturePad(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (canvas && canvas._clearSig) canvas._clearSig();
}

// ===== SHARE KWITANSI LINK =====
// Generates a tokenized read-only URL the admin can paste into WA /
// email so the customer can view their receipt without admin login.
// The token is just a deterministic hash of (invoice_no + created_at)
// — not crypto-secure but good enough for "anyone-with-the-link"-
// style sharing. Real auth would require signed JWTs; for now this
// keeps the feature zero-config.
// ===== SHARE KWITANSI LINK =====
// Ask the server to mint a signed token via POST /api/admin/receipts/:id/share
// (HMAC over invoice_no|created_at|total, 30-day TTL). The token format is
// `<base64-data>.<ts>.<sig>` and the public /api/public/receipt/:token
// endpoint re-derives the receipt from that signature — so the link
// keeps working across server restarts as long as JWT_SECRET and the
// underlying receipt haven't changed. We do NOT roll our own base64
// token client-side anymore (that used to generate single-part tokens
// that the server-side validator would always reject, giving every
// share link a false "kadaluarsa" error).
async function shareKwitansiById(id) {
  try {
    // Mint the signed token on the server. The endpoint requires the
    // admin's JWT (Authorization header is added by api()).
    const { token, expires_at } = await api('/api/admin/receipts/' + id + '/share', { method: 'POST' });
    if (!token) throw new Error('Server tidak mengembalikan token.');
    const url = `${window.location.origin}/kwitansi-share.html?t=${encodeURIComponent(token)}`;
    // Try native share sheet first (mobile), fall back to copy.
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Kwitansi`,
          text: `Ini kwitansi Anda dari Adzkiya Mom Baby Care. Buka link ini untuk melihat & download:`,
          url: url
        });
        return;
      } catch { /* user dismissed; fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      const exp = expires_at ? new Date(expires_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
      alert(`✅ Link kwitansi disalin ke clipboard:\n${url}\n\nLink berlaku sampai ${exp || '30 hari ke depan'}.`);
    } catch {
      prompt('Salin link ini untuk dikirim ke pelanggan:', url);
    }
  } catch (e) { alert('Gagal membuat link share: ' + e.message); }
}

async function printReceipt(r) {
  const items = Array.isArray(r.items) ? r.items : (r.items || JSON.parse(r.items_json || '[]'));
  const biz = SETTINGS || {};
  // Tanda tangan diambil lebih dulu (butuh token admin). Kalau gagal,
  // kwitansi tetap tercetak tanpa gambar tanda tangan.
  const ownerSigDataUrl = (biz && biz.has_owner_signature) ? await fetchOwnerSignatureDataUrl() : '';
  const logoSrc = biz.has_logo ? apiUrl('/api/logo') : null;
  // Preferensi "sembunyikan blok tanda tangan (Penerima & Hormat kami)"
  // juga diterapkan pada tampilan cetak agar konsisten dgn PDF.
  const hideSigPrint = localStorage.getItem('adm_kw_pdf_hide_signatures') === 'true';
  // Multi-waktu support: prefer service_times[] if available, fall back
  // to service_time. Render each as a chip so several sessions fit
  // gracefully on a single line.
  const times = (Array.isArray(r.service_times) && r.service_times.length)
    ? r.service_times
    : (r.service_time ? [r.service_time] : []);
  const timesHtml = times.length
    ? times.map((t) => `<span class="kwitansi-time-chip">⏰ ${esc(t)} WIB</span>`).join('')
    : '<span style="color:var(--text-soft);">—</span>';
  const sessionsLabel = times.length > 1 ? `<strong style="color:var(--primary);">${times.length} sesi</strong>` : '';
  // Kwitansi rendered into a standalone tab. Uses the same .invoice
  // CSS classes as the in-app receipt preview, so the print result
  // matches exactly what's shown on-screen.
  const html = `<!doctype html><html><head><title>Kwitansi ${esc(r.invoice_no || '')}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${PAGE_STYLESHEET}">
    <style>
      body{background:#f7f2f4;padding:30px;font-family:'Plus Jakarta Sans',sans-serif;margin:0;}
      .print-actions{display:flex;justify-content:center;gap:10px;margin-bottom:20px;flex-wrap:wrap;}
      /* Sudut sedang (bukan pil) karena label seperti "Cetak / Save PDF"
         bisa membungkus di layar sempit; teks boleh membelah kata panjang
         supaya tidak meluber keluar tombol. */
      .print-actions button{padding:11px 20px;color:white;border:none;border-radius:12px;font-weight:700;cursor:pointer;font-size:0.95rem;font-family:inherit;line-height:1.35;min-height:44px;overflow-wrap:anywhere;}
      @media (max-width:560px){.print-actions{width:100%;}.print-actions button{flex:1 1 100%;}}
      @media print{body{background:white;padding:0;margin:0;}.print-actions{display:none !important;}}
    </style>
    </head><body>
    <div class="print-actions">
      <button id="printBtn" onclick="embedSigAndPrint()" style="background:#ee5a8a;">🖨️ Cetak / Save PDF</button>
      ${hideSigPrint ? '' : '<button id="clearBtn" onclick="if(window.__sigPad && window.__sigPad._clearSig) window.__sigPad._clearSig()" style="background:#f4a83a;color:white;">✏️ Ulangi TTD</button>'}
      <button onclick="window.close()" style="background:var(--card);color:var(--text);border:1px solid var(--border);">✕ Tutup</button>
    </div>
    <div id="sigWrap" style="${hideSigPrint ? 'display:none;' : ''}max-width:760px;margin:0 auto 12px;padding:14px 18px;background:var(--card);border-radius:12px;box-shadow:var(--shadow);border:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
        <strong style="font-size:0.92rem;color:var(--primary);">✍️ Tanda Tangan Pasien (Opsional)</strong>
        <small style="color:var(--text-soft);">Bisa dilewati untuk hasil cetak cepat</small>
      </div>
      <div id="sigPadWrap" style="background:#fdfafc;border:2px dashed var(--pink-200);border-radius:10px;overflow:hidden;">
        <canvas id="sigPad" style="display:block;touch-action:none;width:100%;height:140px;"></canvas>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:0.78rem;color:var(--text-soft);">
        <span>💡 Tanda tangan di area putih di atas</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="sigInclude" checked> Sertakan di kwitansi
        </label>
      </div>
    </div>
    <div class="invoice">
      <div class="invoice-header">
        <div class="invoice-brand">
          ${logoSrc ? `<img src="${logoSrc}" alt="">` : '<span style="font-size:2.4rem;">🌸</span>'}
          <div>
            <h2>${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</h2>
            <small>${esc(biz.tagline || 'Layanan Kesehatan Ibu & Anak Terpercaya')}<br>
            ${esc(biz.address || '')}<br>
            WA: ${esc(biz.phone || '085887018194')}</small>
          </div>
        </div>
        <div class="invoice-meta">
          <strong>KWITANSI</strong>
          <span class="invoice-meta-no">${esc(r.invoice_no || '')}</span>
          <small>${new Date(r.created_at).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })}</small>
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
            ${r.service_date ? new Date(r.service_date).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }) : '-'}
            <span class="kwitansi-time-row">${timesHtml}</span>
          </p>
        </div>
      </div>
      <table class="invoice-table">
        <thead><tr><th>Layanan</th><th class="num">Qty</th><th class="num">Harga</th><th class="num">Subtotal</th></tr></thead>
        <tbody>
          ${items.map(it => `<tr>
            <td>${esc(it.name)}</td>
            <td class="num">${it.qty}</td>
            <td class="num">${fmtRp(it.price)}</td>
            <td class="num">${fmtRp(it.price * it.qty)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>${fmtRp(r.subtotal)}</span></div>
        ${r.transport_fee ? `<div class="row"><span>Transportasi</span><span>${fmtRp(r.transport_fee)}</span></div>` : ''}
        ${r.discount ? `<div class="row"><span>Diskon</span><span>-${fmtRp(r.discount)}</span></div>` : ''}
        <div class="row grand"><span>TOTAL</span><span>${fmtRp(r.total)}</span></div>
      </div>
      <div class="invoice-footer">
        <div style="${hideSigPrint ? 'display:none;' : 'display:flex;'}justify-content:space-between;align-items:flex-start;gap:24px;flex-wrap:wrap;text-align:left;">
          <div style="flex:1;min-width:200px;">
            <div style="font-size:0.82rem;color:var(--text-soft);">Penerima,</div>
            <img id="sigEmbed" alt="" style="display:none;max-height:80px;max-width:240px;margin-top:6px;margin-bottom:6px;background:transparent;" />
            <div id="sigEmbedPlaceholder" style="margin-top:50px;border-top:1px solid #2a1822;padding-top:6px;font-weight:700;">${esc(r.patient_name || '-')}</div>
            <div style="font-size:0.78rem;color:var(--text-soft);">Nama jelas & tanda tangan</div>
          </div>
          <div style="flex:1;min-width:200px;text-align:right;">
            <div style="font-size:0.82rem;color:var(--text-soft);">Hormat kami,</div>
            <img id="ownerSigEmbed" src="" alt="Tanda tangan ${esc(biz.business_name || '')}" style="display:none;max-height:60px;max-width:220px;margin:4px 0 4px auto;background:transparent;" />
            <div id="ownerSigUnderline" style="margin-top:50px;border-top:1px solid #2a1822;padding-top:6px;font-weight:700;"><em>${esc(biz.practitioner || 'Tasya Hanifah Pramesti, A.Md. Keb., CBME')}</em></div>
            <div style="font-size:0.78rem;color:var(--text-soft);">${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</div>
          </div>
        </div>
        <div style="margin-top:20px;padding-top:14px;border-top:1px dashed var(--pink-200);text-align:center;">
          <div style="font-size:0.92rem;">Terima kasih atas kepercayaan Anda 🌸</div>
          <div style="font-size:0.82rem;line-height:1.55;color:var(--text-soft);margin-top:6px;">Kwitansi ini sah dan diproses secara elektronik oleh sistem.</div>
        </div>
      </div>
    </div>
    <script>
    // Signature pad setup. Runs INSIDE the print-preview window so
    // every event listener, getBoundingClientRect, and getContext call
    // works against the right DOM/window. Previously the parent
    // (admin.js) called attachSignaturePad() which always did
    // document.getElementById('sigPad') — and since admin.js's
    // \`document\` refers to the original window, it returned null,
    // so the function bailed out at the guard and the canvas never
    // got any pointer/touch listeners. That was the "bug tidak
    // bisa TTD". This self-contained script fixes it by owning the
    // canvas from the start.
    (function() {
      const canvas = document.getElementById('sigPad');
      const wrap = document.getElementById('sigPadWrap');
      if (!canvas || !wrap) return;
      // Jika blok tanda tangan disembunyikan (fitur hide-signatures), pad
      // ini display:none → lebarnya 0. Tanpa guard, loop rAF di bawah akan
      // berjalan selamanya (buang CPU/baterai). Kita deteksi lebih awal.
      if (wrap.offsetParent === null && getComputedStyle(wrap).display === 'none') return;
      if (wrap.closest('[style*="display:none"], [style*="display: none"]')) return;
      let _sizeTries = 0;
      function sizeCanvas() {
        // Wrap's CSS already gives the canvas a fixed pixel height
        // (140px) and 100% width. We measure AFTER layout so the
        // bounding rect is non-zero (calling getBoundingClientRect
        // before paint would yield 0×0 for the just-opened tab).
        const r = wrap.getBoundingClientRect();
        if (r.width <= 0) {
          // Tab belum lay out (atau elemen disembunyikan). Defer ke frame
          // berikutnya, tapi BOUNDED — supaya tidak pernah loop selamanya.
          if (++_sizeTries > 120) return;
          requestAnimationFrame(sizeCanvas);
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        canvas.width = r.width * dpr;
        canvas.height = 140 * dpr;
        canvas.style.width = r.width + 'px';
        canvas.style.height = '140px';
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#2a1822';
      }
      sizeCanvas();
      // Re-size on window resize so the canvas stays matched to its
      // CSS box (the @media print rule below hides the wrap on
      // paper so the resize has no effect there).
      window.addEventListener('resize', sizeCanvas);
      const ctx2d = canvas.getContext('2d');
      let drawing = false, last = null;
      function pos(e) {
        const r = canvas.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
      }
      function start(e) {
        e.preventDefault();
        drawing = true;
        last = pos(e);
      }
      function move(e) {
        if (!drawing) return;
        e.preventDefault();
        const p = pos(e);
        ctx2d.beginPath();
        ctx2d.moveTo(last.x, last.y);
        ctx2d.lineTo(p.x, p.y);
        ctx2d.stroke();
        last = p;
      }
      function end(e) {
        if (!drawing) return;
        if (e) e.preventDefault();
        drawing = false;
        last = null;
      }
      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', end);
      canvas.addEventListener('touchcancel', end);
      // Expose helper methods on the canvas DOM node so the print
      // button can clear / extract.
      canvas._clearSig = function() {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      };
      canvas._getSigDataUrl = function() {
        const blank = document.createElement('canvas');
        blank.width = canvas.width;
        blank.height = canvas.height;
        if (canvas.toDataURL() === blank.toDataURL()) return null;
        return canvas.toDataURL('image/png');
      };
      // Expose the canvas on window so the "Ulangi TTD" button's
      // onclick (set inline above) can find it without needing its
      // ID (the inline onclick runs in this window's scope).
      window.__sigPad = canvas;
      // "Sertakan di kwitansi" checkbox: when off, clear the pad
      // so a stale signature doesn't sneak into the printed PDF.
      const inc = document.getElementById('sigInclude');
      if (inc) inc.addEventListener('change', () => { if (!inc.checked) canvas._clearSig(); });

      // Capture the signature as a PNG and embed it into the invoice's
      // "Penerima," block right before the user triggers window.print().
      // Without this, the signature stays on the canvas but never ends
      // up in the printed/Save-as-PDF output. The <img id="sigEmbed"> is
      // hidden by default — show it only when we actually have a
      // non-empty signature AND the "Sertakan di kwitansi" checkbox is
      // still checked. We collapse the nama placeholder's margin-top
      // so the rendered TTD sits cleanly above the underline border.
      function embedSigAndPrint() {
        const img = document.getElementById('sigEmbed');
        const placeholder = document.getElementById('sigEmbedPlaceholder');
        const include = inc && inc.checked;
        const dataUrl = canvas._getSigDataUrl();
        if (include && dataUrl) {
          img.src = dataUrl;
          img.style.display = 'block';
          if (placeholder) placeholder.style.marginTop = '8px';
        } else {
          img.removeAttribute('src');
          img.style.display = 'none';
          if (placeholder) placeholder.style.marginTop = '50px';
        }
        // Also embed the saved owner signature (bidan/pemilik) into
        // the "Hormat kami," block, if the parent's SETTINGS flag is
        // true. We resolve it to a data URL via fetch so the print
        // pipeline doesn't need auth headers. If the request fails
        // (signature was deleted between settings-fetch and print,
        // network glitch, etc.), we silently fall back to the empty
        // placeholder — the printed kwitansi just shows the underline.
        const ownerImg = document.getElementById('ownerSigEmbed');
        const ownerUnderline = document.getElementById('ownerSigUnderline');
        // Data URL tanda tangan sudah diambil PARENT (panel admin) lewat
        // endpoint ber-token dan dioper ke window ini. Jendela cetak tidak
        // pernah mengakses endpoint publik lagi.
        const ownerDataUrl = window.__ownerSigDataUrl || '';
        function finalize() { window.print(); }
        if (ownerDataUrl && ownerImg) {
          ownerImg.src = ownerDataUrl;
          ownerImg.style.display = 'block';
          if (ownerUnderline) ownerUnderline.style.marginTop = '6px';
          // Tunggu gambar benar-benar ter-load sebelum snapshot print.
          if (ownerImg.complete && ownerImg.naturalWidth > 0) finalize();
          else {
            ownerImg.onload = () => finalize();
            ownerImg.onerror = () => {
              ownerImg.style.display = 'none';
              if (ownerUnderline) ownerUnderline.style.marginTop = '50px';
              finalize();
            };
            setTimeout(finalize, 400);
          }
        } else {
          if (ownerImg) ownerImg.style.display = 'none';
          if (ownerUnderline) ownerUnderline.style.marginTop = '50px';
          finalize();
        }
      }
      // Expose to window so the inline onclick="embedSigAndPrint()" on
      // the printBtn (rendered before the script runs, but in the
      // same window) can resolve the function by name.
      window.embedSigAndPrint = embedSigAndPrint;
    })();
    <\/script>
    </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html); w.document.close();
  // Oper data URL tanda tangan (kalau ada) ke jendela cetak. Parent sudah
  // mengambilnya lewat /api/admin/settings/owner-signature dengan token
  // admin, jadi halaman cetak tidak butuh akses endpoint apa pun.
  try {
    w.__hasOwnerSignature = !!ownerSigDataUrl;
    w.__ownerSigDataUrl = ownerSigDataUrl || '';
  } catch (e) {}

  // The new tab now owns its own canvas + listeners. Nothing for the
  // parent window to do — focus the new tab so the admin lands on
  // the print preview immediately.
  setTimeout(() => { try { w.focus(); } catch {} }, 50);
}

// ---------- RECAP ----------
async function renderRecap() {
  const c = document.getElementById('pageContent');
  const m = localMonthStr();
  c.innerHTML = `
    <div class="admin-header">
      <h1>📈 Rekap Bulanan</h1>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <label style="font-size:0.85rem;color:var(--text-soft);font-weight:600;">📅 Bulan:</label>
        <input type="month" id="recapMonth" value="${m}" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);">
        <label style="font-size:0.85rem;color:var(--text-soft);font-weight:600;margin-left:6px;">📊 Range:</label>
        <select id="recapMonths" onchange="loadRecap()" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-weight:600;">
          <option value="1">1 Bulan</option>
          <option value="3">3 Bulan</option>
          <option value="6">6 Bulan</option>
          <option value="12">1 Tahun (12 Bulan)</option>
        </select>
        <button onclick="loadRecap()" class="btn-sm btn-pay">🔄 Muat</button>
        <button onclick="openKwitansiModal()" class="btn-sm btn-approve">🧾 Buat Kwitansi Manual</button>
        <button onclick="exportRecapXLSX()" class="btn-sm btn-approve" title="Download laporan keuangan Excel">📊 Excel</button>
        <button onclick="exportRecapCSV()" class="btn-sm btn-pay">📥 CSV</button>
        <button onclick="exportRecapPDF()" class="btn-sm btn-view" title="Cetak laporan keuangan sebagai PDF">🖨️ PDF</button>
        <button onclick="openLaporanKeuangan()" class="btn-sm" style="background:#7c3aed;color:white;border:none;" title="Buka laporan keuangan printable">📑 Laporan</button>
      </div>
    </div>
    <div id="recapContent">Loading...</div>
  `;
  loadRecap();
}

let RECAP_DATA = null;
let RECAP_RECEIPTS = [];
async function loadRecap() {
  const _token461 = renderToken('recap');
  const month = document.getElementById('recapMonth').value;
  const months = document.getElementById('recapMonths')?.value || '1';
  try {
    RECAP_DATA = await api('/api/admin/recap?month=' + month + '&months=' + months);
  // Render yang lebih baru sudah dimulai — jangan menimpa hasilnya.
  if (!isLatestRender('recap', _token461)) return;
    // For receipts table we only show the single-month receipts (the
    // receipts list is too long to mix across multi-month views).
    RECAP_RECEIPTS = await api('/api/admin/receipts?month=' + month);
    const el = document.getElementById('recapContent');
    const isRange = parseInt(months, 10) > 1;
    // Range label for the page header
    const rangeLabel = isRange
      ? `${RECAP_DATA.monthList[RECAP_DATA.monthList.length - 1]} s/d ${month} (${months} bulan)`
      : month;

    // Build byMonth breakdown table (only for range view)
    const byMonthHtml = (isRange && Array.isArray(RECAP_DATA.byMonth))
      ? `<div style="margin:18px 0 6px;background:var(--card);border-radius:12px;padding:16px;border:1px solid var(--border);">
          <h3 style="margin:0 0 12px;font-size:1.05rem;">📊 Ringkasan Per Bulan (${months} bulan)</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
            ${RECAP_DATA.byMonth.map((m) => {
              const isPeak = m.totalOmzet === Math.max(...RECAP_DATA.byMonth.map((x) => x.totalOmzet));
              return `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:${isPeak ? '#d9efe1' : 'var(--pink-50)'};border:1px solid ${isPeak ? '#1e8957' : 'var(--pink-100)'};border-radius:999px;font-size:0.85rem;font-weight:600;">
                📅 <strong>${m.month}</strong> · ${m.totalReservasi} res · ${fmtRp(m.totalOmzet)}
                ${isPeak ? ' 🏆' : ''}
              </span>`;
            }).join('')}
          </div>
          <div class="table-scroll"><table class="data-table"><thead><tr>
            <th>Bulan</th><th>Reservasi</th><th>Kwitansi</th><th>Omzet (Lunas)</th><th>Rata-rata/Reservasi</th>
          </tr></thead><tbody>
            ${RECAP_DATA.byMonth.map((m) => `<tr>
              <td><strong>${m.month}</strong></td>
              <td>${m.totalReservasi}</td>
              <td>${m.totalKwitansi}</td>
              <td><strong>${fmtRp(m.totalOmzet)}</strong></td>
              <td>${m.totalReservasi ? fmtRp(Math.round(m.totalOmzet / m.totalReservasi)) : '—'}</td>
            </tr>`).join('')}
            <tr style="background:var(--primary);color:white;font-weight:700;">
              <td>TOTAL</td>
              <td>${RECAP_DATA.totalReservasi}</td>
              <td>${RECAP_RECEIPTS.length || RECAP_DATA.byMonth.reduce((s, m) => s + m.totalKwitansi, 0)}</td>
              <td>${fmtRp(RECAP_DATA.totalOmzet)}</td>
              <td>${RECAP_DATA.totalReservasi ? fmtRp(Math.round(RECAP_DATA.totalOmzet / RECAP_DATA.totalReservasi)) : '—'}</td>
            </tr>
          </tbody></table></div>
        </div>`
      : '';

    el.innerHTML = `
      <div style="margin-bottom:14px;padding:10px 14px;background:var(--bg);border-radius:10px;font-size:0.92rem;color:var(--text-soft);border:1px solid var(--border);">
        📅 <strong>${rangeLabel}</strong>${isRange ? ` &nbsp;·&nbsp; <button onclick="openLaporanKeuangan()" style="background:none;border:none;color:var(--primary);text-decoration:underline;font-weight:700;cursor:pointer;">📑 Cetak Laporan Keuangan</button>` : ''}
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Total Reservasi</div><div class="value">${RECAP_DATA.totalReservasi}</div></div>
        <div class="stat-card pink"><div class="label">Total Omzet</div><div class="value">${fmtRp(RECAP_DATA.totalOmzet)}</div></div>
        <div class="stat-card peach"><div class="label">Total Kwitansi</div><div class="value">${RECAP_RECEIPTS.length || RECAP_DATA.byMonth.reduce((s, m) => s + m.totalKwitansi, 0)}</div></div>
      </div>
      ${byMonthHtml}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:8px;" id="recapCols">
        <div>
          <h3 style="margin:20px 0 12px;">🧾 Kwitansi ${isRange ? 'Bulan ' + month : ''}</h3>
          ${RECAP_RECEIPTS.length ? renderReceiptTable(RECAP_RECEIPTS) : '<p style="color:var(--text-soft);text-align:center;padding:20px;background:var(--card);border-radius:12px;">Belum ada kwitansi bulan ini.</p>'}
        </div>
        <div>
          <h3 style="margin:20px 0 12px;">📅 Detail Reservasi ${isRange ? '(' + RECAP_DATA.rows.length + ' di ' + months + ' bulan)' : 'Bulan ' + month}</h3>
          ${RECAP_DATA.rows.length ? `
            <div class="data-table-wrap">
              <div class="table-scroll"><table class="data-table"><thead><tr>
                <th>Tgl</th><th>Pasien</th><th>Layanan</th><th>Sesi</th><th>Total</th><th>Status</th><th>Bayar</th>
              </tr></thead><tbody>
              ${RECAP_DATA.rows.map(r => `<tr>
                <td>${(r.slots||[]).map(s=>`${fmtDate(s.date)} <small>${s.time}</small>`).join('<br>')}</td>
                <td>${esc(r.patient_name)}</td>
                <td><div class="items-list">${(r.items||[]).map(it=>`<div>• ${esc(it.name)} ×${it.qty}</div>`).join('')}</div></td>
                <td>${(r.slots||[]).length}</td>
                <td><strong>${fmtRp(r.total)}</strong></td>
                <td><span class="badge badge-${r.status}">${r.status}</span></td>
                <td><span class="badge badge-${r.payment_status}">${r.payment_status}</span></td>
              </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-soft);padding:20px;">Tidak ada data.</td></tr>'}
              </tbody></table></div>
            </div>
            <div class="card-list">
              ${RECAP_DATA.rows.map(r => `<div class="card-list-item">
                <div class="cli-head">${esc(r.patient_name || '-')}</div>
                <div class="cli-meta">📅 ${(r.slots||[]).map(s=>`${fmtDate(s.date)} ${s.time}`).join(', ')}</div>
                <div class="cli-row"><span class="cli-label">Layanan</span><span class="cli-value" style="text-align:left;font-weight:500;">${(r.items||[]).map(it=>`• ${esc(it.name)} ×${it.qty}`).join('<br>')}</span></div>
                <div class="cli-row"><span class="cli-label">Sesi</span><span class="cli-value">${(r.slots||[]).length}</span></div>
                <div class="cli-row"><span class="cli-label">Total</span><span class="cli-value">${fmtRp(r.total)}</span></div>
                <div class="cli-row"><span class="cli-label">Status</span><span class="cli-value"><span class="badge badge-${r.status}">${r.status}</span> <span class="badge badge-${r.payment_status}">${r.payment_status}</span></span></div>
              </div>`).join('')}
            </div>
          ` : '<p style="color:var(--text-soft);text-align:center;padding:20px;background:var(--card);border-radius:12px;">Belum ada reservasi bulan ini.</p>'}
        </div>
      </div>
      <style>@media(max-width:920px),(hover:none) and (pointer:coarse) and (max-width:1024px){#recapCols{grid-template-columns:1fr !important;}}</style>
    `;
  } catch (e) { document.getElementById('recapContent').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

function renderReceiptTable(rows) {
  // Enable responsive card-list view for phones. Both the table and
  // the card list are rendered; CSS hides the table on phones so
  // every action button stays tappable.
  document.body.setAttribute('data-table-mode', 'cards');
  const tableHtml = `<div class="data-table-wrap"><div class="table-scroll"><table class="data-table"><thead><tr>
    <th>Invoice</th><th>Tgl Layanan</th><th>Pasien</th><th>Total</th><th>Aksi</th>
  </tr></thead><tbody>
  ${rows.map(r => `<tr>
    <td><strong>${esc(r.invoice_no || '-')}</strong><br><small style="color:var(--text-soft)">${fmtDateTime(r.created_at)}</small></td>
    <td>${r.service_date ? fmtDate(r.service_date) : '<span style="color:var(--text-soft)">—</span>'}</td>
    <td>${esc(r.patient_name || '-')}<br><small style="color:var(--text-soft)">${esc(r.whatsapp || '')}</small></td>
    <td><strong>${fmtRp(r.total)}</strong></td>
    <td style="white-space:nowrap;">
      <button class="btn-sm btn-view" onclick="openKwitansiDetailModal(${r.id})" title="Lihat detail">👁️</button>
      <button class="btn-sm" onclick='quickSavePDF(${r.id})' title="Download PDF langsung (pakai ukuran kertas tersimpan)" style="padding:6px 10px;background:#7c3aed;color:white;border:none;font-weight:700;">💾</button>
      <button class="btn-sm btn-view" onclick="shareOrPrintKwitansi(${r.id})" title="Kirim/Cetak/Save PDF (buka menu)" aria-label="Kirim atau cetak kwitansi">📤</button>
      <button class="btn-sm btn-del" onclick="deleteReceipt(${r.id}, '${escJs(r.invoice_no)}')" title="Hapus">🗑️</button>
    </td>
  </tr>`).join('')}
  </tbody></table></div></div>`;
  const cardHtml = `<div class="card-list" aria-label="Daftar kwitansi (tampilan kartu untuk HP)">
    ${rows.map(r => `<div class="card-list-item">
      <div class="cli-head">${esc(r.invoice_no || '')}</div>
      <div class="cli-meta">📅 ${fmtDateTime(r.created_at)}</div>
      <div class="cli-row"><span class="cli-label">Tgl Layanan</span><span class="cli-value">${r.service_date ? fmtDate(r.service_date) : '—'}</span></div>
      <div class="cli-row"><span class="cli-label">Pasien</span><span class="cli-value">${esc(r.patient_name || '-')}<br><small style="font-weight:400;color:var(--text-soft)">${esc(r.whatsapp || '')}</small></span></div>
      <div class="cli-row"><span class="cli-label">Total</span><span class="cli-value">${fmtRp(r.total)}</span></div>
      <div class="cli-actions">
        <button class="btn-sm btn-view" onclick="openKwitansiDetailModal(${r.id})">👁️ Lihat</button>
        <button class="btn-sm" onclick='quickSavePDF(${r.id})' title="Download PDF langsung" style="background:#7c3aed;color:white;border:none;font-weight:700;">💾 PDF</button>
        <button class="btn-sm btn-view" onclick="shareOrPrintKwitansi(${r.id})" title="Kirim/Cetak/Save PDF (buka menu)">📤 Menu</button>
        <button class="btn-sm btn-del" onclick="deleteReceipt(${r.id}, '${escJs(r.invoice_no)}')">🗑️ Hapus</button>
      </div>
    </div>`).join('')}
  </div>`;
  return tableHtml + cardHtml;
}

// Buka modal 'Buat Kwitansi Manual' dari Rekap Bulanan — tidak perlu pindah
// ke menu Kwitansi di sidebar. Form identik dengan yang ada di /receipts.
function openKwitansiModal() {
  receiptItems = [];
  const month = document.getElementById('recapMonth').value + '-01';
  openModal(`
    <h3>🧾 Buat Kwitansi Manual</h3>
    <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 14px;">Kwitansi ini akan otomatis muncul di Rekap <strong>${esc(document.getElementById('recapMonth').value)}</strong>.</p>
    <div class="form-wrap" style="padding:0;">
      <div class="form-group"><label>Nama Pasien</label><input type="text" id="mkw_name"></div>
      <div class="form-row">
        <div class="form-group"><label>HP</label><input type="tel" id="mkw_hp"></div>
        <div class="form-group"><label>Tanggal Layanan</label><input type="date" id="mkw_date" value="${month}"></div>
      </div>
      <div class="form-group"><label>⏰ Waktu / Jam Layanan (multi-waktu)</label>
        <div id="mkw_times" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;"></div>
        <button type="button" onclick="addMkwTimePrompt()" class="btn-sm btn-pay" style="margin-top:6px;">+ Tambah Waktu</button>
        <small style="color:var(--text-soft);display:block;margin-top:4px;">Misal: satu pasien dengan beberapa sesi (09:00, 14:00, 19:00).</small>
      </div>
      <div class="form-group"><label>Alamat</label><input type="text" id="mkw_addr"></div>
      <hr style="margin:14px 0;border:none;border-top:1px dashed var(--border);">
      <h4 style="margin-bottom:8px;">Layanan</h4>
      <div id="mkw_items"></div>
      <button type="button" onclick="mkwAddRow()" class="btn-sm btn-pay" style="margin-top:8px;">+ Tambah Layanan</button>
      <div class="form-row" style="margin-top:14px;">
        <div class="form-group"><label>Fee Transportasi</label><input type="number" id="mkw_transport" value="0"></div>
        <div class="form-group"><label>Diskon</label><input type="number" id="mkw_discount" value="0"></div>
      </div>
      <div class="summary-card" id="mkw_summary" style="margin-top:14px;">
        <div class="row"><span>Subtotal:</span><span id="mkw_sub">Rp 0</span></div>
        <div class="row total"><span>Total:</span><span id="mkw_total">Rp 0</span></div>
      </div>
      <div id="mkw_err" style="display:none;margin-top:10px;padding:10px;background:#fde0e4;color:#c43050;border-radius:8px;font-size:0.88rem;"></div>
      <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn-sm btn-view" onclick="closeModal()">Batal</button>
        <button class="btn btn-primary" onclick="mkwSave()">💾 Simpan & Cetak</button>
      </div>
    </div>
  `);
  mkwAddRow();
  initMkwTimes();
}

function mkwAddRow(item) {
  const i = receiptItems.length;
  receiptItems.push(item || { name: '', price: 0, qty: 1 });
  const wrap = document.getElementById('mkw_items');
  if (!wrap) return;
  const div = document.createElement('div');
  div.style.cssText = 'display:grid;grid-template-columns:1fr 90px 70px 32px;gap:8px;margin-bottom:8px;align-items:center;';
  div.innerHTML = `
    <select onchange="mkwOnServiceChange(${i}, this)">
      <option value="">— pilih layanan —</option>
      ${SERVICES.map(c => `<optgroup label="${esc(c.cat)}">${c.items.map(it => `<option value="${esc(it.name)}" data-price="${it.price}" ${item && item.name === it.name ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}</optgroup>`).join('')}
    </select>
    <div class="kw-price-tag" style="padding:8px 10px;background:var(--pink-50);border:1px solid var(--pink-100);border-radius:8px;font-weight:700;color:var(--pink-700);font-size:0.85rem;text-align:right;white-space:nowrap;">${fmtRp(item ? item.price : 0)}</div>
    <input type="number" placeholder="qty" value="${item ? item.qty : 1}" min="1" oninput="receiptItems[${i}].qty=parseInt(this.value)||1;mkwUpdateTotal();">
    <button type="button" onclick="receiptItems.splice(${i},1);mkwRebuild();" class="btn-sm btn-del" style="padding:6px;" title="Hapus baris">×</button>
  `;
  div.querySelectorAll('select, input').forEach(el => {
    el.style.cssText = (el.style.cssText || '') + ';padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;font-size:0.88rem;';
  });
  wrap.appendChild(div);
  ['#mkw_transport', '#mkw_discount'].forEach(s => { const el = document.querySelector(s); if (el) el.oninput = mkwUpdateTotal; });
  mkwUpdateTotal();
}

function mkwRebuild() {
  const wrap = document.getElementById('mkw_items');
  if (!wrap) return;
  wrap.innerHTML = '';
  const snap = receiptItems.slice();
  receiptItems = [];
  snap.forEach(it => mkwAddRow(it));
}

function mkwOnServiceChange(idx, sel) {
  const opt = sel.options[sel.selectedIndex];
  const price = parseInt(opt.dataset.price) || 0;
  receiptItems[idx].name = sel.value;
  receiptItems[idx].price = price;
  mkwRebuild();
}

function mkwUpdateTotal() {
  const sub = receiptItems.reduce((s, it) => s + (it.price * it.qty), 0);
  const trans = parseInt(document.getElementById('mkw_transport')?.value) || 0;
  const disc = parseInt(document.getElementById('mkw_discount')?.value) || 0;
  const total = sub + trans - disc;
  if (document.getElementById('mkw_sub')) document.getElementById('mkw_sub').textContent = fmtRp(sub);
  if (document.getElementById('mkw_total')) document.getElementById('mkw_total').textContent = fmtRp(total);
}

async function mkwSave() {
  const items = receiptItems.filter(it => it.name && it.price > 0);
  const errEl = document.getElementById('mkw_err');
  errEl.style.display = 'none';
  if (!items.length) {
    errEl.textContent = '⚠️ Tambahkan minimal 1 layanan (pilih dari dropdown).';
    errEl.style.display = 'block';
    return;
  }
  const slots = getMkwSlots();
  if (!slots.length) {
    errEl.textContent = '⚠️ Tambahkan minimal 1 jadwal.';
    errEl.style.display = 'block';
    return;
  }
  const formDate = document.getElementById('mkw_date').value;
  const allSameDate = slots.every((s) => s.date === formDate);
  const body = {
    patient_name: document.getElementById('mkw_name').value,
    whatsapp: document.getElementById('mkw_hp').value,
    address: document.getElementById('mkw_addr').value,
    service_date: allSameDate ? formDate : slots[0].date,
    service_slots: slots,
    items,
    transport_fee: parseInt(document.getElementById('mkw_transport').value) || 0,
    discount: parseInt(document.getElementById('mkw_discount').value) || 0
  };
  try {
    const res = await api('/api/admin/receipts', { method: 'POST', body: JSON.stringify(body) });
    printReceipt({ ...body, invoice_no: res.invoice_no, subtotal: res.subtotal, total: res.total, created_at: new Date().toISOString() });
    closeModal();
    loadRecap();
  } catch (e) {
    errEl.textContent = 'Gagal: ' + e.message;
    errEl.style.display = 'block';
  }
}

// Modal detail kwitansi — dipanggil dari tabel kwitansi di Rekap Bulanan.
async function openKwitansiDetailModal(id) {
  const r = (RECAP_RECEIPTS && RECAP_RECEIPTS.find(x => x.id === id))
    || (window._receiptsCache && window._receiptsCache.find(x => x.id === id));
  if (!r) return alert('Kwitansi tidak ditemukan di cache. Coba muat ulang halaman.');
  const items = Array.isArray(r.items) ? r.items : [];
  const times = (Array.isArray(r.service_times) && r.service_times.length)
    ? r.service_times
    : (r.service_time ? [r.service_time] : []);
  const sessionsLabel = times.length > 1 ? ` <span style="color:var(--primary);font-weight:700;">(${times.length} sesi)</span>` : '';
  const timesHtml = times.length
    ? times.map((t) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:4px 10px;background:var(--pink-50);border:1px solid var(--pink-100);border-radius:999px;font-size:0.86rem;font-weight:700;color:var(--primary);">⏰ ${esc(t)} WIB</span>`).join('')
    : '<span style="color:var(--text-soft);">—</span>';
  openModal(`
    <h3>🧾 Detail Kwitansi ${esc(r.invoice_no || '')}</h3>
    <div style="margin-top:14px;display:grid;gap:8px;font-size:0.92rem;">
      <div><strong>Tanggal Buat:</strong> ${fmtDateTime(r.created_at)}</div>
      <div><strong>Tanggal Layanan:</strong> ${r.service_date ? fmtDate(r.service_date) : '<span style="color:var(--text-soft)">—</span>'}</div>
      <div><strong>Waktu Layanan${sessionsLabel}:</strong>
        <div style="margin-top:4px;line-height:1.8;">${timesHtml}</div>
      </div>
      <div><strong>Pasien:</strong> ${esc(r.patient_name || '-')}</div>
      <div><strong>WhatsApp:</strong> ${esc(r.whatsapp || '-')}</div>
      <div><strong>Alamat:</strong> ${esc(r.address || '-')}</div>
      <div><strong>Layanan:</strong>
        <div style="margin-top:4px;padding:8px;background:var(--pink-50);border-radius:8px;">
          ${items.length ? items.map(it => `<div>• ${esc(it.name)} <small>×${it.qty || 1}</small> — ${fmtRp((it.price || 0) * (it.qty || 1))}</div>`).join('') : '<em style="color:var(--text-soft)">Tidak ada item layanan.</em>'}
        </div>
      </div>
      <div><strong>Subtotal:</strong> ${fmtRp(r.subtotal || 0)}</div>
      ${r.transport_fee ? `<div><strong>Transportasi:</strong> ${fmtRp(r.transport_fee)}</div>` : ''}
      ${r.discount ? `<div><strong>Diskon:</strong> -${fmtRp(r.discount)}</div>` : ''}
      <div style="margin-top:8px;padding:10px;background:var(--primary);color:white;border-radius:10px;text-align:center;font-size:1.05rem;font-weight:800;">
        TOTAL: ${fmtRp(r.total)}
      </div>
    </div>
    <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
      <button class="btn-sm btn-view" onclick="printReceiptById(${r.id})">🖨️ Cetak PDF</button>
      <button class="btn-sm btn-del" onclick="if(confirm('Hapus kwitansi ${escJs(r.invoice_no)}?')){closeModal();deleteReceipt(${r.id},'${escJs(r.invoice_no)}').then(()=>loadRecap());}">🗑️ Hapus</button>
      <button class="btn-sm btn-view" onclick="closeModal()">Tutup</button>
    </div>
  `);
}

// ===== IMPORT KWITANSI DARI JSON =====
// Modal ini menerima:
//   - File .json hasil export dari sistem ini / sistem lain
//   - File .json hasil copy-paste dari spreadsheet (array of objects)
//   - JSON langsung yang di-paste ke textarea
// Server akan otomatis mengenali format dan melewati baris duplikat.
function openImportKwitansiModal() {
  openModal(`
    <h3>📥 Import Kwitansi</h3>
    <p style="color:var(--text-soft);font-size:0.88rem;margin:6px 0 14px;line-height:1.5;">
      Upload file <strong>.json</strong> atau paste JSON langsung. Format yang didukung:
      <br>• Array of objects: <code>[{patient_name,service_date,items:[{name,price,qty}]}]</code>
      <br>• Backup format: <code>{receipts:[...]}</code>
      <br>• Spreadsheet headers (ID/EN): nama/pasien, tanggal/service_date, harga/price, dll.
      <br>• <strong>Multi-waktu & multi-tanggal</strong>: pakai <code>service_slots:[{date,time}]</code> atau CSV <code>"waktu":"09:00,14:00,19:00"</code>. Total dihitung otomatis (subtotal × jumlah slot).
    </p>
    <div style="display:grid;gap:12px;">
      <div>
        <label style="font-weight:600;">📁 Upload File JSON</label>
        <input type="file" id="impKwFile" accept="application/json,.json" style="margin-top:6px;width:100%;">
      </div>
      <div>
        <label style="font-weight:600;">📋 atau Paste JSON</label>
        <textarea id="impKwText" rows="6" placeholder='[{"patient_name":"Bunda Rina","service_date":"2026-09-05","items":[{"name":"Massage Ibu Hamil","price":80000,"qty":1}]}]' style="width:100%;font-family:monospace;font-size:0.85rem;"></textarea>
      </div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:0.9rem;">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="impKwSkipDups" checked> Lewati duplikat (invoice_no / pasien+tanggal sama)
        </label>
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="impKwSyncRes" checked> 🔗 Auto-sinkron ke Reservasi (supaya masuk Rekap Bulanan)
        </label>
        <a href="javascript:void(0)" onclick="downloadKwitansiTemplate()" style="color:var(--primary);text-decoration:underline;font-size:0.85rem;">📄 Download Template</a>
      </div>
    </div>
    <div id="impKwResult" style="margin-top:12px;"></div>
    <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
      <button class="btn-sm btn-view" onclick="closeModal()">Tutup</button>
      <button onclick="doImportKwitansi()" class="btn btn-primary">📥 Import Sekarang</button>
    </div>
  `);
}

async function doImportKwitansi() {
  const resultEl = document.getElementById('impKwResult');
  const fileEl = document.getElementById('impKwFile');
  const textEl = document.getElementById('impKwText');
  const skipDups = document.getElementById('impKwSkipDups').checked;
  const syncRes = document.getElementById('impKwSyncRes').checked;

  let payload;
  if (fileEl.files && fileEl.files[0]) {
    try { payload = await fileEl.files[0].text(); }
    catch (e) { return resultEl.innerHTML = `<div class="alert alert-error">Gagal baca file: ${esc(e.message)}</div>`; }
  } else if (textEl.value.trim()) {
    payload = textEl.value.trim();
  } else {
    return resultEl.innerHTML = `<div class="alert alert-error">Pilih file atau paste JSON terlebih dahulu.</div>`;
  }

  let parsed;
  try { parsed = JSON.parse(payload); }
  catch (e) { return resultEl.innerHTML = `<div class="alert alert-error">JSON tidak valid: ${esc(e.message)}</div>`; }

  resultEl.innerHTML = `<div style="padding:10px;background:var(--pink-50);border-radius:8px;">⏳ Mengimport...</div>`;
  try {
    const params = new URLSearchParams();
    if (!skipDups) params.set('skip', '0');
    if (!syncRes) params.set('sync_reservations', '0');
    const qs = params.toString();
    const res = await fetch(apiUrl('/api/admin/receipts/import' + (qs ? '?' + qs : '')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(parsed)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    let html = `<div style="padding:12px;border-radius:8px;background:${data.imported ? '#d9efe1' : '#fff3d6'};">
      <strong>✅ Import selesai</strong><br>
      Berhasil: <strong>${data.imported}</strong> kwitansi · Lewati (duplikat): <strong>${data.skipped}</strong> · Gagal: <strong>${data.failed}</strong>
      ${syncRes && data.imported ? `<br><small style="color:#1e8957;">🔗 ${data.imported} kwitansi otomatis dibuatkan reservasi mirror (status=approved, payment_status=lunas) supaya muncul di Rekap Bulanan.</small>` : ''}
    </div>`;
    if (data.failed_items && data.failed_items.length) {
      html += `<details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--text-soft);">Lihat ${data.failed_items.length} baris gagal</summary>
        <pre style="background:#fde0e4;padding:8px;border-radius:6px;margin-top:6px;max-height:200px;overflow:auto;font-size:0.78rem;">${esc(JSON.stringify(data.failed_items, null, 2))}</pre>
      </details>`;
    }
    resultEl.innerHTML = html;
    loadReceipts();
    loadKwitansiStats();
    // Also refresh reservations view if the user is currently looking
    // at it, so the newly created mirrors show up immediately.
    if (syncRes && data.imported && CURRENT_PAGE === 'reservations') {
      try { await loadReservations(); } catch {}
    }
  } catch (e) {
    resultEl.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function downloadKwitansiTemplate() {
  const sample = [
    {
      patient_name: "Bunda Rina",
      whatsapp: "081234567890",
      address: "Cilacap",
      service_date: "2026-09-05",
      service_slots: [{ date: "2026-09-05", time: "09:00" }],
      items: [
        { name: "Massage Ibu Hamil", price: 80000, qty: 1 }
      ],
      transport_fee: 0,
      discount: 0
    },
    {
      patient_name: "Bunda Dewi",
      whatsapp: "081234567891",
      address: "Nusawungu",
      service_date: "2026-09-10",
      // Multi-waktu + multi-tanggal: total dihitung otomatis
      // (subtotal × jumlah slot). Bisa juga service_times array
      // untuk 1 tanggal dengan beberapa jam.
      service_slots: [
        { date: "2026-09-12", time: "09:00" },
        { date: "2026-09-14", time: "10:00" },
        { date: "2026-09-15", time: "08:00" }
      ],
      items: [
        { name: "Pijat Laktasi", price: 80000, qty: 2 },
        { name: "Baby Sleepwell", price: 50000, qty: 1 }
      ],
      transport_fee: 15000,
      discount: 0
    }
  ];
  const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'template-import-kwitansi.json';
  a.click();
}

// ===== IMPORT KWITANSI DARI PDF =====
// Upload one or more kwitansi PDFs (the ones printed from this admin
// panel). Server extracts text and parses invoice/patient/items/totals.
// User reviews parsed data in a table, can edit fields, then submits to
// the existing /api/admin/receipts/import for insertion.
let _impPdfParsed = []; // last batch of parsed receipts (after upload, before confirm)
function openImportPdfKwitansiModal() {
  _impPdfParsed = [];
  openModal(`
    <h3>📄 Restore Kwitansi dari PDF</h3>
    <p style="color:var(--text-soft);font-size:0.88rem;margin:6px 0 14px;line-height:1.5;">
      Upload satu atau banyak file PDF kwitansi Adzkiya (PDF yang dicetak dari menu <strong>🖨️ Cetak PDF</strong>).
      Server akan otomatis mengekstrak data dari setiap PDF. Anda bisa cek & edit hasilnya sebelum import.
      <br><small style="color:var(--text-soft);">⚠️ PDF hasil scan/foto tidak didukung (butuh OCR). Hanya PDF yang di-generate oleh sistem ini.</small>
    </p>
    <div id="impPdfStep1">
      <label style="font-weight:600;">📁 Pilih file PDF (boleh lebih dari satu)</label>
      <input type="file" id="impPdfFiles" accept="application/pdf,.pdf" multiple style="margin-top:6px;width:100%;">
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;font-size:0.88rem;flex-wrap:wrap;">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="impPdfSkipDups" checked> Lewati duplikat
        </label>
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="impPdfSyncRes" checked> 🔗 Auto-sinkron ke Reservasi
        </label>
      </div>
      <div id="impPdfStatus" style="margin-top:10px;"></div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button class="btn-sm btn-view" onclick="closeModal()">Batal</button>
        <button onclick="impPdfUpload()" class="btn btn-primary">🔍 Ekstrak Data</button>
      </div>
    </div>
    <div id="impPdfStep2" style="display:none;">
      <div id="impPdfSummary" style="margin-bottom:12px;"></div>
      <div style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
        <table class="data-table" id="impPdfTable">
          <thead><tr>
            <th style="width:32px;">✓</th>
            <th>File</th>
            <th>Invoice</th>
            <th>Pasien</th>
            <th>Tanggal</th>
            <th>Item</th>
            <th>Total</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="impPdfFailed" style="margin-top:10px;"></div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;">
        <button class="btn-sm btn-view" onclick="document.getElementById('impPdfStep1').style.display='';document.getElementById('impPdfStep2').style.display='none';">⬅️ Upload Lagi</button>
        <div style="display:flex;gap:8px;">
          <button class="btn-sm btn-view" onclick="closeModal()">Batal</button>
          <button onclick="impPdfConfirmImport()" class="btn btn-primary">📥 Import ke Database</button>
        </div>
      </div>
    </div>
  `);
}

async function impPdfUpload() {
  const filesEl = document.getElementById('impPdfFiles');
  const statusEl = document.getElementById('impPdfStatus');
  const files = filesEl.files;
  if (!files || !files.length) return statusEl.innerHTML = `<div class="alert alert-error">Pilih minimal 1 file PDF.</div>`;

  statusEl.innerHTML = `<div style="padding:10px;background:var(--pink-50);border-radius:8px;">⏳ Mengekstrak ${files.length} file...</div>`;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);

  try {
    const res = await fetch(apiUrl('/api/admin/receipts/import-pdf'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    _impPdfParsed = (data.results || []).map((r, idx) => ({
      filename: r.filename,
      ok: r.ok,
      error: r.error || null,
      receipt: r.receipt || null,
      selected: r.ok,
    }));

    // Show step 2 with parsed table
    document.getElementById('impPdfStep1').style.display = 'none';
    document.getElementById('impPdfStep2').style.display = '';

    // Summary
    const ok = _impPdfParsed.filter((r) => r.ok);
    const fail = _impPdfParsed.filter((r) => !r.ok);
    document.getElementById('impPdfSummary').innerHTML = `
      <div style="padding:12px;border-radius:8px;background:${ok.length ? '#d9efe1' : '#fff3d6'};">
        <strong>${ok.length}</strong> kwitansi berhasil diekstrak${fail.length ? `, <strong style="color:#c43050;">${fail.length}</strong> gagal` : ''}.
      </div>
    `;

    // Table
    const tbody = document.querySelector('#impPdfTable tbody');
    tbody.innerHTML = _impPdfParsed.map((r, idx) => {
      if (!r.ok) {
        return `<tr style="background:#fde0e4;">
          <td colspan="7"><strong>❌ ${esc(r.filename)}</strong> — ${esc(r.error || 'gagal')}</td>
        </tr>`;
      }
      const rec = r.receipt;
      const itemsText = (rec.items || []).map((it) => `${esc(it.name)} ×${it.qty}`).join(', ');
      return `<tr data-idx="${idx}">
        <td><input type="checkbox" class="imp-pdf-chk" ${r.selected ? 'checked' : ''} onchange="_impPdfParsed[${idx}].selected=this.checked"></td>
        <td><small>${esc(r.filename)}</small></td>
        <td>${esc(rec.invoice_no || '—')}</td>
        <td>${esc(rec.patient_name || '—')}</td>
        <td>${esc(rec.service_date || '—')}</td>
        <td><small>${itemsText}</small></td>
        <td><strong>${fmtRp(rec.total)}</strong></td>
      </tr>`;
    }).join('');

    if (fail.length) {
      document.getElementById('impPdfFailed').innerHTML = `<details><summary style="cursor:pointer;color:var(--text-soft);">${fail.length} file gagal diekstrak</summary>
        <ul style="margin-top:6px;font-size:0.85rem;">${fail.map((f) => `<li><strong>${esc(f.filename)}</strong>: ${esc(f.error || 'unknown')}</li>`).join('')}</ul>
      </details>`;
    }
  } catch (e) {
    statusEl.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

async function impPdfConfirmImport() {
  const toImport = _impPdfParsed.filter((r) => r.ok && r.selected).map((r) => {
    // Strip _confidence fields (server doesn't need them)
    const { _confidence, ...rest } = r.receipt;
    return rest;
  });
  if (!toImport.length) return alert('Tidak ada kwitansi dipilih untuk di-import.');

  const skipDups = document.getElementById('impPdfSkipDups').checked;
  const syncRes = document.getElementById('impPdfSyncRes') ? document.getElementById('impPdfSyncRes').checked : true;
  try {
    const params = new URLSearchParams();
    if (!skipDups) params.set('skip', '0');
    if (!syncRes) params.set('sync_reservations', '0');
    const qs = params.toString();
    const res = await fetch(apiUrl('/api/admin/receipts/import' + (qs ? '?' + qs : '')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(toImport)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    let msg = 'Import selesai: ' + data.imported + ' kwitansi, ' + data.skipped + ' dilewati, ' + data.failed + ' gagal.';
    if (syncRes && data.imported) {
      msg += '\n\n' + data.imported + ' reservasi mirror otomatis dibuat (status=approved, payment_status=lunas) supaya muncul di Rekap Bulanan. Cek menu Reservasi.';
    }
    alert(msg);
    closeModal();
    loadReceipts();
    loadKwitansiStats();
    if (syncRes && data.imported && CURRENT_PAGE === 'reservations') {
      try { await loadReservations(); } catch {}
    }
  } catch (e) {
    alert('Gagal import: ' + e.message);
  }
}

// Refresh total kwitansi stat card on Rekap Bulanan (called after import)
async function loadKwitansiStats() {
  if (typeof RECAP_DATA !== 'undefined' && RECAP_DATA && RECAP_DATA.month) {
    try { await loadRecap(); } catch {}
  }
}

function getRecapMonthAndMonths() {
  const month = document.getElementById('recapMonth')?.value || localMonthStr();
  const months = document.getElementById('recapMonths')?.value || '1';
  return { month, months };
}

function exportRecapCSV() {
  if (!RECAP_DATA) return;
  const { month, months } = getRecapMonthAndMonths();
  const isRange = parseInt(months, 10) > 1;
  const rows = [];
  // Summary at the top so the CSV opens with quick totals.
  rows.push(['LAPORAN KEUANGAN', month]);
  rows.push(['Periode', isRange ? `${RECAP_DATA.monthList[RECAP_DATA.monthList.length - 1]} s/d ${month}` : month]);
  rows.push(['Tanggal Cetak', new Date().toLocaleString('id-ID')]);
  rows.push([]);
  rows.push(['Statistik', 'Nilai']);
  rows.push(['Total Reservasi', RECAP_DATA.totalReservasi]);
  rows.push(['Total Kwitansi', RECAP_DATA.totalKwitansi || 0]);
  rows.push(['Total Omzet (Lunas)', RECAP_DATA.totalOmzet]);
  rows.push(['Rata-rata / Reservasi', RECAP_DATA.totalReservasi ? Math.round(RECAP_DATA.totalOmzet / RECAP_DATA.totalReservasi) : 0]);
  rows.push([]);
  // Per-bulan breakdown when in range mode. Mirrors the byMonth card.
  if (isRange && Array.isArray(RECAP_DATA.byMonth)) {
    rows.push(['Ringkasan Per Bulan']);
    rows.push(['Bulan', 'Reservasi', 'Kwitansi', 'Omzet (Lunas)', 'Rata-rata/Reservasi']);
    for (const m of RECAP_DATA.byMonth) {
      rows.push([
        m.month,
        m.totalReservasi,
        m.totalKwitansi,
        m.totalOmzet,
        m.totalReservasi ? Math.round(m.totalOmzet / m.totalReservasi) : 0
      ]);
    }
    rows.push([]);
  }
  rows.push(['Detail Reservasi']);
  rows.push(['Tanggal','Jam','Pasien','WhatsApp','Layanan','Qty','Harga','Sesi','Total','Status','Pembayaran']);
  RECAP_DATA.rows.forEach(r => {
    (r.slots||[{date:'',time:''}]).forEach(s => {
      (r.items||[{name:'',price:0,qty:0}]).forEach(it => {
        rows.push([s.date, s.time, r.patient_name, r.whatsapp, it.name, it.qty, it.price, (r.slots||[]).length, r.total, r.status, r.payment_status]);
      });
    });
  });
  // RFC 4180 CSV: every cell quoted, embedded quotes doubled, line
  // endings CRLF so Excel & Google Sheets open it cleanly.
  const csv = rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return `"${s.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = isRange ? `rekap-${month}_${months}bulan.csv` : `rekap-${month}.csv`; a.click();
}

async function exportRecapXLSX() {
  if (!RECAP_DATA) return;
  try {
    const { month, months } = getRecapMonthAndMonths();
    const isRange = parseInt(months, 10) > 1;
    await downloadProtected(
      `/api/admin/recap.xlsx?month=${encodeURIComponent(month)}&months=${months}`,
      isRange ? `rekap-adzkiya-${month}_${months}bulan.xlsx` : `rekap-adzkiya-${month}.xlsx`
    );
  } catch (error) {
    alert('Export Excel gagal: ' + error.message);
  }
}

function exportRecapPDF() {
  if (!RECAP_DATA) return;
  // The "🖨️ PDF" button opens the same printable Laporan Keuangan view.
  openLaporanKeuangan();
}

// Dedicated "Laporan Keuangan" printable view — same data as the
// Rekap page but laid out for paper / PDF print. Includes range
// summary at top when in range mode, then per-month breakdown, then
// the full reservation detail table.
function openLaporanKeuangan() {
  if (!RECAP_DATA) return;
  const biz = SETTINGS || {};
  const logoSrc = biz.has_logo ? apiUrl('/api/logo') : null;
  const { month, months } = getRecapMonthAndMonths();
  const isRange = parseInt(months, 10) > 1;
  const rangeLabel = isRange
    ? `${RECAP_DATA.monthList[RECAP_DATA.monthList.length - 1]} s/d ${month} (${months} bulan)`
    : month;

  const summaryRows = isRange && Array.isArray(RECAP_DATA.byMonth)
    ? `<table class="data-table" style="margin:18px 0;">
        <thead><tr><th>Bulan</th><th>Reservasi</th><th>Kwitansi</th><th>Omzet (Lunas)</th><th>Rata-rata/Reservasi</th></tr></thead>
        <tbody>
          ${RECAP_DATA.byMonth.map((m) => `<tr>
            <td><strong>${m.month}</strong></td>
            <td>${m.totalReservasi}</td>
            <td>${m.totalKwitansi}</td>
            <td><strong>${fmtRp(m.totalOmzet)}</strong></td>
            <td>${m.totalReservasi ? fmtRp(Math.round(m.totalOmzet / m.totalReservasi)) : '—'}</td>
          </tr>`).join('')}
          <tr style="background:var(--primary);color:white;">
            <td><strong>TOTAL</strong></td>
            <td><strong>${RECAP_DATA.totalReservasi}</strong></td>
            <td><strong>${RECAP_DATA.byMonth.reduce((s, m) => s + m.totalKwitansi, 0)}</strong></td>
            <td><strong>${fmtRp(RECAP_DATA.totalOmzet)}</strong></td>
            <td><strong>${RECAP_DATA.totalReservasi ? fmtRp(Math.round(RECAP_DATA.totalOmzet / RECAP_DATA.totalReservasi)) : '—'}</strong></td>
          </tr>
        </tbody>
      </table>`
    : '';

  const detailRows = RECAP_DATA.rows.map((r) => `<tr>
    <td>${(r.slots||[]).map((s) => `${s.date} ${s.time}`).join('<br>')}</td>
    <td>${esc(r.patient_name)}</td>
    <td>${(r.items||[]).map((it) => `• ${esc(it.name)} ×${it.qty}`).join('<br>')}</td>
    <td>${(r.slots||[]).length}</td>
    <td>${fmtRp(r.total)}</td>
    <td>${r.status}</td>
    <td>${r.payment_status}</td>
  </tr>`).join('');

  const html = `<!doctype html><html><head><title>Laporan Keuangan — ${esc(rangeLabel)}</title>
    <link rel="stylesheet" href="${PAGE_STYLESHEET}">
    <style>body{padding:30px;background:white;font-family:'Plus Jakarta Sans',sans-serif;color:#2a1822;}@media print{.no-print{display:none;}}h1,h2,h3{color:#4a2533;}</style>
    </head><body>
    <div class="no-print" style="text-align:center;margin-bottom:16px;display:flex;gap:8px;justify-content:center;">
      <button onclick="window.print()" style="padding:11px 24px;background:#ee5a8a;color:white;border:none;border-radius:12px;font-weight:700;cursor:pointer;font-size:0.95rem;line-height:1.35;min-height:44px;">🖨️ Cetak / Save PDF</button>
      <button onclick="window.close()" style="padding:11px 24px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:12px;font-weight:700;cursor:pointer;font-size:0.95rem;line-height:1.35;min-height:44px;">✕ Tutup</button>
    </div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:14px;padding-bottom:14px;border-bottom:3px solid #ee5a8a;">
      ${logoSrc ? `<img src="${logoSrc}" style="width:70px;height:70px;object-fit:contain;">` : '<span style="font-size:2.6rem;">🌸</span>'}
      <div>
        <h1 style="color:#ee5a8a;margin:0;font-size:1.5rem;">${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</h1>
        <div style="color:#8b6878;font-size:0.92rem;">${esc(biz.tagline || 'Layanan Kesehatan Ibu & Anak Terpercaya')}</div>
        <div style="color:#8b6878;font-size:0.82rem;">${esc(biz.address || '')}</div>
      </div>
    </div>
    <h2 style="margin:6px 0 4px;">📑 Laporan Keuangan</h2>
    <p style="margin:0 0 14px;color:#8b6878;">Periode: <strong>${esc(rangeLabel)}</strong></p>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin:14px 0;">
      <div style="flex:1;min-width:160px;padding:14px;background:var(--pink-50);border-radius:10px;">
        <div style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;color:#8b6878;font-weight:700;">Total Reservasi</div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--primary);margin-top:4px;">${RECAP_DATA.totalReservasi}</div>
      </div>
      <div style="flex:1;min-width:160px;padding:14px;background:#d9efe1;border-radius:10px;">
        <div style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;color:#1e8957;font-weight:700;">Total Omzet (Lunas)</div>
        <div style="font-size:1.6rem;font-weight:800;color:#1e8957;margin-top:4px;">${fmtRp(RECAP_DATA.totalOmzet)}</div>
      </div>
      <div style="flex:1;min-width:160px;padding:14px;background:#fff3d6;border-radius:10px;">
        <div style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;color:#b07b15;font-weight:700;">Rata-rata / Reservasi</div>
        <div style="font-size:1.6rem;font-weight:800;color:#b07b15;margin-top:4px;">${RECAP_DATA.totalReservasi ? fmtRp(Math.round(RECAP_DATA.totalOmzet / RECAP_DATA.totalReservasi)) : '—'}</div>
      </div>
      <div style="flex:1;min-width:160px;padding:14px;background:var(--bg);border-radius:10px;border:1px solid var(--border);">
        <div style="font-size:0.78rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);font-weight:700;">Total Kwitansi</div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--text);margin-top:4px;">${RECAP_DATA.byMonth ? RECAP_DATA.byMonth.reduce((s, m) => s + m.totalKwitansi, 0) : RECAP_DATA.totalKwitansi || 0}</div>
      </div>
    </div>
    ${summaryRows ? `<h3 style="margin:18px 0 10px;">📊 Ringkasan Per Bulan</h3>${summaryRows}` : ''}
    <h3 style="margin:18px 0 10px;">📅 Detail Reservasi (${RECAP_DATA.rows.length} baris)</h3>
    <table class="data-table" style="font-size:0.82rem;">
      <thead><tr><th>Jadwal</th><th>Pasien</th><th>Layanan</th><th>Sesi</th><th>Total</th><th>Status</th><th>Bayar</th></tr></thead>
      <tbody>${detailRows}</tbody>
    </table>
    <p style="margin-top:18px;text-align:center;color:#8b6878;font-size:0.78rem;">
      Laporan dicetak pada ${new Date().toLocaleString('id-ID')} · ${esc(biz.business_name || 'Adzkiya Mom Baby Care')}
    </p>
    </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
}

// ---------- BROADCAST WHATSAPP ----------
// Admin pilih template + filter, server generate wa.me links untuk
// semua recipient. Admin klik link satu-satu atau pakai tombol
// "Buka semua sekaligus" untuk firefox/edge yang otomatis konfirmasi
// multiple tab opens.
//
// State:
//   - BROADCAST_LAST: hasil generate yang baru di-fetch
//   - BROADCAST_TEMPLATES: list templates from settings
let BROADCAST_LAST = null;
let BROADCAST_TEMPLATES = [];
let BROADCAST_HISTORY = [];

async function renderBroadcast() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <div>
        <h1>📢 Broadcast WhatsApp</h1>
        <p style="color:var(--text-soft);margin:4px 0 0;">Kirim pesan massal ke banyak pasien sekaligus via wa.me (gratis, tanpa API).</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="switchBroadcastTab('send')" id="bcTabSend" class="btn-sm btn-pay">📨 Kirim</button>
        <button onclick="switchBroadcastTab('templates')" id="bcTabTpl" class="btn-sm btn-view">📝 Template</button>
        <button onclick="switchBroadcastTab('history')" id="bcTabHistory" class="btn-sm btn-view">📜 History</button>
      </div>
    </div>
    <div id="broadcastBody">Loading...</div>
  `;
  // Pre-fetch templates + history once so tabs render fast.
  await Promise.all([
    api('/api/admin/whatsapp/templates').then((t) => { BROADCAST_TEMPLATES = t; }).catch(() => { BROADCAST_TEMPLATES = SETTINGS.whatsapp_templates || []; }),
    api('/api/admin/broadcasts').then((h) => { BROADCAST_HISTORY = h; }).catch(() => { BROADCAST_HISTORY = []; }),
  ]);
  switchBroadcastTab('send');
}

function switchBroadcastTab(tab) {
  ['send', 'templates', 'history'].forEach((t) => {
    const el = document.getElementById('bcTab' + (t === 'send' ? 'Send' : t === 'templates' ? 'Tpl' : 'History'));
    if (!el) return;
    el.className = t === tab ? (t === 'send' ? 'btn-sm btn-pay' : 'btn-sm btn-pay') : 'btn-sm btn-view';
  });
  if (tab === 'send') renderBroadcastSend();
  else if (tab === 'templates') renderBroadcastTemplates();
  else renderBroadcastHistory();
}

function renderBroadcastSend() {
  const body = document.getElementById('broadcastBody');
  if (!body) return;
  const tpls = BROADCAST_TEMPLATES.length ? BROADCAST_TEMPLATES : (SETTINGS.whatsapp_templates || []);
  body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;" id="bcSendGrid">
      <div class="setting-card">
        <h3>📨 Kirim Broadcast</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:14px;">Pilih template, tentukan filter recipient, lalu klik <strong>"Preview Recipient"</strong>.</p>
        <div class="form-group">
          <label>Nama Broadcast (opsional, untuk arsip)</label>
          <input type="text" id="bcName" placeholder="mis. Reminder H-1 untuk booking minggu ini">
        </div>
        <div class="form-group">
          <label>Pakai Template</label>
          <select id="bcTemplate" onchange="updateBcBodyPreview()" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
            <option value="">— Custom (tulis sendiri) —</option>
            ${tpls.map((t) => `<option value="${esc(t.id)}" data-body="${esc(t.body)}" data-name="${esc(t.name)}">${esc(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Isi Pesan (placeholder: <code>{{nama}}, {{tanggal}}, {{jam}}, {{layanan}}, {{total}}, {{invoice_no}}</code>)</label>
          <textarea id="bcBody" rows="6" placeholder="Tulis pesan di sini. Pakai {{nama}} untuk ganti dengan nama pasien otomatis." style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;resize:vertical;"></textarea>
          <small style="color:var(--text-soft);font-size:0.78rem;margin-top:4px;display:block;">💡 Placeholder diganti per recipient. Contoh: "Halo {{nama}}, ini pengingat untuk {{tanggal}} jam {{jam}}."</small>
        </div>
        <h4 style="margin:14px 0 8px;">🎯 Filter Recipient</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group"><label>Status Reservasi</label>
            <select id="bcFilterStatus" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
              <option value="">Semua</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
            </select>
          </div>
          <div class="form-group"><label>Pembayaran</label>
            <select id="bcFilterPay" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
              <option value="">Semua</option><option value="unpaid">Unpaid</option><option value="lunas">Lunas</option>
            </select>
          </div>
          <div class="form-group"><label>📅 Dari Tanggal</label>
            <input type="date" id="bcFilterFrom" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
          </div>
          <div class="form-group"><label>📅 Sampai Tanggal</label>
            <input type="date" id="bcFilterTo" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
          </div>
        </div>
        <div class="form-group"><label>Limit (max recipient per blast)</label>
          <input type="number" id="bcLimit" min="1" max="500" value="100" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
        </div>
        <button onclick="previewBroadcast()" class="btn btn-primary" style="width:100%;justify-content:center;">👁️ Preview & Generate Link</button>
        <div id="bcPreviewResult" style="margin-top:14px;"></div>
      </div>
      <div>
        <div class="setting-card" style="margin-bottom:14px;">
          <h3>💡 Cara Pakai</h3>
          <ol style="font-size:0.88rem;line-height:1.7;color:var(--text-soft);padding-left:20px;">
            <li>Pilih template di sebelah kiri (atau tulis pesan sendiri).</li>
            <li>Set filter — mis. status approved + lunas untuk customer yang sudah bayar.</li>
            <li>Klik <strong>Preview & Generate Link</strong>. Server akan generate wa.me link untuk tiap recipient.</li>
            <li>Klik tombol <strong>"📤 Kirim ke Nama"</strong> di sebelah kanan, satu-satu — WA akan terbuka dengan pesan terisi.</li>
            <li>Atau klik <strong>"Buka Semua Sekaligus"</strong> untuk mengirim batch (beberapa tab WA terbuka).</li>
          </ol>
        </div>
        <div class="setting-card">
          <h3>🔒 Kenapa pakai wa.me link?</h3>
          <p style="color:var(--text-soft);font-size:0.85rem;line-height:1.6;">
            Gratis tanpa API eksternal. Admin klik manual atau batch.
            Untuk otomatis penuh ke 100+ nomor sekaligus, upgrade ke
            WhatsApp Business API + provider (Fonnte/Wablas) dan kita
            bisa integrasi dengan satu endpoint tambahan.
          </p>
        </div>
      </div>
    </div>
  `;
  updateBcBodyPreview();
  // Reset body if user already had a session
  document.getElementById('bcPreviewResult').innerHTML = '';
  BROADCAST_LAST = null;
}

function updateBcBodyPreview() {
  const sel = document.getElementById('bcTemplate');
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  const body = document.getElementById('bcBody');
  if (!body) return;
  if (opt && opt.value && opt.dataset.body) {
    body.value = opt.dataset.body;
    body.disabled = false;
  } else if (!opt || !opt.value) {
    body.disabled = false;
    if (!body.value) body.value = 'Halo {{nama}}, ini pengingat untuk jadwal {{tanggal}} jam {{jam}}. Terima kasih 🌸';
  }
}

async function previewBroadcast() {
  const tplSel = document.getElementById('bcTemplate');
  const tplId = tplSel ? tplSel.value : '';
  const body = document.getElementById('bcBody').value.trim();
  if (!body) return alert('Isi pesan kosong. Pilih template atau tulis sendiri.');
  const filter = {
    status: document.getElementById('bcFilterStatus').value || undefined,
    payment_status: document.getElementById('bcFilterPay').value || undefined,
    from: document.getElementById('bcFilterFrom').value || undefined,
    to: document.getElementById('bcFilterTo').value || undefined,
    limit: parseInt(document.getElementById('bcLimit').value) || 100,
  };
  const name = document.getElementById('bcName').value.trim() || (tplSel && tplSel.selectedIndex >= 0 ? tplSel.options[tplSel.selectedIndex].dataset.name : 'Custom broadcast');
  const resultEl = document.getElementById('bcPreviewResult');
  resultEl.innerHTML = '<div style="padding:14px;background:var(--pink-50);border-radius:10px;text-align:center;">⏳ Generating wa.me links…</div>';
  try {
    const res = await api('/api/admin/broadcasts', {
      method: 'POST',
      body: JSON.stringify({
        template_id: tplId || null,
        body_override: body,
        filter,
        name,
      })
    });
    BROADCAST_LAST = res;
    const links = res.messages || [];
    const ids = links.map((m) => m.id);
    resultEl.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
          <div>
            <strong style="color:var(--primary);">✅ ${res.recipient_count} link siap kirim</strong>
            ${name ? `<div style="font-size:0.78rem;color:var(--text-soft);">${esc(name)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button onclick="broadcastOpenAll('${res.id}')" class="btn-sm btn-pay" title="Buka semua link di tab baru — beberapa pop-up akan muncul, klik 'Open' untuk masing-masing">📤 Kirim Semua</button>
            <button onclick="broadcastCopyAll('${res.id}')" class="btn-sm btn-view">📋 Copy List</button>
          </div>
        </div>
        <div style="max-height:380px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
          <table class="data-table" style="font-size:0.85rem;">
            <thead><tr><th>Pasien</th><th>WhatsApp</th><th>Pesan Preview</th><th>Aksi</th></tr></thead>
            <tbody>
              ${links.map((m) => `
                <tr>
                  <td><strong>${esc(m.name)}</strong></td>
                  <td><code>${esc(m.phone)}</code></td>
                  <td style="max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-soft);" title="${esc(m.text)}">${esc(m.text)}</td>
                  <td>
                    <a href="${esc(m.link)}" target="_blank" rel="noopener" class="btn-sm btn-pay" style="text-decoration:none;display:inline-block;padding:6px 12px;">📤 Kirim</a>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <small style="color:var(--text-soft);display:block;margin-top:8px;">💡 Klik "📤 Kirim Semua" untuk membuka semua link di tab baru. Browser biasanya minta izin pop-up — klik "Allow". Broadcast tersimpan di tab History.</small>
      </div>
    `;
  } catch (e) {
    resultEl.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message)}</div>`;
  }
}

async function broadcastOpenAll(id) {
  // Re-fetch to get the latest message list (in case re-opened mid-session)
  let messages;
  if (BROADCAST_LAST && BROADCAST_LAST.id === id) {
    messages = BROADCAST_LAST.messages;
  } else {
    try {
      const b = await api('/api/admin/broadcasts/' + id);
      messages = b.messages;
    } catch (e) { return alert('Broadcast tidak ditemukan: ' + e.message); }
  }
  if (!messages || !messages.length) return alert('Tidak ada recipient.');
  const urls = messages.map((m) => m.link).filter(Boolean);
  if (!urls.length) return;
  // Try to open all links via window.open. Browsers may cap how many
  // tabs a script can open at once (chromium ~6) — that's fine, admins
  // can click "Kirim Semua" repeatedly.
  let opened = 0;
  for (const url of urls) {
    const w = window.open(url, '_blank');
    if (w) opened++;
  }
  alert(`✅ ${opened}/${urls.length} link dibuka di tab baru. Sisanya mungkin diblokir pop-up — klik "Allow" di address bar, lalu coba lagi.`);
}

async function broadcastCopyAll(id) {
  let messages;
  if (BROADCAST_LAST && BROADCAST_LAST.id === id) {
    messages = BROADCAST_LAST.messages;
  } else {
    const b = await api('/api/admin/broadcasts/' + id);
    messages = b.messages;
  }
  if (!messages || !messages.length) return;
  const txt = messages.map((m) => `${m.name} (${m.phone})\n${m.text}\n${m.link}`).join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(txt);
    alert(`✅ ${messages.length} link disalin ke clipboard. Paste di spreadsheet untuk analisis.`);
  } catch {
    prompt('Salin manual:', txt);
  }
}

function renderBroadcastTemplates() {
  const body = document.getElementById('broadcastBody');
  if (!body) return;
  const list = BROADCAST_TEMPLATES.length ? BROADCAST_TEMPLATES : (SETTINGS.whatsapp_templates || []);
  body.innerHTML = `
    <div class="setting-card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        <div>
          <h3>📝 Template Pesan</h3>
          <p style="color:var(--text-soft);font-size:0.85rem;margin:4px 0 0;">Template yang bisa dipilih saat membuat broadcast. Tambah, edit, atau hapus sesuka hati.</p>
        </div>
        <button onclick="addBcTemplate()" class="btn-sm btn-approve">+ Tambah Template</button>
      </div>
      <div id="bcTemplatesList"></div>
    </div>
  `;
  const wrap = document.getElementById('bcTemplatesList');
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<p style="text-align:center;color:var(--text-soft);padding:20px;background:var(--bg);border-radius:10px;">Belum ada template. Klik "+ Tambah Template" untuk mulai.</p>';
    return;
  }
  wrap.innerHTML = list.map((t) => `
    <div style="display:grid;grid-template-columns:1fr 130px 1fr 90px;gap:8px;margin-bottom:10px;align-items:start;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--bg);">
      <input type="text" value="${esc(t.name)}" onchange="updateBcTemplate('${t.id}', {name: this.value})" style="padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-family:inherit;font-weight:700;">
      <select onchange="updateBcTemplate('${t.id}', {category: this.value})" style="padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-family:inherit;">
        <option value="reminder" ${t.category === 'reminder' ? 'selected' : ''}>⏰ Reminder</option>
        <option value="followup" ${t.category === 'followup' ? 'selected' : ''}>🙏 Follow-up</option>
        <option value="promo" ${t.category === 'promo' ? 'selected' : ''}>🎁 Promo</option>
        <option value="other" ${!['reminder','followup','promo'].includes(t.category) ? 'selected' : ''}>📌 Lainnya</option>
      </select>
      <textarea rows="3" onchange="updateBcTemplate('${t.id}', {body: this.value})" style="padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-family:inherit;font-size:0.85rem;resize:vertical;">${esc(t.body)}</textarea>
      <button onclick="deleteBcTemplate('${t.id}')" class="btn-sm btn-del" style="padding:8px 12px;height:auto;">🗑️</button>
    </div>
    <small style="color:var(--text-soft);display:block;margin-top:-6px;margin-bottom:14px;font-size:0.78rem;">
      Placeholder: <code>{{nama}}</code>, <code>{{tanggal}}</code>, <code>{{jam}}</code>, <code>{{layanan}}</code>, <code>{{total}}</code>, <code>{{invoice_no}}</code>, <code>{{alamat}}</code>
    </small>
  `).join('');
}

async function addBcTemplate() {
  const name = prompt('Nama template (mis. ⏰ Pengingat H-1):');
  if (!name) return;
  try {
    const t = await api('/api/admin/whatsapp/templates', { method: 'POST', body: JSON.stringify({ name, body: 'Halo {{nama}}, [tulis pesan di sini]', category: 'other' }) });
    BROADCAST_TEMPLATES.push(t);
    renderBroadcastTemplates();
  } catch (e) { alert('Gagal: ' + e.message); }
}

async function updateBcTemplate(id, patch) {
  try {
    const t = await api('/api/admin/whatsapp/templates/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    const idx = BROADCAST_TEMPLATES.findIndex((x) => x.id === id);
    if (idx >= 0) BROADCAST_TEMPLATES[idx] = t;
    // Sync SETTINGS too so the home page settings-fetch stays correct.
    if (SETTINGS.whatsapp_templates) {
      SETTINGS.whatsapp_templates = BROADCAST_TEMPLATES;
    }
  } catch (e) { alert('Gagal update: ' + e.message); renderBroadcastTemplates(); }
}

async function deleteBcTemplate(id) {
  if (!confirm('Hapus template ini? Pesan yang sudah dikirim sebelumnya tetap ada di History.')) return;
  try {
    await api('/api/admin/whatsapp/templates/' + id, { method: 'DELETE' });
    BROADCAST_TEMPLATES = BROADCAST_TEMPLATES.filter((t) => t.id !== id);
    renderBroadcastTemplates();
  } catch (e) { alert('Gagal: ' + e.message); }
}

function renderBroadcastHistory() {
  const body = document.getElementById('broadcastBody');
  if (!body) return;
  const list = BROADCAST_HISTORY || [];
  body.innerHTML = `
    <div class="setting-card">
      <h3>📜 Riwayat Broadcast (200 terakhir)</h3>
      <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 14px;">Riwayat blast untuk audit & rekap. Klik baris untuk lihat pesan lengkap.</p>
      <div id="bcHistoryList">
        ${list.length ? `
          <table class="data-table" style="font-size:0.88rem;">
            <thead><tr>
              <th>Tanggal</th><th>Nama Broadcast</th><th>Recipient</th><th>Filter</th><th>Aksi</th>
            </tr></thead>
            <tbody>
              ${list.map((b) => `
                <tr>
                  <td>${fmtDateTime(b.created_at)}</td>
                  <td><strong>${esc(b.name)}</strong><br><small style="color:var(--text-soft);">${esc(b.body.slice(0, 60))}${b.body.length > 60 ? '…' : ''}</small></td>
                  <td>✅ ${b.recipient_count}${b.skipped_no_phone ? ` &nbsp;<small style="color:#c43050;">(${b.skipped_no_phone} no-HP)</small>` : ''}</td>
                  <td>${formatFilter(b.filter)}</td>
                  <td><button onclick="viewBroadcastHistory(${b.id})" class="btn-sm btn-view">👁️ Lihat</button> &nbsp; <button onclick="deleteBroadcastHistory(${b.id})" class="btn-sm btn-del">🗑️</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<p style="text-align:center;color:var(--text-soft);padding:20px;background:var(--bg);border-radius:10px;">Belum ada broadcast. Buat yang pertama di tab 📨 Kirim.</p>'}
      </div>
    </div>
  `;
}

function formatFilter(f) {
  if (!f) return '—';
  const parts = [];
  if (f.status) parts.push(`status=${f.status}`);
  if (f.payment_status) parts.push(`bayar=${f.payment_status}`);
  if (f.from) parts.push(`dari=${f.from}`);
  if (f.to) parts.push(`sampai=${f.to}`);
  if (f.limit) parts.push(`limit=${f.limit}`);
  return parts.length ? parts.join(', ') : 'Semua';
}

async function viewBroadcastHistory(id) {
  try {
    const b = await api('/api/admin/broadcasts/' + id);
    const messages = b.messages || [];
    const html = `
      <h3>📋 ${esc(b.name)}</h3>
      <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 14px;">${fmtDateTime(b.created_at)} · ${b.recipient_count} recipient${b.skipped_no_phone ? ` (${b.skipped_no_phone} dilewati tanpa HP)` : ''} · oleh ${esc(b.created_by)}</p>
      <div style="padding:12px;background:var(--pink-50);border-radius:10px;font-size:0.85rem;line-height:1.5;white-space:pre-wrap;margin-bottom:14px;border:1px solid var(--pink-100);">${esc(b.body)}</div>
      ${messages.length ? `
        <div style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
          <table class="data-table" style="font-size:0.85rem;">
            <thead><tr><th>Pasien</th><th>WhatsApp</th><th>Pesan</th><th>Aksi</th></tr></thead>
            <tbody>
              ${messages.map((m) => `
                <tr>
                  <td>${esc(m.name)}</td>
                  <td><code>${esc(m.phone)}</code></td>
                  <td style="max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-soft);" title="${esc(m.text)}">${esc(m.text)}</td>
                  <td><a href="${esc(m.link)}" target="_blank" rel="noopener" class="btn-sm btn-pay" style="text-decoration:none;display:inline-block;padding:6px 10px;">📤</a></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<p style="color:var(--text-soft);">Tidak ada pesan.</p>'}
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn-sm btn-view" onclick="closeModal()">Tutup</button>
      </div>
    `;
    openModal(html);
  } catch (e) { alert('Gagal: ' + e.message); }
}

async function deleteBroadcastHistory(id) {
  if (!confirm('Hapus broadcast ini dari history? Pesan yang sudah terkirim tidak bisa dibatalkan.')) return;
  try {
    await api('/api/admin/broadcasts/' + id, { method: 'DELETE' });
    BROADCAST_HISTORY = BROADCAST_HISTORY.filter((b) => b.id !== id);
    renderBroadcastHistory();
  } catch (e) { alert('Gagal: ' + e.message); }
}

// ---------- MINI-CRM (Customer Profile + RFM) ----------
let CUST_SORT = 'recent';
let CUST_CACHE = [];

async function renderCustomers() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <div>
        <h1>👥 Mini-CRM Pelanggan</h1>
        <p style="color:var(--text-soft);margin:4px 0 0;">Lihat profil per-pelanggan: total visit, total spend, RFM score, & timeline kunjungan.</p>
      </div>
      <button onclick="renderCustomers()" class="btn btn-outline">🔄 Refresh</button>
    </div>
    <div id="crmContent">Loading...</div>
  `;
  try {
    const data = await api('/api/admin/customers?sort=' + CUST_SORT);
    CUST_CACHE = data.customers;
    renderCustomerSummaryAndTable();
    // Fire-and-forget heatmap fetch
    api('/api/admin/charts/heatmap').then(renderHeatmap).catch(() => {});
  } catch (e) {
    document.getElementById('crmContent').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
  }
}

function renderCustomerSummaryAndTable() {
  const customers = CUST_CACHE || [];
  const total = customers.length;
  const totalSpend = customers.reduce((s, c) => s + c.total_spent, 0);
  const aaa = customers.filter((c) => c.rfm === 'AAA').length;
  const dormant = customers.filter((c) => c.last_visit_age_days > 180).length;
  const outstanding = customers.filter((c) => c.has_outstanding).length;
  document.getElementById('crmContent').innerHTML = `
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));margin-bottom:14px;">
      <div class="stat-card"><div class="label">Total Pelanggan</div><div class="value">${total}</div></div>
      <div class="stat-card peach"><div class="label">Total Spend</div><div class="value">${fmtRp(totalSpend)}</div></div>
      <div class="stat-card pink"><div class="label">⭐ Pelanggan AAA</div><div class="value">${aaa}</div></div>
      <div class="stat-card"><div class="label">😴 Dormant >180h</div><div class="value">${dormant}</div></div>
      <div class="stat-card"><div class="label">⚠️ Outstanding</div><div class="value">${outstanding}</div></div>
    </div>
    <div class="setting-card" style="overflow:hidden;">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
        <input type="search" id="crmSearch" placeholder="🔍 Cari nama / HP" oninput="renderCustomerRows()" style="flex:1;min-width:200px;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
        <select id="crmSort" onchange="CUST_SORT=this.value;renderCustomers()" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-weight:600;font-family:inherit;">
          <option value="recent" ${CUST_SORT === 'recent' ? 'selected' : ''}>↕️ Kunjungan Terbaru</option>
          <option value="spend" ${CUST_SORT === 'spend' ? 'selected' : ''}>💰 Total Spend Terbesar</option>
          <option value="frequency" ${CUST_SORT === 'frequency' ? 'selected' : ''}>🔁 Paling Sering Booking</option>
          <option value="rfm" ${CUST_SORT === 'rfm' ? 'selected' : ''}>⭐ RFM Terbaik</option>
          <option value="name" ${CUST_SORT === 'name' ? 'selected' : ''}>🔤 Nama A-Z</option>
        </select>
      </div>
      <div id="crmHeatmap" style="margin-top:14px;"></div>
      <h3 style="margin:20px 0 10px;font-size:1.05rem;">👤 Daftar Pelanggan</h3>
      <div id="crmRows" class="data-table-wrap" style="overflow:auto;max-height:520px;"></div>
    </div>
  `;
  renderCustomerRows();
}

function renderCustomerRows() {
  const customers = CUST_CACHE || [];
  const q = (document.getElementById('crmSearch')?.value || '').toLowerCase().trim();
  const filtered = q ? customers.filter((c) => c.patient_name.toLowerCase().includes(q) || c.phone.includes(q.replace(/\D/g, ''))) : customers;
  const wrap = document.getElementById('crmRows');
  if (!filtered.length) {
    wrap.innerHTML = `<p style="text-align:center;color:var(--text-soft);padding:30px;">${customers.length ? `Tidak ada yang cocok dengan "${esc(q)}".` : 'Belum ada pelanggan (belum ada reservasi dengan nomor WhatsApp).'}</p>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Pelanggan</th><th>RFM</th><th>Visit</th><th>Spend</th><th>Terakhir</th><th>Aksi</th>
      </tr></thead>
      <tbody>
        ${filtered.map((c) => `
          <tr style="${c.has_outstanding ? 'background:rgba(196,48,80,0.05);' : ''}">
            <td>
              <strong>${esc(c.patient_name)}</strong>
              <br><small style="color:var(--text-soft);">📱 <a href="https://wa.me/${c.whatsapp_intl}" target="_blank">${esc(c.phone)}</a></small>
              ${c.address ? `<br><small style="color:var(--text-soft);">📍 ${esc(c.address.slice(0, 40))}${c.address.length > 40 ? '…' : ''}</small>` : ''}
            </td>
            <td><span title="Recency-Frequency-Monetary: ${c.rfm}" style="display:inline-block;padding:3px 10px;border-radius:8px;font-weight:700;font-size:0.78rem;${rfmColor(c.rfm)}">${c.rfm}</span></td>
            <td>${c.total_reservations} <small style="color:var(--text-soft);">(${Object.entries(c.status_breakdown || {}).map(([k, v]) => `${k}:${v}`).join(', ')})</small></td>
            <td><strong>${fmtRp(c.total_spent)}</strong>${c.has_outstanding ? '<br><small style="color:#c43050;font-weight:700;">⚠️ ada tunggakan</small>' : ''}</td>
            <td>${c.last_visit ? fmtDate(c.last_visit) : '<em style="color:var(--text-soft);">—</em>'}<br><small style="color:var(--text-soft);">${c.last_visit_age_days === 9999 ? '—' : c.last_visit_age_days + ' hari lalu'}</small></td>
            <td>
              <button onclick="openCustomerProfile('${c.phone}')" class="btn-sm btn-view">👤 Profil</button>
              <a href="https://wa.me/${c.whatsapp_intl}" target="_blank" class="btn-sm btn-pay" style="text-decoration:none;display:inline-block;">💬 Chat</a>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function rfmColor(rfm) {
  if (!rfm) return 'background:var(--bg);color:var(--text-soft);';
  const a = (rfm.match(/A/g) || []).length;
  if (a === 3) return 'background:#d9efe1;color:#1e8957;border:1px solid #1e8957;';
  if (a === 2) return 'background:#e8f5e9;color:#2e7d32;';
  if (a === 1) return 'background:#fff3d6;color:#b07b15;';
  return 'background:#fde0e4;color:#c43050;';
}

async function openCustomerProfile(phone) {
  try {
    const c = await api('/api/admin/customers/' + phone);
    const t = c.timeline || [];
    const html = `
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px;">
        <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#ee5a8a,#ffb979);display:flex;align-items:center;justify-content:center;color:white;font-size:1.5rem;font-weight:800;">
          ${esc((c.patient_name || '?').trim().charAt(0).toUpperCase())}
        </div>
        <div>
          <h3 style="margin:0;">${esc(c.patient_name)}</h3>
          <div style="color:var(--text-soft);font-size:0.85rem;">
            <a href="https://wa.me/${c.whatsapp_intl}" target="_blank" style="color:var(--primary);text-decoration:none;font-weight:600;">📱 ${esc(c.phone)}</a>
            ${c.address ? '<br>📍 ' + esc(c.address) : ''}
          </div>
        </div>
        <div style="margin-left:auto;">
          <span title="RFM ${c.rfm}" style="display:inline-block;padding:6px 14px;border-radius:12px;font-weight:700;font-size:0.9rem;${rfmColor(c.rfm)}">${c.rfm}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px;">
        <div style="padding:10px 14px;background:var(--bg);border-radius:10px;">
          <div style="font-size:0.76rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.5px;">Total Visit</div>
          <div style="font-size:1.4rem;font-weight:800;">${c.total_reservations}</div>
        </div>
        <div style="padding:10px 14px;background:var(--pink-50);border-radius:10px;">
          <div style="font-size:0.76rem;color:var(--primary);text-transform:uppercase;letter-spacing:0.5px;">Total Spend</div>
          <div style="font-size:1.2rem;font-weight:800;color:var(--primary);">${fmtRp(c.total_spent)}</div>
        </div>
        <div style="padding:10px 14px;background:var(--bg);border-radius:10px;">
          <div style="font-size:0.76rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.5px;">Pertama</div>
          <div style="font-size:0.95rem;font-weight:700;">${c.first_visit ? fmtDate(c.first_visit) : '—'}</div>
        </div>
        <div style="padding:10px 14px;background:var(--bg);border-radius:10px;">
          <div style="font-size:0.76rem;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.5px;">Terakhir</div>
          <div style="font-size:0.95rem;font-weight:700;">${c.last_visit ? fmtDate(c.last_visit) : '—'}<br><small style="color:var(--text-soft);font-weight:500;">${c.last_visit_age_days === 9999 ? '' : c.last_visit_age_days + ' hari lalu'}</small></div>
        </div>
      </div>
      <h4 style="margin:0 0 8px;">📅 Timeline Kunjungan (${t.length})</h4>
      <div style="max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
        ${t.length ? `
          <table class="data-table" style="font-size:0.85rem;">
            <thead><tr><th>Tgl</th><th>Jam</th><th>Layanan</th><th>Total</th><th>Status</th></tr></thead>
            <tbody>
              ${t.map((e) => `
                <tr style="background:${e.type === 'receipt' ? 'var(--pink-50)' : ''}">
                  <td>${esc(e.date)}${e.invoice_no ? `<br><small style="color:var(--text-soft);">${esc(e.invoice_no)}</small>` : ''}</td>
                  <td>${esc(e.time || '—')}</td>
                  <td>${esc(e.service_name || '—')}</td>
                  <td><strong>${fmtRp(e.total || 0)}</strong></td>
                  <td>${e.type === 'reservation' ? `<span class="badge badge-${e.status}">${e.status}</span> ${e.payment_status ? `<span class="badge badge-${e.payment_status}">${e.payment_status}</span>` : ''}` : '<small style="color:var(--primary);">🧾 kwitansi</small>'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<p style="text-align:center;color:var(--text-soft);padding:20px;">Belum ada kunjungan.</p>'}
      </div>
      <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <a href="https://wa.me/${c.whatsapp_intl}" target="_blank" class="btn btn-wa" style="text-decoration:none;">💬 Chat WhatsApp</a>
        <button class="btn btn-primary" onclick="closeModal();navigate('broadcast');setTimeout(()=>{document.getElementById('bcFilterStatus').value='approved';document.getElementById('bcFilterPay').value='';},200);">📢 Broadcast ke Customer Serupa</button>
        <button class="btn btn-view" onclick="closeModal()">Tutup</button>
      </div>
    `;
    openModal(html);
  } catch (e) { alert('Gagal: ' + e.message); }
}

function renderHeatmap(h) {
  const wrap = document.getElementById('crmHeatmap');
  if (!wrap || !h || !h.grid) return;
  const days = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  const max = Math.max(h.max || 0, 1);
  // Only render hours with any data + 0–21 (last slot stays implicit).
  wrap.innerHTML = `
    <h3 style="margin:14px 0 6px;font-size:1.05rem;">🕒 Heatmap Jam Sibuk (${h.total} reservasi total)</h3>
    <p style="color:var(--text-soft);font-size:0.82rem;margin:0 0 8px;">Cell lebih gelap = lebih banyak booking pada jam tersebut. Berguna untuk atur jadwal bidan.</p>
    <div style="overflow-x:auto;">
      <table class="heatmap" style="border-collapse:separate;border-spacing:2px;font-size:0.76rem;">
        <thead>
          <tr>
            <th style="background:transparent;padding:4px 6px;"></th>
            ${Array.from({ length: 22 }, (_, i) => `<th style="background:transparent;padding:4px 6px;font-weight:600;color:var(--text-soft);">${i.toString().padStart(2, '0')}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${h.grid.map((row, di) => `
            <tr>
              <th style="background:transparent;padding:4px 8px;font-weight:600;color:var(--text-soft);text-align:left;">${days[di]}</th>
              ${row.map((count, hi) => `
                <td style="padding:0;">
                  <div title="${count} booking on ${days[di]} jam ${hi.toString().padStart(2,'0')}:00"
                    style="height:28px;width:28px;border-radius:6px;background:${count === 0 ? 'var(--bg)' : 'rgba(238,90,138,' + (0.15 + 0.65 * (count / max)) + ')'};color:${count > max / 2 ? 'white' : 'var(--text)'};font-weight:600;display:flex;align-items:center;justify-content:center;font-size:0.78rem;cursor:default;">
                    ${count > 0 ? count : ''}
                  </div>
                </td>
              `).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ---------- ACCOUNTING — P&L (Pendapatan vs Beban) ----------
let ACCT_DATA = null;
let ACCT_CATEGORIES = [];
let ACCT_TAB = 'pnl'; // 'pnl' | 'expenses' | 'categories'
let ACCT_INCOME_CHART = null;
let ACCT_EXPENSE_CHART = null;

async function renderAccounting() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <div>
        <h1>💰 Akunting — P&L</h1>
        <p style="color:var(--text-soft);margin:4px 0 0;">Laba Rugi = Pendapatan (reservasi lunas) − Beban operasional. Bantu admin lihat profit bersih per bulan.</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="acctSwitchTab('pnl')" id="acctTabPnl" class="btn-sm btn-pay">📈 P&L Bulanan</button>
        <button onclick="acctSwitchTab('expenses')" id="acctTabExp" class="btn-sm btn-view">💸 Catat Beban</button>
        <button onclick="acctSwitchTab('categories')" id="acctTabCat" class="btn-sm btn-view">🏷️ Kategori</button>
      </div>
    </div>
    <div id="acctBody">Loading...</div>
  `;
  await Promise.all([
    api('/api/admin/accounting/summary?months=6').then(d => { ACCT_DATA = d; }).catch(() => { ACCT_DATA = null; }),
    api('/api/admin/expense-categories').then(cs => { ACCT_CATEGORIES = cs; }).catch(() => { ACCT_CATEGORIES = []; }),
  ]);
  acctSwitchTab(ACCT_TAB);
}

function acctSwitchTab(tab) {
  ACCT_TAB = tab;
  ['pnl', 'expenses', 'categories'].forEach((t) => {
    const el = document.getElementById('acctTab' + (t === 'pnl' ? 'Pnl' : t === 'expenses' ? 'Exp' : 'Cat'));
    if (!el) return;
    el.className = t === tab ? 'btn-sm btn-pay' : 'btn-sm btn-view';
  });
  if (tab === 'pnl') renderAcctPnl();
  else if (tab === 'expenses') renderAcctExpenses();
  else renderAcctCategories();
}

function renderAcctPnl() {
  const body = document.getElementById('acctBody');
  if (!body) return;
  const d = ACCT_DATA;
  if (!d) { body.innerHTML = '<div class="alert alert-error">Tidak ada data.</div>'; return; }
  body.innerHTML = `
    <div class="setting-card" style="margin-bottom:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
        <h3 style="margin:0;">📊 ${d.months} Bulan Terakhir</h3>
        <div style="font-size:0.82rem;color:var(--text-soft);">Pendapatan dari reservasi lunas. Beban dari pencatatan manual di tab "Catat Beban".</div>
      </div>
      <div class="stat-grid" style="margin-bottom:14px;">
        <div class="stat-card peach">
          <div class="label">💰 Total Pendapatan</div>
          <div class="value">${fmtRp(d.totals.income)}</div>
        </div>
        <div class="stat-card" style="background:#fde0e4;color:#c43050;">
          <div class="label" style="color:#c43050;">💸 Total Beban</div>
          <div class="value" style="color:#c43050;">${fmtRp(d.totals.expense)}</div>
        </div>
        <div class="stat-card ${d.totals.profit < 0 ? '' : 'pink'}">
          <div class="label">${d.totals.profit < 0 ? '⚠️ Rugi Bersih' : '📈 Laba Bersih'}</div>
          <div class="value" style="color:${d.totals.profit < 0 ? '#c43050' : ''};">${fmtRp(d.totals.profit)}</div>
        </div>
        <div class="stat-card">
          <div class="label">Margin</div>
          <div class="value">${d.totals.income > 0 ? Math.round((d.totals.profit / d.totals.income) * 100) + '%' : '—'}</div>
        </div>
      </div>
      <div class="chart-card" style="background:transparent;border:1px solid var(--border);border-radius:12px;padding:14px;">
        <h4 style="margin:0 0 8px;">📈 Income vs Expense per Bulan</h4>
        <div class="chart-canvas-wrap" style="height:280px;"><canvas id="acctIncomeChart"></canvas></div>
      </div>
      ${d.expenses_by_category && Object.keys(d.expenses_by_category).length ? `
        <div class="chart-card" style="background:transparent;border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:12px;">
          <h4 style="margin:0 0 8px;">🍩 Beban per Kategori (${d.months} bulan)</h4>
          <div class="chart-canvas-wrap" style="height:240px;"><canvas id="acctExpenseChart"></canvas></div>
        </div>
      ` : ''}
      <h4 style="margin:18px 0 8px;">📋 Detail per Bulan</h4>
      <div style="overflow:auto;border:1px solid var(--border);border-radius:10px;">
        <table class="data-table">
          <thead><tr><th>Bulan</th><th>Pendapatan</th><th>Beban</th><th>Laba / Rugi</th><th>Margin</th></tr></thead>
          <tbody>
            ${d.byMonth.map((m) => `
              <tr style="${m.profit < 0 ? 'background:rgba(196,48,80,0.05);' : ''}">
                <td><strong>${m.month}</strong></td>
                <td>${fmtRp(m.income)}</td>
                <td>${fmtRp(m.expense)}</td>
                <td><strong style="color:${m.profit < 0 ? '#c43050' : 'var(--primary)'};">${fmtRp(m.profit)}</strong></td>
                <td>${m.income > 0 ? Math.round((m.profit / m.income) * 100) + '%' : '—'}</td>
              </tr>
            `).join('')}
            <tr style="background:var(--primary);color:white;font-weight:700;">
              <td>TOTAL</td>
              <td>${fmtRp(d.totals.income)}</td>
              <td>${fmtRp(d.totals.expense)}</td>
              <td>${fmtRp(d.totals.profit)}</td>
              <td>${d.totals.income > 0 ? Math.round((d.totals.profit / d.totals.income) * 100) + '%' : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
  drawAcctCharts(d);
}

function drawAcctCharts(d) {
  if (typeof window.Chart !== 'function') return; // CDN failure → skip silently
  // Income vs Expense line chart
  const labels = d.monthList.map((m) => m.slice(2)); // MM-YY
  const incomeCtx = document.getElementById('acctIncomeChart');
  if (ACCT_INCOME_CHART) { try { ACCT_INCOME_CHART.destroy(); } catch {} }
  if (incomeCtx) {
    ACCT_INCOME_CHART = new Chart(incomeCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Pendapatan', data: d.byMonth.map((m) => m.income), backgroundColor: 'rgba(238,90,138,0.7)', borderRadius: 6 },
          { label: 'Beban', data: d.byMonth.map((m) => m.expense), backgroundColor: 'rgba(196,48,80,0.6)', borderRadius: 6 },
          { type: 'line', label: 'Laba Bersih', data: d.byMonth.map((m) => m.profit), borderColor: '#1e8957', backgroundColor: '#1e8957', borderWidth: 2.5, pointRadius: 5, tension: 0.3, fill: false }
        ]
      },
      options: chartOpts({ y: { ticks: { callback: (v) => 'Rp' + (v / 1000) + 'k' } } })
    });
  }
  const expenseCtx = document.getElementById('acctExpenseChart');
  if (ACCT_EXPENSE_CHART) { try { ACCT_EXPENSE_CHART.destroy(); } catch {} }
  if (expenseCtx && d.expenses_by_category) {
    const labels = Object.keys(d.expenses_by_category);
    const data = labels.map((k) => d.expenses_by_category[k]);
    ACCT_EXPENSE_CHART = new Chart(expenseCtx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: ['#ee5a8a', '#ffb979', '#a070d8', '#5cb8b1', '#ffa76a', '#7c8390'] }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
    });
  }
}

async function renderAcctExpenses() {
  const body = document.getElementById('acctBody');
  if (!body) return;
  // Re-fetch to make sure we have the latest categories (CRUD from
  // the Categories tab reflects on this dropdown immediately).
  try { ACCT_CATEGORIES = await api('/api/admin/expense-categories'); } catch {}
  const month = localMonthStr();
  body.innerHTML = `
    <div class="setting-card" style="margin-bottom:14px;">
      <h3>💸 Catat Pengeluaran</h3>
      <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 14px;">Catat beban operasional bulanan: bensin, supplies, marketing, dll. Setiap entry langsung masuk ke P&L.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
        <div class="form-group"><label>Tanggal</label><input type="date" id="exDate" value="${localTodayStr()}" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;"></div>
        <div class="form-group"><label>Kategori</label>
          <select id="exCat" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
            ${ACCT_CATEGORIES.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Jumlah (Rp)</label><input type="number" id="exAmount" min="1" placeholder="cth: 50000" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;"></div>
      </div>
      <div class="form-group"><label>Keterangan (opsional)</label><input type="text" id="exDesc" maxlength="200" placeholder="cth: Bensin ke rumah Bunda Rina di Cilacap" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;"></div>
      <button onclick="acctAddExpense()" class="btn btn-primary" style="margin-top:8px;">💸 Catat Pengeluaran</button>
      <div id="exFeedback" style="margin-top:10px;"></div>
    </div>
    <div class="setting-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <h3 style="margin:0;">📋 Riwayat Beban</h3>
        <select id="exFilterMonth" onchange="acctReloadExpenses()" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;font-weight:600;">
          <option value="">Semua Waktu</option>
          ${buildMonthOptions(month, 6)}
        </select>
      </div>
      <div id="exList">Loading...</div>
    </div>
  `;
  acctReloadExpenses();
}

function buildMonthOptions(selectedMonth, count) {
  // PENTING: value memakai string bulan lokal (bukan toISOString yang
  // bergeser ke bulan sebelumnya pada 00:00-06:59 WIB tanggal 1),
  // supaya value & label di dropdown selalu konsisten.
  let out = '';
  for (let i = 0; i < count; i++) {
    const m = shiftMonthStr(localMonthStr(), -i);
    const [yy, mm] = m.split('-').map(Number);
    const label = new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    out += `<option value="${m}" ${m === selectedMonth ? 'selected' : ''}>${label}</option>`;
  }
  return out;
}

async function acctReloadExpenses() {
  const month = document.getElementById('exFilterMonth')?.value || '';
  const wrap = document.getElementById('exList');
  if (!wrap) return;
  wrap.innerHTML = '<p style="text-align:center;color:var(--text-soft);">Memuat…</p>';
  try {
    const rows = await api('/api/admin/expenses' + (month ? '?month=' + month : ''));
    if (!rows.length) {
      wrap.innerHTML = '<p style="text-align:center;color:var(--text-soft);padding:20px;background:var(--bg);border-radius:10px;">Belum ada catatan beban' + (month ? ' di ' + month : '') + '.</p>';
      return;
    }
    const catMap = Object.fromEntries(ACCT_CATEGORIES.map((c) => [c.id, c]));
    const total = rows.reduce((s, r) => s + r.amount, 0);
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;background:var(--pink-50);padding:10px 14px;border-radius:10px;">
        <strong style="color:var(--primary);">Total ${rows.length} beban${month ? ' di ' + month : ''}</strong>
        <strong style="color:var(--primary);">${fmtRp(total)}</strong>
      </div>
      <div style="overflow:auto;border:1px solid var(--border);border-radius:10px;">
        <table class="data-table">
          <thead><tr><th>Tanggal</th><th>Kategori</th><th>Keterangan</th><th>Jumlah</th><th>Aksi</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${fmtDate(r.date)}</td>
                <td>${esc((catMap[r.category] && catMap[r.category].name) || r.category)}</td>
                <td style="font-size:0.85rem;color:var(--text-soft);">${esc(r.description || '—')}</td>
                <td><strong>${fmtRp(r.amount)}</strong></td>
                <td>
                  <button class="btn-sm btn-view" onclick="acctEditExpense(${r.id})">✏️</button>
                  <button class="btn-sm btn-del" onclick="acctDelExpense(${r.id})">🗑️</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) { wrap.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
}

async function acctAddExpense() {
  const date = document.getElementById('exDate').value;
  const category = document.getElementById('exCat').value;
  const amount = document.getElementById('exAmount').value;
  const description = document.getElementById('exDesc').value;
  const fb = document.getElementById('exFeedback');
  fb.innerHTML = '';
  if (!date || !category || !amount) { fb.innerHTML = '<div class="alert alert-error">Tanggal, kategori, jumlah wajib diisi.</div>'; return; }
  try {
    const exp = await api('/api/admin/expenses', { method: 'POST', body: JSON.stringify({ date, category, amount, description }) });
    document.getElementById('exAmount').value = '';
    document.getElementById('exDesc').value = '';
    fb.innerHTML = `<div class="alert alert-success">✅ Tercatat: ${fmtRp(exp.amount)} untuk ${esc(exp.description || exp.category)}.</div>`;
    acctReloadExpenses();
    // Refresh P&L so charts reflect the new entry
    ACCT_DATA = await api('/api/admin/accounting/summary?months=6');
  } catch (e) { fb.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
}

async function acctEditExpense(id) {
  const desc = prompt('Edit keterangan (kosongkan jika tidak diubah):');
  const amtStr = prompt('Edit jumlah (Rp, kosongkan jika tidak diubah):');
  if (desc === null && amtStr === null) return;
  const patch = {};
  if (desc !== null) patch.description = desc;
  if (amtStr && amtStr.trim()) {
    const a = parseInt(amtStr, 10);
    if (!Number.isFinite(a) || a <= 0) return alert('Jumlah harus angka > 0');
    patch.amount = a;
  }
  try {
    await api('/api/admin/expenses/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
    acctReloadExpenses();
    ACCT_DATA = await api('/api/admin/accounting/summary?months=6');
  } catch (e) { alert('Gagal: ' + e.message); }
}

async function acctDelExpense(id) {
  if (!confirm('Hapus catatan beban ini?')) return;
  try {
    await api('/api/admin/expenses/' + id, { method: 'DELETE' });
    acctReloadExpenses();
    ACCT_DATA = await api('/api/admin/accounting/summary?months=6');
  } catch (e) { alert('Gagal: ' + e.message); }
}

async function renderAcctCategories() {
  const body = document.getElementById('acctBody');
  if (!body) return;
  try { ACCT_CATEGORIES = await api('/api/admin/expense-categories'); } catch {}
  body.innerHTML = `
    <div class="setting-card">
      <h3>🏷️ Kategori Beban</h3>
      <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 14px;">Edit kategori biaya operasional sesuai jenis usaha Anda. Default sudah termasuk kategori umum.</p>
      <div id="acctCatList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;"></div>
      <button onclick="acctSaveCategories()" class="btn btn-primary">💾 Simpan Kategori</button>
      <button onclick="acctAddCategory()" class="btn btn-view" style="margin-left:8px;">+ Tambah</button>
    </div>
  `;
  renderAcctCategoryInputs();
}

function renderAcctCategoryInputs() {
  const wrap = document.getElementById('acctCatList');
  if (!wrap) return;
  wrap.innerHTML = ACCT_CATEGORIES.map((c, i) => `
    <div style="display:grid;grid-template-columns:1fr 70px 50px;gap:8px;align-items:center;padding:10px;background:var(--bg);border-radius:10px;">
      <input type="text" value="${esc(c.name)}" placeholder="Nama kategori" oninput="ACCT_CATEGORIES[${i}].name=this.value" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-family:inherit;">
      <input type="color" value="${esc(c.color)}" oninput="ACCT_CATEGORIES[${i}].color=this.value" style="width:50px;height:38px;border:1px solid var(--border);border-radius:8px;cursor:pointer;padding:2px;">
      <button class="btn-sm btn-del" onclick="ACCT_CATEGORIES.splice(${i},1);renderAcctCategoryInputs();">×</button>
    </div>
  `).join('');
}

function acctAddCategory() {
  ACCT_CATEGORIES.push({ id: 'cat_' + Date.now().toString(36), name: 'Kategori Baru', color: '#7c8390' });
  renderAcctCategoryInputs();
}

async function acctSaveCategories() {
  try {
    ACCT_CATEGORIES = await api('/api/admin/expense-categories', { method: 'PUT', body: JSON.stringify(ACCT_CATEGORIES) });
    renderAcctCategoryInputs();
    alert('✅ Kategori disimpan.');
  } catch (e) { alert('Gagal: ' + e.message); }
}

// ---------- BACKUP / RESTORE ----------
async function renderBackup() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header"><h1>💾 Backup & Restore</h1></div>
    <div style="padding:14px 16px;background:#fff5f5;border:1.5px solid #f0b4b4;border-radius:12px;margin-bottom:16px;font-size:0.88rem;line-height:1.6;">
      🔒 <strong>Backup berisi data pribadi pasien</strong> (nama, alamat, nomor WhatsApp, riwayat layanan).
      Unduh versi <strong>terenkripsi</strong> (butuh passphrase), simpan di tempat aman, dan
      <strong>jangan pernah mengirimkannya lewat WhatsApp/email tanpa enkripsi</strong>.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;" id="bkGrid">
      <div class="feature" style="border:2px solid #7c3aed;">
        <div class="icn">🔐</div><h3>Backup Terenkripsi (disarankan)</h3>
        <p>Isi file tidak bisa dibaca tanpa passphrase. Simpan passphrase di tempat terpisah —
           file ini <strong>tidak bisa</strong> dipulihkan kalau passphrase hilang.</p>
        <div class="form-group" style="margin-top:12px;">
          <label style="font-size:0.85rem;font-weight:600;">Passphrase (min. 8 karakter)</label>
          <input type="password" id="bkPassphrase" placeholder="cth: kwitansi-adzkiya-2026-rahasia" style="font-family:monospace;font-size:0.88rem;" autocomplete="new-password">
          <div class="btn-row" style="margin-top:8px;">
            <button type="button" class="btn-sm btn-outline" onclick="generateBackupPassphrase()" style="font-size:0.82rem;padding:8px 14px;">🎲 Buat passphrase kuat</button>
            <button type="button" class="btn-sm btn-outline" onclick="toggleBackupPassphrase()" style="font-size:0.82rem;padding:8px 14px;">👁️ Lihat</button>
          </div>
        </div>
        <button onclick="doBackupEncrypted()" class="btn btn-primary" style="margin-top:12px;width:100%;">🔐 Download Backup Terenkripsi</button>
        <details style="margin-top:12px;">
          <summary style="cursor:pointer;font-size:0.82rem;color:var(--text-soft);">JSON polos (untuk dibaca manual — tidak disarankan)</summary>
          <button onclick="doBackupPlain()" class="btn btn-outline" style="margin-top:8px;width:100%;">📥 Download JSON Polos</button>
        </details>
      </div>
      <div class="feature">
        <div class="icn">📥</div><h3>Restore dari backup</h3>
        <p>Mendukung file backup terenkripsi (🔐) maupun JSON polos. Untuk file terenkripsi,
           passphrase akan diminta setelah file dipilih.</p>
        <input type="file" id="restoreFile" accept="application/json,.json" style="margin-top:14px;">
        <div style="margin-top:10px;">
          <label><input type="radio" name="restoreMode" value="append" checked> Append (tambah)</label><br>
          <label><input type="radio" name="restoreMode" value="replace"> Replace (ganti semua)</label>
        </div>
        <button onclick="doRestore()" class="btn btn-outline" style="margin-top:14px;width:100%;">📤 Restore</button>
      </div>
    </div>
    <style>@media(max-width:920px),(hover:none) and (pointer:coarse) and (max-width:1024px){#bkGrid{grid-template-columns:1fr !important;}}</style>
  `;
}

// Passphrase kuat yang mudah diketik ulang (4 kata + angka).
function generateBackupPassphrase() {
  const words = ['mawar', 'melati', 'anggrek', 'kenanga', 'bunda', 'bayi', 'sehat', 'ceria', 'adzkiya', 'cilacap', 'senja', 'pagi'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const value = `${pick()}-${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const el = document.getElementById('bkPassphrase');
  el.type = 'text';
  el.value = value;
  el.select();
  try { navigator.clipboard.writeText(value); } catch {}
  alert('Passphrase dibuat & sudah disalin ke clipboard:\n\n' + value +
    '\n\nSIMPAN di tempat aman (catatan/password manager). Tanpa passphrase ini, file backup tidak bisa dibuka.');
}

function toggleBackupPassphrase() {
  const el = document.getElementById('bkPassphrase');
  el.type = el.type === 'password' ? 'text' : 'password';
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function doBackupEncrypted() {
  const el = document.getElementById('bkPassphrase');
  const passphrase = (el && el.value || '').trim();
  if (passphrase.length < 8) {
    alert('Passphrase minimal 8 karakter. Klik "🎲 Buat passphrase kuat" kalau bingung.');
    el && el.focus();
    return;
  }
  try {
    const envelope = await api('/api/admin/backup/encrypted', {
      method: 'POST',
      body: JSON.stringify({ passphrase })
    });
    downloadJson(envelope, `adzkiya-backup-enc-${localTodayStr()}.json`);
    alert('✅ Backup terenkripsi terunduh.\n\nJangan lupa: file ini hanya bisa dipulihkan dengan passphrase yang tadi diisi.');
  } catch (e) {
    alert('Gagal membuat backup terenkripsi: ' + e.message);
  }
}

async function doBackupPlain() {
  if (!confirm('File JSON polos berisi SELURUH data pasien dalam bentuk teks biasa.\n\nSiapa pun yang mendapatkan file ini bisa membaca semuanya. Tetap unduh?')) return;
  try {
    const data = await api('/api/admin/backup');
    downloadJson(data, `adzkiya-backup-plain-${localTodayStr()}.json`);
  } catch (e) {
    alert('Gagal membuat backup: ' + e.message);
  }
}

async function doRestore() {
  const f = document.getElementById('restoreFile').files[0];
  if (!f) return alert('Pilih file backup JSON terlebih dahulu');
  const mode = document.querySelector('[name=restoreMode]:checked').value;
  if (mode === 'replace' && !confirm('PERINGATAN: Mode REPLACE akan MENGHAPUS semua data. Lanjutkan?')) return;
  const text = await f.text();
  let data;
  try { data = JSON.parse(text); } catch { return alert('File tidak valid'); }

  // Backup terenkripsi: minta passphrase sebelum dikirim ke server.
  let passphrase;
  if (data && data.format === 'adzkiya-backup-enc-v1') {
    const info = data.meta && data.meta.counts ? `\n\nIsi: ${data.meta.counts.reservations || 0} reservasi, ${data.meta.counts.receipts || 0} kwitansi.` : '';
    passphrase = prompt('File backup TERENKRIPSI. Masukkan passphrase:' + info);
    if (passphrase === null) return;
    if (!passphrase) return alert('Passphrase wajib diisi untuk membuka backup terenkripsi.');
  }

  try {
    const res = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify({ ...data, passphrase, mode, sync_reservations: true }) });
    const i = res.imported || {};
    let msg = `✅ Restore selesai (mode: ${res.mode})\n\n` +
              `Reservasi: ${i.reservations} masuk, ${i.reservations_skipped || 0} dilewati\n` +
              `Kwitansi: ${i.receipts} masuk, ${i.receipts_skipped || 0} dilewati\n\n` +
              `🔗 Kwitansi yang di-restore otomatis dibuatkan reservasi mirror supaya muncul di Rekap Bulanan.`;
    alert(msg);
    // Refresh the relevant views so the admin sees the new data
    if (typeof loadReceipts === 'function') loadReceipts();
    if (typeof loadReservations === 'function') loadReservations();
  } catch (e) {
    alert('Gagal restore: ' + e.message);
  }
}

// ---------- SETTINGS ----------
async function renderSettings() {
  const _token73 = renderToken('settings');
  const s = await api('/api/admin/settings');
  // Render yang lebih baru sudah dimulai — jangan menimpa hasilnya.
  if (!isLatestRender('settings', _token73)) return;
  SETTINGS = s;
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <h1>⚙️ Pengaturan</h1>
      <button onclick="saveAllSettings()" class="btn btn-primary">💾 Simpan Semua</button>
    </div>
    <div class="settings-grid">
      <div class="setting-card">
        <h3>🌸 Informasi Bisnis</h3>
        <div class="form-group"><label>Nama Bisnis</label><input type="text" id="se_name" value="${esc(s.business_name||'')}"></div>
        <div class="form-group"><label>Tagline</label><input type="text" id="se_tagline" value="${esc(s.tagline||'')}"></div>
        <div class="form-group"><label>Alamat</label><textarea id="se_address" rows="2">${esc(s.address||'')}</textarea></div>
        <div class="form-row">
          <div class="form-group"><label>WhatsApp</label><input type="tel" id="se_phone" value="${esc(s.phone||'')}"></div>
          <div class="form-group"><label>Wilayah</label><input type="text" id="se_area" value="${esc(s.area||'')}"></div>
        </div>
        <div class="form-group"><label>Praktisi</label><input type="text" id="se_practitioner" value="${esc(s.practitioner||'')}"></div>
        <div class="form-group"><label>Instagram (opsional)</label><input type="text" id="se_ig" placeholder="@username" value="${esc(s.instagram||'')}"></div>
      </div>

      <div class="setting-card">
        <h3>🖼️ Logo & Hero</h3>
        <div style="margin-bottom:16px;">
          <strong>Logo</strong>
          <div class="upload-preview">${s.has_logo ? `<img src="${apiUrl('/api/logo')}?v=${Date.now()}">` : `<div class="placeholder">Belum ada logo</div>`}</div>
          <input type="file" id="se_logo_file" accept="image/*">
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button onclick="uploadAsset('logo')" class="btn-sm btn-approve">📤 Upload</button>
            ${s.has_logo ? '<button onclick="deleteAsset(\'logo\')" class="btn-sm btn-del">🗑️ Hapus</button>' : ''}
          </div>
        </div>
        <hr style="margin:14px 0;border:none;border-top:1px dashed var(--border);">
        <div>
          <strong>Hero Image (latar belakang beranda)</strong>
          <div class="upload-preview" style="height:120px;max-width:280px;">${s.has_hero ? `<img src="${apiUrl('/api/hero')}?v=${Date.now()}">` : `<div class="placeholder">Belum ada hero image</div>`}</div>
          <input type="file" id="se_hero_file" accept="image/*">
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button onclick="uploadAsset('hero')" class="btn-sm btn-approve">📤 Upload</button>
            ${s.has_hero ? '<button onclick="deleteAsset(\'hero\')" class="btn-sm btn-del">🗑️ Hapus</button>' : ''}
          </div>
        </div>
      </div>

      <div class="setting-card">
        <h3>📱 QRIS</h3>
        <div class="upload-preview">${s.has_qris ? `<img src="${apiUrl('/api/qris')}?v=${Date.now()}">` : `<div class="placeholder">Belum ada QRIS</div>`}</div>
        <input type="file" id="se_qris_file" accept="image/*">
        <div style="margin:8px 0;display:flex;gap:8px;">
          <button onclick="uploadAsset('qris')" class="btn-sm btn-approve">📤 Upload Gambar QRIS</button>
          ${s.has_qris ? '<button onclick="deleteAsset(\'qris\')" class="btn-sm btn-del">🗑️ Hapus</button>' : ''}
        </div>
        <div class="form-group" style="margin-top:14px;"><label>Link QRIS (opsional)</label><input type="url" id="se_qris_link" placeholder="https://qris.id/..." value="${esc(s.qris_link||'')}"></div>
      </div>

      <div class="setting-card">
        <h3>✍️ Tanda Tangan Bidan/Pemilik</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 10px;line-height:1.55;">
          Tanda tangan ini akan otomatis muncul di blok <strong>"Hormat kami,"</strong> pada setiap kwitansi yang dicetak dari sistem ini, sehingga bidan/pemilik tidak perlu tanda tangan ulang di setiap kwitansi. Simpan sekali, pakai selamanya.
        </p>
        <div id="ownerSigPreviewWrap" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:12px;background:var(--bg);border:1px dashed var(--border);border-radius:12px;">
          <div id="ownerSigPreviewBox" style="width:200px;min-height:80px;background:var(--card);border:1px solid var(--border);border-radius:10px;display:flex;align-items:center;justify-content:center;padding:8px;">
            ${s.has_owner_signature ? `<img id="ownerSigPreviewImg" style="max-height:80px;max-width:180px;display:block;" alt="Tanda tangan">` : '<span style="color:var(--text-soft);font-size:0.85rem;">Belum ada tanda tangan</span>'}
          </div>
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:700;margin-bottom:2px;">${s.has_owner_signature ? '✅ Tanda tangan tersimpan' : '⚠️ Belum ada tanda tangan'}</div>
            ${s.has_owner_signature ? `
              <small style="color:var(--text-soft);display:block;margin-bottom:6px;">
                📅 ${esc(s.owner_signature_at ? new Date(s.owner_signature_at).toLocaleString('id-ID', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—')}
                · 📥 ${esc(s.owner_signature_method || 'unknown')}
                ${s.owner_signature_via ? ' · 🔖 ' + esc(s.owner_signature_via) : ''}
              </small>
              <button onclick="deleteOwnerSignature()" class="btn-sm btn-del">🗑️ Hapus</button>
            ` : '<small style="color:var(--text-soft);display:block;">Pilih salah satu metode di bawah untuk menambahkan tanda tangan.</small>'}
          </div>
        </div>

        <!-- 3-tab mode picker -->
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
          <button type="button" id="ownerSigTabLangsung" onclick="switchOwnerSigTab('langsung')" class="btn-sm btn-pay">✏️ Tanda Tangan Langsung</button>
          <button type="button" id="ownerSigTabUpload" onclick="switchOwnerSigTab('upload')" class="btn-sm btn-view">📁 Upload Gambar</button>
          <button type="button" id="ownerSigTabScan" onclick="switchOwnerSigTab('scan')" class="btn-sm btn-view">📷 Scan / Barcode</button>
        </div>

        <!-- Mode: langsung -->
        <div id="ownerSigModeLangsung" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="font-size:0.92rem;">✏️ Gambar tanda tangan di area putih</strong>
            <button type="button" onclick="ownerSigClear()" class="btn-sm btn-view">🔄 Reset</button>
          </div>
          <div id="ownerSigPadWrap" style="background:#fdfafc;border:2px dashed var(--pink-200);border-radius:10px;overflow:hidden;">
            <canvas id="ownerSigPad" style="display:block;touch-action:none;width:100%;height:180px;"></canvas>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:8px;">
            <small style="color:var(--text-soft);">💡 Pakai mouse, touchpad, atau jari di HP/tablet</small>
            <button type="button" onclick="ownerSigSave('langsung')" class="btn btn-primary">💾 Simpan Tanda Tangan</button>
          </div>
        </div>

        <!-- Mode: upload -->
        <div id="ownerSigModeUpload" style="display:none;">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="file" id="ownerSigUploadFile" accept="image/png,image/jpeg,image/webp,image/gif" style="flex:1;min-width:200px;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
            <input type="text" id="ownerSigUploadVia" placeholder="Keterangan sumber (opsional)" maxlength="64" style="flex:1;min-width:180px;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
            <button type="button" onclick="uploadOwnerSignature()" class="btn btn-primary">📤 Upload</button>
          </div>
          <small style="color:var(--text-soft);display:block;margin-top:6px;">PNG / JPEG / WebP / GIF. Maksimal 1.5 MB. Tinggi disarankan 200-400px.</small>
        </div>

        <!-- Mode: scan -->
        <div id="ownerSigModeScan" style="display:none;">
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div>
              <label style="font-weight:600;font-size:0.88rem;display:block;margin-bottom:4px;">Metode input</label>
              <select id="ownerSigScanMethod" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
                <option value="barcode">📊 Barcode / QR — hasil decode QR yang menyisipkan gambar tanda tangan</option>
                <option value="ocr">📷 OCR — gambar hasil scan kamera HP / aplikasi OCR</option>
                <option value="langsung">✏️ Paste dari canvas (toDataURL)</option>
              </select>
            </div>
            <div>
              <label style="font-weight:600;font-size:0.88rem;display:block;margin-bottom:4px;">Sumber / aplikasi (untuk audit)</label>
              <input type="text" id="ownerSigScanVia" placeholder="mis: Google Lens, Adobe Scan, QR Scanner" maxlength="64" style="width:100%;padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
            </div>
            <div>
              <label style="font-weight:600;font-size:0.88rem;display:block;margin-bottom:4px;">Paste base64 atau data URL di sini</label>
              <textarea id="ownerSigScanB64" rows="4" placeholder='data:image/png;base64,iVBORw0KGgoAA... atau langsung base64 string tanpa prefix' style="width:100%;font-family:monospace;font-size:0.8rem;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical;"></textarea>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;">
              <button type="button" onclick="saveOwnerSignatureScan()" class="btn btn-primary">💾 Simpan dari Scan</button>
            </div>
            <small style="color:var(--text-soft);line-height:1.5;">
              💡 Cara cepat: di HP, buka foto tanda tangan → bagikan ke aplikasi QR Scanner / Google Lens → pilih "Salin base64" → paste di sini.
              Sistem akan validasi magic bytes PNG/JPEG/WebP dan menolak payload non-image.
            </small>
          </div>
        </div>
      </div>

      <div class="setting-card">
        <h3>🏦 Rekening Bank</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:10px;">Tampil saat pelanggan pilih Transfer.</p>
        <div id="bankList"></div>
        <button onclick="addBank()" class="add-btn" style="width:auto;">+ Tambah Rekening</button>
      </div>

      <div class="setting-card">
        <h3>🕒 Jam Operasional</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:10px;">Akan tampil di beranda. Centang "Tutup" untuk hari libur.</p>
        <div id="hoursList"></div>
      </div>

      <div class="setting-card">
        <h3>🚫 Hari Libur (Blackout Dates)</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:10px;">Tanggal yang ditandai "Libur" tidak bisa dipilih pasien saat reservasi. Cocok untuk hari besar, cuti bersama, atau hari admin off.</p>
        <div id="blackoutList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="date" id="blackoutNewDate" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;">
          <input type="text" id="blackoutNewNote" placeholder="Keterangan (opsional, mis: Libur Natal)" maxlength="80" style="padding:8px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;flex:1;min-width:160px;">
          <button type="button" onclick="addBlackoutDate()" class="btn-sm btn-approve">+ Tambah Tanggal</button>
        </div>
        <small style="display:block;margin-top:8px;color:var(--text-soft);font-size:0.78rem;">
          💡 Tekan <strong>💾 Simpan Semua</strong> di atas setelah selesai mengubah daftar.
        </small>
      </div>

      <div class="setting-card">
        <h3>🌐 Media Sosial</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:10px;">Akan tampil di beranda & footer. Kosongkan URL untuk menyembunyikan.</p>
        <div id="socialList"></div>
        <button onclick="addSocial()" class="add-btn" style="width:auto;">+ Tambah Medsos</button>
      </div>

      <div class="setting-card">
        <h3>🔔 Notifikasi & Pengingat</h3>
        <div class="form-group">
          <label>Ingatkan reservasi (jam sebelum jadwal)</label>
          <input type="number" id="se_reminder" min="0.5" max="72" step="0.5" value="${s.reminder_hours_before ?? 2}">
          <small style="color:var(--text-soft);">Misal 2 = muncul 2 jam sebelum jadwal. Bisa pakai desimal (0.5 = 30 menit).</small>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px;cursor:pointer;">
          <input type="checkbox" id="se_notif_sound" ${s.notif_sound !== false ? 'checked' : ''}>
          <span>🔊 Bunyikan suara saat ada reservasi baru</span>
        </label>
        <div style="margin-top:14px;padding:12px;background:var(--pink-50);border-radius:10px;font-size:0.85rem;color:var(--text-soft);">
          ℹ️ Notifikasi muncul realtime di pojok kanan atas dashboard. Klik menu <strong>🔔 Notifikasi</strong> untuk lihat semua.
        </div>
      </div>

      <div class="setting-card">
        <h3>📍 Google Maps & Ulasan</h3>
        <div class="form-group">
          <label>Link Google Maps</label>
          <input type="url" id="se_gmaps_url" placeholder="https://maps.app.goo.gl/..." value="${esc(s.gmaps_url||'')}">
          <small style="color:var(--text-soft);">Tombol "Lihat di Google Maps" di beranda.</small>
        </div>
        <div class="form-group">
          <label>Embed Google Maps (opsional)</label>
          <textarea id="se_gmaps_embed" rows="2" placeholder='<iframe src="https://www.google.com/maps/embed?pb=..." ...></iframe>'>${esc(s.gmaps_embed||'')}</textarea>
        </div>
      </div>

      <div class="setting-card" style="grid-column:1 / -1;">
        <h3>💬 Testimoni Pelanggan</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:10px;">Diambil/disalin dari ulasan Google Maps. Akan tampil di beranda.</p>
        <div id="testiList"></div>
        <button onclick="addTesti()" class="add-btn" style="width:auto;">+ Tambah Testimoni</button>
      </div>

      <div class="setting-card">
        <h3>🔐 Profil Admin</h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin-bottom:14px;">
          Ubah email dan password login admin. Password saat ini wajib diisi untuk konfirmasi.
        </p>
        <div id="profileAlert"></div>
        <div class="form-group">
          <label>Nama (tidak bisa diubah dari sini)</label>
          <input type="text" value="${esc(USER?.name||'')}" disabled>
        </div>
        <div class="form-group">
          <label>Email Login</label>
          <input type="email" id="pf_email" value="${esc(USER?.email||'')}" placeholder="admin@adzkiya.id" autocomplete="email">
        </div>
        <div class="form-group">
          <label>Password Saat Ini <span style="color:var(--danger)">*</span></label>
          <input type="password" id="pf_current" placeholder="Wajib diisi untuk konfirmasi" autocomplete="current-password">
        </div>
        <div class="form-group">
          <label>Password Baru <small style="color:var(--text-soft);font-weight:500;">— kosongkan jika tidak ingin ganti</small></label>
          <input type="password" id="pf_new" placeholder="Minimal 8 karakter" autocomplete="new-password" minlength="8">
        </div>
        <div class="form-group">
          <label>Konfirmasi Password Baru</label>
          <input type="password" id="pf_confirm" placeholder="Ketik ulang password baru" autocomplete="new-password">
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;">
          <button type="button" onclick="saveProfile()" class="btn btn-primary" id="pfSaveBtn">💾 Simpan Profil</button>
          <button type="button" onclick="logout()" class="btn-sm btn-del" style="padding:10px 20px;">🚪 Logout</button>
        </div>
      </div>

      <div class="setting-card" id="storageStatusCard">
        <h3 style="display:flex;align-items:center;gap:8px;">🗄️ Status Penyimpanan Data</h3>
        <div id="storageStatusBody" style="font-size:0.88rem;color:var(--text-soft);line-height:1.6;">Memuat status…</div>
        <div class="btn-row" style="margin-top:12px;">
          <button type="button" class="btn-sm btn-outline" onclick="loadStorageStatus(true)" style="padding:10px 16px;">🔄 Cek Ulang</button>
          <button type="button" class="btn-sm" id="storageSyncBtn" onclick="syncStorageToDb()" style="display:none;background:#b45309;color:white;border:none;font-weight:700;padding:10px 16px;">⬆️ Sinkronkan Data Darurat ke Database</button>
        </div>
      </div>

      ${USER && !USER.password_changed_at ? `
      <div class="setting-card" style="border:2px solid #b91c1c;background:#fff5f5;">
        <h3 style="color:#b91c1c;">🔐 Ganti Password &mdash; Belum Pernah Diganti</h3>
        <p style="color:#7f1d1d;font-size:0.88rem;margin:8px 0 0;line-height:1.6;">
          Akun ini masih memakai password bawaan. Password adalah satu-satunya kunci ke data pasien
          (nama, alamat, nomor WhatsApp, bukti transfer), jadi wajib diganti sebelum dipakai serius.
          Isi kolom <strong>Password Baru</strong> di bawah, lalu simpan — semua sesi lama otomatis dicabut.
        </p>
      </div>` : ''}

      <div class="setting-card" style="border:2px solid #7c3aed;background:linear-gradient(135deg,#f5f3ff 0%,#fff5f8 100%);">
        <h3 style="display:flex;align-items:center;gap:8px;">🤖 AI Booking Assistant <span id="aiAssistantStatusBadge" style="font-size:0.76rem;padding:3px 10px;border-radius:999px;background:#e5e7eb;color:#374151;font-weight:700;letter-spacing:0.5px;">CHECKING…</span></h3>
        <p style="color:var(--text-soft);font-size:0.85rem;margin:6px 0 14px;line-height:1.5;">
          Otomatiskan customer service 24/7. AI menjawab chat di beranda + WA Business, bantu pilih layanan, dan arahkan ke admin untuk konfirmasi final.
          <br><strong>Dual AI:</strong> Google Gemini (free tier) sebagai primary, OpenRouter sebagai fallback otomatis.
        </p>

        <!-- Toggle on/off -->
        <label style="display:flex;align-items:center;gap:10px;padding:12px;background:white;border:1.5px solid var(--border);border-radius:10px;margin-bottom:12px;cursor:pointer;">
          <input type="checkbox" id="aiAssistantEnabled" style="width:20px;height:20px;cursor:pointer;accent-color:#7c3aed;">
          <div style="flex:1;">
            <div style="font-weight:700;color:var(--text);">Aktifkan AI Assistant</div>
            <div style="font-size:0.78rem;color:var(--text-soft);">Chat widget di beranda + auto-reply WA Business akan aktif</div>
          </div>
        </label>

        <!-- API keys section -->
        <div style="background:white;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px;">
          <div style="font-weight:700;color:var(--text);font-size:0.92rem;margin-bottom:10px;">🔑 API Keys</div>

          <div class="form-group">
            <label>🤖 Google Gemini API Key <span style="color:var(--text-soft);font-weight:500;">(primary, gratis di ai.google.dev)</span></label>
            <input type="password" id="aiGeminiKey" placeholder="AIzaSy..." style="font-family:monospace;font-size:0.85rem;">
            <small style="color:var(--text-soft);display:block;margin-top:4px;">Dapatkan gratis di <a href="https://aistudio.google.com/apikey" target="_blank" style="color:#7c3aed;">aistudio.google.com/apikey</a></small>
          </div>

          <div class="form-group" style="margin-top:10px;">
            <label>🌐 OpenRouter API Key <span style="color:var(--text-soft);font-weight:500;">(fallback)</span></label>
            <input type="password" id="aiOpenRouterKey" placeholder="sk-or-v1-..." style="font-family:monospace;font-size:0.85rem;">
            <small style="color:var(--text-soft);display:block;margin-top:4px;">Dapatkan di <a href="https://openrouter.ai/keys" target="_blank" style="color:#7c3aed;">openrouter.ai/keys</a> (opsional, sebagai backup)</small>
          </div>
        </div>

        <!-- WA Business API section -->
        <details style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;">
          <summary style="cursor:pointer;font-weight:700;color:var(--text);font-size:0.92rem;">📱 WhatsApp Business API (opsional, untuk auto-reply WA)</summary>
          <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border);font-size:0.84rem;color:var(--text-soft);line-height:1.6;">
            <p style="margin:0 0 8px;">Setup WA Business API di <a href="https://developers.facebook.com/apps" target="_blank" style="color:#7c3aed;">Meta for Developers</a>. Butuh app + WhatsApp product + phone number terverifikasi. Setelah dapat credentials:</p>
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>Phone Number ID</label>
            <input type="text" id="aiWaPhoneId" placeholder="123456789012345" style="font-family:monospace;font-size:0.85rem;">
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>Access Token (permanent)</label>
            <input type="password" id="aiWaAccessToken" placeholder="EAAxxxxxxx..." style="font-family:monospace;font-size:0.85rem;">
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>Webhook Verify Token <span style="color:var(--text-soft);font-weight:500;">(string apa saja, untuk verifikasi webhook)</span></label>
            <input type="text" id="aiWaVerifyToken" placeholder="adzkiya-verify-2026" style="font-family:monospace;font-size:0.85rem;">
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>🔐 App Secret <span style="color:var(--text-soft);font-weight:500;">(opsional tapi disarankan — untuk verifikasi signature webhook)</span></label>
            <input type="password" id="aiWaAppSecret" placeholder="kunci dari Meta → Settings → Basic → App Secret" style="font-family:monospace;font-size:0.85rem;">
            <small style="color:var(--text-soft);display:block;margin-top:4px;">Kalau diisi, semua request webhook wajib membawa header <code>X-Hub-Signature-256</code> yang valid — mencegah orang lain memalsukan pesan masuk.</small>
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label>📍 Webhook URL <span style="color:var(--text-soft);font-weight:500;">(paste di Meta Dashboard)</span></label>
            <div style="display:flex;gap:6px;">
              <input type="text" id="aiWebhookUrl" readonly style="font-family:monospace;font-size:0.82rem;background:#f9fafb;flex:1;">
              <button type="button" onclick="(function(){const el=document.getElementById('aiWebhookUrl');el.select();document.execCommand('copy');})()" style="padding:6px 12px;background:#7c3aed;color:white;border:none;border-radius:8px;cursor:pointer;font-size:0.82rem;">Copy</button>
            </div>
          </div>
        </details>

        <!-- Opsi kecepatan -->
        <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:white;border:1.5px solid var(--border);border-radius:10px;margin:12px 0;cursor:pointer;">
          <input type="checkbox" id="aiPreferFast" style="width:20px;height:20px;margin-top:2px;cursor:pointer;accent-color:#7c3aed;">
          <div style="flex:1;">
            <div style="font-weight:700;color:var(--text);">⚡ Utamakan jawaban cepat</div>
            <div style="font-size:0.82rem;line-height:1.5;color:var(--text-soft);">
              Memilih model versi cepat (varian <em>lite</em>) + jawaban dibatasi ~2 kalimat,
              sehingga balasan biasanya muncul jauh lebih cepat. Matikan bila ingin jawaban lebih panjang.
            </div>
          </div>
        </label>

        <label style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:white;border:1.5px solid var(--border);border-radius:10px;margin:0 0 12px;cursor:pointer;">
          <input type="checkbox" id="aiOpenRouterFreeOnly" style="width:20px;height:20px;margin-top:2px;cursor:pointer;accent-color:#7c3aed;">
          <div style="flex:1;">
            <div style="font-weight:700;color:var(--text);">💸 OpenRouter: hanya pakai model gratis</div>
            <div style="font-size:0.82rem;line-height:1.5;color:var(--text-soft);">
              Dipakai otomatis bila akun OpenRouter belum punya kredit (error 402). Model gratis
              (<code>:free</code>) tidak berbiaya tetapi batas lajunya lebih ketat — Gemini tetap
              menjadi penyedia utama.
            </div>
          </div>
        </label>

        <!-- Custom persona prompt -->
        <div class="form-group" style="margin-top:8px;">
          <label>🎭 Custom Persona Prompt <span style="color:var(--text-soft);font-weight:500;">(opsional, override default instructions)</span></label>
          <textarea id="aiBasePrompt" rows="3" placeholder="Kosongkan untuk pakai default. Tambahkan instruksi khusus misal: 'Selalu sebut diskon 10% untuk paket 4 sesi'"></textarea>
        </div>

        <!-- Save button -->
        <!-- .btn-row: label panjang diberi lebar minimum sendiri dan di
             layar HP tiap tombol jadi selebar kartu, jadi teks tidak
             pernah lagi meluber keluar bentuk tombol. -->
        <div class="btn-row" style="margin-top:12px;">
          <button type="button" id="aiAssistantSaveBtn" class="btn btn-primary" style="background:#7c3aed;">💾 Simpan Konfigurasi AI</button>
          <button type="button" id="aiAssistantAiTestBtn" class="btn btn-outline">🤖 Tes AI</button>
          <button type="button" id="aiAssistantDiagBtn" class="btn btn-outline">🔍 Tes Koneksi WhatsApp</button>
          <button type="button" id="aiAssistantLogsBtn" class="btn btn-outline">📋 Log Percakapan</button>
        </div>
        <div id="aiReadinessBox" style="margin-top:10px;"></div>
        <div id="aiModelInfo" style="margin-top:10px;font-size:0.82rem;color:var(--text-soft);"></div>
        <div id="aiAssistantDiagnostics" style="margin-top:12px;"></div>
        <div id="aiAssistantFeedback" style="margin-top:10px;font-size:0.84rem;"></div>
      </div>

      <div class="setting-card">
        <h3>ℹ️ Tentang Sistem</h3>
        <div style="font-size:0.92rem;color:var(--text-soft);line-height:1.8;">
          <div>🌸 <strong>Adzkiya Mom Baby Care</strong> v2.0 Enterprise</div>
          <div>✓ Reservasi multi-layanan & multi-jadwal</div>
          <div>✓ Dashboard grafik realtime</div>
          <div>✓ Kwitansi profesional dengan logo</div>
          <div>✓ Rekap Excel formatted</div>
          <div>✓ Backup/Restore JSON</div>
          <div>✓ Dark mode</div>
        </div>
      </div>
    </div>
  `;
  renderBanks();
  renderHours();
  renderSocials();
  renderTestimonials();
  renderBlackouts();
  // Status penyimpanan (file vs database) — penting supaya admin tahu
  // kalau data sedang hanya tersimpan sementara.
  loadStorageStatus();
  // Tanda tangan pemilik: preview diisi belakangan lewat endpoint ber-token
  // (gambar tidak lagi bisa diambil publik tanpa izin).
  (async () => {
    const img = document.getElementById('ownerSigPreviewImg');
    if (!img) return;
    const dataUrl = await fetchOwnerSignatureDataUrl(true);
    if (dataUrl) img.src = dataUrl;
  })();
  // Phase 3: AI Assistant settings
  wireAIAssistantSettings();
}

// ---------- STATUS PENYIMPANAN ----------
// Menjawab satu pertanyaan penting: "data saya sedang disimpan di mana?"
// Kalau server tidak bisa menghubungi database, semua tulisan hanya masuk
// file container dan akan hilang pada deploy berikutnya — admin harus
// melihat itu di depan mata, bukan menemukannya setelah data lenyap.
async function loadStorageStatus(showAlert) {
  const _token666 = renderToken('storage-status');
  const body = document.getElementById('storageStatusBody');
  const syncBtn = document.getElementById('storageSyncBtn');
  if (!body) return;
  try {
    const st = await api('/api/admin/storage/status');
  // Render yang lebih baru sudah dimulai — jangan menimpa hasilnya.
  if (!isLatestRender('storage-status', _token666)) return;
    const live = st.live_counts || {};
    const db = st.db_counts;
    let html = '';
    if (st.active_storage === 'file' && st.configured_storage === 'file') {
      if (st.file_storage_persistent) {
        html += '<div style="padding:10px 12px;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;color:#065f46;font-weight:600;">'
          + '✅ Mode file <strong>persisten</strong> (' + esc(st.file_storage_source || '') + ')<br>'
          + '<span style="font-weight:500;">Data tetap ada antar deploy. Untuk pengelolaan & pemulihan yang lebih baik, sambungkan database lewat formulir di bawah.</span></div>';
      } else {
        html += '<div style="padding:10px 12px;background:#fff7ed;border:1.5px solid #fdba74;border-radius:10px;color:#7c2d12;font-weight:600;">'
          + '📁 Mode file (DATABASE_URL belum diset)<br>'
          + '<span style="font-weight:500;">File penyimpanan <strong>tidak persisten</strong> — data ikut ter-reset saat deploy. Sambungkan database lewat formulir di bawah, atau pasang Railway Volume lalu set <code>DATA_FILE</code> ke dalam volume itu.</span></div>';
      }
    } else if (st.db_connected) {
      html += '<div style="padding:10px 12px;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;color:#065f46;font-weight:600;">'
        + '✅ Tersimpan di <strong>' + esc(st.configured_storage) + '</strong> — database terhubung.<br>'
        + '<span style="font-weight:500;">Reservasi ' + (live.reservations || 0) + ' · Kwitansi ' + (live.receipts || 0) + ' · Pengeluaran ' + (live.expenses || 0) + '</span></div>';
    } else {
      html += '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;color:#7f1d1d;">'
        + '<strong>⚠️ Database belum terhubung — data masuk ke file' + (st.file_storage_persistent ? ' (persisten)' : ' SEMENTARA') + '</strong><br>'
        + '<span>Database <strong>' + esc(st.configured_storage) + '</strong> tidak bisa dihubungi'
        + (st.db_error ? ': <code>' + esc(st.db_error) + '</code>' : '') + '</span><br>'
        + '<span>Data darurat sekarang: ' + (live.reservations || 0) + ' reservasi · ' + (live.receipts || 0) + ' kwitansi · ' + (live.expenses || 0) + ' pengeluaran.</span></div>';
      // Langkah pemulihan berbeda tergantung apakah database sudah bisa
      // dihubungi lagi ATAU admin harus memperbaiki DATABASE_URL.
      if (st.db_reachable) {
        html += '<div style="padding:10px 12px;background:#fffbeb;border:1.5px solid #fcd34d;border-radius:10px;color:#78350f;margin-top:8px;">'
          + '✅ Database sekarang <strong>sudah bisa dihubungi</strong> — klik <strong>⬆️ Sinkronkan Data Darurat ke Database</strong> di bawah '
          + 'untuk memindahkan data di atas TANPA redeploy. (Jangan redeploy dulu: redeploy akan menghapus file darurat ini.)</div>';
      } else {
        html += '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #b91c1c;border-radius:10px;color:#7f1d1d;margin-top:8px;">'
          + '<strong>🔴 LANGKAH WAJIB SEBELUM MEMPERBAIKI DATABASE_URL:</strong>'
          + '<ol style="margin:8px 0 0 18px;padding:0;line-height:1.7;">'
          + '<li>Buka menu <strong>Backup &amp; Restore</strong> → isi passphrase → <strong>🔐 Download Backup Terenkripsi</strong>.</li>'
          + '<li>Baru perbaiki <code>DATABASE_URL</code> di Railway lalu redeploy.</li>'
          + '<li>Setelah server hidup dengan database, buka <strong>Backup &amp; Restore</strong> → pilih file tadi → <strong>Restore</strong> (mode <em>Append</em>) → masukkan passphrase.</li>'
          + '</ol>'
          + '<div style="margin-top:6px;">Memperbaiki env var di Railway memicu redeploy, dan redeploy <strong>menghapus</strong> file darurat ini — data akan hilang permanen kalau belum dibackup.</div></div>';
      }
    }
    if (typeof db !== 'undefined' && db) {
      html += '<div style="margin-top:8px;font-size:0.84rem;">Isi database saat ini: '
        + (db.reservations || 0) + ' reservasi · ' + (db.receipts || 0) + ' kwitansi · ' + (db.expenses || 0) + ' pengeluaran. '
        + 'Sinkronisasi akan <strong>menggabungkan</strong> (bukan menimpa) data darurat ke atas data ini.</div>';
    }
    if (st.can_sync) {
      html += '<div style="margin-top:8px;font-size:0.84rem;">Pengaturan aplikasi (nama usaha, rekening, TTD, kunci AI) <strong>tidak</strong> ikut disalin — supaya konfigurasi yang sudah benar di database tidak tertimpa. Isi ulang lewat panel ini setelah pindah.</div>';
    }
    if (st.db_connected && st.db_info) {
      const di = st.db_info;
      html += '<div style="margin-top:8px;font-size:0.84rem;">Terhubung ke database <strong>' + esc(di.database || '?') +
        '</strong> sebagai <strong>' + esc(di.user || '?') + '</strong>' + (di.version ? ' · ' + esc(di.version) : '') + '</div>';
    }
    if (st.using_runtime_connection) {
      html += '<div style="padding:10px 12px;background:#fffbeb;border:1.5px solid #fcd34d;border-radius:10px;color:#78350f;margin-top:8px;">'
        + '⚠️ Koneksi database ini <strong>hanya berlaku untuk sesi server yang sedang berjalan</strong> (diisi dari panel ini). '
        + 'Salin connection string yang sama ke <strong>Railway → Variables → DATABASE_URL</strong>, lalu deploy, '
        + 'supaya otomatis dipakai lagi setiap restart.</div>';
    }

    // Formulir perbaikan koneksi: admin bisa MENGUJI kredensial baru di sini
    // sebelum menyentuh Railway — menghindari deploy berulang hanya untuk
    // mencoba-coba.
    html += `
      <details style="margin-top:12px;" ${st.db_connected ? '' : 'open'}>
        <summary style="cursor:pointer;font-weight:700;color:var(--text);">🔧 Perbaiki / Ganti Koneksi Database</summary>
        <div style="margin-top:10px;font-size:0.85rem;line-height:1.6;">
          <div>1. Tempel connection string dari penyedia database (Neon/Railway/Supabase) → klik <strong>Tes Koneksi</strong>.</div>
          <div>2. Kalau berhasil, klik <strong>Gunakan Sekarang</strong> — data darurat otomatis digabungkan ke database.</div>
          <div>3. Terakhir, salin connection string yang sama ke <strong>Railway → Variables → DATABASE_URL</strong> lalu deploy, agar permanen.</div>
        </div>
        <div class="form-group" style="margin-top:10px;">
          <label style="font-size:0.85rem;font-weight:600;">Connection string</label>
          <input type="password" id="stConnUrl" placeholder="postgresql://user:password@host:5432/dbname" style="font-family:monospace;font-size:0.84rem;" autocomplete="off">
          <div style="font-size:0.82rem;line-height:1.55;color:var(--text-soft);margin-top:6px;">Nilai ini hanya dipakai untuk tes &amp; sesi server ini — tidak disimpan ke file log.</div>
        </div>
        <details style="margin-top:8px;">
          <summary style="cursor:pointer;font-size:0.82rem;color:var(--text-soft);">Password memuat karakter @ : / ? # → pakai kolom terpisah</summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:8px;">
            <input type="text" id="stHost" placeholder="host (ep-xxx.neon.tech)">
            <input type="text" id="stPort" placeholder="port (5432)">
            <input type="text" id="stDb" placeholder="database (neondb)">
            <input type="text" id="stUser" placeholder="user (neondb_owner)">
            <input type="password" id="stPass" placeholder="password" autocomplete="off">
            <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;"><input type="checkbox" id="stSsl" checked> SSL</label>
          </div>
        </details>
        <div class="btn-row" style="margin-top:10px;">
          <button type="button" class="btn-sm" onclick="testStorageConnection()" style="background:#0f766e;color:white;border:none;font-weight:700;padding:10px 16px;">🔌 Tes Koneksi</button>
          <button type="button" class="btn-sm" id="stApplyBtn" onclick="applyStorageConnection()" style="display:none;background:#7c3aed;color:white;border:none;font-weight:700;padding:10px 16px;">✅ Gunakan Sekarang</button>
        </div>
        <div id="stConnResult" style="margin-top:10px;"></div>
      </details>`;

    body.innerHTML = html;
    if (syncBtn) syncBtn.style.display = st.can_sync ? 'inline-block' : 'none';
    if (showAlert) alert('Status penyimpanan diperbarui.');
  } catch (e) {
    body.innerHTML = '<div class="alert alert-error">Gagal memuat status: ' + esc(e.message) + '</div>';
  }
}

// Kumpulkan nilai dari formulir koneksi (URL penuh, atau kolom terpisah).
function collectStorageConnectionInput() {
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const url = val('stConnUrl');
  if (url) return { url };
  return {
    host: val('stHost'),
    port: val('stPort'),
    database: val('stDb'),
    user: val('stUser'),
    password: (document.getElementById('stPass') || {}).value || '',
    ssl: !!(document.getElementById('stSsl') || {}).checked,
    kind: /^mysql/i.test(val('stHost')) ? 'mysql' : 'postgres'
  };
}

async function testStorageConnection() {
  const input = collectStorageConnectionInput();
  const box = document.getElementById('stConnResult');
  const applyBtn = document.getElementById('stApplyBtn');
  if (!input.url && !input.host) {
    return alert('Tempel connection string dulu, atau isi minimal kolom host + user.');
  }
  box.innerHTML = '<div style="padding:10px;background:var(--bg);border-radius:10px;">⏳ Menguji koneksi…</div>';
  if (applyBtn) applyBtn.style.display = 'none';
  try {
    const r = await fetch(apiUrl('/api/admin/storage/test-connection'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(input)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      box.innerHTML = '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;color:#7f1d1d;">'
        + '<strong>❌ Gagal terhubung</strong><br>' + esc(data.error || 'Tidak diketahui')
        + (data.hint ? '<br><span style="font-size:0.84rem;">💡 ' + esc(data.hint) + '</span>' : '') + '</div>';
      return;
    }
    const counts = data.db_counts;
    box.innerHTML = '<div style="padding:10px 12px;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;color:#065f46;">'
      + '<strong>✅ Koneksi berhasil</strong> (' + (data.latency_ms || 0) + ' ms)<br>'
      + '<span style="font-size:0.84rem;">Jenis: ' + esc(data.kind) + (data.server_version ? ' · server ' + esc(data.server_version) : '') + '</span><br>'
      + '<span style="font-size:0.84rem;">' + (data.has_app_state_table
          ? 'Tabel data aplikasi ditemukan' + (counts ? ': ' + (counts.reservations || 0) + ' reservasi · ' + (counts.receipts || 0) + ' kwitansi.' : '.')
          : 'Tabel data aplikasi belum ada — akan dibuat otomatis saat digunakan.') + '</span></div>';
    if (applyBtn) applyBtn.style.display = 'inline-block';
  } catch (e) {
    box.innerHTML = '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;color:#7f1d1d;">Gagal menguji: ' + esc(e.message) + '</div>';
  }
}

async function applyStorageConnection() {
  const input = collectStorageConnectionInput();
  if (!confirm('Gunakan koneksi database ini sekarang?\n\nData yang sekarang ada di file akan DIGABUNGKAN ke database (tidak menimpa data lama).')) return;
  const box = document.getElementById('stConnResult');
  box.innerHTML = '<div style="padding:10px;background:var(--bg);border-radius:10px;">⏳ Memindahkan penyimpanan ke database…</div>';
  try {
    const res = await api('/api/admin/storage/apply-connection', {
      method: 'POST',
      body: JSON.stringify({ ...input, confirm: 'PAKAI' })
    });
    const r = res.report || {};
    const successHtml = '<div style="padding:10px 12px;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;color:#065f46;">'
      + '<strong>✅ Server sekarang memakai database</strong><br>'
      + '<span style="font-size:0.84rem;">Ditambahkan: ' + (r.reservations_added || 0) + ' reservasi, ' + (r.receipts_added || 0) + ' kwitansi, '
      + (r.expenses_added || 0) + ' pengeluaran' + (r.admins_added ? ', ' + r.admins_added + ' akun admin' : '') + '.</span><br>'
      + '<span style="font-size:0.84rem;font-weight:700;">Langkah terakhir: salin connection string yang sama ke Railway → Variables → DATABASE_URL, lalu deploy.</span></div>';
    alert('Berhasil. Jangan lupa menyalin connection string ke Railway → Variables → DATABASE_URL agar permanen.');
    // Muat ulang status DULU (kartu & kotak hasil ikut dibuat ulang), baru
    // tulis pesannya ke kotak yang masih ada.
    await loadStorageStatus();
    const freshBox = document.getElementById('stConnResult');
    if (freshBox) freshBox.innerHTML = successHtml;
  } catch (e) {
    box.innerHTML = '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;color:#7f1d1d;">'
      + 'Gagal memakai koneksi: ' + esc(e.message) + '</div>';
  }
}

async function syncStorageToDb() {
  const typed = prompt(
    'Pindahkan data darurat (yang sekarang hanya ada di file sementara) ke database.\n\n' +
    'Data akan DIGABUNG dengan isi database (tidak menimpa). Pengaturan aplikasi tidak ikut disalin.\n\n' +
    'Ketik SINKRON untuk melanjutkan:'
  );
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'SINKRON') return alert('Dibatalkan — kata konfirmasi tidak cocok.');
  const btn = document.getElementById('storageSyncBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Menyinkronkan…'; }
  try {
    const res = await api('/api/admin/storage/sync-to-db', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'SINKRON' })
    });
    const r = res.report || {};
    alert('✅ ' + (res.message || 'Sinkronisasi selesai.') + '\n\n' +
      'Ditambahkan: ' + (r.reservations_added || 0) + ' reservasi, ' + (r.receipts_added || 0) + ' kwitansi, ' +
      (r.expenses_added || 0) + ' pengeluaran, ' + (r.broadcasts_added || 0) + ' broadcast' +
      (r.admins_added ? ', ' + r.admins_added + ' akun admin' : '') + '.\n' +
      'Total di database: ' + ((r.db_after && r.db_after.reservations) || 0) + ' reservasi · ' +
      ((r.db_after && r.db_after.receipts) || 0) + ' kwitansi.');
    // Muat ulang tampilan supaya angka yang tampil sesuai isi database.
    await loadCache();
    renderSettings();
  } catch (e) {
    alert('Gagal sinkron: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆️ Sinkronkan Data Darurat ke Database'; }
  }
}

// Wire up AI Assistant settings panel — called after renderSettings.
// Reads/writes SETTINGS.ai_* fields directly (they come back from /api/admin/settings
// with has_* flags; secret keys are read from a separate /api/admin/ai/config endpoint).
async function wireAIAssistantSettings() {
  const enabledEl = document.getElementById('aiAssistantEnabled');
  const geminiEl = document.getElementById('aiGeminiKey');
  const openrouterEl = document.getElementById('aiOpenRouterKey');
  const phoneIdEl = document.getElementById('aiWaPhoneId');
  const accessTokenEl = document.getElementById('aiWaAccessToken');
  const verifyTokenEl = document.getElementById('aiWaVerifyToken');
  const appSecretEl = document.getElementById('aiWaAppSecret');
  const preferFastEl = document.getElementById('aiPreferFast');
  const orFreeEl = document.getElementById('aiOpenRouterFreeOnly');
  const diagBtn = document.getElementById('aiAssistantDiagBtn');
  const aiTestBtn = document.getElementById('aiAssistantAiTestBtn');
  const diagBox = document.getElementById('aiAssistantDiagnostics');
  const basePromptEl = document.getElementById('aiBasePrompt');
  const webhookUrlInput = document.getElementById('aiWebhookUrl');
  const saveBtn = document.getElementById('aiAssistantSaveBtn');
  const logsBtn = document.getElementById('aiAssistantLogsBtn');
  const feedback = document.getElementById('aiAssistantFeedback');
  const statusBadge = document.getElementById('aiAssistantStatusBadge');
  if (!enabledEl) return;

  // Show AI status (without leaking keys)
  try {
    const cfg = await api('/api/admin/ai/config');
    if (cfg.enabled) {
      statusBadge.textContent = '🟢 ACTIVE';
      statusBadge.style.background = '#4ade80';
      statusBadge.style.color = '#064e3b';
    } else {
      statusBadge.textContent = '⚪ OFF';
      statusBadge.style.background = '#e5e7eb';
      statusBadge.style.color = '#374151';
    }
    enabledEl.checked = !!cfg.enabled;
    verifyTokenEl.value = cfg.wa_verify_token || '';
    basePromptEl.value = cfg.base_prompt || '';
    // For API keys: show "****" if set, otherwise empty
    geminiEl.placeholder = cfg.has_gemini ? '•••••••• (set, kosongkan untuk tetap)' : 'AIzaSy...';
    openrouterEl.placeholder = cfg.has_openrouter ? '•••••••• (set, kosongkan untuk tetap)' : 'sk-or-v1-...';
    phoneIdEl.placeholder = cfg.has_wa_phone_id ? '•••••••• (set)' : '123456789012345';
    accessTokenEl.placeholder = cfg.has_wa_token ? '•••••••• (set)' : 'EAAxxxxxxx...';
    if (appSecretEl) appSecretEl.placeholder = cfg.has_app_secret ? '•••••••• (set, kosongkan untuk tetap)' : 'App Secret dari Meta';
    // Pengaturan kecepatan (default aktif) + model yang sedang dipakai.
    if (preferFastEl) preferFastEl.checked = cfg.prefer_fast_model !== false;
    if (orFreeEl) orFreeEl.checked = cfg.openrouter_free_only === true;
    if (cfg.gemini_model || cfg.openrouter_model) {
      const info = document.getElementById('aiModelInfo');
      if (info) info.textContent = 'Model aktif: ' + [cfg.gemini_model, cfg.openrouter_model].filter(Boolean).join(' · ');
    }
    // Kotak kesiapan: langsung menjawab "kenapa bot cuma bilang gangguan?"
    const rbox = document.getElementById('aiReadinessBox');
    if (rbox) {
      const rd = cfg.readiness || {};
      let html = '';
      if (rd.ready) {
        html = '<div style="padding:10px 12px;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;color:#065f46;font-size:0.86rem;font-weight:600;">'
          + '✅ AI siap dipakai lewat ' + esc([cfg.has_gemini ? 'Google Gemini' : null, cfg.has_openrouter ? 'OpenRouter' : null].filter(Boolean).join(' + ')) + '.'
          + (cfg.gemini_model || cfg.openrouter_model ? '<br><span style="font-weight:500;">Model: ' + esc([cfg.gemini_model, cfg.openrouter_model].filter(Boolean).join(' · ')) + '</span>' : '')
          + '</div>';
      } else {
        html = '<div style="padding:10px 12px;background:#fff7ed;border:1.5px solid #fdba74;border-radius:10px;color:#7c2d12;font-size:0.86rem;">'
          + '<strong>⚠️ AI belum siap: ' + esc(rd.message || 'belum dikonfigurasi') + '</strong>'
          + '<br><span style="font-weight:500;">Selama ini pengunjung akan diarahkan ke WhatsApp admin.</span></div>';
      }
      // Status OpenRouter: sehat / tanpa kredit (mode gratis) / kunci ditolak.
      if (cfg.has_openrouter) {
        if (cfg.openrouter_health === 'bad_key') {
          html += '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;color:#7f1d1d;margin-top:8px;font-size:0.84rem;">'
            + '<strong>❌ Kunci OpenRouter ditolak</strong> — buat kunci baru di openrouter.ai/keys lalu tempel ulang di kolom OpenRouter.</div>';
        } else if (cfg.openrouter_free_only || cfg.openrouter_health === 'no_credits') {
          html += '<div style="padding:10px 12px;background:#eff6ff;border:1.5px solid #93c5fd;border-radius:10px;color:#1e3a8a;margin-top:8px;font-size:0.84rem;line-height:1.55;">'
            + '💸 <strong>OpenRouter mode model gratis.</strong> Akun OpenRouter belum pernah membeli kredit, jadi semua model berbayar ditolak (402). '
            + 'Sistem otomatis memakai model <code>:free</code> yang tidak berbiaya sebagai cadangan Gemini.'
            + (cfg.openrouter_free_models_cached ? ' Terdeteksi <strong>' + cfg.openrouter_free_models_cached + '</strong> model gratis.' : '')
            + '<br>Ingin model terbaik? Tambah kredit di <a href="https://openrouter.ai/credits" target="_blank" rel="noopener">openrouter.ai/credits</a>, lalu matikan centang "hanya pakai model gratis".</div>';
        } else {
          html += '<div style="padding:10px 12px;background:#ecfdf5;border:1.5px solid #6ee7b7;border-radius:10px;color:#065f46;margin-top:8px;font-size:0.84rem;">'
            + '✅ OpenRouter siap sebagai cadangan Gemini.</div>';
        }
      }
      if (cfg.last_error) {
        const kapan = cfg.last_error_at ? new Date(cfg.last_error_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        html += '<div style="padding:10px 12px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;color:#7f1d1d;margin-top:8px;font-size:0.84rem;line-height:1.55;">'
          + '<strong>❌ Kegagalan terakhir' + (kapan ? ' (' + esc(kapan) + ')' : '') + ':</strong><br>'
          + '<code style="font-size:0.8rem;">' + esc(cfg.last_error) + '</code>'
          + '<div style="margin-top:6px;font-weight:500;">Klik <strong>🤖 Tes AI</strong> untuk menguji ulang setelah memperbaiki kunci/kuota.</div></div>';
      }
      rbox.innerHTML = html;
    }
    // URL webhook diambil dari SERVER (absolut, berdasarkan host yang
    // melayani request). Menebak dari window.location berbahaya: kalau
    // panel dibuka dari cermin GitHub Pages, admin akan menyalin URL
    // GitHub ke Meta dan auto-reply tidak pernah jalan.
    webhookUrlInput.value = cfg.webhook_url || (apiUrl('/api/webhook/whatsapp'));
  } catch (e) {
    console.error('AI config fetch failed:', e);
  }

  // PENTING: pakai .onclick (bukan addEventListener) karena fungsi ini
  // dipanggil ulang setelah setiap penyimpanan (untuk refresh badge &
  // placeholder). Dengan addEventListener, listener menumpuk — sekali
  // klik tombol Simpan berikutnya akan mengirim 2x/3x/… PUT request,
  // dan tombol Log membuka modal berkali-kali.
  saveBtn.onclick = async () => {
    feedback.textContent = '⏳ Menyimpan...';
    feedback.style.color = 'var(--text-soft)';
    try {
      const body = {
        ai_assistant_enabled: enabledEl.checked,
        ai_assistant_verify_token: verifyTokenEl.value.trim(),
        ai_assistant_base_prompt: basePromptEl.value.trim(),
        ai_prefer_fast_model: preferFastEl ? preferFastEl.checked : true,
        ai_openrouter_free_only: orFreeEl ? orFreeEl.checked : false
      };
      // Only update keys if admin typed something new
      if (geminiEl.value.trim()) body.ai_gemini_api_key = geminiEl.value.trim();
      if (openrouterEl.value.trim()) body.ai_openrouter_api_key = openrouterEl.value.trim();
      if (phoneIdEl.value.trim()) body.ai_assistant_phone_id = phoneIdEl.value.trim();
      if (accessTokenEl.value.trim()) body.ai_assistant_access_token = accessTokenEl.value.trim();
      if (appSecretEl && appSecretEl.value.trim()) body.ai_assistant_app_secret = appSecretEl.value.trim();
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
      // Clear key fields after save so admin sees placeholder-only next time
      geminiEl.value = '';
      openrouterEl.value = '';
      phoneIdEl.value = '';
      accessTokenEl.value = '';
      if (appSecretEl) appSecretEl.value = '';
      feedback.textContent = '✅ Tersimpan! AI Assistant ' + (enabledEl.checked ? 'aktif' : 'nonaktif') + '.';
      feedback.style.color = 'var(--success, #1e8957)';
      // Re-fetch to update badge + placeholders
      setTimeout(() => wireAIAssistantSettings(), 200);
    } catch (e) {
      feedback.textContent = '❌ Gagal menyimpan: ' + e.message;
      feedback.style.color = '#c43050';
    }
  };

  if (aiTestBtn) aiTestBtn.onclick = async () => {
    aiTestBtn.disabled = true;
    const original = aiTestBtn.textContent;
    aiTestBtn.textContent = '⏳ Menguji AI…';
    diagBox.innerHTML = '<div style="padding:10px;background:var(--bg);border-radius:10px;">⏳ Mengirim satu pesan uji ke provider AI…</div>';
    try {
      const r = await api('/api/admin/ai/test', { method: 'POST', body: '{}' });
      const baris = (nama, d) => {
        const label = nama === 'gemini' ? 'Google Gemini' : 'OpenRouter';
        if (!d) return '';
        if (d.ok) {
          return '<div style="padding:8px 10px;border-radius:8px;background:#ecfdf5;color:#065f46;margin-bottom:6px;font-size:0.85rem;line-height:1.5;">'
            + '✅ <strong>' + label + '</strong> — berhasil (' + (d.latency_ms || 0) + ' ms)<br>'
            + '<span style="opacity:0.85;">Model: <code>' + esc(d.model || '-') + '</code>'
            + (d.mode ? ' · ' + esc(d.mode) : '') + '</span>'
            + (d.sample ? '<br><span style="opacity:0.85;">Balasan uji: ' + esc(d.sample) + '</span>' : '')
            + '</div>';
        }
        return '<div style="padding:8px 10px;border-radius:8px;background:#fef2f2;color:#7f1d1d;margin-bottom:6px;font-size:0.85rem;line-height:1.5;">'
          + '❌ <strong>' + label + '</strong> — gagal<br>'
          + '<span style="font-size:0.82rem;">' + esc(d.error || 'tidak diketahui') + '</span>'
          + (d.hint ? '<br><span style="font-size:0.82rem;opacity:0.9;">💡 ' + esc(d.hint) + '</span>' : '')
          + '</div>';
      };
      diagBox.innerHTML = '<div style="padding:12px;border:1.5px solid var(--border);border-radius:12px;background:var(--card);">'
        + '<div style="font-weight:700;margin-bottom:8px;">🤖 Hasil Tes AI</div>'
        + baris('gemini', r.results && r.results.gemini)
        + baris('openrouter', r.results && r.results.openrouter)
        + '<div style="font-size:0.82rem;color:var(--text-soft);margin-top:6px;line-height:1.6;">'
        + (r.results && r.results.gemini && r.results.gemini.ok
            ? 'Waktu balasan Gemini: <strong>' + (r.results.gemini.latency_ms || 0) + ' ms</strong>.<br>'
            : '')
        + (r.ok
            ? 'AI siap dipakai lewat: ' + esc((r.working_providers || []).join(', ')) + '.'
            : 'Belum ada provider yang berhasil. Perbaiki pesan galat di atas, lalu uji lagi. Pesan galat ditampilkan apa adanya dari penyedia.')
        + '<br>Status aktif/nonaktif: <strong>' + (r.enabled ? 'aktif' : 'NONAKTIF — centang "Aktifkan AI Assistant" lalu simpan') + '</strong>.'
        + (r.saved_models && (r.saved_models.gemini || r.saved_models.openrouter)
            ? '<br>Model tersimpan: ' + esc([r.saved_models.gemini, r.saved_models.openrouter].filter(Boolean).join(', ')) + '.'
            : '')
        + '</div></div>';
    } catch (e) {
      diagBox.innerHTML = '<div class="alert alert-error">Gagal menguji AI: ' + esc(e.message) + '</div>';
    } finally {
      aiTestBtn.disabled = false;
      aiTestBtn.textContent = original;
    }
  };

  if (diagBtn) diagBtn.onclick = async () => {
    diagBtn.disabled = true;
    const original = diagBtn.textContent;
    diagBtn.textContent = '⏳ Menguji…';
    diagBox.innerHTML = '';
    try {
      const d = await api('/api/admin/ai/diagnostics');
      const rows = (d.checklist || []).map((c) => `
        <div style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;background:${c.ok ? '#ecfdf5' : '#fff7ed'};margin-bottom:6px;">
          <span style="flex-shrink:0;">${c.ok ? '✅' : '⚠️'}</span>
          <span style="font-size:0.84rem;line-height:1.5;${c.ok ? 'color:#065f46;' : 'color:#7c2d12;'}">
            <strong>${esc(c.label)}</strong><br><span style="opacity:0.85;">${esc(c.hint || '')}</span>
          </span>
        </div>`).join('');
      const graphLine = d.graph && d.graph.checked
        ? `<div style="font-size:0.82rem;margin-top:6px;color:${d.graph.ok ? '#065f46' : '#b91c1c'};">
             ${d.graph.ok
               ? '📱 Terhubung ke nomor <strong>' + esc(d.graph.display_phone_number || '?') + '</strong>' + (d.graph.verified_name ? ' (' + esc(d.graph.verified_name) + ')' : '')
               : '❌ Meta menolak kredensial: <code>' + esc(d.graph.error || 'tidak diketahui') + '</code>'}
           </div>`
        : '';
      diagBox.innerHTML = `
        <div style="padding:12px;border:1.5px solid var(--border);border-radius:12px;background:var(--card);">
          <div style="font-weight:700;margin-bottom:8px;">🔍 Hasil Tes Koneksi WhatsApp</div>
          ${rows}
          ${graphLine}
          <div style="font-size:0.8rem;color:var(--text-soft);margin-top:8px;line-height:1.5;">
            📍 URL webhook untuk Meta: <code style="word-break:break-all;">${esc(d.webhook_url || '')}</code><br>
            🔐 Signature webhook: ${d.signature_enforced ? 'aktif (App Secret terisi)' : 'belum aktif — isi App Secret supaya pesan palsu ditolak'}
          </div>
        </div>`;
    } catch (e) {
      diagBox.innerHTML = '<div class="alert alert-error">Gagal menguji koneksi: ' + esc(e.message) + '</div>';
    } finally {
      diagBtn.disabled = false;
      diagBtn.textContent = original;
    }
  };

  logsBtn.onclick = async () => {
    try {
      const logs = await api('/api/admin/ai/conversations?limit=50');
      if (!logs.length) {
        alert('Belum ada percakapan AI yang tercatat.');
        return;
      }
      const text = logs.map((l, i) => {
        const when = new Date(l.ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const sender = l.sender_name || l.from_phone || l.session_id || 'anon';
        const provider = l.provider ? ' [' + l.provider + (l.model ? '/' + l.model : '') + (l.latency_ms ? ' ' + l.latency_ms + 'ms' : '') + ']' : '';
        return `${i + 1}. [${when}] ${l.channel.toUpperCase()} ${sender}${provider}
   👤 ${l.user.slice(0, 200)}
   🤖 ${l.assistant.slice(0, 200)}
`;
      }).join('\n---\n');
      openModal(`
        <h3>📋 Log Percakapan AI (50 terbaru)</h3>
        <pre style="white-space:pre-wrap;font-size:0.8rem;background:var(--bg);padding:14px;border-radius:8px;max-height:60vh;overflow-y:auto;font-family:monospace;">${esc(text)}</pre>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn-sm btn-del" onclick="if(confirm('Hapus semua log percakapan?')){api('/api/admin/ai/conversations',{method:'DELETE'}).then(()=>{closeModal();alert('Log dihapus.')}).catch(e=>alert('Gagal: '+e.message));}">🗑️ Hapus Semua Log</button>
          <button class="btn-sm btn-view" onclick="closeModal()">Tutup</button>
        </div>
      `);
    } catch (e) {
      alert('Gagal load log: ' + e.message);
    }
  };
}

function renderHours() {
  const el = document.getElementById('hoursList');
  if (!el) return;
  SETTINGS.hours = SETTINGS.hours || [];
  el.innerHTML = '';
  SETTINGS.hours.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = `
      <div class="settings-row-day" style="font-weight:600;font-size:0.9rem;">${esc(h.day)}</div>
      <input type="time" class="settings-row-open" value="${esc(h.open||'08:00')}" ${h.closed ? 'disabled' : ''} oninput="SETTINGS.hours[${i}].open=this.value" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);">
      <input type="time" class="settings-row-close" value="${esc(h.close||'20:00')}" ${h.closed ? 'disabled' : ''} oninput="SETTINGS.hours[${i}].close=this.value" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);">
      <label class="settings-row-label" style="display:flex;gap:4px;align-items:center;font-size:0.82rem;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" ${h.closed ? 'checked' : ''} onchange="SETTINGS.hours[${i}].closed=this.checked;renderHours();"> Tutup
      </label>
    `;
    el.appendChild(row);
  });
}

// ===== BLACKOUT DATES (Hari Libur) =====
// Renders the "Hari Libur" list in Settings. Each entry has a date
// and an optional note ("Libur Natal", "Cuti bersama", dll).
// Sorted ascending by date so the admin sees the next upcoming
// tanggal libur first.
function renderBlackouts() {
  const el = document.getElementById('blackoutList');
  if (!el) return;
  SETTINGS.blackout_dates = SETTINGS.blackout_dates || [];
  SETTINGS.blackout_notes = SETTINGS.blackout_notes || {};
  el.innerHTML = '';
  if (SETTINGS.blackout_dates.length === 0) {
    el.innerHTML = '<p style="color:var(--text-soft);font-size:0.85rem;text-align:center;padding:14px;background:var(--bg);border-radius:8px;">Belum ada tanggal libur. Semua tanggal aktif untuk reservasi.</p>';
  } else {
    // Sort the dates so the next upcoming holiday is at the top.
    const today = localTodayStr();
    const sorted = SETTINGS.blackout_dates.slice().sort();
    sorted.forEach((date) => {
      const note = SETTINGS.blackout_notes[date] || '';
      const isPast = date < today;
      const row = document.createElement('div');
      row.style.cssText = `display:flex;gap:8px;align-items:center;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:10px;${isPast ? 'opacity:0.55;' : ''}`;
      const labelDate = new Date(date + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
      row.innerHTML = `
        <div style="font-size:1.4rem;flex-shrink:0;">🚫</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;color:var(--text);">${esc(labelDate)}</div>
          <input type="text" value="${esc(note)}" placeholder="Tambah keterangan..." maxlength="80"
            oninput="SETTINGS.blackout_notes['${date}']=this.value"
            style="margin-top:4px;width:100%;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font-family:inherit;font-size:0.82rem;">
        </div>
        <button type="button" onclick="removeBlackoutDate('${date}')" class="btn-sm btn-del" style="padding:6px 10px;flex-shrink:0;" title="Hapus dari daftar hitam">🗑️</button>
      `;
      el.appendChild(row);
    });
  }
}

function addBlackoutDate() {
  const dateEl = document.getElementById('blackoutNewDate');
  const noteEl = document.getElementById('blackoutNewNote');
  const date = (dateEl.value || '').trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    alert('Pilih tanggal yang valid (YYYY-MM-DD).');
    dateEl.focus();
    return;
  }
  SETTINGS.blackout_dates = SETTINGS.blackout_dates || [];
  SETTINGS.blackout_notes = SETTINGS.blackout_notes || {};
  if (SETTINGS.blackout_dates.includes(date)) {
    alert('Tanggal ini sudah ada di daftar hitam.');
    return;
  }
  SETTINGS.blackout_dates.push(date);
  const note = (noteEl.value || '').trim();
  if (note) SETTINGS.blackout_notes[date] = note;
  renderBlackouts();
  dateEl.value = '';
  noteEl.value = '';
  dateEl.focus();
}

function removeBlackoutDate(date) {
  SETTINGS.blackout_dates = (SETTINGS.blackout_dates || []).filter((d) => d !== date);
  if (SETTINGS.blackout_notes) delete SETTINGS.blackout_notes[date];
  renderBlackouts();
}

function renderTestimonials() {
  const el = document.getElementById('testiList');
  if (!el) return;
  SETTINGS.testimonials = SETTINGS.testimonials || [];
  el.innerHTML = '';
  SETTINGS.testimonials.forEach((t, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 80px 36px;gap:8px;margin-bottom:8px;align-items:start;';
    row.innerHTML = `
      <input type="text" placeholder="Nama" value="${esc(t.name||'')}" oninput="SETTINGS.testimonials[${i}].name=this.value" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
      <textarea placeholder="Isi testimoni" rows="2" oninput="SETTINGS.testimonials[${i}].text=this.value" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-family:inherit;resize:vertical;">${esc(t.text||'')}</textarea>
      <select onchange="SETTINGS.testimonials[${i}].rating=parseInt(this.value)" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
        ${[5,4,3,2,1].map(n => `<option value="${n}" ${t.rating===n?'selected':''}>${'★'.repeat(n)}</option>`).join('')}
      </select>
      <button class="rm-btn" onclick="SETTINGS.testimonials.splice(${i},1);renderTestimonials();" style="height:38px;background:#fde0e4;color:#c43050;border:none;border-radius:8px;cursor:pointer;">×</button>
    `;
    el.appendChild(row);
  });
}

function addTesti() {
  SETTINGS.testimonials = SETTINGS.testimonials || [];
  SETTINGS.testimonials.push({ name: '', text: '', rating: 5, source: 'Google Maps' });
  renderTestimonials();
}

function renderSocials() {
  const el = document.getElementById('socialList');
  if (!el) return;
  SETTINGS.socials = SETTINGS.socials || [];
  el.innerHTML = '';
  const platforms = ['Instagram','TikTok','Facebook','YouTube','Twitter/X','WhatsApp','Telegram','LinkedIn','Threads','Lainnya'];
  const icons = { 'Instagram':'📷','TikTok':'🎵','Facebook':'📘','YouTube':'▶️','Twitter/X':'🐦','WhatsApp':'💬','Telegram':'✈️','LinkedIn':'💼','Threads':'@','Lainnya':'🌐' };
  SETTINGS.socials.forEach((sc, i) => {
    const row = document.createElement('div');
    row.className = 'social-row';
    row.style.marginBottom = '8px';
    const hasIcon = !!sc.icon_b64;
    row.innerHTML = `
      <select class="social-platform" onchange="onSocialPlatformChange(${i}, this)">
        ${platforms.map(p => `<option value="${p}" data-icon="${icons[p]}" ${sc.platform===p?'selected':''}>${icons[p]} ${p}</option>`).join('')}
      </select>
      <div class="social-avatar" style="background:${hasIcon ? `url(data:${sc.icon_mime||'image/png'};base64,${sc.icon_b64}) center/cover` : 'var(--pink-100)'};">${hasIcon ? '' : esc(sc.icon || icons[sc.platform] || '🌐')}</div>
      <input class="social-url" type="url" placeholder="https://instagram.com/username" value="${esc(sc.url || '')}" oninput="SETTINGS.socials[${i}].url=this.value">
      <label class="btn-sm btn-approve social-upload">
        📷
        <input type="file" accept="image/*" onchange="uploadSocialIcon(${i}, this)" style="display:none;">
      </label>
      ${hasIcon ? `<button class="btn-sm btn-del social-delete" onclick="deleteSocialIcon(${i})">🗑️</button>` : `<span class="social-spacer"></span>`}
      <button class="rm-btn social-remove" onclick="SETTINGS.socials.splice(${i},1);renderSocials();">×</button>
    `;
    el.appendChild(row);
  });
}

function onSocialPlatformChange(i, sel) {
  const opt = sel.options[sel.selectedIndex];
  SETTINGS.socials[i].platform = sel.value;
  SETTINGS.socials[i].icon = opt.dataset.icon || '🌐';
  renderSocials();
}

function addSocial() {
  SETTINGS.socials = SETTINGS.socials || [];
  SETTINGS.socials.push({ platform: 'Instagram', icon: '📷', url: '' });
  renderSocials();
}

async function uploadSocialIcon(idx, fileInput) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  if (file.size > 500 * 1024) {
    alert('Ukuran foto profil maksimal 500 KB. Crop jadi kecil atau kompres dulu, lalu coba lagi.');
    fileInput.value = '';
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('idx', String(idx));
  try {
    const res = await fetch(apiUrl('/api/admin/socials/icon'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert('Gagal upload: ' + (data.error || res.statusText)); fileInput.value = ''; return; }
    // Update the local SETTINGS so the preview is correct without a refetch.
    if (SETTINGS.socials && SETTINGS.socials[idx]) {
      // Re-fetch settings to get the saved base64 (the server is the source of truth).
      SETTINGS = await api('/api/admin/settings');
    }
    renderSocials();
    fileInput.value = '';
  } catch (e) {
    alert('Error: ' + e.message);
    fileInput.value = '';
  }
}

async function deleteSocialIcon(idx) {
  if (!confirm('Hapus foto profil untuk media sosial ini?')) return;
  try {
    await api('/api/admin/socials/icon/' + idx, { method: 'DELETE' });
    SETTINGS = await api('/api/admin/settings');
    renderSocials();
  } catch (e) {
    alert('Gagal: ' + e.message);
  }
}

// ---------- NOTIFICATIONS (realtime polling) ----------
let NOTIF_LAST_ID = parseInt(localStorage.getItem('adm_notif_last_id') || '0') || 0;
let NOTIF_SEEN_REMINDERS = new Set(JSON.parse(localStorage.getItem('adm_notif_seen_rem') || '[]'));
let NOTIF_TIMER = null;
let NOTIF_LAST_DATA = { new: [], reminders: [] };

function startNotifPolling() {
  // First call: initialize last_id without firing toasts (so we don't spam on first login)
  api('/api/admin/notifications?since=999999999').then(d => {
    if (!NOTIF_LAST_ID) {
      NOTIF_LAST_ID = d.last_id || 0;
      localStorage.setItem('adm_notif_last_id', NOTIF_LAST_ID);
    }
    pollNotifications();
  }).catch(() => {});
  if (NOTIF_TIMER) clearInterval(NOTIF_TIMER);
  NOTIF_TIMER = setInterval(pollNotifications, 20000);
}

async function pollNotifications() {
  try {
    const d = await api('/api/admin/notifications?since=' + NOTIF_LAST_ID);
    NOTIF_LAST_DATA = d;
    if (d.new && d.new.length) {
      d.new.forEach(r => showToast({
        kind: 'new',
        icon: '🎉',
        title: `Reservasi baru #${r.id} — ${r.patient_name}`,
        desc: `${r.service_name || '-'} · ${r.reservation_date} ${r.reservation_time} · ${fmtRp(r.total)}`
      }));
      if (SETTINGS.notif_sound !== false) playBeep();
    }
    NOTIF_LAST_ID = d.last_id || NOTIF_LAST_ID;
    localStorage.setItem('adm_notif_last_id', NOTIF_LAST_ID);

    (d.reminders || []).forEach(r => {
      const key = `${r.id}|${r.date}|${r.time}`;
      if (NOTIF_SEEN_REMINDERS.has(key)) return;
      NOTIF_SEEN_REMINDERS.add(key);
      showToast({
        kind: 'reminder',
        icon: '⏰',
        title: `Pengingat: ${r.patient_name}`,
        desc: `${r.service_name || '-'} · ${r.date} ${r.time} · ${r.mins_left} menit lagi`
      });
      if (SETTINGS.notif_sound !== false) playBeep(true);
    });
    localStorage.setItem('adm_notif_seen_rem', JSON.stringify([...NOTIF_SEEN_REMINDERS].slice(-200)));
    updateNavBadge();

    if (CURRENT_PAGE === 'notifications') {
      const list = document.getElementById('notifPageList');
      if (list) list.innerHTML = renderNotifList(d);
    }
  } catch (e) {}
}

function updateNavBadge() {
  const b = document.getElementById('navNotifBadge');
  if (!b) return;
  const total = (NOTIF_LAST_DATA.reminders || []).length;
  if (total > 0) {
    b.textContent = total > 99 ? '99+' : String(total);
    b.style.display = 'flex';
  } else {
    b.style.display = 'none';
  }
}

function showToast({ kind, icon, title, desc, timeoutMs = 8000 }) {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  const div = document.createElement('div');
  div.className = 'toast toast-' + (kind || 'new');
  div.innerHTML = `
    <div class="ti">${icon || '🔔'}</div>
    <div class="tb">
      <div class="tt">${esc(title)}</div>
      <div class="td">${esc(desc)}</div>
    </div>
    <button class="tx" onclick="this.parentElement.remove()">×</button>
  `;
  root.appendChild(div);
  setTimeout(() => { try { div.remove(); } catch {} }, timeoutMs);
}

function playBeep(urgent) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.value = urgent ? 880 : 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.4);
    if (urgent) setTimeout(() => playBeep(false), 250);
  } catch (e) {}
}

async function renderNotifications() {
  const _tk_renderNotifications = renderToken('notifications');
  if (!isLatestRender('notifications', _tk_renderNotifications)) return;
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <div>
        <h1>🔔 Notifikasi & Pengingat</h1>
        <p style="color:var(--text-soft);">Reservasi baru & alarm sebelum jadwal pelaksanaan.</p>
      </div>
      <div style="display:flex;gap:8px;">
        <button onclick="pollNotifications()" class="btn btn-outline">🔄 Refresh</button>
        <button onclick="resetNotifSeen()" class="btn btn-outline" title="Tampilkan ulang pengingat yang sudah ditutup">↻ Reset Tanda</button>
      </div>
    </div>
    <div id="notifPageList">Memuat...</div>
  `;
  try {
    const d = await api('/api/admin/notifications?since=0&hours=' + (SETTINGS.reminder_hours_before || 2));
    NOTIF_LAST_DATA = d;
    document.getElementById('notifPageList').innerHTML = renderNotifList(d);
  } catch (e) {
    document.getElementById('notifPageList').innerHTML = `<div class="alert alert-error">${e.message}</div>`;
  }
}

function renderNotifList(d) {
  const newR = d.new || [];
  const rem = d.reminders || [];
  const waText = (name, date, time) => encodeURIComponent('Halo Bunda ' + name + ', mengingatkan jadwal layanan kami di ' + date + ' pukul ' + time + '. Terima kasih 🌸');
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;" id="notifInner">
    <div>
      <h3 style="margin-bottom:12px;">⏰ Pengingat (≤ ${d.reminder_hours || 2} jam)</h3>
      ${rem.length ? rem.map(r => `
        <div class="notif-card reminder">
          <div class="notif-icon">⏰</div>
          <div class="notif-body">
            <div class="notif-title">${esc(r.patient_name)} · ${esc(r.service_name || '-')}</div>
            <div class="notif-meta">📅 ${r.date} ${r.time} · 📞 ${esc(r.whatsapp)}</div>
            <div class="notif-meta"><span class="badge badge-${r.status}">${r.status}</span> <span class="badge badge-${r.payment_status}">${r.payment_status}</span></div>
            <div style="margin-top:8px;display:flex;gap:6px;">
              <a class="btn-sm btn-pay" href="https://wa.me/${(r.whatsapp||'').replace(/[^\d]/g,'').replace(/^0/,'62')}?text=${waText(r.patient_name, r.date, r.time)}" target="_blank" style="text-decoration:none;">💬 Ingatkan via WA</a>
            </div>
          </div>
          <div class="notif-time">${r.mins_left}m lagi</div>
        </div>`).join('') : '<p style="color:var(--text-soft);padding:14px;background:var(--card);border-radius:12px;text-align:center;">Tidak ada pengingat dalam window ini.</p>'}
    </div>
    <div>
      <h3 style="margin-bottom:12px;">🎉 Reservasi Terbaru</h3>
      ${newR.length ? newR.slice(0,20).map(r => `
        <div class="notif-card new">
          <div class="notif-icon">🎉</div>
          <div class="notif-body">
            <div class="notif-title">#${r.id} · ${esc(r.patient_name)}</div>
            <div class="notif-meta">${esc(r.service_name || '-')} · ${r.reservation_date} ${r.reservation_time}</div>
            <div class="notif-meta">💰 <strong>${fmtRp(r.total)}</strong> · <span class="badge badge-${r.status}">${r.status}</span></div>
          </div>
          <div class="notif-time">${fmtDateTime(r.created_at)}</div>
        </div>`).join('') : '<p style="color:var(--text-soft);padding:14px;background:var(--card);border-radius:12px;text-align:center;">Belum ada reservasi.</p>'}
    </div>
  </div>
  <style>@media(max-width:920px),(hover:none) and (pointer:coarse) and (max-width:1024px){#notifInner{grid-template-columns:1fr !important;}}</style>`;
}

function resetNotifSeen() {
  NOTIF_SEEN_REMINDERS = new Set();
  localStorage.removeItem('adm_notif_seen_rem');
  pollNotifications();
}

function renderBanks() {
  const el = document.getElementById('bankList');
  el.innerHTML = '';
  (SETTINGS.bank_accounts || []).forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'bank-row';
    row.innerHTML = `
      <input type="text" placeholder="Bank" value="${esc(b.bank||'')}" oninput="SETTINGS.bank_accounts[${i}].bank=this.value">
      <input type="text" placeholder="No. Rekening" value="${esc(b.number||'')}" oninput="SETTINGS.bank_accounts[${i}].number=this.value">
      <input type="text" placeholder="Atas Nama" value="${esc(b.name||'')}" oninput="SETTINGS.bank_accounts[${i}].name=this.value">
      <button class="rm-btn" onclick="SETTINGS.bank_accounts.splice(${i},1);renderBanks();" style="height:38px;background:#fde0e4;color:#c43050;border:none;border-radius:8px;cursor:pointer;">×</button>
    `;
    el.appendChild(row);
  });
}
function addBank() {
  SETTINGS.bank_accounts = SETTINGS.bank_accounts || [];
  SETTINGS.bank_accounts.push({ bank: '', number: '', name: '' });
  renderBanks();
}

async function uploadAsset(kind) {
  const inp = document.getElementById('se_' + kind + '_file');
  const file = inp.files[0];
  if (!file) return alert('Pilih file dulu');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  const res = await fetch(apiUrl('/api/admin/settings/upload'), {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd
  });
  if (!res.ok) { const e = await res.json().catch(()=>({})); alert('Error: ' + (e.error || res.statusText)); return; }
  alert('✅ ' + kind + ' diupload');
  renderSettings();
}

async function deleteAsset(kind) {
  if (!confirm('Hapus ' + kind + '?')) return;
  await api('/api/admin/settings/' + kind, { method: 'DELETE' });
  renderSettings();
}

async function saveAllSettings() {
  const body = {
    business_name: document.getElementById('se_name').value,
    tagline: document.getElementById('se_tagline').value,
    address: document.getElementById('se_address').value,
    phone: document.getElementById('se_phone').value,
    area: document.getElementById('se_area').value,
    practitioner: document.getElementById('se_practitioner').value,
    instagram: document.getElementById('se_ig').value,
    qris_link: document.getElementById('se_qris_link').value,
    gmaps_url: document.getElementById('se_gmaps_url')?.value || '',
    gmaps_embed: document.getElementById('se_gmaps_embed')?.value || '',
    hours: SETTINGS.hours || [],
    testimonials: (SETTINGS.testimonials || []).filter(t => t.name && t.text),
    socials: (SETTINGS.socials || []).filter(s => s && s.url),
    reminder_hours_before: parseFloat(document.getElementById('se_reminder')?.value) || 2,
    notif_sound: document.getElementById('se_notif_sound')?.checked !== false,
    bank_accounts: (SETTINGS.bank_accounts || []).filter(b => b.bank || b.number || b.name),
    // Hari Libur (blackout dates). Deduped + sorted on the server
    // too, but we filter client-side to be safe.
    blackout_dates: Array.from(new Set((SETTINGS.blackout_dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort(),
    blackout_notes: (SETTINGS.blackout_notes && typeof SETTINGS.blackout_notes === 'object') ? SETTINGS.blackout_notes : {}
  };
  await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
  alert('✅ Pengaturan disimpan');
  await loadCache();
}

// Save admin profile (email + password). Validates inputs client-side
// first so we get instant feedback; the server also re-validates and
// checks the current password before making any change.
async function saveProfile() {
  const alertBox = document.getElementById('profileAlert');
  const btn = document.getElementById('pfSaveBtn');
  if (alertBox) alertBox.innerHTML = '';

  const emailEl = document.getElementById('pf_email');
  const curEl = document.getElementById('pf_current');
  const newEl = document.getElementById('pf_new');
  const confEl = document.getElementById('pf_confirm');

  const email = (emailEl?.value || '').trim();
  const current_password = curEl?.value || '';
  const new_password = newEl?.value || '';
  const confirm = confEl?.value || '';

  if (!current_password) {
    alertBox.innerHTML = '<div class="alert alert-error">❌ Password saat ini wajib diisi untuk konfirmasi.</div>';
    curEl?.focus();
    return;
  }
  if (new_password && new_password.length < 10) {
    alertBox.innerHTML = '<div class="alert alert-error">❌ Password baru minimal 10 karakter (kunci utama data pasien).</div>';
    newEl?.focus();
    return;
  }
  if (new_password && new_password !== confirm) {
    alertBox.innerHTML = '<div class="alert alert-error">❌ Konfirmasi password baru tidak cocok.</div>';
    confEl?.focus();
    return;
  }
  const emailChanged = email && email.toLowerCase() !== (USER?.email || '').toLowerCase();
  const passwordChanged = !!new_password;
  if (!emailChanged && !passwordChanged) {
    alertBox.innerHTML = '<div class="alert alert-error">❌ Tidak ada perubahan. Edit email atau password baru dulu.</div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const body = { current_password };
    if (emailChanged) body.email = email;
    if (passwordChanged) body.new_password = new_password;
    const data = await api('/api/admin/profile', { method: 'PUT', body: JSON.stringify(body) });

    if (data.user) {
      USER = data.user;
      localStorage.setItem('adm_user', JSON.stringify(USER));
    }

    if (curEl) curEl.value = '';
    if (newEl) newEl.value = '';
    if (confEl) confEl.value = '';

    const lines = [];
    if (data.email_changed) lines.push('✅ Email diperbarui');
    if (data.password_changed) lines.push('✅ Password diperbarui');
    alertBox.innerHTML = '<div class="alert alert-success">' + lines.join('<br>') + '</div>';

    // Email / password berubah = semua sesi lama dicabut server (token
    // terbitan lama tidak berlaku lagi). Bersihkan token lokal dan minta
    // login ulang supaya user tidak menabrak error 401 beruntun.
    if (data.requires_relogin) {
      alert('Perubahan tersimpan.\n\nSemua sesi lama sudah dicabut demi keamanan — silakan login ulang dengan kredensial terbaru.');
      logout();
      return;
    }

    renderSettings();
  } catch (e) {
    alertBox.innerHTML = '<div class="alert alert-error">❌ ' + esc(e.message) + '</div>';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💾 Simpan Profil';
  }
}

// ---------- MODAL ----------
function openModal(html) {
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">${html}</div>
    </div>`;
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

// ===== OWNER SIGNATURE (Bidan / Pemilik) =====
// Saved-once signature that auto-embeds into every kwitansi's
// "Hormat kami," block. Three input modes accepted:
//
//   1. langsung   admin draws on a <canvas>; signature.save('langsung')
//   2. upload     admin picks an image file; uploadOwnerSignature()
//   3. scan       admin pastes base64 from QR decoder / OCR app;
//                  saveOwnerSignatureScan()
//
// All three end up calling POST /api/admin/settings/owner-signature
// (multipart) or POST /api/admin/settings/owner-signature/scan (JSON).
// The server re-checks magic bytes before saving so we never persist a
// non-image payload.
let _ownerSigTab = null;
function switchOwnerSigTab(tab) {
  _ownerSigTab = tab;
  // Toggle button styles + section visibility
  const tabs = {
    langsung: ['ownerSigTabLangsung', 'ownerSigModeLangsung'],
    upload:   ['ownerSigTabUpload',   'ownerSigModeUpload'],
    scan:     ['ownerSigTabScan',     'ownerSigModeScan']
  };
  Object.entries(tabs).forEach(([key, [btnId, modeId]]) => {
    const btn = document.getElementById(btnId);
    const mode = document.getElementById(modeId);
    if (btn) btn.className = key === tab ? 'btn-sm btn-pay' : 'btn-sm btn-view';
    if (mode) mode.style.display = key === tab ? '' : 'none';
  });
  if (tab === 'langsung') {
    // Initialize the canvas the first time the tab opens (it has a
    // CSS-driven size, so we need to defer until layout completes).
    requestAnimationFrame(() => attachOwnerSigPad('ownerSigPad', 'ownerSigPadWrap'));
  }
}

function attachOwnerSigPad(canvasId, wrapId) {
  const canvas = document.getElementById(canvasId);
  const wrap = document.getElementById(wrapId);
  if (!canvas || !wrap) return;
  // If already attached (event listeners + helpers exist), just resize.
  if (canvas._ownerSigAttached) {
    sizeOwnerSigCanvas();
    return;
  }
  function sizeOwnerSigCanvas() {
    const r = wrap.getBoundingClientRect();
    if (r.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = 180 * dpr;
    canvas.style.width = r.width + 'px';
    canvas.style.height = '180px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset any prior scale
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2a1822';
  }
  sizeOwnerSigCanvas();
  const ctx2d = canvas.getContext('2d');
  let drawing = false, last = null;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }
  function start(e) {
    e.preventDefault();
    drawing = true;
    last = pos(e);
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx2d.beginPath();
    ctx2d.moveTo(last.x, last.y);
    ctx2d.lineTo(p.x, p.y);
    ctx2d.stroke();
    last = p;
  }
  function end(e) {
    if (!drawing) return;
    if (e && e.preventDefault) e.preventDefault();
    drawing = false;
    last = null;
  }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
  canvas.addEventListener('touchcancel', end);
  // Helper methods for save/clear
  canvas._clearSig = () => {
    ctx2d.save();
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.restore();
  };
  canvas._isOwnerBlank = () => {
    const blank = document.createElement('canvas');
    blank.width = canvas.width;
    blank.height = canvas.height;
    return canvas.toDataURL() === blank.toDataURL();
  };
  canvas._getSigDataUrl = () => {
    if (canvas._isOwnerBlank()) return null;
    return canvas.toDataURL('image/png');
  };
  canvas._ownerSigAttached = true;
  // Re-size on window resize so the canvas matches its CSS box.
  window.addEventListener('resize', sizeOwnerSigCanvas);
}

function ownerSigClear() {
  const canvas = document.getElementById('ownerSigPad');
  if (canvas && canvas._clearSig) canvas._clearSig();
}

async function ownerSigSave(method) {
  const canvas = document.getElementById('ownerSigPad');
  if (!canvas) return alert('Tanda tangan pad belum siap.');
  const dataUrl = canvas._getSigDataUrl ? canvas._getSigDataUrl() : null;
  if (!dataUrl) return alert('Belum ada tanda tangan. Gambar dulu di area putih.');
  try {
    await saveOwnerSignatureScan({ b64: dataUrl, method, via: 'canvas pad' });
  } catch (e) {
    alert('Gagal menyimpan tanda tangan: ' + e.message);
  }
}

async function uploadOwnerSignature() {
  const fileEl = document.getElementById('ownerSigUploadFile');
  const viaEl = document.getElementById('ownerSigUploadVia');
  const file = fileEl?.files?.[0];
  if (!file) return alert('Pilih file gambar dulu.');
  if (file.size > 1.5 * 1024 * 1024) {
    return alert('Ukuran file maksimal 1.5 MB. Kompres dulu atau pilih file lain.');
  }
  if (!file.type.startsWith('image/')) {
    return alert('File harus gambar (PNG/JPEG/WebP/GIF).');
  }
  const fd = new FormData();
  fd.append('file', file);
  if (viaEl?.value) fd.append('via', viaEl.value.trim().slice(0, 64));
  try {
    const res = await fetch(apiUrl('/api/admin/settings/owner-signature'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    alert('✅ Tanda tangan diupload (' + data.bytes + ' bytes, ' + data.mime + ').');
    OWNER_SIG_CACHE = null; // gambar baru — buang cache lama
    await loadCache();
    renderSettings();
  } catch (e) {
    alert('Gagal upload: ' + e.message);
  }
}

async function saveOwnerSignatureScan(opts) {
  // opts = { b64, method, via }
  // If `opts` is not provided, read from the scan tab form.
  let b64, method, via;
  if (opts) {
    ({ b64, method, via } = opts);
  } else {
    b64 = document.getElementById('ownerSigScanB64')?.value?.trim();
    method = document.getElementById('ownerSigScanMethod')?.value || 'ocr';
    via = document.getElementById('ownerSigScanVia')?.value?.trim() || null;
  }
  if (!b64) return alert('Belum ada data base64. Paste gambar hasil scan/QR.');
  try {
    const res = await fetch(apiUrl('/api/admin/settings/owner-signature/scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ b64, method, via })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!opts) alert('✅ Tanda tangan dari ' + method + ' tersimpan (' + data.bytes + ' bytes, ' + data.mime + ').');
    OWNER_SIG_CACHE = null; // gambar baru — buang cache lama
    await loadCache();
    renderSettings();
  } catch (e) {
    if (!opts) alert('Gagal simpan: ' + e.message);
    throw e;
  }
}

async function deleteOwnerSignature() {
  OWNER_SIG_CACHE = null; // buang cache supaya tidak memakai gambar lama
  if (!confirm('Hapus tanda tangan bidan/pemilik? Kwitansi yang dicetak setelah ini tidak akan menampilkan tanda tangan sampai yang baru di-upload.')) return;
  try {
    await api('/api/admin/settings/owner-signature', { method: 'DELETE' });
    await loadCache();
    renderSettings();
  } catch (e) {
    alert('Gagal hapus: ' + e.message);
  }
}

// ===== KWITANSI PDF EXPORT (Direct download, no print dialog) =====
// Three paper sizes supported. Default = A5 portrait — the most
// common receipt size for Indonesian baby-spa / home-service
// businesses. The @page CSS rules in the inline print template
// (see printReceipt below) read this and bake the page size into
// the generated PDF so the user's printer doesn't have to be
// reconfigured.
//
// A4  : 210 × 297 mm — full letter size, for shops that use a
//       normal printer with cut-to-size receipt printer paper.
// A5  : 148 × 210 mm — half-letter, the default for kwitansi
//       bayi/spa in Indonesia. Fits roughly 60% of the screen.
// F4  : 215 × 330 mm — Folio (common in Indonesia for legal docs).
// Thermal-80mm : 80 × auto mm — narrow thermal receipt printer
//       (Epson TM-T82, etc.). Auto height = sum of content.
// Thermal-58mm : 58 × auto mm — narrower thermal printer.
//
// The "lock layout" promise: no matter which size admin picks, the
// content reflows to fit without text overlap. We achieve this by:
//   1. Wrapping the invoice in a fixed-WIDTH container sized to
//      match the chosen paper.
//   2. Using `font-size: clamp(min, ideal, max)` so text shrinks
//      proportionally when paper is narrow.
//   3. Using `flex-wrap: wrap` on the 2-column footer so Penerima /
//      Hormat kami stack vertically when there's no horizontal room.
//   4. Hiding non-essential UI (signature pad, etc.) in the PDF
//      output — only the clean receipt goes into the file.
// ===== KWITANSI PDF EXPORT (Direct download, no print dialog) =====
//
// Paper-size aware PDF generation. Each size embeds its own page
// dimensions so when the PDF is opened elsewhere + printed, the
// user doesn't have to manually configure the print dialog.
//
// A4  : 210 × 297 mm — full letter, for shops using normal printers
// A5  : 148 × 210 mm — kwitansi bayi/spa paling umum di Indonesia
// F4  : 215 × 330 mm — Folio (legal docs in Indonesia)
// Thermal-80mm : 80mm × auto — printer struk Epson TM-T82 dll
// Thermal-58mm : 58mm × auto — printer struk kecil
//
// Lock layout promise: content reflows to fit, never overflows,
// never overlaps. Implemented via:
//   - Wrap pinned to paper width with explicit padding (6mm)
//   - Inline <style> at top of wrap replicates .invoice CSS rules
//     so html2canvas renders correctly even though the global CSS
//     file isn't loaded for detached elements
//   - Per-paper-size font scale (Thermal: 9pt, A5: 10pt, A4/F4: 11pt)
//   - flex-wrap so 2-column footer stacks when paper is narrow
//   - word-break: break-word on long strings (nama panjang, alamat)
//
// Library strategy: jsPDF + html2canvas bundled together. We do
// NOT use html2pdf.js 0.10.x because its off-screen rendering +
// pagebreak options are buggy and silently produce blank PDFs.
const KW_PAPER_SIZES = {
  'A5':           { width: 148, height: 210, label: 'A5 (148×210mm) — kwitansi bayi/spa',     icon: '📄', fontPt: 10 },
  'A4':           { width: 210, height: 297, label: 'A4 (210×297mm) — full letter',         icon: '📃', fontPt: 11 },
  'F4':           { width: 215, height: 330, label: 'F4 (215×330mm) — Folio legal',         icon: '📋', fontPt: 11 },
  'Thermal-80mm': { width:  80, height:   0, label: 'Thermal 80mm (printer struk)',         icon: '🧾', fontPt:  9, autoHeight: true },
  'Thermal-58mm': { width:  58, height:   0, label: 'Thermal 58mm (printer struk kecil)',   icon: '🧾', fontPt:  8, autoHeight: true }
};

// Load jsPDF and html2canvas once. Both bundled together from a
// single CDN script. ~80KB gzipped combined. The library is loaded
// as a UMD module that exposes jsPDF as window.jspdf.
async function ensureJsPdfLoaded() {
  if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Gagal memuat jsPDF dari CDN. Cek koneksi internet.'));
    document.head.appendChild(s);
  });
  return window.jspdf.jsPDF;
}

async function ensureHtml2CanvasLoaded() {
  if (typeof window.html2canvas === 'function') return window.html2canvas;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Gagal memuat html2canvas dari CDN. Cek koneksi internet.'));
    document.head.appendChild(s);
  });
  return window.html2canvas;
}

// Build the full inline-style block that replicates the .invoice
// CSS from /css/style.css. We can't <link rel="stylesheet"> from
// the off-screen DOM because html2canvas only captures inline + style
// rules that are scoped to the element being rasterized.
//
// Note: this is a copy of the production CSS rules. If the global
// /css/style.css .invoice rules ever change, mirror the changes
// here. (Slight duplication for reliability.)
function buildInvoiceInlineCSS(fontPt) {
  return `
    .kw-pdf-wrap { font-family: 'Plus Jakarta Sans','Helvetica Neue',Arial,sans-serif; color: #2a1822; font-size: ${fontPt}pt; line-height: 1.45; }
    .kw-pdf-wrap, .kw-pdf-wrap * { box-sizing: border-box; }
    .kw-pdf-wrap .invoice { width: 100%; background: white; border: 1px solid #f0e0e5; border-radius: 8px; padding: 5mm; margin: 0; }
    .kw-pdf-wrap .invoice-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 4mm; padding-bottom: 3mm; border-bottom: 2px solid #ee5a8a; }
    .kw-pdf-wrap .invoice-brand { display: flex; gap: 3mm; align-items: center; flex: 1 1 60%; min-width: 0; }
    .kw-pdf-wrap .invoice-brand img { max-width: 20mm; max-height: 20mm; object-fit: contain; display: block; }
    .kw-pdf-wrap .invoice-brand h2 { font-size: 1.2em; margin: 0 0 1mm; font-weight: 800; color: #2a1822; }
    .kw-pdf-wrap .invoice-brand small { font-size: 0.85em; line-height: 1.4; color: #6a5a64; word-break: break-word; display: block; }
    .kw-pdf-wrap .invoice-meta { text-align: right; flex: 0 0 auto; min-width: 0; }
    .kw-pdf-wrap .invoice-meta strong { display: block; font-size: 0.95em; letter-spacing: 1px; color: #6a5a64; margin-bottom: 1mm; }
    .kw-pdf-wrap .invoice-meta-no { display: block; font-size: 1.05em; font-weight: 700; color: #2a1822; margin-bottom: 1mm; }
    .kw-pdf-wrap .invoice-meta small { font-size: 0.82em; color: #6a5a64; }
    .kw-pdf-wrap .invoice-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; margin: 4mm 0 3mm; }
    .kw-pdf-wrap .invoice-block { min-width: 0; }
    .kw-pdf-wrap .invoice-block h4 { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.5px; color: #8b6878; margin: 0 0 2mm; font-weight: 700; }
    .kw-pdf-wrap .invoice-block-body { font-size: 0.95em; line-height: 1.45; word-break: break-word; margin: 0; color: #2a1822; }
    .kw-pdf-wrap .invoice-table { width: 100%; border-collapse: collapse; margin: 3mm 0; font-size: 0.92em; table-layout: fixed; }
    .kw-pdf-wrap .invoice-table thead { background: #ee5a8a; color: white; }
    .kw-pdf-wrap .invoice-table th, .kw-pdf-wrap .invoice-table td { border-bottom: 1px solid #ffd6e2; padding: 2mm 2.5mm; text-align: left; word-break: break-word; vertical-align: top; }
    .kw-pdf-wrap .invoice-table th { font-weight: 700; }
    .kw-pdf-wrap .invoice-table th.num, .kw-pdf-wrap .invoice-table td.num { text-align: right; white-space: nowrap; }
    .kw-pdf-wrap .totals { margin: 3mm 0; }
    .kw-pdf-wrap .totals .row { display: flex; justify-content: space-between; padding: 1.5mm 0; font-size: 0.95em; border-bottom: 1px dashed #ffe0e8; }
    .kw-pdf-wrap .totals .row.grand { font-weight: 800; font-size: 1.15em; border-top: 2px solid #ee5a8a; border-bottom: none; padding-top: 2.5mm; margin-top: 2mm; color: #2a1822; }
    .kw-pdf-wrap .invoice-footer { margin-top: 4mm; padding-top: 3mm; border-top: 1px dashed #ffd6e2; }
    .kw-pdf-wrap .footer-row { display: flex; gap: 4mm; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; }
    .kw-pdf-wrap .footer-col { flex: 1 1 45%; min-width: 0; }
    .kw-pdf-wrap .footer-col.right { text-align: right; }
    .kw-pdf-wrap .footer-label { font-size: 0.85em; color: #6a5a64; margin-bottom: 1mm; }
    .kw-pdf-wrap .footer-name { border-top: 1px solid #2a1822; padding-top: 2mm; margin-top: 14mm; font-weight: 700; font-size: 1em; color: #2a1822; word-break: break-word; }
    .kw-pdf-wrap .footer-col.right .footer-name { margin-top: 14mm; }
    .kw-pdf-wrap #ownerSigEmbed { max-height: 16mm !important; max-width: 100% !important; height: auto !important; display: block; margin: 1mm 0 1mm auto !important; }
    .kw-pdf-wrap .thank-you { text-align: center; margin-top: 5mm; padding-top: 3mm; border-top: 1px dashed #ffd6e2; font-size: 0.88em; color: #6a5a64; }
    .kw-pdf-wrap .thank-you strong { color: #2a1822; display: block; margin-bottom: 1mm; font-size: 1.1em; }
    .kw-pdf-wrap .kwitansi-time-chip { display: inline-block; margin: 1mm 1mm 1mm 0; padding: 1mm 2mm; background: #fff5f8; border: 1px solid #ffd6e2; border-radius: 6px; font-size: 0.82em; font-weight: 700; color: #ee5a8a; word-break: keep-all; }
  `;
}

// Thermal-specific overrides: even tighter padding and smaller font
// so a 58mm paper still fits a meaningful receipt.
function buildThermalOverrides(fontPt) {
  return `
    .kw-pdf-wrap { font-size: ${fontPt}pt; }
    .kw-pdf-wrap .invoice { padding: 2mm; border-radius: 0; border: none; }
    .kw-pdf-wrap .invoice-header { padding-bottom: 2mm; gap: 2mm; border-bottom-width: 1px; }
    .kw-pdf-wrap .invoice-brand img { max-width: 12mm; max-height: 12mm; }
    .kw-pdf-wrap .invoice-brand h2 { font-size: 1.1em; }
    .kw-pdf-wrap .invoice-brand small { font-size: 0.78em; line-height: 1.3; }
    .kw-pdf-wrap .invoice-meta strong { font-size: 0.85em; }
    .kw-pdf-wrap .invoice-meta-no { font-size: 0.95em; }
    .kw-pdf-wrap .invoice-grid { grid-template-columns: 1fr; gap: 2mm; margin: 2mm 0; }
    .kw-pdf-wrap .invoice-block h4 { font-size: 0.72em; margin-bottom: 1mm; }
    .kw-pdf-wrap .invoice-block-body { font-size: 0.85em; line-height: 1.35; }
    .kw-pdf-wrap .invoice-table { font-size: 0.82em; margin: 2mm 0; }
    .kw-pdf-wrap .invoice-table th, .kw-pdf-wrap .invoice-table td { padding: 1mm 1.5mm; }
    .kw-pdf-wrap .totals .row { padding: 0.8mm 0; font-size: 0.85em; }
    .kw-pdf-wrap .totals .row.grand { font-size: 1em; }
    .kw-pdf-wrap .invoice-footer { margin-top: 2mm; padding-top: 2mm; }
    .kw-pdf-wrap .footer-row { flex-direction: column; gap: 3mm; }
    .kw-pdf-wrap .footer-col { flex: 1 1 100%; }
    .kw-pdf-wrap .footer-col.right { text-align: left; }
    .kw-pdf-wrap .footer-label { font-size: 0.78em; }
    .kw-pdf-wrap .footer-name { margin-top: 8mm; padding-top: 1mm; font-size: 0.92em; }
    .kw-pdf-wrap .thank-you { margin-top: 2mm; padding-top: 2mm; font-size: 0.78em; }
    .kw-pdf-wrap #ownerSigEmbed { max-height: 12mm !important; }
    .kw-pdf-wrap .kwitansi-time-chip { font-size: 0.78em; padding: 0.8mm 1.5mm; }
  `;
}

// Build the HTML body of the invoice (no <html>, no <head> —
// html2canvas only needs the inner DOM).
//
// CRITICAL LAYOUT NOTES — html2canvas 1.4.1 has well-known issues:
//   • `display: grid` is NOT supported (renders as block, children stack)
//   • `table-layout: fixed` causes column widths to collapse
//   • `display: flex` IS supported
//   • `width: N%` may not work as expected; use explicit pixel values
//   • Complex nested wrappers can confuse the layout calculator
//
// To work around this, the HTML uses ONLY flexbox and explicit pixel
// widths. We compute widths in pixels from the paper-size mm value at
// generation time so the layout is deterministic regardless of where
// the wrap is rendered.
function buildKwitansiHtmlForExport(r, ps, isThermal, opts) {
  const fontPt = ps.fontPt;
  const items = Array.isArray(r.items) ? r.items : (r.items || JSON.parse(r.items_json || '[]'));
  const biz = SETTINGS || {};
  const logoSrc = biz.has_logo ? apiUrl('/api/logo') : null;
  const times = (Array.isArray(r.service_times) && r.service_times.length)
    ? r.service_times
    : (r.service_time ? [r.service_time] : []);
  const timesHtml = times.length
    ? times.map((t) => `<span style="display:inline-block;margin:1px 2px 1px 0;padding:1px 4px;background:#fff5f8;border:1px solid #ffd6e2;border-radius:4px;font-size:${Math.round(fontPt * 0.82)}pt;font-weight:700;color:#ee5a8a;">⏰ ${esc(t)} WIB</span>`).join(' ')
    : '<span style="color:#6a5a64;">—</span>';
  const sessionsLabel = times.length > 1 ? ` <strong style="color:#ee5a8a;">${times.length} sesi</strong>` : '';

  // Per-size layout values (all in pixels for html2canvas reliability).
  // Layout widths assume a 96 DPI baseline: 1mm ≈ 3.78px.
  // For thermal receipts we use the wrap width; for standard sizes
  // (A4/A5/F4) we size both columns equally.
  // The total wrap inner width is ~360px for A5, ~510px for A4, etc.
  const totalWidthPx = ps ? Math.round(ps.width * 3.78) : 400;
  const padPx = isThermal ? 8 : 18;
  const innerWidthPx = totalWidthPx - (padPx * 2);
  const halfColPx = Math.floor(innerWidthPx / 2) - 4;  // -4 for gap

  // Header: 2 columns (brand left, meta right). Use flex with
  // explicit widths so html2canvas doesn't have to compute flex-basis.
  const headerHeightPx = isThermal ? 60 : 88;
  const brandColWidthPx = Math.floor(innerWidthPx * 0.62);
  const metaColWidthPx = innerWidthPx - brandColWidthPx;

  // Grid (Kepada + Tanggal & Waktu): 2 columns side by side. We use
  // flex instead of grid since grid doesn't render in html2canvas 1.4.1.
  const blockColPx = halfColPx;

  // Table columns (Layanan / Qty / Harga / Subtotal).
  const tblNamePx = Math.max(innerWidthPx - 60 - 70 - 80, 80);
  const tblQtyPx = 60;
  const tblPricePx = 70;
  const tblSubPx = 80;

  // Padding per cell (uniform, scaled by font size).
  const cellPadY = Math.round(fontPt * 0.6) + 'px';
  const cellPadX = Math.round(fontPt * 0.8) + 'px';

  // Fitur: sembunyikan blok tanda tangan (Penerima & Hormat kami).
  const hideSignatures = !!(opts && opts.hideSignatures);
  const signatureBlock = hideSignatures ? '' : `
        <div style="display:flex;flex-direction:row;gap:12px;justify-content:space-between;align-items:flex-start;">
          <div style="width:${blockColPx}px;flex-shrink:0;">
            <div style="font-size:${Math.round(fontPt * 0.78)}pt;color:#6a5a64;margin-bottom:2px;">Penerima,</div>
            <div style="margin-top:${isThermal ? 32 : 56}px;padding-top:4px;border-top:1px solid #2a1822;font-weight:bold;font-size:${fontPt}pt;color:#2a1822;word-wrap:break-word;">${esc(r.patient_name || '-')}</div>
            <div style="font-size:${Math.round(fontPt * 0.74)}pt;color:#6a5a64;margin-top:3px;">Nama jelas &amp; tanda tangan</div>
          </div>
          <div style="width:${blockColPx}px;flex-shrink:0;text-align:right;">
            <div style="font-size:${Math.round(fontPt * 0.78)}pt;color:#6a5a64;margin-bottom:2px;">Hormat kami,</div>
            <img id="ownerSigEmbed" alt="" crossorigin="anonymous" style="display:none;max-height:${isThermal ? 36 : 56}px;max-width:100%;height:auto;margin:4px auto 4px 0;" />
            <div id="ownerSigUnderline" style="margin-top:${isThermal ? 32 : 56}px;padding-top:4px;border-top:1px solid #2a1822;font-weight:bold;font-size:${fontPt}pt;color:#2a1822;word-wrap:break-word;"><em>${esc(biz.practitioner || 'Tasya Hanifah Pramesti, A.Md. Keb., CBME')}</em></div>
            <div style="font-size:${Math.round(fontPt * 0.74)}pt;color:#6a5a64;margin-top:3px;">${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</div>
          </div>
        </div>`;
  return `
    <div style="width:${totalWidthPx}px;background:white;color:#2a1822;font-family:Arial,Helvetica,sans-serif;font-size:${fontPt}pt;line-height:1.4;padding:${padPx}px;box-sizing:border-box;">
      <!-- HEADER: brand left, KWITANSI+invoice+date right -->
      <div style="display:flex;flex-direction:row;align-items:flex-start;justify-content:space-between;padding-bottom:6px;border-bottom:2px solid #ee5a8a;">
        <div style="width:${brandColWidthPx}px;display:flex;flex-direction:row;align-items:center;gap:6px;">
          ${logoSrc ? `<img src="${logoSrc}" alt="" crossorigin="anonymous" style="width:${isThermal ? 32 : 48}px;height:${isThermal ? 32 : 48}px;object-fit:contain;display:block;flex-shrink:0;">` : `<span style="font-size:${isThermal ? 18 : 24}px;flex-shrink:0;">🌸</span>`}
          <div style="flex:1;min-width:0;">
            <div style="font-size:${Math.round(fontPt * 1.15)}pt;font-weight:bold;color:#2a1822;line-height:1.2;margin-bottom:2px;">${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</div>
            <div style="font-size:${Math.round(fontPt * 0.78)}pt;color:#6a5a64;line-height:1.3;">${esc(biz.tagline || 'Layanan Kesehatan Ibu & Anak Terpercaya')}<br>${esc(biz.address || '')}<br>WA: ${esc(biz.phone || '085887018194')}</div>
          </div>
        </div>
        <div style="width:${metaColWidthPx}px;text-align:right;">
          <div style="font-size:${Math.round(fontPt * 0.92)}pt;font-weight:bold;letter-spacing:1px;color:#6a5a64;margin-bottom:3px;">KWITANSI</div>
          <div style="font-size:${Math.round(fontPt * 1.08)}pt;font-weight:bold;color:#2a1822;margin-bottom:3px;">${esc(r.invoice_no || '')}</div>
          <div style="font-size:${Math.round(fontPt * 0.8)}pt;color:#6a5a64;">${new Date(r.created_at).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })}</div>
        </div>
      </div>

      <!-- GRID: Kepada / Tanggal & Waktu (2 columns via flex, NOT grid) -->
      <div style="display:flex;flex-direction:row;gap:8px;margin:8px 0 6px;">
        <div style="width:${blockColPx}px;flex-shrink:0;">
          <div style="font-size:${Math.round(fontPt * 0.74)}pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:#8b6878;margin-bottom:3px;">Kepada</div>
          <div style="font-size:${Math.round(fontPt * 0.9)}pt;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word;">
            <strong>${esc(r.patient_name || '-')}</strong><br>
            ${esc(r.whatsapp || '')}<br>
            ${esc(r.address || '')}
          </div>
        </div>
        <div style="width:${blockColPx}px;flex-shrink:0;">
          <div style="font-size:${Math.round(fontPt * 0.74)}pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:#8b6878;margin-bottom:3px;">Tanggal & Waktu Layanan ${sessionsLabel}</div>
          <div style="font-size:${Math.round(fontPt * 0.9)}pt;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word;">
            ${r.service_date ? new Date(r.service_date).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }) : '-'}
            <div style="margin-top:4px;">${timesHtml}</div>
          </div>
        </div>
      </div>

      <!-- TABLE: items -->
      <table style="width:100%;border-collapse:collapse;margin:6px 0;font-size:${Math.round(fontPt * 0.9)}pt;">
        <thead>
          <tr style="background:#ee5a8a;color:white;">
            <th style="width:${tblNamePx}px;padding:${cellPadY} ${cellPadX};text-align:left;font-weight:bold;color:white;background:#ee5a8a;">Layanan</th>
            <th style="width:${tblQtyPx}px;padding:${cellPadY} ${cellPadX};text-align:right;font-weight:bold;color:white;background:#ee5a8a;">Qty</th>
            <th style="width:${tblPricePx}px;padding:${cellPadY} ${cellPadX};text-align:right;font-weight:bold;color:white;background:#ee5a8a;">Harga</th>
            <th style="width:${tblSubPx}px;padding:${cellPadY} ${cellPadX};text-align:right;font-weight:bold;color:white;background:#ee5a8a;">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(it => `<tr>
            <td style="padding:${cellPadY} ${cellPadX};border-bottom:1px solid #ffd6e2;vertical-align:top;word-wrap:break-word;">${esc(it.name)}</td>
            <td style="padding:${cellPadY} ${cellPadX};border-bottom:1px solid #ffd6e2;text-align:right;vertical-align:top;">${it.qty}</td>
            <td style="padding:${cellPadY} ${cellPadX};border-bottom:1px solid #ffd6e2;text-align:right;vertical-align:top;">${fmtRp(it.price)}</td>
            <td style="padding:${cellPadY} ${cellPadX};border-bottom:1px solid #ffd6e2;text-align:right;vertical-align:top;">${fmtRp(it.price * it.qty)}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <!-- TOTALS -->
      <div style="margin:6px 0;">
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:${Math.round(fontPt * 0.92)}pt;border-bottom:1px dashed #ffe0e8;">
          <span>Subtotal</span><span>${fmtRp(r.subtotal)}</span>
        </div>
        ${r.transport_fee ? `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:${Math.round(fontPt * 0.92)}pt;border-bottom:1px dashed #ffe0e8;"><span>Transportasi</span><span>${fmtRp(r.transport_fee)}</span></div>` : ''}
        ${r.discount ? `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:${Math.round(fontPt * 0.92)}pt;border-bottom:1px dashed #ffe0e8;"><span>Diskon</span><span>-${fmtRp(r.discount)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;padding:6px 0 0;margin-top:4px;border-top:2px solid #ee5a8a;font-weight:bold;font-size:${Math.round(fontPt * 1.08)}pt;color:#2a1822;">
          <span>TOTAL</span><span>${fmtRp(r.total)}</span>
        </div>
      </div>

      <!-- FOOTER: Penerima / Hormat kami (2 columns via flex) -->
      <div style="margin-top:14px;padding-top:8px;border-top:1px dashed #ffd6e8;">
        ${signatureBlock}
        <div style="text-align:center;margin-top:14px;padding-top:8px;border-top:1px dashed #ffd6e2;font-size:${Math.round(fontPt * 0.82)}pt;color:#6a5a64;">
          <strong style="color:#2a1822;display:block;margin-bottom:2px;font-size:${Math.round(fontPt * 1.05)}pt;">Terima kasih atas kepercayaan Anda 🌸</strong>
          Kwitansi ini sah dan diproses secara elektronik oleh sistem.
        </div>
      </div>
    </div>
  `;
}

// Main entry point. r = receipt object, paperSize = KW_PAPER_SIZES key.
async function saveKwitansiAsPDF(r, paperSize, options) {
  options = options || {};
  const ps = KW_PAPER_SIZES[paperSize] || KW_PAPER_SIZES['A5'];
  const isThermal = !!ps.autoHeight;
  // includeSignature defaults to true (preserves old behavior). When
  // false, the owner signature is NOT embedded into the PDF even if
  // the admin has one saved. This gives admins a per-download choice.
  const includeSignature = options.includeSignature !== false;

  // Step 1: build the visible wrap.
  //
  // After extensive testing, the only reliably-working approach with
  // html2canvas 1.4.1 is to render the wrap VISIBLE in the document
  // (no opacity:0, no display:none, no z-index:-1 — html2canvas skips
  // or mis-renders all of those). We position the wrap just below
  // the modal (so the user can see it briefly) and use pointer-events:none
  // so it doesn't block clicks.
  //
  // Earlier versions used various hidden states (opacity:0, z-index:-1,
  // top:100000px) and ALL of them produced 9KB blank PDFs because
  // html2canvas captured an empty 0×0 canvas.
  const wrap = document.createElement('div');
  wrap.className = 'kw-pdf-wrap';
  // Position the wrap just below the modal (~600px down). The user
  // will see a brief flash of the invoice before it's snapshotted.
  // We use position:absolute (relative to body since body isn't
  // positioned) so it doesn't affect the document's normal flow.
  wrap.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',                          // top-left of document body
    'background:white',
    'color:#2a1822',
    `width:${ps.width}mm`,
    'padding:0',
    'margin:0',
    'box-sizing:border-box',
    'font-family:"Plus Jakarta Sans","Helvetica Neue",Arial,sans-serif',
    'pointer-events:none',            // don't block clicks underneath
    'z-index:2147483646'              // max-safe z-index minus 1
  ].join(';');

  // No <style> block needed — all styling is inline on each element
  // (see buildKwitansiHtmlForExport). html2canvas reads inline styles
  // directly via getComputedStyle without needing to parse any
  // stylesheet rules.

  // Inject the invoice HTML as a child. All visual styling is now
  // baked into the HTML as inline style="" attributes — no separate
  // <style> block needed (which html2canvas had trouble with).
  // The body wrapper just holds the invoice; the invoice itself
  // has explicit pixel widths so layout is deterministic.
  const body = document.createElement('div');
  body.style.cssText = 'background:white;color:#2a1822;line-height:1.4;';
  body.innerHTML = buildKwitansiHtmlForExport(r, ps, isThermal, { hideSignatures: options.hideSignatures === true });
  wrap.appendChild(body);

  // Append wrap directly to body. wrap is positioned absolute, so it
  // doesn't affect document layout. The brief visual flash is
  // acceptable for the reliability win over hidden positioning.
  document.body.appendChild(wrap);

  // Step 2: populate owner signature (if any) so it renders into
  // the captured canvas. We wait for FileReader explicitly so
  // html2canvas captures the loaded image (otherwise the img.src
  // is set but image data isn't loaded yet when canvas is drawn).
  //
  // includeSignature flag lets the admin CHOOSE whether to embed the
  // signature on a per-download basis. Default: include if admin has
  // one saved. When unchecked: skip the fetch + display:block so the
  // PDF has just the practitioner name + underline (no signature image).
  const ownerImg = wrap.querySelector('#ownerSigEmbed');
  const ownerUnderline = wrap.querySelector('#ownerSigUnderline');
  const wantOwner = includeSignature && !!(SETTINGS && SETTINGS.has_owner_signature);
  if (wantOwner && ownerImg) {
    try {
      const dataUrl = await fetchOwnerSignatureDataUrl();
      if (dataUrl) {
        ownerImg.src = dataUrl;
        ownerImg.style.display = 'block';
        if (ownerUnderline) ownerUnderline.style.marginTop = '2mm';
        // Wait for the image to actually load in DOM before snapshot
        await new Promise((resolve) => {
          if (ownerImg.complete && ownerImg.naturalWidth > 0) resolve();
          else ownerImg.onload = () => resolve();
        });
      } else if (ownerUnderline) {
        ownerUnderline.style.marginTop = '14mm';
      }
    } catch (e) {
      console.warn('Owner signature fetch failed:', e);
      if (ownerUnderline) ownerUnderline.style.marginTop = '14mm';
    }
  } else if (ownerUnderline) {
    ownerUnderline.style.marginTop = '14mm';
  }

  // Step 3: load jsPDF + html2canvas from CDN. Both UMD modules.
  const jsPDF = await ensureJsPdfLoaded();
  const html2canvas = await ensureHtml2CanvasLoaded();

  // Step 4: rasterize the wrap to canvas. Force a synchronous layout
  // pass so getBoundingClientRect returns the post-style values
  // (not the initial 0). Reading offsetHeight/Width also forces
  // the browser to compute layout synchronously — without this,
  // the next html2canvas call may capture an un-laid-out DOM.
  wrap.getBoundingClientRect();
  const wrapHeightPx = wrap.offsetHeight;
  const wrapWidthPx = wrap.offsetWidth;
  // Explicit canvas dimensions in CSS pixels at 96 DPI baseline.
  // 1mm = 3.7795px. We compute this so html2canvas doesn't have to
  // guess the wrap's size — it just uses our number. This is the
  // single biggest fix for the "9KB blank PDF" symptom: if we
  // don't pass width/height and the wrap is in an unusual CSS
  // context (off-screen, opacity-0, behind elements), html2canvas
  // may produce a 0×0 canvas.
  const mmToPx = 96 / 25.4;
  // Use the wrap's ACTUAL measured size if available; fall back to
  // computed size from paper dimensions if measurement failed.
  const wrapWidthCssPx = Math.max(
    wrapWidthPx || Math.ceil(ps.width * mmToPx),
    Math.ceil(ps.width * mmToPx)
  );
  const wrapHeightCssPx = Math.max(
    wrapHeightPx || (isThermal ? 200 * mmToPx : ps.height * mmToPx),
    100  // floor: never less than 100px so we always get a canvas
  );
  console.log('[kw-pdf] Capturing canvas:', wrapWidthCssPx, 'x', wrapHeightCssPx, 'px for paper size', paperSize);
  // Step 5: rasterize to canvas.
  let canvas;
  try {
    canvas = await html2canvas(wrap, {
      // Explicit size — html2canvas needs to know what dimensions to
      // render. Without this, it sometimes captures only a portion of
      // the wrap (e.g. just the visible viewport area), leading to
      // partial or empty PDFs.
      width: wrapWidthCssPx,
      height: wrapHeightCssPx,
      // scale:2 = 2x for crisp output on retina/print (canvas pixels
      // are 2x CSS pixels — final canvas.width === wrapWidthCssPx*2).
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      // Mitigasi bug html2canvas: library ini kadang salah menempatkan
      // spasi antar-kata (mis. "Kwitansi ini" ter-render "Kw itansini")
      // karena mewarisi letter/word-spacing & metrik font halaman admin.
      // Di dokumen klon kita normalkan spacing + paksa stack font yang
      // metriknya konsisten, supaya teks PDF rapi tanpa spasi aneh.
      onclone: (clonedDoc) => {
        const root = clonedDoc.querySelector('.kw-pdf-wrap');
        if (root) {
          root.style.letterSpacing = '0px';
          root.style.wordSpacing = '0px';
          root.querySelectorAll('*').forEach((el) => {
            el.style.letterSpacing = '0px';
            el.style.wordSpacing = '0px';
          });
        }
      },
      // Default windowWidth/windowHeight — wrap is visible at top:0
      // in the viewport, so html2canvas sees it naturally.
      scrollX: 0,
      scrollY: 0,
      removeContainer: true
    });
  } catch (e) {
    try { document.body.removeChild(wrap); } catch (e) {}
    throw new Error('Gagal render kwitansi ke canvas: ' + e.message);
  }

  // Step 6: compute PDF dimensions.
  // Canvas dimensions are in pixels at scale=2. Convert to mm
  // using the same scale factor (96 DPI standard for screen → mm).
  //   px → mm:  px / 96 * 25.4
  //   But because we used scale=2, canvas pixels are 2x the layout
  //   pixels. So the conversion is: (canvas.px / 2) / 96 * 25.4
  const pxPerMm = 96 / 25.4; // layout pixels per mm
  const canvasWidthMm = canvas.width / 2 / pxPerMm;
  const canvasHeightMm = canvas.height / 2 / pxPerMm;

  // For thermal: use canvas height as the page height (auto-fit).
  // For fixed sizes: cap to the paper height — if content is shorter
  // than the paper, that's fine (PDF will have whitespace at the
  // bottom). We don't auto-shrink because that would force the
  // next receipt to a different page size, which is confusing.
  let pageWidthMm, pageHeightMm;
  if (isThermal) {
    pageWidthMm = ps.width;
    pageHeightMm = Math.max(canvasHeightMm, 50); // min 50mm so an empty receipt is still printable
  } else {
    pageWidthMm = ps.width;
    pageHeightMm = ps.height;
  }

  // Step 7: instantiate jsPDF with the right format. Different rules
  // per size:
  //   • jsPDF native formats ('a4', 'a5') → pass the name directly
  //   • Custom sizes (F4, Thermal) → pass an explicit [w, h] array
  // jsPDF does NOT recognize 'f4' as a known format name — passing it
  // as a string would silently fall back to Letter size, producing a
  // wrong-sized PDF. Always pass F4 as an explicit width/height array.
  let pdf;
  if (isThermal || paperSize === 'F4') {
    pdf = new jsPDF({
      unit: 'mm',
      format: [pageWidthMm, pageHeightMm],
      orientation: pageWidthMm > pageHeightMm ? 'landscape' : 'portrait'
    });
  } else {
    pdf = new jsPDF({
      unit: 'mm',
      format: paperSize.toLowerCase(), // 'a5' or 'a4' — both are jsPDF native
      orientation: 'portrait'
    });
  }

  // Step 8: add the rasterized image to the PDF, sized to the page.
  const imgData = canvas.toDataURL('image/jpeg', 0.95);
  // Scale image to fit page width, preserving aspect ratio.
  const targetWidth = pageWidthMm;
  const targetHeight = (canvasHeightMm / canvasWidthMm) * pageWidthMm;
  // If image is taller than page (rare with our padding rules), scale
  // it down to fit page height. For thermal autoHeight this never
  // triggers because we sized the page to match.
  let drawWidth = targetWidth;
  let drawHeight = targetHeight;
  if (drawHeight > pageHeightMm && !isThermal) {
    drawHeight = pageHeightMm;
    drawWidth = (canvasWidthMm / canvasHeightMm) * pageHeightMm;
  }
  pdf.addImage(imgData, 'JPEG', 0, 0, drawWidth, drawHeight, undefined, 'FAST');

  // Step 9: trigger the download.
  //
  // The previous version used `pdf.save(filename)`, which works in
  // most cases but has a subtle bug: when the click handler is async
  // and the PDF generation involves multiple `await`s (loading
  // jsPDF, html2canvas, owner signature image, etc.), Chrome can
  // silently block the download because the `.click()` on the
  // temporary `<a>` element no longer has a direct user-gesture
  // context. The user would see "nothing happens" and assume the
  // feature is broken.
  //
  // Fix: build the download explicitly using `pdf.output('blob')` +
  // `URL.createObjectURL()` + a real `<a>` element. Same approach as
  // pdf.save() but with explicit visibility into what happens.
  // The Object URL is revoked after 1500ms which is enough time for
  // Chrome to start the download.
  const filename = (r.invoice_no || 'kwitansi') + '.pdf';
  try {
    const pdfBlob = pdf.output('blob');
    const blobUrl = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (e) {}
      try { URL.revokeObjectURL(blobUrl); } catch (e) {}
    }, 1500);
  } finally {
    try { document.body.removeChild(wrap); } catch (e) {}
  }
}



// INIT
if (API_BASE) {
  document.querySelectorAll('.brand-logo img').forEach((image) => { image.src = apiUrl('/api/logo'); });
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = apiUrl('/api/logo');
}
// If admin.html's Chart.js multi-CDN fallback exhausts every option,
// flip a global flag so drawCharts() can route to its HTML-table
// fallback instead of trying to instantiate Chart() in vain.
window.addEventListener('chartjs:unavailable', () => { window.__chartJsFailed = true; });
if (TOKEN && USER) {
  api('/api/admin/stats').then(() => showApp()).catch(() => showLogin());
} else {
  showLogin();
}
initTheme();
