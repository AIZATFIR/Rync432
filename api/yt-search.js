// Genuine YouTube Live Search Scraper (Discord Music Bot style)
// Scrapes live YouTube results directly from youtube.com ytInitialData without API keys or mock fallback.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const query = req.query?.q || '';
  if (!query.trim()) {
    return res.status(400).json({ error: 'Missing search query ?q=...' });
  }

  try {
    // 1. Direct YouTube Search HTML Scrape
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
    const response = await fetch(ytUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (response.ok) {
      const html = await response.text();
      const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/s);
      
      if (match && match[1]) {
        const data = JSON.parse(match[1]);
        const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        
        const results = [];
        if (Array.isArray(contents)) {
          for (const section of contents) {
            const itemSection = section?.itemSectionRenderer?.contents;
            if (Array.isArray(itemSection)) {
              for (const item of itemSection) {
                const video = item?.videoRenderer;
                if (video && video.videoId) {
                  const id = video.videoId;
                  const title = video.title?.runs?.map(r => r.text).join('') || video.title?.simpleText || 'Untitled';
                  const channel = video.ownerText?.runs?.map(r => r.text).join('') || video.shortBylineText?.runs?.map(r => r.text).join('') || 'YouTube Artist';
                  
                  // Duration parsing (e.g. "3:45" or "1:12:30")
                  const durationText = video.lengthText?.simpleText || video.lengthText?.runs?.map(r => r.text).join('') || '3:30';
                  const durationParts = durationText.split(':').map(Number);
                  let durationSec = 0;
                  if (durationParts.length === 2) {
                    durationSec = durationParts[0] * 60 + durationParts[1];
                  } else if (durationParts.length === 3) {
                    durationSec = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
                  }

                  const thumbnail = video.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

                  results.push({
                    id,
                    title,
                    channel,
                    duration: durationSec || 210,
                    durationText,
                    thumbnail,
                    url: `https://www.youtube.com/watch?v=${id}`
                  });

                  if (results.length >= 8) break;
                }
              }
            }
            if (results.length >= 8) break;
          }
        }

        if (results.length > 0) {
          return res.status(200).json({ results });
        }
      }
    }
  } catch (err) {
    console.warn('Direct YouTube scrape error:', err.message);
  }

  // 2. Invidious / Piped API fallbacks with live results
  const publicInstances = [
    `https://inv.tux.pizza/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
    `https://invidious.nerdvpn.de/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
    `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query)}&filter=music_songs`
  ];

  for (const instance of publicInstances) {
    try {
      const resp = await fetch(instance, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (resp.ok) {
        const data = await resp.json();
        const items = data.items || data || [];
        if (Array.isArray(items) && items.length > 0) {
          const results = items.slice(0, 8).map(item => {
            const id = item.videoId || (item.url ? item.url.replace('/watch?v=', '') : '');
            return {
              id,
              title: item.title || 'YouTube Track',
              channel: item.author || item.uploaderName || 'Artist',
              duration: item.lengthSeconds || item.duration || 200,
              thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${id}`
            };
          }).filter(i => i.id);

          if (results.length > 0) {
            return res.status(200).json({ results });
          }
        }
      }
    } catch (e) {}
  }

  return res.status(200).json({ results: [] });
}
