import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/proxy-manager';
import { GhostFetch, NoProxyAvailableError } from '../src';

const A = 'http://user:pass@host-a.com:8001';
const B = 'http://user:pass@host-b.com:8001';
const C = 'http://user:pass@host-c.com:8001';

describe('ProxyManager — per-proxy concurrency cap', () => {
  it('is off by default, so a proxy can be leased without limit', () => {
    const pm = new ProxyManager([A]);

    for (let i = 0; i < 50; i++) expect(pm.lease()).toBe(A);
    expect(pm.inFlight(A)).toBe(50);
    expect(pm.isCapacityBlocked()).toBe(false);
  });

  it('stops handing out a proxy once it is carrying its share', () => {
    const pm = new ProxyManager([A], undefined, 2);

    expect(pm.lease()).toBe(A);
    expect(pm.lease()).toBe(A);
    expect(pm.lease()).toBeNull();
    expect(pm.isCapacityBlocked()).toBe(true);
  });

  it('frees the slot on release', () => {
    const pm = new ProxyManager([A], undefined, 1);

    expect(pm.lease()).toBe(A);
    expect(pm.lease()).toBeNull();

    pm.release(A);
    expect(pm.inFlight(A)).toBe(0);
    expect(pm.lease()).toBe(A);
  });

  it('spreads a burst across the pool instead of stacking one proxy', () => {
    const pm = new ProxyManager([A, B], undefined, 1);

    const first = pm.lease();
    const second = pm.lease();

    expect(new Set([first, second])).toEqual(new Set([A, B]));
    expect(pm.lease()).toBeNull();
  });

  // The scenario the cap exists for: bans wear the pool down to one survivor, and every
  // concurrent request would otherwise be handed that same exit IP at the same moment.
  it('does not funnel a burst onto the last proxy a scoped ban left standing', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60_000 }, 2);
    const scope = 'example.com';

    expect(pm.reportScopedFailure(A, scope)).toBe(true);

    const opts = { scope };
    expect(pm.lease(opts)).toBe(B);
    expect(pm.lease(opts)).toBe(B);
    expect(pm.lease(opts)).toBeNull();
    expect(pm.isCapacityBlocked(opts)).toBe(true);
  });

  it('reports a ban-blocked pool as blocked by bans, not by capacity', () => {
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 60_000 }, 2);

    expect(pm.reportFailure(A)).toBe(true);
    expect(pm.lease()).toBeNull();
    // Nothing is eligible at all — the caller must not be told to sit and wait for a slot
    expect(pm.isCapacityBlocked()).toBe(false);
  });

  it('an unleased release cannot push the count below zero', () => {
    const pm = new ProxyManager([A], undefined, 1);

    pm.release(A);
    pm.release(A);
    expect(pm.inFlight(A)).toBe(0);
    expect(pm.lease()).toBe(A);
    expect(pm.lease()).toBeNull();
  });
});

describe('ProxyManager — waiting for a slot', () => {
  it('resolves as soon as a slot is released, without waiting out the poll', async () => {
    const pm = new ProxyManager([A], undefined, 1);
    expect(pm.lease()).toBe(A);

    const started = Date.now();
    const waiting = pm.waitForLease();

    setTimeout(() => pm.release(A), 30);

    await expect(waiting).resolves.toBe(A);
    // The ban poll runs on a much longer interval; landing this fast proves the wait was
    // woken by the release rather than by the next tick of the poll.
    expect(Date.now() - started).toBeLessThan(500);
    expect(pm.inFlight(A)).toBe(1);
  });

  it('hands the freed slot to exactly one of several waiters', async () => {
    const pm = new ProxyManager([A], undefined, 1);
    expect(pm.lease()).toBe(A);

    const first = pm.waitForLease();
    const second = pm.waitForLease({}, 400);

    pm.release(A);

    await expect(first).resolves.toBe(A);
    await expect(second).rejects.toBeInstanceOf(NoProxyAvailableError);
    expect(pm.inFlight(A)).toBe(1);
  });

  it('gives up with NoProxyAvailableError when the wait is capped', async () => {
    const pm = new ProxyManager([A], undefined, 1);
    expect(pm.lease()).toBe(A);

    await expect(pm.waitForLease({}, 150)).rejects.toBeInstanceOf(NoProxyAvailableError);
  });
});

