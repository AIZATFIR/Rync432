// Rync432 High-Speed YouTube & Audio Stream Proxy Engine
// Direct YouTube Innertube Audio Stream Extraction (Zero Key / Zero Proxy Delay)

export const config = {
  api: {
    responseLimit: '50mb'
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const queryUrl = req.query?.url || '';
  const queryId = req.query?.id || '';

  // 1. Direct Audio File URL (MP3 / WAV / OGG / FLAC)
  if (queryUrl.startsWith('http') && !queryUrl.includes('youtube.com') && !queryUrl.includes('youtu.be')) {
    try {
      const audioResp = await fetch(queryUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (audioResp.ok) {
        const ct = audioResp.headers.get('content-type') || 'audio/mpeg';
        res.setHeader('Content-Type', ct);
        const buf = await audioResp.arrayBuffer();
        return res.status(200).send(Buffer.from(buf));
      }
    } catch (e) {
      return res.redirect(queryUrl);
    }
  }

  let videoId = queryId;
  if (!videoId && queryUrl) {
    const match = queryUrl.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) {
      videoId = match[1];
    }
  }

  if (!videoId) {
    return res.status(400).json({
      error: 'URL tidak valid. Masukkan link YouTube atau link file audio langsung.'
    });
  }

  let resolvedAudioUrl = null;
  let trackTitle = 'YouTube Audio';

  // 2. Primary: Direct YouTube Innertube API (ANDROID_VR Client)
  try {
    const innertubeResp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'X-YouTube-Client-Name': '28',
        'X-YouTube-Client-Version': '1.58.18'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.58.18',
            deviceModel: 'Quest 3',
            hl: 'en',
            gl: 'US'
          }
        },
        videoId: videoId
      })
    });

    if (innertubeResp.ok) {
      const data = await innertubeResp.json();
      trackTitle = data.videoDetails?.title || trackTitle;
      const formats = data.streamingData?.adaptiveFormats || [];
      const audioFormats = formats.filter(f => (f.mimeType || '').startsWith('audio/') && f.url);

      if (audioFormats.length > 0) {
        // Sort by audio quality (highest bitrate first)
        audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        resolvedAudioUrl = audioFormats[0].url;
      }
    }
  } catch (err) {
    console.warn('Innertube direct error:', err.message);
  }

  // 3. Fallback: Secondary Multi-Node Extractors
  if (!resolvedAudioUrl) {
    const fallbackNodes = [
      {
        type: 'cobalt',
        url: 'https://cobalt-api.kwiatekm.tokyo/api/json',
        body: { url: `https://www.youtube.com/watch?v=${videoId}`, isAudioOnly: true, aFormat: 'mp3' }
      },
      {
        type: 'invidious',
        url: `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`
      },
      {
        type: 'invidious',
        url: `https://inv.tux.pizza/api/v1/videos/${videoId}`
      },
      {
        type: 'piped',
        url: `https://pipedapi.kavin.rocks/streams/${videoId}`
      }
    ];

    for (const node of fallbackNodes) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        if (node.type === 'cobalt') {
          const resp = await fetch(node.url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0'
            },
            body: JSON.stringify(node.body)
          });
          clearTimeout(timeout);
          if (resp.ok) {
            const d = await resp.json();
            if (d.url) {
              resolvedAudioUrl = d.url;
              break;
            }
          }
        } else {
          const resp = await fetch(node.url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          clearTimeout(timeout);
          if (resp.ok) {
            const d = await resp.json();
            trackTitle = d.title || trackTitle;
            const audioFormats = (d.adaptiveFormats || d.audioStreams || []).filter(f => (f.type || f.mimeType || '').startsWith('audio/') && f.url);
            if (audioFormats.length > 0) {
              resolvedAudioUrl = audioFormats[0].url;
              break;
            }
          }
        }
      } catch (e) {}
    }
  }

  // 4. Stream binary audio back to Web Audio API Engine
  if (resolvedAudioUrl) {
    try {
      const audioFetch = await fetch(resolvedAudioUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*'
        }
      });

      if (audioFetch.ok) {
        const contentType = audioFetch.headers.get('content-type') || 'audio/mp4';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Track-Title', encodeURIComponent(trackTitle));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const arrayBuf = await audioFetch.arrayBuffer();
        return res.status(200).send(Buffer.from(arrayBuf));
      } else {
        return res.redirect(resolvedAudioUrl);
      }
    } catch (streamErr) {
      return res.redirect(resolvedAudioUrl);
    }
  }

  return res.status(422).json({
    error: 'Gagal mengekstrak audio YouTube. Gunakan tab "File" untuk upload file audio langsung tanpa hambatan.',
    videoId
  });
}
