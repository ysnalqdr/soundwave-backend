#!/usr/bin/env node
/**
 * pengumuman.js — kirim pengumuman manual dari terminal.
 *
 * Notifikasi di app bersifat per-user: satu dokumen untuk satu orang. Jadi
 * satu pengumuman digandakan ke tiap user di koleksi `notifications` plus push
 * FCM. Karena modelnya per-user, badge belum dibaca dan tombol tandai semua di
 * app langsung bekerja tanpa logika tambahan.
 *
 * CARA PAKAI
 *   node pengumuman.js
 *       interaktif: judul, pesan, target, lalu konfirmasi.
 *
 *   node pengumuman.js "Judul" "Isi pesan"
 *       langsung ke semua user, tetap ada konfirmasi.
 *
 *   node pengumuman.js "Judul" "Isi" --uid=UID
 *   node pengumuman.js "Judul" "Isi" --email=nama@email.com
 *       hanya satu user.
 *
 *   --ya              lewati konfirmasi
 *   --dry             uji coba: hitung target saja, tidak mengirim
 *   --tanpa-push      masuk inbox saja, HP tidak bergetar
 *   --termasuk-admin  ikut kirim ke akun admin, default hanya role user
 *   --help            tampilkan bantuan
 *
 * Tulis \n di dalam pesan untuk membuat baris baru.
 * Tidak butuh server.js hidup, skrip ini bicara langsung ke Firebase.
 */
'use strict';

const readline = require('readline');
const path = require('path');
const admin = require('firebase-admin');
const log = require('./logger');
const { buatPengirim, KOLEKSI_USER } = require('./notifikasi');

const { paint, pad, padL } = log;
const LEBAR = 58;
const GARIS = '─'.repeat(LEBAR);
const ADMIN_ROLES = ['admin', 'super_admin'];

// Tampilan: satu aksen hijau, kolom sejajar.
function judulBanner(sub) {
  const isi = (t) => '│' + '  ' + pad(t, LEBAR - 4) + '  ' + '│';
  console.log('');
  console.log('╭' + GARIS + '╮');
  console.log(isi(paint.bold('PENGUMUMAN · SoundWave')));
  if (sub) console.log(isi(paint.dim(sub)));
  console.log('╰' + GARIS + '╯');
  console.log('');
}

function baris(k, v, catatan) {
  const kiri = '  ' + paint.dim(pad(k, 17));
  const kanan = catatan ? pad(String(v), 14) + paint.dim(catatan) : String(v);
  console.log(kiri + kanan);
}

function bantuan() {
  judulBanner('bantuan');
  console.log('  CARA PAKAI');
  console.log('');
  console.log('    node pengumuman.js');
  console.log('        interaktif — ditanya judul, pesan, target.');
  console.log('');
  console.log('    node pengumuman.js "Judul" "Isi pesan"');
  console.log('        kirim ke SEMUA user (role user).');
  console.log('');
  console.log('    node pengumuman.js "Judul" "Isi" --uid=UID_USER');
  console.log('    node pengumuman.js "Judul" "Isi" --email=nama@email.com');
  console.log('        kirim ke satu user saja.');
  console.log('');
  console.log('  OPSI');
  console.log('    --ya               lewati konfirmasi (untuk skrip)');
  console.log('    --dry              uji coba, tidak mengirim apa pun');
  console.log('    --tanpa-push       inbox saja, HP tidak bergetar');
  console.log('    --termasuk-admin   ikut kirim ke akun admin');
  console.log('');
  console.log('  CATATAN: tulis \\n di dalam pesan untuk baris baru.');
  console.log('');
}

// Argumen
function bacaArgumen(argv) {
  const f = { push: true, dry: false, ya: false, termasukAdmin: false, uid: null, email: null, bantuan: false };
  const posisi = [];
  for (const a of argv) {
    if (a === '--dry') f.dry = true;
    else if (a === '--ya' || a === '-y') f.ya = true;
    else if (a === '--tanpa-push') f.push = false;
    else if (a === '--termasuk-admin') f.termasukAdmin = true;
    else if (a === '--help' || a === '-h') f.bantuan = true;
    else if (a.startsWith('--uid=')) f.uid = a.slice(6).trim();
    else if (a.startsWith('--email=')) f.email = a.slice(8).trim();
    else posisi.push(a);
  }
  f.judul = (posisi[0] || '').trim() || null;
  f.pesan = posisi.slice(1).join(' ').trim() || null;
  return f;
}

