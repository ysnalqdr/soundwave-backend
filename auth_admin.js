'use strict';
/**
 * auth_admin.js — penjaga rute /admin/*.
 *
 * Rute admin mengubah uang dan status pesanan, jadi tidak boleh terbuka.
 * Setiap permintaan wajib membawa header:
 *
 *   Authorization: Bearer <ID token Firebase>
 *
 * Token diverifikasi ke Firebase, lalu peran pengguna dibaca dari dokumen
 * users/{uid}. Hanya role 'admin' atau 'super_admin' yang lolos.
 * Aplikasi mengirim token lewat MidtransService._kepalaAdmin().
 */
const admin = require('firebase-admin');

const PERAN_DIIZINKAN = ['admin', 'super_admin'];

async function wajibAdmin(req, res, next) {
  const kepala = req.headers.authorization || '';
  const token = kepala.startsWith('Bearer ') ? kepala.slice(7).trim() : '';

  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: 'Token admin tidak ada' });
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    return res
      .status(401)
      .json({ success: false, message: 'Token admin tidak valid atau kedaluwarsa' });
  }

  try {
    const snap = await admin.firestore().collection('users').doc(uid).get();
    const peran = snap.exists ? snap.get('role') || '' : '';
    if (!PERAN_DIIZINKAN.includes(peran)) {
      return res
        .status(403)
        .json({ success: false, message: 'Akun ini bukan admin' });
    }
    req.admin = { uid, peran };
    return next();
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: 'Gagal memeriksa peran admin' });
  }
}

/**
 * Penjaga rute pengguna biasa.
 *
 * Rute seperti /create-transaction dan /request-refund dulu menerima
 * userId dari body permintaan, jadi siapa pun yang tahu ID orang lain
 * bisa bertindak atas namanya. Sekarang identitas diambil dari ID token,
 * bukan dari body.
 */
async function wajibPengguna(req, res, next) {
  const kepala = req.headers.authorization || '';
  const token = kepala.startsWith('Bearer ') ? kepala.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Rute ini butuh login. Sertakan ID token Firebase.',
    });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.pengguna = { uid: decoded.uid, email: decoded.email || null };
    return next();
  } catch (e) {
    return res.status(401).json({
      success: false,
      message: 'ID token tidak valid atau kedaluwarsa.',
    });
  }
}

module.exports = { wajibAdmin, wajibPengguna };
