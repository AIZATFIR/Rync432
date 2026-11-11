# Rync homeserver runbook

Panduan ini untuk meng-update checkout Rync yang sudah berjalan di homeserver. Nama service dan konfigurasi reverse proxy berbeda tiap instalasi; gunakan nama yang sudah dipakai di server, jangan menyalin contoh service yang belum diverifikasi.

## Sebelum update

1. Pastikan checkout berada pada branch rilis yang benar dan tidak memiliki perubahan lokal:

   ```bash
   git status --short --branch
   git fetch origin
   git log -1 --oneline
   ```

   Jika working tree berisi perubahan lokal, simpan atau tinjau dulu. Jangan menimpa perubahan itu dengan reset paksa.

2. Pastikan secret tersedia melalui environment service atau file environment di luar repository:

   - `YOUTUBE_DATA_API_KEY` untuk pencarian metadata YouTube. Jangan taruh nilainya di file yang di-commit atau di frontend.
   - `RYNC_ROOM_STORE_PATH` menunjuk ke file pada disk persisten dan writable. Tanpa konfigurasi ini, room disimpan di `data/rooms.json` relatif terhadap checkout.
   - `PORT` bila service tidak memakai port default `3000`.

   Audio file yang diunggah untuk room disimpan di memori dan hilang saat proses restart. Host perlu tetap online untuk membagikan file lokal. Metadata room kedaluwarsa setelah tiga jam.

3. Pastikan reverse proxy meneruskan HTTP ke port aplikasi dan mendukung WebSocket upgrade untuk koneksi room. WebSocket dan API room harus diarahkan ke instance aplikasi yang sama; penyimpanan lokal tidak menyinkronkan beberapa instance.

## Update

Ambil perubahan branch yang memang akan dipakai pada homeserver. Misalnya, jika checkout mengikuti branch fitur Rync:

```bash
git pull --ff-only origin feat/rync-music-player
npm ci
npm test
npm run build
```

Jika test atau build gagal, jangan restart service dengan checkout tersebut. Pertahankan commit sebelumnya dan periksa output lengkap sebelum melanjutkan.

Setelah verifikasi hijau, restart service memakai service manager yang sudah dikonfigurasi pada host. Jangan mengganti nama service atau environment file sebagai bagian dari update aplikasi.

## Verifikasi setelah restart

1. Periksa health endpoint:

   ```bash
   curl --fail --silent --show-error https://rync.zafir.my/api/health
   ```

   Respons sukses memiliki `"status":"ok"`. Pastikan juga halaman utama terbuka lewat domain publik.

2. Dari dua perangkat/browser terpisah:

   - Buat room, salin link undangan, dan buka link itu sebagai guest.
   - Pastikan host serta guest terlihat di daftar perangkat dan kedua koneksi menunjukkan online.
   - Tambahkan/putar sumber audio yang tersedia. Pastikan kedua perangkat melaporkan siap dan antrean menampilkan item yang sama.
   - Coba keluar dan masuk kembali memakai link yang sama.

3. Periksa pencarian YouTube. Bila menampilkan pesan bahwa provider belum diatur, cek `YOUTUBE_DATA_API_KEY` pada environment proses service, restart setelah memperbaiki konfigurasi, lalu uji kembali. Pencarian eksternal resmi tetap tersedia sebagai fallback; pemutaran YouTube memakai embed resmi.

4. Periksa log service untuk error startup, WebSocket upgrade, storage permission, atau request API yang gagal. Jangan menyalin secret atau kode room publik ke tiket/log bersama.

## Rollback

Catat commit aktif sebelum update. Jika smoke check gagal, kembalikan checkout ke commit sebelumnya hanya setelah memastikan tidak ada perubahan lokal yang perlu disimpan. Jalankan ulang instalasi dependency dan pemeriksaan build yang sesuai, restart service, lalu pastikan `/api/health` dan alur room pulih. File room store persisten jangan dihapus saat rollback.

## Batas verifikasi

Green unit tests dan health check hanya membuktikan aplikasi merespons. Catat browser/perangkat, jaringan, output audio, jumlah perangkat, hasil join/play, serta durasi saat menjalankan matrix rilis 2–5 perangkat. Bluetooth dan tab latar belakang perlu dicatat terpisah. Jangan menyebut batas lima perangkat sebagai kapasitas terukur sampai matrix itu selesai.
