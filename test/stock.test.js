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
  // recordAIError memakai sanitizeAIError() dari server.js; di sandbox cukup
  // dianggap tidak mengubah pesan.
  sandbox.sanitizeAIError = (e) => String((e && e.message) || e || '');
  sandbox._lastAIErrorSaved = { msg: null, src: null, at: 0 };
  // Konstanta diambil apa adanya dari server.js (bukan ditulis ulang) supaya
  // batas atas jumlah stok ikut teruji.
  const qtyMax = /const SUPPLY_QTY_MAX = (\d+);/.exec(serverSrc);
  assert.ok(qtyMax, 'konstanta SUPPLY_QTY_MAX tidak ditemukan di server.js');
  sandbox.SUPPLY_QTY_MAX = Number(qtyMax[1]);
  sandbox.SUPPLY_MONEY_MAX = Number(/const SUPPLY_MONEY_MAX = (\d+);/.exec(serverSrc)[1]);
  vm.createContext(sandbox);
  for (const fn of [
    'function shiftDateStr',
    'function roundQty',
    'function clampQty',
    'function supplyStock',
    'function supplyLowStock',
    'function restockSuggestion',
    'function supplyStockValue',
    'function clampMoney',
    'function parseNumberInput',
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
    'function supplyUsageByItem',
    'function recordAIError',
    'function clearAIError'
  ]) {
    vm.runInContext(block(fn), sandbox);
  }
    // Isi awal berupa POJO → perlu "diadopsi" jadi referensi sandbox supaya
  // mutasi stok terlihat oleh tes.
  const ctx = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, ctx };
}

// ---------- sandbox pemulihan storage (merge) ----------
function mergeSandbox() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(block('function normalizeStateObject'), sandbox);
  vm.runInContext(block('function mergeTransactionalState'), sandbox);
  return sandbox;
}
function mergeState(sandbox, dbState, liveState) {
  return vm.runInContext(
    'mergeTransactionalState(JSON.parse(' + JSON.stringify(JSON.stringify(dbState)) + '), JSON.parse(' + JSON.stringify(JSON.stringify(liveState)) + '))',
    sandbox
  );
}
const hasDuplicateIds = (arr) => {
  const ids = (arr || []).map((x) => x.id);
  return ids.length !== new Set(ids).size;
};

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

test('Angka: input bukan angka DITOLAK, bukan dibaca sebagai 0', () => {
  const { ctx } = stockSandbox();
  // Dulu "abc" berubah jadi 0 sehingga stok bisa hilang tanpa peringatan.
  for (const bad of ['', '  ', 'abc', null, undefined, true, false, [], {}, 'Infinity', NaN]) {
    assert.equal(ctx('parseNumberInput(' + JSON.stringify(bad) + ')'), null, 'input ' + JSON.stringify(bad) + ' harus ditolak');
  }
  assert.equal(ctx('parseNumberInput(0)'), 0, 'nol adalah angka yang sah (stok boleh 0)');
  assert.equal(ctx('parseNumberInput("2.5")'), 2.5, 'angka dalam bentuk teks tetap diterima');
  assert.equal(ctx('parseNumberInput(-3)'), -3, 'nilai negatif diteruskan agar bisa divalidasi pemanggil');
});

test('Uang: harga satuan dibatasi & tidak pernah NaN', () => {
  const { ctx } = stockSandbox();
  assert.equal(ctx('clampMoney(45000)'), 45000);
  assert.equal(ctx('clampMoney(-100)'), 0);
  assert.equal(ctx('clampMoney("abc")'), 0);
  // Infinity tidak mungkin datang dari HTTP (JSON mengubahnya jadi null) —
  // nilainya dianggap tidak sah, bukan dibulatkan menjadi angka raksasa.
  assert.equal(ctx('clampMoney(Infinity)'), 0);
  assert.equal(ctx('clampMoney(1e21)'), 1000000000, 'harga tidak boleh merusak laporan dengan angka mustahil');
  assert.equal(ctx('clampMoney(0.4)'), 0);
  assert.equal(ctx('clampMoney(1000.6)'), 1001);
  // Harga beli dari restok juga dibatasi
  const items = [barang(1, 'Minyak', 0, 1, 1000)];
  const { sandbox } = stockSandbox({ supplies: items, settings: {} });
  sandbox.ctx = null;
  vm.runInContext('recordSupplyMove(DB.supplies[0], { type: "in", qty: 1, unit_cost: 1e21 })', sandbox);
  assert.equal(sandbox.DB.supplies[0].cost, 1000000000);
  assert.equal(sandbox.DB.supply_moves[0].total_cost, 1000000000);
});

