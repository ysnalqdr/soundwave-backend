/**
 * ═══════════════════════════════════════════════════════════════
 * Uji E2E NOTIFIKASI OTOMATIS — NON-DESTRUKTIF
 * ═══════════════════════════════════════════════════════════════
 * Membuktikan backend mengirim notifikasi SENDIRI (tanpa admin mengetik):
 *   1. Pembayaran sukses  → /midtrans-webhook (settlement)
 *   2. Refund diajukan    → /request-refund
 *   3. Refund disetujui   → /admin/refund/approve
 *   4. Refund ditolak     → /admin/refund/reject
 *
 * Semua memakai ORDER UJI yang dibuat skrip ini dan DIHAPUS di akhir.
 * Order/data asli TIDAK disentuh.
 *
 * Jalankan: node test_notifikasi.js
 */
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const saPath = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json';
const sa = require(path.isAbsolute(saPath) ? saPath : path.resolve(__dirname, saPath));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const TAG = 'UJI-NOTIF-' + Date.now();
const { ambilToken, pesanLewati } = require('./token_uji');

let TOKEN = null;

let lulus = 0, gagal = 0;
const hasil = [];
function cek(nama, kondisi, info = '') {
  if (kondisi) { lulus++; hasil.push('  [LULUS] ' + nama + (info ? '  · ' + info : '')); }
  else { gagal++; hasil.push('  [GAGAL] ' + nama + (info ? '  · ' + info : '')); }
}
const jeda = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

/** Cari satu userId nyata supaya data uji realistis. */
async function cariUserId() {
  const snap = await db.collection('orders').limit(30).get();
  for (const d of snap.docs) {
    const u = d.data().userId;
    if (u) return u;
  }
  const us = await db.collection('users').limit(1).get();
  return us.empty ? null : us.docs[0].id;
}

