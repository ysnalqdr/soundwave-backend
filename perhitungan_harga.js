/**
 * Rincian harga pesanan — SATU RUMUS, dicerminkan dari Flutter.
 *
 * Sumber kebenaran di sisi aplikasi: `lib/utils/rincian_harga.dart`.
 * Keduanya harus menghasilkan angka identik; kalau berbeda, pembeli melihat
 * satu angka di layar dan ditagih angka lain oleh Midtrans.
 *
 * ## Kenapa file ini ada
 *
 * Sebelumnya total dihitung di sini sebagai:
 *
 *     harga x jumlah + 5000          ← TANPA diskon, TANPA pajak
 *
 * sementara Flutter menghitung:
 *
 *     subtotal + 5000 - diskon
 *
 * Lalu blok `if (totalHarga !== authoritativeTotal)` MENIMPA nilai klien.
 * Akibatnya voucher yang dipilih pembeli hilang tepat saat pembayaran
 * dimulai — dan tidak ada jejak voucher di pesanan, sehingga refund
 * menghitung ulang dari total penuh.
 *
 * ## Urutan perhitungan (Opsi A — disepakati)
 *
 *     subtotal   = hargaSatuan x jumlah
 *     diskon     = voucher, dibatasi subtotal
 *     dasar      = subtotal - diskon        ← dasar pengenaan pajak
 *     pajak 10%  = dasar x 10%              ← PBJT / pajak hiburan
 *     layanan 5% = dasar x 5%
 *     layanan    = Rp 5.000 (tetap)
 *     total      = dasar + pajak + layanan5% + layananTetap
 *
 * Semua nilai dibulatkan PER KOMPONEN, lalu total adalah jumlah komponen
 * yang sudah dibulatkan. Dengan begitu angka di layar selalu sama dengan
 * yang ditagih — tidak ada selisih beberapa rupiah.
 */

/** Tarif pajak hiburan (PBJT) dalam persen. */
const TARIF_PAJAK_PERSEN = 10;

/** Tarif biaya layanan berbasis persentase. */
const TARIF_LAYANAN_PERSEN = 5;

/** Biaya layanan tetap per transaksi, dalam rupiah. */
const BIAYA_LAYANAN_TETAP = 5000;

/**
 * Hitung seluruh rincian harga satu pesanan.
 *
 * @param {number} hargaSatuan Harga tiket dari database (bukan dari klien).
 * @param {number} jumlah Jumlah tiket.
 * @param {number} [diskon=0] Potongan voucher dalam rupiah. Pemanggil wajib
 *   memvalidasi voucher lebih dulu lewat `hitungDiskonVoucher`; fungsi ini
 *   hanya membatasi agar tidak melebihi subtotal.
 * @returns {{
 *   subtotal: number, diskon: number, dasar: number, pajak: number,
 *   layananPersen: number, layananTetap: number, totalBiaya: number,
 *   total: number
 * }}
 */
function hitungRincianHarga(hargaSatuan, jumlah, diskon = 0) {
  const harga = Number(hargaSatuan) || 0;
  const qty = Math.max(0, Math.floor(Number(jumlah) || 0));

  const subtotal = Math.round(harga * qty);

  let potongan = Math.round(Number(diskon) || 0);
  if (potongan < 0) potongan = 0;
  if (potongan > subtotal) potongan = subtotal;

  const dasar = subtotal - potongan;

  const pajak = Math.round((dasar * TARIF_PAJAK_PERSEN) / 100);
  const layananPersen = Math.round((dasar * TARIF_LAYANAN_PERSEN) / 100);
  const layananTetap = BIAYA_LAYANAN_TETAP;

  const totalBiaya = pajak + layananPersen + layananTetap;
  const total = dasar + totalBiaya;

  return {
    subtotal,
    diskon: potongan,
    dasar,
    pajak,
    layananPersen,
    layananTetap,
    totalBiaya,
    total,
  };
}

/**
 * Normalkan tipe diskon ke dua nilai baku: 'percentage' atau 'fixed'.
 *
 * ## Kenapa perlu
 *
 * Aplikasi Flutter menulis tipe sebagai `percentage` / `fixed`
 * (`lib/models/promo_model.dart`), sementara endpoint lama di server ini
 * memakai `persen` / `nominal`. Endpoint `/validate-promo` dulu memeriksa
 * `tipe === 'persen'`; karena dokumen yang dibuat admin berisi
 * `percentage`, kondisinya selalu salah dan blok `else` mengambil alih —
 * voucher **50% dianggap potongan Rp 50**. Kesalahan yang tidak terlihat
 * sampai ada pembeli memakainya.
 *
 * Fungsi ini menerima kedua kosakata supaya dokumen lama dan baru sama-sama
 * terbaca benar.
 *
 * @param {string} tipe Nilai mentah dari dokumen.
 * @returns {'percentage'|'fixed'}
 */
function normalkanTipe(tipe) {
  const t = String(tipe || '').toLowerCase().trim();
  if (t === 'percentage' || t === 'persen' || t === 'percent' || t === '%') {
    return 'percentage';
  }
  return 'fixed';
}

/**
 * Validasi voucher dan hitung potongannya.
 *
 * Aturan sama dengan `PromoCodeModel.discountAmount` di Flutter:
 *   * `percentage` → subtotal x (nilai / 100), dibatasi subtotal
 *   * `fixed`      → nilai, dibatasi subtotal
 *   * subtotal di bawah `minPembelian` → 0
 *
 * Fungsi ini TIDAK memeriksa masa berlaku / kuota / status aktif: itu tugas
 * pemanggil, karena pesanan lama boleh memakai voucher yang kini sudah
 * kedaluwarsa. Yang dijaga di sini hanya matematikanya.
 *
 * @param {object|null} promo Dokumen `promo_codes`, atau null.
 * @param {number} subtotal Subtotal pesanan.
 * @returns {{diskon: number, alasan: string|null}} `alasan` berisi pesan
 *   untuk pengguna bila potongan nol karena suatu sebab.
 */
function hitungDiskonVoucher(promo, subtotal) {
  if (!promo) return { diskon: 0, alasan: null };

  const min = Number(promo.minPembelian) || 0;
  if (subtotal < min) {
    return {
      diskon: 0,
      alasan: `Minimum belanja untuk voucher ini ${min}`,
    };
  }

  const nilai = Number(promo.nilai) || 0;
  let potongan;

  if (normalkanTipe(promo.tipe) === 'percentage') {
    potongan = Math.round(subtotal * (nilai / 100));
  } else {
    potongan = Math.round(nilai);
  }

  if (potongan < 0) potongan = 0;
  if (potongan > subtotal) potongan = subtotal;

  return { diskon: potongan, alasan: null };
}

module.exports = {
  TARIF_PAJAK_PERSEN,
  TARIF_LAYANAN_PERSEN,
  BIAYA_LAYANAN_TETAP,
  hitungRincianHarga,
  hitungDiskonVoucher,
  normalkanTipe,
};
