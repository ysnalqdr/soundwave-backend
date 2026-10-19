// Uji end-to-end alur refund: reject → approve → guard.
// Membuat dokumen dummy di Firestore, memanggil endpoint backend lokal,
// memverifikasi orders/refunds/tickets, lalu membersihkan semuanya.
//
// Jalankan: node test_refund_flow.js   (server.js harus hidup di :3000)
const admin = require('firebase-admin');
try { require('dotenv').config({ quiet: true }); } catch {}

admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccountKey.json')),
});
const db = admin.firestore();

const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';

// Rute /admin/* dijaga auth_admin.js, jadi wajib Bearer ID token milik admin.
// Skrip ini membuat custom token lewat Admin SDK, menukarnya jadi ID token
// lewat REST, lalu memakai token itu untuk semua permintaan di bawah.
let TOKEN_ADMIN = null;

async function siapkanToken() {
  if (!WEB_API_KEY) return null;
  const snap = await db.collection('users').where('role', '==', 'admin').limit(1).get();
  const uid = !snap.empty ? snap.docs[0].id : null;
  if (!uid) return null;
  const custom = await admin.auth().createCustomToken(uid);
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + WEB_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  const json = await res.json();
  return json.idToken || null;
}

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TAG = 'ZZTEST_' + Date.now();
const ticketId = TAG + '_ticket';
const orderId = TAG + '_order';
const refundId = TAG + '_refund';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' -> ' + extra : ''}`);
}

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN_ADMIN ? { Authorization: 'Bearer ' + TOKEN_ADMIN } : {}),
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch {}
  return { status: res.status, json, txt };
}

async function seed() {
  await db.collection('tickets').doc(ticketId).set({
    idKonser: 'ZZTEST', kategori: 'VVIP', harga: 100000,
    stok: 10, terjual: 5, revisionCounter: 1,
  });
  await db.collection('orders').doc(orderId).set({
    userId: 'zztest_user', status: 'REFUND_REQUESTED', kodeBooking: 'ZZ-TEST-1',
    idKonser: 'ZZTEST', judulKonser: 'ZZ Test', kategoriTiket: 'VVIP',
    jumlahTiket: 2, totalHarga: 200000, idTiket: ticketId,
    tanggalBeli: new Date().toISOString(),
  });
  await db.collection('refunds').doc(refundId).set({
    refundId, orderId, userId: 'zztest_user', alasan: 'uji otomatis',
    status: 'PENDING', kodeBooking: 'ZZ-TEST-1', jumlahTiket: 2,
    totalHarga: 200000, refundAmount: 200000,
    tanggalRequest: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function getOrder() { return (await db.collection('orders').doc(orderId).get()).data(); }
async function getRefund() { return (await db.collection('refunds').doc(refundId).get()).data(); }
async function getTicket() { return (await db.collection('tickets').doc(ticketId).get()).data(); }

(async () => {
  try {
    TOKEN_ADMIN = await siapkanToken();
    if (!TOKEN_ADMIN) {
      console.log('LEWATI: FIREBASE_WEB_API_KEY kosong atau tidak ada user ber-role admin.');
      console.log('Rute /admin/* wajib Bearer ID token, jadi uji refund butuh keduanya.');
      return;
    }

    await seed();

    // A. Reject
    const r1 = await post('/admin/refund/reject', { refundId, alasanReject: 'uji tolak' });
    check('reject: HTTP 200 + success=true',
      r1.status === 200 && r1.json && r1.json.success === true, JSON.stringify(r1.json));
    const o1 = await getOrder(), rf1 = await getRefund(), tk1 = await getTicket();
    check('reject: orders.status kembali AKTIF (tiket bisa discan)', o1.status === 'AKTIF', 'status=' + o1.status);
    check('reject: refunds.status REJECTED + alasan tersimpan',
      rf1.status === 'REJECTED' && rf1.alasanReject === 'uji tolak', `status=${rf1.status}`);
    check('reject: order menyimpan refundStatus/refundRejectReason',
      o1.refundStatus === 'REJECTED' && o1.refundRejectReason === 'uji tolak');
    check('reject: stok tiket TIDAK berubah',
      tk1.stok === 10 && tk1.terjual === 5, `stok=${tk1.stok} terjual=${tk1.terjual}`);

    // B. Approve
    await db.collection('orders').doc(orderId).update({ status: 'REFUND_REQUESTED' });
    await db.collection('refunds').doc(refundId).update({ status: 'PENDING' });
    const r2 = await post('/admin/refund/approve', { refundId, orderId });
    check('approve: HTTP 200 + success=true',
      r2.status === 200 && r2.json && r2.json.success === true, JSON.stringify(r2.json));
    const o2 = await getOrder(), rf2 = await getRefund(), tk2 = await getTicket();
    check('approve: orders.status REFUNDED', o2.status === 'REFUNDED', 'status=' + o2.status);
    check('approve: refunds.status APPROVED', rf2.status === 'APPROVED', `status=${rf2.status}`);
    check('approve: stok dipulihkan (stok +2, terjual -2, rev +1)',
      tk2.stok === 12 && tk2.terjual === 3 && tk2.revisionCounter === 2,
      `stok=${tk2.stok} terjual=${tk2.terjual} rev=${tk2.revisionCounter}`);
    check('approve: TIDAK memanggil Midtrans (metode MANUAL)',
      r2.json.metodePengembalian === 'MANUAL' && r2.json.stokDipulihkan === true);
    check('approve: audit trail REFUND_APPROVED tercatat',
      Array.isArray(o2.auditTrail) && o2.auditTrail.some(a => a.event === 'REFUND_APPROVED'));

    // C. Approve ganda harus ditolak
    const r3 = await post('/admin/refund/approve', { refundId, orderId });
    check('approve ganda: ditolak HTTP 409', r3.status === 409, 'http=' + r3.status);

    // D. Alias rute
    const r4 = await post('/approve-refund', { refundId, orderId });
    check('alias /approve-refund tidak 404', r4.status !== 404, 'http=' + r4.status);
    const r4b = await post('/reject-refund', { refundId, alasanReject: 'x' });
    check('alias /reject-refund tidak 404', r4b.status !== 404, 'http=' + r4b.status);

    // E. Tiket sudah discan: stok tidak dipulihkan
    await db.collection('orders').doc(orderId).update({
      status: 'REFUND_REQUESTED',
      tanggalDigunakan: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('refunds').doc(refundId).update({ status: 'PENDING' });
    const r5 = await post('/admin/refund/approve', { refundId, orderId });
    const tk3 = await getTicket();
    check('approve tiket sudah discan: stok TIDAK dipulihkan',
      r5.json && r5.json.stokDipulihkan === false && tk3.stok === 12,
      `stok=${tk3.stok} json=${JSON.stringify(r5.json)}`);

    // F. Reject pada tiket yang sudah discan: kembali TERPAKAI
    await db.collection('refunds').doc(refundId).update({ status: 'PENDING' });
    await post('/admin/refund/reject', { refundId, alasanReject: 'uji tolak 2' });
    const o4 = await getOrder();
    check('reject tiket sudah discan: kembali TERPAKAI (bukan AKTIF)',
      o4.status === 'TERPAKAI', 'status=' + o4.status);
  } catch (e) {
    console.error('FATAL:', e);
    results.push({ name: 'FATAL', ok: false });
  } finally {
    for (const [col, id] of [['tickets', ticketId], ['orders', orderId], ['refunds', refundId]]) {
      try { await db.collection(col).doc(id).delete(); } catch {}
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`\nREKAP: ${results.length - failed} lulus, ${failed} gagal`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
