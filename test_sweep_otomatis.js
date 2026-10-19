// Uji: penyapu otomatis (tanpa endpoint) mengubah PENDING → EXPIRED
// begitu jendela 5 menit lewat. Membuktikan "langsung" tanpa app dibuka.
require('dotenv').config();
const admin = require('firebase-admin');
const sa = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const ref = db.collection('orders').doc('ZZAUTO_SWEEP');
  const detik = 6; // batas waktu dibuat sangat dekat supaya cepat diamati
  const mulai = Date.now();

  await ref.set({
    kodeBooking: 'ZZ-AUTO-1',
    idKonser: 'zz',
    idTiket: '',
    jumlahTiket: 1,
    totalHarga: 0,
    userId: 'zztest',
    status: 'PENDING',
    reservedUntil: admin.firestore.Timestamp.fromMillis(mulai + detik * 1000),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[INFO] pesanan dibuat, batas ${detik} detik dari sekarang`);

  let status = 'PENDING';
  let lewatDetik = null;
  while (Date.now() - mulai < 70000) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = (await ref.get()).data();
    if (d.status !== 'PENDING') {
      status = d.status;
      lewatDetik = Math.round((Date.now() - mulai) / 1000);
      break;
    }
  }

  const lapor = (ok, pesan) => console.log(`${ok ? '[PASS]' : '[GAGAL]'} ${pesan}`);
  lapor(status === 'EXPIRED',
    `status berubah sendiri jadi EXPIRED (status=${status})`);
  if (lewatDetik !== null) {
    const batasDetik = detik;
    const jeda = lewatDetik - batasDetik;
    lapor(jeda >= 0 && jeda <= 35,
      `berubah ${jeda} detik setelah batas waktu (penyapu tiap 30 detik)`);
  }
  await ref.delete();
  console.log('[INFO] pesanan uji dihapus');
  process.exit(status === 'EXPIRED' ? 0 : 1);
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
