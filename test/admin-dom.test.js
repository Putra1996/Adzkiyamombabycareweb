// Uji integrasi panel admin memakai DOM sungguhan (jsdom).
//
// Tujuan: menangkap kerusakan yang tidak terlihat oleh tes string —
// template yang melempar error saat dirender, elemen penting yang hilang,
// dan kegagalan jaringan yang membuat panel tampak "beku".
//
// jsdom bukan dependency produksi. Kalau belum terpasang, tes ini
// MENYILANGKAN dirinya sendiri (npm test tetap hijau). Untuk menjalankannya
// secara lokal:
//     npm install --no-save jsdom
//
// Catatan: skrip halaman disuntikkan sebagai <script> asli (runScripts:
// 'dangerously') supaya deklarasi `const` tingkat atas (mis. fmtRp di
// main.js) benar-benar menjadi binding global seperti di browser — kalau
// dijalankan lewat eval, binding-nya terisolasi dan tes memberi
// kesalahan palsu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* opsional */ }

const SETTINGS_FIXTURE = {
  business_name: 'Adzkiya Mom Baby Care', tagline: 'Layanan Ibu & Anak', address: 'Cilacap', phone: '0858',
  area: 'Nusawungu', type: 'Home Service', practitioner: 'Tasya Hanifah', instagram: '@adzkiya',
  has_logo: true, has_hero: false, has_qris: false, has_owner_signature: true,
  owner_signature_method: 'upload', owner_signature_at: '2026-09-01T00:00:00.000Z',
  hours: [{ day: 'Senin', open: '08:00', close: '20:00', closed: false }],
  testimonials: [{ name: 'Bunda A', text: 'Mantap', rating: 5 }],
  socials: [{ platform: 'instagram', url: 'https://instagram.com/adzkiya', has_icon: false }],
  bank_accounts: [{ bank: 'BSI', number: '7000', name: 'Tasya' }],
  blackout_dates: ['2026-12-25'], blackout_notes: { '2026-12-25': 'Natal' },
  reminder_hours_before: 2, notif_sound: true, gmaps_url: '', gmaps_embed: '', qris_link: '',
  primary_color: '#ee5a8a', accent_color: '#ffb979',
  has_ai_gemini: false, has_ai_openrouter: false, has_ai_wa_token: false,
  ai_assistant_enabled: false
};