test('Pemakaian: resep tanpa bahan tersisa tidak dianggap berhasil', () => {
  const items = [barang(1, 'Minyak', 5, 1, 1000)];
  const recipes = [{ id: 1, service_name: 'A', items: [{ supply_id: 99, qty: 1 }] }]; // bahan sudah dihapus
  const { sandbox, ctx } = stockSandbox({ supplies: items, recipes });
  const plan = ctx('supplyUsePlan("A", 1)');
  assert.equal(plan.found, true, 'resepnya tetap ada');
  assert.equal(plan.items.length, 0, 'tidak ada bahan valid');
  assert.equal(plan.ok, false, 'resep kosong tidak boleh dianggap cukup');
  assert.equal(plan.total_cost, 0);
  // applySupplyUse() wajib tidak mengubah apa pun
  const moves = vm.runInContext('applySupplyUse(supplyUsePlan("A", 1), {})', sandbox);
  assert.equal(moves.length, 0, 'pemakaian tanpa bahan valid tidak boleh menghasilkan pergerakan');
  assert.equal(sandbox.DB.supplies[0].stock, 5);
  assert.equal(sandbox.DB.supply_moves.length, 0);
});

test('Pemulihan storage: ID selalu baru & rujukan dipetakan (tidak ada ID bentrok)', () => {
  const sb = mergeSandbox();
  // Database sudah berisi id 1 (yang biasa terjadi), file darurat juga mulai dari 1.
  const dbState = {
    reservations: [{ id: 1, patient_name: 'Pasien Lama', reservation_date: '2026-09-01', total: 80000 }],
    receipts: [{ id: 1, invoice_no: 'INV-20260901-001', patient_name: 'Pasien Lama', service_date: '2026-09-01', total: 80000 }],
    expenses: [{ id: 1, date: '2026-09-01', category: 'cat_bensin', amount: 20000, description: 'bensin' }],
    packages: [{ id: 1, patient_name: 'Pasien Lama', service_name: 'Newborn Care 5 Days', total_sessions: 5, used_sessions: [] }],
    supplies: [{ id: 1, name: 'Lotion', stock: 5, cost: 1000 }],
    supply_moves: [{ id: 1, supply_id: 1, type: 'in', qty: 5, date: '2026-09-01', at: 'x1' }],
    supply_recipes: [],
    _seq: { reservations: 1, receipts: 1, expenses: 1, packages: 1, supplies: 1, supply_moves: 1 }
  };
  const liveState = {
    reservations: [{ id: 1, patient_name: 'Pasien Darurat', reservation_date: '2026-09-22', total: 100000, payment_status: 'unpaid' }],
    receipts: [{ id: 1, invoice_no: 'INV-20260922-001', patient_name: 'Pasien Darurat', service_date: '2026-09-22', total: 100000 }],
    expenses: [{ id: 5, date: '2026-09-22', category: 'cat_supplies', amount: 50000, description: 'Restok Minyak', supply_id: 9, supply_move_id: 4 }],
    packages: [{ id: 1, patient_name: 'Pasien Darurat', service_name: 'Newborn Care 7 Days', total_sessions: 7, used_sessions: [{ date: '2026-09-22' }], receipt_id: 1, reservation_id: 1 }],
    supplies: [{ id: 9, name: 'Minyak', stock: 2, cost: 2000 }],
    supply_moves: [{ id: 4, supply_id: 9, type: 'in', qty: 10, date: '2026-09-22', at: 'x2', expense_id: 5, reservation_id: 1 }],
    supply_recipes: [{ id: 1, service_name: 'Massage Ibu Hamil', items: [{ supply_id: 9, qty: 0.2 }] }],
    broadcasts: [{ id: 1, name: 'Promo', recipient_count: 3, created_at: '2026-09-22T00:00:00Z' }],
    _seq: { reservations: 1, receipts: 1, expenses: 5, packages: 1, supplies: 9, supply_moves: 4, supply_recipes: 1, broadcasts: 1 }
  };
  const out = mergeState(sb, dbState, liveState);
  const st = out.state;
  for (const [label, arr] of [
    ['reservasi', st.reservations], ['kwitansi', st.receipts], ['pengeluaran', st.expenses],
    ['paket', st.packages], ['barang', st.supplies], ['riwayat', st.supply_moves],
    ['resep', st.supply_recipes], ['broadcast', st.broadcasts]
  ]) {
    assert.equal(hasDuplicateIds(arr), false, `ID ${label} bentrok setelah pemulihan: ` + arr.map((x) => x.id).join(','));
  }
  // ID baru tidak menabrak ID lama maupun ID dari file darurat
  const newRes = st.reservations.find((r) => r.patient_name === 'Pasien Darurat');
  assert.ok(newRes.id > 1, 'reservasi hasil pemulihan harus dapat ID baru: ' + newRes.id);
  assert.equal(st.reservations.filter((r) => r.id === 1).length, 1);
  // Paket sesi IKUT dipulihkan (dulu hilang) + rujukannya dipetakan
  assert.equal(out.report.packages_added, 1, 'paket sesi tidak ikut tersalin');
  const pkg = st.packages.find((p) => p.patient_name === 'Pasien Darurat');
  assert.equal(pkg.reservation_id, newRes.id, 'rujukan paket → reservasi tidak dipetakan');
  assert.equal(pkg.receipt_id, st.receipts.find((r) => r.patient_name === 'Pasien Darurat').id);
  // Riwayat stok & pengeluaran saling tertaut dengan ID baru
  const move = st.supply_moves.find((m) => m.id !== 1);
  const expense = st.expenses.find((e) => e.id !== 1);
  assert.equal(st.supplies.filter((s) => s.id === move.supply_id).length, 1, 'riwayat stok menunjuk barang yang tidak ada');
  assert.equal(move.expense_id, expense.id, 'tautan riwayat → pengeluaran tidak dipetakan');
  assert.equal(expense.supply_move_id, move.id, 'tautan pengeluaran → riwayat tidak dipetakan');
  assert.equal(expense.supply_id, move.supply_id);
  // Penghitung naik sehingga data baru berikutnya tidak menabrak
  for (const key of ['reservations', 'receipts', 'expenses', 'packages', 'supplies', 'supply_moves', 'supply_recipes', 'broadcasts']) {
    const maxId = Math.max(0, ...st[key].map((x) => x.id));
    assert.ok(st._seq[key] >= maxId, `_seq.${key} (${st._seq[key]}) lebih kecil dari ID maksimum (${maxId})`);
  }
});

