// Uji: /settle-dev tidak lagi memotong stok dua kali.
require('dotenv').config();
const admin = require('firebase-admin');
const sa = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const URL = 'http://localhost:3000/settle-dev';
const lapor = (ok, p) => console.log(`${ok ? '[PASS]' : '[GAGAL]'} ${p}`);

(async () => {
  const tiketDoc = (await db.collection('tickets').limit(1).get()).docs[0];
  const tiketRef = tiketDoc.ref;
  const awal = tiketDoc.data();
  const stok0 = awal.stok || 0;
  const terjual0 = awal.terjual || 0;

  const settle = async (orderId) => {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    return { http: r.status, body: await r.json() };
  };

  // ── Kasus 1: RESERVED (stok sudah dipotong saat reservasi) ──
  const o1 = db.collection('orders').doc('ZZSETTLE_RESERVED');
  await o1.set({
    kodeBooking: 'ZZ-SET-1', idKonser: awal.idKonser || 'zz', idTiket: tiketRef.id,
    kategoriTiket: 'Festival', jumlahTiket: 2, totalHarga: 200000, userId: 'zztest',
    status: 'RESERVED', stokDipotong: true,
    reservedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + 120000),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const r1 = await settle('ZZSETTLE_RESERVED');
  const d1 = (await o1.get()).data();
  const s1 = (await tiketRef.get()).data();
  lapor(r1.http === 200 && r1.body.success === true, `settle RESERVED HTTP 200 (${JSON.stringify(r1.body)})`);
  lapor(d1.status === 'AKTIF', `RESERVED → AKTIF (status=${d1.status})`);
  lapor(s1.stok === stok0, `stok TIDAK terpotong lagi (${stok0} → ${s1.stok}) ← bug lama: jadi ${stok0 - 2}`);
  lapor(s1.terjual === terjual0, `terjual tidak dobel (${terjual0} → ${s1.terjual})`);

  // ── Kasus 2: PENDING lama (stok belum pernah dipotong) → potong sekali ──
  const o2 = db.collection('orders').doc('ZZSETTLE_LEGACY');
  await o2.set({
    kodeBooking: 'ZZ-SET-2', idKonser: awal.idKonser || 'zz', idTiket: tiketRef.id,
    kategoriTiket: 'Festival', jumlahTiket: 1, totalHarga: 100000, userId: 'zztest',
    status: 'PENDING', createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const r2 = await settle('ZZSETTLE_LEGACY');
  const s2 = (await tiketRef.get()).data();
  lapor(r2.http === 200, `settle PENDING lama HTTP 200`);
  lapor(s2.stok === stok0 - 1, `data lama dipotong SEKALI (${stok0} → ${s2.stok})`);
  lapor(s2.terjual === terjual0 + 1, `terjual +1 sekali (${terjual0} → ${s2.terjual})`);

  // ── Kasus 3: EXPIRED → ditolak, stok tidak berubah ──
  const o3 = db.collection('orders').doc('ZZSETTLE_EXPIRED');
  await o3.set({
    kodeBooking: 'ZZ-SET-3', idKonser: awal.idKonser || 'zz', idTiket: tiketRef.id,
    kategoriTiket: 'Festival', jumlahTiket: 1, totalHarga: 100000, userId: 'zztest',
    status: 'EXPIRED', stokDipotong: true, stokDilepas: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const r3 = await settle('ZZSETTLE_EXPIRED');
  const s3 = (await tiketRef.get()).data();
  lapor(r3.http >= 400, `EXPIRED ditolak (HTTP ${r3.http})`);
  lapor(String(r3.body.message || '').includes('5 menit'),
    `pesan penolakan menyebut 5 menit → "${r3.body.message}"`);
  lapor(s3.stok === s2.stok, `stok tidak berubah oleh penolakan (${s3.stok})`);

  // ── bersihkan ──
  await o1.delete(); await o2.delete(); await o3.delete();
  await tiketRef.update({ stok: stok0, terjual: terjual0, revisionCounter: awal.revisionCounter || 0 });
  const bersih = (await tiketRef.get()).data();
  lapor(bersih.stok === stok0 && bersih.terjual === terjual0,
    `bersih: stok/terjual kembali ${stok0}/${terjual0}`);
  process.exit(0);
})().catch((e) => { console.error('GAGAL:', e.message); process.exit(1); });
