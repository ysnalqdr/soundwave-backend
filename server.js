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
const log = require('./logger');
const { buatPengirim } = require('./notifikasi');
const { wajibAdmin } = require('./auth_admin');

// ─── Load .env ───
require('dotenv').config ? require('dotenv').config({ quiet: true }) : (() => {
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
let firebaseProjectId = process.env.FIREBASE_PROJECT_ID || '';
try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = admin.credential.cert(serviceAccount);
    firebaseProjectId = firebaseProjectId || serviceAccount.project_id || '';
  } else {
    const path = require('path');
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json';
    const resolvedPath = path.isAbsolute(serviceAccountPath)
      ? serviceAccountPath
      : path.resolve(__dirname, serviceAccountPath);
    const serviceAccount = require(resolvedPath);
    credential = admin.credential.cert(serviceAccount);
    firebaseProjectId = firebaseProjectId || serviceAccount.project_id || '';
  }
  admin.initializeApp({ credential });
  log.ok('Firebase Admin SDK siap');
} catch (e) {
  log.err('Firebase Admin SDK gagal init: ' + e.message);
  log.info('  Download serviceAccountKey.json dari Firebase Console → Project Settings → Service Accounts');
  process.exit(1);
}

const db = admin.firestore();

// ─── Pengirim notifikasi: inbox (koleksi `notifications`) + push FCM ───
// Satu jalur untuk notifikasi OTOMATIS (file ini) dan PENGUMUMAN MANUAL
// (pengumuman.js). Isi modulnya di notifikasi.js.
const { kirimNotifikasi, kirimPush } = buatPengirim({
  db,
  messaging: admin.messaging(),
  log,
});

// ─── Midtrans Snap Client ───
const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const serverKey = process.env.MIDTRANS_SERVER_KEY || '';
const clientKey = process.env.MIDTRANS_CLIENT_KEY || '';

// ─── Jendela reservasi (menit) ───
// Satu angka untuk app + backend. Stok dipotong SEKALI saat pembayaran
// dimulai, dan dilepas SEKALI kalau tidak dibayar dalam jendela ini.
const HOLD_MENIT = Number(process.env.RESERVATION_HOLD_MINUTES || 5);
const HOLD_MS = HOLD_MENIT * 60 * 1000;

// Apakah stok pesanan ini SUDAH dipotong? Dipakai semua jalur (checkout,
// webhook, settle-dev, penyapu) supaya potong/lepas tidak pernah dobel.
// Data lama tidak punya penanda: pesanan RESERVED versi lama PASTI sudah
// dipotong (kode lama memotong di /checkout-atomic), pesanan PENDING belum.
function stokSudahDipotong(order) {
  if (!order) return false;
  if (order.stokDilepas === true) return false;
  if (order.stokDipotong === true) return true;
  if (order.stokDipotong === false) return false;
  return order.status === 'RESERVED';
}

if (!serverKey || serverKey.includes('XXXXXX')) {
  log.err('MIDTRANS_SERVER_KEY belum diisi di .env');
  process.exit(1);
}

const snap = new midtransClient.Snap({
  isProduction,
  serverKey,
  clientKey,
});

// ─── Midtrans Core API (direct charge: VA, GoPay, QRIS, status polling) ───
const core = new midtransClient.CoreApi({
  isProduction,
  serverKey,
  clientKey,
});

// ═══════════════════════════════════════════
// Helper: NOTIFIKASI IN-APP (koleksi 'notifications')
// ═══════════════════════════════════════════
// Ditulis OTOMATIS oleh backend saat ada kejadian penting — admin maupun
// user TIDAK perlu mengetik apa pun. Dibaca user di layar Jelajah (ikon
// lonceng). Kegagalan di sini NON-FATAL: tidak boleh menggagalkan
// transaksi utama (pembayaran / refund).

/** Format angka jadi rupiah, mis. 155000 -> "Rp 155.000". */
function rupiah(n) {
  return 'Rp ' + (Math.round(Number(n)) || 0).toLocaleString('id-ID');
}

// CATATAN: fungsi kirimNotifikasi() dulu ada di sini. Sekarang dipindah ke
// notifikasi.js supaya dipakai BERSAMA oleh notifikasi otomatis (file ini)
// dan pengumuman manual (pengumuman.js). Yang di-import di atas sudah
// mencakup: kirimNotifikasi() -> inbox + push, dan kirimPush() -> push saja.

// mode Midtrans ditampilkan di banner startup

// ─── Helper: render a fallback QR image URL via QuickChart ───
function buildQrImageUrl(qrString) {
  if (!qrString) return null;
  return `https://quickchart.io/qr?text=${encodeURIComponent(qrString)}&size=300&dark=000000&light=FFFFFF&margin=2`;
}

// ─── Helper: resolve Firestore order doc + gross amount ───
async function loadOrderForCharge(orderId) {
  const orderRef = db.collection('orders').doc(orderId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) {
    const err = new Error('Pesanan tidak ditemukan');
    err.code = 404;
    throw err;
  }
  const orderData = orderDoc.data();
  const grossAmount = Math.round(Number(orderData.totalHarga));
  if (!grossAmount || grossAmount <= 0) {
    const err = new Error('Total harga tidak valid');
    err.code = 422;
    throw err;
  }
  return { orderRef, orderData, grossAmount };
}

