# SoundWave Backend

Backend Express yang memegang semua keputusan uang di aplikasi SoundWave: memotong stok, membuat tagihan Midtrans, menerima webhook pembayaran, menerbitkan tiket bertanda tangan, dan menerima hasil pindai gerbang.

Aplikasi Flutter membaca Firestore langsung untuk tampilan. Semua yang menyangkut harga, stok, dan status pesanan lewat sini. Server key Midtrans dan service account Firebase hanya ada di proses ini, tidak pernah di APK.

Cloud Functions tidak dipakai karena project berjalan di Firebase Spark. Backend kecil di laptop ditambah Cloudflare Quick Tunnel memberi hasil yang sama dengan biaya Rp 0.

Aplikasi kliennya ada di [ysnalqdr/SoundWave](https://github.com/ysnalqdr/SoundWave).

## English Summary

Express backend for the SoundWave concert ticketing app. It owns stock deduction, Midtrans charges, webhook verification, ticket signing, and gate scan sync. The Flutter client reads Firestore directly for display but never writes anything money related. Runs on a laptop behind a Cloudflare Quick Tunnel, so the whole stack costs nothing.

23 routes, 20 pricing unit tests, and a static security audit. Every user route requires a Firebase ID token; every `/admin/*` route additionally requires an `admin` or `super_admin` role read from `users/{uid}`.

---

## Daftar Isi

- [Peran di Sistem](#peran-di-sistem)
- [Prasyarat](#prasyarat)
- [Cara Memakai: Dari Nol Sampai Jalan](#cara-memakai-dari-nol-sampai-jalan)
- [Menyiapkan Midtrans Sandbox](#menyiapkan-midtrans-sandbox)
- [Menyiapkan Kunci Tanda Tangan Tiket](#menyiapkan-kunci-tanda-tangan-tiket)
- [Menjalankan Server](#menjalankan-server)
- [Menghubungkan Aplikasi Flutter](#menghubungkan-aplikasi-flutter)
- [Mencoba Endpoint dengan curl](#mencoba-endpoint-dengan-curl)
- [Daftar Endpoint](#daftar-endpoint)
- [Perintah npm](#perintah-npm)
- [Modul](#modul)
- [Pengujian](#pengujian)
- [Pemecahan Masalah](#pemecahan-masalah)
- [Keamanan](#keamanan)
- [Batasan yang Diketahui](#batasan-yang-diketahui)
- [Lisensi](#lisensi)

---

## Peran di Sistem

| Bagian | Tanggung jawab |
|---|---|
| APK Flutter | Menampilkan data dan mengirim niat beli. Tidak memutuskan harga atau stok |
| Backend ini | Satu-satunya pemegang server key Midtrans dan service account Firebase |
| Firestore | Sumber kebenaran stok, harga, dan status pesanan |
| Midtrans Sandbox | Membuat tagihan dan mengirim notifikasi pembayaran |

Backend ini **tidak** menyimpan data sendiri. Semua keadaan ada di Firestore; server hanya memutuskan boleh atau tidaknya sebuah perubahan.

---

## Prasyarat

| Kebutuhan | Keterangan |
|---|---|
| Node.js | 18 atau lebih baru (`package.json` menetapkan `>=18`) |
| npm | Ikut terpasang bersama Node.js |
| Akun Midtrans Sandbox | Untuk server key dan client key |
| Service account Firebase | JSON dari project Firebase yang sama dengan aplikasi |
| `cloudflared.exe` | Hanya untuk mode tunnel. Unduh dari [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), taruh di folder ini |

Cek versi Node sebelum mulai:

```bash
node --version     # harus v18 atau lebih
```

---

## Cara Memakai: Dari Nol Sampai Jalan

Bagian ini urut dari repo yang baru di-clone sampai server menjawab permintaan. Ikuti berurutan.

### Langkah 1 — Ambil kode dan pasang dependency

```bash
git clone https://github.com/ysnalqdr/soundwave-backend.git
cd soundwave-backend
npm install
```

`npm install` mengunduh `express`, `firebase-admin`, `midtrans-client`, `dotenv`, dan `cors`.

### Langkah 2 — Buat berkas `.env`

```bash
copy .env.example .env      # Windows
cp .env.example .env        # macOS / Linux
```

Berkas `.env` sudah masuk `.gitignore`, jadi isinya tidak akan ikut ter-commit. Isi nilainya mengikuti tabel di bawah.

### Langkah 3 — Unduh service account Firebase

1. Buka [Firebase Console](https://console.firebase.google.com), pilih project aplikasi SoundWave.
2. Klik ikon gerigi → **Project settings** → tab **Service accounts**.
3. Klik **Generate new private key**, lalu **Generate key**.
4. Simpan berkas JSON hasil unduhan ke folder ini dengan nama `serviceAccountKey.json`.
5. Pastikan `.env` berisi:

```
FIREBASE_SERVICE_ACCOUNT=./serviceAccountKey.json
```

> Berkas ini memberi akses penuh ke Firestore dan Auth. Jangan pernah di-commit, jangan dikirim lewat chat, dan jangan ditaruh di folder yang tersinkron ke cloud publik.

### Langkah 4 — Isi kunci Midtrans

Ambil dari [dashboard Sandbox](https://dashboard.sandbox.midtrans.com/settings/config_info):

```
MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxx
MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxxxxxx
MIDTRANS_IS_PRODUCTION=false
```

Nilai `MIDTRANS_IS_PRODUCTION` harus **persis** `false` untuk Sandbox. Kode memeriksa string `'true'`, jadi nilai lain dianggap Sandbox.

### Langkah 5 — Buat kunci tanda tangan tiket

```bash
node buat_kunci_qr.js
```

Skrip ini mencetak pasangan kunci Ed25519. Salin dua baris yang diminta ke `.env`:

```
ED25519_KEY_ID=v3
ED25519_PRIVATE_KEY_HEX=<96 karakter hex>
```

Simpan juga **kunci publik** yang dicetak, karena harus ditempel ke aplikasi Flutter (lihat [Menyiapkan Kunci Tanda Tangan Tiket](#menyiapkan-kunci-tanda-tangan-tiket)).

### Langkah 6 — Nyalakan server

```bash
npm start
```

Kalau berhasil, konsol menampilkan banner berisi port, mode Midtrans (`SANDBOX`), project Firebase, versi Node, PID, dan daftar rute. Uji dari terminal lain:

```bash
curl http://localhost:3000
```

Jawaban yang benar:

```json
{ "status": "ok", "service": "SoundWave Backend", "midtrans": "sandbox", "timestamp": "..." }
```

### Langkah 7 — Buka akses dari HP (opsional)

Supaya HP bisa menghubungi backend, alamat `localhost` tidak cukup. Jalankan:

```bash
npm run tunnel
```

Skrip ini memeriksa port 3000 lebih dulu, menyalakan server kalau belum jalan, lalu menjalankan `cloudflared.exe`. Setelah alamat `https://xxx.trycloudflare.com` muncul, alamat itu otomatis ditulis ke dua dokumen Firestore:

| Dokumen | Peran |
|---|---|
| `app_config/backend` | Lokasi utama yang dibaca aplikasi sejak Okt 2026 |
| `events/_backend_config` | Cadangan, supaya aplikasi versi lama tetap jalan |

Aplikasi membaca alamat itu saat dibuka, jadi tidak perlu build ulang APK ketika tunnel berganti alamat.

> **Penting:** alamat Quick Tunnel **berubah setiap kali** `npm run tunnel` dijalankan ulang. Karena itu penulisan ke Firestore dilakukan otomatis oleh skrip, bukan manual.

### Langkah 8 — Siapkan akun admin

Rute `/admin/*` menolak akun biasa. Untuk membuat akun pertama berperan admin, buka Firestore Console → koleksi `users` → dokumen dengan `id` sama dengan UID akun → ubah field `role` menjadi `admin` atau `super_admin`. Setelah itu akun tersebut bisa mempromosikan akun lain lewat panel admin di aplikasi.

---

## Menyiapkan Midtrans Sandbox

### Mendaftar

1. Buat akun di [dashboard.sandbox.midtrans.com](https://dashboard.sandbox.midtrans.com).
2. Setelah masuk, buka **Settings → Access Keys** untuk melihat `Server Key` dan `Client Key`.
3. Keduanya berakhiran `-server-` dan `-client-` untuk Sandbox.

### Mengatur webhook

Webhook adalah cara Midtrans memberi tahu backend bahwa pembayaran selesai. Alamatnya harus bisa diakses publik, jadi tunnel diperlukan saat pengujian lokal.

1. Jalankan `npm run tunnel` dan catat alamat `https://xxx.trycloudflare.com`.
2. Buka **Settings → Configuration**.
3. Isi **Payment Notification URL** dengan:

```
https://xxx.trycloudflare.com/midtrans-webhook
```

4. Simpan.

Kalau alamat tunnel berganti, **webhook harus diperbarui manual** di dashboard Midtrans. Ini batasan nyata dari Quick Tunnel, bukan bug.

### Melunasi pesanan tanpa uang

Di Sandbox, transaksi bisa disimulasikan:

1. Buka [dashboard.sandbox.midtrans.com](https://dashboard.sandbox.midtrans.com) → **Transactions**.
2. Cari transaksi dengan `order_id` yang sesuai.
3. Klik **Simulate Payment** dan pilih status yang diinginkan.

Backend akan menerima webhook dan mengubah pesanan menjadi `AKTIF`, lalu menerbitkan tiket bertanda tangan.

### Catatan QRIS

Jangan mengisi `qris.acquirer` pada permintaan. Sandbox menolak nilai `gpn` dengan HTTP 500. Biarkan kosong.

---

## Menyiapkan Kunci Tanda Tangan Tiket

Tiket diverifikasi **offline** di HP, tanpa bertanya ke server. Karena itu kunci publik harus ikut ditanam di aplikasi.

### Membuat pasangan kunci

```bash
node buat_kunci_qr.js
```

Keluaran skrip:

```
Pasangan kunci Ed25519 baru
──────────────────────────────────────────────────────────────
kunci publik  : <64 karakter hex>
sidik jari    : <hash>

Simpan baris berikut di .env backend (jangan di-commit):
  ED25519_KEY_ID=v3
  ED25519_PRIVATE_KEY_HEX=<96 karakter hex>
```

### Menempelkan kunci publik ke aplikasi

1. Buka repo aplikasi Flutter.
2. Cari `OfflineTicketService.publicKeyRing` di `lib/services/offline_ticket_service.dart`.
3. Tambahkan entri dengan `keyId` yang sama seperti `ED25519_KEY_ID` dan kunci publik yang baru dicetak.

Kalau `keyId` di backend dan di aplikasi berbeda, semua tiket akan ditolak scanner dengan status `INVALID`, walaupun tiketnya asli.

### Merotasi kunci

1. Jalankan `node buat_kunci_qr.js` lagi untuk pasangan baru, misalnya dengan `ED25519_KEY_ID=v4`.
2. Tambahkan kunci publik baru ke `publicKeyRing` di aplikasi dan rilis APK.
3. Baru setelah APK beredar, ganti `ED25519_KEY_ID` dan `ED25519_PRIVATE_KEY_HEX` di `.env` backend.

`publicKeyRing` sengaja berupa peta `keyId → publicKey` supaya tiket lama tetap bisa diverifikasi setelah kunci berganti.

---

## Menjalankan Server

### Mode yang tersedia

```bash
npm start          # server saja
npm run dev        # server dengan watch, restart otomatis saat berkas berubah
npm run tunnel     # server + Cloudflare Quick Tunnel
```

### Di Windows, tanpa terminal

Klik dua kali **`START_SOUNDWAVE.bat`**. Berkas ini menjalankan `node start_tunnel.js` dan menahan jendela tetap terbuka kalau terjadi galat.

### Port

Default `3000`, bisa diubah lewat `PORT` di `.env`. Server mendengarkan di `0.0.0.0`, jadi bisa diakses dari perangkat lain di jaringan lokal selain lewat tunnel.

### Menghentikan server

Tekan `Ctrl+C`. Server menangani `SIGINT` dan `SIGTERM`, menutup koneksi, lalu keluar.

Kalau port 3000 masih tertahan proses lama:

```bash
netstat -ano | findstr :3000      # Windows, catat PID di kolom terakhir
taskkill /PID <pid> /F
```

`npm run tunnel` sudah mencoba menangani ini sendiri: ia memeriksa port lebih dulu, dan hanya mematikan proses yang benar-benar `node` yang mendengarkan di port 3000. Proses lain tidak disentuh.

---

## Menghubungkan Aplikasi Flutter

Aplikasi **tidak** menyimpan alamat backend di dalam kode. Alamat dibaca dari Firestore saat aplikasi dibuka, dengan urutan:

1. `app_config/backend` → field `url`
2. `events/_backend_config` → field `url` (cadangan untuk kompatibilitas)
3. Kalau keduanya kosong atau Firestore tidak terjangkau, aplikasi menampilkan pesan server belum siap

`npm run tunnel` menulis ke kedua dokumen itu secara otomatis, jadi alur normalnya tidak perlu campur tangan manual.

### Kalau ingin mengisi manual

Buka Firestore Console, buat dokumen `app_config/backend`, lalu isi satu field:

| Field | Tipe | Isi |
|---|---|---|
| `url` | string | `https://xxx.trycloudflare.com` (tanpa garis miring di akhir) |

### Yang harus selaras antara backend dan aplikasi

| Nilai | Di backend | Di aplikasi |
|---|---|---|
| Jendela reservasi | `RESERVATION_HOLD_MINUTES` (default `5`) | `AppConstants.reservationHoldMinutes` |
| Kunci tanda tangan | `ED25519_KEY_ID` + `ED25519_PRIVATE_KEY_HEX` | `OfflineTicketService.publicKeyRing` |
| Client key Midtrans | `MIDTRANS_CLIENT_KEY` | `MIDTRANS_CLIENT_KEY` di `.env` aplikasi |

Kalau jendela reservasi berbeda, aplikasi menghitung hitung mundur dengan angka yang tidak sama dengan yang dipakai server saat menyapu pesanan kedaluwarsa.

---

## Mencoba Endpoint dengan curl

Semua rute selain `GET /` dan `/midtrans-webhook` memerlukan ID token Firebase. Contoh lengkap untuk rute yang dijaga:

```bash
# 1. Ambil ID token (butuh FIREBASE_WEB_API_KEY di .env)
node -e "require('./token_uji').ambilToken('<UID>').then(t=>console.log(t))"

# 2. Pakai token itu
curl http://localhost:3000/check-status/<orderId> \
  -H "Authorization: Bearer <ID_TOKEN>"
```

Contoh rute yang tidak butuh token:

```bash
# Health check
curl http://localhost:3000

# Cek promo (butuh token)
curl -X POST http://localhost:3000/validate-promo \
  -H "Authorization: Bearer <ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"kode":"EARLYBIRD50","idKonser":"<idKonser>","subtotal":500000}'
```

Bentuk body beberapa rute penting:

| Rute | Body wajib |
|---|---|
| `POST /checkout-atomic` | `orderId`, `ticketId`, `jumlahTiket` |
| `POST /validate-promo` | `kode`, `idKonser`, `subtotal` |
| `GET /check-status/:orderId` | — (orderId di URL) |
| `POST /settle-dev` | `orderId` |

---

## Daftar Endpoint

Ada **23 rute**. Kolom "Penjaga" menunjukkan siapa yang boleh memanggil.

| Kelompok | Rute | Penjaga | Fungsi |
|---|---|---|---|
| Dasar | `GET /` | publik | Daftar rute dan status server |
| Checkout | `POST /checkout-atomic` | pengguna | Potong stok dan tulis pesanan `RESERVED` dalam satu transaksi |
| | `POST /validate-promo` | pengguna | Periksa kode promo dan hitung potongan di server |
| | `GET /check-status/:orderId` | pengguna | Status pesanan untuk layar pembayaran |
| | `GET /invoice/:orderId` | pengguna | Halaman invoice yang bisa dibuka di browser |
| Pembayaran | `POST /create-transaction` | pengguna | Transaksi Midtrans Snap |
| | `POST /create-va` | pengguna | Virtual account |
| | `POST /create-qris` | pengguna | QRIS |
| | `POST /create-gopay` | pengguna | GoPay |
| | `POST /midtrans-webhook` | signature SHA512 | Notifikasi pembayaran dari Midtrans |
| | `POST /poll-payment` | pengguna | Tanya status langsung ke Midtrans bila webhook terlambat |
| | `POST /sweep-expired` | pengguna | Lepas stok pesanan yang lewat 5 menit |
| | `POST /settle-dev` | pengguna | Tandai lunas di lingkungan pengembangan (ditolak `403` bila production) |
| Refund | `POST /request-refund` | pengguna | Pengajuan refund dari pengguna |
| | `POST /approve-refund` | admin | Setujui refund (alias kompatibilitas aplikasi lama) |
| | `POST /reject-refund` | admin | Tolak refund (alias kompatibilitas aplikasi lama) |
| | `GET /admin/refunds` | admin | Daftar pengajuan untuk admin |
| | `POST /admin/refund/approve` | admin | Persetujuan dari panel admin |
| | `POST /admin/refund/reject` | admin | Penolakan dari panel admin |
| Promo | `GET /admin/promos` | admin | Daftar kode promo |
| | `POST /admin/promo` | admin | Tambah atau ubah kode promo |
| | `DELETE /admin/promo/:id` | admin | Hapus kode promo |
| Gerbang | `POST /sync-offline-scans` | pengguna | Unggah hasil pindai offline saat perangkat kembali online |

**Penjaga yang dipakai:**

| Penjaga | Arti |
|---|---|
| `publik` | Tanpa token |
| `pengguna` | Header `Authorization: Bearer <ID token Firebase>` yang sah |
| `admin` | Token sah **dan** `role` di `users/{uid}` bernilai `admin` atau `super_admin` |
| `signature SHA512` | Bukan token, melainkan tanda tangan notifikasi Midtrans |

Identitas pemanggil selalu diambil dari token, **bukan** dari `userId` di body. Pesanan hanya bisa dilihat, dilunasi, atau direfund oleh pemiliknya.

### Kode status yang sering muncul

| Kode | Arti | Muncul di |
|---|---|---|
| `200` | Berhasil | semua rute |
| `400` | Field wajib tidak lengkap | rute dengan body |
| `401` | Token tidak ada, tidak sah, atau kedaluwarsa | rute `pengguna` dan `admin` |
| `403` | Token sah tapi peran bukan admin; atau signature webhook salah; atau `settle-dev` dipanggil di production | `admin`, `/midtrans-webhook`, `/settle-dev` |
| `404` | Pesanan atau rute tidak ditemukan | `check-status`, `invoice`, rute tak dikenal |
| `409` | Balapan stok: `revisionCounter` sudah berubah | `/checkout-atomic` |
| `429` | Kena pembatas laju | rute admin, transaksi, webhook |
| `500` | Galat tak terduga di server | semua rute |

---

## Perintah npm

| Perintah | Yang dijalankan | Kapan dipakai |
|---|---|---|
| `npm start` | `node server.js` | Menjalankan server untuk dipakai |
| `npm run dev` | `node --watch server.js` | Saat mengembangkan, server restart otomatis |
| `npm run tunnel` | `node start_tunnel.js` | Saat HP perlu menghubungi backend |

Tidak ada build step. Berkas `.js` dijalankan apa adanya.

---

## Modul

| Berkas | Isi |
|---|---|
| `server.js` | Rute, transaksi stok, verifikasi webhook, tanda tangan tiket Ed25519 |
| `perhitungan_harga.js` | Satu sumber rumus harga: subtotal, diskon, pajak 10%, biaya layanan 5% + Rp 5.000 |
| `auth_admin.js` | Penjaga rute `/admin/*`: verifikasi ID token, lalu cek peran di `users/{uid}` |
| `keamanan_http.js` | Header keamanan dan pembatas laju per IP. Tanpa dependency |
| `token_uji.js` | Pembuat ID token untuk skrip uji, karena rute kini butuh login |
| `logger.js` | Tampilan konsol. Tanpa dependency, warna mati otomatis saat output masuk berkas |
| `notifikasi.js` | Satu jalur untuk inbox Firestore dan push FCM |
| `pengumuman.js` | Pengumuman manual ke pengguna |
| `start_tunnel.js` | Nyalakan server, buka tunnel, simpan alamat publik ke Firestore |
| `buat_kunci_qr.js` | Buat pasangan kunci Ed25519 untuk tanda tangan QR tiket |
| `reconcile_refund_orders.js` | Perbaiki pesanan yang statusnya tidak sinkron setelah refund |
| `diag_qris.js` | Periksa konfigurasi QRIS tanpa membuat transaksi sungguhan |
| `preview_tampilan.js` | Pratinjau tampilan konsol tanpa menjalankan server |

### Mengirim pengumuman

```bash
node pengumuman.js                                  # interaktif
node pengumuman.js "Judul" "Isi pesan"              # ke semua user
node pengumuman.js "Judul" "Isi" --uid=<UID>        # ke satu user
node pengumuman.js "Judul" "Isi" --email=<email>    # ke satu user
node pengumuman.js --help                           # bantuan lengkap
```

Di Windows bisa juga lewat `PENGUMUMAN.bat` yang menyediakan menu.

---

## Pengujian

Bukan jest. Skrip manual yang dijalankan satu per satu, masing-masing mencetak hasil lalu keluar.

### Uji yang tidak butuh Firebase

```bash
node test_perhitungan_harga.js
```

Menguji rumus harga secara murni: subtotal, diskon persen dan nominal, pajak, biaya layanan, pembulatan, serta normalisasi kosakata lama (`persen`/`nominal` ↔ `percentage`/`fixed`). **20 kasus, 0 gagal.**

### Uji yang butuh Firebase dan token

```bash
node test_sweep_reservasi.js    # stok dilepas setelah 5 menit
node test_sweep_otomatis.js     # penyapu berjalan sendiri, bukan hanya endpoint
node test_settle_stok.js        # potong dan lepas stok tidak pernah dobel
node test_refund_flow.js        # pengajuan sampai keputusan admin
node test_notifikasi.js         # inbox Firestore
node test_push.js               # push FCM
```

Semuanya butuh `FIREBASE_WEB_API_KEY` di `.env` karena rutenya dijaga token. Ambil dari Firebase Console → **Project settings** → **Web API Key**.

`test_refund_flow.js` menguji rute `/admin/*`, jadi butuh dua hal: `FIREBASE_WEB_API_KEY` terisi **dan** minimal satu user ber-role `admin`. Tanpa keduanya skrip berhenti dengan pesan `LEWATI`, bukan gagal.

### Audit keamanan

```bash
node uji_keamanan.js                              # audit statis
node uji_keamanan.js --live http://localhost:3000 # tembak payload ke backend
```

Memeriksa kredensial tertanam, rute tanpa penjaga, dan pola injeksi. Jalankan sebelum setiap rilis.

### Pratinjau tampilan konsol

```bash
node preview_tampilan.js                # tanpa warna bila output bukan terminal
FORCE_COLOR=1 node preview_tampilan.js  # paksa warna
```

---

## Pemecahan Masalah

| Gejala | Sebab | Solusi |
|---|---|---|
| `Cannot find module 'firebase-admin'` | Dependency belum dipasang | `npm install` |
| Server mati dengan pesan service account | `serviceAccountKey.json` tidak ada atau path salah | Periksa `FIREBASE_SERVICE_ACCOUNT` di `.env` |
| `EADDRINUSE :3000` | Port dipakai proses lain | `taskkill /PID <pid> /F`, atau ubah `PORT` |
| Aplikasi menampilkan "server belum siap" | Dokumen `app_config/backend` kosong atau tunnel mati | Jalankan `npm run tunnel`, pastikan field `url` terisi |
| Tunnel jalan tapi webhook tidak masuk | URL notifikasi di dashboard Midtrans masih alamat lama | Perbarui **Payment Notification URL** setiap tunnel berganti |
| Scanner menolak semua tiket (`INVALID`) | `ED25519_KEY_ID` backend tidak ada di `publicKeyRing` aplikasi | Samakan `keyId`, tempel kunci publik yang benar, rilis ulang APK |
| Rute `/admin/*` menjawab `401` | Token tidak dikirim, kedaluwarsa, atau `role` bukan admin | Kirim header `Authorization: Bearer …`, cek `users/{uid}.role` |
| Rute `/admin/*` menjawab `403` | Token sah tapi perannya bukan `admin`/`super_admin` | Ubah `role` di Firestore |
| `settle-dev` menjawab `403` | `MIDTRANS_IS_PRODUCTION=true` | Set `false` untuk Sandbox |
| QRIS gagal dengan HTTP 500 | Field `qris.acquirer` terisi | Kosongkan field itu |
| Skrip uji mencetak `LEWATI` | `FIREBASE_WEB_API_KEY` kosong | Isi di `.env` |
| Semua permintaan tampak dari `127.0.0.1` | Proxy tidak dipercaya | Sudah ditangani: `app.set('trust proxy', true)` |
| `cloudflared.exe` tidak ditemukan | Berkas belum diunduh | Unduh dari Cloudflare, taruh di folder ini |

### Melihat log

Server menulis log ke konsol. Untuk menyimpan ke berkas:

```bash
npm start > backend.log 2>&1     # macOS / Linux
npm start > backend.log 2>&1     # Windows PowerShell
```

`LOG_VERBOSE=1` di `.env` menaikkan tingkat detail log. Berkas `*.log` sudah masuk `.gitignore`.

---

## Keamanan

| Area | Penanganan |
|---|---|
| Rahasia | `.env`, `serviceAccountKey.json`, `cloudflared.exe`, `config.yml`, dan `*.log` masuk `.gitignore` |
| Webhook | Signature SHA512 diverifikasi sebelum status pesanan diubah, dibandingkan dengan `timingSafeEqual`. Tanda tangan salah dijawab `403` |
| Rute pengguna | `wajibPengguna`: ID token Firebase wajib sah |
| Rute admin | `wajibAdmin`: token sah **dan** `role` di `users/{uid}` bernilai `admin` atau `super_admin` |
| Identitas | Diambil dari token, bukan dari `userId` di body |
| Tiket | Ditandatangani Ed25519, diverifikasi di HP tanpa bertanya ke server |
| Kunci privat | Hanya ada di `.env`. Repo ini tidak menyimpan kunci apa pun |
| Body | JSON dibatasi 100 KB |
| Pembatas laju | 60/menit rute admin, 120/menit webhook, 30/menit pembuatan transaksi |
| Header | Header keamanan dipasang `keamanan_http.js` tanpa dependency tambahan |
| Akses konfigurasi | Dokumen `app_config/backend` hanya dibuka untuk pengguna yang sudah login lewat Firestore Rules |
| Audit | `uji_keamanan.js` memeriksa kredensial tertanam, rute tanpa penjaga, dan pola injeksi |

### Kalau kunci pernah bocor

Menghapus kunci dari berkas **tidak** menghapusnya dari riwayat git. Langkah yang benar:

1. Rotasi kunci di dashboard Midtrans (atau Firebase, untuk service account).
2. Perbarui `.env`.
3. Kalau kunci sempat ter-commit, bersihkan riwayat dengan `git filter-repo` atau anggap repo itu sudah publik dan rotasi adalah satu-satunya pertahanan.

---

## Batasan yang Diketahui

1. **Firestore Spark** membatasi 20.000 tulis dan 50.000 baca per hari. Cukup untuk demo, tidak untuk produksi.
2. **Quick Tunnel berganti alamat** setiap kali dijalankan ulang. Aplikasi membaca alamat terbaru dari Firestore, tapi **webhook di dashboard Midtrans harus diperbarui manual**.
3. **Satu instance, tanpa antrean.** Cukup untuk demo, bukan untuk lonjakan penjualan.
4. **Pembatas laju disimpan di memori.** Kalau proses restart, hitungannya kembali dari nol. Beberapa instance tidak berbagi hitungan.
5. **Belum ada rekonsiliasi otomatis.** `reconcile_refund_orders.js` masih dijalankan manual.
6. **Sandbox, bukan uang nyata.** Tidak ada settlement dan tidak ada rekonsiliasi bank.
7. **`cloudflared.exe` tidak ikut repo** karena ukurannya sekitar 55 MB. Harus diunduh sendiri.

---

## Lisensi

MIT. Lihat [LICENSE](LICENSE).
