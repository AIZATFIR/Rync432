// Rync432 Service Worker - Offline Cache & Background Audio Support
const CACHE_NAME = 'rync432-v2';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/privacy.html',
  '/terms.html',
  '/css/style.css',
  '/manifest.json',
  '/js/app.js',
  '/js/privacyGate.js',
  '/js/privacy/consent.js',
  '/js/privacy/youtubeDataRetention.js',
  '/js/privacy/youtubePlaybackErrors.js',
  '/js/ui/UIManager.js',
  '/js/ui/Visualizer.js',
  '/js/ui/QRCodeGenerator.js',
  '/js/ui/QRScanner.js',
  '/js/audio/AudioEngine.js',
  '/js/audio/ClockSync.js',
  '/js/audio/LatencyTuner.js',
  '/js/audio/Metronome.js',
  '/js/music/MusicSourceManager.js',
  '/js/music/AudioResolver.js',
  '/js/music/types.js',
  '/js/music/sources/PublicAudioSource.js',
  '/js/music/sources/SpotifySource.js',
  '/js/music/sources/DirectUrlSource.js',
  '/js/music/sources/YouTubeSource.js',
  '/js/music/sources/LocalSource.js',
  '/js/network/SocketClient.js',
  '/js/network/CloudMesh.js',
  '/js/library/LocalLibrary.js',
  '/js/auth/FirebaseAuth.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('SW Pre-cache partial warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass API calls, streaming audio, and external analytics
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    url.hostname.includes('broker') ||
    url.hostname.includes('emqx') ||
    url.hostname.includes('googlesyndication') ||
    url.hostname.includes('youtube') ||
    url.hostname.includes('ytimg') ||
    url.hostname.includes('googlevideo') ||
    event.request.headers.get('range')
  ) {
    return;
  }

  // Network-first for dynamic app code, cache fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});