// ─── Helper: order_id unik untuk Midtrans ───
// Midtrans menolak order_id yang sudah pernah di-charge (406 conflict) atau
// duplikat dalam waktu singkat. Pakai basis kodeBooking + suffix unik, lalu
// simpan pemetaannya di dokumen order agar webhook & poll bisa menemukannya.
function uniqueMidtransOrderId(base) {
  const clean = (base || 'SW').toString().replace(/[^A-Za-z0-9\-_.]/g, '').slice(0, 30);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${clean}-${suffix}`.slice(0, 50);
}

// Cek apakah timestamp Firestore/Date masih di masa depan (instrumen berlaku).
function isFutureTimestamp(value) {
  try {
    if (!value) return false;
    const ms = typeof value.toMillis === 'function'
      ? value.toMillis()
      : (value instanceof Date ? value.getTime() : new Date(value).getTime());
    return Number.isFinite(ms) && ms > Date.now();
  } catch (_) {
    return false;
  }
}

// ─── Helper: GET a Midtrans action URL (e.g. GoPay generate-qr-code) ───
async function fetchActionUrl(url) {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(serverKey + ':').toString('base64'),
        'Accept': 'application/json',
      },
    });
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await resp.json();
    }
    return { _text: await resp.text(), _contentType: contentType };
  } catch (e) {
    return { _error: e.message };
  }
}

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
app.use(log.requestLogger());

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
      log.warn(`[SECURITY] Price mismatch order ${orderId}. Expected ${authoritativeTotal}, got ${orderData.totalHarga}`);
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

    log.note(res, `token Snap dibuat`);

    res.json({
      success: true,
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      order_id: orderId,
    });
  } catch (err) {
    log.fail(res, 'create-transaction', err);
    res.status(500).json({ success: false, message: 'Gagal menghubungi payment gateway Midtrans' });
  }
});

// ═══════════════════════════════════════════
// 1b. POST /checkout-atomic
// Atomic: reserve tiket + create Snap token dalam 1 transaction
// Cegah race condition pada tiket viral
// ═══════════════════════════════════════════
app.post('/checkout-atomic', async (req, res) => {
  try {
    const { orderId, ticketId, jumlahTiket, revisionCounter } = req.body;

    if (!orderId || !ticketId || !jumlahTiket) {
      return res.status(400).json({ success: false, message: 'orderId, ticketId, jumlahTiket wajib' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const ticketRef = db.collection('tickets').doc(ticketId);

    let snapToken = null;
    let redirectUrl = null;
    let finalRevision = null;
    let conflictDetected = false;

    // Atomic transaction: reserve + token
    await db.runTransaction(async (transaction) => {
      const orderDoc = await transaction.get(orderRef);
      const ticketDoc = await transaction.get(ticketRef);

      if (!orderDoc.exists) {
        throw new Error('Order tidak ditemukan');
      }
      if (!ticketDoc.exists) {
        throw new Error('Tiket konser tidak ditemukan');
      }

      const orderData = orderDoc.data();
      const ticketData = ticketDoc.data();

      // ── Status order menentukan apakah stok perlu dipotong ──
      //   PENDING            → stok BELUM dipotong → potong sekarang (sekali).
      //   RESERVED + potong  → stok SUDAH dipotong → JANGAN potong lagi,
      //                        cukup segarkan jendela waktu pembayaran.
      const statusAwal = orderData.status;
      const sudahPotong = stokSudahDipotong(orderData);

      if (statusAwal === 'EXPIRED') {
        throw new Error(
          `Waktu pembayaran ${HOLD_MENIT} menit sudah habis. Pesanan kedaluwarsa — silakan pesan ulang.`
        );
      }
      if (!(statusAwal === 'PENDING' || (statusAwal === 'RESERVED' && sudahPotong))) {
        throw new Error(`Order status ${statusAwal}, tidak bisa checkout ulang`);
      }

      const currentRevision = ticketData.revisionCounter || 0;

      // Optimistic locking: hanya relevan saat kita AKAN memotong stok.
      // Untuk pesanan yang sudah direservasi, revision sudah naik karena
      // potongan kita sendiri — mengeceknya justru memicu konflik palsu.
      if (!sudahPotong && revisionCounter !== undefined && revisionCounter !== currentRevision) {
        conflictDetected = true;
        return;
      }

      if (!sudahPotong) {
        const currentStock = ticketData.stok || 0;
        if (currentStock < jumlahTiket) {
          throw new Error(`Stok tidak cukup. Sisa: ${currentStock}`);
        }

        const newStock = currentStock - jumlahTiket;
        const newRevision = (currentRevision || 0) + 1;
        const newTerjual = (ticketData.terjual || 0) + jumlahTiket;

        transaction.update(ticketRef, {
          stok: newStock,
          terjual: newTerjual,
          revisionCounter: newRevision,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        finalRevision = newRevision;
      } else {
        finalRevision = currentRevision;
      }

      // Generate QR signature
      const privKey = crypto.createPrivateKey({ key: getSigningKey(), format: 'der', type: 'pkcs8' });
      const canonicalPayload = `SW2|${activeKeyId}|${orderRef.id}|${orderData.kodeBooking}|${orderData.idKonser}|${orderData.kategoriTiket}|${jumlahTiket}`;
      const edSignatureHex = crypto.sign(null, Buffer.from(canonicalPayload), privKey).toString('hex');
      const signedQrPayload = `${canonicalPayload}|${edSignatureHex}`;

      // GROSS AMOUNT: pakai total pesanan yang tersimpan (order.totalHarga) —
      // sumber yang sama dengan /create-va, /create-gopay, /create-qris
      // (loadOrderForCharge) dan angka yang tampil di halaman tiket.
      // Menghitung ulang dari harga tiket akan menagih harga PENUH pada
      // pesanan yang totalnya sudah terpotong voucher/promo.
      const grossAmount = Math.round(Number(orderData.totalHarga))
        || ((Number(ticketData.harga) || 0) * jumlahTiket) + 5000;
      const biayaAdmin = 5000;
      const sisaTiket = grossAmount - biayaAdmin;
      const qty = jumlahTiket || 1;
      const hargaSatuan = sisaTiket > 0 ? Math.round(sisaTiket / qty) : 0;
      const namaItem =
        `${orderData.judulKonser} (${orderData.kategoriTiket})`.substring(0, 50);
      // item_details WAJIB berjumlah tepat = gross_amount (validasi Snap).
      const itemDetails = (sisaTiket > 0 && hargaSatuan * qty === sisaTiket)
        ? [
            { id: ticketId, price: hargaSatuan, quantity: qty, name: namaItem },
            {
              id: 'BIAYA-ADMIN',
              price: biayaAdmin,
              quantity: 1,
              name: 'Biaya Layanan & Pemeliharaan',
            },
          ]
        : [{ id: ticketId, price: grossAmount, quantity: 1, name: namaItem }];

      // Update order: mark as reserved + generate Snap token
      const parameter = {
        transaction_details: {
          order_id: orderData.kodeBooking || orderId,
          gross_amount: grossAmount,
        },
        item_details: itemDetails,
        customer_details: {
          first_name: orderData.namaPembeli,
          email: orderData.emailPembeli,
          phone: orderData.teleponPembeli || '08123456789',
        },
      };

      // Snap token creation: best-effort. Jika order sudah memiliki transaksi
      // (VA/QR dibuat via Core API /create-va, /create-gopay, /create-qris di Step 2),
      // snap.createTransaction akan gagal "order_id already exists". Dalam kasus itu
      // kita reuse token lama dan TETAP menyelesaikan reservasi stok (inventory guarantee).
      try {
        const mtxResult = await snap.createTransaction(parameter);
        snapToken = mtxResult.token;
        redirectUrl = mtxResult.redirect_url;
      } catch (snapErr) {
        log.warn(`[checkout-atomic] Snap create skipped (non-fatal): ${(snapErr.message || snapErr).toString().substring(0, 150)}`);
        snapToken = orderData.snapToken || snapToken;
        redirectUrl = orderData.snapRedirectUrl || redirectUrl;
      }

      // Metode pembayaran yang benar-benar dipakai user (opsional, dari app).
      const metodeBayar = req.body && req.body.metodePembayaran
        ? String(req.body.metodePembayaran).substring(0, 60)
        : null;
      transaction.update(orderRef, {
        status: 'RESERVED',
        // Pembukuan stok: dipotong tepat sekali, dilepas tepat sekali.
        stokDipotong: true,
        stokDilepas: false,
        // Jendela pembayaran disegarkan dari jam SERVER (bukan jam HP user).
        reservedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + HOLD_MS),
        holdMenit: HOLD_MENIT,
        ...(metodeBayar ? { metodePembayaran: metodeBayar } : {}),
        snapToken: snapToken,
        snapRedirectUrl: redirectUrl,
        qrPayloadSignature: signedQrPayload,
        ticketRevisionAtCheckout: finalRevision,
        auditTrail: admin.firestore.FieldValue.arrayUnion({
          event: 'ATOMIC_CHECKOUT_RESERVED',
          ticketRevision: finalRevision,
          timestamp: new Date().toISOString(),
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    if (conflictDetected) {
      return res.status(409).json({
        success: false,
        message: 'Stok tiket berubah. Silakan refresh untuk lihat update terbaru',
        currentRevision: finalRevision,
        conflict: true,
      });
    }

    log.note(res, `pesanan dibuat · kursi dikunci`);
    res.json({
      success: true,
      order_id: orderId,
      token: snapToken,
      redirect_url: redirectUrl,
      ticketRevision: finalRevision,
    });
  } catch (err) {
    log.fail(res, 'checkout-atomic', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════
// 1c. POST /create-va
// Buat Virtual Account untuk Transfer Bank (BCA / BNI / Mandiri)
// Menggunakan Midtrans Core API /v2/charge dengan payment_type bank_transfer
// ═══════════════════════════════════════════
app.post('/create-va', async (req, res) => {
  try {
    const { orderId, bank } = req.body;
    const validBanks = ['bca', 'bni', 'mandiri'];
    const bankLower = (bank || '').toString().toLowerCase();

    if (!orderId || !bank || !validBanks.includes(bankLower)) {
      return res.status(400).json({
        success: false,
        message: 'orderId dan bank (bca/bni/mandiri) wajib disertakan',
      });
    }

    const { orderRef, orderData, grossAmount } = await loadOrderForCharge(orderId);

    // Idempotency: jika VA masih berlaku, kembalikan yang sama (cegah 406 conflict)
    if (orderData.vaNumber && isFutureTimestamp(orderData.vaExpiresAt)) {
      return res.json({
        success: true,
        va_number: orderData.vaNumber,
        bank: orderData.vaBank || bankLower,
        bill_key: orderData.billKey || null,
        biller_code: orderData.billerCode || null,
        expires_at: orderData.vaExpiresAt && orderData.vaExpiresAt.toDate
          ? orderData.vaExpiresAt.toDate().toISOString() : null,
        order_id: orderId,
        transaction_status: 'pending',
        reused: true,
      });
    }

    const midtransOrderId = uniqueMidtransOrderId(orderData.kodeBooking || orderId);

    // Charge via Core API — bank transfer
    const parameter = {
      payment_type: 'bank_transfer',
      transaction_details: {
        order_id: midtransOrderId,
        gross_amount: grossAmount,
      },
      bank_transfer: { bank: bankLower },
      customer_details: {
        first_name: orderData.namaPembeli || 'Pembeli',
        email: orderData.emailPembeli || 'guest@soundwave.id',
        phone: orderData.teleponPembeli || '08123456789',
      },
      item_details: [
        {
          id: orderData.idTiket || orderData.idKonser || 'TIKET',
          price: grossAmount - 5000 > 0 ? grossAmount - 5000 : grossAmount,
          quantity: orderData.jumlahTiket || 1,
          name: `${orderData.judulKonser || 'Tiket'} (${orderData.kategoriTiket || ''})`.substring(0, 50),
        },
        { id: 'BIAYA-ADMIN', price: 5000, quantity: 1, name: 'Biaya Layanan' },
      ],
      expiry: { unit: 'day', duration: 1 }, // VA berlaku 24 jam
    };

    const chargeResponse = await core.charge(parameter);

    // BCA & BNI → va_numbers[]; Mandiri → bill_key + biller_code
    let vaNumber = null;
    let vaBank = bankLower;
    let billKey = null;
    let billerCode = null;

    if (Array.isArray(chargeResponse.va_numbers) && chargeResponse.va_numbers.length > 0) {
      vaNumber = chargeResponse.va_numbers[0].va_number;
      vaBank = chargeResponse.va_numbers[0].bank || vaBank;
    } else if (chargeResponse.permata_va_number) {
      vaNumber = chargeResponse.permata_va_number;
      vaBank = 'permata';
    } else if (chargeResponse.bill_key) {
      billKey = chargeResponse.bill_key;
      billerCode = chargeResponse.biller_code;
      vaNumber = billKey; // Nomor utama untuk ditampilkan / disalin
      vaBank = 'mandiri';
    }

    if (!vaNumber) {
      return res.status(502).json({
        success: false,
        message: 'Midtrans tidak mengembalikan nomor VA: ' + JSON.stringify(chargeResponse).substring(0, 200),
      });
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await orderRef.update({
      midtransOrderId,
      vaNumber,
      vaBank,
      billKey: billKey || null,
      billerCode: billerCode || null,
      paymentType: 'bank_transfer',
      metodePembayaran: `Transfer Bank (${vaBank.toUpperCase()})`,
      midtransTransactionId: chargeResponse.transaction_id || null,
      vaExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      auditTrail: admin.firestore.FieldValue.arrayUnion({
        event: 'VA_CREATED',
        bank: vaBank,
        vaNumber,
        timestamp: new Date().toISOString(),
      }),
    });

    log.note(res, `VA ${vaBank} dibuat`);
    res.json({
      success: true,
      va_number: vaNumber,
      bank: vaBank,
      bill_key: billKey,
      biller_code: billerCode,
      expires_at: expiresAt.toISOString(),
      order_id: orderId,
      transaction_status: chargeResponse.transaction_status || 'pending',
    });
  } catch (err) {
    log.fail(res, 'create-va', err);
    const status = err.code || 500;
    res.status(status).json({
      success: false,
      message: 'Gagal membuat Virtual Account: ' + (err.message || err),
    });
  }
});

// ═══════════════════════════════════════════
// 1d. POST /create-gopay
// Buat transaksi GoPay + QR code (berlaku 5 menit)
// Menggunakan Midtrans Core API /v2/charge dengan payment_type gopay
// ═══════════════════════════════════════════
app.post('/create-gopay', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId wajib disertakan' });
    }

    const { orderRef, orderData, grossAmount } = await loadOrderForCharge(orderId);

    // Idempotency: jika QR GoPay masih berlaku, kembalikan yang sama
    if (orderData.gopayQrString && isFutureTimestamp(orderData.gopayExpiresAt)) {
      return res.json({
        success: true,
        qr_string: orderData.gopayQrString,
        qr_image_url: orderData.gopayQrImageUrl || buildQrImageUrl(orderData.gopayQrString),
        expires_at: orderData.gopayExpiresAt && orderData.gopayExpiresAt.toDate
          ? orderData.gopayExpiresAt.toDate().toISOString() : null,
        order_id: orderId,
        transaction_status: 'pending',
        reused: true,
      });
    }

    const midtransOrderId = uniqueMidtransOrderId(orderData.kodeBooking || orderId);

    const parameter = {
      payment_type: 'gopay',
      transaction_details: {
        order_id: midtransOrderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        first_name: orderData.namaPembeli || 'Pembeli',
        email: orderData.emailPembeli || 'guest@soundwave.id',
        phone: orderData.teleponPembeli || '08123456789',
      },
      gopay: {
        enable_callback: true,
        callback_url: (process.env.GOPAY_CALLBACK_URL || 'https://soundwave.id/callback'),
      },
      expiry: { unit: 'minute', duration: 5 }, // GoPay QR berlaku 5 menit
    };

    const chargeResponse = await core.charge(parameter);

    // GoPay charge → actions[] (generate-qr-code). Beberapa versi langsung qr_string.
    let qrString = chargeResponse.qr_string || chargeResponse.qrcode_string || null;
    let qrImageUrl = chargeResponse.qr_code_url || null;

    if (!qrString && Array.isArray(chargeResponse.actions)) {
      const qrAction = chargeResponse.actions.find(
        (a) => a.name === 'generate-qr-code' || (a.url && a.url.includes('gopay-qr'))
      );
      if (qrAction && qrAction.url) {
        const actionResp = await fetchActionUrl(qrAction.url);
        if (actionResp && typeof actionResp === 'object') {
          qrString = actionResp.qr_string || actionResp.qrcode_string || qrString;
          qrImageUrl = actionResp.qr_code_url || actionResp.qrcode_url || qrImageUrl;
        }
        // Fallback: render QR dari action URL itu sendiri
        if (!qrString) qrString = qrAction.url;
      }
    }

    if (!qrString) {
      return res.status(502).json({
        success: false,
        message: 'Midtrans tidak mengembalikan QR GoPay: ' + JSON.stringify(chargeResponse).substring(0, 200),
      });
    }

    qrImageUrl = qrImageUrl || buildQrImageUrl(qrString);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await orderRef.update({
      midtransOrderId,
      gopayQrString: qrString,
      gopayQrImageUrl: qrImageUrl,
      paymentType: 'gopay',
      metodePembayaran: 'GoPay',
      midtransTransactionId: chargeResponse.transaction_id || null,
      gopayExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      auditTrail: admin.firestore.FieldValue.arrayUnion({
        event: 'GOPAY_QR_CREATED',
        timestamp: new Date().toISOString(),
      }),
    });

    log.note(res, `QR GoPay dibuat · berlaku 5 menit`);
    res.json({
      success: true,
      qr_string: qrString,
      qr_image_url: qrImageUrl,
      expires_at: expiresAt.toISOString(),
      order_id: orderId,
      transaction_status: chargeResponse.transaction_status || 'pending',
    });
  } catch (err) {
    log.fail(res, 'create-gopay', err);
    const status = err.code || 500;
    res.status(status).json({
      success: false,
      message: 'Gagal membuat QR GoPay: ' + (err.message || err),
    });
  }
});

// ═══════════════════════════════════════════
// 1e. POST /create-qris
// Buat transaksi QRIS + QR code (berlaku 5 menit)
// Menggunakan Midtrans Core API /v2/charge dengan payment_type qris
// ═══════════════════════════════════════════
app.post('/create-qris', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId wajib disertakan' });
    }

    const { orderRef, orderData, grossAmount } = await loadOrderForCharge(orderId);

    // Idempotency: jika QR QRIS masih berlaku, kembalikan yang sama
    if (orderData.qrisQrString && isFutureTimestamp(orderData.qrisExpiresAt)) {
      return res.json({
        success: true,
        qr_string: orderData.qrisQrString,
        qr_image_url: orderData.qrisQrImageUrl || buildQrImageUrl(orderData.qrisQrString),
        expires_at: orderData.qrisExpiresAt && orderData.qrisExpiresAt.toDate
          ? orderData.qrisExpiresAt.toDate().toISOString() : null,
        order_id: orderId,
        transaction_status: 'pending',
        reused: true,
      });
    }

    const midtransOrderId = uniqueMidtransOrderId(orderData.kodeBooking || orderId);

    const parameter = {
      payment_type: 'qris',
      transaction_details: {
        order_id: midtransOrderId,
        gross_amount: grossAmount,
      },
      customer_details: {
        first_name: orderData.namaPembeli || 'Pembeli',
        email: orderData.emailPembeli || 'guest@soundwave.id',
        phone: orderData.teleponPembeli || '08123456789',
      },
      // PENTING: JANGAN set `qris.acquirer` = 'gpn'. Midtrans SANDBOX menolaknya
      // dengan HTTP 500 "Sorry. Our system is recovering from unexpected issues."
      // (terbukti lewat uji langsung). Biarkan default (gopay) — terverifikasi sukses.
      expiry: { unit: 'minute', duration: 5 }, // QRIS QR berlaku 5 menit
    };

    const chargeResponse = await core.charge(parameter);

    // QRIS charge langsung mengembalikan qr_string
    let qrString = chargeResponse.qr_string || chargeResponse.qrcode_string || null;
    let qrImageUrl = chargeResponse.qr_code_url || null;

    if (!qrString && Array.isArray(chargeResponse.actions)) {
      const qrAction = chargeResponse.actions.find((a) => a.url);
      if (qrAction && qrAction.url) {
        const actionResp = await fetchActionUrl(qrAction.url);
        if (actionResp && typeof actionResp === 'object') {
          qrString = actionResp.qr_string || qrString;
          qrImageUrl = actionResp.qr_code_url || qrImageUrl;
        }
      }
    }

    if (!qrString) {
      return res.status(502).json({
        success: false,
        message: 'Midtrans tidak mengembalikan QR QRIS: ' + JSON.stringify(chargeResponse).substring(0, 200),
      });
    }

    qrImageUrl = qrImageUrl || buildQrImageUrl(qrString);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await orderRef.update({
      midtransOrderId,
      qrisQrString: qrString,
      qrisQrImageUrl: qrImageUrl,
      paymentType: 'qris',
      metodePembayaran: 'QRIS',
      midtransTransactionId: chargeResponse.transaction_id || null,
      qrisExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      auditTrail: admin.firestore.FieldValue.arrayUnion({
        event: 'QRIS_QR_CREATED',
        timestamp: new Date().toISOString(),
      }),
    });

    log.note(res, `QR QRIS dibuat · berlaku 5 menit`);
    res.json({
      success: true,
      qr_string: qrString,
      qr_image_url: qrImageUrl,
      expires_at: expiresAt.toISOString(),
      order_id: orderId,
      transaction_status: chargeResponse.transaction_status || 'pending',
    });
  } catch (err) {
    log.fail(res, 'create-qris', err);
    const status = err.code || 500;
    res.status(status).json({
      success: false,
      message: 'Gagal membuat QR QRIS: ' + (err.message || err),
    });
  }
});

// ═══════════════════════════════════════════
// 1f. POST /poll-payment
// Cek status pembayaran Midtrans via Core API /v2/{orderId}/status
// Dipanggil Flutter secara periodik setelah QR/VA ditampilkan
// ═══════════════════════════════════════════
app.post('/poll-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId wajib disertakan' });
    }

    // Ambil order untuk dapat kodeBooking (Midtrans pakai kodeBooking sebagai order_id)
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }
    const orderData = orderDoc.data();
    const midtransOrderId = orderData.midtransOrderId || orderData.kodeBooking || orderId;

    // Core API: /v2/{orderId}/status
    const statusResponse = await core.transaction.status(midtransOrderId);

    const txStatus = statusResponse.transaction_status || 'pending';
    const fraudStatus = statusResponse.fraud_status;

    // Map status Midtrans → status SoundWave
    let mappedStatus = 'PENDING';
    let isPaid = false;
    if (txStatus === 'capture' && fraudStatus === 'accept') {
      mappedStatus = 'AKTIF'; isPaid = true;
    } else if (txStatus === 'settlement') {
      mappedStatus = 'AKTIF'; isPaid = true;
    } else if (['deny', 'cancel', 'expire'].includes(txStatus)) {
      mappedStatus = 'CANCELLED';
    }

    // Jika lunas dan order belum AKTIF, update Firestore
    if (isPaid && orderData.status !== 'AKTIF' && orderData.status !== 'TERPAKAI') {
      try {
        await db.runTransaction(async (transaction) => {
          const freshDoc = await transaction.get(orderRef);
          if (!freshDoc.exists) return;
          const freshData = freshDoc.data();
          if (freshData.status === 'AKTIF' || freshData.status === 'TERPAKAI') return;

          // Generate Ed25519 signed QR payload (reuse existing signing)
          const privKey = crypto.createPrivateKey({ key: getSigningKey(), format: 'der', type: 'pkcs8' });
          const canonicalPayload = `SW2|${activeKeyId}|${orderRef.id}|${freshData.kodeBooking}|${freshData.idKonser}|${freshData.kategoriTiket}|${freshData.jumlahTiket}`;
          const edSignatureHex = crypto.sign(null, Buffer.from(canonicalPayload), privKey).toString('hex');

          transaction.update(orderRef, {
            status: 'AKTIF',
            qrPayloadSignature: `${canonicalPayload}|${edSignatureHex}`,
            paymentDetails: {
              transactionStatus: txStatus,
              fraudStatus: fraudStatus || null,
              paymentType: statusResponse.payment_type || orderData.paymentType || null,
              processedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            auditTrail: admin.firestore.FieldValue.arrayUnion({
              event: 'POLL_PAYMENT_SETTLED',
              status: 'AKTIF',
              timestamp: new Date().toISOString(),
              transactionStatus: txStatus,
            }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        log.note(res, `pembayaran selesai · tiket AKTIF`);
      } catch (txErr) {
        log.warn(`[poll-payment] Firestore update failed (non-fatal): ${txErr.message}`);
      }
    }

    res.json({
      success: true,
      order_id: orderId,
      transaction_status: txStatus,
      status: mappedStatus,
      fraud_status: fraudStatus || null,
      payment_type: statusResponse.payment_type || null,
      is_paid: isPaid,
    });
  } catch (err) {
    log.fail(res, 'poll-payment', err);
    res.status(500).json({
      success: false,
      message: 'Gagal mengecek status pembayaran: ' + (err.message || err),
    });
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
      log.warn(`[SECURITY] Invalid webhook signature for ${orderIdOrBookingCode}`);
      return res.status(403).json({ error: 'Invalid signature key' });
    }

    // 2. Cari order di Firestore (by ID atau kodeBooking)
    let orderRef = db.collection('orders').doc(orderIdOrBookingCode);
    let orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      let query = await db.collection('orders')
        .where('kodeBooking', '==', orderIdOrBookingCode)
        .limit(1).get();
      if (query.empty) {
        // Fallback: cari berdasarkan midtransOrderId (order_id unik per charge)
        query = await db.collection('orders')
          .where('midtransOrderId', '==', orderIdOrBookingCode)
          .limit(1).get();
      }
      if (query.empty) {
        return res.status(404).json({ error: 'Order not found' });
      }
      orderDoc = query.docs[0];
      orderRef = query.docs[0].ref;
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

    // 4. Idempotency check (RESERVED → AKTIF OK, jangan reject)
    if (currentOrder.status === 'AKTIF' || currentOrder.status === 'TERPAKAI') {
      return res.json({ status: 'already_processed' });
    }

    // 5. Atomic transaction: update status + inventory
    let finalStatus = targetStatus;
    // Di-set HANYA bila transaksi ini yang benar-benar mengubah status.
    // (Jalur 'sudah AKTIF' di bawah tidak meng-set-nya, sehingga webhook
    //  yang datang berulang tidak mengirim notifikasi dobel.)
    let notifUntukDikirim = null;

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
      const sudahPotong = stokSudahDipotong(freshData);
      let isOverbooked = false;
      let potongSekarang = false;
      let lepasSekarang = false;

      // ── PEMBUKUAN STOK — satu aturan, tidak pernah dobel ──
      // Stok dipotong SEKALI saat reservasi (/checkout-atomic), dilepas SEKALI
      // saat gagal/kedaluwarsa, dan TIDAK dipotong lagi saat pembayaran masuk.
      if (isPaidSuccess) {
        if (freshData.status === 'EXPIRED' || freshData.status === 'CANCELLED') {
          // Uang masuk tapi stok sudah dilepas → tiket tidak bisa diberikan.
          finalStatus = 'REFUND_REQUIRED';
          isOverbooked = true;
        } else if (freshData.idTiket && !sudahPotong) {
          // Alur lama / pesanan yang belum pernah memotong: potong sekali sekarang.
          const ticketRef = db.collection('tickets').doc(freshData.idTiket);
          const ticketDoc = await transaction.get(ticketRef);

          if (ticketDoc.exists) {
            const ticketData = ticketDoc.data();
            const currentStock = ticketData.stok || 0;
            const qty = freshData.jumlahTiket || 1;

            if (currentStock < qty) {
              isOverbooked = true;
              finalStatus = 'REFUND_REQUIRED';
            } else {
              transaction.update(ticketRef, {
                stok: currentStock - qty,
                terjual: (ticketData.terjual || 0) + qty,
                revisionCounter: (ticketData.revisionCounter || 0) + 1,
              });
              potongSekarang = true;
            }
          }
        }
      } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
        // Gagal bayar / kedaluwarsa di Midtrans → status EXPIRED (bukan
        // CANCELLED) dan stok dilepas SEKALI kalau memang pernah dipotong.
        finalStatus = 'EXPIRED';
        lepasSekarang = !!sudahPotong && !!freshData.idTiket;

        if (lepasSekarang) {
          const ticketRef = db.collection('tickets').doc(freshData.idTiket);
          const ticketDoc = await transaction.get(ticketRef);
          if (ticketDoc.exists) {
            const ticketData = ticketDoc.data();
            const qty = freshData.jumlahTiket || 1;
            transaction.update(ticketRef, {
              stok: (ticketData.stok || 0) + qty,
              terjual: Math.max(0, (ticketData.terjual || 0) - qty),
              revisionCounter: (ticketData.revisionCounter || 0) + 1,
            });
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
        ...(potongSekarang ? { stokDipotong: true } : {}),
        ...(lepasSekarang ? { stokDilepas: true } : {}),
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

      notifUntukDikirim = finalStatus;
    });

    // 6. Notifikasi in-app (non-fatal)
    if (notifUntukDikirim === 'AKTIF') {
      await kirimNotifikasi(currentOrder.userId, {
        title: 'Pembayaran Berhasil',
        message: `E-tiket ${currentOrder.judulKonser || 'konsermu'} `
          + `(${currentOrder.jumlahTiket || 1} tiket) sudah aktif. `
          + `Kode booking ${currentOrder.kodeBooking || orderRef.id}.`,
        type: 'payment_success',
        refId: orderRef.id,
      });
    } else if (notifUntukDikirim === 'REFUND_REQUIRED') {
      await kirimNotifikasi(currentOrder.userId, {
        title: 'Pesanan Tidak Dapat Diproses',
        message: `Stok tiket habis saat pembayaranmu masuk. `
          + `Dana ${rupiah(currentOrder.totalHarga)} akan dikembalikan. `
          + `Kode booking ${currentOrder.kodeBooking || orderRef.id}.`,
        type: 'refund_required',
        refId: orderRef.id,
      });
    } else if (notifUntukDikirim === 'EXPIRED') {
      await kirimNotifikasi(currentOrder.userId, {
        title: 'Pembayaran Kedaluwarsa',
        message: `Pembayaran untuk ${currentOrder.kodeBooking || orderRef.id} tidak selesai. `
          + `Stok tiket sudah dilepas kembali — silakan pesan ulang kalau masih ingin datang.`,
        type: 'order_expired',
        refId: orderRef.id,
      });
    } else if (notifUntukDikirim === 'CANCELLED') {
      await kirimNotifikasi(currentOrder.userId, {
        title: 'Pembayaran Dibatalkan',
        message: `Pembayaran untuk ${currentOrder.kodeBooking || orderRef.id} `
          + `dibatalkan atau kedaluwarsa. Kursi dilepas kembali.`,
        type: 'payment_cancelled',
        refId: orderRef.id,
      });
    }

    log.note(res, `webhook Midtrans · status ${finalStatus}`);
    res.json({ status: 'ok', updated_status: finalStatus });
  } catch (err) {
    log.fail(res, 'webhook', err);
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
    log.fail(res, 'check-status', err);
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
      if (orderData.status === 'EXPIRED') {
        throw new Error(
          `Waktu pembayaran ${HOLD_MENIT} menit sudah habis. Pesanan kedaluwarsa — silakan pesan ulang.`
        );
      }

      // ── Stok: potong HANYA kalau belum pernah dipotong saat reservasi. ──
      // Dulu blok ini memotong tanpa syarat, sehingga 1 tiket memotong stok
      // DUA kali (sekali di /checkout-atomic, sekali di sini).
      if (orderData.idTiket && !stokSudahDipotong(orderData)) {
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
        stokDipotong: true,
        stokDilepas: false,
        qrPayloadSignature: `${canonicalPayload}|${edSignatureHex}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        auditTrail: admin.firestore.FieldValue.arrayUnion({
          event: 'DEV_SETTLEMENT_SIMULATED',
          timestamp: new Date().toISOString(),
        }),
      });
    });

    log.note(res, `settlement dev · tiket AKTIF`);
    res.json({ success: true, message: 'Pesanan berhasil diselesaikan (DEV)' });
  } catch (err) {
    log.fail(res, 'settle-dev', err);
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
    log.fail(res, 'sync-offline-scans', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ═══════════════════════════════════════════
// 6. PROMO CODES
// ═══════════════════════════════════════════

// 6a. POST /validate-promo
// Validasi kode promo saat checkout
app.post('/validate-promo', async (req, res) => {
  try {
    const { kode, idKonser, subtotal } = req.body;
    if (!kode || !idKonser || subtotal === undefined) {
      return res.status(400).json({ success: false, message: 'kode, idKonser, subtotal wajib disertakan' });
    }

    const subtotalNum = Math.round(Number(subtotal)) || 0;
    const promoRef = db.collection('promo_codes').doc(kode);
    const promoDoc = await promoRef.get();

    if (!promoDoc.exists) {
      return res.json({ valid: false, message: 'Kode promo tidak ditemukan' });
    }

    const promo = promoDoc.data();

    // Cek aktif
    if (promo.aktif === false) {
      return res.json({ valid: false, message: 'Kode promo sudah tidak aktif' });
    }

    // Cek periode berlaku (berlakuMulai/berlakuAkhir disimpan sebagai ISO string)
    const nowMs = Date.now();
    const mulaiMs = promo.berlakuMulai ? new Date(promo.berlakuMulai).getTime() : 0;
    const akhirMs = promo.berlakuAkhir ? new Date(promo.berlakuAkhir).getTime() : Infinity;
    if (Number.isNaN(mulaiMs) || Number.isNaN(akhirMs) || nowMs < mulaiMs || nowMs > akhirMs) {
      return res.json({ valid: false, message: 'Kode promo di luar periode berlaku' });
    }

    // Cek konser (kosong = berlaku untuk semua konser)
    if (promo.idKonser && promo.idKonser !== idKonser) {
      return res.json({ valid: false, message: 'Kode promo tidak berlaku untuk konser ini' });
    }

    // Cek kuota pemakaian
    const sudahDipakai = Number(promo.sudahDipakai) || 0;
    const maxPakai = Number(promo.maxPakai) || 0;
    if (maxPakai > 0 && sudahDipakai >= maxPakai) {
      return res.json({ valid: false, message: 'Kuota kode promo sudah habis' });
    }

    // Cek minimal pembelian
    const minPembelian = Number(promo.minPembelian) || 0;
    if (minPembelian > 0 && subtotalNum < minPembelian) {
      return res.json({
        valid: false,
        message: `Minimal pembelian Rp${minPembelian.toLocaleString('id-ID')} untuk kode ini`,
      });
    }

    // Hitung diskon
    const nilai = Number(promo.nilai) || 0;
    const tipe = promo.tipe; // 'persen' | 'nominal'
    let discountAmount = 0;
    if (tipe === 'persen') {
      discountAmount = Math.round((subtotalNum * nilai) / 100);
    } else {
      discountAmount = Math.min(nilai, subtotalNum);
    }

    log.note(res, `promo valid · diskon Rp${discountAmount}`);
    res.json({
      valid: true,
      tipe,
      nilai,
      discountAmount,
      deskripsi: promo.deskripsi || null,
    });
  } catch (err) {
    log.fail(res, 'validate-promo', err);
    res.status(500).json({ success: false, message: 'Gagal memvalidasi kode promo: ' + (err.message || err) });
  }
});

// 6b. POST /admin/promo
// Buat kode promo baru
app.post('/admin/promo', wajibAdmin, async (req, res) => {
  try {
    const { kode, tipe, nilai, idKonser, minPembelian, maxPakai, berlakuMulai, berlakuAkhir, deskripsi } = req.body;
    if (!kode || !tipe || nilai === undefined) {
      return res.status(400).json({ success: false, message: 'kode, tipe, nilai wajib disertakan' });
    }
    if (!['persen', 'nominal'].includes(tipe)) {
      return res.status(400).json({ success: false, message: "tipe harus 'persen' atau 'nominal'" });
    }

    const promoRef = db.collection('promo_codes').doc(kode);
    const existing = await promoRef.get();
    if (existing.exists) {
      return res.status(409).json({ success: false, message: 'Kode promo sudah ada' });
    }

    const docData = {
      kode,
      tipe,
      nilai: Number(nilai) || 0,
      idKonser: idKonser || null,
      minPembelian: Number(minPembelian) || 0,
      maxPakai: Number(maxPakai) || 0,
      sudahDipakai: 0,
      berlakuMulai: berlakuMulai ? new Date(berlakuMulai).toISOString() : null,
      berlakuAkhir: berlakuAkhir ? new Date(berlakuAkhir).toISOString() : null,
      deskripsi: deskripsi || null,
      aktif: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await promoRef.set(docData);

    log.note(res, `promo dibuat`);
    res.json({ success: true, kode, message: 'Kode promo berhasil dibuat' });
  } catch (err) {
    log.fail(res, 'admin/promo', err);
    res.status(500).json({ success: false, message: 'Gagal membuat kode promo: ' + (err.message || err) });
  }
});

// 6c. GET /admin/promos
// List semua kode promo
app.get('/admin/promos', wajibAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('promo_codes').get();
    const promos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, count: promos.length, promos });
  } catch (err) {
    log.fail(res, 'admin/promos', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil daftar promo: ' + (err.message || err) });
  }
});

