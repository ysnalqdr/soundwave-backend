# SoundWave Backend

Backend Express yang memegang semua keputusan uang di aplikasi SoundWave: memotong stok, membuat tagihan Midtrans, menerima webhook pembayaran, menerbitkan tiket bertanda tangan, dan menerima hasil pindai gerbang.

Aplikasi Flutter membaca Firestore langsung untuk tampilan. Semua yang menyangkut harga, stok, dan status pesanan lewat sini. Server key Midtrans dan service account Firebase hanya ada di proses ini, tidak pernah di APK.

Cloud Functions tidak dipakai karena project berjalan di Firebase Spark. Backend kecil di laptop ditambah Cloudflare Quick Tunnel memberi hasil yang sama dengan biaya Rp 0.

Aplikasi kliennya ada di [ysnalqdr/soundwave](https://github.com/ysnalqdr/soundwave).

## English Summary

Express backend for the SoundWave concert ticketing app. It owns stock deduction, Midtrans charges, webhook verification, ticket signing, and gate scan sync. The Flutter client reads Firestore directly for display but never writes anything money related. Runs on a laptop behind a Cloudflare Quick Tunnel, so the whole stack costs nothing.

## Peran di sistem

| Bagian | Tanggung jawab |
|---|---|
| APK Flutter | Menampilkan data dan mengirim niat beli. Tidak memutuskan harga atau stok |
| Backend ini | Satu-satunya pemegang server key Midtrans dan service account Firebase |
| Firestore | Sumber kebenaran stok, harga, dan status pesanan |
| Midtrans Sandbox | Membuat tagihan dan mengirim notifikasi pembayaran |

## Prasyarat

- Node.js 18 atau lebih baru
- Akun Midtrans Sandbox
- Service account Firebase untuk project yang sama dengan aplikasi

## Menjalankan

```bash
npm install
copy .env.example .env      # Windows
cp .env.example .env        # macOS / Linux
```

Isi `.env`:

| Variabel | Wajib | Keterangan |
|---|---|---|
| `PORT` | tidak | Default `3000` |
| `MIDTRANS_SERVER_KEY` | ya | Server key Sandbox. Tidak boleh ada di aplikasi |
| `MIDTRANS_CLIENT_KEY` | ya | Client key Sandbox, dipakai Snap |
| `MIDTRANS_IS_PRODUCTION` | tidak | `false` untuk Sandbox |
| `FIREBASE_SERVICE_ACCOUNT` | ya | Path ke `serviceAccountKey.json` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | alternatif | Isi service account sebagai satu baris JSON, untuk platform tanpa berkas |
| `FIREBASE_PROJECT_ID` | tidak | Kalau kosong, diambil dari service account |
| `RESERVATION_HOLD_MINUTES` | tidak | Default `5`. Harus sama dengan `AppConstants.reservationHoldMinutes` |
| `BASE_URL` | tidak | Alamat publik untuk callback dan tautan invoice |
| `GOPAY_CALLBACK_URL` | tidak | Callback khusus GoPay |
| `LOG_VERBOSE` | tidak | `1` untuk log verbose |

Jalankan:

```bash
npm start          # server saja
npm run dev        # server dengan watch
npm run tunnel     # server + Cloudflare Quick Tunnel
```

`npm run tunnel` memeriksa dulu apakah port 3000 sudah dipakai. Kalau belum, server dinyalakan, lalu cloudflared dijalankan dan alamat `https://xxx.trycloudflare.com` ditulis ke dokumen `events/_backend_config` supaya aplikasi tahu alamat backend yang sedang berlaku.

## Endpoint

Ada 23 rute. Semua rute yang diawali `/admin/` wajib membawa header `Authorization` berisi kata `Bearer` diikuti ID token Firebase milik akun ber-role `admin` atau `super_admin`. Tanpa token, jawabannya 401.

| Kelompok | Rute | Fungsi |
|---|---|---|
| Dasar | `GET /` | Daftar rute dan status server |
| Checkout | `POST /checkout-atomic` | Potong stok dan tulis pesanan `RESERVED` dalam satu transaksi |
| | `POST /validate-promo` | Periksa kode promo dan hitung potongan di server |
| | `GET /check-status/:orderId` | Status pesanan untuk layar pembayaran |
| | `GET /invoice/:orderId` | Halaman invoice yang bisa dibuka di browser |
| Pembayaran | `POST /create-transaction` | Transaksi Midtrans Snap |
| | `POST /create-va` | Virtual account |
| | `POST /create-qris` | QRIS |
| | `POST /create-gopay` | GoPay |
| | `POST /midtrans-webhook` | Notifikasi pembayaran dari Midtrans, diverifikasi SHA512 |
| | `POST /poll-payment` | Tanya status langsung ke Midtrans bila webhook terlambat |
| | `POST /sweep-expired` | Lepas stok pesanan yang lewat 5 menit |
| | `POST /settle-dev` | Tandai lunas di lingkungan pengembangan |
| Refund | `POST /request-refund` | Pengajuan refund dari pengguna |
| | `POST /approve-refund` | Setujui refund |
| | `POST /reject-refund` | Tolak refund |
| | `GET /admin/refunds` | Daftar pengajuan untuk admin |
| | `POST /admin/refund/approve` | Persetujuan dari panel admin |
| | `POST /admin/refund/reject` | Penolakan dari panel admin |
| Promo | `GET /admin/promos` | Daftar kode promo |
| | `POST /admin/promo` | Tambah atau ubah kode promo |
| | `DELETE /admin/promo/:id` | Hapus kode promo |
| Gerbang | `POST /sync-offline-scans` | Unggah hasil pindai offline saat perangkat kembali online |

## Modul

| Berkas | Isi |
|---|---|
| `server.js` | Rute, transaksi stok, verifikasi webhook, tanda tangan tiket Ed25519 |
| `auth_admin.js` | Penjaga rute `/admin/*`: verifikasi ID token, lalu cek peran di `users/{uid}` |
| `logger.js` | Tampilan konsol. Tanpa dependency, warna mati otomatis saat output masuk berkas |
| `notifikasi.js` | Satu jalur untuk inbox Firestore dan push FCM |
| `pengumuman.js` | Pengumuman manual ke pengguna |
| `start_tunnel.js` | Nyalakan server, buka tunnel, simpan alamat publik ke Firestore |
| `reconcile_refund_orders.js` | Perbaiki pesanan yang statusnya tidak sinkron setelah refund |
| `diag_qris.js` | Periksa konfigurasi QRIS tanpa membuat transaksi sungguhan |
| `preview_tampilan.js` | Pratinjau tampilan tanpa membuka aplikasi |

## Pengujian

Enam skrip manual, dijalankan satu per satu saat backend hidup. Bukan jest.

```bash
node test_sweep_reservasi.js    # stok dilepas setelah 5 menit
node test_sweep_otomatis.js     # penyapu berjalan sendiri, bukan hanya endpoint
node test_settle_stok.js        # potong dan lepas stok tidak pernah dobel
node test_refund_flow.js        # pengajuan sampai keputusan admin
node test_notifikasi.js         # inbox Firestore
node test_push.js               # push FCM
```
`test_refund_flow.js` menguji rute `/admin/*`, jadi butuh dua hal: `FIREBASE_WEB_API_KEY` terisi di `.env` dan minimal satu user ber-role `admin`. Tanpa keduanya, skrip itu berhenti dengan pesan lewat, bukan gagal.

## Keamanan

- `.env` dan `serviceAccountKey.json` masuk `.gitignore`. Jangan pernah di-commit.
- Webhook Midtrans diverifikasi signature SHA512 sebelum status pesanan diubah.
- Tiket ditandatangani Ed25519 dan diverifikasi di HP, tanpa bertanya ke server.
- Kunci yang pernah bocor harus dirotasi di dashboard Midtrans. Menghapusnya dari berkas tidak menghapusnya dari riwayat git.
- Rute `/admin/*` dijaga `auth_admin.js`. Token diverifikasi ke Firebase, lalu peran dibaca dari `users/{uid}`. Tanpa token 401, tanpa role admin 403.

## Batasan yang diketahui

- Firestore Spark membatasi 20.000 tulis dan 50.000 baca per hari.
- Quick Tunnel berganti alamat setiap kali dijalankan ulang. Aplikasi membaca alamat terbaru dari `events/_backend_config`.
- Satu instance, tanpa antrean. Cukup untuk demo, bukan untuk lonjakan penjualan.
- Rute pengguna seperti `/checkout-atomic` dan `/request-refund` belum memverifikasi identitas pemanggil. `userId` masih dibaca dari body permintaan.

## Lisensi

MIT. Lihat [LICENSE](LICENSE).