// Target
async function ambilSemuaUser(db) {
  const snap = await db.collection(KOLEKSI_USER).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

async function ambilSatuUser(db, f) {
  if (f.uid) {
    const snap = await db.collection(KOLEKSI_USER).doc(f.uid).get();
    if (!snap.exists) throw new Error('UID tidak ditemukan: ' + f.uid);
    return [Object.assign({ id: snap.id }, snap.data())];
  }
  const q = await db.collection(KOLEKSI_USER).where('email', '==', f.email).limit(1).get();
  if (q.empty) throw new Error('Email tidak ditemukan: ' + f.email);
  const d = q.docs[0];
  return [Object.assign({ id: d.id }, d.data())];
}

async function tentukanTarget(db, f) {
  if (f.uid || f.email) return ambilSatuUser(db, f);
  const semua = await ambilSemuaUser(db);
  if (f.termasukAdmin) return semua;
  // default: hanya user biasa (admin tidak perlu pengumuman promosi)
  return semua.filter((u) => !ADMIN_ROLES.includes(u.role || 'user'));
}

const labelUser = (u) => u.email || u.nama || u.name || u.id;

// Interaktif
function tanya(rl, label) {
  return new Promise((resolve) => rl.question(label, (a) => resolve(String(a || '').trim())));
}

async function modeInteraktif(f, jumlahUser) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('  ' + paint.dim('Kosongkan lalu Enter untuk batal.'));
    console.log('');

    f.judul = (await tanya(rl, '  ' + paint.dim(pad('Judul', 10)) + '  ')) || null;
    if (!f.judul) return f;
    f.pesan = (await tanya(rl, '  ' + paint.dim(pad('Pesan', 10)) + '  ')) || null;
    if (!f.pesan) return f;

    console.log('');
    console.log('  ' + paint.dim(pad('Target', 10)) + '  [1] Semua user (' + jumlahUser + ')');
    console.log('  ' + ' '.repeat(12) + '  [2] Satu user (UID atau email)');
    const pilih = (await tanya(rl, '  ' + paint.dim(pad('Pilih', 10)) + '  ')) || '1';

    if (pilih === '2') {
      const kunci = await tanya(rl, '  ' + paint.dim(pad('UID/email', 10)) + '  ');
      if (kunci) {
        if (kunci.includes('@')) f.email = kunci;
        else f.uid = kunci;
      }
    }
    return f;
  } finally {
    rl.close();
  }
}

