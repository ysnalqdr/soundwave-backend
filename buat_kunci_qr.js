'use strict';
/**
 * buat_kunci_qr.js — membuat pasangan kunci Ed25519 untuk tanda tangan QR tiket.
 *
 * Jalankan sekali, lalu simpan hasilnya:
 *   1. ED25519_PRIVATE_KEY_HEX ke .env  (jangan pernah di-commit)
 *   2. kunci publik ke aplikasi Flutter (OfflineTicketService.publicKeyRing)
 *
 * Contoh: node buat_kunci_qr.js
 */
const crypto = require('crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

// Kunci privat disimpan sebagai PKCS#8 DER dalam bentuk hex,
// bentuk yang dibaca crypto.createPrivateKey() di server.js.
const privatHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');

// Kunci publik diambil dari 32 byte terakhir SPKI DER,
// bentuk yang dipakai paket cryptography di Dart.
const publikHex = publicKey.export({ type: 'spki', format: 'der' }).slice(-32).toString('hex');

const sidikJari = crypto.createHash('sha256').update(publikHex).digest('hex').slice(0, 16);

console.log('');
console.log('Pasangan kunci Ed25519 baru');
console.log('──────────────────────────────────────────────────────────────');
console.log('kunci publik  :', publikHex);
console.log('sidik jari    :', sidikJari);
console.log('');
console.log('Simpan baris berikut di .env backend (jangan di-commit):');
console.log('  ED25519_KEY_ID=v3');
console.log('  ED25519_PRIVATE_KEY_HEX=' + privatHex);
console.log('');
console.log('Lalu tempel kunci publik di atas ke publicKeyRing aplikasi Flutter');
console.log('dengan keyId yang sama, dan tambahkan keyId lama ke revokedKeyIds.');
console.log('');
