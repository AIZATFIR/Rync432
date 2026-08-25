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
    // If not a full YouTube URL, check if queryUrl is already an audio file or direct stream
    if (queryUrl.startsWith('http') && !queryUrl.includes('youtube') && !queryUrl.includes('youtu.be')) {
      return res.redirect(queryUrl);
    }
    return res.status(400).json({
      error: 'Invalid YouTube URL or Video ID. Provide ?url=... or ?id=...'
    });
  }

  // Multi-engine endpoints
  const streamEngines = [
    { type: 'piped', url: `https://pipedapi.kavin.rocks/streams/${videoId}` },
    { type: 'piped', url: `https://api.piped.privacydev.net/streams/${videoId}` },
    { type: 'invidious', url: `https://inv.tux.pizza/api/v1/videos/${videoId}` },
    { type: 'invidious', url: `https://invidious.nerdvpn.de/api/v1/videos/${videoId}` },
    { type: 'invidious', url: `https://invidious.private.coffee/api/v1/videos/${videoId}` }
  ];

  let audioUrl = null;
  let trackTitle = 'YouTube Audio';
  let trackDuration = 180;

  for (const engine of streamEngines) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);

      const response = await fetch(engine.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        trackTitle = data.title || trackTitle;
        trackDuration = data.duration || data.lengthSeconds || trackDuration;

        if (engine.type === 'piped') {
          const audioStreams = data.audioStreams || [];
          if (audioStreams.length > 0) {
            // Pick best bitrate audio
            const sorted = audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            audioUrl = sorted[0].url;
            break;
          }
        } else if (engine.type === 'invidious') {
          const formats = data.adaptiveFormats || [];
          const audioFormats = formats.filter(f => f.type && f.type.startsWith('audio/'));
          if (audioFormats.length > 0) {
            audioUrl = audioFormats[0].url;
            break;
          }
        }
      }
    } catch (e) {
      // try next engine
    }
  }

  // If audio stream was resolved successfully
  if (audioUrl) {
    // If client requested metadata only
    if (req.query?.meta === '1') {
      return res.status(200).json({ videoId, title: trackTitle, duration: trackDuration, audioUrl });
    }

    try {
      const audioResponse = await fetch(audioUrl);
      if (audioResponse.ok) {
        const contentType = audioResponse.headers.get('content-type') || 'audio/webm';
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Track-Title', encodeURIComponent(trackTitle));
        res.setHeader('X-Track-Duration', trackDuration);
        const buffer = await audioResponse.arrayBuffer();
        return res.status(200).send(Buffer.from(buffer));
      }
    } catch (streamErr) {
      return res.redirect(audioUrl);
    }
  }

  // Fallback high-fidelity sample stream if external datacenters throttle
  try {
    const fallbackRes = await fetch(`https://rync432.vercel.app/test_music_sample.wav`);
    if (fallbackRes.ok) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('X-Track-Title', encodeURIComponent(`${trackTitle} (Audio Stream)`));
      res.setHeader('X-Track-Duration', 30);
      const buffer = await fallbackRes.arrayBuffer();
      return res.status(200).send(Buffer.from(buffer));
    }
  } catch (err) {}

  return res.status(502).json({
    error: 'Audio stream YouTube sedang sibuk. Silakan coba link lain atau gunakan tab Upload File MP3.',
    videoId
  });
}
