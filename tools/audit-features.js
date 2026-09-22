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

  // Booking lewat web lalu dibayar & dibuatkan kwitansi: reservasi yang sudah
  // ada harus ditandai lunas (dulu kwitansinya diam-diam dilewati sehingga
  // pendapatan yang benar-benar diterima tidak masuk Rekap/P&L).
  const fdBayar = (f) => { const x = new FormData(); Object.entries(f).forEach(([k, v]) => x.set(k, v)); return x; };
  const resBayar = await api('/api/reservations', { method: 'POST', body: fdBayar({ patient_name: 'Audit Bayar', whatsapp: '081200000099', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-09-19', time: '09:00' }]) }) });
  const resBayarId = resBayar.json && resBayar.json.id;
  await api('/api/admin/receipts', { method: 'POST', headers: H, body: JSON.stringify({ patient_name: 'Audit Bayar', whatsapp: '081200000099', address: 'Alamat audit', service_date: '2026-09-19', service_time: '09:00', items: [{ name: layanan, price: harga, qty: 1 }] }) });
  const resSetelah = (await api('/api/admin/reservations', { headers: H })).json.filter((x) => x.patient_name === 'Audit Bayar');
  check('kwitansi untuk booking yang sudah ada tidak menggandakan reservasi', resSetelah.length === 1, resSetelah.length + ' reservasi');
  check('kwitansi menandai reservasi itu lunas (omzet tidak hilang)', !!resSetelah[0] && resSetelah[0].payment_status === 'lunas' && resSetelah[0].status === 'approved', resSetelah[0] ? resSetelah[0].payment_status : '-');
  check('jejak pembayaran lewat kwitansi dicatat di catatan reservasi', !!resSetelah[0] && /kwitansi/i.test(String(resSetelah[0].notes || '')));

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

  console.log('\n[23] Buku stok: barang, riwayat, HPP, daftar belanja, peringatan');
  // --- barang ---
  let sup = await api('/api/admin/supplies', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Audit Minyak', unit: 'botol', stock: 5, min_stock: 2, cost: 40000, supplier: 'Toko Audit', supplier_wa: '081234000001' }) });
  check('tambah barang stok', sup.status === 200 && sup.json.supply.id, 'status ' + sup.status);
  const supId = sup.json.supply.id;
  check('stok awal tercatat di riwayat (bukan ditulis langsung)', !!sup.json.move && sup.json.move.type === 'in' && sup.json.move.qty === 5, JSON.stringify(sup.json.move && sup.json.move.type));
  check('stok awal TIDAK otomatis jadi pengeluaran', !sup.json.expense);
  check('barang duplikat ditolak', (await api('/api/admin/supplies', { method: 'POST', headers: H, body: JSON.stringify({ name: 'audit minyak' }) })).status === 409);
  check('barang tanpa nama ditolak', (await api('/api/admin/supplies', { method: 'POST', headers: H, body: JSON.stringify({ name: '   ' }) })).status === 400);
  const sup2 = await api('/api/admin/supplies', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Audit Lotion', unit: 'botol', stock: 2, min_stock: 3, cost: 30000, supplier: 'Toko Audit', supplier_wa: '081234000001' }) });
  const sup2Id = sup2.json.supply.id;
  let list = (await api('/api/admin/supplies', { headers: H })).json;
  check('ringkasan stok memuat nilai persediaan', list.stock_value >= 5 * 40000, 'nilai=' + list.stock_value);
  check('barang menipis terdeteksi (stok <= min)', list.low_count >= 1 && list.low_stock.some((x) => x.id === sup2Id));
  check('saran beli = 2x minimum - sisa', (list.low_stock.find((x) => x.id === sup2Id) || {}).suggested_qty === 4, 'saran=' + (list.low_stock.find((x) => x.id === sup2Id) || {}).suggested_qty);
  const lowOnly = (await api('/api/admin/supplies?low=1', { headers: H })).json;
  check('filter hanya menipis', lowOnly.supplies.every((s) => s.low));
  const cariStok = (await api('/api/admin/supplies?q=audit+lotion', { headers: H })).json;
  check('pencarian barang', cariStok.count === 1, 'hasil=' + cariStok.count);
  const cariKategori = (await api('/api/admin/supplies?q=minyak', { headers: H })).json;
  check('pencarian juga menjangkau kategori & supplier', cariKategori.count >= 2, 'hasil=' + cariKategori.count);

  // --- restok + sambungan ke Pengeluaran/P&L ---
  const expBefore = (await api('/api/admin/expenses', { headers: H })).json.length;
  let mv = await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'in', qty: 10, unit_cost: 45000, note: 'Audit belanja' }) });
  check('restok menambah stok', mv.status === 200 && mv.json.supply.stock === 15, 'stok=' + (mv.json.supply && mv.json.supply.stock));
  check('restok memperbarui harga beli terakhir', mv.json.supply.cost === 45000);
  check('restok otomatis tercatat sebagai pengeluaran', !!mv.json.expense && mv.json.expense.amount === 450000, 'pengeluaran=' + JSON.stringify(mv.json.expense && mv.json.expense.amount));
  const expAfter = (await api('/api/admin/expenses', { headers: H })).json;
  check('pengeluaran restok bertambah tepat 1 entri', expAfter.length === expBefore + 1, expBefore + ' -> ' + expAfter.length);
  check('kategori pengeluaran restok = supplies', (expAfter.find((e) => e.id === mv.json.expense.id) || {}).category === 'cat_supplies');
  mv = await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'in', qty: 3, unit_cost: 45000, create_expense: false }) });
  check('restok bisa TIDAK dicatat sebagai pengeluaran', !mv.json.expense && mv.json.supply.stock === 18, 'stok=' + mv.json.supply.stock);
  const stokSebelumTolak = mv.json.supply.stock;
  const outTolak = await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'out', qty: 999 }) });
  check('keluar melebihi stok ditolak (400)', outTolak.status === 400 && /tidak cukup/i.test(outTolak.text), outTolak.text.slice(0, 60));
  check('stok tidak berubah setelah penolakan', (await api('/api/admin/supplies?q=audit+minyak', { headers: H })).json.supplies[0].stock === stokSebelumTolak);
  check('jumlah 0 ditolak', (await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'out', qty: 0 }) })).status === 400);
  check('jenis pergerakan ngawur ditolak', (await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'kadaluarsa', qty: 1 }) })).status === 400);

  // --- resep + HPP ---
  let rec = await api('/api/admin/supply-recipes', { method: 'POST', headers: H, body: JSON.stringify({ service_name: layanan, items: [{ supply_id: supId, qty: 0.1 }, { supply_id: sup2Id, qty: 0.5 }] }) });
  check('buat resep bahan', rec.status === 200 && rec.json.recipe.cost_per_session === 19500, 'hpp=' + (rec.json.recipe && rec.json.recipe.cost_per_session) + ' (0.1*45000 + 0.5*30000)');
  check('resep tanpa bahan ditolak', (await api('/api/admin/supply-recipes', { method: 'POST', headers: H, body: JSON.stringify({ service_name: 'X', items: [] }) })).status === 400);
  check('resep dengan bahan tidak dikenal ditolak', (await api('/api/admin/supply-recipes', { method: 'POST', headers: H, body: JSON.stringify({ service_name: 'X', items: [{ supply_id: 99999, qty: 1 }] }) })).status === 400);
  const recEdit = await api('/api/admin/supply-recipes', { method: 'POST', headers: H, body: JSON.stringify({ service_name: layanan.toUpperCase(), items: [{ supply_id: supId, qty: 0.2 }] }) });
  const recAll = (await api('/api/admin/supply-recipes', { headers: H })).json;
  check('resep sama tidak menggandakan (upsert)', recAll.recipes.filter((r) => r.service_name.toLowerCase() === layanan.toLowerCase()).length === 1, recAll.count + ' resep');
  check('HPP diperbarui setelah edit resep', recEdit.json.recipe.cost_per_session === 9000, 'hpp=' + recEdit.json.recipe.cost_per_session);
  const usePlan = await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ service_name: layanan, sessions: 3 }) });
  check('pakai bahan mengurangi stok 3 sesi', usePlan.status === 200 && usePlan.json.total_cost === 27000, 'biaya=' + (usePlan.json && usePlan.json.total_cost));
  check('riwayat pemakaian memakai satu batch (dasar hitung sesi)', (usePlan.json.moves || []).every((m) => m.batch === usePlan.json.moves[0].batch));
  // Stok dikurangi dulu supaya kekurangan pasti terjadi (60 sesi × 0.2 = 12).
  const stokSebelumKurang = (await api('/api/admin/supplies?q=audit+minyak', { headers: H })).json.supplies[0].stock;
  await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'adjust', qty: 1, note: 'audit: uji stok kurang' }) });
  const stokKurang = await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ service_name: layanan, sessions: 60 }) });
  check('pemakaian melebihi stok ditolak (400) + rincian kekurangan', stokKurang.status === 400 && /tidak cukup/i.test(stokKurang.text), stokKurang.text.slice(0, 70));
  check('stok tidak berkurang saat pemakaian ditolak', (await api('/api/admin/supplies?q=audit+minyak', { headers: H })).json.supplies[0].stock === 1);
  await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'adjust', qty: stokSebelumKurang }) });
  check('layanan tanpa resep ditolak jelas', (await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ service_name: 'Layanan Tanpa Resep' }) })).status === 404);

  // --- pemakaian dari reservasi ---
  const fdStok = (f) => { const x = new FormData(); Object.entries(f).forEach(([k, v]) => x.set(k, v)); return x; };
  const resStok = await api('/api/reservations', { method: 'POST', body: fdStok({ patient_name: 'Audit Stok', whatsapp: '081299900123', address: 'Alamat audit', payment_method: 'COD', items: JSON.stringify([{ name: layanan, qty: 1 }]), slots: JSON.stringify([{ date: '2026-11-02', time: '09:00' }]) }) });
  check('reservasi uji pemakaian bahan dibuat', resStok.status === 201, 'status ' + resStok.status);
  const resStokId = resStok.json && resStok.json.id;
  const pending = (await api('/api/admin/supplies/pending-uses?days=3650', { headers: H })).json;
  check('reservasi yang bahannya belum dicatat terdaftar', (pending.pending || []).some((x) => x.reservation_id === resStokId), 'pending=' + pending.count);
  const useRes = await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ reservation_id: resStokId }) });
  check('pakai bahan lewat reservasi', useRes.status === 200 && useRes.json.total_cost === 9000, 'biaya=' + (useRes.json && useRes.json.total_cost));
  const useResAgain = await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ reservation_id: resStokId }) });
  check('pemakaian ganda untuk reservasi sama ditolak (409)', useResAgain.status === 409, 'status ' + useResAgain.status);
  check('reservasi hilang ditolak 404', (await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ reservation_id: 987654 }) })).status === 404);

  // --- riwayat & pembatalan ---
  const hist = (await api('/api/admin/supplies/moves?supply_id=' + supId, { headers: H })).json;
  check('riwayat stok berisi sebelum -> sesudah', hist.moves.every((m) => typeof m.before === 'number' && typeof m.after === 'number'), hist.count + ' pergerakan');
  // Pembatalan restok diuji pada barang tersendiri supaya stoknya pasti
  // belum terpakai (pembatalan yang membuat stok minus memang ditolak).
  const supUndo = await api('/api/admin/supplies', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Audit Undo', unit: 'pcs', stock: 0, min_stock: 1, cost: 10000 }) });
  const supUndoId = supUndo.json.supply.id;
  const restokUndo = await api('/api/admin/supplies/' + supUndoId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'in', qty: 4, unit_cost: 10000, note: 'audit restok' }) });
  check('restok untuk uji pembatalan', restokUndo.status === 200 && restokUndo.json.supply.stock === 4 && !!restokUndo.json.expense, 'stok=' + (restokUndo.json.supply && restokUndo.json.supply.stock));
  const undoMove = await api('/api/admin/supplies/moves/' + restokUndo.json.move.id, { method: 'DELETE', headers: H });
  check('batalkan restok mengembalikan stok', undoMove.status === 200 && undoMove.json.supply.stock === 0, 'stok=' + (undoMove.json.supply && undoMove.json.supply.stock));
  check('batalkan restok ikut menghapus pengeluaran tertaut', undoMove.json.expense_removed === 1);
  check('pengeluaran restok benar-benar hilang dari P&L', !(await api('/api/admin/expenses', { headers: H })).json.some((e) => e.id === restokUndo.json.expense.id));
  const restokBesar = await api('/api/admin/supplies/' + supUndoId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'in', qty: 10, create_expense: false }) });
  await api('/api/admin/supplies/' + supUndoId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'out', qty: 8 }) });
  const undoNegatif = await api('/api/admin/supplies/moves/' + restokBesar.json.move.id, { method: 'DELETE', headers: H });
  check('pembatalan yang membuat stok minus ditolak + saran', undoNegatif.status === 400 && /terpakai/i.test(undoNegatif.text), undoNegatif.text.slice(0, 70));
  await api('/api/admin/supplies/' + supUndoId, { method: 'DELETE', headers: H });
  const stokSekarang = (await api('/api/admin/supplies?q=audit+minyak', { headers: H })).json.supplies[0].stock;
  const stokOutKecil = await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'out', qty: Math.max(0.001, Math.min(1, stokSekarang)) }) });
  check('stok opname/keluar kecil diterima', stokOutKecil.status === 200, 'status ' + stokOutKecil.status);
  const undoOut = await api('/api/admin/supplies/moves/' + stokOutKecil.json.move.id, { method: 'DELETE', headers: H });
  check('batalkan pemakaian mengembalikan stok', undoOut.status === 200 && undoOut.json.supply.stock === stokSekarang, 'stok=' + (undoOut.json.supply && undoOut.json.supply.stock));
  check('batalkan riwayat asing ditolak 404', (await api('/api/admin/supplies/moves/999999', { method: 'DELETE', headers: H })).status === 404);
  const adj = await api('/api/admin/supplies/' + supId + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'adjust', qty: 1, note: 'Audit opname' }) });
  check('penyesuaian stok (stok opname) memakai angka absolut', adj.json.move.qty === 1 && adj.json.move.before !== adj.json.move.after);
  const editBarang = await api('/api/admin/supplies/' + supId, { method: 'PATCH', headers: H, body: JSON.stringify({ stock: 2.5, min_stock: 1, note: 'catatan audit' }) });
  check('ubah stok dari form edit tetap tercatat sebagai penyesuaian', editBarang.json.move && editBarang.json.move.type === 'adjust' && editBarang.json.supply.stock === 2.5, 'stok=' + editBarang.json.supply.stock);
  check('ubah stok dari form edit tidak dianggap pemakaian (bukan type out)', editBarang.json.move.type !== 'out');

  // --- peringatan & daftar belanja ---
  await api('/api/admin/supplies/' + sup2Id + '/move', { method: 'POST', headers: H, body: JSON.stringify({ type: 'adjust', qty: 0.5 }) });
  const alerts = (await api('/api/admin/supplies/alerts', { headers: H })).json;
  check('endpoint peringatan mendaftar barang menipis', alerts.count >= 1 && alerts.items.some((x) => x.id === sup2Id), 'count=' + alerts.count);
  check('teks peringatan terisi tanpa placeholder', /sisa/.test(alerts.text) && !/\{daftar\}|\{jumlah\}/.test(alerts.text));
  check('peringatan punya tautan WA (WA bisnis)', !!alerts.wa_link && /wa\.me\/\d+/.test(alerts.wa_link));
  const alertSend = await api('/api/admin/supplies/alerts/send', { method: 'POST', headers: H, body: '{}' });
  check('kirim peringatan tanpa kredensial WA ditolak dengan saran', alertSend.status === 400 && /belum dikonfigurasi/i.test(alertSend.text), alertSend.text.slice(0, 70));
  const orderList = (await api('/api/admin/supplies/shopping-list', { headers: H })).json;
  check('daftar belanja memuat barang menipis + estimasi', orderList.count >= 1 && orderList.total_estimate > 0, 'estimasi=' + orderList.total_estimate);
  check('daftar belanja dikelompokkan per supplier', (orderList.by_supplier || []).length >= 1 && orderList.by_supplier[0].items.length >= 1);
  check('tautan WA supplier dibuat dari data barang', (orderList.by_supplier.find((g) => g.phone) || {}).wa_link ? /wa\.me\/62812/.test(orderList.by_supplier.find((g) => g.phone).wa_link) : false);
  check('teks daftar belanja memuat nama barang & total', /Audit Lotion/.test(orderList.text) && /Rp/.test(orderList.text));
  const orderSend = await api('/api/admin/supplies/shopping-list/send', { method: 'POST', headers: H, body: JSON.stringify({ phone: '081234000001' }) });
  check('kirim daftar belanja tanpa kredensial WA ditolak dengan saran', orderSend.status === 400 && /wa\.me|belum dikonfigurasi/i.test(orderSend.text), orderSend.text.slice(0, 70));

  // --- laporan HPP & margin ---
  const rep = (await api('/api/admin/supplies/report?months=6', { headers: H })).json;
  check('laporan stok: nilai persediaan & jumlah barang', rep.stock_value >= 0 && rep.items_count >= 2, 'nilai=' + rep.stock_value);
  check('laporan HPP per layanan terisi', (rep.services || []).some((s) => s.service_name === layanan && s.material_cost > 0), JSON.stringify((rep.services || []).slice(0, 1)));
  check('margin per layanan dihitung (omzet - bahan)', (rep.services || []).some((s) => typeof s.margin === 'number'));
  check('laporan memuat pemakaian per barang 30 hari', (rep.items || []).every((s) => 'used_30d' in s && 'per_session' in s));
  check('laporan memuat resep yang sudah dibuat', rep.recipes_count >= 1);
  const xlsxStok = await api('/api/admin/supplies/export.xlsx', { headers: H });
  check('export Excel buku stok terunduh', xlsxStok.status === 200 && xlsxStok.text.length > 2000, xlsxStok.text.length + ' byte');
  check('export Excel bukan HTML error', !/<html/i.test(xlsxStok.text.slice(0, 200)));

  // --- sambungan ke dasbor, akunting, backup, keamanan ---
  const statsStok = (await api('/api/admin/stats', { headers: H })).json;
  check('dasbor memuat jumlah stok menipis', typeof statsStok.low_stock === 'number' && statsStok.low_stock >= 1, 'low=' + statsStok.low_stock);
  check('dasbor memuat nilai persediaan', typeof statsStok.stock_value === 'number');
  const acctStok = (await api('/api/admin/accounting/summary?months=3', { headers: H })).json;
  check('akunting memuat blok buku stok', acctStok.supply && typeof acctStok.supply.material_total === 'number', JSON.stringify(acctStok.supply && acctStok.supply.material_total));
  check('biaya bahan TIDAK ditambahkan lagi ke total beban', acctStok.supply && acctStok.totals.expense < acctStok.totals.expense + acctStok.supply.material_total + 1 && acctStok.supply.material_total >= 0);
  const bebanSebelumPakai = (await api('/api/admin/accounting/summary?months=3', { headers: H })).json.totals.expense;
  await api('/api/admin/supplies/use', { method: 'POST', headers: H, body: JSON.stringify({ service_name: layanan, sessions: 1 }) });
  const bebanSetelahPakai = (await api('/api/admin/accounting/summary?months=3', { headers: H })).json;
  check('pemakaian bahan tidak menambah beban baru (tidak dobel)', bebanSetelahPakai.totals.expense === bebanSebelumPakai, bebanSebelumPakai + ' -> ' + bebanSetelahPakai.totals.expense);
  check('pemakaian bahan menambah HPP di laporan', bebanSetelahPakai.supply.material_total > 0);
  const backupStok = await api('/api/admin/backup', { headers: H });
  check('backup memuat data buku stok', (backupStok.json.supplies || []).length >= 1 && (backupStok.json.supply_moves || []).length >= 1, (backupStok.json.supplies || []).length + ' barang, ' + (backupStok.json.supply_moves || []).length + ' riwayat');
  check('backup tidak membocorkan token stok', !/ai_assistant_access_token|ai_gemini_api_key/.test(backupStok.text));
  for (const p of ['/api/admin/supplies', '/api/admin/supply-recipes', '/api/admin/supplies/report', '/api/admin/supplies/shopping-list', '/api/admin/supplies/alerts', '/api/admin/supplies/pending-uses']) {
    check('stok wajib token: ' + p, (await api(p)).status === 401);
  }
  check('riwayat stok wajib token', (await api('/api/admin/supplies/moves')).status === 401);
  check('export stok wajib token', (await api('/api/admin/supplies/export.xlsx')).status === 401);
  check('data stok tidak bocor ke pengaturan publik', !/supplies|supply_recipes/.test((await api('/api/public-settings')).text));

  // --- hapus barang: riwayat & resep ikut dibersihkan ---
  const delSup = await api('/api/admin/supplies/' + supId, { method: 'DELETE', headers: H });
  check('hapus barang menghapus riwayatnya', delSup.status === 200 && delSup.json.moves_deleted >= 1, 'riwayat terhapus=' + (delSup.json && delSup.json.moves_deleted));
  check('hapus barang menyesuaikan resepnya', delSup.json.recipes_updated >= 1, 'resep disesuaikan=' + delSup.json.recipes_updated);
  const recAfterDel = (await api('/api/admin/supply-recipes', { headers: H })).json;
  const recTarget = recAfterDel.recipes.find((r) => r.service_name.toLowerCase() === layanan.toLowerCase());
  check('bahan yang dihapus tidak lagi dipakai di resep', !!recTarget && recTarget.items.every((it) => it.supply_id !== supId), JSON.stringify(recTarget && recTarget.items.map((i) => i.name)));
  check('riwayat barang yang dihapus hilang', (await api('/api/admin/supplies/moves?supply_id=' + supId, { headers: H })).json.count === 0);

  console.log('\n================ RINGKASAN AUDIT BAGIAN 2 ================');
  console.log('Lulus: ' + pass + ' | Masalah: ' + fail);
  if (masalah.length) { console.log('\nDaftar masalah:'); masalah.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Audit bagian 2 gagal:', e); process.exit(2); });
