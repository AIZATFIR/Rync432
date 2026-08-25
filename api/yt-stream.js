// Genuine YouTube Direct Audio Stream Extractor (InnerTube Android Client + Cobalt Relay)
// Zero mock/demo fallbacks - extracts genuine high-bitrate Opus/AAC audio streams directly from YouTube.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const queryUrl = req.query?.url || '';
  const queryId = req.query?.id || '';

  let videoId = queryId;
  if (!videoId && queryUrl) {
    const match = queryUrl.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) {
      videoId = match[1];
    }
  }

  if (!videoId) {
    if (queryUrl.startsWith('http') && !queryUrl.includes('youtube') && !queryUrl.includes('youtu.be')) {
      return res.redirect(queryUrl);
    }
    return res.status(400).json({
      error: 'Invalid YouTube URL or Video ID. Provide ?url=... or ?id=...'
    });
  }

  let directAudioUrl = null;
  let trackTitle = 'YouTube Audio';
  let trackDuration = 210;

  // 1. YouTube InnerTube Android Client API (Official Client Emulation)
  try {
    const innertubeRes = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '19.09.37'
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.09.37',
            androidSdkVersion: 30,
            hl: 'en',
            gl: 'US'
          }
        }
      })
    });

    if (innertubeRes.ok) {
      const data = await innertubeRes.json();
      trackTitle = data?.videoDetails?.title || trackTitle;
      trackDuration = parseInt(data?.videoDetails?.lengthSeconds || '210', 10);

      const formats = data?.streamingData?.adaptiveFormats || [];
      const audioStreams = formats.filter(f => f.mimeType && f.mimeType.startsWith('audio/'));

      if (audioStreams.length > 0) {
        // Find best audio stream with direct URL
        const withUrl = audioStreams.filter(f => f.url);
        if (withUrl.length > 0) {
          const sorted = withUrl.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          directAudioUrl = sorted[0].url;
        }
      }
    }
  } catch (err) {
    console.warn('InnerTube API notice:', err.message);
  }

  // 2. Cobalt Fast Media Proxy (High Quality Audio Extractor)
  if (!directAudioUrl) {
    const cobaltInstances = [
      'https://api.cobalt.tools/api/json',
      'https://cobalt-api.kwiatekm.tokyo/api/json',
      'https://api.wuk.sh/api/json'
    ];

    for (const endpoint of cobaltInstances) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);

        const cobaltRes = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Rync432-MusicMesh/2.0'
          },
          body: JSON.stringify({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            isAudioOnly: true,
            aFormat: 'mp3'
          })
        });
        clearTimeout(timeout);

        if (cobaltRes.ok) {
          const data = await cobaltRes.json();
          if (data.url) {
            directAudioUrl = data.url;
            break;
          }
        }
      } catch (e) {}
    }
  }

  // 3. Invidious / Piped Backup Nodes
  if (!directAudioUrl) {
    const backupNodes = [
      `https://inv.tux.pizza/api/v1/videos/${videoId}`,
      `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
      `https://pipedapi.kavin.rocks/streams/${videoId}`
    ];

    for (const node of backupNodes) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const resp = await fetch(node, { signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          const data = await resp.json();
          trackTitle = data.title || trackTitle;
          const audioFormats = (data.adaptiveFormats || data.audioStreams || []).filter(f => (f.type || f.mimeType || '').startsWith('audio/') && f.url);
          if (audioFormats.length > 0) {
            directAudioUrl = audioFormats[0].url;
            break;
          }
        }
      } catch (e) {}
    }
  }

  // Stream binary to Web Audio engine
  if (directAudioUrl) {
    try {
      const audioResponse = await fetch(directAudioUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });

      if (audioResponse.ok) {
        const contentType = audioResponse.headers.get('content-type') || 'audio/mp4';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Track-Title', encodeURIComponent(trackTitle));
        res.setHeader('X-Track-Duration', trackDuration);
        res.setHeader('Cache-Control', 'public, max-age=3600');

        const arrayBuffer = await audioResponse.arrayBuffer();
        return res.status(200).send(Buffer.from(arrayBuffer));
      }
    } catch (streamErr) {
      // If direct proxy failed, redirect to URL
      return res.redirect(directAudioUrl);
    }
  }

  return res.status(502).json({
    error: 'Gagal mengekstrak audio YouTube. Silakan gunakan link video YouTube lain atau gunakan tab Upload File.',
    videoId
  });
}
