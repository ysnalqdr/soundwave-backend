'use strict';
/**
 * token_uji.js — pembuat ID token untuk skrip uji.
 *
 * Sejak rute pengguna dan rute admin dijaga token, skrip uji tidak bisa lagi
 * memanggil backend begitu saja. Modul ini membuat custom token lewat Admin
 * SDK, lalu menukarnya jadi ID token lewat Identity Toolkit.
 *
 * Butuh FIREBASE_WEB_API_KEY di .env. Kunci ini bukan rahasia (memang ikut
 * di APK), tapi tetap harus diisi supaya skrip bisa jalan.
 */
require('dotenv').config({ quiet: true });
const admin = require('firebase-admin');

const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || '';

function pastikanApp() {
  try {
    return admin.app();
  } catch (_) {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } else {
      credential = admin.credential.applicationDefault();
    }
    return admin.initializeApp({ credential });
  }
}

/**
 * Tukar custom token jadi ID token untuk uid tertentu.
 * @param {string} uid
 * @returns {Promise<string|null>} ID token, atau null kalau kunci web kosong
 */
async function ambilToken(uid) {
  if (!WEB_API_KEY) return null;
  pastikanApp();

  const custom = await admin.auth().createCustomToken(uid);
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + WEB_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  const json = await res.json();
  return json.idToken || null;
}

/** ID token untuk user pertama yang ber-role admin. */
async function ambilTokenAdmin() {
  if (!WEB_API_KEY) return null;
  pastikanApp();
  const snap = await admin
    .firestore()
    .collection('users')
    .where('role', '==', 'admin')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return ambilToken(snap.docs[0].id);
}

/** Pesan seragam saat kunci web belum diisi. */
function pesanLewati(namaSkrip) {
  console.log(
    `LEWATI: ${namaSkrip} butuh FIREBASE_WEB_API_KEY di .env. ` +
      'Ambil dari Firebase Console, Project settings, bagian Web API Key.',
  );
}

module.exports = { ambilToken, ambilTokenAdmin, pesanLewati, WEB_API_KEY };
