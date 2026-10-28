# Inventaris Elektronik

Aplikasi web untuk mencatat komponen elektronik dan mikrokontroler: stok, lokasi penyimpanan, spesifikasi teknis, stok minimum, dan pemakaian per proyek. Data bisa diekspor ke **Excel, PDF, dan Word**.

## Fitur

- Data barang: kode otomatis per kategori (`MCU-001`, `RES-002`, …), nilai, package, tegangan/rating, part number, link datasheet
- Lokasi rak / laci / kotak + slot
- Stok minimum dengan status **Aman / Menipis / Habis**
- Stok masuk/keluar per proyek, tombol −/+ cepat, dan riwayat lengkap
- Halaman proyek: komponen yang dialokasikan dan jumlah yang sudah terpakai
- Pencarian, filter (kategori, lokasi, status, proyek), dan pengurutan
- Ekspor **Excel** (inventaris, perlu restock, ringkasan, riwayat), **PDF** (laporan + daftar belanja), **Word (.docx)**
- Impor dari Excel, template Excel, backup/pulihkan JSON
- Auto backup ke Google Drive (opsional, dijalankan oleh server)
- Data bersama di server (SQLite), bisa dipakai beberapa orang/perangkat sekaligus
- Mode gelap, tampilan HP

## Deploy dengan Docker (disarankan)

Butuh Docker + Docker Compose di server.

```bash
git clone https://github.com/electrical-embedded/inventaris-elektronik.git
cd inventaris-elektronik
cp .env.example .env
nano .env            # isi APP_PASSWORD
docker compose up -d --build
```

Buka `http://IP-SERVER:3000`, lalu login dengan `APP_USER` / `APP_PASSWORD` dari `.env`.

Data disimpan di Docker volume `inventaris-data` (file `/data/inventaris.db`), jadi tidak hilang saat container dibuat ulang.

### Update ke versi terbaru

```bash
git pull
docker compose up -d --build
```

## Deploy tanpa Docker

Butuh **Node.js 22.13 atau lebih baru** (memakai modul bawaan `node:sqlite`, tanpa `npm install`).

```bash
APP_PASSWORD=rahasia PORT=3000 npm start
```

`npm start` otomatis membaca file `.env` bila ada. Untuk berjalan terus di latar belakang, pakai systemd, pm2, atau sejenisnya. Data tersimpan di folder `data/` (bisa diubah lewat `DATA_DIR`).

## Konfigurasi

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `HOST` | `0.0.0.0` | Alamat yang didengarkan |
| `APP_USER` | `admin` | Nama user login |
| `APP_PASSWORD` | *(kosong)* | Password login. Jika kosong, **tanpa login** — hanya untuk jaringan lokal tepercaya |
| `DATA_DIR` | `./data` (`/data` di Docker) | Lokasi file database SQLite |

## HTTPS (jika diakses dari internet)

