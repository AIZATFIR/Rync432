// Scratch test script to test working YouTube audio streaming backends
async function testStream(videoId) {
  const sources = [
    // 1. Cobalt API
    {
      name: 'Cobalt Tools',
      fn: async () => {
        const res = await fetch('https://api.cobalt.tools/api/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, isAudioOnly: true, aFormat: 'mp3' })
        });
        const d = await res.json();
        return d.url;
      }
    },
    // 2. Invidious Instances
    {
      name: 'Invidious Flokinet',
      fn: async () => {
        const res = await fetch(`https://invidious.flokinet.to/api/v1/videos/${videoId}`);
        const d = await res.json();
        const aud = (d.adaptiveFormats || []).find(f => f.type && f.type.startsWith('audio/'));
        return aud ? aud.url : null;
      }
    },
    // 3. Invidious Tux Pizza
    {
      name: 'Invidious Tux Pizza',
      fn: async () => {
        const res = await fetch(`https://inv.tux.pizza/api/v1/videos/${videoId}`);
        const d = await res.json();
        const aud = (d.adaptiveFormats || []).find(f => f.type && f.type.startsWith('audio/'));
        return aud ? aud.url : null;
      }
    },
    // 4. Piped Kavin
    {
      name: 'Piped Kavin',
      fn: async () => {
        const res = await fetch(`https://pipedapi.kavin.rocks/streams/${videoId}`);
        const d = await res.json();
        const aud = (d.audioStreams || [])[0];
        return aud ? aud.url : null;
      }
    },
    // 5. Ytdl/Invidious Direct Proxy
    {
      name: 'Invidious NerdVPN',
      fn: async () => {
        const res = await fetch(`https://invidious.nerdvpn.de/api/v1/videos/${videoId}`);
        const d = await res.json();
        const aud = (d.adaptiveFormats || []).find(f => f.type && f.type.startsWith('audio/'));
        return aud ? aud.url : null;
      }
    }
  ];

  for (const s of sources) {
    try {
      const url = await s.fn();
      console.log(`[${s.name}] Result:`, url ? url.substring(0, 80) + '...' : 'null');
      if (url) {
        const head = await fetch(url, { method: 'HEAD' });
        console.log(`[${s.name}] Stream Status:`, head.status, head.headers.get('content-type'));
      }
    } catch (e) {
      console.log(`[${s.name}] Error:`, e.message);
    }
  }
}

testStream('dQw4w9WgXcQ');
