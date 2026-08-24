import http from 'node:http';
import zlib from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GhostFetch, MaxRetriesExceededError, GhostFetchRequestError, InterceptorError } from '../src';

// --- Test server ---

let port: number;
let requestCount: number;
const endpointHits = new Map<string, number>();

// 1x1 transparent PNG — byte 0x89 and the trailing chunk are not valid UTF-8,
// so a client that round-trips through a string will corrupt this.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const server = http.createServer((req, res) => {
  requestCount++;
  const url = req.url ?? '/';
  endpointHits.set(url, (endpointHits.get(url) ?? 0) + 1);

  if (url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'success' }));
    return;
  }

  if (url === '/rate-limit') {
    res.writeHead(429);
    res.end('rate limit exceeded');
    return;
  }

  if (url === '/unavailable') {
    res.writeHead(503);
    res.end('service unavailable');
    return;
  }

  if (url === '/fake-200') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limit', data: null }));
    return;
  }

  if (url === '/auth-error') {
    res.writeHead(401);
    res.end('unauthorized');
    return;
  }

  if (url === '/cloudflare') {
    res.writeHead(403);
    res.end('<html><head><title>Just a moment...</title></head><body>cf_chl_opt Checking your browser</body></html>');
    return;
  }

  // First 2 hits to /recover return 429, 3rd returns 200
  if (url === '/recover') {
    const hits = endpointHits.get('/recover') ?? 0;
    if (hits <= 2) {
      res.writeHead(429);
      res.end('rate limit');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ recovered: true }));
    }
    return;
  }

  if (url === '/no-content') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url === '/echo' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ received: JSON.parse(body), headers: req.headers }));
    });
    return;
  }

  if (url === '/echo-raw' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body, contentType: req.headers['content-type'], headers: req.headers }));
    });
    return;
  }

  if (url === '/redirect') {
    res.writeHead(302, { location: `http://localhost:${port}/ok` });
    res.end();
    return;
  }

  if (url === '/echo-cookies') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ cookie: req.headers['cookie'] ?? null }));
    return;
  }

  // Mixed-case header names + repeated Set-Cookie
  if (url === '/headers') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Custom-Header': 'CaseSensitiveValue',
      'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'],
    });
    res.end('{}');
    return;
  }

  // Body that must survive verbatim: exotic whitespace + an integer past Number.MAX_SAFE_INTEGER
  if (url === '/raw-json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{\n  "id": 12345678901234567890,\n  "name": "keep   spacing"\n}');
    return;
  }

  // 429 + Retry-After on the first hit, then 200
  if (url === '/retry-after') {
    const hits = endpointHits.get('/retry-after') ?? 0;
    if (hits <= 1) {
      res.writeHead(429, { 'retry-after': '1' });
      res.end('slow down');
    } else {
      res.writeHead(200);
      res.end('ok');
    }
    return;
  }

  // Raw PNG bytes — must survive without UTF-8 mangling
  if (url === '/binary') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG_BYTES);
    return;
  }

  // Cloudflare signalling a challenge via header on a non-403 status
  if (url === '/cf-header') {
    res.writeHead(200, { 'cf-mitigated': 'challenge' });
    res.end('<html></html>');
    return;
  }

  if (url === '/set-cookie') {
    res.writeHead(200, { 'Set-Cookie': ['sid=session-value; Path=/'], 'content-type': 'text/plain' });
    res.end('logged in');
    return;
  }

  if (url === '/gzip') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(Buffer.from('{"compressed":true}')));
    return;
  }

  if (url === '/brotli') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
    res.end(zlib.brotliCompressSync(Buffer.from('{"compressed":"br"}')));
    return;
  }

  // Claims gzip but sends plain text — the body must still be readable
  if (url === '/lying-encoding') {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end('not actually compressed');
    return;
  }

  // Never responds — used for timeout testing
  if (url === '/hang') {
    return;
  }

  // Returns 429 for first N hits, then 200
  if (url === '/scoped-limit') {
    const hits = endpointHits.get('/scoped-limit') ?? 0;
    if (hits <= 3) {
      res.writeHead(429);
      res.end('rate limit');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

function u(path: string) {
  return `http://localhost:${port}${path}`;
}

// Single shared CycleTLS client — avoids port conflict
let client: GhostFetch;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  client = new GhostFetch({ retry: { delays: [] } });
});

