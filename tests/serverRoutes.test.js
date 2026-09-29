import { describe, it, expect } from 'vitest';
import healthHandler from '../api/health.js';

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
  });
});
