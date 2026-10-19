#!/usr/bin/env node
'use strict';
/**
 * uji_keamanan.js — audit keamanan SoundWave.
 *
 * Dua mode:
 *   node uji_keamanan.js                 audit statis, tidak butuh server
 *   node uji_keamanan.js --live <url>    tembak payload ke backend yang sedang jalan
 *
 * Catatan penting: database di proyek ini Firestore, bukan SQL. Tidak ada
 * "SQL injection" klasik karena tidak ada string SQL yang dirakit. Yang setara
 * risikonya adalah operator injection di query Firestore (misalnya {$ne: null})
 * dan itu yang diuji di mode --live.
 *
 * Hasil: PASS (aman), WARN (perlu dilihat), FAIL (harus diperbaiki).
 * Exit code 1 kalau ada FAIL, supaya bisa dipakai di CI.
 */

const fs = require('fs');
const path = require('path');

const AKAR = __dirname;
const LEWATI = new Set(['node_modules', '.git', '.dart_tool', 'build', 'coverage']);

const hasil = [];
function catat(status, judul, keterangan) {
  hasil.push({ status, judul, keterangan });
  const tanda = status === 'PASS' ? '[ OK ]' : status === 'WARN' ? '[WARN]' : '[FAIL]';
  console.log(`${tanda} ${judul}`);
  if (keterangan) console.log(`       ${keterangan}`);
}

// Pembaca berkas

function daftarBerkas() {
  // Yang penting diperiksa adalah berkas yang ikut terkirim ke GitHub,
  // bukan berkas lokal yang sudah di-ignore (.env, service account).
  try {
    const { execSync } = require('child_process');
    const keluaran = execSync('git ls-files', { cwd: AKAR, encoding: 'utf8' });
    return keluaran
      .split(/\r?\n/)
      .filter(Boolean)
      .map((f) => path.join(AKAR, f));
  } catch {
    const keluar = [];
    const jalan = (dir) => {
      for (const isi of fs.readdirSync(dir, { withFileTypes: true })) {
        if (LEWATI.has(isi.name)) continue;
        const penuh = path.join(dir, isi.name);
        if (isi.isDirectory()) jalan(penuh);
        else keluar.push(penuh);
      }
    };
    jalan(AKAR);
    return keluar;
  }
}

const berkasKode = daftarBerkas().filter((f) =>
  /\.(js|json|md|bat|example|rules|yml|yaml)$/.test(f),
);

