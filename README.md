# Rync

Rync adalah pemutar musik browser dengan antrean bersama dan room untuk mendengarkan bareng. Cari musik, putar sumber yang tersedia, lalu bagikan tautan room ke teman.

---

## Fitur yang tersedia

- Pemutar audio browser dengan antrean lokal dan antrean room.
- Pencarian YouTube, link YouTube, URL audio langsung, dan audio yang diunggah.
- Room dengan tautan/kode undangan, daftar perangkat, dan kontrol host.
- Sinkronisasi lewat WebRTC dengan jalur HTTP sebagai fallback untuk audio yang didukung.
- Antrean bersama dengan tambah, susun ulang, hapus, clear-upcoming, dan undo.
- Mode repeat dan shuffle yang dibagikan ke anggota room.
- Favorit, playlist, dan riwayat lokal pada browser.

Ketersediaan sumber YouTube bergantung pada provider dan kebijakan yang berlaku. Metode provider saat ini belum ditinjau untuk peluncuran publik; jangan menganggap endpoint YouTube sebagai layanan produksi yang dijamin tersedia.

---

## 🚀 Menjalankan Secara Lokal (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Jalankan test unit (Vitest)
npm test

# 3. Jalankan server lokal
npm start
```

- Buka `http://localhost:3000` di laptop/PC Host (Master).
- Buka `http://<IP-Lokal-WiFi>:3000` dari smartphone lain di jaringan Wi-Fi yang sama untuk langsung sinkron!
- Server Node menyimpan room dan queue di `data/rooms.json` (TTL 3 jam). Simpan folder `data/` pada disk persisten homeserver dan sertakan di backup; room ini tidak dipersist di deployment Vercel/serverless.
- Lokasi store dapat diganti dengan `RYNC_ROOM_STORE_PATH=/path/yang/persisten/rooms.json`. File dibuat dengan permission `0600`; peer aktif dan sinyal WebRTC harus tersambung ulang setelah restart.
- Batas room saat ini: 5 perangkat aktif, 500 item antrean, payload signaling 64 KiB, dan paling banyak 256 sinyal tertunda per room. Sinyal kedaluwarsa setelah 30 detik.
- Batas tersebut menjaga server, bukan hasil uji performa. Sinkronisasi audio tetap bergantung pada browser, jaringan, dan output device.

---

## 🌐 Deploy ke Vercel (Vercel Setup)

Proyek ini memiliki konfigurasi [`vercel.json`](vercel.json):

```bash
# Deploy via Vercel CLI
npx vercel
```
Atau hubungkan repository Git ini langsung ke dashboard [Vercel](https://vercel.com) dengan nama project `Rync432`.

---

## 📂 Struktur Project

```
Rync432/
├── api/
│   └── health.js              # Serverless health endpoint untuk Vercel
├── docs/
│   └── superpowers/plans/     # Implementation plans
├── public/
│   ├── css/
│   │   └── style.css          # Spotify Design System tokens & layout
│   ├── js/
│   │   ├── audio/
│   │   │   ├── AudioEngine.js # Web Audio API & Synthwave generator
│   │   │   ├── ClockSync.js   # NTP Cristian's algorithm
│   │   │   ├── LatencyTuner.js# Precision offset calculator (±1ms, presets)
│   │   │   └── Metronome.js   # 2-tone keep-alive audio warmer
│   │   ├── network/
│   │   │   └── SocketClient.js# WebSocket sync & binary audio relay
│   │   ├── ui/
│   │   │   ├── UIManager.js   # Spotify DOM controller & Google Auth
│   │   │   └── Visualizer.js  # 60fps Spotify Green canvas spectrum
│   │   └── app.js             # Main application bootstrapper
│   └── index.html             # Spotify-styled HTML5 application
├── server/
│   ├── roomManager.js         # Room lifecycle & peer state
│   └── server.js              # HTTP & WebSocket sync server
├── tests/
│   ├── clockSync.test.js      # Clock offset unit tests
│   ├── latencyTuner.test.js   # Latency calculation unit tests
│   └── roomManager.test.js    # Room peer join/leave tests
├── package.json
├── vercel.json                # Vercel routing configuration
└── README.md
```

---

## 📜 Lisensi
MIT License • Dibuat untuk performa audio mesh berkecepatan tinggi.
