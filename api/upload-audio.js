// Serverless Audio Cloud Storage Endpoint for Rync432
// Uploads audio to fast public CDN for guaranteed multi-device download

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '40mb'
    }
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { }
    }

    const audioBase64 = body.audioBase64;
    const fileName = body.fileName || 'track.mp3';

    if (!audioBase64) {
      return res.status(400).json({ error: 'audioBase64 is required' });
    }

    const buffer = Buffer.from(audioBase64, 'base64');
    const blob = new Blob([buffer], { type: body.contentType || 'audio/mpeg' });

    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '72h'); // Retain for 72 hours
    form.append('fileToUpload', blob, fileName);

    // 1. Primary: Litterbox CDN
    try {
      const response = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: form
      });

      if (response.ok) {
        const directUrl = (await response.text()).trim();
        if (directUrl.startsWith('http')) {
          return res.status(200).json({
            success: true,
            audioUrl: directUrl,
            fileName
          });
        }
      }
    } catch (e) {
      console.warn('Litterbox notice:', e.message);
    }

    // 2. Fallback: tmpfiles.org CDN
    try {
      const tmpForm = new FormData();
      tmpForm.append('file', blob, fileName);
      const tmpRes = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: tmpForm
      });
      const tmpJson = await tmpRes.json();
      if (tmpJson.status === 'success' && tmpJson.data?.url) {
        const dlUrl = tmpJson.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
        return res.status(200).json({
          success: true,
          audioUrl: dlUrl,
          fileName
        });
      }
    } catch (e) {
      console.warn('Tmpfiles notice:', e.message);
    }

    return res.status(500).json({ error: 'Failed to upload to cloud storage' });
  } catch (err) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
