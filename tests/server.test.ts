import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GhostFetch, MaxRetriesExceededError, GhostFetchRequestError } from '../src';

// --- Test server ---

let port: number;
let requestCount: number;

const server = http.createServer((req, res) => {
  requestCount++;
  const url = req.url ?? '/';

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

  // First 2 requests return 429, 3rd returns 200
  if (url === '/recover') {
    if (requestCount <= 2) {
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
