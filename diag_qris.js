// Diagnosa QRIS Midtrans Sandbox: uji beberapa variasi payload untuk menemukan
// penyebab error HTTP 500 "Sorry. Our system is recovering from unexpected issues."
//
// Jalankan: node diag_qris.js
const path = require('path');
const fs = require('fs');
const midtransClient = require('midtrans-client');

// muat .env
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !line.startsWith('#')) {
      process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
    }
  });
}

const serverKey = process.env.MIDTRANS_SERVER_KEY;
const clientKey = process.env.MIDTRANS_CLIENT_KEY;
const isProduction = String(process.env.MIDTRANS_IS_PRODUCTION || 'false') === 'true';

console.log(`Mode: ${isProduction ? 'PRODUCTION' : 'SANDBOX'}`);
console.log(`Server key prefix: ${(serverKey || '').slice(0, 12)}... (len=${(serverKey || '').length})`);
console.log(`Client key prefix: ${(clientKey || '').slice(0, 12)}...`);
console.log('');

const core = new midtransClient.CoreApi({ isProduction, serverKey, clientKey });

const uniq = () => 'DIAG-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

const base = (orderId) => ({
  payment_type: 'qris',
  transaction_details: { order_id: orderId, gross_amount: 6000 },
  customer_details: {
    first_name: 'Diag',
    email: 'diag@soundwave.id',
    phone: '08123456789',
  },
});

const variants = [
  ['V1: persis kode sekarang (acquirer=gpn, expiry unit=minute duration=5)', (id) => ({
    ...base(id), qris: { acquirer: 'gpn' }, expiry: { unit: 'minute', duration: 5 },
  })],
  ['V2: tanpa acquirer, tanpa expiry', (id) => ({ ...base(id) })],
  ['V3: acquirer=gopay, expiry unit=minutes', (id) => ({
    ...base(id), qris: { acquirer: 'gopay' }, expiry: { unit: 'minutes', duration: 5 },
  })],
  ['V4: acquirer=gpn, tanpa expiry', (id) => ({ ...base(id), qris: { acquirer: 'gpn' } })],
  ['V5: tanpa acquirer, expiry unit=minute', (id) => ({
    ...base(id), expiry: { unit: 'minute', duration: 5 },
  })],
  ['V6: acquirer=gpn, expiry unit=minutes', (id) => ({
    ...base(id), qris: { acquirer: 'gpn' }, expiry: { unit: 'minutes', duration: 5 },
  })],
  ['V7: gross_amount 1000 (min kecil)', (id) => ({
    payment_type: 'qris',
    transaction_details: { order_id: id, gross_amount: 1000 },
    customer_details: { first_name: 'Diag', email: 'diag@soundwave.id', phone: '08123456789' },
  })],
];

(async () => {
  for (const [label, build] of variants) {
    const id = uniq();
    try {
      const resp = await core.charge(build(id));
      const hasQr = !!(resp.qr_string || resp.qrcode_string);
      console.log(`[OK]   ${label}`);
      console.log(`       order_id=${id} status=${resp.transaction_status} qr_string=${hasQr ? 'ADA' : 'TIDAK ADA'} keys=${Object.keys(resp).join(',')}`);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const http = e && (e.httpStatusCode || e.ApiResponse || e.code);
      console.log(`[FAIL] ${label}`);
      console.log(`       order_id=${id}`);
      console.log(`       -> ${msg.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (e && e.ApiResponse) {
        console.log(`       ApiResponse: ${JSON.stringify(e.ApiResponse).slice(0, 400)}`);
      }
    }
    console.log('');
  }
})();