async function buatOrderUji(id, status, userId) {
  await db.collection('orders').doc(id).set({
    kodeBooking: id,
    userId,
    status,
    judulKonser: 'Konser Uji Notifikasi',
    totalHarga: 1000,
    jumlahTiket: 1,
    idTiket: null,
    namaPembeli: 'Uji Otomatis',
    emailPembeli: 'uji@soundwave.test',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** Notifikasi uji milik userId yang menunjuk ke refId tertentu. */
async function cariNotif(userId, refId, type) {
  const snap = await db.collection('notifications')
    .where('userId', '==', userId)
    .where('refId', '==', refId)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((n) => (type ? n.type === type : true));
}

const dibuat = { orders: [], refunds: [], notifs: [] };

async function bersihkan() {
  // 1. Hapus yang terlacak.
  for (const r of dibuat.refunds) { try { await db.collection('refunds').doc(r).delete(); } catch (_) {} }
  for (const n of dibuat.notifs) { try { await db.collection('notifications').doc(n).delete(); } catch (_) {} }
  for (const o of dibuat.orders) { try { await db.collection('orders').doc(o).delete(); } catch (_) {} }
  // 2. SAPU berdasarkan rentang id uji — jaring pengaman supaya tidak ada
  //    dokumen uji yang tertinggal walau tidak sempat terlacak di atas.
  const sapu = async (koleksi, field) => {
    try {
      const snap = await db.collection(koleksi)
        .where(field, '>=', TAG).where(field, '<', TAG + '~').get();
      for (const d of snap.docs) await d.ref.delete();
      return snap.size;
    } catch (_) { return 0; }
  };
  dibuat.order = await sapu('orders', 'kodeBooking');
  dibuat.refund = await sapu('refunds', 'orderId');
  dibuat.notif = await sapu('notifications', 'refId');
}

(async () => {
  console.log('\n═══ UJI E2E NOTIFIKASI OTOMATIS ═══');
  console.log('Backend : ' + BASE);
  console.log('Tag uji : ' + TAG + '\n');

  const userId = await cariUserId();

  // Rute pengguna dijaga token, jadi ambil ID token untuk user uji ini.
  TOKEN = await ambilToken(userId);
  if (!TOKEN) {
    pesanLewati('test_notifikasi.js');
    process.exit(0);
  }
  if (!userId) { console.log('Tidak ada user di Firestore — uji dibatalkan.'); process.exit(1); }
  console.log('userId uji: ' + userId.substring(0, 10) + '…\n');

  try {
    // 1. Pembayaran sukses lewat webhook settlement.
    {
      const id = TAG + '-PAY';
      await buatOrderUji(id, 'RESERVED', userId);
      dibuat.orders.push(id);

      const statusCode = '200';
      const gross = '1000';
      const signature = crypto.createHash('sha512')
        .update(`${id}${statusCode}${gross}${SERVER_KEY}`).digest('hex');

      const r = await post('/midtrans-webhook', {
        order_id: id, status_code: statusCode, gross_amount: gross,
        signature_key: signature, transaction_status: 'settlement',
        fraud_status: 'accept', payment_type: 'qris',
      });
      await jeda(900);

      const order = await db.collection('orders').doc(id).get();
      const notifs = await cariNotif(userId, id, 'payment_success');
      notifs.forEach((n) => dibuat.notifs.push(n.id));

      cek('webhook settlement → order AKTIF', order.data()?.status === 'AKTIF',
        'status=' + order.data()?.status + ' http=' + r.status);
      cek('webhook settlement → notifikasi otomatis', notifs.length === 1,
        notifs.length ? '"' + notifs[0].title + '"' : 'tidak ada notifikasi');
      cek('notifikasi berstatus belum dibaca', notifs[0]?.read === false);
      cek('notifikasi punya createdAt (server time)', !!notifs[0]?.createdAt);
    }

    // 2. Refund diajukan.
    let refundId = null;
    {
      const id = TAG + '-REQ';
      await buatOrderUji(id, 'AKTIF', userId);
      dibuat.orders.push(id);

      const r = await post('/request-refund', { orderId: id, userId, alasan: 'Uji otomatis' });
      refundId = r.json?.refundId || null;
      if (refundId) dibuat.refunds.push(refundId);
      await jeda(900);

      const notifs = await cariNotif(userId, id, 'refund_requested');
      notifs.forEach((n) => dibuat.notifs.push(n.id));

      cek('request-refund → berhasil', r.json?.success === true, 'http=' + r.status);
      cek('refund diajukan → notifikasi otomatis', notifs.length === 1,
        notifs.length ? '"' + notifs[0].title + '"' : 'tidak ada notifikasi');
    }

    // 3. Refund disetujui.
    {
      const id = TAG + '-REQ';
      const r = await post('/admin/refund/approve', { refundId, orderId: id });
      await jeda(900);

      const notifs = await cariNotif(userId, id, 'refund_approved');
      notifs.forEach((n) => dibuat.notifs.push(n.id));

      cek('refund disetujui → berhasil', r.json?.success === true, 'http=' + r.status);
      cek('refund disetujui → notifikasi otomatis', notifs.length === 1,
        notifs.length ? '"' + notifs[0].message + '"' : 'tidak ada notifikasi');
    }

    // 4. Refund ditolak.
    {
      const id = TAG + '-REJ';
      await buatOrderUji(id, 'AKTIF', userId);
      dibuat.orders.push(id);

      const r1 = await post('/request-refund', { orderId: id, userId, alasan: 'Uji tolak' });
      if (r1.json?.refundId) dibuat.refunds.push(r1.json.refundId);
      await jeda(600);
      (await cariNotif(userId, id, 'refund_requested'))
        .forEach((n) => dibuat.notifs.push(n.id));

      const r2 = await post('/admin/refund/reject', { refundId: r1.json?.refundId, alasanReject: 'Uji otomatis: alasan ditolak' });
      await jeda(900);

      const notifs = await cariNotif(userId, id, 'refund_rejected');
      notifs.forEach((n) => dibuat.notifs.push(n.id));

      cek('refund ditolak → berhasil', r2.json?.success === true, 'http=' + r2.status);
      cek('refund ditolak → notifikasi otomatis', notifs.length === 1,
        notifs.length ? '"' + notifs[0].message + '"' : 'tidak ada notifikasi');
    }

    // 5. Webhook berulang tidak boleh menghasilkan notifikasi dobel.
    {
      const id = TAG + '-PAY';
      const statusCode = '200', gross = '1000';
      const signature = crypto.createHash('sha512')
        .update(`${id}${statusCode}${gross}${SERVER_KEY}`).digest('hex');
      await post('/midtrans-webhook', {
        order_id: id, status_code: statusCode, gross_amount: gross,
        signature_key: signature, transaction_status: 'settlement',
        fraud_status: 'accept', payment_type: 'qris',
      });
      await jeda(900);
      const notifs = await cariNotif(userId, id, 'payment_success');
      notifs.forEach((n) => dibuat.notifs.push(n.id));
      cek('webhook berulang TIDAK menduplikasi notifikasi', notifs.length === 1,
        'jumlah=' + notifs.length);
    }
  } catch (e) {
    gagal++;
    hasil.push('  [GAGAL] exception: ' + (e.message || e));
  } finally {
    await bersihkan();
  }

  // Verifikasi akhir: tidak ada sisa data uji.
  try {
    const sisaO = await db.collection('orders')
      .where('kodeBooking', '>=', TAG).where('kodeBooking', '<', TAG + '~').get();
    const sisaN = await db.collection('notifications')
      .where('refId', '>=', TAG).where('refId', '<', TAG + '~').get();
    const sisaR = await db.collection('refunds')
      .where('orderId', '>=', TAG).where('orderId', '<', TAG + '~').get();
    cek('tidak ada sisa data uji di Firestore',
      sisaO.size === 0 && sisaN.size === 0 && sisaR.size === 0,
      `order=${sisaO.size} notif=${sisaN.size} refund=${sisaR.size}`);
  } catch (e) {
    hasil.push('  [INFO] cek sisa data dilewati: ' + (e.message || e));
  }

  console.log(hasil.join('\n'));
  console.log('\n───────────────');
  console.log(`  LULUS ${lulus}  ·  GAGAL ${gagal}`);
  console.log('  data uji dibersihkan: ' + dibuat.order + ' order · '
    + dibuat.refund + ' refund · ' + dibuat.notif + ' notifikasi');
  console.log('───────────────\n');
  process.exit(gagal === 0 ? 0 : 1);
})();
