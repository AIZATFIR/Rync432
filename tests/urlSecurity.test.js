import { describe, it, expect } from 'vitest';
import { isForbiddenIp, validateStreamUrl } from '../server/streaming/urlSecurity.js';

describe('urlSecurity - SSRF & IP Validation', () => {
  describe('isForbiddenIp', () => {
    it('blocks IPv4 loopback (127.0.0.1 - 127.255.255.255)', () => {
      expect(isForbiddenIp('127.0.0.1')).toBe(true);
      expect(isForbiddenIp('127.1.2.3')).toBe(true);
    });

    it('blocks IPv4 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)', () => {
      expect(isForbiddenIp('10.0.0.1')).toBe(true);
      expect(isForbiddenIp('10.255.255.255')).toBe(true);
      expect(isForbiddenIp('172.16.0.1')).toBe(true);
      expect(isForbiddenIp('172.31.255.255')).toBe(true);
      expect(isForbiddenIp('192.168.1.1')).toBe(true);
      expect(isForbiddenIp('192.168.0.254')).toBe(true);
    });

    it('blocks link-local & cloud metadata IPs (169.254.169.254)', () => {
      expect(isForbiddenIp('169.254.169.254')).toBe(true);
      expect(isForbiddenIp('169.254.1.1')).toBe(true);
    });

    it('blocks Carrier-grade NAT (100.64.0.0/10)', () => {
      expect(isForbiddenIp('100.64.0.1')).toBe(true);
      expect(isForbiddenIp('100.127.255.255')).toBe(true);
    });

    it('blocks IPv6 loopback, unspecified, and private/link-local', () => {
      expect(isForbiddenIp('::1')).toBe(true);
      expect(isForbiddenIp('::')).toBe(true);
      expect(isForbiddenIp('fc00::1')).toBe(true);
      expect(isForbiddenIp('fe80::1')).toBe(true);
      expect(isForbiddenIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('allows valid public IPs', () => {
      expect(isForbiddenIp('8.8.8.8')).toBe(false);
      expect(isForbiddenIp('1.1.1.1')).toBe(false);
      expect(isForbiddenIp('142.250.190.46')).toBe(false);
    });
  });

  describe('validateStreamUrl', () => {
    it('rejects invalid or empty URLs', async () => {
      const res1 = await validateStreamUrl('');
      expect(res1.valid).toBe(false);

      const res2 = await validateStreamUrl('not-a-url');
      expect(res2.valid).toBe(false);
    });

    it('rejects non-http/https protocols (file:, javascript:, data:, blob:)', async () => {
      const resFile = await validateStreamUrl('file:///etc/passwd');
      expect(resFile.valid).toBe(false);

      const resJs = await validateStreamUrl('javascript:alert(1)');
      expect(resJs.valid).toBe(false);

      const resData = await validateStreamUrl('data:audio/mp3;base64,AAAA');
      expect(resData.valid).toBe(false);
    });

    it('rejects localhost and loopback domains', async () => {
      const resLocal = await validateStreamUrl('http://localhost:3000/audio.mp3');
      expect(resLocal.valid).toBe(false);

      const resLocalIp = await validateStreamUrl('http://127.0.0.1:8080/audio.mp3');
      expect(resLocalIp.valid).toBe(false);

      const resMetadata = await validateStreamUrl('http://169.254.169.254/latest/meta-data');
      expect(resMetadata.valid).toBe(false);
    });

    it('allows valid public audio URLs', async () => {
      const resValid = await validateStreamUrl('https://8.8.8.8/sound.mp3');
      expect(resValid.valid).toBe(true);
      expect(resValid.parsedUrl).toBeDefined();
    });
  });
});
