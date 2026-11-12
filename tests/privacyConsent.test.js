import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasCurrentPrivacyConsent, PRIVACY_CONSENT_KEY, PRIVACY_CONSENT_VERSION, savePrivacyConsent } from '../public/js/privacy/consent.js';

afterEach(() => vi.unstubAllGlobals());

describe('Rync privacy consent gate', () => {
  it('requires a current explicit consent record before starting the app', () => {
    const storage = { getItem: vi.fn(() => null) };
    expect(hasCurrentPrivacyConsent(storage)).toBe(false);
    expect(storage.getItem).toHaveBeenCalledWith(PRIVACY_CONSENT_KEY);
  });

  it('accepts only a recorded agreement for the current policy version', () => {
    const storage = { getItem: () => JSON.stringify({ version: PRIVACY_CONSENT_VERSION, acceptedAt: 123 }) };
    expect(hasCurrentPrivacyConsent(storage)).toBe(true);
    expect(hasCurrentPrivacyConsent({ getItem: () => JSON.stringify({ version: 'old', acceptedAt: 123 }) })).toBe(false);
    expect(hasCurrentPrivacyConsent({ getItem: () => JSON.stringify({ version: PRIVACY_CONSENT_VERSION }) })).toBe(false);
  });

  it('fails closed when browser storage access throws', () => {
    const storage = { getItem: () => { throw new Error('storage blocked'); } };
    const writeBlocked = { setItem: () => { throw new Error('storage blocked'); } };

    expect(hasCurrentPrivacyConsent(storage)).toBe(false);
    expect(savePrivacyConsent(writeBlocked, 456)).toBe(false);
  });

  it('persists agreement time and handles unavailable storage', () => {
    const values = new Map();
    const storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) };
    expect(savePrivacyConsent(storage, 456)).toBe(true);
    expect(JSON.parse(values.get(PRIVACY_CONSENT_KEY))).toEqual({ version: PRIVACY_CONSENT_VERSION, acceptedAt: 456 });
    expect(hasCurrentPrivacyConsent(storage)).toBe(true);
    expect(savePrivacyConsent(null, 456)).toBe(false);
  });

  it('does not load the Rync app bundle before the consent gate', () => {
    const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
    const html = readFileSync(htmlPath, 'utf8');

    expect(html).toContain('<div class="app-container" id="appShell" inert aria-hidden="true">');
    expect(html).toContain('id="privacyGate" role="dialog" aria-modal="true"');
    expect(html).toContain('src="/js/privacyGate.js"');
    expect(html).not.toContain('src="/js/app.js"');
    expect(html).not.toContain('cdnjs.cloudflare.com');
    expect(html).toContain('href="/privacy.html"');
    expect(html).toContain('href="/terms.html"');
    expect(html).toContain('href="https://www.youtube.com/t/terms"');
    const gateJs = readFileSync(fileURLToPath(new URL('../public/js/privacyGate.js', import.meta.url)), 'utf8');
    expect(gateJs).toContain("script.src = 'https://cdnjs.cloudflare.com");
    expect(gateJs).toContain('loadRealtimeClient();');
  });
});
