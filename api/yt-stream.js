import { extractYouTubeVideoId } from '../public/js/music/sources/YouTubeSource.js';

function extractVideoId(input) {
  const value = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  return extractYouTubeVideoId(value);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  const requestedUrl = typeof req.query?.url === 'string' ? req.query.url : '';
  const videoId = extractVideoId(req.query?.id || requestedUrl);
  if (videoId) {
    return res.status(410).json({
      error: 'EMBED_PLAYER_REQUIRED',
      videoId,
      message: 'Gunakan player YouTube resmi untuk video ini.'
    });
  }

  if (!requestedUrl) return res.status(400).json({ error: 'INVALID_URL' });
  let parsedUrl;
  try {
    parsedUrl = new URL(requestedUrl);
  } catch (error) {
    return res.status(400).json({ error: 'INVALID_URL' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return res.status(400).json({ error: 'INVALID_URL' });
  return res.redirect(`/api/stream?url=${encodeURIComponent(parsedUrl.href)}`);
}
