/**
 * test_push.js — uji plumbing PUSH FCM TANPA perlu HP.
 *
 * Yang diuji (non-destruktif: bikin data uji sendiri lalu membersihkannya):
 *   1. FCM benar-benar menjawab  -> bukti API Cloud Messaging aktif & bisa
 *      dijangkau (dites pakai token palsu, jadi jawabannya berupa error).
 *   2. User dengan token MATI    -> inbox tetap tersimpan, push gagal dengan
 *      rapi (tidak crash), dan token mati dibersihkan otomatis.
 *   3. User tanpa token          -> inbox tetap tersimpan, push dilewati.
 *
 * Jalankan: node test_push.js
 */
'use strict';

const admin = require('firebase-admin');
const log = require('./logger');
const { buatPengirim, KOLEKSI_USER, KOLEKSI_NOTIF } = require('./notifikasi');

admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const db = admin.firestore();
const messaging = admin.messaging();

const TAG = 'ZZPUSH_' + Date.now();
const uidA = TAG + '_punya_token';
const uidB = TAG + '_tanpa_token';
const tokenPalsu = 'token-palsu-uji-' + TAG;

const TOKEN_MATI = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

const hasil = [];
const pesanLog = [];
function check(nama, kondisi, catatan) {
  hasil.push(!!kondisi);
  console.log((kondisi ? '[PASS] ' : '[FAIL] ') + nama + (catatan ? '  -> ' + catatan : ''));
}

const pengirim = buatPengirim({
  db,
  messaging,
  log: { info: () => {}, warn: (m) => pesanLog.push(String(m)) },
});

async function bersihkan() {
  try {
    const notif = await db.collection(KOLEKSI_NOTIF).where('refId', '==', TAG).get();
    await Promise.all(notif.docs.map((d) => d.ref.delete()));
    await db.collection(KOLEKSI_USER).doc(uidA).delete();
    await db.collection(KOLEKSI_USER).doc(uidB).delete();
    // sapu-rentang: notifikasi uji yang mungkin tercatat dengan refId lain
    const sisa = await db.collection(KOLEKSI_NOTIF).where('userId', 'in', [uidA, uidB]).get();
    await Promise.all(sisa.docs.map((d) => d.ref.delete()));
    return notif.size + sisa.size;
  } catch (e) {
    console.log('[WARN] pembersihan: ' + e.message);
    return -1;
  }
}

async function main() {
  console.log('');
  console.log('  UJI PUSH FCM  ·  ' + TAG);
  console.log('  ' + '─'.repeat(56));

  // ── 0. siapkan data uji ──
  await db.collection(KOLEKSI_USER).doc(uidA).set({
    email: TAG + '_a@uji.local', nama: 'Uji Punya Token', role: 'user',
    fcmToken: tokenPalsu, fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection(KOLEKSI_USER).doc(uidB).set({
    email: TAG + '_b@uji.local', nama: 'Uji Tanpa Token', role: 'user',
  });

  // ── 1. FCM menjawab? (token palsu -> harus error, bukan hang) ──
  let kodeMentah = null, pesanMentah = '';
  try {
    await messaging.send({ token: tokenPalsu, notification: { title: 'uji', body: 'uji' } });
  } catch (e) {
    kodeMentah = (e && e.code) || '(tanpa kode)';
    pesanMentah = (e && e.message) || String(e);
  }
  check('FCM menjawab (API Cloud Messaging aktif & terjangkau)', !!kodeMentah,
    'kode=' + kodeMentah);
  if (pesanMentah) console.log('       pesan: ' + String(pesanMentah).slice(0, 110));

  // ── 2. user PUNYA token (mati) ──
  const simpanA = await pengirim.kirimNotifikasi(uidA, {
    title: 'Uji Push A', message: 'Isi uji A', type: 'info', refId: TAG, push: false,
  });
  check('inbox user ber-token tersimpan', simpanA === true);

  const statusA = await pengirim.kirimPush(uidA, {
    title: 'Uji Push A', message: 'Isi uji A', type: 'info', refId: TAG,
  });
  check('push ke token palsu = "gagal" (tidak crash)', statusA === 'gagal', 'status=' + statusA);

  const docA = await db.collection(KOLEKSI_USER).doc(uidA).get();
  const tokenSesudah = docA.data() ? docA.data().fcmToken : 'user-hilang';
  if (TOKEN_MATI.has(kodeMentah)) {
    check('token mati dibersihkan otomatis', tokenSesudah === null, 'fcmToken=' + tokenSesudah);
  } else {
    console.log('[INFO] token tidak dihapus karena kode error bukan kode token-mati');
  }

  // ── 3. user TANPA token ──
  const simpanB = await pengirim.kirimNotifikasi(uidB, {
    title: 'Uji Push B', message: 'Isi uji B', type: 'info', refId: TAG, push: false,
  });
  check('inbox user tanpa token tetap tersimpan', simpanB === true);

  const statusB = await pengirim.kirimPush(uidB, {
    title: 'Uji Push B', message: 'Isi uji B', type: 'info', refId: TAG,
  });
  check('push user tanpa token dilewati', statusB === 'tanpa_token', 'status=' + statusB);

  // ── 4. isi dokumen inbox lengkap ──
  const notif = await db.collection(KOLEKSI_NOTIF).where('refId', '==', TAG).get();
  check('dua dokumen inbox tercipta', notif.size === 2, 'jumlah=' + notif.size);
  const n = notif.docs.length ? notif.docs[0].data() : {};
  check('field wajib ada & benar',
    n.userId === uidA && n.read === false && n.readAt === null &&
    n.title === 'Uji Push A' && n.type === 'info' && !!n.createdAt,
    'read=' + n.read + ' createdAt=' + (n.createdAt ? 'ada' : 'kosong'));

  // ── 5. cleanup ──
  const terhapus = await bersihkan();
  check('data uji dibersihkan', terhapus === 2, 'terhapus=' + terhapus);
  const sisaNotif = await db.collection(KOLEKSI_NOTIF).where('refId', '==', TAG).get();
  check('tidak ada sisa data uji', sisaNotif.size === 0, 'sisa=' + sisaNotif.size);

  // ── rekap ──
  const lulus = hasil.filter(Boolean).length;
  console.log('');
  console.log('  ' + '─'.repeat(56));
  console.log('  REKAP: ' + lulus + ' lulus, ' + (hasil.length - lulus) + ' gagal');
  console.log('');
  process.exitCode = lulus === hasil.length ? 0 : 1;
}

main().catch(async (e) => {
  console.error('[FATAL] ' + ((e && e.message) || e));
  await bersihkan();
  process.exitCode = 1;
});
