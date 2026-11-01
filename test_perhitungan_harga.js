/**
 * Tes rumus harga backend.
 *
 * Rumus ini dipakai untuk menghitung angka yang DITAGIH Midtrans, jadi
 * kesalahannya langsung terasa oleh pembeli. Tes ini juga mencocokkan hasil
 * dengan contoh yang sama seperti `test/unit/rincian_harga_test.dart` di
 * aplikasi Flutter — kalau salah satu berubah tanpa yang lain, salah satu
 * tes akan gagal.
 *
 * Jalankan: node test_perhitungan_harga.js
 */

const assert = require('assert');
const {
  hitungRincianHarga,
  hitungDiskonVoucher,
  normalkanTipe,
  TARIF_PAJAK_PERSEN,
  TARIF_LAYANAN_PERSEN,
  BIAYA_LAYANAN_TETAP,
} = require('./perhitungan_harga');

let lulus = 0;
const gagal = [];

function uji(nama, fn) {
  try {
    fn();
    lulus++;
    console.log(`  ok   ${nama}`);
  } catch (e) {
    gagal.push({ nama, pesan: e.message });
    console.log(`  GAGAL ${nama}`);
    console.log(`        ${e.message}`);
  }
}

console.log('\n== Tarif ==');
uji('pajak 10%, layanan 5%, tetap 5000', () => {
  assert.strictEqual(TARIF_PAJAK_PERSEN, 10);
  assert.strictEqual(TARIF_LAYANAN_PERSEN, 5);
  assert.strictEqual(BIAYA_LAYANAN_TETAP, 5000);
});

console.log('\n== Tanpa diskon ==');
uji('2 x 500.000', () => {
  const r = hitungRincianHarga(500000, 2);
  assert.strictEqual(r.subtotal, 1000000);
  assert.strictEqual(r.diskon, 0);
  assert.strictEqual(r.dasar, 1000000);
  assert.strictEqual(r.pajak, 100000);
  assert.strictEqual(r.layananPersen, 50000);
  assert.strictEqual(r.layananTetap, 5000);
  assert.strictEqual(r.totalBiaya, 155000);
  assert.strictEqual(r.total, 1155000);
});

console.log('\n== Dengan diskon: pajak & layanan ikut turun ==');
uji('diskon 50.000 dari 1.000.000', () => {
  const r = hitungRincianHarga(500000, 2, 50000);
  assert.strictEqual(r.dasar, 950000);
  assert.strictEqual(r.pajak, 95000); // 10% dari 950.000
  assert.strictEqual(r.layananPersen, 47500);
  assert.strictEqual(r.totalBiaya, 147500);
  assert.strictEqual(r.total, 1097500);
});

uji('diskon menurunkan total lebih dari nilai diskonnya', () => {
  const tanpa = hitungRincianHarga(500000, 2);
  const dengan = hitungRincianHarga(500000, 2, 50000);
  assert.strictEqual(tanpa.total - dengan.total, 57500);
});

console.log('\n== Pembulatan ==');
uji('total = jumlah komponen yang sudah dibulatkan', () => {
  const r = hitungRincianHarga(333333, 1);
  assert.strictEqual(
    r.total,
    r.dasar + r.pajak + r.layananPersen + r.layananTetap,
  );
  assert.strictEqual(r.total, 388333);
});

console.log('\n== Batas aman ==');
uji('diskon melebihi subtotal dibatasi', () => {
  const r = hitungRincianHarga(100000, 1, 500000);
  assert.strictEqual(r.diskon, 100000);
  assert.strictEqual(r.dasar, 0);
  assert.strictEqual(r.pajak, 0);
  assert.strictEqual(r.total, 5000); // hanya biaya layanan tetap
});

uji('diskon negatif diabaikan', () => {
  const r = hitungRincianHarga(100000, 1, -25000);
  assert.strictEqual(r.diskon, 0);
  assert.strictEqual(r.dasar, 100000);
});