test('Pemulihan storage: riwayat yatim dilewati, data kembar tidak digandakan', () => {
  const sb = mergeSandbox();
  const dbState = { expenses: [], reservations: [], receipts: [], packages: [], supplies: [], supply_moves: [], supply_recipes: [], _seq: {} };
  const liveState = {
    supplies: [{ id: 3, name: 'Minyak', stock: 1, cost: 100 }],
    supply_moves: [
      { id: 1, supply_id: 3, type: 'in', qty: 2, date: '2026-09-22', at: 'a' },
      { id: 2, supply_id: 77, type: 'in', qty: 2, date: '2026-09-22', at: 'b' } // barang tidak ada di mana pun
    ],
    supply_recipes: [{ id: 1, service_name: 'A', items: [{ supply_id: 3, qty: 1 }, { supply_id: 77, qty: 1 }] }],
    reservations: [], receipts: [], expenses: [], packages: [], broadcasts: [], _seq: {}
  };
  const out = mergeState(sb, dbState, liveState);
  assert.equal(out.state.supply_moves.length, 1, 'riwayat tanpa barang ikut tersalin (yatim)');
  assert.equal(out.state.supply_recipes[0].items.length, 1, 'bahan yang tidak ada tetap tertulis di resep');
  // Pemulihan kedua kalinya tidak menggandakan apa pun
  const out2 = mergeState(sb, out.state, liveState);
  assert.equal(out2.state.supply_moves.length, 1, 'riwayat digandakan saat pemulihan diulang');
  assert.equal(out2.state.supply_recipes.length, 1, 'resep digandakan saat pemulihan diulang');
  assert.equal(out2.report.supply_moves_added, 0);
});

