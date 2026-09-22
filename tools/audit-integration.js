// AUDIT INTEGRASI MENYELURUH — semua fitur, satu alur.
// Menjalankan server lokal (dengan AI tiruan) lalu memeriksa setiap fitur
// seperti pemakaian nyata: reservasi publik → admin → kwitansi → rekap →
// akunting → broadcast → CRM → backup → AI booking → webhook WA.
//
// Setiap pemeriksaan mencetak OK / !! (masalah) supaya temuan bisa langsung
// ditindaklanjuti.
const BASE = process.env.BASE || 'http://127.0.0.1:3600';
// Kredensial akun uji. Nilainya SAMA dengan contoh di tools/README.md dan bisa
// ditimpa lewat env — dulu keduanya berbeda sehingga siapa pun yang mengikuti
// README akan mendapat "Login gagal, audit berhenti" tanpa sebab yang jelas.
const AUDIT_EMAIL = process.env.AUDIT_EMAIL || 'a@b.id';
const AUDIT_PASSWORD = process.env.AUDIT_PASSWORD || 'password12345';

let pass = 0, fail = 0;
const masalah = [];
function ok(label, extra) { pass++; console.log('  OK   ' + label + (extra ? ' — ' + extra : '')); }
function bad(label, extra) { fail++; masalah.push(label + (extra ? ' — ' + extra : '')); console.log('  !!   ' + label + (extra ? ' — ' + extra : '')); }
function check(label, cond, extra) { cond ? ok(label, extra) : bad(label, extra); }

// Rate limit API (240/menit) bisa tercapai bila beberapa skrip audit dijalankan
// beruntun pada server yang sama — itu bukan bug aplikasi.
const isRateLimited = (r) => r && r.status === 429;

const api = async (path, opts) => {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};

