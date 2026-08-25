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
    return res.status(400).json({
      error: 'Invalid YouTube URL or Video ID. Provide ?url=... or ?id=...'
    });
  }

  // Reliable Invidious & Piped public API instances
  const instances = [
    `https://inv.tux.pizza/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
    `https://invidious.private.coffee/api/v1/videos/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://api.piped.privacydev.net/streams/${videoId}`
  ];

  let audioUrl = null;
  let title = 'YouTube Audio Stream';
  let duration = 180;

  for (const instanceUrl of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      const response = await fetch(instanceUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Rync432-AudioEngine/2.0' }
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        title = data.title || title;
        duration = data.lengthSeconds || data.duration || duration;

        // Invidious format: adaptiveFormats
        if (data.adaptiveFormats && Array.isArray(data.adaptiveFormats)) {
          const audioFormats = data.adaptiveFormats
            .filter(f => f.type && f.type.startsWith('audio/'))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          
          if (audioFormats.length > 0 && audioFormats[0].url) {
            audioUrl = audioFormats[0].url;
            break;
          }
        }

        // Piped format: audioStreams
        if (data.audioStreams && Array.isArray(data.audioStreams)) {
          const sorted = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (sorted.length > 0 && sorted[0].url) {
            audioUrl = sorted[0].url;
            break;
          }
        }
      }
    } catch (e) {
      // try next instance
    }
  }

  if (!audioUrl) {
    return res.status(502).json({
      error: 'Tidak dapat mengekstrak audio stream dari YouTube saat ini. Silakan coba link lain atau gunakan tab Upload File MP3.',
      videoId
    });
  }

  // If user requests JSON metadata only
  if (req.query?.meta === '1') {
    return res.status(200).json({
      videoId,
      title,
      duration,
      audioUrl
    });
  }

  // Stream raw audio pipe back to client
  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      return res.redirect(audioUrl);
    }

    const contentType = audioRes.headers.get('content-type') || 'audio/webm';
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Track-Title', encodeURIComponent(title));
    res.setHeader('X-Track-Duration', duration);

    const arrayBuffer = await audioRes.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (err) {
    // Fallback: Redirect client to direct audio stream URL
    return res.redirect(audioUrl);
  }
}