test('Barang nonaktif: tidak memicu peringatan / daftar belanja, tapi tetap terlihat', () => {
  const items = [barang(1, 'Masih Dipakai', 1, 3, 10000), barang(2, 'Sudah Dihentikan', 0, 5, 20000, { active: false })];
  const { ctx } = stockSandbox({ supplies: items });
  const low = ctx('lowStockSupplies()');
  assert.equal(low.length, 1, 'barang nonaktif tidak boleh memicu peringatan: ' + JSON.stringify(low.map((x) => x.name)));
  assert.equal(low[0].name, 'Masih Dipakai');
  // Nilai mentahnya tetap benar supaya kartu barang bisa memberi catatan
  assert.equal(ctx('supplyLowStock(DB.supplies[1])'), true, 'stok barang nonaktif tetap tercatat di bawah minimum');
  assert.equal(ctx('supplyLowStock(DB.supplies[0])'), true);
});

test('Resep dengan bahan nonaktif ditandai (bukan dipakai diam-diam)', () => {
  const items = [barang(1, 'Aktif', 9, 1, 10000), barang(2, 'Discontinued', 9, 1, 5000, { active: false })];
  const recipes = [{ id: 1, service_name: 'Layanan X', items: [{ supply_id: 1, qty: 1 }, { supply_id: 2, qty: 2 }] }];
  const { ctx } = stockSandbox({ supplies: items, recipes });
  const plan = ctx('supplyUsePlan("Layanan X", 1)');
  assert.equal(plan.items.length, 2);
  assert.equal(plan.inactive.length, 1, 'bahan nonaktif tidak ditandai');
  assert.equal(plan.inactive[0].name, 'Discontinued');
  assert.equal(plan.ok, false, 'rencana dengan bahan nonaktif tidak boleh dianggap siap');
  // Tanpa bahan nonaktif, rencana normal
  const bersih = [{ id: 2, service_name: 'Layanan Y', items: [{ supply_id: 1, qty: 1 }] }];
  const sb2 = stockSandbox({ supplies: items, recipes: bersih });
  const plan2 = sb2.ctx('supplyUsePlan("Layanan Y", 1)');
  assert.equal(plan2.inactive.length, 0);
  assert.equal(plan2.ok, true);
});