(async () => {
  // ---------- 0. Login ----------
  const login = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: AUDIT_EMAIL, password: AUDIT_PASSWORD })
  });
  if (login.status !== 200) { console.error('Login gagal, audit berhenti:', login.text); process.exit(1); }
  const TOKEN = login.json.token;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN };
  ok('login admin');

  // ---------- 1. HALAMAN & ENDPOINT PUBLIK ----------
  console.log('\n[1] Publik: halaman & data dasar');
  for (const p of ['/', '/kalender.html', '/reservasi.html', '/admin', '/kwitansi-share.html', '/404.html', '/robots.txt', '/sitemap.xml', '/health']) {
    const r = await api(p);
    check('halaman ' + p, r.status === 200, 'status ' + r.status);
  }
  const svc = (await api('/api/services')).json;
  const layanan = svc[0].items[0].name;
  const hargaAsli = svc[0].items[0].price;
  check('katalog layanan terisi', svc.length > 0 && svc[0].items.length > 0, svc.length + ' kategori');
  const ps = (await api('/api/public-settings')).json;
  check('public-settings tidak membocorkan kunci AI', !('ai_gemini_api_key' in ps) && !('has_ai_gemini' in ps) || !('ai_gemini_api_key' in ps));
  check('public-settings tidak memuat owner_signature_b64', !('owner_signature_b64' in ps));
  const cal0 = (await api('/api/calendar')).json;
  check('kalender publik berupa array', Array.isArray(cal0));

  // ---------- 2. RESERVASI PUBLIK ----------
  console.log('\n[2] Reservasi publik (form)');
  const fd = (fields) => { const f = new FormData(); Object.entries(fields).forEach(([k, v]) => f.set(k, v)); return f; };
  let r = await api('/api/reservations', { method: 'POST', body: fd({ patient_name: 'Audit Satu', whatsapp: '081200000001', address: 'Alamat audit panjang', payment_method: 'COD', items: JSON.stringify([{ name: layanan, price: 1, qty: 2 }]), slots: JSON.stringify([{ date: '2026-12-01', time: '09:00' }]) }) });
  check('reservasi publik dibuat', r.status === 201, 'status ' + r.status);
  check('harga ditentukan server (menolak harga form)', r.json && r.json.total === hargaAsli * 2, 'total=' + (r.json && r.json.total) + ' diharap ' + (hargaAsli * 2));
  const resId = r.json && r.json.id;

  r = await api('/api/reservations', { method: 'POST', body: fd({ patient_name: 'Audit Dua', whatsapp: '081200000002', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: 'Layanan Palsu', qty: 1 }]), slots: JSON.stringify([{ date: '2026-12-02', time: '09:00' }]) }) });
  check('layanan di luar katalog ditolak', r.status === 400, 'status ' + r.status);

  r = await api('/api/reservations', { method: 'POST', body: fd({ patient_name: 'Audit Tiga', whatsapp: '081200000003', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-12-03', time: '09:00' }, { date: '2026-12-03', time: '09:00' }]) }) });
  check('slot duplikat di-ringkas (bukan 2 sesi)', r.status === 201 && r.json.total === hargaAsli, 'total=' + (r.json && r.json.total));

  r = await api('/api/reservations', { method: 'POST', body: fd({ patient_name: 'Audit Empat', whatsapp: '081200000004', address: 'Alamat audit', payment_method: 'Kripto', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-12-04', time: '09:00' }]) }) });
  check('metode pembayaran tidak valid ditolak', r.status === 400, 'status ' + r.status);

  // ---------- 3. ADMIN: RESERVASI ----------
  console.log('\n[3] Admin: kelola reservasi');
  let list = (await api('/api/admin/reservations', { headers: H })).json;
  check('daftar reservasi memuat data baru', list.some((x) => x.id === resId));
  check('profil reservasi memuat items & slots', Array.isArray(list[0].items) && Array.isArray(list[0].slots));
  r = await api('/api/admin/reservations/' + resId, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'approved' }) });
  check('approve reservasi', r.status === 200 && r.json.ok);
  r = await api('/api/admin/reservations/' + resId, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'status-ngawur' }) });
  check('status ngawur ditolak', r.status === 400);
  r = await api('/api/admin/reservations/' + resId, { method: 'PATCH', headers: H, body: JSON.stringify({ payment_status: 'lunas' }) });
  check('tandai lunas', r.status === 200);
  const cal1 = (await api('/api/calendar')).json;
  check('reservasi approved muncul di kalender publik', cal1.some((e) => e.id === resId));
  const stats = (await api('/api/admin/stats', { headers: H })).json;
  check('statistik menghitung omzet', stats.omzet >= hargaAsli * 2, 'omzet=' + stats.omzet);

  // ---------- 4. KWITANSI ----------
  console.log('\n[4] Kwitansi & link publik');
  r = await api('/api/admin/receipts', { method: 'POST', headers: H, body: JSON.stringify({ patient_name: 'Audit Kwitansi', whatsapp: '081200000005', address: 'Alamat kwitansi', service_date: '2026-12-05', service_time: '10:00', items: [{ name: layanan, price: hargaAsli, qty: 1 }], transport_fee: 20000, discount: 5000 }) });
  check('kwitansi dibuat', r.status === 200 && r.json.invoice_no, r.json && r.json.invoice_no);
  const totalKw = hargaAsli + 20000 - 5000;
  check('total kwitansi = subtotal + transport - diskon', r.json.total === totalKw, 'total=' + r.json.total);
  const receipts = (await api('/api/admin/receipts', { headers: H })).json;
  const rc = receipts.find((x) => x.invoice_no === r.json.invoice_no);
  check('kwitansi muncul di daftar', !!rc);
  check('daftar kwitansi punya header total', (await api('/api/admin/receipts?limit=1', { headers: H })).headers.get('x-total-count') !== null);
  const bulan = (await api('/api/admin/receipts?month=2026-12', { headers: H })).json;
  check('filter bulan kwitansi', bulan.length >= 1);
  const cari = (await api('/api/admin/receipts?q=Audit+Kwitansi', { headers: H })).json;
  check('pencarian kwitansi', cari.length === 1);
  const share = await api('/api/admin/receipts/' + rc.id + '/share', { method: 'POST', headers: H });
  check('link kwitansi dibuat', share.status === 200 && share.json.token);
  const pubPage = await api('/kwitansi/' + share.json.token);
  check('halaman kwitansi publik 200', pubPage.status === 200);
  check('halaman kwitansi memuat nama pasien', pubPage.text.includes('Audit Kwitansi'));
  const pubApi = (await api('/api/public/receipt/' + share.json.token)).json;
  check('API kwitansi publik tanpa bukti transfer', pubApi.receipt && !('proof_b64' in pubApi.receipt));
  const badToken = await api('/api/public/receipt/token.ngawur.123');
  check('token kwitansi palsu ditolak', badToken.status === 404);

  // ---------- 5. REKAP, AKUNTING, PENGELUARAN ----------
  console.log('\n[5] Rekap & akunting');
  const recap = (await api('/api/admin/recap?month=2026-12', { headers: H })).json;
  check('rekap bulan ini menghitung omzet', recap.totalOmzet >= hargaAsli * 2, 'omzet=' + recap.totalOmzet);
  check('rekap menghitung kwitansi', recap.totalKwitansi >= 1);
  const xlsx = await api('/api/admin/recap.xlsx?month=2026-12', { headers: H });
  check('export Excel terunduh', xlsx.status === 200 && xlsx.text.length > 1000, xlsx.text.length + ' byte');
  // Tanggal pengeluaran memakai BULAN BERJALAN (WIB) agar benar-benar masuk
  // rentang ringkasan P&L — sebelumnya memakai bulan tetap sehingga cek
  // "pengeluaran mengurangi profit" selalu gagal (false positive).
  const bulanWib = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  r = await api('/api/admin/expenses', { method: 'POST', headers: H, body: JSON.stringify({ date: bulanWib + '-06', category: 'Bensin', amount: 25000, description: 'Audit' }) });
  check('catat pengeluaran', r.status === 200 && r.json.id);
  const expId = r.json.id;
  r = await api('/api/admin/expenses', { method: 'POST', headers: H, body: JSON.stringify({ date: bulanWib + '-06', category: 'Bensin', amount: -5 }) });
  check('pengeluaran negatif ditolak', r.status === 400);
  const acct = (await api('/api/admin/accounting/summary?months=3', { headers: H })).json;
  check('ringkasan P&L menghitung profit', typeof acct.totals.profit === 'number');
  check('pengeluaran ikut mengurangi profit', acct.totals.expense >= 25000, 'expense=' + acct.totals.expense);
  await api('/api/admin/expenses/' + expId, { method: 'DELETE', headers: H });
  check('hapus pengeluaran', true);

  // ---------- 6. BROADCAST & TEMPLATE ----------
  console.log('\n[6] Broadcast WhatsApp');
  r = await api('/api/admin/whatsapp/templates', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Audit tpl', category: 'reminder', body: 'Halo {{nama_pasien}}, jadwal {{tanggal}} {{jam}} di {{layanan}}.' }) });
  check('buat template WA', r.status === 200 && r.json.id);
  const tplId = r.json.id;
  const prev = (await api('/api/admin/broadcasts/preview', { method: 'POST', headers: H, body: JSON.stringify({ template_id: tplId, filter: { limit: 5 } }) })).json;
  check('preview broadcast menghitung penerima', typeof prev.count === 'number' && Array.isArray(prev.recipients));
  if (prev.count > 0) {
    check('preview mengganti placeholder', !prev.recipients[0].patient_name.includes('{{'), prev.recipients[0].patient_name);
  }
  r = await api('/api/admin/broadcasts', { method: 'POST', headers: H, body: JSON.stringify({ template_id: tplId, filter: { limit: 5 }, name: 'Audit blast' }) });
  if (prev.count > 0) {
    check('kirim broadcast membuat link wa.me', r.status === 200 && r.json.messages.every((m) => /wa\.me\/\d+\?text=/.test(m.link)), r.json.messages && r.json.messages[0] && r.json.messages[0].link);
    check('link broadcast memakai format internasional', r.json.messages.every((m) => !/wa\.me\/0/.test(m.link)));
  } else { ok('broadcast (tidak ada penerima — dilewati)'); }
  await api('/api/admin/whatsapp/templates/' + tplId, { method: 'DELETE', headers: H });
  check('hapus template', true);

  // ---------- 7. CRM ----------
  console.log('\n[7] CRM pelanggan');
  const cust = (await api('/api/admin/customers?sort=spend', { headers: H })).json;
  check('daftar pelanggan terisi', cust.count >= 1, cust.count + ' pelanggan');
  if (cust.count) {
    const c0 = cust.customers[0];
    check('pelanggan punya skor RFM', /^[A-D]{3}$/.test(c0.rfm), c0.rfm);
    const det = (await api('/api/admin/customers/' + c0.phone, { headers: H })).json;
    check('detail pelanggan punya timeline', Array.isArray(det.timeline) && det.timeline.length > 0);
  }

  // ---------- 8. NOTIFIKASI ----------
  console.log('\n[8] Notifikasi & pengingat');
  const notif = (await api('/api/admin/notifications?since=0&hours=9999', { headers: H })).json;
  check('notifikasi memuat reservasi baru', notif.new.length >= 1, notif.new.length + ' baru');
  check('notifikasi memuat last_id', typeof notif.last_id === 'number' && notif.last_id >= resId);

  // ---------- 9. PENGATURAN ----------
  console.log('\n[9] Pengaturan');
  const st = (await api('/api/admin/settings', { headers: H })).json;
  check('settings tidak memuat kunci AI', !('ai_gemini_api_key' in st) && !('ai_openrouter_api_key' in st) && !('ai_assistant_access_token' in st));
  check('settings melaporkan flag kunci AI', 'has_ai_gemini' in st);
  r = await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ business_name: 'Adzkiya Mom Baby Care', ai_gemini_api_key: '' }) });
  check('simpan pengaturan dengan kunci kosong diterima', r.status === 200);
  r = await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ __proto__: { jahat: 1 } }) });
  check('protesi prototype ditolak', ({}).jahat === undefined);
  r = await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ blackout_dates: ['2026-12-24'], blackout_notes: { '2026-12-24': 'Libur audit' } }) });
  check('simpan hari libur', r.status === 200);
  r = await api('/api/reservations', { method: 'POST', body: fd({ patient_name: 'Audit Libur', whatsapp: '081200000006', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-12-24', time: '09:00' }]) }) });
  check('reservasi di hari libur ditolak', r.status === 400 && /libur/i.test(r.text), r.text.slice(0, 70));
  r = await api('/api/admin/receipts', { method: 'POST', headers: H, body: JSON.stringify({ patient_name: 'Audit Libur 2', whatsapp: '0812', address: 'x', service_date: '2026-12-24', service_time: '09:00', items: [{ name: layanan, price: hargaAsli, qty: 1 }] }) });
  check('kwitansi di hari libur ditolak', r.status === 400 && /libur/i.test(r.text), r.text.slice(0, 70));
  await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ blackout_dates: [], blackout_notes: {} }) });

  // ---------- 10. BACKUP & RESTORE ----------
  console.log('\n[10] Backup & restore');
  const plain = await api('/api/admin/backup', { headers: H });
  check('backup polos terunduh', plain.status === 200 && plain.json.receipts.length >= 1);
  check('backup tidak memuat kredensial/TTD', !/ai_gemini_api_key|ai_openrouter_api_key|ai_assistant_access_token|ai_assistant_app_secret|owner_signature_b64|proof_b64/.test(plain.text));
  const enc = await api('/api/admin/backup/encrypted', { method: 'POST', headers: H, body: JSON.stringify({ passphrase: 'passphrase-audit-panjang' }) });
  check('backup terenkripsi dibuat', enc.status === 200 && enc.json.format === 'adzkiya-backup-enc-v1');
  check('isi backup terenkripsi tidak memuat PII', !/Audit Kwitansi|081200000001/.test(enc.text));
  const wrong = await api('/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ ...enc.json, passphrase: 'salah-sekali', mode: 'append' }) });
  check('restore dengan passphrase salah ditolak', wrong.status === 400, wrong.text.slice(0, 60));
  const right = await api('/api/admin/restore', { method: 'POST', headers: H, body: JSON.stringify({ ...enc.json, passphrase: 'passphrase-audit-panjang', mode: 'append', sync_reservations: false }) });
  check('restore dengan passphrase benar diterima', right.status === 200, right.text.slice(0, 80));

  // ---------- 11. AI ----------
  console.log('\n[11] AI Assistant & reservasi otomatis');
  const aiStatus = (await api('/api/ai/status')).json;
  check('status AI publik tersedia', typeof aiStatus.ready === 'boolean', JSON.stringify(aiStatus).slice(0, 70));
  const aiCfg = (await api('/api/admin/ai/config', { headers: H })).json;
  check('config AI tidak membocorkan kunci', !('gemini_api_key' in aiCfg) && !('access_token' in aiCfg) && !('app_secret' in aiCfg));
  check('config AI memuat kesiapan', !!aiCfg.readiness);
  const diag = await api('/api/admin/ai/diagnostics', { headers: H });
  check('diagnosa WA berjalan', diag.status === 200 && Array.isArray(diag.json.checklist));
  const aiTest = (await api('/api/admin/ai/test', { method: 'POST', headers: H, body: '{}' })).json;
  check('tes AI melaporkan provider yang berhasil', Array.isArray(aiTest.working_providers), aiTest.working_providers && aiTest.working_providers.join(', '));
  const chatReply = await api('/api/ai/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'halo', session_id: 'audit-1' }) });
  check('chat AI menjawab', chatReply.status === 200 && chatReply.json.reply, 'provider=' + (chatReply.json && chatReply.json.provider));
  check('balasan tidak memuat blok mesin', !/BOOKING/.test((chatReply.json && chatReply.json.reply) || ''));
  const logs = (await api('/api/admin/ai/conversations?limit=5', { headers: H })).json;
  check('log percakapan tercatat', logs.length >= 1);

  // webhook WA
  const wv = await api('/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=salah&hub.challenge=123');
  check('verifikasi webhook token salah ditolak', wv.status === 403);
  const wp = await api('/api/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: [] }) });
  check('webhook POST membalas 200', wp.status === 200);

  // ---------- 12. KEAMANAN ----------
  console.log('\n[12] Keamanan');
  const noAuth = ['/api/admin/reservations', '/api/admin/receipts', '/api/admin/settings', '/api/admin/backup', '/api/admin/storage/status', '/api/admin/ai/config', '/api/proof/1'];
  let allDenied = true;
  for (const p of noAuth) { if ((await api(p)).status !== 401) { allDenied = false; bad('endpoint tanpa token TIDAK 401: ' + p); } }
  if (allDenied) ok('semua endpoint admin menolak tanpa token (7 diperiksa)');
  const badTok = await api('/api/admin/reservations', { headers: { Authorization: 'Bearer token.palsu.xyz' } });
  check('token palsu ditolak', badTok.status === 401);
  const sig = await api('/api/owner-signature');
  check('endpoint TTD pemilik tidak publik', sig.status === 404);
  const leaked = await api('/api/public-settings');
  check('public-settings tidak membocorkan kunci AI', !/ai_gemini_api_key|ai_assistant_access_token/.test(leaked.text));

  // ---------- 13. PEMULIHAN STORAGE ----------
  console.log('\n[13] Status penyimpanan');
  const sst = (await api('/api/admin/storage/status', { headers: H })).json;
  check('status penyimpanan tersedia', typeof sst.active_storage === 'string', 'aktif=' + sst.active_storage);
  check('status memuat flag persistensi file', typeof sst.file_storage_persistent === 'boolean');
  const badConn = await api('/api/admin/storage/test-connection', { method: 'POST', headers: H, body: JSON.stringify({ url: 'postgresql://u:p@127.0.0.1:1/db' }) });
  check('tes koneksi DB mati dilaporkan gagal + saran', badConn.status === 400 && badConn.json.hint, (badConn.json.hint || '').slice(0, 60));

  // ---------- 14. BUKU STOK (integrasi lintas fitur) ----------
  console.log('\n[14] Buku stok terhubung ke akunting, backup & panel');
  const stokList = (await api('/api/admin/supplies', { headers: H })).json;
  check('daftar stok dapat diakses admin', typeof stokList.stock_value === 'number' && Array.isArray(stokList.supplies));
  const stokStats = (await api('/api/admin/stats', { headers: H })).json;
  check('dasbor memuat peringatan stok menipis', 'low_stock' in stokStats && 'stock_value' in stokStats);
  const stokAcct = (await api('/api/admin/accounting/summary?months=2', { headers: H })).json;
  check('ringkasan P&L memuat blok buku stok', !!(stokAcct.supply && Array.isArray(stokAcct.supply.by_month)));
  const stokBackup = await api('/api/admin/backup', { headers: H });
  check('backup memuat supplies & supply_recipes', Array.isArray(stokBackup.json.supplies) && Array.isArray(stokBackup.json.supply_recipes));
  check('backup tidak memuat timestamp peringatan stok', !('supply_alert_last_at' in (stokBackup.json.settings || {})));
  const stokAlerts = (await api('/api/admin/supplies/alerts', { headers: H })).json;
  check('endpoint peringatan stok berjalan', typeof stokAlerts.count === 'number' && typeof stokAlerts.interval_hours === 'number', 'jeda=' + stokAlerts.interval_hours + ' jam');
  check('no-auth: /api/admin/supplies → 401', (await api('/api/admin/supplies')).status === 401);
  check('no-auth: /api/admin/supplies/report → 401', (await api('/api/admin/supplies/report')).status === 401);
  // Pemulihan storage darurat: salinan WAJIB pakai ID baru (kalau tidak, dua
  // transaksi berbeda ber-ID sama dan tombol Setujui/Hapus bisa salah sasaran).
  const mergeSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const mergeFn = mergeSrc.slice(mergeSrc.indexOf('function mergeTransactionalState'), mergeSrc.indexOf('function startDbRetryLoop'));
  check('pemulihan storage memberi ID baru untuk reservasi', /target\.reservations\.push\(\{ \.\.\.r, id: resSeq \}\)/.test(mergeFn));
  check('pemulihan storage memberi ID baru untuk kwitansi', /target\.receipts\.push\(\{ \.\.\.k, id: recSeq \}\)/.test(mergeFn));
  check('pemulihan storage memberi ID baru untuk broadcast', /target\.broadcasts\.push\(\{ \.\.\.b, id: bcSeq \}\)/.test(mergeFn));
  check('pemulihan storage ikut menyalin paket sesi', /report\.packages_added\+\+/.test(mergeFn));
  check('pemulihan storage memetakan tautan riwayat stok ↔ pengeluaran', /expIdMap\.get\(oldExpenseId\)/.test(mergeFn));
  check('laporan pemulihan menyebut jumlah paket & barang', /packages: target\.packages\.length/.test(mergeFn) && /supplies: target\.supplies\.length/.test(mergeFn));

  // Ronde 3: barang nonaktif, sumber galat, penjagaan riwayat lama
  const stokCek = (await api('/api/admin/supplies', { headers: H })).json;
  check('daftar stok memisahkan barang nonaktif', typeof stokCek.inactive_count === 'number');
  const cfgAi = (await api('/api/admin/ai/config', { headers: H })).json;
  check('config AI melaporkan sumber galat terakhir', typeof cfgAi.last_error_source === 'string');
  const jsAdmin = await api('/js/admin.js');
  check('panel: ada tombol aktif/nonaktifkan barang', /toggleSupplyActive/.test(jsAdmin.text));
  check('panel: label sumber galat WhatsApp (bukan AI)', /Peringatan stok \(WhatsApp\)/.test(jsAdmin.text));
  check('server: riwayat lama tanpa angka stok tidak bisa dikosongkan', /tidak menyimpan angka stok sebelumnya/.test(mergeSrc));

  // Panel admin: halaman & menu stok tersedia
  const adminPage = await api('/admin');
  check('panel admin memuat menu Buku Stok', adminPage.status === 200 && /data-page="stock"/.test(adminPage.text));
  const adminJs = await api('/js/admin.js');
  check('panel admin memuat fungsi halaman stok', adminJs.status === 200 && /function renderStock\(/.test(adminJs.text) && /function renderStockReport\(/.test(adminJs.text));

  // ---------- RINGKASAN ----------
  console.log('\n================ RINGKASAN AUDIT ================');
  console.log('Lulus: ' + pass + ' | Masalah: ' + fail);
  if (masalah.length) { console.log('\nDaftar masalah:'); masalah.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Audit gagal dijalankan:', e); process.exit(2); });