const API_FIXTURES = {
  '/api/services': [{ cat: 'Basic Treatment Ibu', items: [{ name: 'Massage Ibu Hamil', price: 80000 }] }],
  '/api/admin/settings': SETTINGS_FIXTURE,
  '/api/admin/stats': { pending: 1, approved: 2, lunas: 2, omzet: 160000, total: 3 },
  '/api/admin/reservations': [{
    id: 1, patient_name: 'Bunda Uji', whatsapp: '0812', address: 'Jl. Uji',
    items: [{ name: 'Massage Ibu Hamil', price: 80000, qty: 1 }],
    slots: [{ date: '2026-09-20', time: '09:00' }], total: 80000, status: 'pending',
    payment_status: 'unpaid', reservation_date: '2026-09-20', reservation_time: '09:00',
    payment_method: 'COD', proof_file: null, created_at: '2026-09-19T00:00:00.000Z'
  }],
  '/api/admin/receipts': [{
    id: 1, invoice_no: 'INV-20260920-001', patient_name: 'Bunda Uji', whatsapp: '0812',
    total: 80000, subtotal: 80000, items: [{ name: 'Massage Ibu Hamil', price: 80000, qty: 1 }],
    service_date: '2026-09-20', service_time: '09:00', service_times: ['09:00'],
    created_at: '2026-09-20T00:00:00.000Z', transport_fee: 0, discount: 0
  }],
  '/api/admin/charts': {
    omzetByDay: [{ date: '2026-09-20', omzet: 80000, count: 1 }],
    topServices: [{ name: 'Massage', count: 1 }], payCount: { COD: 1 },
    statusCount: { pending: 1, approved: 0, rejected: 0 }, omzetByMonth: [{ month: '2026-09', omzet: 80000 }]
  },
  '/api/admin/recap': {
    month: '2026-09', months: 1, monthList: ['2026-09'], totalReservasi: 1, totalOmzet: 80000,
    totalKwitansi: 1, byMonth: [{ month: '2026-09', totalReservasi: 1, totalOmzet: 80000, totalKwitansi: 1 }], rows: []
  },
  '/api/admin/customers': { count: 0, customers: [] },
  '/api/admin/notifications': { server_time: '2026-09-20T00:00:00.000Z', last_id: 1, new_count: 0, new: [], reminder_hours: 2, reminders: [] },
  '/api/admin/expense-categories': [{ id: 'cat_bensin', name: 'Bensin', color: '#ee5a8a' }],
  '/api/admin/expenses': [],
  '/api/admin/accounting/summary': {
    months: 6, monthList: ['2026-09'], totals: { income: 80000, expense: 0, profit: 80000 },
    byMonth: [{ month: '2026-09', income: 80000, expense: 0, profit: 80000 }],
    expenses_by_category: {}, expense_categories: []
  },
  '/api/admin/broadcasts': [],
  '/api/admin/whatsapp/templates': [],
  '/api/admin/storage/status': {
    configured_storage: 'postgres', active_storage: 'file', db_connected: false, db_reachable: false,
    file_storage_persistent: false, file_storage_source: 'filesystem container',
    db_error: 'password authentication failed for user ***',
    live_counts: { reservations: 3, receipts: 4, expenses: 1, broadcasts: 0 },
    can_sync: true, using_runtime_connection: false
  },
  '/api/admin/ai/config': {
    enabled: false, has_gemini: false, has_openrouter: false, has_wa_phone_id: false, has_wa_token: false,
    has_app_secret: false, wa_verify_token: '', base_prompt: '', conversation_count: 0,
    webhook_url: 'https://contoh.up.railway.app/api/webhook/whatsapp'
  },
  '/api/admin/settings/owner-signature': { ok: true, has_signature: false, data_url: null },
  '/health': {
    ok: true, storage: 'file', configured_storage: 'postgres', db_connected: false, db_reachable: false,
    file_persistent: false, db_error: 'password authentication failed for user ***'
  }
};

function jsonResponse(payload) {
  return {
    ok: true, status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null }
  };
}

async function bootAdmin() {
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://contoh.up.railway.app/admin' });
  const { window } = dom;
  const runtimeErrors = [];

  window.localStorage.setItem('adm_token', 'token-uji');
  window.localStorage.setItem('adm_user', JSON.stringify({ id: 1, email: 'a@b.id', name: 'Tasya', role: 'super' }));
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  window.fetch = async (url) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (!(key in API_FIXTURES)) return jsonResponse({});
    return jsonResponse(API_FIXTURES[key]);
  };
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  window.URL.createObjectURL = () => 'blob:uji';
  window.addEventListener('error', (e) => runtimeErrors.push((e.error && e.error.message) || e.message));
  window.onunhandledrejection = (e) => runtimeErrors.push('unhandled: ' + ((e.reason && e.reason.message) || e.reason));

  // Muat skrip dengan urutan yang sama seperti admin.html.
  const scripts = ['public/js/api-config.js', 'public/js/i18n.js', 'public/js/main.js', 'public/js/admin.js'];
  for (const rel of scripts) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    window.document.head.appendChild(el);
  }
  // Panel mem-boot sendiri saat token tersimpan di localStorage
  // (loadCache → navigate('dashboard')). Tunggu sampai proses itu selesai
  // supaya render pertama tidak bertabrakan dengan render di dalam tes —
  // di browser hal ini tidak terjadi karena boot hanya sekali.
  await new Promise((resolve) => setTimeout(resolve, 250));
  runtimeErrors.length = 0; // error boot tidak dihitung sebagai error render halaman
  return { window, runtimeErrors };
}