beforeEach(() => {
  requestCount = 0;
  endpointHits.clear();
});

afterAll(async () => {
  await client.destroy();
  server.close();
});

// --- Tests ---

describe('basic requests', () => {
  it('GET 200 returns response', async () => {
    const res = await client.get(u('/ok'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ message: 'success' });
  });

  it('POST with JSON body sets content-type', async () => {
    const res = await client.post(u('/echo'), {
      body: { hello: 'world' },
    });
    const data = JSON.parse(res.body);
    expect(data.received).toEqual({ hello: 'world' });
    expect(data.headers['content-type']).toBe('application/json');
  });

  it('204 No Content returns empty body', async () => {
    const res = await client.get(u('/no-content'));
    expect(res.status).toBe(204);
    expect(res.body).toBe('');
  });

  it('401 returns response without retry (no interceptor)', async () => {
    const res = await client.get(u('/auth-error'));
    expect(res.status).toBe(401);
    expect(res.body).toBe('unauthorized');
  });
});

describe('default retry statuses', () => {
  it('429 triggers retry and throws MaxRetriesExceededError', async () => {
    try {
      await client.get(u('/rate-limit'), { retry: { delays: [50, 50] } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      const e = err as MaxRetriesExceededError;
      expect(e.attempts).toBe(3);
      expect(e.lastError.status).toBe(429);
    }
  });

  it('503 triggers retry and throws MaxRetriesExceededError', async () => {
    try {
      await client.get(u('/unavailable'), { retry: { delays: [50, 50] } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      const e = err as MaxRetriesExceededError;
      expect(e.lastError.status).toBe(503);
    }
  });

  it('429 then recovery returns successful response', async () => {
    const res = await client.get(u('/recover'), { retry: { delays: [50, 50] } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ recovered: true });
  });
});

describe('cloudflare detection', () => {
  it('throws CloudflareJSChallengeError on CF challenge page', async () => {
    try {
      await client.get(u('/cloudflare'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GhostFetchRequestError);
      expect((err as GhostFetchRequestError).message).toContain('Cloudflare JS challenge');
    }
  });
});

describe('instance-level interceptor', () => {
  it('detects soft error in 200 body and retries', async () => {
    client.addInterceptor({
      name: 'soft-error',
      match: (url) => url.includes('/fake-200'),
      check: (res) => {
        const body = JSON.parse(res.body);
        if (body.error === 'rate limit') return 'retry';
        return null;
      },
    });

    try {
      await client.get(u('/fake-200'), { retry: { delays: [50, 50] } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      const e = err as MaxRetriesExceededError;
      expect(e.lastError.message).toContain('soft-error');
      expect(e.lastError.status).toBe(200);
    }

    client.removeInterceptor('soft-error');
  });

  it('skip returns response immediately', async () => {
    client.addInterceptor({
      name: 'skip-401',
      match: (url) => url.includes('/auth-error'),
      check: (res) => res.status === 401 ? 'skip' : null,
    });

    const res = await client.get(u('/auth-error'));
    expect(res.status).toBe(401);

    client.removeInterceptor('skip-401');
  });

  it('bypasses default 429 handling when matched', async () => {
    client.addInterceptor({
      name: 'custom-429',
      match: (url) => url.includes('/rate-limit'),
      check: (res) => res.status === 429 ? 'skip' : null,
    });

    const res = await client.get(u('/rate-limit'));
    expect(res.status).toBe(429);

    client.removeInterceptor('custom-429');
  });
});

describe('request-level interceptor', () => {
  it('overrides default 429 behavior', async () => {
    const res = await client.get(u('/rate-limit'), {
      interceptor: { check: (r) => r.status === 429 ? 'skip' : null },
    });
    expect(res.status).toBe(429);
  });

  it('takes priority over instance interceptor', async () => {
    client.addInterceptor({
      name: 'instance-retry',
      match: (url) => url.includes('/auth-error'),
      check: () => 'retry',
    });

    const res = await client.get(u('/auth-error'), {
      interceptor: { check: (r) => r.status === 401 ? 'skip' : null },
    });
    expect(res.status).toBe(401);

    client.removeInterceptor('instance-retry');
  });
});

describe('CycleTLS v2 options', () => {
  it('POST with URLSearchParams sets correct content-type', async () => {
    const res = await client.post(u('/echo-raw'), {
      body: new URLSearchParams({ username: 'foo', password: 'bar' }),
    });
    const data = JSON.parse(res.body);
    expect(data.contentType).toBe('application/x-www-form-urlencoded');
    expect(data.body).toContain('username=foo');
    expect(data.body).toContain('password=bar');
  });

  it('URLSearchParams does not override explicit content-type', async () => {
    const res = await client.post(u('/echo-raw'), {
      body: new URLSearchParams({ a: '1' }),
      headers: { 'content-type': 'text/plain' },
    });
    const data = JSON.parse(res.body);
    expect(data.contentType).toBe('text/plain');
  });

  it('disableRedirect returns 302 instead of following', async () => {
    const res = await client.get(u('/redirect'), {
      disableRedirect: true,
    });
    expect(res.status).toBe(302);
  });

  it('without disableRedirect, follows redirect to /ok', async () => {
    const res = await client.get(u('/redirect'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ message: 'success' });
  });

  it('config-level disableRedirect applies to all requests', async () => {
    const noRedirectClient = new GhostFetch({
      retry: { delays: [] },
      disableRedirect: true,
    });

    const res = await noRedirectClient.get(u('/redirect'));
    expect(res.status).toBe(302);
    await noRedirectClient.destroy();
  });

  it('per-request disableRedirect overrides config', async () => {
    const noRedirectClient = new GhostFetch({
      retry: { delays: [] },
      disableRedirect: true,
    });

    const res = await noRedirectClient.get(u('/redirect'), {
      disableRedirect: false,
    });
    expect(res.status).toBe(200);
    await noRedirectClient.destroy();
  });

  it('config-level cookies are sent', async () => {
    const cookieClient = new GhostFetch({
      retry: { delays: [] },
      cookies: { session: 'abc123', lang: 'en' },
    });

    const res = await cookieClient.get(u('/echo-cookies'));
    const data = JSON.parse(res.body);
    expect(data.cookie).toContain('session=abc123');
    expect(data.cookie).toContain('lang=en');
    await cookieClient.destroy();
  });

  it('per-request cookies replace config cookies', async () => {
    const cookieClient = new GhostFetch({
      retry: { delays: [] },
      cookies: { session: 'old' },
    });

    const res = await cookieClient.get(u('/echo-cookies'), {
      cookies: { token: 'new' },
    });
    const data = JSON.parse(res.body);
    expect(data.cookie).toContain('token=new');
    expect(data.cookie).not.toContain('session=old');
    await cookieClient.destroy();
  });
});

describe('retry with delays', () => {
  it('delays: [] means no retry — single attempt', async () => {
    try {
      await client.get(u('/rate-limit'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      expect((err as MaxRetriesExceededError).attempts).toBe(1);
    }
  });

  it('per-request delays override instance delays', async () => {
    const res = await client.get(u('/recover'), {
      retry: { delays: [50, 50] },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ recovered: true });
  });
});

describe('scopedBan', () => {
  it('bans proxy only for matching scope, not other URLs', async () => {
    const scopedClient = new GhostFetch({
      retry: { delays: [10, 10, 10] },
      ban: { maxFailures: 1, duration: 60000 },
    });

    // Add interceptor that returns scopedBan on 429
    scopedClient.addInterceptor({
      name: 'scoped-429',
      match: (url) => url.includes('/scoped-limit') || url.includes('/rate-limit'),
      check: (res) => res.status === 429 ? 'scopedBan' : null,
    });

    // This should fail — all retries hit 429 on /rate-limit
    // After first 429, proxy is scoped-banned for localhost scope
    // But since there's no other proxy, retries proceed without proxy
    try {
      await scopedClient.get(u('/rate-limit'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      const e = err as MaxRetriesExceededError;
      expect(e.lastError.message).toContain('scopedBan');
    }

    // /ok on same host should still work (no proxy needed)
    const okRes = await scopedClient.get(u('/ok'));
    expect(okRes.status).toBe(200);

    await scopedClient.destroy();
  });

  it('request-level interceptor can return scopedBan', async () => {
    const scopedClient = new GhostFetch({
      retry: { delays: [10] },
      ban: { maxFailures: 1, duration: 60000 },
    });

    try {
      await scopedClient.get(u('/rate-limit'), {
        interceptor: { check: (r) => r.status === 429 ? 'scopedBan' : null },
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      const e = err as MaxRetriesExceededError;
      expect(e.lastError.message).toContain('scopedBan');
    }

    await scopedClient.destroy();
  });

  it('custom scopeKey extracts path-based scope', async () => {
    const scopedClient = new GhostFetch({
      retry: { delays: [10] },
      ban: {
        maxFailures: 1,
        duration: 60000,
        scopeKey: (url) => {
          const u = new URL(url);
          return `${u.hostname}:${u.pathname}`;
        },
      },
    });

    scopedClient.addInterceptor({
      name: 'path-scoped',
      match: () => true,
      check: (res) => res.status === 429 ? 'scopedBan' : null,
    });

    try {
      await scopedClient.get(u('/rate-limit'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MaxRetriesExceededError);
      const e = err as MaxRetriesExceededError;
      expect(e.lastError.message).toContain('scopedBan');
      // Scope should include path
      expect(e.lastError.message).toContain('/rate-limit');
    }

    await scopedClient.destroy();
  });
});

describe('timeout enforcement', () => {
  it('5s timeout aborts hanging request before server responds', async () => {
    const start = Date.now();
    try {
      await client.get(u('/hang'), { timeout: 5000 });
      expect.unreachable('should have thrown');
    } catch (err) {
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(8000); // should not take much longer than 5s
      expect(elapsed).toBeGreaterThanOrEqual(4500); // should be close to 5s
      const lastError = (err as MaxRetriesExceededError).lastError;
      expect(lastError.message).toContain('timeout');
    }
  });

  it('0.01s timeout kills request immediately', async () => {
    const start = Date.now();
    try {
      await client.get(u('/hang'), { timeout: 10 });
      expect.unreachable('should have thrown');
    } catch (err) {
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000); // should be near-instant
      const lastError = (err as MaxRetriesExceededError).lastError;
      expect(lastError.message).toContain('timeout');
    }
  });

  it('timeout error is classified as ambiguous (proxy not penalized)', async () => {
    try {
      await client.get(u('/hang'), { timeout: 10 });
      expect.unreachable('should have thrown');
    } catch (err) {
      const lastError = (err as MaxRetriesExceededError).lastError;
      expect(lastError.type).toBe('ambiguous');
    }
  });
});


describe('response headers', () => {
  it('lower-cases header names regardless of what the server sent', async () => {
    const res = await client.get(u('/headers'));
    expect(res.headers['x-custom-header']).toBe('CaseSensitiveValue');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('exposes repeated set-cookie values separately, not flattened into headers', async () => {
    const res = await client.get(u('/headers'));
    expect(res.setCookie).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('setCookie is an empty array when the server sends none', async () => {
    const res = await client.get(u('/ok'));
    expect(res.setCookie).toEqual([]);
  });
});

describe('body fidelity', () => {
  it('returns the raw body verbatim — no JSON re-serialization', async () => {
    const res = await client.get(u('/raw-json'));
    expect(res.body).toBe('{\n  "id": 12345678901234567890,\n  "name": "keep   spacing"\n}');
  });
});

describe('OPTIONS method', () => {
  it('sends an OPTIONS request', async () => {
    const res = await client.options(u('/ok'));
    expect(res.status).toBe(200);
  });
});


describe('Retry-After', () => {
  it('waits the duration the server asked for instead of the configured delay', async () => {
    const start = Date.now();
    // Configured delay is 10ms; the server asks for 1s and must win
    const res = await client.get(u('/retry-after'), { retry: { delays: [10, 10] } });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  }, 10000);

  it('respectRetryAfter: false falls back to the configured delay', async () => {
    const start = Date.now();
    const res = await client.get(u('/retry-after'), {
      retry: { delays: [10, 10], respectRetryAfter: false },
    });

    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(900);
  });

  it('maxRetryAfter caps how long a server can make us wait', async () => {
    const start = Date.now();
    const res = await client.get(u('/retry-after'), {
      retry: { delays: [10, 10], maxRetryAfter: 100 },
    });

    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(900);
  });
});

describe('binary responses', () => {
  it('returns PNG bytes intact', async () => {
    const res = await client.get(u('/binary'));
    const buf = res.buffer();

    expect(buf).toBeInstanceOf(Buffer);
    // PNG magic number — the first byte is 0x89, which UTF-8 decoding destroys
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(buf.length).toBe(70);
  });

  it('arrayBuffer() exposes the same bytes', async () => {
    const res = await client.get(u('/binary'));
    expect(Buffer.from(res.arrayBuffer())).toEqual(res.buffer());
  });
});

describe('cloudflare handling', () => {
  it('detects a challenge from the cf-mitigated header at status 200', async () => {
    try {
      await client.get(u('/cf-header'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Cloudflare JS challenge');
    }
  });

  it("cloudflare: 'retry' rotates instead of failing instantly, then throws the CF error", async () => {
    const cfClient = new GhostFetch({ cloudflare: 'retry', retry: { delays: [10, 10] } });

    try {
      await cfClient.get(u('/cloudflare'));
      expect.unreachable('should have thrown');
    } catch (err) {
      // Still a CloudflareJSChallengeError so existing catch blocks keep working
      expect((err as Error).name).toBe('CloudflareJSChallengeError');
      // ...but it retried rather than giving up on the first response
      expect(endpointHits.get('/cloudflare')).toBe(3);
    }

    await cfClient.destroy();
  });
});

describe('sessions', () => {
  it('replays cookies the server set on a later request', async () => {
    const s = client.session('test-session');

    const login = await s.get(u('/set-cookie'));
    expect(login.setCookie).toEqual(['sid=session-value; Path=/']);

    const echoed = await s.get(u('/echo-cookies'));
    expect(JSON.parse(echoed.body).cookie).toContain('sid=session-value');

    client.destroySession('test-session');
  });

  it('does not leak session cookies to plain client requests', async () => {
    const s = client.session('isolated');
    await s.get(u('/set-cookie'));

    const plain = await client.get(u('/echo-cookies'));
    expect(JSON.parse(plain.body).cookie).toBeNull();

    client.destroySession('isolated');
  });

  it('keeps separate jars per session key', async () => {
    const a = client.session('a');
    const b = client.session('b');

    await a.get(u('/set-cookie'));

    expect(JSON.parse((await a.get(u('/echo-cookies'))).body).cookie).toContain('sid=');
    expect(JSON.parse((await b.get(u('/echo-cookies'))).body).cookie).toBeNull();

    client.destroySession('a');
    client.destroySession('b');
  });

  it('returns the same instance for the same key and a new one after destroy', () => {
    const first = client.session('same');
    expect(client.session('same')).toBe(first);

    expect(client.destroySession('same')).toBe(true);
    expect(client.session('same')).not.toBe(first);
    client.destroySession('same');
  });

  it('reset() clears the jar', async () => {
    const s = client.session('resettable');
    await s.get(u('/set-cookie'));
    expect(s.cookies.length).toBe(1);

    s.reset();
    expect(s.cookies).toEqual([]);
    expect(JSON.parse((await s.get(u('/echo-cookies'))).body).cookie).toBeNull();

    client.destroySession('resettable');
  });

  it('per-request cookies layer on top of the jar', async () => {
    const s = client.session('layered');
    await s.get(u('/set-cookie'));

    const res = await s.get(u('/echo-cookies'), { cookies: { extra: 'yes' } });
    const cookie = JSON.parse(res.body).cookie;
    expect(cookie).toContain('sid=session-value');
    expect(cookie).toContain('extra=yes');

    client.destroySession('layered');
  });
});

describe('idleTimeout', () => {
  it('closes the transport when idle, and reopens it for the next request', async () => {
    const idleClient = new GhostFetch({ retry: { delays: [] }, idleTimeout: 200 });

    expect((await idleClient.get(u('/ok'))).status).toBe(200);
    expect((idleClient as unknown as { cycleTLS: unknown }).cycleTLS).not.toBeNull();

    await new Promise((r) => setTimeout(r, 900));
    expect((idleClient as unknown as { cycleTLS: unknown }).cycleTLS).toBeNull();

    // Transport comes back on demand
    expect((await idleClient.get(u('/ok'))).status).toBe(200);

    await idleClient.destroy();
  }, 15000);

  it('does not close while a request is still in flight', async () => {
    const idleClient = new GhostFetch({ retry: { delays: [] }, idleTimeout: 50 });

    const slow = idleClient.get(u('/hang'), { timeout: 700 }).catch(() => 'failed');
    await new Promise((r) => setTimeout(r, 400));
    expect((idleClient as unknown as { cycleTLS: unknown }).cycleTLS).not.toBeNull();

    await slow;
    await idleClient.destroy();
  }, 15000);
});


describe('compressed responses', () => {
  it('decodes a gzip body', async () => {
    const res = await client.get(u('/gzip'), { headers: { 'accept-encoding': 'gzip' } });
    expect(res.json()).toEqual({ compressed: true });
  });

  it('decodes a brotli body', async () => {
    const res = await client.get(u('/brotli'), { headers: { 'accept-encoding': 'br' } });
    expect(res.json()).toEqual({ compressed: 'br' });
  });

  it('falls back to the raw bytes when content-encoding lies', async () => {
    const res = await client.get(u('/lying-encoding'), { headers: { 'accept-encoding': 'gzip' } });
    expect(res.body).toBe('not actually compressed');
  });
});

describe('browser presets', () => {
  it('sends the preset headers, in order, with the caller layered on top', async () => {
    const chrome = new GhostFetch({ browser: 'chrome', retry: { delays: [] } });

    const res = await chrome.post(u('/echo'), {
      body: { x: 1 },
      headers: { 'accept-language': 'tr-TR,tr;q=0.9' },
    });
    const sent = JSON.parse(res.body).headers;

    expect(sent['user-agent']).toContain('Chrome/131');
    expect(sent['sec-ch-ua']).toContain('Google Chrome');
    expect(sent['sec-fetch-mode']).toBe('navigate');
    // caller override wins over the preset default of en-US
    expect(sent['accept-language']).toBe('tr-TR,tr;q=0.9');

    await chrome.destroy();
  });

  it('an explicit userAgent replaces the preset one', async () => {
    const custom = new GhostFetch({
      browser: 'chrome',
      userAgent: 'my-crawler/1.0',
      retry: { delays: [] },
    });

    const res = await custom.post(u('/echo'), { body: {} });
    expect(JSON.parse(res.body).headers['user-agent']).toBe('my-crawler/1.0');

    await custom.destroy();
  });
});

describe('session HTTP verbs', () => {
  it('every verb routes through the session', async () => {
    const s = client.session('verbs');

    expect((await s.get(u('/ok'))).status).toBe(200);
    expect((await s.post(u('/echo'), { body: { a: 1 } })).status).toBe(200);
    expect((await s.put(u('/ok'))).status).toBe(200);
    expect((await s.patch(u('/ok'))).status).toBe(200);
    expect((await s.delete(u('/ok'))).status).toBe(200);
    expect((await s.head(u('/ok'))).status).toBe(200);
    expect((await s.options(u('/ok'))).status).toBe(200);

    client.destroySession('verbs');
  }, 30000);

  it('an unnamed session gets its own key and jar', async () => {
    const a = client.session();
    const b = client.session();

    expect(a.key).not.toBe(b.key);
    await a.get(u('/set-cookie'));
    expect(a.cookies.length).toBe(1);
    expect(b.cookies.length).toBe(0);

    client.destroySession(a.key);
    client.destroySession(b.key);
  });

  it('destroySession reports whether anything was there', () => {
    expect(client.destroySession('never-existed')).toBe(false);
  });

  it('a failed request does not leave the session pinned', async () => {
    const s = client.session('failing');
    await expect(s.get(u('/rate-limit'), { retry: { delays: [] } })).rejects.toThrow();
    expect(s.proxy).toBeNull();
    client.destroySession('failing');
  });
});


describe('header merging is case-insensitive', () => {
  it('a TitleCase per-request header overrides a lower-case preset default', async () => {
    const chrome = new GhostFetch({ browser: 'chrome', retry: { delays: [] } });

    const res = await chrome.post(u('/echo'), {
      body: {},
      headers: { 'Accept-Language': 'tr-TR' },
    });

    expect(JSON.parse(res.body).headers['accept-language']).toBe('tr-TR');
    await chrome.destroy();
  }, 30000);

  it('a per-request header overrides a config header of different case', async () => {
    const c = new GhostFetch({ headers: { 'x-token': 'from-config' }, retry: { delays: [] } });

    const res = await c.post(u('/echo'), { body: {}, headers: { 'X-Token': 'from-request' } });
    expect(JSON.parse(res.body).headers['x-token']).toBe('from-request');

    await c.destroy();
  }, 30000);

  it('does not send the same header twice under different casing', async () => {
    const c = new GhostFetch({ headers: { 'X-Dup': 'a' }, retry: { delays: [] } });

    const res = await c.post(u('/echo'), { body: {}, headers: { 'x-dup': 'b' } });
    // Node joins repeated headers with ", " — a single value proves there was only one
    expect(JSON.parse(res.body).headers['x-dup']).toBe('b');

    await c.destroy();
  }, 30000);
});


describe('a throwing interceptor is the caller\'s bug, not a retry', () => {
  it('surfaces InterceptorError immediately without retrying', async () => {
    const c = new GhostFetch({ retry: { delays: [10, 10] } });
    c.addInterceptor({
      name: 'buggy',
      match: () => true,
      check: (res) => {
        // The classic: assuming the body is JSON
        return (JSON.parse(res.body) as { nope: { deep: string } }).nope.deep === 'x' ? 'retry' : null;
      },
    });

    const before = endpointHits.get('/ok') ?? 0;

    await expect(c.get(u('/ok'))).rejects.toMatchObject({
      name: 'InterceptorError',
      interceptor: 'buggy',
    });

    // Exactly one attempt — the bug was not retried into a MaxRetriesExceededError
    expect((endpointHits.get('/ok') ?? 0) - before).toBe(1);

    await c.destroy();
  }, 30000);

  it('keeps the original error as the cause', async () => {
    const c = new GhostFetch({ retry: { delays: [] } });
    const boom = new TypeError('boom');

    try {
      await c.get(u('/ok'), { interceptor: { check: () => { throw boom; } } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as InterceptorError).cause).toBe(boom);
      expect((err as Error).message).toContain('boom');
    }

    await c.destroy();
  }, 30000);
});