async function konfirmasi(f, target, db) {
  console.log('');
  console.log('  ' + GARIS);
  baris('JUDUL', f.judul);
  baris('PESAN', f.pesan.length > 42 ? f.pesan.slice(0, 41) + '…' : f.pesan);
  baris('PENERIMA', target.length + ' user');
  baris('PUSH FCM', f.push ? paint.green('ya') : paint.dim('tidak'));
  if (target.length === 1) baris('  →', labelUser(target[0]));
  console.log('  ' + GARIS);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const j = await tanya(rl, '  Kirim sekarang? (y/n) ');
    return j.toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

// Pengiriman
const UKURAN_BAGIAN = 20; // kirim 20 user paralel sekali jalan

async function sebar(pengirim, target, f) {
  const hasil = { inbox: 0, push: 0, tanpaToken: 0, gagal: 0 };
  const mulai = Date.now();
  const pesan = f.pesan.replace(/\\n/g, '\n');

  for (let i = 0; i < target.length; i += UKURAN_BAGIAN) {
    const bagian = target.slice(i, i + UKURAN_BAGIAN);
    await Promise.all(bagian.map(async (u) => {
      const tersimpan = await pengirim.kirimNotifikasi(u.id, {
        title: f.judul,
        message: pesan,
        type: 'pengumuman',
        refId: null,
        push: false, // push ditangani terpisah supaya hasilnya bisa dihitung
        sumber: 'PENGUMUMAN_MANUAL',
      });
      if (tersimpan) hasil.inbox++;
      else hasil.gagal++;

      if (f.push && tersimpan) {
        const st = await pengirim.kirimPush(u.id, { title: f.judul, message: pesan, type: 'pengumuman' });
        if (st === 'terkirim') hasil.push++;
        else if (st === 'tanpa_token') hasil.tanpaToken++;
        else hasil.gagal++;
      }
    }));

    const sudah = Math.min(i + UKURAN_BAGIAN, target.length);
    process.stdout.write('\r  ' + paint.dim('mengirim') + '  ' + padL(sudah + '/' + target.length, 9));
  }
  process.stdout.write('\r' + ' '.repeat(34) + '\r');
  hasil.durasi = ((Date.now() - mulai) / 1000).toFixed(1).replace('.', ',') + 's';
  return hasil;
}

function ringkasan(hasil, jumlahTarget, push) {
  console.log('  ' + GARIS);
  console.log('  ' + paint.bold('RINGKASAN'));
  console.log('  ' + GARIS);
  baris('TARGET', jumlahTarget + ' user');
  baris('INBOX TERSIMPAN', paint.green(hasil.inbox));
  if (push) {
    baris('PUSH TERKIRIM', paint.green(hasil.push));
    baris('TANPA TOKEN HP', paint.dim(hasil.tanpaToken), ' belum pernah login di device');
  }
  baris('GAGAL', hasil.gagal > 0 ? paint.red(hasil.gagal) : paint.dim(0));
  console.log('  ' + GARIS);
  console.log('  ' + paint.dim('selesai dalam ' + hasil.durasi));
  console.log('');
}

// Alur utama
async function main() {
  const f = bacaArgumen(process.argv.slice(2));
  if (f.bantuan) return bantuan();

  // Kredensial Firebase, caranya sama seperti server.js.
  try { require('dotenv').config({ quiet: true }); } catch (_) { /* opsional */ }
  try {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } else {
      const p = process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccountKey.json';
      const resolved = path.isAbsolute(p) ? p : path.resolve(__dirname, p);
      credential = admin.credential.cert(require(resolved));
    }
    admin.initializeApp({ credential });
  } catch (e) {
    judulBanner();
    log.err('Firebase gagal init: ' + e.message);
    log.info('  Butuh serviceAccountKey.json di folder ini (Firebase Console → Project Settings → Service Accounts)');
    process.exitCode = 1;
    return;
  }

  const db = admin.firestore();
  // log.info di-mute: jangan cetak 1 baris per user saat fan-out.
  const pengirim = buatPengirim({ db, messaging: admin.messaging(), log: { info: () => {}, warn: log.warn } });

  const interaktif = !f.judul || !f.pesan;
  if (interaktif) {
    const semua = await ambilSemuaUser(db);
    judulBanner('ketik pengumuman yang mau dikirim ke user');
    await modeInteraktif(f, semua.length);
  }

  if (!f.judul || !f.pesan) {
    if (!interaktif) judulBanner();
    log.warn('dibatalkan — judul dan pesan wajib diisi');
    log.info('  contoh: node pengumuman.js "Promo Akhir Pekan" "Diskon 30% tiket Sabtu"');
    return;
  }

  if (!interaktif) judulBanner('mode satu baris perintah');

  // Target
  let target;
  try {
    target = await tentukanTarget(db, f);
  } catch (e) {
    log.err(e.message);
    process.exitCode = 1;
    return;
  }

  if (target.length === 0) {
    log.warn('tidak ada user yang cocok dengan target');
    return;
  }

  // Uji coba
  if (f.dry) {
    console.log('  ' + paint.dim('MODE UJI COBA (--dry) — tidak ada yang dikirim'));
    console.log('');
    baris('TARGET', target.length + ' user');
    baris('PUSH FCM', f.push ? paint.green('ya') : paint.dim('tidak'));
    console.log('');
    console.log('  ' + paint.dim('contoh 5 penerima pertama:'));
    target.slice(0, 5).forEach((u) => console.log('    ' + paint.dim('·') + ' ' + labelUser(u)));
    if (target.length > 5) console.log('    ' + paint.dim('· … dan ' + (target.length - 5) + ' lainnya'));
    console.log('');
    return;
  }

  // Konfirmasi
  if (!f.ya) {
    const setuju = await konfirmasi(f, target, db);
    if (!setuju) {
      console.log('');
      log.warn('dibatalkan oleh kamu — tidak ada yang dikirim');
      return;
    }
    console.log('');
  }

  // Kirim
  console.log('  ' + GARIS);
  const hasil = await sebar(pengirim, target, f);
  ringkasan(hasil, target.length, f.push);
}

main().catch((e) => {
  console.error('');
  log.err('gagal: ' + ((e && e.message) || e));
  process.exitCode = 1;
});
