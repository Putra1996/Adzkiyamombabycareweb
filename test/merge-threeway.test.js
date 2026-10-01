'use strict';
// Tes unit three-way merge antar instance (lihat threeWayMergeState di
// server.js). Merge lama berbasis union: reservasi yang dihapus instance
// lain hidup lagi, pindah jadwal membuat dobel, dan perubahan instance yang
// kalah rev dibuang. Tes ini mengunci perilaku yang benar tanpa database.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.VERCEL = '1';
process.env.DATA_FILE = path.join(os.tmpdir(), `merge-threeway-${process.pid}.json`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'merge-threeway-secret-lebih-dari-32-karakter';
delete process.env.DATABASE_URL;
const { _internals } = require('../server.js');
const merge = _internals.threeWayMergeState;

const R = (id, extra = {}) => ({ id, patient_name: 'P' + id, reservation_date: '2026-11-0' + id, total: 100, status: 'pending', ...extra });
const state = (reservations, extra = {}) => ({ _seq: { reservations: Math.max(0, ...reservations.map((r) => r.id)) }, reservations, ...extra });
const byId = (out) => Object.fromEntries(out.reservations.map((r) => [r.id, r]));

test('hapus di instance lain tidak dihidupkan lagi oleh instance basi', () => {
  const base = state([R(1), R(2)]);
  const theirs = state([R(1)]);            // instance lain menghapus #2
  const ours = state([R(1), R(2), R(3)]);  // kita (basi) menambah #3
  const out = merge(base, ours, theirs);
  assert.deepEqual(out.reservations.map((r) => r.id).sort(), [1, 3]);
});

test('hapus oleh kita diterapkan bila instance lain tidak mengubah item itu', () => {
  const base = state([R(1), R(2)]);
  const out = merge(base, state([R(1)]), state([R(1), R(2), R(5)]));
  assert.deepEqual(out.reservations.map((r) => r.id).sort(), [1, 5]);
});

test('pindah jadwal di instance lain tidak membuat reservasi dobel', () => {
  const base = state([R(1)]);
  const theirs = state([R(1, { reservation_date: '2027-01-01' })]);
  const out = merge(base, state([R(1)]), theirs);
  assert.equal(out.reservations.length, 1);
  assert.equal(out.reservations[0].reservation_date, '2027-01-01');
});

test('dua instance mengubah kolom berbeda pada item yang sama: keduanya tersimpan', () => {
  const base = state([R(1)]);
  const ours = state([R(1, { payment_status: 'lunas' })]);
  const theirs = state([R(1, { status: 'approved' })]);
  const r = byId(merge(base, ours, theirs))[1];
  assert.equal(r.status, 'approved');
  assert.equal(r.payment_status, 'lunas');
});

test('dua instance mengubah item BERBEDA: keduanya tersimpan', () => {
  const base = state([R(1), R(2)]);
  const out = byId(merge(base, state([R(1), R(2, { status: 'rejected' })]), state([R(1, { status: 'approved' }), R(2)])));
  assert.equal(out[1].status, 'approved');
  assert.equal(out[2].status, 'rejected');
});

test('hapus vs ubah: yang mengubah menang (tidak ada data hilang diam-diam)', () => {
  const base = state([R(1)]);
  assert.equal(merge(base, state([R(1, { status: 'approved' })]), state([])).reservations.length, 1);
  assert.equal(merge(base, state([]), state([R(1, { status: 'approved' })])).reservations.length, 1);
});

test('tabrakan ID item baru: keduanya disimpan, rujukan kwitansi ikut dipindah', () => {
  const base = state([R(1)], { receipts: [] });
  const ours = state([R(1), R(2, { patient_name: 'Kita' })], { receipts: [{ id: 1, reservation_id: 2, patient_name: 'Kita' }] });
  const theirs = state([R(1), R(2, { patient_name: 'Mereka' })], { receipts: [] });
  const out = merge(base, ours, theirs);
  assert.equal(out.reservations.length, 3);
  const kita = out.reservations.find((r) => r.patient_name === 'Kita');
  const mereka = out.reservations.find((r) => r.patient_name === 'Mereka');
  assert.equal(mereka.id, 2);
  assert.equal(kita.id, 3);
  assert.equal(out.receipts[0].reservation_id, 3);
  assert.ok(out._seq.reservations >= 3);
  assert.equal(new Set(out.reservations.map((r) => r.id)).size, 3);
});

test('penghitung nomor kwitansi & _seq mengambil nilai terbesar', () => {
  const base = state([], { invoice_counters: { '20261001': 3 } });
  const out = merge(base, state([], { invoice_counters: { '20261001': 5 } }), state([], { invoice_counters: { '20261001': 4, '20261002': 1 } }));
  assert.equal(out.invoice_counters['20261001'], 5);
  assert.equal(out.invoice_counters['20261002'], 1);
});
