import { describe, it, expect } from 'vitest';
import healthHandler from '../api/health.js';
import roomHandler from '../api/room.js';

describe('Server & API Route Adapters', () => {
  it('handles health check endpoint correctly', () => {
    let statusCode = 0;
    let jsonOutput = null;

    const req = {
      query: { t0: '12345678' }
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonOutput = data;
        return this;
      },
      setHeader() {}
    };

    healthHandler(req, res);

    expect(statusCode).toBe(200);
    expect(jsonOutput.status).toBe('ok');
    expect(jsonOutput.app).toBe('Rync432');
    expect(jsonOutput.t0).toBe(12345678);
    expect(jsonOutput.timestamp).toBeGreaterThan(0);
    expect(jsonOutput.providers.youtubeSearch).toBe(Boolean(process.env.YOUTUBE_DATA_API_KEY));
  });

  it('rejects joining an unknown room instead of creating a ghost room', async () => {
    const roomId = `M${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    let statusCode = 0;
    let jsonOutput;
    const req = { method: 'POST', query: { action: 'join' }, body: { roomId, peerId: 'guest-1' } };
    const res = {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(data) { jsonOutput = data; return this; }
    };

    await roomHandler(req, res);

    expect(statusCode).toBe(404);
    expect(jsonOutput).toMatchObject({ success: false, error: 'ROOM_NOT_FOUND' });
  });
});
