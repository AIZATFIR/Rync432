# Rync

Rync adalah music player berbasis browser dengan pencarian YouTube, library lokal, antrean, dan room untuk mendengarkan bersama. Buat room dari player lalu bagikan link atau kode room ke teman.

## Jalankan lokal

Butuh Node.js dan npm.

```bash
npm install
npm test
npm run build
npm start
```

Buka `http://localhost:3000`. Metadata room dan antreannya disimpan di `data/rooms.json` selama maksimum tiga jam. Audio yang diunggah ke room berada di memori server dan hilang saat proses server restart. Untuk server yang memakai disk persisten, set `RYNC_ROOM_STORE_PATH` ke lokasi file yang persisten dan sertakan file itu dalam backup. Room dibatasi lima perangkat aktif dan 500 item antrean.

Pencarian YouTube memerlukan YouTube Data API v3 key pada environment server:

```bash
YOUTUBE_DATA_API_KEY=isi_key_di_environment_server
```

Jangan masukkan API key ke kode frontend atau commit ke Git. Pemutaran YouTube menggunakan player embed resmi. Video yang menolak embed, kebijakan autoplay browser, kuota API dan ketersediaan jaringan dapat membatasi pencarian atau pemutaran.

## Sumber audio dan room

- YouTube diputar melalui player embed resmi; audio YouTube tidak diunduh menjadi file.
- URL audio langsung dan file lokal didukung sesuai validasi dan batas ukuran aplikasi.
- File lokal untuk room harus dibagikan oleh host melalui WebRTC atau relay yang tersedia. Host perlu tetap terhubung untuk menyiapkan dan mengirim sumber audio.
- Room memakai WebRTC bila tersedia dan beralih ke relay untuk sumber yang mendukungnya. Jaringan, NAT, browser, autoplay dan perangkat keluaran memengaruhi keberhasilan serta waktu mulai.
- Batas server saat ini: lima perangkat aktif, 500 item antrean, payload signaling 64 KiB, 256 sinyal tertunda per room, TTL room tiga jam.

Jumlah perangkat tersebut adalah batas konfigurasi, bukan hasil uji kapasitas. Ukuran sinkronisasi dan keberhasilan P2P perlu diukur pada perangkat serta jaringan yang akan digunakan; Bluetooth dan tab browser di latar belakang dapat menambah latensi.

## Pemeriksaan lokal

```bash
npm test
npm run build
```

Untuk instalasi homeserver, pastikan folder penyimpanan room persisten. Deploy ke Vercel tidak menyediakan penyimpanan file room persisten secara otomatis; gunakan layanan penyimpanan yang sesuai sebelum mengandalkannya untuk room yang harus bertahan antar-instance.
