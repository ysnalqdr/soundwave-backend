const { spawn } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');
const log = require('./logger');

// Baca .env jika ada
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !line.startsWith('#')) {
      process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '');
    }
  });
}

// 1. Init Firebase Admin
try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else {
    credential = admin.credential.cert(require('./serviceAccountKey.json'));
  }
  admin.initializeApp({ credential });
} catch (e) {
  log.err('Firebase gagal init: ' + e.message);
}

const db = admin.firestore();

log.judul('SOUNDWAVE · server + tunnel');
log.info('memeriksa server di port 3000…');

// 2. Jalankan Node Server jika belum aktif
const http = require('http');

function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3000', (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

(async () => {
  const isRunning = await checkServerRunning();
  let server = null;
  if (!isRunning) {
    server = spawn('node', ['server.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true
    });
    server.on('error', (err) => log.err('gagal menjalankan server: ' + err.message));
    log.ok('server dijalankan (port 3000)');
  } else {
    log.ok('server sudah aktif (port 3000)');
  }

  // 3. Jalankan Cloudflare Tunnel
  log.info('menghubungkan tunnel Cloudflare…');
  const cfPath = path.resolve(__dirname, 'cloudflared.exe');
  const cf = spawn(cfPath, ['tunnel', '--url', 'http://localhost:3000'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

let foundUrl = false;

async function onTunnelOutput(chunk) {
  const text = chunk.toString();
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match && !foundUrl) {
    foundUrl = true;
    const tunnelUrl = match[0];
    log.ok('tunnel aktif  ·  ' + tunnelUrl);

    try {
      await db.collection('events').doc('_backend_config').set({
        url: tunnelUrl,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      log.info('URL disimpan ke Firebase (events/_backend_config)');
      log.info('HP dengan kuota data apa pun sudah bisa order tiket');
    } catch (e) {
      log.err('gagal simpan URL ke Firebase: ' + e.message);
    }
    log.warn('jangan tutup jendela ini selama backend dipakai');
  }
}

cf.stderr.on('data', onTunnelOutput);
cf.stdout.on('data', onTunnelOutput);

cf.on('close', (code) => {
  log.warn('tunnel berhenti (kode ' + code + ')');
});

process.on('SIGINT', () => {
  if (server) server.kill();
  cf.kill();
  process.exit();
});
})();