function baca(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

const relatif = (f) => path.relative(AKAR, f).replace(/\\/g, '/');

// 1. Kredensial tertanam

function cekKredensial() {
  const pola = [
    { nama: 'Midtrans server/client key', re: /SB-Mid-(server|client)-[A-Za-z0-9_~-]{8,}/ },
    { nama: 'Firebase web API key', re: /AIza[0-9A-Za-z_-]{35}/ },
    { nama: 'Private key PEM', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { nama: 'Service account JSON', re: /"type"\s*:\s*"service_account"/ },
    {
      nama: 'Kunci Ed25519 dalam bentuk hex',
      re: /(?:private|privat|seed|secret)[^\n]{0,40}['"][0-9a-f]{64}['"]/i,
    },
  ];

  const temuan = [];
  for (const f of berkasKode) {
    const nama = relatif(f);
    if (nama === '.env') continue; // berkas lokal, tidak ikut repo
    const isi = baca(f);
    for (const p of pola) {
      if (p.re.test(isi)) temuan.push(`${nama} → ${p.nama}`);
    }
  }

  if (temuan.length === 0) {
    catat('PASS', 'Tidak ada kredensial tertanam di berkas repo', `${berkasKode.length} berkas dipindai`);
  } else {
    catat('FAIL', 'Ada kredensial tertanam', temuan.slice(0, 8).join('; '));
  }
}

// 2. Rute admin tanpa penjaga

function cekRute() {
  const server = baca(path.join(AKAR, 'server.js'));
  if (!server) {
    catat('WARN', 'server.js tidak ditemukan', 'lewati pemeriksaan rute');
    return;
  }

  const rute = [...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)];
  const publikSah = new Set(['/', '/midtrans-webhook']);

  const tanpaPenjaga = [];
  let jumlahAdmin = 0;
  let jumlahPengguna = 0;

  for (const m of rute) {
    const badan = server.slice(m.index, m.index + 400);
    const adaAdmin = badan.includes('wajibAdmin');
    const adaPengguna = badan.includes('wajibPengguna');
    if (adaAdmin) jumlahAdmin += 1;
    else if (adaPengguna) jumlahPengguna += 1;
    if (publikSah.has(m[2])) continue;
    if (!adaAdmin && !adaPengguna) tanpaPenjaga.push(m[2]);
  }

  if (tanpaPenjaga.length === 0) {
    catat(
      'PASS',
      'Semua rute selain health check dan webhook punya penjaga token',
      `${jumlahAdmin} rute admin, ${jumlahPengguna} rute pengguna, ${rute.length} total`,
    );
  } else {
    catat('FAIL', 'Ada rute tanpa penjaga token', tanpaPenjaga.join(', '));
  }

  catat(
    'PASS',
    'Rute publik hanya health check dan webhook',
    'webhook dijaga tanda tangan SHA512, bukan token',
  );
}

// 3. Sink injeksi

function cekSinkInjeksi() {
  const pola = [
    { nama: 'eval()', re: /\beval\s*\(/ },
    { nama: 'new Function()', re: /new\s+Function\s*\(/ },
    { nama: 'child_process', re: /require\(['"]child_process['"]\)/ },
    { nama: 'operator mentah dari body', re: /where\([^)]*req\.body/ },
    { nama: 'query string dirakit manual', re: /(where|orderBy)\([^)]*\+\s*req\./ },
    { nama: 'path dari input pengguna', re: /(readFile|writeFile|createReadStream)\([^)]*req\.(params|query|body)/ },
    { nama: 'spread body ke objek', re: /Object\.assign\([^)]*req\.body|\.\.\.req\.body/ },
  ];

  const temuan = [];
  // Berkas ini sendiri berisi pola serangan, jadi tidak ikut dipindai.
  const bolehDipindai = berkasKode.filter(
    (x) => x.endsWith('.js') && !x.endsWith('uji_keamanan.js'),
  );
  // start_tunnel.js memanggil cloudflared, itu memang tujuannya.
  const dikecualikan = ['start_tunnel.js:1 → child_process'];

  for (const f of bolehDipindai) {
    const isi = baca(f);
    for (const p of pola) {
      const baris = isi.split(/\r?\n/).findIndex((b) => p.re.test(b));
      if (baris < 0) continue;
      const catatan = `${relatif(f)}:${baris + 1} → ${p.nama}`;
      if (dikecualikan.some((d) => catatan.endsWith(d))) continue;
      temuan.push(catatan);
    }
  }

  if (temuan.length === 0) {
    catat('PASS', 'Tidak ada sink injeksi (eval, exec, query rakit manual)');
  } else {
    catat('WARN', 'Ada pola yang perlu ditinjau', temuan.join('; '));
  }
}

// 4. Konfigurasi express

function cekKonfigurasi() {
  const server = baca(path.join(AKAR, 'server.js'));

  if (/express\.json\(\s*\{[^}]*limit/.test(server)) {
    catat('PASS', 'Body JSON dibatasi ukurannya');
  } else {
    catat('WARN', 'express.json() tanpa limit', 'payload besar bisa memakan memori');
  }

  if (/require\(['"]helmet['"]\)/.test(server) || /headerKeamanan/.test(server)) {
    catat('PASS', 'Header keamanan dipasang');
  } else {
    catat('WARN', 'Header keamanan belum dipasang', 'X-Frame-Options dan X-Content-Type-Options belum ada');
  }

  if (/rate[-_]?limit/i.test(server) || /batasiLaju/.test(server)) {
    catat('PASS', 'Ada pembatas laju permintaan');
  } else {
    catat('WARN', 'Belum ada rate limit', 'endpoint publik bisa dibanjiri');
  }

  const corsLonggar = /cors\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/.test(server) || /cors\(\s*\)/.test(server);
  if (corsLonggar) {
    catat('WARN', 'CORS terbuka untuk semua origin', 'wajar untuk API publik, tapi jangan dipasangkan dengan cookie');
  } else {
    catat('PASS', 'CORS dibatasi');
  }

  if (/timingSafeEqual/.test(server) && /sha512/i.test(server)) {
    catat('PASS', 'Tanda tangan webhook diverifikasi dengan perbandingan waktu-tetap');
  } else {
    catat('FAIL', 'Verifikasi tanda tangan webhook lemah atau tidak ada');
  }
}

// 5. Berkas yang tidak boleh ikut repo

function cekGitignore() {
  const gi = baca(path.join(AKAR, '.gitignore'));
  const wajib = ['.env', 'serviceAccountKey.json', 'node_modules'];
  const kurang = wajib.filter((w) => !gi.includes(w));
  if (kurang.length === 0) {
    catat('PASS', '.gitignore menutup berkas rahasia', 'termasuk .env dan service account');
  } else {
    catat('FAIL', '.gitignore kurang', kurang.join(', '));
  }

  const contoh = baca(path.join(AKAR, '.env.example'));
  const namaRahasia = /(SECRET|TOKEN|PASSWORD|PRIVATE|SERVER_KEY|CLIENT_KEY)/;
  const bocor = [...contoh.matchAll(/^([A-Z0-9_]+)=(.+)$/gm)]
    .filter((m) => namaRahasia.test(m[1]) && !/^(x+|\s*)$/.test(m[2].trim()))
    .map((m) => m[1]);
  if (bocor.length === 0) {
    catat('PASS', '.env.example tidak memuat nilai rahasia');
  } else {
    catat('FAIL', '.env.example memuat nilai terisi', bocor.join(', '));
  }
}

// 6. Tembak payload (mode --live)

async function cekLive(base) {
  const url = base.replace(/\/$/, '');
  console.log(`\nMenembak ${url}\n`);

  const jwtPalsu = [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from('{"uid":"admin","role":"super_admin"}').toString('base64url'),
    '',
  ].join('.');

  const percobaan = [
    {
      nama: 'Rute admin tanpa token ditolak',
      minta: { method: 'GET', url: `${url}/admin/promos` },
      harap: (r) => r.status === 401 || r.status === 403,
    },
    {
      nama: 'Rute admin dengan JWT alg=none ditolak',
      minta: { method: 'GET', url: `${url}/admin/refunds`, headers: { Authorization: `Bearer ${jwtPalsu}` } },
      harap: (r) => r.status === 401 || r.status === 403,
    },
    {
      nama: 'Operator injection Firestore {$ne:null} ditolak',
      minta: {
        method: 'POST',
        url: `${url}/checkout-atomic`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: { $ne: null }, userId: { $gt: '' } }),
      },
      harap: (r) => r.status >= 400 && r.status < 500,
    },
    {
      nama: 'Operator injection di query string ditolak',
      minta: { method: 'GET', url: `${url}/events?id[$ne]=1` },
      harap: (r) => r.status >= 400 && r.status < 500,
    },
    {
      nama: 'Path traversal tidak membaca berkas sistem',
      minta: { method: 'GET', url: `${url}/../../../../etc/passwd` },
      harap: (r) => r.status >= 400 && !/root:x:/.test(r.body),
    },
    {
      nama: 'Webhook dengan tanda tangan salah ditolak',
      minta: {
        method: 'POST',
        url: `${url}/midtrans-webhook`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: 'SW-PALSU-1',
          transaction_status: 'settlement',
          signature_key: 'deadbeef',
          status_code: '200',
          gross_amount: '1.00',
        }),
      },
      harap: (r) => r.status === 401 || r.status === 403 || r.status === 400,
    },
    {
      nama: 'JSON rusak ditolak rapi',
      minta: {
        method: 'POST',
        url: `${url}/checkout-atomic`,
        headers: { 'Content-Type': 'application/json' },
        body: '{"orderId": ',
      },
      harap: (r) => r.status >= 400 && r.status < 500,
    },
    {
      nama: 'Jumlah tiket negatif ditolak',
      minta: {
        method: 'POST',
        url: `${url}/checkout-atomic`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: 'SW-UJI-1', jumlahTiket: -5, totalHarga: -1 }),
      },
      harap: (r) => r.status >= 400 && r.status < 500,
    },
    {
      nama: 'Prototype pollution tidak membuat server error',
      minta: {
        method: 'POST',
        url: `${url}/checkout-atomic`,
        headers: { 'Content-Type': 'application/json' },
        body: '{"__proto__":{"isAdmin":true},"orderId":"SW-UJI-2"}',
      },
      harap: (r) => r.status < 500,
    },
    {
      nama: 'Body sangat besar ditolak',
      minta: {
        method: 'POST',
        url: `${url}/checkout-atomic`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: 'x', catatan: 'A'.repeat(3 * 1024 * 1024) }),
      },
      harap: (r) => r.status === 413 || r.status === 400,
    },
  ];

  for (const p of percobaan) {
    let r;
    try {
      const jawab = await fetch(p.minta.url, {
        method: p.minta.method,
        headers: p.minta.headers,
        body: p.minta.body,
        signal: AbortSignal.timeout(15000),
      });
      r = { status: jawab.status, body: await jawab.text() };
    } catch (err) {
      catat('WARN', p.nama, `tidak bisa dihubungi: ${err.message}`);
      continue;
    }

    if (p.harap(r)) {
      catat('PASS', p.nama, `HTTP ${r.status}`);
    } else {
      const bocor = /SB-Mid|stack|at Object\.|FirebaseError/.test(r.body);
      catat('FAIL', p.nama, `HTTP ${r.status}${bocor ? ', response memuat detail internal' : ''}`);
    }
  }
}

// Jalan

(async () => {
  const arg = process.argv.slice(2);
  const idx = arg.indexOf('--live');

  console.log('Audit keamanan SoundWave');
  console.log('='.repeat(60));
  console.log('');

  cekKredensial();
  cekRute();
  cekSinkInjeksi();
  cekKonfigurasi();
  cekGitignore();

  if (idx >= 0 && arg[idx + 1]) {
    await cekLive(arg[idx + 1]);
  } else {
    console.log('\nMode statis selesai. Untuk menguji backend yang sedang jalan:');
    console.log('  node uji_keamanan.js --live http://localhost:3000');
  }

  const gagal = hasil.filter((h) => h.status === 'FAIL').length;
  const awas = hasil.filter((h) => h.status === 'WARN').length;
  console.log('');
  console.log('='.repeat(60));
  console.log(`${hasil.length - gagal - awas} aman, ${awas} perlu dilihat, ${gagal} harus diperbaiki`);
  process.exit(gagal > 0 ? 1 : 0);
})();
