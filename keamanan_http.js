'use strict';
/**
 * keamanan_http.js — header keamanan dan pembatas laju.
 *
 * Ditulis tanpa dependensi tambahan supaya proyek tetap ringan dan tetap
 * jalan di Firebase Spark. Cukup untuk menahan tembakan berulang ke endpoint
 * publik dan rute admin.
 */

function headerKeamanan(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Batasi jumlah permintaan per alamat IP dalam satu jendela waktu.
 * @param {{jendelaMs?: number, maks?: number, nama?: string}} opsi
 */
function batasiLaju({ jendelaMs = 60_000, maks = 60, nama = 'umum' } = {}) {
  const buku = new Map();

  // Bersihkan catatan lama supaya memori tidak tumbuh terus.
  const pembersih = setInterval(() => {
    const sekarang = Date.now();
    for (const [ip, catatan] of buku) {
      if (sekarang - catatan.mulai > jendelaMs) buku.delete(ip);
    }
  }, jendelaMs);
  if (typeof pembersih.unref === 'function') pembersih.unref();

  return function pembatas(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'tanpa-ip';
    const sekarang = Date.now();
    let catatan = buku.get(ip);

    if (!catatan || sekarang - catatan.mulai > jendelaMs) {
      catatan = { jumlah: 0, mulai: sekarang };
      buku.set(ip, catatan);
    }

    catatan.jumlah += 1;

    if (catatan.jumlah > maks) {
      const sisaDetik = Math.ceil((catatan.mulai + jendelaMs - sekarang) / 1000);
      res.setHeader('Retry-After', String(sisaDetik));
      return res.status(429).json({
        success: false,
        message: `Terlalu banyak permintaan ke ${nama}. Coba lagi dalam ${sisaDetik} detik.`,
      });
    }

    next();
  };
}

module.exports = { headerKeamanan, batasiLaju };