Login memakai HTTP Basic Auth, jadi **wajib lewat HTTPS** bila server terbuka ke internet. Contoh paling mudah dengan [Caddy](https://caddyserver.com/) (sertifikat otomatis):

```
inventaris.domainanda.com {
    reverse_proxy localhost:3000
}
```

Atau Nginx:

```nginx
server {
    server_name inventaris.domainanda.com;
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Aplikasi juga bisa dipasang di sub-path (mis. `https://domain.com/inventaris/`) karena semua alamat API relatif.

## Backup

- Dari aplikasi: **Pengaturan & Data → Backup lengkap (.json)**. File ini bisa dipulihkan lewat menu yang sama.
- Dari server (Docker):

  ```bash
  docker compose exec inventaris node -e "new (require('node:sqlite').DatabaseSync)('/data/inventaris.db').exec(\"VACUUM INTO '/data/backup.db'\")"
  docker compose cp inventaris:/data/backup.db ./backup-$(date +%F).db
  ```

## Auto backup ke Google Drive

Server bisa mengunggah backup JSON ke Google Drive secara otomatis (default tiap 24 jam, hanya bila data berubah) dan menyimpan 30 file terakhir; file yang lebih lama dipindah ke Sampah Drive. File backup memakai format yang sama dengan **Backup lengkap (.json)**, jadi bisa dipulihkan lewat **Pengaturan & Data → Pulihkan dari backup…**. Status dan tombol **Backup ke Drive sekarang** ada di halaman Pengaturan.

Aplikasi hanya meminta izin `drive.file`: ia hanya bisa melihat file dan folder yang dibuatnya sendiri, bukan isi Drive lainnya.

### 1. Buat OAuth client di Google Cloud (sekali saja)

1. Buka [console.cloud.google.com](https://console.cloud.google.com/), buat project baru (mis. `Inventaris Backup`).
2. **APIs & Services → Library**, cari **Google Drive API**, klik **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): pilih **External**, isi nama aplikasi dan email. Di **Audience**, klik **Publish app** agar statusnya **In production**.
   Jika dibiarkan **Testing**, token kedaluwarsa setelah 7 hari dan backup akan berhenti. Scope `drive.file` tidak perlu verifikasi Google.
4. **Clients → Create client**, tipe **Desktop app**. Catat **Client ID** dan **Client secret**.

### 2. Ambil refresh token

Di komputer yang punya browser (bisa laptop Anda, tidak harus server), di folder project:

```bash
node scripts/gdrive-auth.js CLIENT_ID CLIENT_SECRET email-tujuan@gmail.com
```

Argumen ketiga (opsional) adalah akun Google tujuan backup; akun itu dipilihkan otomatis di halaman login. Buka link yang muncul, pastikan yang login adalah akun tersebut, lalu izinkan. Akun yang terhubung ditampilkan di kartu **Auto backup Google Drive** di Pengaturan. Terminal akan menampilkan tiga baris `GDRIVE_...`.

### 3. Pasang di server

Tempel ketiga baris itu ke `.env` di server, lalu jalankan ulang:

```bash
docker compose up -d
```

Log server akan menampilkan `Auto backup Google Drive aktif`. Folder **Inventaris Elektronik Backup** dibuat otomatis di Drive saat backup pertama (sekitar 30 detik setelah server menyala).

| Variabel | Default | Keterangan |
|---|---|---|
| `GDRIVE_CLIENT_ID` | *(kosong)* | Client ID OAuth (tipe Desktop app) |
| `GDRIVE_CLIENT_SECRET` | *(kosong)* | Client secret OAuth |
| `GDRIVE_REFRESH_TOKEN` | *(kosong)* | Hasil `scripts/gdrive-auth.js` |
| `GDRIVE_FOLDER_NAME` | `Inventaris Elektronik Backup` | Nama folder backup di Drive |
| `GDRIVE_BACKUP_HOURS` | `24` | Jarak antar backup (jam) |
| `GDRIVE_KEEP` | `30` | Jumlah file backup yang disimpan |

Jika backup gagal (mis. izin dicabut di akun Google), pesan error tampil di Pengaturan dan di bar backup halaman Barang; server mencoba lagi tiap jam. Ulangi langkah 2 untuk membuat token baru.

## Tanpa server (mode lokal)

`public/index.html` juga bisa langsung dibuka di browser (klik dua kali) atau di-hosting statis (GitHub Pages, Netlify, dsb.). Dalam mode ini data tersimpan di browser masing-masing, bukan di server. Penanda di pojok kanan atas menunjukkan mode yang aktif: **Lokal** atau **Tersimpan di server**.

Fitur ekspor memuat library (SheetJS, jsPDF, docx) dari CDN, jadi browser pengguna perlu terhubung ke internet.

## API

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/healthz` | Cek kesehatan (tanpa login) |
| `GET` | `/api/state` | Seluruh data |
| `GET` | `/api/rev` | Nomor revisi data terbaru |
| `POST` | `/api/sync` | Kirim perubahan (`items`/`logs`: `upsert` & `remove`, `settings`) |
| `GET` | `/api/gdrive` | Status auto backup Google Drive |
| `POST` | `/api/gdrive/backup` | Jalankan backup ke Google Drive sekarang |

Perubahan dari beberapa pengguna digabung per barang; jika dua orang mengubah barang yang **sama** pada saat bersamaan, perubahan terakhir yang dipakai. Halaman otomatis memuat perubahan dari pengguna lain setiap 10 detik.
