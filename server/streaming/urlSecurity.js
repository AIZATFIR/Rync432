import dns from 'dns';
import { promisify } from 'util';
import net from 'net';

const lookupAsync = promisify(dns.lookup);

/**
 * Checks whether an IPv4 or IPv6 address is private, loopback, link-local, or cloud metadata.
 * @param {string} ip
 * @returns {boolean} true if forbidden
 */
export function isForbiddenIp(ip) {
  if (!ip) return true;

  // IPv6
  if (net.isIPv6(ip)) {
    const cleanIp = ip.toLowerCase();
    // Loopback
    if (cleanIp === '::1' || cleanIp === '0:0:0:0:0:0:0:1') return true;
    // Unspecified
    if (cleanIp === '::' || cleanIp === '0:0:0:0:0:0:0:0') return true;
    // Unique local (fc00::/7)
    if (cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) return true;
    // Link-local (fe80::/10)
    if (cleanIp.startsWith('fe8') || cleanIp.startsWith('fe9') || cleanIp.startsWith('fea') || cleanIp.startsWith('feb')) return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    if (cleanIp.startsWith('::ffff:')) {
      const v4Part = cleanIp.substring(7);
      return isForbiddenIp(v4Part);
    }
    return false;
  }

  // IPv4
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;

    const [a, b, c, d] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;

    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;

    // 10.0.0.0/8 (Private)
    if (a === 10) return true;

    // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation/TEST-NET)
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;

    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (a >= 224) return true;

    return false;
  }

  return true;
}

/**
 * Validates a target URL against SSRF vulnerabilities.
 * @param {string} rawUrl
 * @returns {Promise<{ valid: boolean, error?: string, parsedUrl?: URL, resolvedIp?: string }>}
 */
export async function validateStreamUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'INVALID_URL: URL tidak boleh kosong' };
  }

  const trimmed = rawUrl.trim();

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return { valid: false, error: 'INVALID_URL: Format URL tidak valid' };
  }

  // 1. Protocol check: strictly http: or https:
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'INVALID_URL: Protokol harus HTTP atau HTTPS' };
  }

  // 2. Reject credentials in URL (user:pass@host)
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'INVALID_URL: URL dengan kredensial tidak diizinkan' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 3. String blacklist check
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    return { valid: false, error: 'FORBIDDEN_TARGET: Akses ke host lokal/internal diblokir' };
  }

  // 4. If hostname is already a raw IP
  if (net.isIP(hostname)) {
    if (isForbiddenIp(hostname)) {
      return { valid: false, error: 'FORBIDDEN_TARGET: Akses ke alamat IP privat/loopback diblokir' };
    }
    return { valid: true, parsedUrl: parsed, resolvedIp: hostname };
  }

  // 5. DNS Resolution check
  try {
    const lookupResult = await lookupAsync(hostname, { all: true });
    if (!lookupResult || lookupResult.length === 0) {
      return { valid: false, error: 'DNS_LOOKUP_FAILED: Domain tidak dapat diresolusi' };
    }

    for (const record of lookupResult) {
      if (isForbiddenIp(record.address)) {
        return {
          valid: false,
          error: `FORBIDDEN_TARGET: Domain merujuk ke IP terlarang (${record.address})`
        };
      }
    }

    return {
      valid: true,
      parsedUrl: parsed,
      resolvedIp: lookupResult[0].address
    };
  } catch (err) {
    return {
      valid: false,
      error: `DNS_LOOKUP_FAILED: Gagal resolusi domain (${err.message || 'DNS error'})`
    };
  }
}
