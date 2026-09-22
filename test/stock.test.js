// Tes regresi BUKU STOK (bahan habis pakai):
//   1. Sisa stok, batas minimum, dan saran jumlah pembelian
//   2. Riwayat masuk/keluar/penyesuaian (angka stok tidak pernah berubah
//      tanpa jejak) + tautan ke Pengeluaran saat restok
//   3. Resep bahan per layanan → HPP per sesi & rencana pemakaian
//   4. Daftar belanja & peringatan stok menipis (placeholder, anti-spam)
//   5. Sambungan ke endpoint, backup/restore, dan normalisasi state
//
// Kode yang diuji diambil APA ADANYA dari server.js lalu dijalankan di sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function block(marker) {
  const i = serverSrc.indexOf(marker);
  assert.ok(i > 0, `blok "${marker}" tidak ada di server.js`);
  const end = serverSrc.indexOf('\n}\n', i);
  return serverSrc.slice(i, end + 3);
}

// ---------- sandbox buku stok ----------
function stockSandbox(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    todayJakarta: () => o.today || '2026-09-22',
    monthJakarta: () => (o.today || '2026-09-22').slice(0, 7),
    DB: {
      supplies: o.supplies || [],
      supply_moves: o.moves || [],
      supply_recipes: o.recipes || [],
      expenses: o.expenses || [],
      reservations: o.reservations || [],
      settings: Object.assign({ business_name: 'Adzkiya Mom Baby Care' }, o.settings || {}),
      _seq: { supplies: 0, supply_moves: 0, supply_recipes: 0, expenses: 0 }
    },
    save: () => {},
    nextId: (t) => { sandbox.DB._seq[t] = (sandbox.DB._seq[t] || 0) + 1; return sandbox.DB._seq[t]; }
  };
  // Konstanta diambil apa adanya dari server.js (bukan ditulis ulang) supaya
  // batas atas jumlah stok ikut teruji.
  const qtyMax = /const SUPPLY_QTY_MAX = (\d+);/.exec(serverSrc);
  assert.ok(qtyMax, 'konstanta SUPPLY_QTY_MAX tidak ditemukan di server.js');
  sandbox.SUPPLY_QTY_MAX = Number(qtyMax[1]);
  vm.createContext(sandbox);
  for (const fn of [
    'function shiftDateStr',
    'function roundQty',
    'function clampQty',
    'function supplyStock',
    'function supplyLowStock',
    'function restockSuggestion',
    'function supplyStockValue',
    'function supplyById',
    'function lowStockSupplies',
    'function supplyRecipeFor',
    'function recipeCost',
    'function supplyUsePlan',
    'function recordSupplyMove',
    'function applySupplyUse',
    'function supplyExpenseCategory',
    'function createSupplyExpense',
    'function supplyOrderTemplate',
    'function supplyAlertTemplate',
    'function renderSupplyOrderText',
    'function renderSupplyAlertText',
    'function supplyAlertRecipient',
    'function supplyAlertIntervalHours',
    'function supplyWhatsReady',
    'function supplyAlertDue',
    'function markSupplyAlertSent',
    'function supplyCostByMonth',
    'function supplyUsageByItem'
  ]) {
    vm.runInContext(block(fn), sandbox);
  }
    // Isi awal berupa POJO → perlu "diadopsi" jadi referensi sandbox supaya
  // mutasi stok terlihat oleh tes.
  const ctx = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, ctx };
}

const barang = (id, name, stock, min, cost, extra) => Object.assign({
  id, name, unit: 'botol', stock, min_stock: min, cost, category: '🧴 Bahan', supplier: '', supplier_wa: ''
}, extra || {});

test('Stok: pembulatan desimal & batas maksimum aman', () => {
  const { ctx } = stockSandbox();
  assert.equal(ctx('roundQty(0.1 + 0.2)'), 0.3);
  assert.equal(ctx('roundQty("abc")'), 0);
  assert.equal(ctx('clampQty(-5)'), 0);
  assert.equal(ctx('clampQty(SUPPLY_QTY_MAX + 1)'), 1000000);
  assert.equal(ctx('clampQty("2.5")'), 2.5);
});

