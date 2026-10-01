import http from 'node:http';
import net from 'node:net';
import { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GhostFetch, NoProxyAvailableError, MaxRetriesExceededError } from '../src';

/**
 * These exercise the proxy paths end to end against real local proxies — health
 * check, country resolution, banning, refresh, and session stickiness. CycleTLS
 * tunnels through a proxy with CONNECT even for plain http targets, so the fixture
 * below has to speak CONNECT.
 */

// --- target server ---

let targetPort: number;
let targetHits = 0;

const target = http.createServer((req, res) => {
  targetHits++;

  if (req.url === '/geo-us') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ip: '1.2.3.4', country: 'US' }));
    return;
  }
  if (req.url === '/geo-de') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ip: '5.6.7.8', country: 'DE' }));
    return;
  }
  if (req.url === '/no-country') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ip: '9.9.9.9' }));
    return;
  }
  if (req.url === '/blocked') {
    res.writeHead(403);
    res.end('blocked');
    return;
  }

  // Accepts the connection and never answers — CycleTLS hands its own timeout to Go
  // and does not enforce it here, so this is what leaves a probe unsettled
  if (req.url === '/never-answers') {
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

// --- CONNECT-capable forward proxy ---

interface TestProxy {
  url: string;
  hits: number;
  /** Tunnels torn down because they carried `dropPath`. */
  drops: number;
  close: () => Promise<void>;
}

interface ProxyBehaviour {
  /** Answer the CONNECT with this status instead of tunnelling — a proxy refusing us. */
  refuseWith?: number;
  /** Tear the tunnel down on any request for this path — an exit IP one route refuses. */
  dropPath?: string;
}

async function startProxy(host = '127.0.0.1', behaviour: ProxyBehaviour = {}): Promise<TestProxy> {
  const server = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end('this fixture only serves CONNECT');
  });

  const proxy: TestProxy = {
    url: '',
    hits: 0,
    drops: 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };

  server.on('connect', (req, socket, head) => {
    proxy.hits++;
    if (behaviour.refuseWith) {
      socket.end(`HTTP/1.1 ${behaviour.refuseWith} Refused\r\n\r\n`);
      return;
    }
    const [h, p] = req.url!.split(':');
    const upstream = net.connect(Number(p), h, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      // Checked per chunk, not per tunnel: the client keeps tunnels alive, so a later
      // request for the refused route can arrive on one that served another route first.
      // The target is plain http, so the request line is readable inside the tunnel.
      socket.on('data', (chunk: Buffer) => {
        if (behaviour.dropPath && chunk.toString('latin1').includes(` ${behaviour.dropPath}`)) {
          proxy.drops++;
          socket.destroy();
          upstream.destroy();
          return;
        }
        upstream.write(chunk);
      });
      // What `socket.pipe(upstream)` did on its own: without it a client that hangs up leaves
      // the tunnel half-open, and `server.close()` waits on it forever.
      socket.on('end', () => upstream.end());
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  proxy.url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return proxy;
}

/** A port with nothing listening — stands in for a dead proxy. */
const DEAD_PROXY = 'http://127.0.0.1:9';

let proxyA: TestProxy;
let proxyB: TestProxy;

function geo(path: string) {
  return `http://127.0.0.1:${targetPort}${path}`;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', () => resolve()));
  targetPort = (target.address() as AddressInfo).port;

  proxyA = await startProxy();
  proxyB = await startProxy();
});

afterAll(async () => {
  await proxyA.close();
  await proxyB.close();
  target.close();
});

beforeEach(() => {
  targetHits = 0;
  proxyA.hits = 0;
  proxyB.hits = 0;
});

// --- tests ---

describe('health check', () => {
  it('resolves country, keeps healthy proxies, discards dead ones', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, DEAD_PROXY],
      healthCheck: { url: geo('/geo-us'), timeout: 3000 },
      retry: { delays: [] },
    });

    const health = await client.ready();

    expect(health.total).toBe(2);
    expect(health.healthy).toBe(1);
    expect(health.dead).toBe(1);
    expect(health.countries).toEqual({ US: 1 });
    expect(health.proxies[proxyA.url]).toBe('US');
    expect(health.proxies[DEAD_PROXY]).toBeNull();
    expect(client.stats.totalProxies).toBe(1);

    await client.destroy();
  }, 30000);

  it('records a healthy proxy with no country as null', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/no-country'), timeout: 3000 },
      retry: { delays: [] },
    });

    const health = await client.ready();
    expect(health.healthy).toBe(1);
    expect(health.countries).toEqual({});
    expect(health.proxies[proxyA.url]).toBeNull();

    await client.destroy();
  }, 30000);

  it('healthCheck: false trusts the list and skips the round trip', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, DEAD_PROXY],
      healthCheck: false,
      retry: { delays: [] },
    });

    await client.ready();
    expect(client.stats.totalProxies).toBe(2);
    expect(targetHits).toBe(0); // nothing was probed

    await client.destroy();
  }, 30000);
});

