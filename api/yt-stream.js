// Rync432 Audio Stream Resolver & Proxy
// Attempts multi-provider audio extraction; returns clear status to client without fake audio replacement.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const queryUrl = req.query?.url || '';
  const queryId = req.query?.id || '';

  // If already a direct audio file URL (mp3/wav/ogg/flac)
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
      error: 'URL tidak valid. Masukkan link audio atau YouTube yang valid.'
    });
  }

  // Attempt multi-engine extraction (Cobalt, Piped, Invidious)
  const extractionEndpoints = [
    {
      name: 'Cobalt',
      url: 'https://api.cobalt.tools/api/json',
      method: 'POST',
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, isAudioOnly: true, aFormat: 'mp3' })
    },
    {
      name: 'Invidious NerdVPN',
      url: `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
      method: 'GET'
    },
    {
      name: 'Piped',
      url: `https://pipedapi.kavin.rocks/streams/${videoId}`,
      method: 'GET'
    }
  ];

  for (const ep of extractionEndpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      let streamUrl = null;
      if (ep.method === 'POST') {
        const resp = await fetch(ep.url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          body: ep.body
        });
        clearTimeout(timeout);
        if (resp.ok) {
          const d = await resp.json();
          streamUrl = d.url;
        }
      } else {
        const resp = await fetch(ep.url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timeout);
        if (resp.ok) {
          const d = await resp.json();
          const audioFormats = (d.adaptiveFormats || d.audioStreams || []).filter(f => (f.type || f.mimeType || '').startsWith('audio/') && f.url);
          if (audioFormats.length > 0) {
            streamUrl = audioFormats[0].url;
          }
        }
      }

      if (streamUrl) {
        const audioFetch = await fetch(streamUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (audioFetch.ok) {
          const contentType = audioFetch.headers.get('content-type') || 'audio/mp4';
          res.setHeader('Content-Type', contentType);
          const arrayBuf = await audioFetch.arrayBuffer();
          return res.status(200).send(Buffer.from(arrayBuf));
        }
      }
    } catch (e) {}
  }

  // Explicit transparent error if rate-limited by YouTube datacenter policies
  return res.status(502).json({
    error: 'YouTube memblokir IP serverless hosting. Silakan gunakan tab "File" untuk mengupload MP3/WAV langsung dari HP atau PC.',
    videoId
  });
}
