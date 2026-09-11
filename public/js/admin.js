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
}
async function loadCache() {
  try {
    [SERVICES, SETTINGS] = await Promise.all([
      fetch(apiUrl('/api/services')).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
      api('/api/admin/settings')
    ]);
  } catch (e) {}
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

function navigate(page) {
  CURRENT_PAGE = page;
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
  };
  (handlers[page] || renderDashboard)();
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }

// ---------- DASHBOARD ----------
async function renderDashboard() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <div>
        <h1>👋 Halo, ${esc(USER?.name) || 'Admin'}</h1>
        <p style="color:var(--text-soft);">Ringkasan reservasi & pendapatan.</p>
      </div>
      <button onclick="renderDashboard()" class="btn btn-outline">🔄 Refresh</button>
    </div>
    <div class="stat-grid" id="statGrid"><div>Loading...</div></div>
    <div class="charts-grid">
      <div class="chart-card"><h3>📈 Omzet 14 Hari Terakhir</h3><div class="chart-canvas-wrap"><canvas id="chOmzetDay"></canvas></div></div>
      <div class="chart-card"><h3>📊 Status Reservasi</h3><div class="chart-canvas-wrap"><canvas id="chStatus"></canvas></div></div>
    </div>
    <div class="charts-grid">
      <div class="chart-card"><h3>💰 Omzet 6 Bulan</h3><div class="chart-canvas-wrap"><canvas id="chOmzetMonth"></canvas></div></div>
      <div class="chart-card"><h3>💳 Metode Pembayaran</h3><div class="chart-canvas-wrap"><canvas id="chPay"></canvas></div></div>
    </div>
    <div class="chart-card" style="margin-bottom:20px;"><h3>🏆 Layanan Terpopuler</h3><div class="chart-canvas-wrap" style="height:280px;"><canvas id="chServices"></canvas></div></div>
    <h3 style="margin: 24px 0 14px;">📋 Reservasi Terbaru</h3>
    <div id="recentList"></div>
  `;
  try {
    const [stats, charts, rows] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/charts'),
      api('/api/admin/reservations')
    ]);
    document.getElementById('statGrid').innerHTML = `
      <div class="stat-card"><div class="label">Pending</div><div class="value">${stats.pending}</div></div>
      <div class="stat-card"><div class="label">Approved</div><div class="value">${stats.approved}</div></div>
      <div class="stat-card peach"><div class="label">Lunas</div><div class="value">${stats.lunas}</div></div>
      <div class="stat-card pink"><div class="label">Total Omzet</div><div class="value">${fmtRp(stats.omzet)}</div></div>
      <div class="stat-card"><div class="label">Total Reservasi</div><div class="value">${stats.total}</div></div>
    `;
    drawCharts(charts);

    const recent = rows.slice(0, 8);
    document.getElementById('recentList').innerHTML = recent.length ? `
      <div class="table-scroll"><table class="data-table"><thead>
        <tr><th>Pasien</th><th>Layanan</th><th>Sesi</th><th>Status</th><th>Bayar</th><th>Total</th></tr>
      </thead><tbody>
      ${recent.map(r => `<tr>
        <td><strong>${esc(r.patient_name)}</strong><br><small style="color:var(--text-soft)">${esc(r.whatsapp)}</small></td>
        <td>${renderItemsCompact(r.items)}</td>
        <td>${(r.slots || []).length} sesi</td>
        <td><span class="badge badge-${r.status}">${r.status}</span></td>
        <td><span class="badge badge-${r.payment_status}">${r.payment_status}</span></td>
        <td><strong>${fmtRp(r.total)}</strong></td>
      </tr>`).join('')}
      </tbody></table></div>
    ` : '<p style="color:var(--text-soft);text-align:center;padding:20px;">Belum ada reservasi.</p>';
  } catch (e) { document.getElementById('statGrid').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

function renderItemsCompact(items) {
  if (!items || !items.length) return '-';
  const first = items[0];
  if (items.length === 1) return `${esc(first.name)} ×${first.qty}`;
  return `${esc(first.name)} ×${first.qty} <span class="tag">+${items.length - 1}</span>`;
}

function drawCharts(d) {
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
function chartOpts(scales) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true, ...scales.y } }
  };
}

// ---------- RESERVATIONS ----------
async function renderReservations() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <h1>📅 Reservasi</h1>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <select id="filterStatus" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);">
          <option value="">Semua Status</option><option value="pending">Pending</option>
          <option value="approved">Approved</option><option value="rejected">Rejected</option>
        </select>
        <select id="filterPay" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);">
          <option value="">Semua Bayar</option><option value="unpaid">Unpaid</option><option value="lunas">Lunas</option>
        </select>
        <button onclick="loadReservations()" class="btn-sm btn-pay">🔄 Refresh</button>
      </div>
    </div>
    <div id="reservationsList">Loading...</div>
  `;
  document.getElementById('filterStatus').onchange = loadReservations;
  document.getElementById('filterPay').onchange = loadReservations;
  loadReservations();
}

