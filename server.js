/**
 * ═══════════════════════════════════════════════════════════════
 * SoundWave Backend Lokal — Midtrans + Firebase Admin
 * ═══════════════════════════════════════════════════════════════
 * Backend Node.js lokal untuk demo kampus. 100% gratis.
 * Menggantikan Firebase Cloud Functions (butuh Blaze plan).
 *
 * Jalankan: node server.js
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const midtransClient = require('midtrans-client');
const admin = require('firebase-admin');

// ─── Load .env ───
require('dotenv').config ? require('dotenv').config() : (() => {
  // dotenv belum install? fallback: baca .env manual
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !line.startsWith('#')) {
        process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '');
      }
    });
  }
})();

// ─── Firebase Admin Init ───
try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = admin.credential.cert(serviceAccount);
  } else {
    const path = require('path');
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json';
    const resolvedPath = path.isAbsolute(serviceAccountPath)
      ? serviceAccountPath
      : path.resolve(__dirname, serviceAccountPath);
    const serviceAccount = require(resolvedPath);
    credential = admin.credential.cert(serviceAccount);
  }
  admin.initializeApp({ credential });
  console.log('✅ Firebase Admin SDK initialized');
} catch (e) {
  console.error('❌ Firebase Admin SDK gagal init:', e.message);
  console.error('   Download serviceAccountKey.json dari Firebase Console → Project Settings → Service Accounts');
  process.exit(1);
}

const db = admin.firestore();

// ─── Midtrans Snap Client ───
const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const serverKey = process.env.MIDTRANS_SERVER_KEY || '';
const clientKey = process.env.MIDTRANS_CLIENT_KEY || '';

if (!serverKey || serverKey.includes('XXXXXX')) {
  console.error('❌ MIDTRANS_SERVER_KEY belum diisi di .env');
  process.exit(1);
}

const snap = new midtransClient.Snap({
  isProduction,
  serverKey,
  clientKey,
});

console.log(`✅ Midtrans ${isProduction ? 'PRODUCTION' : 'SANDBOX'} mode`);

// ─── Ed25519 Key untuk QR Signature ───
const activeKeyId = process.env.ED25519_KEY_ID || 'v1';

function getSigningKey() {
  const hex = process.env.ED25519_PRIVATE_KEY_HEX;
  if (!hex) {
    // Development sandbox key (safe for demo, jangan pakai di production)
    return Buffer.from(
      '302e020100300506032b657004220420c699893e2338a0bd8c4aef14d17c700209775bd14198d80dad1ce1c896f9eb31',
      'hex'
    );
  }
  return Buffer.from(hex, 'hex');
}

// ─── Express App ───
const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SoundWave Backend',
    midtrans: isProduction ? 'production' : 'sandbox',
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════
// 1. POST /create-transaction
// Flutter panggil ini untuk buat Snap Token
// ═══════════════════════════════════════════
app.post('/create-transaction', async (req, res) => {
  try {
    const { orderId, userId } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId wajib disertakan' });
    }

    // Ambil data order dari Firestore
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }

    const orderData = orderDoc.data();

    // Validasi: hanya pemilik order
    if (userId && orderData.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke pesanan ini' });
    }

    // Hanya PENDING order bisa diproses
    if (orderData.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `Pesanan sudah berstatus ${orderData.status}, tidak dapat diproses ulang`,
      });
    }

    // ── Re-verifikasi harga dari database (anti price tampering) ──
    let authoritativePrice = 0;
    if (orderData.idTiket) {
      const ticketDoc = await db.collection('tickets').doc(orderData.idTiket).get();
      if (!ticketDoc.exists) {
        return res.status(404).json({ success: false, message: 'Data tiket konser tidak ditemukan' });
      }
      const ticketData = ticketDoc.data();
      if (ticketData.stok < orderData.jumlahTiket) {
        return res.status(409).json({
          success: false,
          message: `Stok tiket tidak mencukupi. Sisa stok: ${ticketData.stok}`,
        });
      }
      authoritativePrice = Number(ticketData.harga) || 0;
    }

    const serviceFee = 5000;
    const authoritativeTotal = authoritativePrice > 0
      ? (authoritativePrice * orderData.jumlahTiket) + serviceFee
      : Math.round(orderData.totalHarga);

    // Security: overwrite jika harga client tidak cocok
    if (Math.round(orderData.totalHarga) !== authoritativeTotal) {
      console.warn(`[SECURITY] Price mismatch order ${orderId}. Expected ${authoritativeTotal}, got ${orderData.totalHarga}`);
      await orderRef.update({
        totalHarga: authoritativeTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Kalau sudah punya snapToken, reuse
    if (orderData.snapToken && orderData.snapRedirectUrl) {
      return res.json({
        success: true,
        token: orderData.snapToken,
        redirect_url: orderData.snapRedirectUrl,
        order_id: orderId,
      });
    }

    // ── Buat transaksi Midtrans ──
    const parameter = {
      transaction_details: {
        order_id: orderData.kodeBooking || orderId,
        gross_amount: authoritativeTotal,
      },
      item_details: [
        {
          id: orderData.idTiket || orderData.idKonser,
          price: authoritativePrice > 0
            ? authoritativePrice
            : Math.round((authoritativeTotal - serviceFee) / orderData.jumlahTiket),
          quantity: orderData.jumlahTiket,
          name: `${orderData.judulKonser} (${orderData.kategoriTiket})`.substring(0, 50),
        },
        {
          id: 'BIAYA-ADMIN',
          price: serviceFee,
          quantity: 1,
          name: 'Biaya Layanan & Pemeliharaan',
        },
      ],
      customer_details: {
        first_name: orderData.namaPembeli,
        email: orderData.emailPembeli,
        phone: orderData.teleponPembeli || '08123456789',
      },
    };

    const transaction = await snap.createTransaction(parameter);

    // Simpan snapToken ke Firestore
    await orderRef.update({
      snapToken: transaction.token,
      snapRedirectUrl: transaction.redirect_url,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Snap token created for order ${orderId}`);

    res.json({
      success: true,
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      order_id: orderId,
    });
  } catch (err) {
    console.error('❌ create-transaction error:', err);
    res.status(500).json({ success: false, message: 'Gagal menghubungi payment gateway Midtrans' });
  }
});

// ═══════════════════════════════════════════
// 2. POST /midtrans-webhook
// Midtrans kirim notifikasi pembayaran ke sini
// ═══════════════════════════════════════════
app.post('/midtrans-webhook', async (req, res) => {
  try {
    const notification = req.body;
    const {
      order_id: orderIdOrBookingCode,
      status_code: statusCode,
      gross_amount: grossAmount,
      signature_key: signatureKey,
      transaction_status: transactionStatus,
      fraud_status: fraudStatus,
      payment_type: paymentType,
    } = notification;

    // 1. Verifikasi signature SHA512
    const rawSignature = `${orderIdOrBookingCode}${statusCode}${grossAmount}${serverKey}`;
    const calculatedSignature = crypto.createHash('sha512').update(rawSignature).digest('hex');

    if (signatureKey !== calculatedSignature) {
      console.warn(`[SECURITY] Invalid webhook signature for ${orderIdOrBookingCode}`);
      return res.status(403).json({ error: 'Invalid signature key' });
    }

    // 2. Cari order di Firestore (by ID atau kodeBooking)
    let orderRef = db.collection('orders').doc(orderIdOrBookingCode);
    let orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      const query = await db.collection('orders')
        .where('kodeBooking', '==', orderIdOrBookingCode)
        .limit(1).get();
      if (query.empty) {
        return res.status(404).json({ error: 'Order not found' });
      }
      orderDoc = query.docs[0];
      orderRef = orderDoc.ref;
    }

    const currentOrder = orderDoc.data();

    // 3. Map status Midtrans → SoundWave
    let targetStatus = 'PENDING';
    let isPaidSuccess = false;

    if (transactionStatus === 'capture' && fraudStatus === 'accept') {
      targetStatus = 'AKTIF'; isPaidSuccess = true;
    } else if (transactionStatus === 'settlement') {
      targetStatus = 'AKTIF'; isPaidSuccess = true;
    } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
      targetStatus = 'CANCELLED';
    }

    // 4. Idempotency check
    if (currentOrder.status === targetStatus || currentOrder.status === 'TERPAKAI') {
      return res.json({ status: 'already_processed' });
    }

    // 5. Atomic transaction: update status + inventory
    let finalStatus = targetStatus;

    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(orderRef);
      const freshData = freshDoc.data();

      if (freshData.status === 'AKTIF' || freshData.status === 'TERPAKAI') {
        finalStatus = freshData.status;
        return;
      }

      const nowMs = Date.now();
      const resUntilMs = freshData.reservedUntil ? freshData.reservedUntil.toMillis() : null;
      const isExpiredHold = resUntilMs && resUntilMs < nowMs;
      let isOverbooked = false;

      // Inventory management saat pembayaran berhasil
      if (isPaidSuccess && freshData.idTiket) {
        const ticketRef = db.collection('tickets').doc(freshData.idTiket);
        const ticketDoc = await transaction.get(ticketRef);

        if (ticketDoc.exists) {
          const ticketData = ticketDoc.data();
          const currentStock = ticketData.stok || 0;
          const currentTerjual = ticketData.terjual || 0;
          const qty = freshData.jumlahTiket || 1;

          if (isExpiredHold && currentStock < qty) {
            isOverbooked = true;
            finalStatus = 'REFUND_REQUIRED';
          } else if (isExpiredHold) {
            transaction.update(ticketRef, { stok: currentStock - qty, terjual: currentTerjual + qty });
          } else {
            transaction.update(ticketRef, { terjual: currentTerjual + qty });
          }
        }
      }

      // Generate Ed25519 signed QR payload
      const privKey = crypto.createPrivateKey({ key: getSigningKey(), format: 'der', type: 'pkcs8' });
      const canonicalPayload = `SW2|${activeKeyId}|${orderRef.id}|${freshData.kodeBooking}|${freshData.idKonser}|${freshData.kategoriTiket}|${freshData.jumlahTiket}`;
      const edSignatureHex = crypto.sign(null, Buffer.from(canonicalPayload), privKey).toString('hex');
      const signedQrPayload = `${canonicalPayload}|${edSignatureHex}`;

      transaction.update(orderRef, {
        status: finalStatus,
        metodePembayaran: paymentType || freshData.metodePembayaran,
        qrPayloadSignature: signedQrPayload,
        paymentDetails: {
          transactionStatus, fraudStatus: fraudStatus || null,
          paymentType: paymentType || null,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          isOverbooked,
        },
        auditTrail: admin.firestore.FieldValue.arrayUnion({
          event: finalStatus === 'AKTIF' ? 'PAYMENT_SETTLED_TICKET_ACTIVE' : 'WEBHOOK_STATUS_UPDATE',
          status: finalStatus, timestamp: new Date().toISOString(), transactionStatus,
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(`✅ Webhook processed: ${orderIdOrBookingCode} → ${finalStatus}`);
    res.json({ status: 'ok', updated_status: finalStatus });
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(500).json({ error: 'Internal transaction error' });
  }
});

// ═══════════════════════════════════════════
// 3. GET /check-status/:orderId
// Flutter cek status order setelah bayar
// ═══════════════════════════════════════════
app.get('/check-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderDoc = await db.collection('orders').doc(orderId).get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }

    const data = orderDoc.data();
    res.json({
      success: true,
      order_id: orderId,
      status: data.status,
      kodeBooking: data.kodeBooking,
      snapRedirectUrl: data.snapRedirectUrl || null,
    });
  } catch (err) {
    console.error('❌ check-status error:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil status pesanan' });
  }
});

// ═══════════════════════════════════════════
// 4. POST /settle-dev
// Simulasi pembayaran untuk demo (sandbox only)
// ═══════════════════════════════════════════
app.post('/settle-dev', async (req, res) => {
  if (isProduction) {
    return res.status(403).json({ success: false, message: 'Dinonaktifkan di production' });
  }

  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId wajib disertakan' });
    }

    const orderRef = db.collection('orders').doc(orderId);

    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) throw new Error('Pesanan tidak ditemukan');

      const orderData = orderDoc.data();
      if (orderData.status === 'AKTIF' || orderData.status === 'TERPAKAI') return;

      // Kurangi stok
      if (orderData.idTiket) {
        const ticketRef = db.collection('tickets').doc(orderData.idTiket);
        const ticketDoc = await transaction.get(ticketRef);
        if (ticketDoc.exists) {
          const td = ticketDoc.data();
          transaction.update(ticketRef, {
            stok: Math.max(0, (td.stok || 0) - (orderData.jumlahTiket || 1)),
            terjual: (td.terjual || 0) + (orderData.jumlahTiket || 1),
          });
        }
      }

      // Generate QR signature
      const privKey = crypto.createPrivateKey({ key: getSigningKey(), format: 'der', type: 'pkcs8' });
      const canonicalPayload = `SW2|${activeKeyId}|${orderRef.id}|${orderData.kodeBooking}|${orderData.idKonser}|${orderData.kategoriTiket}|${orderData.jumlahTiket}`;
      const edSignatureHex = crypto.sign(null, Buffer.from(canonicalPayload), privKey).toString('hex');

      transaction.update(orderRef, {
        status: 'AKTIF',
        qrPayloadSignature: `${canonicalPayload}|${edSignatureHex}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        auditTrail: admin.firestore.FieldValue.arrayUnion({
          event: 'DEV_SETTLEMENT_SIMULATED',
          timestamp: new Date().toISOString(),
        }),
      });
    });

    console.log(`✅ Dev settlement: ${orderId} → AKTIF`);
    res.json({ success: true, message: 'Pesanan berhasil diselesaikan (DEV)' });
  } catch (err) {
    console.error('❌ settle-dev error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════
// 5. POST /sync-offline-scans
// Gate scanner sinkronisasi tiket offline
// ═══════════════════════════════════════════
app.post('/sync-offline-scans', async (req, res) => {
  try {
    const { scans } = req.body;
    if (!Array.isArray(scans) || scans.length === 0) {
      return res.json({ syncedCount: 0, duplicateCount: 0 });
    }

    let syncedCount = 0;
    let duplicateCount = 0;

    for (const scan of scans) {
      const { scanId, orderId } = scan;
      if (!orderId) continue;

      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await orderRef.get();

      if (orderDoc.exists && orderDoc.data().status === 'AKTIF') {
        await orderRef.update({
          status: 'TERPAKAI',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          auditTrail: admin.firestore.FieldValue.arrayUnion({
            event: 'OFFLINE_GATE_SCAN_SYNCED',
            scanId,
            timestamp: new Date().toISOString(),
          }),
        });
        syncedCount++;
      } else {
        duplicateCount++;
      }
    }

    res.json({ syncedCount, duplicateCount });
  } catch (err) {
    console.error('❌ sync-offline-scans error:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(`🎵 SoundWave Backend running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Midtrans: ${isProduction ? 'PRODUCTION ⚠️' : 'SANDBOX ✅'}`);
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('Endpoints:');
  console.log(`  POST http://localhost:${PORT}/create-transaction`);
  console.log(`  POST http://localhost:${PORT}/midtrans-webhook`);
  console.log(`  GET  http://localhost:${PORT}/check-status/:orderId`);
  console.log(`  POST http://localhost:${PORT}/settle-dev`);
  console.log('');
});
