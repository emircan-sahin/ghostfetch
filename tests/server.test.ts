import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GhostFetch, MaxRetriesExceededError, GhostFetchRequestError } from '../src';

// --- Test server ---

let port: number;
let requestCount: number;
const endpointHits = new Map<string, number>();

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