async function loadReservations() {
  const status = document.getElementById('filterStatus').value;
  const pay = document.getElementById('filterPay').value;
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (pay) qs.set('payment_status', pay);
  try {
    const rows = await api('/api/admin/reservations?' + qs);
    const el = document.getElementById('reservationsList');
    if (!rows.length) { el.innerHTML = '<p style="color:var(--text-soft);text-align:center;padding:40px;">Tidak ada reservasi.</p>'; return; }
    el.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>
      <th>#</th><th>Pasien</th><th>Layanan</th><th>Jadwal</th><th>Bayar</th><th>Total</th><th>Status</th><th>Aksi</th>
    </tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td>#${r.id}</td>
        <td><strong>${esc(r.patient_name)}</strong><br>
          <small><a href="https://wa.me/${r.whatsapp.replace(/\D/g,'')}" target="_blank">${esc(r.whatsapp)}</a></small><br>
          <small style="color:var(--text-soft)">${esc(r.address.slice(0,40))}${r.address.length>40?'…':''}</small></td>
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
    </tbody></table></div>`;
  } catch (e) { document.getElementById('reservationsList').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

async function updateRes(id, status, payment_status) {
  const body = {};
  if (status) body.status = status;
  if (payment_status) body.payment_status = payment_status;
  await api('/api/admin/reservations/' + id, { method: 'PATCH', body: JSON.stringify(body) });
  loadReservations();
}
async function delRes(id) {
  if (!confirm('Hapus reservasi ini?')) return;
  await api('/api/admin/reservations/' + id, { method: 'DELETE' });
  loadReservations();
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
let admCalDate = new Date();
async function renderCalendarAdmin() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header">
      <h1>🗓️ Kalender Realtime</h1>
      <div class="cal-nav">
        <button class="btn-sm btn-pay" onclick="admPrev()">‹</button>
        <button class="btn-sm btn-pay" onclick="admToday()">Hari ini</button>
        <button class="btn-sm btn-pay" onclick="admNext()">›</button>
      </div>
    </div>
    <div class="calendar-wrap">
      <h3 id="admCalLabel" style="margin-bottom:16px;">—</h3>
      <div class="cal-grid" id="admCalGrid"></div>
    </div>
  `;
  drawAdmCal();
}
async function drawAdmCal() {
  const rows = await api('/api/admin/reservations');
  // Flatten slots
  const events = [];
  rows.forEach(r => {
    (r.slots || []).forEach(s => events.push({
      date: s.date, time: s.time, patient_name: r.patient_name,
      service_name: r.items && r.items[0] ? r.items[0].name : r.service_name,
      status: r.status
    }));
  });
  const y = admCalDate.getFullYear(), m = admCalDate.getMonth();
  const mn = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  document.getElementById('admCalLabel').textContent = `${mn[m]} ${y}`;
  const grid = document.getElementById('admCalGrid'); grid.innerHTML = '';
  ['Min','Sen','Sel','Rab','Kam','Jum','Sab'].forEach(d => {
    const h = document.createElement('div'); h.className = 'cal-cell head'; h.textContent = d; grid.appendChild(h);
  });
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < firstDay; i++) { const c = document.createElement('div'); c.className = 'cal-cell muted'; grid.appendChild(c); }
  const today = new Date().toISOString().slice(0, 10);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const evs = events.filter(e => e.date === ds);
    const c = document.createElement('div');
    c.className = 'cal-cell' + (ds === today ? ' today' : '');
    c.innerHTML = `<span class="day-num">${d}</span>`;
    evs.slice(0,3).forEach(e => {
      const ev = document.createElement('div');
      ev.className = 'ev';
      ev.style.background = e.status === 'approved' ? '#d9efe1' : '#fff3d6';
      ev.style.color = e.status === 'approved' ? '#1e8957' : '#b07b15';
      ev.title = `${e.time} — ${e.patient_name} — ${e.service_name}`;
      ev.textContent = `${e.time.slice(0,5)} ${e.patient_name}`;
      c.appendChild(ev);
    });
    if (evs.length > 3) { const m = document.createElement('div'); m.className = 'ev'; m.textContent = `+${evs.length - 3}`; c.appendChild(m); }
    grid.appendChild(c);
  }
}
function admPrev() { admCalDate.setMonth(admCalDate.getMonth() - 1); drawAdmCal(); }
function admNext() { admCalDate.setMonth(admCalDate.getMonth() + 1); drawAdmCal(); }
function admToday() { admCalDate = new Date(); drawAdmCal(); }

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
            <div class="form-group"><label>Tanggal Layanan</label><input type="date" id="kw_date" value="${new Date().toISOString().slice(0,10)}"></div>
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
            <input type="search" id="kwSearch" placeholder="Cari nama / invoice..." oninput="filterKwList()" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);min-width:160px;">
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
    <style>@media(max-width:920px){#kwGrid{grid-template-columns:1fr !important;}}</style>
  `;
  receiptItems = [];
  addReceiptItem();
  loadReceipts();
}

// Filter kwitansi list by search text (client-side)
function filterKwList() {
  const q = (document.getElementById('kwSearch')?.value || '').toLowerCase().trim();
  const tbody = document.querySelector('#kwList tbody');
  if (!tbody) return;
  let visible = 0;
  tbody.querySelectorAll('tr').forEach((tr) => {
    const text = tr.textContent.toLowerCase();
    const show = !q || text.includes(q);
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
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
}

async function saveReceipt() {
  const items = receiptItems.filter(it => it.name && it.price > 0);
  if (!items.length) return alert('Tambahkan minimal 1 layanan');
  const body = {
    patient_name: document.getElementById('kw_name').value,
    whatsapp: document.getElementById('kw_hp').value,
    address: document.getElementById('kw_addr').value,
    service_date: document.getElementById('kw_date').value,
    items,
    transport_fee: parseInt(document.getElementById('kw_transport').value) || 0,
    discount: parseInt(document.getElementById('kw_discount').value) || 0
  };
  const res = await api('/api/admin/receipts', { method: 'POST', body: JSON.stringify(body) });
  printReceipt({ ...body, invoice_no: res.invoice_no, subtotal: res.subtotal, total: res.total, created_at: new Date().toISOString() });
  loadReceipts();
}

async function loadReceipts() {
  try {
    const rows = await api('/api/admin/receipts');
    window._receiptsCache = rows;
    const el = document.getElementById('kwList');
    if (!rows.length) {
      el.innerHTML = '<p style="color:var(--text-soft);padding:20px;text-align:center;">Belum ada kwitansi.</p>';
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
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr>
            <th style="width:36px;"></th>
            <th>No. Invoice</th><th>Pasien</th><th>Total</th><th>Aksi</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr data-rid="${r.id}">
              <td><input type="checkbox" class="kw-chk" value="${r.id}" onchange="updateKwSelCount()"></td>
              <td><strong>${r.invoice_no}</strong><br><small>${fmtDateTime(r.created_at)}</small></td>
              <td>${esc(r.patient_name || '-')}</td>
              <td><strong>${fmtRp(r.total)}</strong></td>
              <td style="white-space:nowrap;">
                <button class="btn-sm btn-view" onclick="openKwitansiDetailModal(${r.id})" title="Lihat">👁️</button>
                <button class="btn-sm btn-view" onclick='printReceiptById(${r.id})' title="Cetak">🖨️</button>
                <button class="btn-sm btn-del" onclick="deleteReceipt(${r.id}, '${esc(r.invoice_no)}')" title="Hapus" style="padding:6px 10px;">🗑️</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    updateKwSelCount();
  } catch (e) { document.getElementById('kwList').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

function printReceiptById(id) {
  const r = (window._receiptsCache || []).find(x => x.id === id);
  if (r) printReceipt(r);
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
  if (!confirm(`⚠️ HAPUS SEMUA ${rows.length} kwitansi?\n\nTindakan ini PERMANEN dan tidak dapat dibatalkan.\n\nLanjutkan?`)) return;
  const confirm2 = prompt('Ketik HAPUS SEMUA untuk konfirmasi:');
  if (confirm2 !== 'HAPUS SEMUA') return alert('Dibatalkan.');
  try {
    const res = await api('/api/admin/receipts', { method: 'DELETE' });
    alert(`✅ ${res.deleted} kwitansi dihapus.`);
    loadReceipts();
  } catch (e) { alert('Gagal: ' + e.message); }
}

function printReceipt(r) {
  const items = Array.isArray(r.items) ? r.items : (r.items || JSON.parse(r.items_json || '[]'));
  const biz = SETTINGS || {};
  const logoSrc = biz.has_logo ? apiUrl('/api/logo') : null;
  const html = `<!doctype html><html><head><title>Kwitansi ${r.invoice_no}</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${PAGE_STYLESHEET}">
    <style>body{background:#f7f2f4;padding:30px;font-family:'Plus Jakarta Sans',sans-serif;}@media print{body{background:white;padding:0;}.print-actions{display:none;}}</style>
    </head><body>
    <div class="print-actions" style="text-align:center;margin-bottom:20px;">
      <button onclick="window.print()" style="padding:10px 24px;background:#ee5a8a;color:white;border:none;border-radius:999px;font-weight:700;cursor:pointer;font-size:1rem;">🖨️ Cetak / Save PDF</button>
    </div>
    <div class="invoice">
      <div class="invoice-header">
        <div style="display:flex;align-items:center;gap:14px;">
          ${logoSrc ? `<img src="${logoSrc}" style="width:70px;height:70px;object-fit:contain;">` : '<span style="font-size:2.4rem;">🌸</span>'}
          <div>
            <h2 style="margin:0;">${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</h2>
            <small>${esc(biz.tagline || 'Layanan Kesehatan Ibu & Anak Terpercaya')}<br>
            ${esc(biz.address || '')}<br>
            WA: ${esc(biz.phone || '085887018194')}</small>
          </div>
        </div>
        <div class="meta">
          <strong style="font-size:1.1rem;">KWITANSI</strong><br>
          <span>${r.invoice_no}</span><br>
          <small>${new Date(r.created_at).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })}</small>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div class="invoice-block">
          <h4>Kepada</h4>
          <strong>${esc(r.patient_name || '-')}</strong><br>
          ${esc(r.whatsapp || '')}<br>
          ${esc(r.address || '')}
        </div>
        <div class="invoice-block">
          <h4>Tanggal Layanan</h4>
          ${r.service_date ? new Date(r.service_date).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' }) : '-'}
        </div>
      </div>
      <table>
        <thead><tr><th>Layanan</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Harga</th><th style="text-align:right;">Subtotal</th></tr></thead>
        <tbody>
          ${items.map(it => `<tr>
            <td>${esc(it.name)}</td>
            <td style="text-align:center;">${it.qty}</td>
            <td style="text-align:right;">${fmtRp(it.price)}</td>
            <td style="text-align:right;">${fmtRp(it.price * it.qty)}</td>
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
        Terima kasih atas kepercayaan Anda 🌸<br>
        <em>${esc(biz.practitioner || 'Tasya Hanifah Pramesti, A.Md. Keb., CBME')}</em>
      </div>
    </div>
    </body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html); w.document.close();
}

// ---------- RECAP ----------
async function renderRecap() {
  const c = document.getElementById('pageContent');
  const m = new Date().toISOString().slice(0, 7);
  c.innerHTML = `
    <div class="admin-header">
      <h1>📈 Rekap Bulanan</h1>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="month" id="recapMonth" value="${m}" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);">
        <button onclick="loadRecap()" class="btn-sm btn-pay">🔄 Muat</button>
        <button onclick="openKwitansiModal()" class="btn-sm btn-approve">🧾 Buat Kwitansi Manual</button>
        <button onclick="exportRecapXLSX()" class="btn-sm btn-approve">📊 Excel</button>
        <button onclick="exportRecapCSV()" class="btn-sm btn-pay">📥 CSV</button>
        <button onclick="exportRecapPDF()" class="btn-sm btn-view">🖨️ PDF</button>
      </div>
    </div>
    <div id="recapContent">Loading...</div>
  `;
  loadRecap();
}

let RECAP_DATA = null;
let RECAP_RECEIPTS = [];
async function loadRecap() {
  const month = document.getElementById('recapMonth').value;
  try {
    RECAP_DATA = await api('/api/admin/recap?month=' + month);
    RECAP_RECEIPTS = await api('/api/admin/receipts?month=' + month);
    const el = document.getElementById('recapContent');
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Total Reservasi</div><div class="value">${RECAP_DATA.totalReservasi}</div></div>
        <div class="stat-card pink"><div class="label">Total Omzet</div><div class="value">${fmtRp(RECAP_DATA.totalOmzet)}</div></div>
        <div class="stat-card peach"><div class="label">Total Kwitansi</div><div class="value">${RECAP_RECEIPTS.length}</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:8px;" id="recapCols">
        <div>
          <h3 style="margin:20px 0 12px;">🧾 Kwitansi Bulan ${month}</h3>
          ${RECAP_RECEIPTS.length ? renderReceiptTable(RECAP_RECEIPTS) : '<p style="color:var(--text-soft);text-align:center;padding:20px;background:var(--card);border-radius:12px;">Belum ada kwitansi bulan ini.</p>'}
        </div>
        <div>
          <h3 style="margin:20px 0 12px;">📅 Detail Reservasi Bulan ${month}</h3>
          ${RECAP_DATA.rows.length ? `
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
          ` : '<p style="color:var(--text-soft);text-align:center;padding:20px;background:var(--card);border-radius:12px;">Belum ada reservasi bulan ini.</p>'}
        </div>
      </div>
      <style>@media(max-width:920px){#recapCols{grid-template-columns:1fr !important;}}</style>
    `;
  } catch (e) { document.getElementById('recapContent').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
}

function renderReceiptTable(rows) {
  return `<div class="table-scroll"><table class="data-table"><thead><tr>
    <th>Invoice</th><th>Tgl Layanan</th><th>Pasien</th><th>Total</th><th>Aksi</th>
  </tr></thead><tbody>
  ${rows.map(r => `<tr>
    <td><strong>${esc(r.invoice_no || '-')}</strong><br><small style="color:var(--text-soft)">${fmtDateTime(r.created_at)}</small></td>
    <td>${r.service_date ? fmtDate(r.service_date) : '<span style="color:var(--text-soft)">—</span>'}</td>
    <td>${esc(r.patient_name || '-')}<br><small style="color:var(--text-soft)">${esc(r.whatsapp || '')}</small></td>
    <td><strong>${fmtRp(r.total)}</strong></td>
    <td style="white-space:nowrap;">
      <button class="btn-sm btn-view" onclick="openKwitansiDetailModal(${r.id})" title="Lihat">👁️</button>
      <button class="btn-sm btn-view" onclick="printReceiptById(${r.id})" title="Cetak PDF">🖨️</button>
      <button class="btn-sm btn-del" onclick="deleteReceipt(${r.id}, '${esc(r.invoice_no)}')" title="Hapus">🗑️</button>
    </td>
  </tr>`).join('')}
  </tbody></table></div>`;
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
  const body = {
    patient_name: document.getElementById('mkw_name').value,
    whatsapp: document.getElementById('mkw_hp').value,
    address: document.getElementById('mkw_addr').value,
    service_date: document.getElementById('mkw_date').value,
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
  openModal(`
    <h3>🧾 Detail Kwitansi ${esc(r.invoice_no || '')}</h3>
    <div style="margin-top:14px;display:grid;gap:8px;font-size:0.92rem;">
      <div><strong>Tanggal Buat:</strong> ${fmtDateTime(r.created_at)}</div>
      <div><strong>Tanggal Layanan:</strong> ${r.service_date ? fmtDate(r.service_date) : '<span style="color:var(--text-soft)">—</span>'}</div>
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
      <button class="btn-sm btn-del" onclick="if(confirm('Hapus kwitansi ${esc(r.invoice_no)}?')){closeModal();deleteReceipt(${r.id},'${esc(r.invoice_no)}').then(()=>loadRecap());}">🗑️ Hapus</button>
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
    const res = await fetch(apiUrl('/api/admin/receipts/import' + (skipDups ? '' : '?skip=0')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(parsed)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    let html = `<div style="padding:12px;border-radius:8px;background:${data.imported ? '#d9efe1' : '#fff3d6'};">
      <strong>✅ Import selesai</strong><br>
      Berhasil: <strong>${data.imported}</strong> · Lewati (duplikat): <strong>${data.skipped}</strong> · Gagal: <strong>${data.failed}</strong>
    </div>`;
    if (data.failed_items && data.failed_items.length) {
      html += `<details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--text-soft);">Lihat ${data.failed_items.length} baris gagal</summary>
        <pre style="background:#fde0e4;padding:8px;border-radius:6px;margin-top:6px;max-height:200px;overflow:auto;font-size:0.78rem;">${esc(JSON.stringify(data.failed_items, null, 2))}</pre>
      </details>`;
    }
    resultEl.innerHTML = html;
    loadReceipts();
    loadKwitansiStats();
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
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;font-size:0.88rem;">
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="impPdfSkipDups" checked> Lewati duplikat
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
  try {
    const res = await fetch(apiUrl('/api/admin/receipts/import' + (skipDups ? '' : '?skip=0')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(toImport)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    alert(`✅ Import selesai: ${data.imported} kwitansi ditambahkan, ${data.skipped} dilewati (duplikat), ${data.failed} gagal.`);
    closeModal();
    loadReceipts();
    loadKwitansiStats();
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

function exportRecapCSV() {
  if (!RECAP_DATA) return;
  const rows = [['Tanggal','Jam','Pasien','WhatsApp','Layanan','Qty','Harga','Sesi','Total','Status','Pembayaran']];
  RECAP_DATA.rows.forEach(r => {
    (r.slots||[{date:'',time:''}]).forEach(s => {
      (r.items||[{name:'',price:0,qty:0}]).forEach(it => {
        rows.push([s.date, s.time, r.patient_name, r.whatsapp, it.name, it.qty, it.price, (r.slots||[]).length, r.total, r.status, r.payment_status]);
      });
    });
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `rekap-${RECAP_DATA.month}.csv`; a.click();
}

async function exportRecapXLSX() {
  if (!RECAP_DATA) return;
  try {
    await downloadProtected(
      `/api/admin/recap.xlsx?month=${encodeURIComponent(RECAP_DATA.month)}`,
      `rekap-adzkiya-${RECAP_DATA.month}.xlsx`
    );
  } catch (error) {
    alert('Export Excel gagal: ' + error.message);
  }
}

function exportRecapPDF() {
  if (!RECAP_DATA) return;
  const biz = SETTINGS || {};
  const logoSrc = biz.has_logo ? apiUrl('/api/logo') : null;
  const html = `<!doctype html><html><head><title>Rekap ${RECAP_DATA.month}</title>
    <link rel="stylesheet" href="${PAGE_STYLESHEET}">
    <style>body{padding:30px;background:white;font-family:'Plus Jakarta Sans',sans-serif;}@media print{.no-print{display:none;}}</style>
    </head><body>
    <div class="no-print" style="text-align:center;margin-bottom:16px;"><button onclick="window.print()" style="padding:10px 24px;background:#ee5a8a;color:white;border:none;border-radius:999px;font-weight:700;cursor:pointer;">🖨️ Cetak / Save PDF</button></div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:18px;padding-bottom:14px;border-bottom:3px solid #ee5a8a;">
      ${logoSrc ? `<img src="${logoSrc}" style="width:80px;height:80px;object-fit:contain;">` : '<span style="font-size:3rem;">🌸</span>'}
      <div><h1 style="color:#ee5a8a;margin:0;">${esc(biz.business_name || 'Adzkiya Mom Baby Care')}</h1><div style="color:#8b6878;">${esc(biz.tagline || '')}</div></div>
    </div>
    <h2>Rekap Bulanan — ${RECAP_DATA.month}</h2>
    <p style="margin:14px 0;"><strong>Total Reservasi:</strong> ${RECAP_DATA.totalReservasi} &nbsp;|&nbsp; <strong>Total Omzet:</strong> ${fmtRp(RECAP_DATA.totalOmzet)} &nbsp;|&nbsp; <strong>Total Kwitansi:</strong> ${RECAP_DATA.totalKwitansi}</p>
    <table class="data-table" style="font-size:0.85rem;">
      <thead><tr><th>Jadwal</th><th>Pasien</th><th>Layanan</th><th>Sesi</th><th>Total</th><th>Status</th><th>Bayar</th></tr></thead>
      <tbody>${RECAP_DATA.rows.map(r => `<tr>
        <td>${(r.slots||[]).map(s=>`${s.date} ${s.time}`).join('<br>')}</td>
        <td>${esc(r.patient_name)}</td>
        <td>${(r.items||[]).map(it=>`• ${esc(it.name)} ×${it.qty}`).join('<br>')}</td>
        <td>${(r.slots||[]).length}</td><td>${fmtRp(r.total)}</td><td>${r.status}</td><td>${r.payment_status}</td>
      </tr>`).join('')}</tbody>
    </table>
    </body></html>`;
  const w = window.open('', '_blank'); w.document.write(html); w.document.close();
}

// ---------- BACKUP / RESTORE ----------
async function renderBackup() {
  const c = document.getElementById('pageContent');
  c.innerHTML = `
    <div class="admin-header"><h1>💾 Backup & Restore</h1></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;" id="bkGrid">
      <div class="feature">
        <div class="icn">📤</div><h3>Backup Offline (JSON)</h3>
        <p>Download seluruh data reservasi, kwitansi, & pengaturan.</p>
        <button onclick="doBackup()" class="btn btn-primary" style="margin-top:16px;">📥 Download Backup</button>
      </div>
      <div class="feature">
        <div class="icn">📥</div><h3>Restore dari JSON</h3>
        <p>Upload file backup untuk memulihkan data.</p>
        <input type="file" id="restoreFile" accept="application/json" style="margin-top:14px;">
        <div style="margin-top:10px;">
          <label><input type="radio" name="restoreMode" value="append" checked> Append (tambah)</label><br>
          <label><input type="radio" name="restoreMode" value="replace"> Replace (ganti semua)</label>
        </div>
        <button onclick="doRestore()" class="btn btn-outline" style="margin-top:14px;">📤 Restore</button>
      </div>
    </div>
    <style>@media(max-width:920px){#bkGrid{grid-template-columns:1fr !important;}}</style>
  `;
}

async function doBackup() {
  const data = await api('/api/admin/backup');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `adzkiya-backup-${new Date().toISOString().slice(0,10)}.json`; a.click();
}

async function doRestore() {
  const f = document.getElementById('restoreFile').files[0];
  if (!f) return alert('Pilih file backup JSON terlebih dahulu');
  const mode = document.querySelector('[name=restoreMode]:checked').value;
  if (mode === 'replace' && !confirm('PERINGATAN: Mode REPLACE akan MENGHAPUS semua data. Lanjutkan?')) return;
  const text = await f.text();
  let data;
  try { data = JSON.parse(text); } catch { return alert('File tidak valid'); }
  const res = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify({ ...data, mode }) });
  alert(`✅ Restore selesai: ${res.imported.reservations} reservasi, ${res.imported.receipts} kwitansi`);
}

// ---------- SETTINGS ----------
async function renderSettings() {
  const s = await api('/api/admin/settings');
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
        <div class="form-group"><label>Nama</label><input type="text" value="${esc(USER?.name||'')}" disabled></div>
        <div class="form-group"><label>Email</label><input type="email" value="${esc(USER?.email||'')}" disabled></div>
        <div class="form-group"><label>Role</label><input type="text" value="${esc(USER?.role||'')}" disabled></div>
        <button onclick="logout()" class="btn-sm btn-del" style="padding:10px 20px;margin-top:10px;">🚪 Logout</button>
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
}

function renderHours() {
  const el = document.getElementById('hoursList');
  if (!el) return;
  SETTINGS.hours = SETTINGS.hours || [];
  el.innerHTML = '';
  SETTINGS.hours.forEach((h, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:90px 1fr 1fr auto;gap:8px;margin-bottom:6px;align-items:center;';
    row.innerHTML = `
      <div style="font-weight:600;font-size:0.9rem;">${esc(h.day)}</div>
      <input type="time" value="${esc(h.open||'08:00')}" ${h.closed ? 'disabled' : ''} oninput="SETTINGS.hours[${i}].open=this.value" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);">
      <input type="time" value="${esc(h.close||'20:00')}" ${h.closed ? 'disabled' : ''} oninput="SETTINGS.hours[${i}].close=this.value" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);">
      <label style="display:flex;gap:4px;align-items:center;font-size:0.82rem;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" ${h.closed ? 'checked' : ''} onchange="SETTINGS.hours[${i}].closed=this.checked;renderHours();"> Tutup
      </label>
    `;
    el.appendChild(row);
  });
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
    row.style.cssText = 'display:grid;grid-template-columns:140px 50px 1fr 70px 70px 36px;gap:8px;margin-bottom:8px;align-items:center;';
    const hasIcon = !!sc.icon_b64;
    row.innerHTML = `
      <select onchange="onSocialPlatformChange(${i}, this)" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
        ${platforms.map(p => `<option value="${p}" data-icon="${icons[p]}" ${sc.platform===p?'selected':''}>${icons[p]} ${p}</option>`).join('')}
      </select>
      <div style="width:42px;height:42px;border-radius:50%;background:${hasIcon ? `url(data:${sc.icon_mime||'image/png'};base64,${sc.icon_b64}) center/cover` : 'var(--pink-100)'};display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;">${hasIcon ? '' : esc(sc.icon || icons[sc.platform] || '🌐')}</div>
      <input type="url" placeholder="https://instagram.com/username" value="${esc(sc.url || '')}" oninput="SETTINGS.socials[${i}].url=this.value" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
      <label class="btn-sm btn-approve" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:8px;margin:0;">
        📷
        <input type="file" accept="image/*" onchange="uploadSocialIcon(${i}, this)" style="display:none;">
      </label>
      ${hasIcon ? `<button class="btn-sm btn-del" onclick="deleteSocialIcon(${i})" style="padding:8px;">🗑️</button>` : `<span style="display:inline-block;width:36px;"></span>`}
      <button class="rm-btn" onclick="SETTINGS.socials.splice(${i},1);renderSocials();" style="height:38px;background:#fde0e4;color:#c43050;border:none;border-radius:8px;cursor:pointer;">×</button>
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
  <style>@media(max-width:920px){#notifInner{grid-template-columns:1fr !important;}}</style>`;
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
    bank_accounts: (SETTINGS.bank_accounts || []).filter(b => b.bank || b.number || b.name)
  };
  await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
  alert('✅ Pengaturan disimpan');
  await loadCache();
}

// ---------- MODAL ----------
function openModal(html) {
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">${html}</div>
    </div>`;
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

// INIT
if (API_BASE) {
  document.querySelectorAll('.brand-logo img').forEach((image) => { image.src = apiUrl('/api/logo'); });
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = apiUrl('/api/logo');
}
if (TOKEN && USER) {
  api('/api/admin/stats').then(() => showApp()).catch(() => showLogin());
} else {
  showLogin();
}
initTheme();