test('Panel admin: semua halaman render tanpa error di DOM sungguhan', { skip: JSDOM ? false : 'jsdom tidak terpasang (npm install --no-save jsdom)' }, async () => {
  const { window, runtimeErrors } = await bootAdmin();
  const renderers = {
    dashboard: 'renderDashboard', reservations: 'renderReservations', notifications: 'renderNotifications',
    calendar: 'renderCalendarAdmin', receipts: 'renderReceipts', recap: 'renderRecap',
    broadcast: 'renderBroadcast', customers: 'renderCustomers', accounting: 'renderAccounting',
    backup: 'renderBackup', settings: 'renderSettings'
  };
  // PENTING: panggil handler-nya LANGSUNG, bukan lewat navigate(). navigate()
  // memanggil handler yang sama tanpa ditunggu, sehingga di tes dua render
  // bersamaan bisa saling menimpa — itu artefak harness, bukan bug aplikasi.
  for (const [page, fn] of Object.entries(renderers)) {
    await window.eval(`(async () => { CURRENT_PAGE = ${JSON.stringify(page)}; if (typeof ${fn} === 'function') await ${fn}(); })()`);
    const html = window.document.getElementById('pageContent').innerHTML;
    assert.ok(html && html.length > 200, `halaman ${page} menghasilkan konten kosong/pendek`);
    assert.ok(!/Gagal memuat halaman/.test(html), `halaman ${page} menampilkan kartu error`);
  }
  assert.deepEqual(runtimeErrors, [], 'ada error runtime saat merender panel');
});

test('Panel admin: elemen penting halaman Pengaturan ada', { skip: JSDOM ? false : 'jsdom tidak terpasang' }, async () => {
  const { window } = await bootAdmin();
  // Render tunggal & deterministik: sebut handler-nya langsung supaya tidak
  // ada dua render bersamaan (navigate() juga memanggil renderSettings).
  await window.eval(`(async () => { CURRENT_PAGE = 'settings'; await renderSettings(); })()`);
  // renderSettings() memanggil loadStorageStatus() tanpa await; beri waktu
  // satu putaran event loop supaya kartu status ikut terisi.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const html = window.document.getElementById('pageContent').innerHTML;
  const wajib = {
    'kartu Status Penyimpanan': 'Status Penyimpanan Data',
    'tombol sinkronkan penyimpanan': 'storageSyncBtn',
    'formulir perbaikan koneksi': 'stConnUrl',
    'tombol Tes Koneksi DB': 'testStorageConnection()',
    'panel AI': 'aiAssistantSaveBtn',
    'tombol diagnosa WhatsApp': 'aiAssistantDiagBtn',
    'alert database belum terhubung': 'Database belum terhubung'
  };
  for (const [label, needle] of Object.entries(wajib)) {
    assert.ok(html.includes(needle), `elemen hilang: ${label} (${needle})`);
  }
});

test('Panel admin: kegagalan API menampilkan pesan + tombol coba lagi (bukan layar beku)', { skip: JSDOM ? false : 'jsdom tidak terpasang' }, async () => {
  const { window } = await bootAdmin();
  // Paksa /api/admin/settings gagal seperti jaringan putus.
  window.fetch = async (url) => {
    const key = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (key === '/api/admin/settings') throw new Error('Failed to fetch');
    if (key in API_FIXTURES) return jsonResponse(API_FIXTURES[key]);
    return jsonResponse({});
  };
  await window.eval(`(async () => { await navigate('settings'); })()`);
  const html = window.document.getElementById('pageContent').innerHTML;
  assert.ok(/Gagal memuat halaman/.test(html), 'kartu error tidak muncul saat API gagal');
  assert.ok(html.includes('Coba Lagi'), 'tombol "Coba Lagi" tidak ada');
  assert.ok(/Failed to fetch/.test(html), 'pesan penyebab kegagalan tidak ditampilkan ke admin');
});
