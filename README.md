# 🎵 SoundWave Backend Lokal

Backend Node.js lokal untuk SoundWave — menggantikan Firebase Cloud Functions supaya **100% gratis** (tanpa Blaze plan).

## Prasyarat

- **Node.js 18+** → [download](https://nodejs.org/)
- **Akun Midtrans Sandbox** → [daftar gratis](https://dashboard.sandbox.midtrans.com/register)
- **Firebase Service Account Key** → dari Firebase Console

---

## Setup (Sekali Saja)

### 1. Install dependencies
```bash
cd "D:\Projects\Big Projects\soundwave-backend"
npm install
```

### 2. Buat file `.env`
```bash
copy .env.example .env
```
Lalu edit `.env`:

### 3. Isi Midtrans Sandbox Keys
Buka: https://dashboard.sandbox.midtrans.com/settings/config_info

Copy **Server Key** dan **Client Key** ke `.env`:
```
MIDTRANS_SERVER_KEY=xxxxxxxx
MIDTRANS_CLIENT_KEY=xxxxxxxx
```

### 4. Download Firebase Service Account Key
1. Buka: https://console.firebase.google.com/project/flutter-firebase-konser-apps/settings/serviceaccounts/adminsdk
2. Klik **"Generate New Private Key"**
3. Simpan file JSON-nya sebagai `serviceAccountKey.json` di folder ini
4. Pastikan `.env` berisi:
```
FIREBASE_SERVICE_ACCOUNT=./serviceAccountKey.json
```

### 5. Jalankan
```bash
npm start
```

Kalau berhasil, akan tampil:
```
✅ Firebase Admin SDK initialized
✅ Midtrans SANDBOX mode
═══════════════════════════════════════════
🎵 SoundWave Backend running on port 3000
   http://localhost:3000
═══════════════════════════════════════════
```

---

## Endpoints

| Method | Path | Fungsi |
|--------|------|--------|
| GET | `/` | Health check |
| POST | `/create-transaction` | Buat Snap Token Midtrans |
| POST | `/midtrans-webhook` | Terima notifikasi pembayaran |
| GET | `/check-status/:orderId` | Cek status order |
| POST | `/settle-dev` | Simulasi bayar (sandbox) |

---

## Yang Harus Diubah di Flutter

File `lib/services/midtrans_service.dart` harus diubah:
- Ganti `FirebaseFunctions.httpsCallable('createSnapToken')` → `http.post('http://<IP_LAPTOP>:3000/create-transaction')`
- Ganti `FirebaseFunctions.httpsCallable('settleOrderDev')` → `http.post('http://<IP_LAPTOP>:3000/settle-dev')`

> **IP Laptop**: jalankan `ipconfig` di CMD, cari IPv4 Address WiFi (contoh: `192.168.1.10`)
> HP Android harus di WiFi yang sama dengan laptop.

---

## Saat Demo Kampus

1. Laptop nyalakan backend: `npm start`
2. HP konek WiFi yang sama dengan laptop
3. Flutter app panggil backend via IP laptop
4. Midtrans Sandbox = tidak pakai uang sungguhan

---

## ⚠️ PENTING

- File `serviceAccountKey.json` dan `.env` **JANGAN** di-commit ke git
- Server Key Midtrans **JANGAN** dimasukkan ke kode Flutter
- Backend ini untuk **demo/development saja**, bukan production
