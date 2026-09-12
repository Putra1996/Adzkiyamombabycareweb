// Kalender publik — compact, mobile-friendly, dengan indikator Penuh.
// Logika-nya identik dengan admin kalender (renderCalendarAdmin di
// public/js/admin.js). Pasien dapat klik tanggal untuk lihat detail
// sesi (jam + daftar layanan) plus status. Data pribadi (nama, HP,
// alamat) TIDAK ditampilkan — sesuai dengan privasi yang diminta di
// menu admin.
//
// "Penuh" = jumlah sesi booked pada hari itu >= MAX_SESSIONS_PER_DAY.
// Default 4 sesi/hari. Bisa diubah via ?max=<n> di URL.
const MAX_SESSIONS_PER_DAY = parseInt(new URLSearchParams(location.search).get('max') || '4', 10);

let viewDate = new Date();
let events = [];

// Fetch events from /api/calendar (server already flattens each slot
// into one event with reservation_date + reservation_time +
// service_name).
async function loadEvents() {
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    events = await res.json();
  } catch (e) {
    events = [];
    console.warn('Calendar events not loaded:', e);
  }
  renderCalendar();
}

function countEventsOn(dateStr) {
  return events.filter((e) => e.reservation_date === dateStr).length;
}

function renderCalendar() {
  const y = viewDate.getFullYear();
  const m = viewDate.getMonth();
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  document.getElementById('calLabel').textContent = `${monthNames[m]} ${y}`;

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';
  const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  dayNames.forEach((d) => {
    const h = document.createElement('div');
    h.className = 'cal-cell head';
    h.textContent = d;
    grid.appendChild(h);
  });

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  for (let i = firstDay - 1; i >= 0; i--) {
    const c = document.createElement('div');
    c.className = 'cal-cell muted';
    c.innerHTML = `<span class="day-num">${prevDays - i}</span>`;
    grid.appendChild(c);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cellDate = new Date(y, m, d);
    const isPast = cellDate < todayMidnight;
    const count = countEventsOn(dateStr);
    const isFull = count >= MAX_SESSIONS_PER_DAY;
    const dayEvents = events.filter((e) => e.reservation_date === dateStr);

    const c = document.createElement('div');
    let classes = 'cal-cell';
    if (dateStr === todayStr) classes += ' today';
    if (isFull && !isPast) classes += ' full';
    else if (count > 0 && !isPast) classes += ' has-events';
    if (isPast) classes += ' past';
    c.className = classes;
    c.style.cursor = 'pointer';
    c.title = `${d} ${monthNames[m]} ${y}${count ? ' — ' + count + ' sesi' : ''}${isFull ? ' (Penuh)' : ''}`;
    c.onclick = () => openDateDetail(dateStr, dayEvents, isFull);

    let html = `<span class="day-num">${d}</span>`;
    if (count > 0 && !isPast) {
      const badgeText = isFull ? `${count} 🛑` : `${count}`;
      html += `<span class="count-badge" title="${count} sesi${isFull ? ' — Penuh' : ''}">${badgeText}</span>`;
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

// Show the day's events with services + times + status. NO personal
// data — same privacy posture as the admin calendar detail panel.
// dayEvents are flat {reservation_date, reservation_time, service_name}
// entries from /api/calendar. service_name may already concatenate
// items (e.g. "Massage + Sleepwell") when a reservation has multiple.
function openDateDetail(dateStr, dayEvents, isFull) {
  const detail = document.getElementById('dateDetail');
  const title = document.getElementById('dateDetailTitle');
  const content = document.getElementById('dateDetailContent');
  if (!detail) return;
  const dateLabel = new Date(dateStr + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  title.textContent = `📅 ${dateLabel}`;
  if (!dayEvents.length) {
    content.innerHTML = `
      <p style="color:var(--text-soft);margin:6px 0 0;">Tidak ada treatment terjadwal di tanggal ini — semua jam masih tersedia. Silakan reservasi kapan saja.</p>
      <p style="margin-top:14px;"><a href="/reservasi.html" class="btn btn-primary" style="display:inline-block;text-decoration:none;">📅 Buat Reservasi di Tanggal Ini</a></p>`;
  } else {
    // Sort by time so patients see the schedule in order
    const sorted = dayEvents.slice().sort((a, b) => (a.reservation_time || '').localeCompare(b.reservation_time || ''));
    const list = sorted.map((e) => `
      <div style="display:flex;gap:10px;align-items:center;padding:10px 12px;margin-top:6px;background:var(--pink-50);border-radius:8px;border-left:3px solid var(--primary);">
        <div style="font-weight:700;color:var(--primary);min-width:54px;font-size:0.92rem;">${esc((e.reservation_time || '').slice(0, 5))}</div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:0.92rem;">${esc(e.service_name || '-')}</div>
          <div style="color:var(--text-soft);font-size:0.78rem;margin-top:2px;">Sesi ${esc((e.reservation_time || '').slice(0, 5))} WIB</div>
        </div>
      </div>
    `).join('');
    const fullNote = isFull
      ? `<div style="margin-top:12px;padding:12px 14px;background:#fde0e4;color:#c43050;border-radius:8px;font-weight:600;font-size:0.92rem;line-height:1.5;">🛑 Hari ini sudah penuh (${dayEvents.length} sesi). Silakan pilih tanggal lain yang jadwalnya lebih longgar.</div>`
      : `<div style="margin-top:12px;padding:12px 14px;background:#d9efe1;color:#1e8957;border-radius:8px;font-weight:600;font-size:0.92rem;line-height:1.5;">✅ Tersisa ${Math.max(0, MAX_SESSIONS_PER_DAY - dayEvents.length)} slot lagi untuk hari ini — masih bisa reservasi.</div>`;
    const reserveCta = `<p style="margin-top:14px;"><a href="/reservasi.html" class="btn btn-primary" style="display:inline-block;text-decoration:none;">📅 Buat Reservasi</a></p>`;
    const note = `<p style="margin-top:14px;padding:10px 12px;background:var(--bg);border-radius:8px;color:var(--text-soft);font-size:0.78rem;line-height:1.5;border:1px dashed var(--border);">
      🔒 <strong>Privasi:</strong> Nama pasien & WhatsApp tidak ditampilkan. Hanya jadwal layanan untuk transparansi ketersediaan.
    </p>`;
    content.innerHTML = `${list}${fullNote}${reserveCta}${note}`;
  }
  detail.style.display = 'block';
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDetail() {
  const detail = document.getElementById('dateDetail');
  if (detail) detail.style.display = 'none';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function prevMonth() { viewDate.setMonth(viewDate.getMonth() - 1); renderCalendar(); closeDetail(); }
function nextMonth() { viewDate.setMonth(viewDate.getMonth() + 1); renderCalendar(); closeDetail(); }
function todayBtn() { viewDate = new Date(); renderCalendar(); closeDetail(); }

loadEvents();
