// Rync432 YouTube & Audio Stream Proxy Engine
// Multi-node failover with fast timeouts

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

  // 2. High-speed multi-node extraction nodes
  const nodes = [
    {
      type: 'cobalt',
      url: 'https://cobalt-api.kwiatekm.tokyo/api/json',
      body: { url: `https://www.youtube.com/watch?v=${videoId}`, isAudioOnly: true, aFormat: 'mp3' }
    },
    {
      type: 'cobalt',
      url: 'https://api.cobalt.tools/api/json',
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

  let resolvedAudioUrl = null;
  let trackTitle = 'YouTube Audio';

  for (const node of nodes) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      if (node.type === 'cobalt') {
        const resp = await fetch(node.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
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

  // Stream binary to Web Audio engine
  if (resolvedAudioUrl) {
    try {
      const audioFetch = await fetch(resolvedAudioUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (audioFetch.ok) {
        const contentType = audioFetch.headers.get('content-type') || 'audio/mp4';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Track-Title', encodeURIComponent(trackTitle));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const arrayBuf = await audioFetch.arrayBuffer();
        return res.status(200).send(Buffer.from(arrayBuf));
      }
    } catch (streamErr) {
      return res.redirect(resolvedAudioUrl);
    }
  }

  return res.status(422).json({
    error: 'YouTube membatasi ekstraksi streaming pada serverless hosting. Silakan gunakan tab "File" untuk mengupload MP3/WAV langsung tanpa batas!',
    videoId
  });
}
