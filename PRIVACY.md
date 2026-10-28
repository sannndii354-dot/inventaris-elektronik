# Kebijakan Privasi — Inventaris Elektronik Backup

*Berlaku sejak 28 Oktober 2026*

**Inventaris Elektronik** adalah aplikasi web open-source untuk mencatat komponen elektronik. Fitur opsional **auto backup ke Google Drive** memakai integrasi Google bernama "Inventaris Elektronik Backup". Halaman ini menjelaskan data apa yang diakses integrasi itu.

## Data Google yang diakses

- Aplikasi hanya meminta izin `https://www.googleapis.com/auth/drive.file`. Dengan izin ini aplikasi **hanya bisa melihat dan mengubah file dan folder yang dibuatnya sendiri**. Aplikasi tidak bisa membaca file lain di Google Drive Anda.
- Aplikasi juga membaca alamat email akun Drive, hanya untuk ditampilkan di halaman Pengaturan aplikasi supaya jelas ke akun mana backup disimpan.

## Cara data dipakai

- Server aplikasi milik Anda membuat folder **Inventaris Elektronik Backup** di Drive Anda, mengunggah file backup JSON berisi data inventaris Anda, dan memindahkan backup lama ke Sampah Drive sesuai batas jumlah yang Anda atur.
- Token akses Google hanya disimpan di server aplikasi Anda sendiri (file `.env`). Token tidak dikirim ke pihak lain.
- Tidak ada data yang dijual, dibagikan ke pihak ketiga, atau dipakai untuk iklan.

## Menghapus akses dan data

- Cabut akses kapan saja di [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- File backup ada di Drive Anda sendiri dan bisa dihapus langsung dari Google Drive.

## Kontak

Pertanyaan tentang kebijakan ini dapat diajukan melalui [Issues di repositori ini](https://github.com/sannndii354-dot/inventaris-elektronik/issues).