describe('country filtering', () => {
  it('picks only proxies from the requested country', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/geo-de'), timeout: 3000 },
      retry: { delays: [] },
    });
    await client.ready();

    expect(client.getAvailableProxies({ country: 'DE' })).toEqual([proxyA.url]);
    expect(client.getAvailableProxies({ country: 'US' })).toEqual([]);

    // A request for a country we have no proxy in fails fast rather than hanging
    await expect(
      client.get(geo('/ok'), { country: 'US', forceProxy: true }),
    ).rejects.toBeInstanceOf(NoProxyAvailableError);

    await client.destroy();
  }, 30000);
});

describe('requests actually go through the proxy', () => {
  it('routes traffic via the pooled proxy', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/geo-us'), timeout: 3000 },
      retry: { delays: [] },
    });
    await client.ready();

    proxyA.hits = 0;
    const res = await client.get(geo('/ok'));

    expect(res.status).toBe(200);
    expect(proxyA.hits).toBe(1);

    await client.destroy();
  }, 30000);
});

describe('refresh', () => {
  it('keeps the working pool when every proxy in a refresh fails', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/geo-us'), timeout: 2000 },
      retry: { delays: [] },
      onProxyRefresh: () => [DEAD_PROXY, 'http://127.0.0.1:10'],
    });

    await client.ready();
    expect(client.stats.totalProxies).toBe(1);

    // A provider outage must not leave us with an empty pool
    await client.refreshProxies();

    expect(client.stats.totalProxies).toBe(1);
    expect(client.getAvailableProxies()).toEqual([proxyA.url]);

    await client.destroy();
  }, 60000);

  it('replaces the pool when the refreshed proxies are healthy', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/geo-us'), timeout: 2000 },
      retry: { delays: [] },
      onProxyRefresh: () => [proxyB.url],
    });

    await client.ready();
    expect(client.getAvailableProxies()).toEqual([proxyA.url]);

    await client.refreshProxies();
    expect(client.getAvailableProxies()).toEqual([proxyB.url]);

    await client.destroy();
  }, 60000);
});

describe('banning and rotation', () => {
  it('bans a failing proxy and rotates to the other one', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, proxyB.url],
      healthCheck: { url: geo('/geo-us'), timeout: 3000 },
      retry: { delays: [10, 10, 10] },
      ban: { maxFailures: 1, duration: 60000 },
    });
    await client.ready();
    expect(client.stats.totalProxies).toBe(2);

    client.addInterceptor({
      name: 'ban-403',
      match: (url) => url.includes('/blocked'),
      check: (res) => (res.status === 403 ? 'ban' : null),
    });

    await expect(client.get(geo('/blocked'))).rejects.toBeInstanceOf(MaxRetriesExceededError);

    // Both proxies got tried and both got banned
    expect(proxyA.hits).toBeGreaterThan(0);
    expect(proxyB.hits).toBeGreaterThan(0);
    expect(client.stats.availableProxies).toBe(0);

    client.removeInterceptor('ban-403');
    await client.destroy();
  }, 60000);

  it('forceProxy throws when the pool is empty', async () => {
    const client = new GhostFetch({ forceProxy: true, retry: { delays: [] } });
    await expect(client.get(geo('/ok'))).rejects.toBeInstanceOf(NoProxyAvailableError);
    await client.destroy();
  }, 30000);

  it('without forceProxy, an empty pool means a direct request', async () => {
    const client = new GhostFetch({ retry: { delays: [] } });
    const res = await client.get(geo('/ok'));
    expect(res.status).toBe(200);
    await client.destroy();
  }, 30000);
});

