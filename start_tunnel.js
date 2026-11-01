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
  let server = null;

  // ---------------------------------------------------------------
  // Bersihkan server lama sebelum memulai.
  //
  // Tanpa ini, menjalankan START_SOUNDWAVE.bat dua kali menghasilkan
  // jendela yang terlihat "mati": skrip mendeteksi port 3000 sudah
  // terpakai, melewati spawn, sehingga TIDAK ada banner dan TIDAK ada log
  // request — padahal servernya hidup di jendela/jendela lama. Semua
  // aktivitas login dan pembayaran muncul di sana, bukan di sini.
  //
  // Yang dimatikan hanya proses `node server.js` milik proyek ini. Proses
  // lain yang kebetulan memakai port 3000 tidak disentuh.
  async function bebaskanPort() {
    const pid = await new Promise((resolve) => {
      const { exec } = require('child_process');
      exec('netstat -ano -p tcp', (err, out) => {
        if (err || !out) return resolve(null);
        const semua = out.split(String.fromCharCode(10));
        const baris = semua.find(
          (b) => b.includes(':3000') && b.includes('LISTENING'),
        );
        if (!baris) return resolve(null);
        const bagian = baris.trim().split(/\s+/);
        resolve(bagian[bagian.length - 1] || null);
      });
    });
    if (!pid) return;

    const cmd = await new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter ' +
          '\\"ProcessId=' + pid + '\\").CommandLine"',
        (err, out) => resolve(err ? '' : String(out || '')),
      );
    });

    if (!cmd.includes('server.js')) {
      log.warn(`port 3000 dipakai proses lain (PID ${pid}) — tidak disentuh`);
      return;
    }

    log.warn(`server lama masih jalan (PID ${pid}) — dimatikan dulu`);
    await new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(`taskkill /PID ${pid} /F`, () => resolve());
    });
    // Beri waktu OS melepas port.
    await new Promise((r) => setTimeout(r, 1200));
  }

  await bebaskanPort();

  const isRunning = await checkServerRunning();
  if (!isRunning) {
    server = spawn('node', ['server.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: true
    });
    server.on('error', (err) => log.err('gagal menjalankan server: ' + err.message));
    log.ok('server dijalankan (port 3000)');
  } else {
    log.warn('port 3000 masih dipakai proses lain');
    log.warn('log request TIDAK akan muncul di jendela ini.');
    log.info('tutup proses itu dulu:  taskkill /PID <pid> /F');
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
      // Simpan ke DUA lokasi.
      //
      // `app_config/backend` adalah lokasi yang dibaca aplikasi sejak Okt
      // 2026. `events/_backend_config` tetap ditulis sebagai cadangan supaya
      // APK versi lama (yang belum tahu lokasi baru) masih bisa dipakai.
      //
      // Sebelumnya skrip ini HANYA menulis ke lokasi lama. Karena URL tunnel
      // Cloudflare berubah setiap kali dijalankan, `app_config/backend`
      // menyimpan URL BASI — dan aplikasi mendahulukan lokasi itu, sehingga
      // mencoba menghubungi tunnel yang sudah mati. Itu penyebab "server
      // pembayaran tidak bisa dihubungi" padahal backend hidup.
      const data = {
        url: tunnelUrl,
        updatedAt: new Date().toISOString()
      };
      await db.collection('app_config').doc('backend').set(data, { merge: true });
      await db.collection('events').doc('_backend_config').set(data, { merge: true });
      log.info('URL disimpan ke Firebase (app_config/backend + events/_backend_config)');
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
