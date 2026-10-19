// Uji penyapu reservasi: RESERVED kedaluwarsa → EXPIRED + stok kembali SEKALI.
require('dotenv').config();
const admin = require('firebase-admin');
const sa = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const URL = 'http://localhost:3000/sweep-expired';
const { ambilToken, pesanLewati } = require('./token_uji');

const lapor = (ok, pesan) => console.log(`${ok ? '[PASS]' : '[GAGAL]'} ${pesan}`);

(async () => {
  // Rute /sweep-expired dijaga token, jadi skrip ini butuh ID token.
  const TOKEN = await ambilToken('zztest');
  if (!TOKEN) {
    pesanLewati('test_sweep_reservasi.js');
    process.exit(0);
  }

  const tiketSnap = await db.collection('tickets').limit(1).get();
  if (tiketSnap.empty) throw new Error('tidak ada tiket untuk diuji');
  const tiketDoc = tiketSnap.docs[0];
  const tiketRef = tiketDoc.ref;
  const sebelum = tiketDoc.data();
  const stokAwal = sebelum.stok || 0;
  const terjualAwal = sebelum.terjual || 0;

  const orderRef = db.collection('orders').doc('ZZSWEEP_ORDER');
  const lewat = admin.firestore.Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);

  // 1) RESERVED kedaluwarsa, stok sudah dipotong
  await orderRef.set({
    kodeBooking: 'ZZ-SWEEP-1',
    idKonser: sebelum.idKonser || 'zz',
    idTiket: tiketRef.id,
    jumlahTiket: 2,
    totalHarga: 200000,
    userId: 'zztest',
    status: 'RESERVED',
    stokDipotong: true,
    reservedUntil: lewat,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2) PENDING kedaluwarsa, stok BELUM dipotong
  const orderPendingRef = db.collection('orders').doc('ZZSWEEP_PENDING');
  await orderPendingRef.set({
    kodeBooking: 'ZZ-SWEEP-2',
    idKonser: sebelum.idKonser || 'zz',
    idTiket: tiketRef.id,
    jumlahTiket: 1,
    totalHarga: 100000,
    userId: 'zztest',
    status: 'PENDING',
    reservedUntil: lewat,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const panggilSweep = async () => {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
    });
    return r.json();
  };

  const hasil1 = await panggilSweep();
  console.log('sweep#1:', JSON.stringify(hasil1));

  const o1 = (await orderRef.get()).data();
  const o2 = (await orderPendingRef.get()).data();
  const tiketSetelah = (await tiketRef.get()).data();

  lapor(o1.status === 'EXPIRED', `RESERVED → EXPIRED (status=${o1.status})`);
  lapor(o1.stokDilepas === true, `RESERVED ditandai stokDilepas=true`);
  lapor(o2.status === 'EXPIRED', `PENDING → EXPIRED (status=${o2.status})`);
  lapor(o2.stokDilepas === undefined, 'PENDING TIDAK melepas stok (memang belum dipotong)');
  lapor(tiketSetelah.stok === stokAwal + 2,
    `stok kembali tepat +2 (${stokAwal} → ${tiketSetelah.stok})`);
  // terjual tidak boleh negatif: kalau data lama 0, tetap 0 (lantai nol)
  const terjualHarap = Math.max(0, terjualAwal - 2);
  lapor(tiketSetelah.terjual === terjualHarap,
    `terjual turun tepat ke lantai nol (${terjualAwal} → ${tiketSetelah.terjual}, harap ${terjualHarap})`);

  // 3) sapu ulang → tidak boleh menambah stok lagi
  const hasil2 = await panggilSweep();
  const tiketLagi = (await tiketRef.get()).data();
  console.log('sweep#2:', JSON.stringify(hasil2));
  lapor(tiketLagi.stok === tiketSetelah.stok,
    `sapu ulang tidak dobel (stok tetap ${tiketLagi.stok})`);

  // 4) bersihkan
  await orderRef.delete();
  await orderPendingRef.delete();
  await tiketRef.update({
    stok: stokAwal,
    terjual: terjualAwal,
    revisionCounter: sebelum.revisionCounter || 0,
  });
  const bersih = (await tiketRef.get()).data();
  lapor(bersih.stok === stokAwal && bersih.terjual === terjualAwal,
    `bersih: stok/terjual kembali ke ${stokAwal}/${terjualAwal}`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
