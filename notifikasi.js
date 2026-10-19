/**
 * notifikasi.js — satu pintu untuk NOTIFIKASI (inbox) + PUSH (FCM).
 *
 * Dipakai DUA pemakai supaya jalurnya identik:
 *   - server.js      -> notifikasi OTOMATIS (pembayaran, refund, batal)
 *   - pengumuman.js  -> pengumuman MANUAL yang diketik di terminal
 *
 * Tiap kali kirim = 2 hal sekaligus:
 *   1. dokumen di koleksi `notifications` -> muncul di inbox user (ikon lonceng)
 *   2. push FCM ke HP user               -> HP bergetar walau app ditutup
 *      (hanya bila user punya `fcmToken`, yaitu sudah pernah login di device)
 *
 * PRINSIP: semua kegagalan NON-FATAL. Notifikasi/push tidak boleh
 * menggagalkan transaksi utama (pembayaran / refund).
 */
'use strict';

const admin = require('firebase-admin');

const KOLEKSI_USER = 'users';
const KOLEKSI_NOTIF = 'notifications';
const CHANNEL_ANDROID = 'soundwave_updates'; // dibuat app di NotificationService.init()
const TIMEOUT_PUSH_MS = 8000; // jangan biarkan webhook Midtrans menggantung

/** Kode error FCM yang berarti token sudah mati -> aman dihapus. */
const TOKEN_MATI = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Bikin pengirim yang terikat ke instance Firestore + Messaging tertentu.
 * @param {{db: FirebaseFirestore.Firestore, messaging: object, log?: object}} opsi
 */
function buatPengirim({ db, messaging, log = console } = {}) {
  const tulis = (level, pesan) => {
    if (log && typeof log[level] === 'function') log[level](pesan);
  };

  /** Token FCM milik user (null bila belum pernah login di device). */
  async function ambilToken(userId) {
    try {
      const snap = await db.collection(KOLEKSI_USER).doc(userId).get();
      if (!snap.exists) return null;
      const t = snap.data().fcmToken;
      return typeof t === 'string' && t.trim() ? t.trim() : null;
    } catch (_) {
      return null; // data user tidak terbaca = anggap tidak punya token
    }
  }

  /** Hapus token yang sudah mati supaya tidak dicoba berulang tiap notifikasi. */
  async function hapusTokenMati(userId) {
    try {
      await db.collection(KOLEKSI_USER).doc(userId).update({
        fcmToken: null,
        fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {
      // user doc hilang / tidak bisa ditulis: tidak fatal
    }
  }

  /**
   * Tembakkan push ke SATU user.
   * @returns {Promise<'terkirim'|'tanpa_token'|'gagal'>}
   */
  async function kirimPush(userId, { title, message, type = 'info', refId = null } = {}) {
    if (!userId || !messaging) return 'tanpa_token';

    const token = await ambilToken(userId);
    if (!token) return 'tanpa_token'; // user belum pernah login di HP

    const payload = {
      token,
      notification: { title: title || 'SoundWave', body: message || '' },
      // data ikut dikirim supaya app bisa tahu ini notifikasi apa saat di-tap
      data: { type: String(type || 'info'), refId: refId ? String(refId) : '' },
      android: {
        priority: 'high',
        notification: {
          channelId: CHANNEL_ANDROID,
          sound: 'default',
          defaultVibrateTimings: true,
        },
      },
    };

    try {
      const janji = messaging.send(payload);
      janji.catch(() => {}); // cegah unhandled rejection bila timeout duluan
      await Promise.race([
        janji,
        new Promise((_, tolak) =>
          setTimeout(() => tolak(new Error('timeout push ' + TIMEOUT_PUSH_MS + 'ms')), TIMEOUT_PUSH_MS)),
      ]);
      return 'terkirim';
    } catch (e) {
      const kode = (e && e.code) || '';
      if (TOKEN_MATI.has(kode)) {
        await hapusTokenMati(userId);
        tulis('warn', '[push] token mati dibersihkan · ' + userId);
      } else {
        tulis('warn', '[push] gagal · ' + ((e && e.message) || e));
      }
      return 'gagal';
    }
  }

  /**
   * Kirim satu notifikasi lengkap: inbox (+ push bila diminta).
   * @returns {Promise<boolean>} true bila dokumen inbox berhasil tersimpan.
   */
  async function kirimNotifikasi(userId, {
    title,
    message,
    type = 'info',
    refId = null,
    push = true,
    sumber = 'BACKEND_AUTO',
  } = {}) {
    if (!userId) return false; // tanpa penerima = tidak ada yang dikirim

    try {
      await db.collection(KOLEKSI_NOTIF).add({
        userId,
        title,
        message,
        type: type || 'info',
        refId,
        read: false,
        readAt: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sumber,
      });
      tulis('info', 'notifikasi terkirim · ' + (type || 'info'));

      if (push) {
        // SENGAJA di-await supaya hasilnya bisa dilaporkan; kegagalannya
        // sudah ditelan di dalam kirimPush() -> tetap non-fatal.
        await kirimPush(userId, { title, message, type, refId });
      }
      return true;
    } catch (e) {
      tulis('warn', '[notifikasi] gagal kirim: ' + ((e && e.message) || e));
      return false;
    }
  }

  return { kirimNotifikasi, kirimPush, ambilToken, hapusTokenMati };
}

module.exports = {
  buatPengirim,
  KOLEKSI_USER,
  KOLEKSI_NOTIF,
  CHANNEL_ANDROID,
};
