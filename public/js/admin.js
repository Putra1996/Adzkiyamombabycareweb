// Admin SPA logic v2
// Pages: dashboard, reservations, calendar, receipts, recap, backup, settings
let TOKEN = localStorage.getItem('adm_token') || '';
let USER = JSON.parse(localStorage.getItem('adm_user') || 'null');
let SERVICES = [];
let SETTINGS = {};
let CURRENT_PAGE = 'dashboard';
let CHARTS = {};
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const fmtDateTime = (s) => s ? new Date(s).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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
      fetch('/api/services').then(r => r.json()),
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
        <td>${esc(r.payment_method)}<br>${r.proof_file ? `<a href="${r.proof_file}" target="_blank" style="font-size:0.78rem;">📎 Bukti</a><br>` : ''}<span class="badge badge-${r.payment_status}">${r.payment_status}</span></td>
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
      ${r.proof_file ? `<div><strong>Bukti:</strong><br><a href="${r.proof_file}" target="_blank"><img src="${r.proof_file}" style="max-width:100%;margin-top:6px;border-radius:8px;"></a></div>` : ''}
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
        <h3 style="margin-bottom:12px;">Riwayat Kwitansi</h3>
        <div id="kwList">Loading...</div>
      </div>
    </div>
    <style>@media(max-width:920px){#kwGrid{grid-template-columns:1fr !important;}}</style>
  `;
  receiptItems = [];
  addReceiptItem();
  loadReceipts();
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
  const logoSrc = biz.has_logo ? '/api/logo' : null;
  const html = `<!doctype html><html><head><title>Kwitansi ${r.invoice_no}</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/style.css">
    <style>body{background:#f7f2f4;padding:30px;font-family:'Plus Jakarta Sans',sans-serif;}@media print{body{background:white;padding:0;}.print-actions{display:none;}}</style>
    </head><body>
    <div class="print-actions" style="text-align:center;margin-bottom:20px;">
      <button onclick="window.print()" style="padding:10px 24px;background:#ee5a8a;color:white;border:none;border-radius:999px;font-weight:700;cursor:pointer;font-size:1rem;">🖨️ Cetak / Save PDF</button>
    </div>
    <div class="invoice">
      <div class="invoice-header">
        <div style="display:flex;align-items:center;gap:14px;">
          ${logoSrc ? `<img src="${location.origin}${logoSrc}" style="width:70px;height:70px;object-fit:contain;">` : '<span style="font-size:2.4rem;">🌸</span>'}
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
async function loadRecap() {
  const month = document.getElementById('recapMonth').value;
  try {
    RECAP_DATA = await api('/api/admin/recap?month=' + month);
    const el = document.getElementById('recapContent');
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="label">Total Reservasi</div><div class="value">${RECAP_DATA.totalReservasi}</div></div>
        <div class="stat-card pink"><div class="label">Total Omzet</div><div class="value">${fmtRp(RECAP_DATA.totalOmzet)}</div></div>
        <div class="stat-card peach"><div class="label">Total Kwitansi</div><div class="value">${RECAP_DATA.totalKwitansi}</div></div>
      </div>
      <h3 style="margin:20px 0 12px;">Detail Reservasi Bulan ${RECAP_DATA.month}</h3>
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
    `;
  } catch (e) { document.getElementById('recapContent').innerHTML = `<div class="alert alert-error">${e.message}</div>`; }
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

function exportRecapXLSX() {
  if (!RECAP_DATA) return;
  const url = `/api/admin/recap.xlsx?month=${RECAP_DATA.month}&token=${TOKEN}`;
  window.open(url, '_blank');
}

function exportRecapPDF() {
  if (!RECAP_DATA) return;
  const biz = SETTINGS || {};
  const logoSrc = biz.has_logo ? `${location.origin}/api/logo` : null;
  const html = `<!doctype html><html><head><title>Rekap ${RECAP_DATA.month}</title>
    <link rel="stylesheet" href="/css/style.css">
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
          <div class="upload-preview">${s.has_logo ? `<img src="/api/logo?v=${Date.now()}">` : `<div class="placeholder">Belum ada logo</div>`}</div>
          <input type="file" id="se_logo_file" accept="image/*">
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button onclick="uploadAsset('logo')" class="btn-sm btn-approve">📤 Upload</button>
            ${s.has_logo ? '<button onclick="deleteAsset(\'logo\')" class="btn-sm btn-del">🗑️ Hapus</button>' : ''}
          </div>
        </div>
        <hr style="margin:14px 0;border:none;border-top:1px dashed var(--border);">
        <div>
          <strong>Hero Image (latar belakang beranda)</strong>
          <div class="upload-preview" style="height:120px;max-width:280px;">${s.has_hero ? `<img src="/api/hero?v=${Date.now()}">` : `<div class="placeholder">Belum ada hero image</div>`}</div>
          <input type="file" id="se_hero_file" accept="image/*">
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button onclick="uploadAsset('hero')" class="btn-sm btn-approve">📤 Upload</button>
            ${s.has_hero ? '<button onclick="deleteAsset(\'hero\')" class="btn-sm btn-del">🗑️ Hapus</button>' : ''}
          </div>
        </div>
      </div>

      <div class="setting-card">
        <h3>📱 QRIS</h3>
        <div class="upload-preview">${s.has_qris ? `<img src="/api/qris?v=${Date.now()}">` : `<div class="placeholder">Belum ada QRIS</div>`}</div>
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
    row.style.cssText = 'display:grid;grid-template-columns:140px 50px 1fr 36px;gap:8px;margin-bottom:8px;align-items:center;';
    row.innerHTML = `
      <select onchange="onSocialPlatformChange(${i}, this)" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
        ${platforms.map(p => `<option value="${p}" data-icon="${icons[p]}" ${sc.platform===p?'selected':''}>${icons[p]} ${p}</option>`).join('')}
      </select>
      <input type="text" value="${esc(sc.icon || icons[sc.platform] || '🌐')}" oninput="SETTINGS.socials[${i}].icon=this.value" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);text-align:center;font-size:1.1rem;">
      <input type="url" placeholder="https://instagram.com/username" value="${esc(sc.url || '')}" oninput="SETTINGS.socials[${i}].url=this.value" style="padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
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
  const res = await fetch('/api/admin/settings/upload', {
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
if (TOKEN && USER) {
  api('/api/admin/stats').then(() => showApp()).catch(() => showLogin());
} else {
  showLogin();
}
initTheme();