test('Stok: batas minimum & saran beli (min 0 = tanpa peringatan)', () => {
  const { ctx } = stockSandbox();
  assert.equal(ctx('supplyLowStock({ stock: 1, min_stock: 2 })'), true);
  assert.equal(ctx('supplyLowStock({ stock: 2, min_stock: 2 })'), true, 'stok sama dengan min sudah menipis');
  assert.equal(ctx('supplyLowStock({ stock: 3, min_stock: 2 })'), false);
  assert.equal(ctx('supplyLowStock({ stock: 0, min_stock: 0 })'), false, 'min 0 berarti tanpa peringatan');
  assert.equal(ctx('restockSuggestion({ stock: 1, min_stock: 3 })'), 5, 'saran beli = 2x min - sisa');
  assert.equal(ctx('restockSuggestion({ stock: 0, min_stock: 0 })'), 1, 'saran minimal 1 walau tanpa batas');
  assert.equal(ctx('restockSuggestion({ stock: 10, min_stock: 2 })'), 1, 'tidak pernah menyarankan 0');
});

test('Stok: restok menambah stok, memperbarui harga beli, dan menautkan pengeluaran', () => {
  const items = [barang(1, 'Minyak Pijat', 2, 3, 40000)];
  const { sandbox, ctx } = stockSandbox({ supplies: items });
  const move = ctx('recordSupplyMove(DB.supplies[0], { type: "in", qty: 10, unit_cost: 45000, date: "2026-09-20", note: "Belanja Toko A" })');
  assert.equal(sandbox.DB.supplies[0].stock, 12);
  assert.equal(sandbox.DB.supplies[0].cost, 45000, 'harga beli terakhir harus menggantikan harga lama');
  assert.equal(move.before, 2);
  assert.equal(move.after, 12);
  assert.equal(move.total_cost, 450000);
  assert.equal(move.date, '2026-09-20');
  // Pengeluaran otomatis + tautannya
  const exp = vm.runInContext('createSupplyExpense(DB.supplies[0], DB.supply_moves[0])', sandbox);
  assert.equal(exp.category, 'cat_supplies');
  assert.equal(exp.amount, 450000);
  assert.match(exp.description, /Minyak Pijat/);
  assert.equal(sandbox.DB.supply_moves[0].expense_id, exp.id, 'riwayat tidak menautkan pengeluaran');
});

test('Stok: keluar mengurangi, penyesuaian memakai angka absolut (bukan selisih)', () => {
  const items = [barang(1, 'Lotion', 10, 2, 30000)];
  const { sandbox, ctx } = stockSandbox({ supplies: items });
  const out = ctx('recordSupplyMove(DB.supplies[0], { type: "out", qty: 2.5 })');
  assert.equal(sandbox.DB.supplies[0].stock, 7.5);
  assert.equal(out.total_cost, 75000);
  const adj = ctx('recordSupplyMove(DB.supplies[0], { type: "adjust", qty: 5, note: "stok opname" })');
  assert.equal(sandbox.DB.supplies[0].stock, 5);
  assert.equal(adj.before, 7.5);
  assert.equal(adj.after, 5);
  // Biaya penyesuaian hanya sebesar nilai barang yang hilang (2.5), bukan 5.
  assert.equal(adj.total_cost, 75000, 'nilai penyesuaian harus dari selisih, bukan angka stok baru');
});

test('Resep: HPP per sesi & rencana pemakaian (stok kurang terdeteksi)', () => {
  const items = [barang(1, 'Minyak Pijat', 1, 2, 50000), barang(2, 'Lotion', 10, 2, 30000)];
  const recipes = [{ id: 1, service_name: 'Massage Ibu Hamil', items: [{ supply_id: 1, qty: 0.05 }, { supply_id: 2, qty: 0.1 }] }];
  const { ctx } = stockSandbox({ supplies: items, recipes });
  assert.equal(ctx('recipeCost(DB.supply_recipes[0])'), 5500, '0.05*50000 + 0.1*30000 = 5500');
  // Nama layanan tidak peka huruf besar/kecil & spasi
  assert.ok(ctx('supplyRecipeFor("  massage ibu hamil ")'), 'pencocokan nama layanan gagal');
  const plan = ctx('supplyUsePlan("Massage Ibu Hamil", 4)');
  assert.equal(plan.sessions, 4);
  assert.equal(plan.items[0].qty, 0.2, 'qty harus dikalikan jumlah sesi');
  assert.equal(plan.total_cost, 22000);
  assert.equal(plan.ok, true);
  // 4 sesi butuh 0.2 botol minyak, sisa cuma 1 → masih cukup. Naikkan sesi.
  const plan2 = ctx('supplyUsePlan("Massage Ibu Hamil", 40)');
  assert.equal(plan2.ok, false);
  assert.equal(plan2.missing.length, 1);
  assert.match(plan2.missing[0].name, /Minyak/);
  assert.equal(plan2.missing[0].need, 2);
  // Layanan tanpa resep
  const kosong = ctx('supplyUsePlan("Gentle Flow", 1)');
  assert.equal(kosong.found, false);
  assert.equal(kosong.ok, false);
  assert.equal(kosong.total_cost, 0);
});

