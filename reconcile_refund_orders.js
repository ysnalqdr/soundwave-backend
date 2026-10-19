// Perbaikan data lama: order yang "nyangkut" di REFUND_REQUESTED padahal
// dokumen refund-nya sudah APPROVED / REJECTED.
//
// Penyebab: versi lama app admin hanya mengubah dokumen `refunds` dan
// memanggil endpoint yang tidak ada -> `orders.status` tidak pernah berubah,
// sehingga tiket user selamanya tampil "REFUND DIPROSES".
//
// Skrip ini meniru PERSIS logika handleRefundApprove / handleRefundReject di
// server.js (status, stok, audit trail) supaya data jadi konsisten.
//
// Pemakaian:
//   node reconcile_refund_orders.js           -> DRY RUN (tidak mengubah apa pun)
//   node reconcile_refund_orders.js --apply   -> benar-benar memperbaiki
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccountKey.json')),
});
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const APPLY = process.argv.includes('--apply');
const FINAL = ['APPROVED', 'REJECTED'];

async function main() {
  console.log(APPLY ? 'MODE APPLY - data akan diubah.' : 'DRY RUN - tidak ada data yang diubah.');
  console.log('');

  const snap = await db.collection('refunds').get();
  let ketemu = 0, diperbaiki = 0, dilewati = 0;

  for (const doc of snap.docs) {
    const r = doc.data();
    const status = String(r.status || '').toUpperCase();
    if (!FINAL.includes(status)) continue;
    if (!r.orderId) continue;

    const orderRef = db.collection('orders').doc(r.orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      console.log(`- refund ${doc.id}: order ${r.orderId} TIDAK ADA -> dilewati`);
      dilewati++; continue;
    }
    const o = orderDoc.data();

    // hanya sentuh order yang memang masih nyangkut
    if (!['REFUND_REQUESTED', 'REFUND_REQUIRED'].includes(o.status)) {
      dilewati++; continue;
    }

    ketemu++;
    const sudahDiscan = !!o.tanggalDigunakan;
    const statusBaru = status === 'APPROVED' ? 'REFUNDED' : (sudahDiscan ? 'TERPAKAI' : 'AKTIF');
    const refundAmount = Math.round(Number(r.amount || r.refundAmount || o.totalHarga)) || 0;
    const now = new Date().toISOString();

    console.log(`* refund ${doc.id}  [${status}]  order ${r.orderId}`);
    console.log(`    kodeBooking  : ${o.kodeBooking || '-'}  (Rp ${o.totalHarga})`);
    console.log(`    status order : ${o.status}  ->  ${statusBaru}`);
    if (status === 'APPROVED') {
      console.log(`    stok tiket   : ${sudahDiscan ? 'TIDAK dipulihkan (tiket sudah discan)' : 'dipulihkan (+' + (o.jumlahTiket || 1) + ') pada tickets/' + (o.idTiket || '-')}`);
      console.log(`    refundAmount : Rp ${refundAmount}`);
    } else {
      console.log(`    alasan tolak : ${r.alasanReject || '(kosong)'}`);
    }

    if (!APPLY) { console.log(''); continue; }

    // samakan dengan handleRefundApprove
    let stokDipulihkan = false;
    if (status === 'APPROVED' && !sudahDiscan && o.idTiket) {
      const ticketRef = db.collection('tickets').doc(o.idTiket);
      const tDoc = await ticketRef.get();
      if (tDoc.exists) {
        const td = tDoc.data();
        const qty = o.jumlahTiket || 1;
        await ticketRef.update({
          stok: (td.stok || 0) + qty,
          terjual: Math.max(0, (td.terjual || 0) - qty),
          revisionCounter: (td.revisionCounter || 0) + 1,
          updatedAt: FV.serverTimestamp(),
        });
        stokDipulihkan = true;
      }
    }

    if (status === 'APPROVED') {
      await orderRef.update({
        status: 'REFUNDED',
        refundStatus: 'APPROVED',
        refundAmount,
        refundProcessedAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp(),
        auditTrail: FV.arrayUnion({
          event: 'REFUND_APPROVED', refundId: doc.id, refundAmount,
          stokDipulihkan, metodePengembalian: 'MANUAL', sumber: 'RECONCILE', timestamp: now,
        }),
      });
      if (!r.processedAt) {
        await doc.ref.update({
          status: 'APPROVED', refundAmount,
          processedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
        });
      }
    } else {
      await orderRef.update({
        status: statusBaru,
        refundStatus: 'REJECTED',
        refundRejectReason: r.alasanReject || 'Ditolak admin',
        refundProcessedAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp(),
        auditTrail: FV.arrayUnion({
          event: 'REFUND_REJECTED', refundId: doc.id,
          alasanReject: r.alasanReject || 'Ditolak admin',
          statusOrderBaru: statusBaru, sumber: 'RECONCILE', timestamp: now,
        }),
      });
      if (!r.processedAt) {
        await doc.ref.update({
          status: 'REJECTED',
          alasanReject: r.alasanReject || 'Ditolak admin',
          processedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
        });
      }
    }

    diperbaiki++;
    console.log('    DIPERBAIKI');
    console.log('');
  }

  console.log(`REKAP: ${ketemu} order nyangkut, ${diperbaiki} diperbaiki, ${dilewati} dilewati (sudah konsisten).`);
  if (!APPLY && ketemu > 0) console.log('Jalankan ulang dengan --apply untuk memperbaiki.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