describe('GhostFetch — slots are given back', () => {
  it('releases the slot after a failed request, so the proxy is reusable', async () => {
    // Unroutable proxies: every attempt fails, which is the path a leak would hide in.
    const dead = 'http://127.0.0.1:1/';
    const client = new GhostFetch({
      proxies: [dead],
      healthCheck: false,
      maxConcurrentPerProxy: 1,
      retry: { delays: [] },
      timeout: 1500,
    });

    try {
      // Element access reaches the private field without an `any` cast, which the
      // codebase does not allow.
      const manager = client['proxyManager'];

      await client.get('http://127.0.0.1:1/nowhere').catch(() => undefined);
      expect(manager.inFlight(dead)).toBe(0);

      await client.get('http://127.0.0.1:1/nowhere').catch(() => undefined);
      expect(manager.inFlight(dead)).toBe(0);
    } finally {
      await client.destroy();
    }
  }, 20_000);
});

describe('ProxyManager — spreading a burst', () => {
  it('lands a burst flat across the pool instead of stacking it', () => {
    // Cap off on purpose: even spreading is not the cap's doing, and must hold without it.
    const pm = new ProxyManager([A, B, C]);

    for (let i = 0; i < 9; i++) expect(pm.lease()).not.toBeNull();

    expect([A, B, C].map((p) => pm.inFlight(p))).toEqual([3, 3, 3]);
  });

  it('still prefers a different host on retry, then the idlest of those', () => {
    const pm = new ProxyManager([A, B, C]);

    // B is busy, C is not — a retry off A must leave A and take the idler of the rest
    pm.acquire(B);
    expect(pm.lease({ exclude: A })).toBe(C);
  });
});

describe('ProxyManager — a caller-named proxy', () => {
  it('queues for a slot rather than skipping the cap', async () => {
    const pm = new ProxyManager([A], undefined, 1);
    expect(pm.lease()).toBe(A);

    let settled = false;
    const queued = pm.acquireWhenFree(A).then((p) => {
      settled = true;
      return p;
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    expect(pm.inFlight(A)).toBe(1);

    pm.release(A);
    await expect(queued).resolves.toBe(A);
    expect(pm.inFlight(A)).toBe(1);
  });

  it('can queue on a proxy the pool has never heard of', async () => {
    const pm = new ProxyManager([A], undefined, 1);
    const stranger = 'http://user:pass@host-z.com:8001';

    await expect(pm.acquireWhenFree(stranger)).resolves.toBe(stranger);
    expect(pm.inFlight(stranger)).toBe(1);
  });
});

describe('GhostFetch — session pins', () => {
  // Regression: picking a pin used to lease, and the session then sent through the normal
  // request path which leased again. The first slot was never released, so a handful of
  // re-pins retired the proxy from rotation permanently.
  it('choosing a pin does not take a slot', async () => {
    // Bounded so the regression fails fast: leaked slots make the second pick wait, and
    // without a bound it waits out the whole test timeout instead of reporting anything.
    const client = new GhostFetch({
      proxies: [A],
      healthCheck: false,
      maxConcurrentPerProxy: 1,
      proxyWaitTimeout: 300,
    });

    try {
      const manager = client['proxyManager'];

      for (let i = 0; i < 5; i++) {
        const pin = await client['pickSessionProxy'](null, 'https://example.com/page', {});
        expect(pin).toBe(A);
      }

      expect(manager.inFlight(A)).toBe(0);
      expect(manager.lease()).toBe(A);
    } finally {
      await client.destroy();
    }
  });
});

describe('GhostFetch — poolStatus', () => {
  it('shows a scoped ban that stats reports as a healthy pool', async () => {
    const client = new GhostFetch({
      proxies: [A, B],
      healthCheck: false,
      maxConcurrentPerProxy: 1,
      ban: { maxFailures: 1, duration: 60_000 },
    });

    try {
      const manager = client['proxyManager'];
      expect(manager.reportScopedFailure(A, 'example.com')).toBe(true);

      expect(client.poolStatus('https://example.com/page')).toEqual({
        total: 2,
        banned: 0,
        scopedBanned: 1,
        busy: 0,
        usable: 1,
        inFlight: 0,
      });

      // The blind spot poolStatus exists for: nothing is globally banned, so stats sees
      // a full pool while only one proxy can actually serve this host.
      expect(client.stats.availableProxies).toBe(2);

      // ...and once that survivor is busy, nothing is left for this host at all
      manager.acquire(B);
      const busy = client.poolStatus('https://example.com/page');
      expect(busy.busy).toBe(1);
      expect(busy.usable).toBe(0);
      expect(busy.inFlight).toBe(1);
    } finally {
      await client.destroy();
    }
  });

  it('reports the whole pool when no target is named', async () => {
    const client = new GhostFetch({ proxies: [A, B], healthCheck: false });

    try {
      expect(client.poolStatus()).toEqual({
        total: 2,
        banned: 0,
        scopedBanned: 0,
        busy: 0,
        usable: 2,
        inFlight: 0,
      });
    } finally {
      await client.destroy();
    }
  });
});
