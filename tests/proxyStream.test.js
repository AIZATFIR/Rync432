import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { handleStreamProxy } from '../server/streaming/proxyStream.js';

describe('proxyStream - Audio Streaming Proxy & Range Support', () => {
  let mockAudioServer;
  let mockPort;
  const sampleAudioData = Buffer.from('RIFF_MOCK_WAV_AUDIO_DATA_FOR_RANGE_TESTING_1234567890');

  beforeAll(async () => {
    mockAudioServer = http.createServer((req, res) => {
      const range = req.headers.range;
      const totalLen = sampleAudioData.length;

      if (range) {
        // e.g. "bytes=0-10"
        const match = range.match(/bytes=(\d+)-(\d+)?/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : totalLen - 1;
          const chunk = sampleAudioData.slice(start, end + 1);

          res.writeHead(206, {
            'Content-Type': 'audio/wav',
            'Content-Range': `bytes ${start}-${end}/${totalLen}`,
            'Content-Length': chunk.length,
            'Accept-Ranges': 'bytes'
          });
          res.end(chunk);
          return;
        }
      }

      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': totalLen,
        'Accept-Ranges': 'bytes'
      });
      res.end(sampleAudioData);
    });

    await new Promise((resolve) => {
      mockAudioServer.listen(0, '127.0.0.1', () => {
        mockPort = mockAudioServer.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => mockAudioServer.close(resolve));
  });

  it('rejects proxy requests without url query param', async () => {
    let statusCode;
    let headers = {};
    let data = '';

    const req = {
      url: '/api/stream',
      method: 'GET',
      headers: { host: 'localhost:3000' },
      on: () => {}
    };

    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      set statusCode(val) { statusCode = val; },
      get statusCode() { return statusCode; },
      end: (chunk) => { if (chunk) data += chunk; }
    };

    await handleStreamProxy(req, res);
    expect(statusCode).toBe(400);
    expect(JSON.parse(data).error).toContain('INVALID_URL');
  });

  it('blocks loopback / SSRF targets with 403', async () => {
    let statusCode;
    let headers = {};
    let data = '';

    const req = {
      url: `/api/stream?url=http://127.0.0.1:${mockPort}/test.wav`,
      method: 'GET',
      headers: { host: 'localhost:3000' },
      on: () => {}
    };

    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      set statusCode(val) { statusCode = val; },
      get statusCode() { return statusCode; },
      end: (chunk) => { if (chunk) data += chunk; }
    };

    await handleStreamProxy(req, res);
    expect(statusCode).toBe(403);
    expect(JSON.parse(data).error).toContain('FORBIDDEN_TARGET');
  });
});
