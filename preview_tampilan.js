'use strict';
/**
 * preview_tampilan.js — pratinjau tampilan console TANPA menjalankan server.
 *
 *   node preview_tampilan.js               → pratinjau apa adanya (tanpa warna
 *                                            bila output bukan terminal)
 *   FORCE_COLOR=1 node preview_tampilan.js → paksa warna (lihat ANSI-nya)
 */
const log = require('./logger');

log.banner({
  port: 3000,
  midtrans: 'SANDBOX',
  firebaseProject: 'flutter-firebase-konser-apps',
  nodeVersion: process.version.replace(/^v/, ''),
  pid: process.pid,
  startedAt: '16 Okt 2026, 19:25:05 WIB',
  routes: [
    { method: 'POST', path: '/create-transaction' },
    { method: 'POST', path: '/checkout-atomic' },
    { method: 'POST', path: '/create-va' },
    { method: 'POST', path: '/create-gopay' },
    { method: 'POST', path: '/create-qris' },
    { method: 'GET', path: '/check-status/:orderId' },
  ],
});
log.ready(33);

log.request({ method: 'POST', path: '/create-qris', status: 200, ms: 412, ref: '3pR143eJFUFqhZZSZPFW', note: 'QR QRIS dibuat · berlaku 5 menit' });
log.request({ method: 'POST', path: '/poll-payment', status: 200, ms: 38, ref: '3pR143eJFUFqhZZSZPFW', note: 'menunggu pembayaran' });
log.request({ method: 'GET', path: '/check-status/SW-39088744', status: 200, ms: 9, ref: 'SW-39088744', note: 'PENDING' });
log.request({ method: 'POST', path: '/admin/refund/approve', status: 409, ms: 12, ref: 'SW-43866590', note: 'Pesanan berstatus AKTIF, tidak bisa menyetujui refund' });
log.request({ method: 'POST', path: '/create-va', status: 500, ms: 180, ref: 'SW-11223344', note: 'Gagal membuat VA: Midtrans API is returning API error. HTTP status code: 500' });
log.request({ method: 'POST', path: '/rute-ngawur', status: 404, ms: 2, ref: '', note: '' });

log.warn('[SECURITY] harga tidak cocok pada pesanan SW-11223344');
log.err('contoh baris error startup');

// Pratinjau bagian tunnel, diambil dari start_tunnel.js.
log.judul('SOUNDWAVE · server + tunnel');
log.info('memeriksa server di port 3000…');
log.ok('server sudah aktif (port 3000)');
log.info('menghubungkan tunnel Cloudflare…');
log.ok('tunnel aktif  ·  https://extreme-endorsement-send-lion.trycloudflare.com');
log.info('URL disimpan ke Firebase (events/_backend_config)');
log.info('HP dengan kuota data apa pun sudah bisa order tiket');
log.warn('jangan tutup jendela ini selama backend dipakai');

log.startHeartbeat(300);
setTimeout(() => {
  log.shutdown('SIGINT');
  process.exit(0);
}, 800);