describe('session stickiness', () => {
  it('keeps every request on the same proxy', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, proxyB.url],
      healthCheck: { url: geo('/geo-us'), timeout: 3000 },
      retry: { delays: [] },
    });
    await client.ready();

    const session = client.session('sticky');
    await session.get(geo('/ok'));
    const pinned = session.proxy;
    expect(pinned).toBeTruthy();

    proxyA.hits = 0;
    proxyB.hits = 0;

    for (let i = 0; i < 4; i++) await session.get(geo('/ok'));

    const pinnedHits = pinned === proxyA.url ? proxyA.hits : proxyB.hits;
    const otherHits = pinned === proxyA.url ? proxyB.hits : proxyA.hits;

    expect(session.proxy).toBe(pinned);
    expect(pinnedHits).toBe(4);
    expect(otherHits).toBe(0);

    await client.destroy();
  }, 60000);

  it('re-pins when the pinned proxy gets banned', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, proxyB.url],
      healthCheck: { url: geo('/geo-us'), timeout: 3000 },
      retry: { delays: [] },
      ban: { maxFailures: 1, duration: 60000 },
    });
    await client.ready();

    const session = client.session('repin');
    await session.get(geo('/ok'));
    const first = session.proxy!;

    // Ban the pinned proxy out from under the session
    (client as unknown as { proxyManager: { reportFailure(p: string): void } }).proxyManager.reportFailure(first);

    await session.get(geo('/ok'));
    expect(session.proxy).not.toBe(first);

    await client.destroy();
  }, 60000);
});


describe('session concurrency', () => {
  it('parallel requests on one session all leave from the same IP', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, proxyB.url],
      healthCheck: { url: geo('/geo-us'), timeout: 3000 },
      retry: { delays: [] },
    });
    await client.ready();

    const session = client.session('concurrent');
    proxyA.hits = 0;
    proxyB.hits = 0;

    // Selection is async — without serialization each of these picks before any
    // has recorded its choice, and the session goes out over both IPs at once
    await Promise.all(Array.from({ length: 6 }, () => session.get(geo('/ok'))));

    expect(proxyA.hits + proxyB.hits).toBe(6);
    expect(Math.max(proxyA.hits, proxyB.hits)).toBe(6);
    expect(Math.min(proxyA.hits, proxyB.hits)).toBe(0);

    await client.destroy();
  }, 60000);
});


describe('health check cannot hang the client', () => {
  it('settles ready() when the probe endpoint never answers', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/never-answers'), timeout: 1000 },
      retry: { delays: [] },
    });

    const started = Date.now();
    const health = await client.ready();
    const elapsed = Date.now() - started;

    // 1s per attempt, two attempts, 3s between them
    expect(elapsed).toBeLessThan(15000);
    expect(health.healthy).toBe(0);
    expect(health.dead).toBe(1);

    await client.destroy();
  }, 40000);

  it('a stalled probe does not block requests', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url],
      healthCheck: { url: geo('/never-answers'), timeout: 1000 },
      retry: { delays: [] },
    });

    // request() awaits ready(), so an unsettled health check used to take every
    // request on the client with it — not just startup
    const res = await client.get(geo('/ok'));
    expect(res.status).toBe(200);

    await client.destroy();
  }, 40000);
});