test('Resep: bahan yang sudah dihapus tidak membengkokkan biaya', () => {
  const items = [barang(1, 'Minyak Pijat', 5, 1, 50000)];
  const recipes = [{ id: 1, service_name: 'A', items: [{ supply_id: 1, qty: 0.1 }, { supply_id: 99, qty: 3 }] }];
  const { ctx } = stockSandbox({ supplies: items, recipes });
  assert.equal(ctx('recipeCost(DB.supply_recipes[0])'), 5000, 'bahan tak dikenal harus diabaikan');
  const plan = ctx('supplyUsePlan("A", 2)');
  assert.equal(plan.ok, false, 'bahan terhapus = tidak boleh dianggap cukup');
  assert.equal(plan.total_cost, 10000);
});

test('Pemakaian: stok berkurang sekali per bahan & satu batch untuk 1 kunjungan', () => {
  const items = [barang(1, 'Minyak Pijat', 5, 1, 50000), barang(2, 'Lotion', 5, 1, 30000)];
  const recipes = [{ id: 1, service_name: 'Massage Ibu Hamil', items: [{ supply_id: 1, qty: 0.05 }, { supply_id: 2, qty: 0.1 }] }];
  const { sandbox, ctx } = stockSandbox({ supplies: items, recipes });
  const moves = vm.runInContext(`
    const plan = supplyUsePlan("Massage Ibu Hamil", 2);
    applySupplyUse(plan, { date: "2026-09-22", reservation_id: 7 });
  `, sandbox);
  assert.equal(moves.length, 2, 'dua bahan = dua riwayat');
  assert.equal(sandbox.DB.supplies[0].stock, 4.9);
  assert.equal(sandbox.DB.supplies[1].stock, 4.8);
  assert.ok(moves[0].batch && moves[0].batch === moves[1].batch, 'satu pemakaian harus satu batch (dasar hitung jumlah sesi)');
  assert.equal(moves[0].service_name, 'Massage Ibu Hamil');
  assert.equal(moves[0].reservation_id, 7);
  assert.equal(moves[0].source, 'recipe');
  // Pemakaian yang gagal (stok kurang) TIDAK boleh mengubah stok sama sekali
  const stokSebelum = sandbox.DB.supplies[0].stock;
  const movesGagal = vm.runInContext('applySupplyUse(supplyUsePlan("Massage Ibu Hamil", 9999), {})', sandbox);
  assert.equal(movesGagal.length, 0);
  assert.equal(sandbox.DB.supplies[0].stock, stokSebelum, 'stok berubah walau pemakaian ditolak');
});

test('Peringatan: teks pesanan & peringatan mengisi semua placeholder', () => {
  const items = [barang(1, 'Minyak Pijat', 1, 3, 50000, { supplier: 'Toko A', supplier_wa: '0812' })];
  const { ctx } = stockSandbox({ supplies: items });
  const low = ctx('lowStockSupplies()');
  assert.equal(low.length, 1);
  assert.equal(low[0].suggested_qty, 5);
  assert.equal(low[0].estimated_cost, 250000);
  const order = ctx('renderSupplyOrderText(lowStockSupplies(), { supplier: "Toko A" })');
  assert.match(order, /Minyak Pijat — 5 botol/);
  assert.match(order, /Rp250\.000/);
  assert.ok(!/\{daftar\}|\{total\}|\{bisnis\}|\{tanggal\}/.test(order), 'masih ada placeholder yang tidak terisi: ' + order);
  const alert = ctx('renderSupplyAlertText(lowStockSupplies())');
  assert.match(alert, /sisa 1 botol \(min 3\)/);
  assert.match(alert, /Toko A/);
  assert.ok(!/\{daftar\}|\{jumlah\}/.test(alert), 'placeholder peringatan tidak terisi: ' + alert);
});