uji('jumlah nol tidak menghasilkan angka negatif', () => {
  const r = hitungRincianHarga(100000, 0);
  assert.strictEqual(r.subtotal, 0);
  assert.strictEqual(r.total, 5000);
});

uji('harga atau jumlah tidak valid dianggap nol', () => {
  assert.strictEqual(hitungRincianHarga(null, 2).subtotal, 0);
  assert.strictEqual(hitungRincianHarga(100000, 'abc').subtotal, 0);
  assert.strictEqual(hitungRincianHarga(100000, -3).subtotal, 0);
});

console.log('\n== Validasi voucher ==');
uji('persentase 10% dari 1.000.000', () => {
  const v = hitungDiskonVoucher({ tipe: 'percentage', nilai: 10 }, 1000000);
  assert.strictEqual(v.diskon, 100000);
  assert.strictEqual(v.alasan, null);
});

uji('nominal tetap 75.000', () => {
  const v = hitungDiskonVoucher({ tipe: 'fixed', nilai: 75000 }, 1000000);
  assert.strictEqual(v.diskon, 75000);
});

uji('minimum belanja tidak terpenuhi', () => {
  const v = hitungDiskonVoucher(
    { tipe: 'fixed', nilai: 75000, minPembelian: 2000000 },
    1000000,
  );
  assert.strictEqual(v.diskon, 0);
  assert.ok(v.alasan, 'harus ada alasan');
});

uji('persentase di atas 100% dibatasi subtotal', () => {
  const v = hitungDiskonVoucher({ tipe: 'percentage', nilai: 150 }, 100000);
  assert.strictEqual(v.diskon, 100000);
});

uji('tanpa voucher = nol, tanpa alasan', () => {
  const v = hitungDiskonVoucher(null, 100000);
  assert.strictEqual(v.diskon, 0);
  assert.strictEqual(v.alasan, null);
});

console.log('\n== Cocok dengan Flutter (rincian_harga_test.dart) ==');
uji('persentase 10% pada 1.000.000 -> total 1.040.000', () => {
  const v = hitungDiskonVoucher({ tipe: 'percentage', nilai: 10 }, 1000000);
  const r = hitungRincianHarga(500000, 2, v.diskon);
  assert.strictEqual(r.total, 1040000);
});

uji('nominal 75.000 pada 1.000.000 -> total 1.068.750', () => {
  const v = hitungDiskonVoucher({ tipe: 'fixed', nilai: 75000 }, 1000000);
  const r = hitungRincianHarga(500000, 2, v.diskon);
  assert.strictEqual(r.total, 1068750);
});

console.log('\n== Normalisasi tipe diskon ==');
uji('kosakata aplikasi dikenali', () => {
  assert.strictEqual(normalkanTipe('percentage'), 'percentage');
  assert.strictEqual(normalkanTipe('fixed'), 'fixed');
});

uji('kosakata lama tetap dikenali', () => {
  assert.strictEqual(normalkanTipe('persen'), 'percentage');
  assert.strictEqual(normalkanTipe('nominal'), 'fixed');
});

uji('voucher 50% dari dokumen aplikasi tidak jadi Rp 50', () => {
  // Bug yang pernah ada: `tipe === 'persen'` gagal untuk 'percentage',
  // sehingga blok else memotong Rp 50 alih-alih 50%.
  const v = hitungDiskonVoucher({ tipe: 'percentage', nilai: 50 }, 200000);
  assert.strictEqual(v.diskon, 100000);
});

uji('voucher bertipe kosong dianggap nominal', () => {
  const v = hitungDiskonVoucher({ tipe: undefined, nilai: 25000 }, 200000);
  assert.strictEqual(v.diskon, 25000);
});

console.log(`\n${lulus} lulus, ${gagal.length} gagal\n`);
if (gagal.length > 0) {
  process.exitCode = 1;
}