describe('route bans', () => {
  const MINTS = [
    '9chx7Xgtq9mkagFkZPbCJgqKsydHTc6ZDPYqzfMbpump',
    '7tNGyzmx2RkL4PfsU4mWmJLTTsQRBbBq1Ns5K6fGpump',
    '3N5imznFARN7MYo5cpv8mMCfPwsC769S9sYMbrcUpump',
    '1222tmXyKYi83uhPA99wKfwhZc2Lc2GvoVmiCkh8pump',
  ];

  it('reads a refused CONNECT as a proxy failure, not as the target answering', async () => {
    const refusing = await startProxy('127.0.0.1', { refuseWith: 503 });
    const client = new GhostFetch({
      proxies: [refusing.url],
      healthCheck: false,
      retry: { delays: [] },
      ban: { maxFailures: 1, duration: 60000 },
    });

    try {
      const error = await client.get(geo('/ok')).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MaxRetriesExceededError);
      const { lastError } = error as MaxRetriesExceededError;
      // Before, this came back as a 503 from the target: retried as "server busy" and the
      // proxy credited with a success it never had
      expect(lastError.type).toBe('proxy');
      expect(lastError.status).toBeUndefined();
      expect(lastError.message).toContain('Proxy responded with non 200 code');
      expect(client.stats.availableProxies).toBe(0);
    } finally {
      await client.destroy();
      await refusing.close();
    }
  }, 30000);

  it('reads a 429 on the CONNECT as the provider throttling, and bans nothing for it', async () => {
    const throttled = await startProxy('127.0.0.1', { refuseWith: 429 });
    const client = new GhostFetch({
      proxies: [throttled.url, proxyB.url],
      healthCheck: false,
      retry: { delays: [0] },
      ban: { maxFailures: 1, duration: 60000 },
    });

    try {
      // Pinned, so every attempt lands on the throttled exit
      const error = await client.get(geo('/ok'), { proxy: throttled.url }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(MaxRetriesExceededError);
      const { lastError } = error as MaxRetriesExceededError;
      expect(lastError.type).toBe('throttled');
      expect(lastError.message).toContain('Proxy responded with non 200 code: 429');

      // A provider-wide throttle used to ban every exit in turn and empty the pool
      expect(client.stats.availableProxies).toBe(2);
      expect(client.poolStatus(geo('/ok')).usable).toBe(2);

      // Unpinned, the retry rotates to the other exit and goes through
      for (let i = 0; i < 4; i++) {
        const res = await client.get(geo('/ok'));
        expect(res.status).toBe(200);
      }
    } finally {
      await client.destroy();
      await throttled.close();
    }
  }, 30000);

  it('bans an exit off the route it fails on and keeps it everywhere else', async () => {
    const flaky = await startProxy('127.0.0.1', { dropPath: '/rug/' });
    const client = new GhostFetch({
      proxies: [flaky.url, proxyB.url],
      healthCheck: false,
      retry: { delays: [0] },
      ban: { maxFailures: 1, duration: 60000 },
    });

    try {
      // Pinned, so the failure is guaranteed to land on the flaky exit
      await expect(client.get(geo(`/rug/${MINTS[0]}`), { proxy: flaky.url })).rejects.toBeInstanceOf(
        MaxRetriesExceededError,
      );
      const dropsAfterBan = flaky.drops;
      expect(dropsAfterBan).toBeGreaterThan(0);

      // Banned for the whole route — a different token on it is the same scope
      const onRoute = client.poolStatus(geo(`/rug/${MINTS[1]}`));
      expect(onRoute.scopedBanned).toBe(1);
      expect(onRoute.usable).toBe(1);

      // ...so no request for any token on it goes near the flaky exit again
      for (const mint of MINTS.slice(1)) {
        const res = await client.get(geo(`/rug/${mint}`));
        expect(res.status).toBe(200);
      }
      expect(flaky.drops).toBe(dropsAfterBan);

      // A dropped tunnel says nothing about the exit's other routes, nor about it globally
      expect(client.poolStatus(geo('/ok')).usable).toBe(2);
      expect(client.stats.availableProxies).toBe(2);
      const elsewhere = await client.get(geo('/ok'), { proxy: flaky.url });
      expect(elsewhere.status).toBe(200);
    } finally {
      await client.destroy();
      await flaky.close();
    }
  }, 60000);

  it('cannot empty the pool on a route that is down for everyone', async () => {
    const client = new GhostFetch({
      proxies: [proxyA.url, proxyB.url],
      healthCheck: false,
      timeout: 1000,
      retry: { delays: [0] },
      ban: { maxFailures: 1, duration: 60000 },
    });

    try {
      // Both attempts time out, one on each proxy
      await expect(client.get(geo('/never-answers'))).rejects.toBeInstanceOf(MaxRetriesExceededError);

      const status = client.poolStatus(geo('/never-answers'));
      expect(status.scopedBanned).toBe(1);
      expect(status.usable).toBe(1);
    } finally {
      await client.destroy();
    }
  }, 30000);
});