test('Peringatan: tujuan WA, jeda anti-spam, dan syarat kredensial', () => {
  const items = [barang(1, 'Minyak Pijat', 1, 3, 50000)];
  // Nomor khusus peringatan dipakai lebih dulu daripada WA bisnis.
  const a = stockSandbox({ supplies: items, settings: { supply_alert_wa: '08123', whatsapp: '08999' } });
  assert.equal(a.ctx('supplyAlertRecipient()'), '08123');
  const b = stockSandbox({ supplies: items, settings: { whatsapp: '08999' } });
  assert.equal(b.ctx('supplyAlertRecipient()'), '08999');
  assert.equal(b.ctx('supplyWhatsReady()'), false, 'tanpa kredensial WA harus dianggap belum siap');
  const c = stockSandbox({ supplies: items, settings: { ai_assistant_phone_id: '1', ai_assistant_access_token: 'x' } });
  assert.equal(c.ctx('supplyWhatsReady()'), true);
  // Jeda: baru saja dikirim → tidak boleh kirim lagi
  const d = stockSandbox({ supplies: items, settings: { supply_alert_last_at: new Date().toISOString() } });
  assert.equal(d.ctx('supplyAlertDue()'), false);
  // Sudah lewat jeda → boleh
  const e = stockSandbox({ supplies: items, settings: { supply_alert_last_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() } });
  assert.equal(e.ctx('supplyAlertDue()'), true);
  // Tidak ada barang menipis → tidak pernah kirim
  const sehat = stockSandbox({ supplies: [barang(1, 'Minyak', 10, 1, 1000)] });
  assert.equal(sehat.ctx('supplyAlertDue()'), false);
  // Dimatikan admin
  const mati = stockSandbox({ supplies: items, settings: { supply_alert_enabled: false } });
  assert.equal(mati.ctx('supplyAlertDue()'), false);
});

test('Laporan: pembelian vs pemakaian per bulan + pemakaian per barang', () => {
  const items = [barang(1, 'Minyak Pijat', 3, 1, 50000)];
  const moves = [
    { id: 1, supply_id: 1, type: 'in', qty: 10, total_cost: 500000, date: '2026-08-05', at: '2026-08-05T02:00:00Z' },
    { id: 2, supply_id: 1, type: 'out', qty: 0.1, total_cost: 5000, date: '2026-09-02', at: '2026-09-02T02:00:00Z', service_name: 'Massage Ibu Hamil', batch: 'b1' },
    { id: 3, supply_id: 1, type: 'out', qty: 0.2, total_cost: 10000, date: '2026-09-03', at: '2026-09-03T02:00:00Z', service_name: 'Massage Ibu Hamil', batch: 'b1' },
    { id: 4, supply_id: 1, type: 'out', qty: 0.3, total_cost: 15000, date: '2026-09-04', at: '2026-09-04T02:00:00Z', service_name: 'Newborn Care', batch: 'b2' }
  ];
  const { ctx } = stockSandbox({ supplies: items, moves, today: '2026-09-22' });
  const cost = ctx('supplyCostByMonth(["2026-08","2026-09"])');
  assert.equal(cost.purchase['2026-08'], 500000);
  assert.equal(cost.purchase['2026-09'], 0);
  assert.equal(cost.material['2026-09'], 30000);
  assert.equal(cost.material_total, 30000, 'bulan di luar rentang tidak boleh ikut dihitung');
  assert.equal(ctx('supplyStockValue()'), 150000, 'nilai persediaan = stok × harga beli');
  const usage = ctx('supplyUsageByItem(30)');
  assert.equal(usage[1].used, 0.6);
  assert.equal(usage[1].cost_used, 30000);
  assert.equal(usage[1].sessions, 2, 'jumlah sesi dihitung dari batch unik');
});

test('Laporan: melihat riwayat lama tidak dihitung sebagai pemakaian baru', () => {
  const items = [barang(1, 'Minyak', 3, 1, 10000)];
  const moves = [{ id: 1, supply_id: 1, type: 'out', qty: 1, total_cost: 10000, date: '2026-07-01', at: '2026-07-01T02:00:00Z' }];
  const { ctx } = stockSandbox({ supplies: items, moves, today: '2026-09-22' });
  const usage = ctx('supplyUsageByItem(30)');
  assert.equal(usage[1], undefined, 'pemakaian Juli harus di luar jendela 30 hari');
});

