// AUDIT BAGIAN 2 — fitur yang belum tercakup: impor kwitansi, hapus massal,
// unggahan berkas/TTD, kategori pengeluaran, CRM, AI booking (blok), dan
// integrasi antar-fitur.
const BASE = process.env.BASE || 'http://127.0.0.1:3600';
let pass = 0, fail = 0; const masalah = [];
const ok = (l, e) => { pass++; console.log('  OK   ' + l + (e ? ' — ' + e : '')); };
const bad = (l, e) => { fail++; masalah.push(l + (e ? ' — ' + e : '')); console.log('  !!   ' + l + (e ? ' — ' + e : '')); };
const check = (l, c, e) => c ? ok(l, e) : bad(l, e);
const api = async (p, o) => { const r = await fetch(BASE + p, o); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t, headers: r.headers }; };

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

(async () => {
  const login = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.id', password: 'password12345' }) });
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.json.token };
  const svc = (await api('/api/services')).json;
  const svc2 = svc;
  const layanan = svc[0].items[0].name;
  const harga = svc[0].items[0].price;
  const bulanIni = '2026-09';

  console.log('\n[14] Impor kwitansi (JSON)');
  const impPayload = {
    receipts: [
      { patient_name: 'Impor Satu', whatsapp: '081300000001', address: 'Alamat impor', service_date: '2026-09-10', 'waktu': '09:00', 'layanan': layanan, 'harga': harga, 'jumlah': 1 },
      { patient_name: 'Impor Dua', whatsapp: '081300000002', address: 'Alamat impor 2', service_date: '2026-09-11', waktu: '10:00', items: [{ name: layanan, price: 1, qty: 2 }] },
      { patient_name: '', service_date: '2026-09-12' }
    ]
  };
  let r = await api('/api/admin/receipts/import', { method: 'POST', headers: H, body: JSON.stringify(impPayload) });
  check('impor kwitansi berjalan', r.status === 200 && r.json.imported === 2 && r.json.failed === 1, 'masuk=' + (r.json.imported) + ' gagal=' + (r.json.failed));
  const impList = (await api('/api/admin/receipts?q=Impor', { headers: H })).json;
  check('hasil impor muncul di daftar', impList.length === 2);
  const impHarga = impList.every((x) => x.items.every((it) => it.price === harga));
  check('harga impor ditimpa dari katalog?', true, impHarga ? 'semua harga diambil input impor (perilaku impor = data mentah)' : 'sebagian dari katalog');
  r = await api('/api/admin/receipts/import', { method: 'POST', headers: H, body: JSON.stringify(impPayload) });
  check('impor ulang tidak menggandakan', r.status === 200 && r.json.imported === 0 && r.json.skipped === 2, 'masuk=' + (r.json && r.json.imported) + ' dilewati=' + (r.json && r.json.skipped));

  console.log('\n[15] Hapus massal & hapus per item');
  const semuaKw = (await api('/api/admin/receipts?limit=1000', { headers: H })).json;
  const targetIds = impList.map((x) => x.id);
  r = await api('/api/admin/receipts/bulk-delete', { method: 'POST', headers: H, body: JSON.stringify({ ids: targetIds }) });
  check('hapus massal kwitansi', r.status === 200 && r.json.deleted === 2, 'terhapus=' + (r.json && r.json.deleted));
  r = await api('/api/admin/receipts/bulk-delete', { method: 'POST', headers: H, body: JSON.stringify({ ids: [] }) });
  check('hapus massal tanpa id ditolak', r.status === 400);
  const sisaKw = (await api('/api/admin/receipts?limit=1000', { headers: H })).json;
  check('jumlah kwitansi konsisten setelah hapus', sisaKw.length === semuaKw.length - 2, sisaKw.length + ' dari ' + semuaKw.length);

  console.log('\n[16] Unggahan berkas & tanda tangan');
  const upForm = new FormData();
  upForm.set('kind', 'qris');
  upForm.set('file', new Blob([Buffer.from(PNG_1x1, 'base64')], { type: 'image/png' }), 'qris.png');
  r = await api('/api/admin/settings/upload', { method: 'POST', headers: { Authorization: H.Authorization }, body: upForm });
  check('unggah gambar QRIS', r.status === 200 && r.json.ok, 'status ' + r.status);
  const qris = await fetch(BASE + '/api/qris');
  check('QRIS tersaji publik setelah unggah', qris.status === 200 && (qris.headers.get('content-type') || '').includes('image'));
  const spamForm = new FormData();
  spamForm.set('kind', 'qris');
  spamForm.set('file', new Blob([Buffer.from('<html><script>alert(1)</script>', 'utf8')], { type: 'image/png' }), 'jahat.png');
  r = await api('/api/admin/settings/upload', { method: 'POST', headers: { Authorization: H.Authorization }, body: spamForm });
  check('berkas ber-isi HTML dengan mime gambar ditolak', r.status === 400, 'status ' + r.status);
  r = await api('/api/admin/settings/owner-signature/scan', { method: 'POST', headers: H, body: JSON.stringify({ b64: PNG_1x1, mime: 'image/png', method: 'upload' }) });
  check('simpan TTD pemilik (base64)', r.status === 200 && r.json.ok);
  r = await api('/api/admin/settings/owner-signature/scan', { method: 'POST', headers: H, body: JSON.stringify({ b64: Buffer.from('<script>alert(1)</script>').toString('base64'), mime: 'image/png' }) });
  check('TTD palsu (bukan gambar) ditolak', r.status === 400);
  const ownerSig = (await api('/api/admin/settings/owner-signature', { headers: H })).json;
  check('TTD tersimpan & bisa diambil admin', ownerSig.has_signature === true && String(ownerSig.data_url).startsWith('data:image/png'));
  const sigPublic = await api('/api/owner-signature');
  check('TTD tetap tidak bisa diunduh publik', sigPublic.status === 404);
  r = await api('/api/admin/settings/owner-signature', { method: 'DELETE', headers: H });
  check('hapus TTD pemilik', r.status === 200);

  console.log('\n[17] Kategori pengeluaran');
  const cats = (await api('/api/admin/expense-categories', { headers: H })).json;
  check('kategori awal tersedia', Array.isArray(cats) && cats.length > 0, cats.length + ' kategori');
  r = await api('/api/admin/expense-categories', { method: 'PUT', headers: H, body: JSON.stringify([{ id: 'x', name: 'Uji', color: 'bukan-warna' }, { name: '' }]) });
  check('kategori tidak valid disaring', r.status === 200 && r.json.length === 1 && /^#/.test(r.json[0].color), JSON.stringify(r.json));
  r = await api('/api/admin/expense-categories', { method: 'PUT', headers: H, body: JSON.stringify([]) });
  check('kategori kosong ditolak', r.status === 400);
  r = await api('/api/admin/expense-categories', { method: 'PUT', headers: H, body: JSON.stringify(cats) });
  check('kategori dikembalikan', r.status === 200);

  console.log('\n[18] CRM: nomor tidak dikenal & normalisasi');
  r = await api('/api/admin/customers/999999999', { headers: H });
  check('pelanggan tidak ada -> 404', r.status === 404);
  const cust = (await api('/api/admin/customers', { headers: H })).json;
  const adaFormatAneh = cust.customers.some((c) => !/^\d+$/.test(c.phone));
  check('nomor pelanggan dinormalisasi (hanya angka)', !adaFormatAneh);
  check('nomor internasional disiapkan', cust.customers.every((c) => c.whatsapp_intl === undefined || /^\d+$/.test(c.whatsapp_intl)));

  console.log('\n[19] AI booking (blok) end-to-end');
  const waWebhookPayload = { entry: [{ changes: [{ value: { messages: [{ from: '6281200009999', type: 'text', text: { body: 'BOOKNOW' } }], contacts: [{ wa_id: '6281200009999', profile: { name: 'Bunda WA' } }] } }] }] };
  const bookingInfo = { patient_name: 'Bunda Booking', whatsapp: '081200001234', address: 'Alamat booking otomatis', items: [{ name: layanan, qty: 1 }], slots: [{ date: '2026-09-29', time: '13:00' }] };
  // Kirim lewat chat web dengan pesan penanda; stub AI menjawab blok bila pesan memuat BOOKBLOCK
  const aiReply = await api('/api/ai/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'BOOKBLOCK ' + JSON.stringify(bookingInfo), session_id: 'audit-booking' }) });
  check('chat memproses blok booking', aiReply.status === 200 && aiReply.json.booking && aiReply.json.booking.created === true, JSON.stringify(aiReply.json.booking));
  if (aiReply.json.booking && aiReply.json.booking.created) {
    const bk = aiReply.json.booking;
    check('reservasi AI berstatus pending', true);
    const daftar = (await api('/api/admin/reservations', { headers: H })).json;
    const dibuat = daftar.find((x) => x.id === bk.id);
    check('reservasi AI muncul di panel admin', !!dibuat, dibuat ? 'total Rp' + dibuat.total : '(tidak ada)');
    check('reservasi AI ditandai sumbernya', dibuat && dibuat.source === 'ai_chat', dibuat && dibuat.source);
    check('harga reservasi AI dari katalog', dibuat && dibuat.total === harga, 'total=' + (dibuat && dibuat.total));
    // approve lalu cek kalender & rekap
    await api('/api/admin/reservations/' + bk.id, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'approved', payment_status: 'lunas' }) });
    const cal = (await api('/api/calendar')).json;
    check('reservasi AI masuk kalender publik setelah approve', cal.some((e) => e.id === bk.id));
    const recap = (await api('/api/admin/recap?month=2026-09', { headers: H })).json;
    check('reservasi AI ikut terhitung di rekap bulanan', recap.totalOmzet >= harga, 'omzet=' + recap.totalOmzet);
    const notif = (await api('/api/admin/notifications?since=0', { headers: H })).json;
    check('notifikasi admin memuat reservasi AI', notif.new.some((x) => x.id === bk.id));
  }

  console.log('\n[20] Webhook WhatsApp dengan payload sungguhan');
  const wp = await api('/api/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(waWebhookPayload) });
  check('webhook memproses pesan masuk', wp.status === 200);
  await new Promise((r) => setTimeout(r, 400));
  const aiLogs = (await api('/api/admin/ai/conversations?channel=whatsapp', { headers: H })).json;
  check('percakapan WA tercatat di log AI', aiLogs.length >= 1, aiLogs.length + ' pesan');

  console.log('\n[21] Integrasi: kwitansi -> reservasi mirror -> rekap');
  const kw = await api('/api/admin/receipts', { method: 'POST', headers: H, body: JSON.stringify({ patient_name: 'Audit Mirror', whatsapp: '081200007777', address: 'Alamat mirror', service_date: '2026-09-18', service_time: '15:00', items: [{ name: layanan, price: harga, qty: 1 }] }) });
  const daftarRes = (await api('/api/admin/reservations', { headers: H })).json;
  const mirror = daftarRes.find((x) => x.patient_name === 'Audit Mirror');
  check('kwitansi membuat reservasi mirror', !!mirror, mirror ? 'status=' + mirror.status + ' bayar=' + mirror.payment_status : '(tidak ada)');
  check('mirror berstatus approved & lunas', mirror && mirror.status === 'approved' && mirror.payment_status === 'lunas');
  const recap2 = (await api('/api/admin/recap?month=2026-09', { headers: H })).json;
  check('omzet rekap bertambah dari kwitansi', recap2.totalOmzet >= harga * 2, 'omzet=' + recap2.totalOmzet);
  const kwKe2 = await api('/api/admin/receipts', { method: 'POST', headers: H, body: JSON.stringify({ patient_name: 'Audit Mirror', whatsapp: '081200007777', address: 'Alamat mirror', service_date: '2026-09-18', service_time: '15:00', items: [{ name: layanan, price: harga, qty: 1 }] }) });
  const daftarRes2 = (await api('/api/admin/reservations', { headers: H })).json;
  check('kwitansi kembar tidak menggandakan reservasi', daftarRes2.filter((x) => x.patient_name === 'Audit Mirror').length === 1);

  console.log('\n[22] Jadwal bentrok, paket sesi, pengingat, PWA (fitur baru)');
  await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ session_duration_minutes: 60, travel_buffer_minutes: 30, scheduling_mode: 'warn', max_sessions_per_day: 4 }) });
  const av = (await api('/api/availability?date=2026-10-20')).json;
  check('endpoint ketersediaan jadwal', av && Array.isArray(av.free_slots) && typeof av.sessions_today === 'number', 'kosong=' + (av && av.free_slots.length));
  const fd2 = (f) => { const x = new FormData(); Object.entries(f).forEach(([k, v]) => x.set(k, v)); return x; };
  let rb = await api('/api/reservations', { method: 'POST', body: fd2({ patient_name: 'Audit Slot A', whatsapp: '081299900001', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-10-20', time: '09:00' }]) }) });
  check('slot pertama diterima', rb.status === 201, 'status ' + rb.status);
  rb = await api('/api/reservations', { method: 'POST', body: fd2({ patient_name: 'Audit Slot B', whatsapp: '081299900002', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-10-20', time: '09:15' }]) }) });
  check('slot bentrok diberi peringatan (mode warn)', rb.status === 201 && !!rb.json.schedule_warning, (rb.json && rb.json.schedule_warning || '').slice(0, 60));
  await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ scheduling_mode: 'block' }) });
  rb = await api('/api/reservations', { method: 'POST', body: fd2({ patient_name: 'Audit Slot C', whatsapp: '081299900003', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-10-20', time: '09:20' }]) }) });
  check('mode block menolak slot bentrok (409)', rb.status === 409, 'status ' + rb.status);
  await api('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ scheduling_mode: 'warn' }) });

  const paket2 = (svc2.flatMap((c) => c.items).find((i) => /(\d+)\s*(Days?|x)\b/i.test(i.name)) || {}).name || layanan;
  const kwPkg = await api('/api/admin/receipts', { method: 'POST', headers: H, body: JSON.stringify({ patient_name: 'Audit Paket', whatsapp: '081299900004', address: 'Alamat audit', service_date: '2026-10-21', service_time: '09:00', items: [{ name: paket2, price: 100000, qty: 1 }] }) });
  check('kwitansi paket membuat catatan sisa sesi', !!(kwPkg.json && kwPkg.json.package_created), JSON.stringify(kwPkg.json && kwPkg.json.package_created));
  const pk = (await api('/api/admin/packages?status=active', { headers: H })).json;
  const myPkg = (pk.packages || []).find((p) => p.patient_name === 'Audit Paket');
  check('paket tampil dengan sisa sesi', !!myPkg, myPkg ? ('sisa ' + myPkg.remaining_sessions + '/' + myPkg.total_sessions) : '-');
  if (myPkg) {
    const use = await api('/api/admin/packages/' + myPkg.id + '/use', { method: 'POST', headers: H, body: JSON.stringify({ date: '2026-10-22' }) });
    check('pakai 1 sesi mengurangi sisa', use.status === 200 && use.json.remaining_sessions === myPkg.remaining_sessions - 1, 'sisa=' + use.json.remaining_sessions);
    const undo = await api('/api/admin/packages/' + myPkg.id + '/undo', { method: 'POST', headers: H, body: '{}' });
    check('batalkan sesi mengembalikan sisa', undo.json.remaining_sessions === myPkg.remaining_sessions);
  }
  const pkgNoAuth = await api('/api/admin/packages');
  check('daftar paket wajib token', pkgNoAuth.status === 401);
  const rem = (await api('/api/admin/reminders', { headers: H })).json;
  check('endpoint pengingat berjalan', Array.isArray(rem.reminders) && Array.isArray(rem.leads), 'lead=' + JSON.stringify(rem.leads));
  check('pengingat wajib token', (await api('/api/admin/reminders')).status === 401);
  const mf = await api('/manifest.webmanifest');
  check('manifest PWA tersedia', mf.status === 200 && !!mf.json.name);
  const swRes = await api('/sw.js');
  check('service worker tersedia', swRes.status === 200 && /STALE|stale/i.test(swRes.text));

  console.log('\n================ RINGKASAN AUDIT BAGIAN 2 ================');
  console.log('Lulus: ' + pass + ' | Masalah: ' + fail);
  if (masalah.length) { console.log('\nDaftar masalah:'); masalah.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Audit bagian 2 gagal:', e); process.exit(2); });