// 6d. DELETE /admin/promo/:id
// Nonaktifkan kode promo (aktif=false)
app.delete('/admin/promo/:id', wajibAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const promoRef = db.collection('promo_codes').doc(id);
    const promoDoc = await promoRef.get();
    if (!promoDoc.exists) {
      return res.status(404).json({ success: false, message: 'Kode promo tidak ditemukan' });
    }
    await promoRef.update({
      aktif: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    log.note(res, `promo dinonaktifkan`);
    res.json({ success: true, message: 'Kode promo berhasil dinonaktifkan' });
  } catch (err) {
    log.fail(res, 'admin/promo DELETE', err);
    res.status(500).json({ success: false, message: 'Gagal menonaktifkan kode promo: ' + (err.message || err) });
  }
});

// ═══════════════════════════════════════════
// 7. REFUND WORKFLOW
// ═══════════════════════════════════════════

// 7a. POST /request-refund
// User ajukan refund → buat doc 'refunds' + set order REFUND_REQUESTED
app.post('/request-refund', async (req, res) => {
  try {
    const { orderId, userId, alasan } = req.body;
    if (!orderId || !alasan) {
      return res.status(400).json({ success: false, message: 'orderId dan alasan wajib disertakan' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }
    const orderData = orderDoc.data();

    // Validasi kepemilikan
    if (userId && orderData.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke pesanan ini' });
    }

    // Hanya order yang sudah dibayar (AKTIF/TERPAKAI) bisa diajukan refund
    if (!['AKTIF', 'TERPAKAI'].includes(orderData.status)) {
      return res.status(400).json({
        success: false,
        message: `Pesanan berstatus ${orderData.status}, tidak bisa request refund`,
      });
    }

    const refundRef = db.collection('refunds').doc();
    const refundId = refundRef.id;
    const now = new Date().toISOString();

    await refundRef.set({
      refundId,
      orderId,
      userId: orderData.userId || userId || null,
      alasan,
      status: 'PENDING',
      amount: Math.round(Number(orderData.totalHarga)) || 0,
      refundAmount: Math.round(Number(orderData.totalHarga)) || 0,
      kodeBooking: orderData.kodeBooking || null,
      judulKonser: orderData.judulKonser || null,
      namaPembeli: orderData.namaPembeli || null,
      jumlahTiket: Number(orderData.jumlahTiket) || 0,
      totalHarga: Number(orderData.totalHarga) || 0,
      tanggalRequest: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await orderRef.update({
      status: 'REFUND_REQUESTED',
      refundId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      auditTrail: admin.firestore.FieldValue.arrayUnion({
        event: 'REFUND_REQUESTED',
        refundId,
        alasan,
        timestamp: now,
      }),
    });

    await kirimNotifikasi(orderData.userId || userId, {
      title: 'Pengajuan Refund Diterima',
      message: `Pengajuan refund untuk ${orderData.kodeBooking || orderId} `
        + `sudah kami terima dan sedang ditinjau admin.`,
      type: 'refund_requested',
      refId: orderId,
    });

    log.note(res, `pengajuan refund dibuat`);
    res.json({ success: true, refundId, status: 'PENDING' });
  } catch (err) {
    log.fail(res, 'request-refund', err);
    res.status(500).json({ success: false, message: 'Gagal membuat permintaan refund: ' + (err.message || err) });
  }
});

// 7b. GET /admin/refunds
// List semua request refund, support ?status=PENDING
app.get('/admin/refunds', wajibAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = db.collection('refunds');
    if (status) {
      query = query.where('status', '==', String(status).toUpperCase());
    }
    const snapshot = await query.get();
    const refunds = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, count: refunds.length, refunds });
  } catch (err) {
    log.fail(res, 'admin/refunds', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil daftar refund: ' + (err.message || err) });
  }
});

// 7c. POST /admin/refund/approve  (alias: POST /approve-refund)
// Setujui refund: order -> REFUNDED, stok tiket dipulihkan (bila belum pernah discan),
// refund -> APPROVED. Pengembalian uang dilakukan MANUAL oleh admin (TIDAK memanggil Midtrans).
async function handleRefundApprove(req, res) {
  try {
    const { refundId } = req.body;
    let { orderId } = req.body;
    if (!refundId) {
      return res.status(400).json({ success: false, message: 'refundId wajib disertakan' });
    }

    const refundRef = db.collection('refunds').doc(refundId);
    const refundDoc = await refundRef.get();
    if (!refundDoc.exists) {
      return res.status(404).json({ success: false, message: 'Permintaan refund tidak ditemukan' });
    }
    const refundData = refundDoc.data();
    if (!orderId) orderId = refundData.orderId;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId tidak ditemukan pada dokumen refund' });
    }

    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }
    const orderData = orderDoc.data();

    // Hanya pesanan yang sedang mengajukan refund yang boleh di-approve.
    if (!['REFUND_REQUESTED', 'REFUND_REQUIRED'].includes(orderData.status)) {
      return res.status(409).json({
        success: false,
        message: `Pesanan berstatus ${orderData.status}, tidak bisa menyetujui refund`,
      });
    }

    const refundAmount = Math.round(Number(refundData.amount || refundData.refundAmount || orderData.totalHarga)) || 0;
    // Tiket yang sudah pernah discan tidak mengembalikan stok (kursi sudah terpakai).
    const sudahDiscan = !!orderData.tanggalDigunakan;

    let stokDipulihkan = false;
    if (!sudahDiscan && orderData.idTiket) {
      const ticketRef = db.collection('tickets').doc(orderData.idTiket);
      const ticketDoc = await ticketRef.get();
      if (ticketDoc.exists) {
        const td = ticketDoc.data();
        const qty = orderData.jumlahTiket || 1;
        await ticketRef.update({
          stok: (td.stok || 0) + qty,
          terjual: Math.max(0, (td.terjual || 0) - qty),
          revisionCounter: (td.revisionCounter || 0) + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        stokDipulihkan = true;
      }
    }

    const now = new Date().toISOString();
    await orderRef.update({
      status: 'REFUNDED',
      refundStatus: 'APPROVED',
      refundAmount,
      refundProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      auditTrail: admin.firestore.FieldValue.arrayUnion({
        event: 'REFUND_APPROVED',
        refundId,
        refundAmount,
        stokDipulihkan,
        metodePengembalian: 'MANUAL',
        timestamp: now,
      }),
    });

    await refundRef.update({
      status: 'APPROVED',
      refundAmount,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await kirimNotifikasi(orderData.userId, {
      title: 'Refund Disetujui',
      message: `${rupiah(refundAmount)} untuk pesanan `
        + `${orderData.kodeBooking || orderId} disetujui. `
        + `Pengembalian dana dilakukan manual oleh admin.`,
      type: 'refund_approved',
      refId: orderId,
    });

    log.note(res, `refund disetujui · dana dikembalikan manual`);
    res.json({
      success: true,
      refundId,
      orderId,
      status: 'REFUNDED',
      refundAmount,
      stokDipulihkan,
      metodePengembalian: 'MANUAL',
    });
  } catch (err) {
    log.fail(res, 'admin/refund/approve', err);
    res.status(500).json({ success: false, message: 'Gagal menyetujui refund: ' + (err.message || err) });
  }
}

app.post('/admin/refund/approve', wajibAdmin, handleRefundApprove);
app.post('/approve-refund', wajibAdmin, handleRefundApprove); // alias kompatibilitas app lama

// 7d. POST /admin/refund/reject  (alias: POST /reject-refund)
// Tolak refund: refund -> REJECTED (+ alasan), order dikembalikan ke AKTIF (atau TERPAKAI
// bila tiket sudah pernah discan) supaya tiket bisa dipakai/discan kembali.
async function handleRefundReject(req, res) {
  try {
    const { refundId, alasanReject } = req.body;
    if (!refundId || !alasanReject) {
      return res.status(400).json({ success: false, message: 'refundId dan alasanReject wajib disertakan' });
    }

    const refundRef = db.collection('refunds').doc(refundId);
    const refundDoc = await refundRef.get();
    if (!refundDoc.exists) {
      return res.status(404).json({ success: false, message: 'Permintaan refund tidak ditemukan' });
    }
    const refundData = refundDoc.data();
    const orderId = refundData.orderId;
    const now = new Date().toISOString();

    await refundRef.update({
      status: 'REJECTED',
      alasanReject,
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    let statusOrderBaru = null;
    if (orderId) {
      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await orderRef.get();
      if (orderDoc.exists) {
        const od = orderDoc.data();
        // Kembalikan ke TERPAKAI bila tiket sudah pernah discan, selain itu AKTIF.
        statusOrderBaru = od.tanggalDigunakan ? 'TERPAKAI' : 'AKTIF';
        await orderRef.update({
          status: statusOrderBaru,
          refundStatus: 'REJECTED',
          refundRejectReason: alasanReject,
          refundProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          auditTrail: admin.firestore.FieldValue.arrayUnion({
            event: 'REFUND_REJECTED',
            refundId,
            alasanReject,
            statusOrderBaru,
            timestamp: now,
          }),
        });

        await kirimNotifikasi(od.userId, {
          title: 'Refund Ditolak',
          message: `Pengajuan refund untuk ${od.kodeBooking || orderId} `
            + `ditolak. Alasan: ${alasanReject}. `
            + `Status pesanan: ${statusOrderBaru}.`,
          type: 'refund_rejected',
          refId: orderId,
        });
      }
    }

    log.note(res, `refund ditolak · tiket ${statusOrderBaru}`);
    res.json({ success: true, refundId, orderId, status: 'REJECTED', statusOrder: statusOrderBaru });
  } catch (err) {
    log.fail(res, 'admin/refund/reject', err);
    res.status(500).json({ success: false, message: 'Gagal menolak refund: ' + (err.message || err) });
  }
}

app.post('/admin/refund/reject', wajibAdmin, handleRefundReject);
app.post('/reject-refund', wajibAdmin, handleRefundReject); // alias kompatibilitas app lama

// ═══════════════════════════════════════════
// 8. INVOICE
// ═══════════════════════════════════════════

// 8a. GET /invoice/:orderId
// Generate invoice number (INV-SW-YYYY-XXXX) + return detail invoice
app.get('/invoice/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: 'Pesanan tidak ditemukan' });
    }
    const orderData = orderDoc.data();

    // Generate / reuse invoice number
    let invoiceNumber = orderData.invoiceNumber;
    if (!invoiceNumber) {
      const year = new Date().getFullYear();
      const seq = String(Math.floor(1000 + Math.random() * 9000));
      invoiceNumber = `INV-SW-${year}-${seq}`;
      await orderRef.update({
        invoiceNumber,
        invoiceGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Ambil harga tiket authoritative dari tickets collection
    let ticketPrice = 0;
    if (orderData.idTiket) {
      const ticketDoc = await db.collection('tickets').doc(orderData.idTiket).get();
      if (ticketDoc.exists) {
        ticketPrice = Number(ticketDoc.data().harga) || 0;
      }
    }
    const qty = Number(orderData.jumlahTiket) || 1;
    if (!ticketPrice) {
      // Fallback: derive dari totalHarga (minus biaya layanan 5000)
      const derived = (Number(orderData.totalHarga) - 5000) / qty;
      if (derived > 0) ticketPrice = Math.round(derived);
    }

    const items = [{
      name: `${orderData.judulKonser || 'Tiket Konser'} (${orderData.kategoriTiket || ''})`.trim(),
      price: ticketPrice,
      qty,
    }];

    const subtotal = ticketPrice * qty;
    const ppn11 = Math.round(subtotal * 0.11);
    const total = subtotal + ppn11;

    // Tanggal invoice: pakai createdAt order, fallback now
    let date = new Date().toISOString();
    if (orderData.createdAt) {
      try {
        date = orderData.createdAt._seconds
          ? orderData.createdAt.toDate().toISOString()
          : new Date(orderData.createdAt).toISOString();
      } catch (_) { /* keep now */ }
    }

    res.json({
      invoiceNumber,
      date,
      buyerName: orderData.namaPembeli || null,
      buyerEmail: orderData.emailPembeli || null,
      items,
      subtotal,
      ppn11,
      total,
      status: orderData.status || null,
      paymentMethod: orderData.metodePembayaran || orderData.paymentType || null,
    });
  } catch (err) {
    log.fail(res, 'invoice', err);
    res.status(500).json({ success: false, message: 'Gagal membuat invoice: ' + (err.message || err) });
  }
});

// ═══════════════════════════════════════════
// 6. SAPU RESERVASI KEDALUWARSA (PENDING + RESERVED)
// ═══════════════════════════════════════════
// Jendela pembayaran HOLD_MENIT menit. Begitu lewat:
//   PENDING  → EXPIRED (stok belum pernah dipotong → tidak ada yang dilepas)
//   RESERVED → EXPIRED + stok dilepas SEKALI (ditandai stokDilepas)
// Dulu penyapu hanya mengenal PENDING, sehingga pesanan RESERVED nyangkut
// selamanya dan stoknya terkunci (kursi "hantu").
async function sapuReservasiKedaluwarsa(limit = 50) {
  const sekarang = admin.firestore.Timestamp.fromMillis(Date.now());
  // Query satu field (reservedUntil) saja → tidak butuh composite index.
  const snap = await db.collection('orders')
    .where('reservedUntil', '<', sekarang)
    .limit(limit)
    .get();

  let stokDilepas = 0;
  const selesai = [];

  for (const doc of snap.docs) {
    const awal = doc.data();
    if (awal.status !== 'PENDING' && awal.status !== 'RESERVED') continue;

    const hasil = await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      if (!fresh.exists) return null;

      const o = fresh.data();
      if (o.status !== 'PENDING' && o.status !== 'RESERVED') return null;

      const qty = o.jumlahTiket || 1;
      const bolehLepas = !!o.idTiket && stokSudahDipotong(o);

      if (bolehLepas) {
        const ticketRef = db.collection('tickets').doc(o.idTiket);
        const ticketDoc = await transaction.get(ticketRef);
        if (ticketDoc.exists) {
          const td = ticketDoc.data();
          transaction.update(ticketRef, {
            stok: (td.stok || 0) + qty,
            terjual: Math.max(0, (td.terjual || 0) - qty),
            revisionCounter: (td.revisionCounter || 0) + 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      transaction.update(doc.ref, {
        status: 'EXPIRED',
        ...(bolehLepas ? { stokDilepas: true } : {}),
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        auditTrail: admin.firestore.FieldValue.arrayUnion({
          event: 'RESERVATION_EXPIRED',
          stokDilepas: !!bolehLepas,
          timestamp: new Date().toISOString(),
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        userId: o.userId || null,
        kode: o.kodeBooking || doc.id,
        id: doc.id,
        dilepas: !!bolehLepas,
      };
    });

    if (hasil) {
      if (hasil.dilepas) stokDilepas++;
      selesai.push(hasil);
    }
  }

  for (const n of selesai) {
    if (!n.userId) continue;
    try {
      await kirimNotifikasi(n.userId, {
        title: 'Waktu Pembayaran Habis',
        message: `Pesanan ${n.kode} kedaluwarsa karena tidak dibayar dalam ${HOLD_MENIT} menit. `
          + 'Stok tiket sudah dilepas — silakan pesan ulang kalau masih ingin datang.',
        type: 'order_expired',
        refId: n.id,
      });
    } catch (_) { /* notifikasi tidak boleh menggagalkan penyapuan */ }
  }

  return { diperiksa: snap.size, kedaluwarsa: selesai.length, stokDilepas };
}

app.post('/sweep-expired', async (req, res) => {
  try {
    const hasil = await sapuReservasiKedaluwarsa();
    log.note(res, `sapu reservasi · ${hasil.kedaluwarsa} kedaluwarsa · ${hasil.stokDilepas} stok dilepas`);
    res.json({ success: true, ...hasil });
  } catch (err) {
    log.fail(res, 'sweep-expired', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Penyapu otomatis tiap 30 detik — app tidak perlu jadi penentu waktu.
const sapuTimer = setInterval(() => {
  sapuReservasiKedaluwarsa().catch((e) => log.warn(`[sweep] ${e.message}`));
}, 30000);
if (sapuTimer.unref) sapuTimer.unref();

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;

// Daftar rute untuk ditampilkan di banner (urut sesuai alur pemakaian).
const ROUTES = [
  { method: 'POST',   path: '/create-transaction' },
  { method: 'POST',   path: '/checkout-atomic' },
  { method: 'POST',   path: '/create-va' },
  { method: 'POST',   path: '/create-gopay' },
  { method: 'POST',   path: '/create-qris' },
  { method: 'POST',   path: '/poll-payment' },
  { method: 'POST',   path: '/midtrans-webhook' },
  { method: 'GET',    path: '/check-status/:orderId' },
  { method: 'POST',   path: '/settle-dev' },
  { method: 'POST',   path: '/sweep-expired' },
  { method: 'POST',   path: '/validate-promo' },
  { method: 'POST',   path: '/request-refund' },
  { method: 'POST',   path: '/admin/refund/approve' },
  { method: 'POST',   path: '/admin/refund/reject' },
  { method: 'GET',    path: '/admin/refunds' },
  { method: 'POST',   path: '/admin/promo' },
  { method: 'GET',    path: '/admin/promos' },
  { method: 'DELETE', path: '/admin/promo/:id' },
  { method: 'GET',    path: '/invoice/:orderId' },
  { method: 'POST',   path: '/sync-offline-scans' },
];

function formatStartTime(d) {
  const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(d.getDate())} ${BULAN[d.getMonth()]} ${d.getFullYear()}, ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} WIB`;
}

const bootStart = Date.now();
app.listen(PORT, '0.0.0.0', () => {
  log.banner({
    port: PORT,
    midtrans: isProduction ? 'PRODUCTION' : 'SANDBOX',
    firebaseProject: firebaseProjectId,
    nodeVersion: process.version.replace(/^v/, ''),
    pid: process.pid,
    startedAt: formatStartTime(new Date()),
    routes: ROUTES,
  });
  log.ready(Date.now() - bootStart);
  log.startHeartbeat(60000);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.shutdown(sig); process.exit(0); });
}