test('Sambungan endpoint: stok wajib token, otomatis, dan tersambung ke fitur lain', () => {
  // Semua endpoint buku stok wajib token admin
  for (const r of [
    "app.get('/api/admin/supplies', auth",
    "app.post('/api/admin/supplies', auth",
    "app.patch('/api/admin/supplies/:id', auth",
    "app.delete('/api/admin/supplies/:id', auth",
    "app.post('/api/admin/supplies/:id/move', auth",
    "app.get('/api/admin/supplies/moves', auth",
    "app.delete('/api/admin/supplies/moves/:id', auth",
    "app.get('/api/admin/supplies/shopping-list', auth",
    "app.post('/api/admin/supplies/shopping-list/send', auth",
    "app.get('/api/admin/supplies/alerts', auth",
    "app.post('/api/admin/supplies/alerts/send', auth",
    "app.post('/api/admin/supplies/use', auth",
    "app.get('/api/admin/supplies/pending-uses', auth",
    "app.get('/api/admin/supplies/report', auth",
    "app.get('/api/admin/supplies/export.xlsx', auth",
    "app.get('/api/admin/supply-recipes', auth",
    "app.post('/api/admin/supply-recipes', auth",
    "app.delete('/api/admin/supply-recipes/:id', auth"
  ]) {
    assert.ok(serverSrc.includes(r), 'endpoint tidak terpasang atau tanpa auth: ' + r);
  }
  // Peringatan otomatis dijalankan berkala saat boot
  assert.match(serverSrc, /setInterval\(autoStockAlert, 30 \* 60 \* 1000\)/, 'scheduler peringatan stok tidak berjalan');
  assert.match(serverSrc, /if \(!supplyAlertDue\(\)\) return;/, 'scheduler tidak menghormati jeda anti-spam');
  // Dasbor menampilkan barang menipis
  const statsSection = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/stats'"), serverSrc.indexOf("app.get('/api/admin/stats'") + 900);
  assert.match(statsSection, /low_stock: lowStock.length/, 'statistik dasbor tidak memuat jumlah stok menipis');
  // Akunting memuat blok stok TANPA menghitung beban dua kali
  const acct = serverSrc.slice(serverSrc.indexOf("app.get('/api/admin/accounting/summary'"), serverSrc.indexOf("app.get('/api/admin/receipts/import'"));
  assert.match(acct, /const supply = supplyCostByMonth\(monthList\)/, 'ringkasan akunting tidak menghitung biaya bahan');
  assert.ok(!/totals\.expense\s*\+=\s*supply/.test(acct), 'biaya bahan ditambahkan ke total beban (dihitung dua kali)');
  assert.match(acct, /material_total: supply\.material_total/);
});

test('Sambungan data: normalisasi, backup, restore, dan pemulihan storage', () => {
  // State lama tanpa kunci stok harus tetap jalan
  assert.match(serverSrc, /'supplies', 'supply_moves', 'supply_recipes'\]\.forEach/, 'normalisasi state stok hilang');
  assert.match(serverSrc, /out\._seq\.supply_moves = out\._seq\.supply_moves \|\| 0/, 'penghitung id riwayat stok hilang');
  // Backup memuat data stok (kalau tidak, sisa stok & resep hilang saat restore)
  const backup = serverSrc.slice(serverSrc.indexOf('function buildBackupPayload'), serverSrc.indexOf("app.get('/api/admin/backup'"));
  assert.match(backup, /supplies: DB\.supplies/);
  assert.match(backup, /supply_moves: DB\.supply_moves/);
  assert.match(backup, /supply_recipes: DB\.supply_recipes/);
  assert.match(backup, /supply_alert_last_at,/);
  // Restore mengembalikan data stok + melaporkannya
  const restore = serverSrc.slice(serverSrc.indexOf("app.post('/api/admin/restore'"), serverSrc.indexOf('===== ADMIN — PROFILE'));
  assert.match(restore, /suppliesImported/, 'restore tidak mengembalikan barang');
  assert.match(restore, /supply_recipes: supplyRecipesImported/, 'restore tidak melaporkan resep');
  assert.match(restore, /expense_id: null/, 'riwayat hasil restore masih menautkan pengeluaran yang tidak ikut dipulihkan');
  // Pemulihan storage darurat ikut membawa data stok
  const merge = serverSrc.slice(serverSrc.indexOf('function mergeTransactionalState'), serverSrc.indexOf('function startDbRetryLoop'));
  assert.match(merge, /supplies_added/, 'pemulihan storage tidak menyalin barang');
  assert.match(merge, /report\.supply_moves_added\+\+/, 'pemulihan storage tidak menyalin riwayat stok');
});

test('Keamanan: data stok tidak bocor ke endpoint publik', () => {
  const pub = serverSrc.slice(serverSrc.indexOf("app.get('/api/public-settings'"), serverSrc.indexOf("['__proto__'") > 0 ? serverSrc.indexOf("app.get('/api/public-settings'") + 2000 : serverSrc.indexOf("app.get('/api/public-settings'") + 2000);
  assert.ok(!/supplies|supply_moves/.test(pub), 'public-settings menyebut data stok');
  // Kata sandi/kunci tidak pernah ikut pada respons stok
  const suppliesSection = serverSrc.slice(serverSrc.indexOf('// ===== BUKU STOK'), serverSrc.indexOf('// ===== PENGINGAT OTOMATIS'));
  assert.ok(!/ai_gemini_api_key|ai_openrouter_api_key|password_hash/.test(suppliesSection), 'bagian stok menyentuh kredensial');
});
