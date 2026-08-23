# Rync432 • Spotify-Style Multi-Device Audio Synchronizer 🎵🟢

> **Web-Native Ultra-Low Latency Synchronized Audio Mesh Player**  
> Mengubah sekumpulan smartphone, laptop, dan tablet menjadi satu kesatuan multi-channel sound system yang megah dan berharmoni dengan akurasi sub-milidetik.

![Spotify Theme](https://img.shields.io/badge/UI-Spotify%20Dark%20Theme-1ed760?style=for-the-badge&logo=spotify&logoColor=black)
![Web Audio API](https://img.shields.io/badge/Audio-Web%20Audio%20API-orange?style=for-the-badge)
![WebSockets](https://img.shields.io/badge/Sync-NTP%20Cristian%20Algorithm-6366f1?style=for-the-badge)
![Vercel Ready](https://img.shields.io/badge/Deployment-Vercel-black?style=for-the-badge&logo=vercel)

---

## ✨ Fitur Unggulan (Key Features)

1. **Spotify Design Aesthetics (`#121212` / `#1ed760`)**:
   - Tema gelap imersif (*content-first darkness*) dengan tombol pill (`border-radius: 9999px`), kontrol sirkular 50%, font CircularSp/SpotifyMixUI, dan shadow terangkat (`rgba(0,0,0,0.5) 0px 8px 24px`).
2. **Sub-Millisecond Sample-Accurate Audio Engine**:
   - Menggunakan `AudioContext` & `AudioBufferSourceNode` yang dijadwalkan langsung ke hardware clock (`AudioContext.currentTime`), mengeliminasi delay 50-200ms bawaan tag `<audio>` HTML5.
3. **Precision Latency Tuner ($\pm 1\text{ms}$ Fine-Tune & Nudge Buttons)**:
   - Tombol step `+` dan `−` untuk penyesuaian delay mikrodetik per perangkat.
   - Preset hardware: *Wired Speaker (0ms)*, *Internal Phone (+15ms)*, *Bluetooth Speaker (+120ms)*, *AirPlay (+250ms)*.
4. **Dual-Tone Keep-Alive Metronome (Ketukan 2 Nada: 880Hz / 440Hz)**:
   - Mencegah browser mobile (iOS Safari/Android Chrome) mematikan (*sleep mode*) DAC audio hardware saat hening, dan menjadi sarana kalibrasi telinga di ruangan.
5. **Skema Login Google (Google OAuth 2.0)**:
   - Tombol Google Sign-in resmi dengan modal profil user, avatar, dan persistensi preferensi akun di localStorage.
6. **Slot Google AdSense (Responsive Banner Ads)**:
   - Kontainer iklan responsif bertema gelap yang siap disematkan Google Publisher ID (`ca-pub-XXXXXXXXXXXXX`).
7. **Mesh Topology Monitor**:
   - Menampilkan daftar seluruh speaker/device yang terhubung di ruangan lengkap dengan ping RTT dan latency offset masing-masing.

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

---

## 🌐 Deploy ke Vercel (Vercel Setup)

Proyek ini telah dikonfigurasi dengan [`vercel.json`](file:///home/aizatfir/Project/Rync432/vercel.json) untuk deployment instan:

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