test('Galat AI vs galat WhatsApp dibedakan sumbernya', () => {
  const sb = stockSandbox({ supplies: [barang(1, 'X', 1, 0, 1000)] });
  sb.sandbox.DB.settings = { business_name: 'Adzkiya' };
  vm.runInContext('recordAIError(new Error("WA send 401"), "stock_alert")', sb.sandbox);
  assert.equal(sb.sandbox.DB.settings.ai_last_error, 'WA send 401');
  assert.equal(sb.sandbox.DB.settings.ai_last_error_source, 'stock_alert');
  // Tanpa sumber, dianggap galat AI
  sb.sandbox._lastAIErrorSaved = { msg: null, src: null, at: 0 };
  vm.runInContext('recordAIError(new Error("gemini 429"))', sb.sandbox);
  assert.equal(sb.sandbox.DB.settings.ai_last_error_source, 'ai');
  // Dibersihkan setelah AI berhasil
  vm.runInContext('clearAIError()', sb.sandbox);
  assert.equal(sb.sandbox.DB.settings.ai_last_error, null);
  assert.equal(sb.sandbox.DB.settings.ai_last_error_source, null);
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
  // Barang nonaktif dihormati (peringatan/daftar belanja) & bahan nonaktif ditolak
  assert.match(serverSrc, /filter\(\(s\) => s\.active !== false && supplyLowStock\(s\)\)/, 'barang nonaktif masih memicu peringatan');
  assert.match(serverSrc, /Resep ini masih memakai bahan yang sudah dinonaktifkan/, 'bahan nonaktif masih boleh dipakai tanpa peringatan');
  // Jumlah sesi eksplisit divalidasi (dulu 0 → 1 sesi diam-diam)
  assert.match(serverSrc, /Jumlah sesi harus angka ≥ 1/, 'jumlah sesi tidak divalidasi');
  // Riwayat lama tanpa angka stok sebelumnya tidak boleh membuat stok 0
  assert.match(serverSrc, /tidak menyimpan angka stok sebelumnya/, 'pembatalan riwayat lama masih bisa mengosongkan stok');
  // Galat pengiriman WA diberi sumber supaya tidak terbaca sebagai galat AI
  assert.match(serverSrc, /recordAIError\(e, 'stock_alert'\)/, 'galat peringatan stok tidak diberi sumber');
  assert.match(serverSrc, /recordAIError\(e, 'reminder'\)/, 'galat pengingat tidak diberi sumber');
  // Validasi angka & uang benar-benar dipakai di endpoint
  assert.match(serverSrc, /const qtyRaw = parseNumberInput\(b\.qty\)/, 'pergerakan stok tidak memvalidasi jumlah');
  assert.match(serverSrc, /Sisa stok harus berupa angka/, 'edit barang tidak menolak stok bukan angka');
  assert.match(serverSrc, /if \(!plan\.items\.length\)/, 'pemakaian resep kosong tidak ditolak');
  assert.match(serverSrc, /if \(!moves\.length\)/, 'pemakaian tanpa efek masih dianggap berhasil');
  assert.match(serverSrc, /if \(r\.status === 'rejected'\) return;/, 'daftar tunggu pemakaian masih memuat reservasi yang ditolak');
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
  assert.match(merge, /report\.packages_added\+\+/, 'pemulihan storage tidak menyalin paket sesi');
  assert.match(merge, /const nextSeq = \(key, \.\.\.sources\)/, 'pemulihan storage tidak menghitung ID berikutnya dengan aman');
  // Semua jenis data harus memakai ID baru (id: <seq>) — pernah tidak, sehingga
  // dua transaksi berbeda ber-ID sama dan tombol Setujui/Hapus bisa salah sasaran.
  for (const marker of ['target.reservations.push({ ...r, id: resSeq })', 'target.receipts.push({ ...k, id: recSeq })',
    'target.expenses.push({', 'target.broadcasts.push({ ...b, id: bcSeq })', 'target.packages.push({']) {
    assert.ok(merge.includes(marker), 'salinan tanpa ID baru: ' + marker);
  }
  assert.match(merge, /expIdMap\.get\(oldExpenseId\)/, 'tautan riwayat stok → pengeluaran tidak dipetakan setelah ID berubah');
});

test('Keamanan: data stok tidak bocor ke endpoint publik', () => {
  const pub = serverSrc.slice(serverSrc.indexOf("app.get('/api/public-settings'"), serverSrc.indexOf("['__proto__'") > 0 ? serverSrc.indexOf("app.get('/api/public-settings'") + 2000 : serverSrc.indexOf("app.get('/api/public-settings'") + 2000);
  assert.ok(!/supplies|supply_moves/.test(pub), 'public-settings menyebut data stok');
  // Kata sandi/kunci tidak pernah ikut pada respons stok
  const suppliesSection = serverSrc.slice(serverSrc.indexOf('// ===== BUKU STOK'), serverSrc.indexOf('// ===== PENGINGAT OTOMATIS'));
  assert.ok(!/ai_gemini_api_key|ai_openrouter_api_key|password_hash/.test(suppliesSection), 'bagian stok menyentuh kredensial');
});
