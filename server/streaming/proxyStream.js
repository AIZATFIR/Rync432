import http from 'http';
import https from 'https';
import { validateStreamUrl } from './urlSecurity.js';
import { pipeline } from 'stream';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Performs a safe upstream fetch with redirect re-validation and SSRF protection.
 * @param {string} targetUrl
 * @param {object} clientHeaders
 * @param {AbortSignal} abortSignal
 * @param {number} redirectCount
 * @returns {Promise<{ response: http.IncomingMessage, finalUrl: string }>}
 */
async function fetchUpstream(targetUrl, clientHeaders = {}, abortSignal, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error('TOO_MANY_REDIRECTS: Terlalu banyak pengalihan URL');
  }

  const securityCheck = await validateStreamUrl(targetUrl);
  if (!securityCheck.valid) {
    throw new Error(securityCheck.error || 'INVALID_URL');
  }

  const parsed = securityCheck.parsedUrl;
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Rync432/1.0',
    'Accept': 'audio/*, */*;q=0.8'
  };

  // Forward Range header if present
  if (clientHeaders.range || clientHeaders.Range) {
    requestHeaders['Range'] = clientHeaders.range || clientHeaders.Range;
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: requestHeaders,
      timeout: REQUEST_TIMEOUT_MS
    };

    const upstreamReq = transport.request(reqOptions, (res) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // Consume stream to avoid leaking sockets
        const redirectUrl = new URL(res.headers.location, parsed.href).href;
        fetchUpstream(redirectUrl, clientHeaders, abortSignal, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      settled = true;
      resolve({ response: res, finalUrl: targetUrl });
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      if (!settled) {
        settled = true;
        reject(new Error('STREAM_TIMEOUT: Koneksi ke sumber audio timeout'));
      }
    });

    upstreamReq.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`UPSTREAM_ERROR: ${err.message}`));
      }
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        upstreamReq.destroy();
        if (!settled) {
          settled = true;
          reject(new Error('CLIENT_ABORT: Request dibatalkan'));
        }
      });
    }

    upstreamReq.end();
  });
}

/**
 * HTTP handler for `/api/stream`
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
export async function handleStreamProxy(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  let rawUrl;
  try {
    const parsedReq = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    rawUrl = parsedReq.searchParams.get('url');
  } catch (e) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'INVALID_REQUEST: Query parameter url tidak valid' }));
  }

  if (!rawUrl) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'INVALID_URL: Parameter ?url= harus disertakan' }));
  }

  const abortController = new AbortController();

  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const { response: upstreamRes } = await fetchUpstream(rawUrl, req.headers, abortController.signal);

    const statusCode = upstreamRes.statusCode || 200;
    res.statusCode = statusCode;

    // Forward crucial audio headers
    const contentType = upstreamRes.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (upstreamRes.headers['content-length']) {
      res.setHeader('Content-Length', upstreamRes.headers['content-length']);
    }

    if (upstreamRes.headers['content-range']) {
      res.setHeader('Content-Range', upstreamRes.headers['content-range']);
    }

    if (upstreamRes.headers['cache-control']) {
      res.setHeader('Cache-Control', upstreamRes.headers['cache-control']);
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    // If HEAD request, close early
    if (req.method === 'HEAD') {
      upstreamRes.resume();
      return res.end();
    }

    // Direct stream piping without buffering the entire audio file in memory
    pipeline(upstreamRes, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Stream piping error:', err.message);
      }
    });

  } catch (err) {
    if (res.headersSent) {
      return res.end();
    }

    const message = err.message || 'Gagal mengambil stream audio';
    let status = 500;
    if (message.includes('INVALID_URL') || message.includes('FORBIDDEN_TARGET')) status = 403;
    if (message.includes('DNS_LOOKUP_FAILED')) status = 502;
    if (message.includes('STREAM_TIMEOUT')) status = 504;

    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: message,
      status
    }));
  }
}
