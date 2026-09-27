import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/proxy-manager';

const A = 'http://user:pass@host-a.com:8001';
const B = 'http://user:pass@host-b.com:8001';

describe('ProxyManager — global bans', () => {
  it('bans a proxy after maxFailures consecutive failures', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 60000 });

    // Failures inside DEDUP_WINDOW count as one, so space them out via distinct proxies
    expect(pm.reportFailure(A)).toBe(false);
    expect(pm.available).toBe(2);
  });

  it('reportSuccess resets the fail counter once the burst has passed', async () => {
    // dedupWindow is short here on purpose: a success inside the window of a failure
    // belongs to the same burst and is not allowed to forgive it, so the assertion below
    // would hold for the wrong reason.
    const pm = new ProxyManager([A], { maxFailures: 2, duration: 60000, dedupWindow: 20 });

    expect(pm.reportFailure(A)).toBe(false); // strike 1
    await new Promise((r) => setTimeout(r, 30));
    pm.reportSuccess(A);

    await new Promise((r) => setTimeout(r, 30));
    expect(pm.reportFailure(A)).toBe(false); // strike 1 again, so the counter did reset
    expect(pm.getAvailableProxies()).toEqual([A]);
  });
});

describe('ProxyManager — scoped bans', () => {
  it('scoped ban removes the proxy only for that scope', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000 });

    expect(pm.reportScopedFailure(A, 'okx.com')).toBe(true);

    // A is gone for okx.com...
    expect(pm.getProxy({ scope: 'okx.com' })).toBe(B);
    // ...but still fine globally and for other scopes
    expect(pm.available).toBe(2);
    expect(new Set([pm.getProxy({ scope: 'binance.com' })])).not.toEqual(new Set([null]));
  });

  it('reportScopedSuccess resets the scope fail counter once the burst has passed', async () => {
    const pm = new ProxyManager([A], { scopedMaxFailures: 2, duration: 60000, dedupWindow: 20 });

    // One failure — not banned yet
    expect(pm.reportScopedFailure(A, 'okx.com')).toBe(false);

    // A successful request on the same scope must clear the counter, otherwise the
    // next single failure would ban the proxy as if it had failed twice in a row. It has
    // to land clear of the failure's dedup window to count as evidence at all.
    await new Promise((r) => setTimeout(r, 30));
    pm.reportScopedSuccess(A, 'okx.com');

    await new Promise((r) => setTimeout(r, 30));
    expect(pm.reportScopedFailure(A, 'okx.com')).toBe(false);
    expect(pm.getProxy({ scope: 'okx.com' })).toBe(A);
  });

  it('scoped bans are ignored when banning is disabled', () => {
    const pm = new ProxyManager([A], false);
    expect(pm.reportScopedFailure(A, 'okx.com')).toBe(false);
    expect(pm.getProxy({ scope: 'okx.com' })).toBe(A);
  });
});

describe('ProxyManager — ban lifecycle', () => {
  it('a ban lapses once its duration is up', () => {
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 40 });

    expect(pm.reportFailure(A)).toBe(true);
    expect(pm.available).toBe(0);
    expect(pm.banned).toBe(1);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(pm.available).toBe(1);
        expect(pm.banned).toBe(0);
        resolve();
      }, 60);
    });
  });

  it('collapses a burst of concurrent failures into one', () => {
    const pm = new ProxyManager([A], { maxFailures: 2, duration: 60000 });

    // Three parallel requests failing at the same instant are one bad moment,
    // not three strikes
    expect(pm.reportFailure(A)).toBe(false);
    expect(pm.reportFailure(A)).toBe(false);
    expect(pm.reportFailure(A)).toBe(false);
    expect(pm.available).toBe(1);
  });

  it('ban: false never sidelines a proxy', () => {
    const pm = new ProxyManager([A], false);
    expect(pm.reportFailure(A)).toBe(false);
    expect(pm.available).toBe(1);
  });
});

describe('ProxyManager — isUsable', () => {
  it('rejects a proxy that is not in the pool', () => {
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 60000 });
    expect(pm.isUsable(A)).toBe(true);
    expect(pm.isUsable(B)).toBe(false);
  });

  it('rejects a banned proxy', () => {
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 60000 });
    pm.reportFailure(A);
    expect(pm.isUsable(A)).toBe(false);
  });

  it('honours the country and scope filters', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000 });
    pm.setCountry(A, 'us');

    expect(pm.isUsable(A, { country: 'US' })).toBe(true);
    expect(pm.isUsable(A, { country: 'DE' })).toBe(false);
    expect(pm.isUsable(B, { country: 'US' })).toBe(false);

    pm.reportScopedFailure(A, 'okx.com');
    expect(pm.isUsable(A, { scope: 'okx.com' })).toBe(false);
    expect(pm.isUsable(A, { scope: 'binance.com' })).toBe(true);
  });
});

describe('ProxyManager — country data', () => {
  it('normalizes country codes to upper case', () => {
    const pm = new ProxyManager([A, B]);
    pm.setCountry(A, 'de');
    pm.setCountry(B, 'DE');

    expect(pm.getCountry(A)).toBe('DE');
    expect(pm.getProxiesByCountry('de').sort()).toEqual([A, B].sort());
    expect(pm.getProxiesByCountry('US')).toEqual([]);
  });

  it('returns undefined for a proxy with no country resolved', () => {
    expect(new ProxyManager([A]).getCountry(A)).toBeUndefined();
  });

  it('replaceProxies clears bans and country data', () => {
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 60000 });
    pm.setCountry(A, 'US');
    pm.reportFailure(A);
    pm.reportScopedFailure(A, 'okx.com');

    pm.replaceProxies([A, B]);

    expect(pm.total).toBe(2);
    expect(pm.available).toBe(2);
    expect(pm.getCountry(A)).toBeUndefined();
    expect(pm.isUsable(A, { scope: 'okx.com' })).toBe(true);
  });
});

describe('ProxyManager — waitForProxy', () => {
  it('resolves immediately when one is already free', async () => {
    const pm = new ProxyManager([A]);
    await expect(pm.waitForProxy()).resolves.toBe(A);
  });

  it('waits for a ban to lapse and then resolves', async () => {
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 30 });
    pm.reportFailure(A);
    expect(pm.getProxy()).toBeNull();

    await expect(pm.waitForProxy()).resolves.toBe(A);
  }, 15000);
});

describe('ProxyManager — scoped threshold and the half-pool guard', () => {
  const C = 'http://user:pass@host-c.com:8001';
  const D = 'http://user:pass@host-d.com:8001';
  const ROUTE = 'api.site.com/rug/*';

  it('bans off a scope on the first failure by default', () => {
    const pm = new ProxyManager([A, B]);

    expect(pm.reportScopedFailure(A, ROUTE)).toBe(true);
    expect(pm.isUsable(A, { scope: ROUTE })).toBe(false);
    // A scoped ban is exactly that — the proxy keeps serving every other route
    expect(pm.isUsable(A, { scope: 'api.site.com/ok' })).toBe(true);
  });

  it('counts scoped strikes against scopedMaxFailures, not maxFailures', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, scopedMaxFailures: 2, dedupWindow: 0 });

    expect(pm.reportScopedFailure(A, ROUTE)).toBe(false);
    expect(pm.reportScopedFailure(A, ROUTE)).toBe(true);
  });

  it('stops a guarded ban once half the pool is out on the scope', () => {
    const pm = new ProxyManager([A, B, C, D], { dedupWindow: 0 });

    // A target that is down for everyone fails every proxy in turn
    expect(pm.reportScopedFailure(A, ROUTE, { guarded: true })).toBe(true);
    expect(pm.reportScopedFailure(B, ROUTE, { guarded: true })).toBe(true);
    expect(pm.reportScopedFailure(C, ROUTE, { guarded: true })).toBe(false);
    expect(pm.reportScopedFailure(D, ROUTE, { guarded: true })).toBe(false);

    expect(pm.status({ scope: ROUTE }).usable).toBe(2);
  });

  it('never takes the last usable proxy off a scope on its own', () => {
    const pm = new ProxyManager([A], { dedupWindow: 0 });

    expect(pm.reportScopedFailure(A, ROUTE, { guarded: true })).toBe(false);
    expect(pm.isUsable(A, { scope: ROUTE })).toBe(true);
  });

  it('measures the half against the usable pool, not the configured one', () => {
    const pm = new ProxyManager([A, B, C, D], { maxFailures: 1, dedupWindow: 0 });
    pm.reportFailure(C);
    pm.reportFailure(D);

    // Two usable: banning one leaves one, which is half — allowed. The second is not.
    expect(pm.reportScopedFailure(A, ROUTE, { guarded: true })).toBe(true);
    expect(pm.reportScopedFailure(B, ROUTE, { guarded: true })).toBe(false);
  });

  it('leaves an interceptor-named scopedBan unguarded', () => {
    const pm = new ProxyManager([A, B], { dedupWindow: 0 });

    // The caller looked at the response and decided — that is not a guess to second-guess
    expect(pm.reportScopedFailure(A, ROUTE)).toBe(true);
    expect(pm.reportScopedFailure(B, ROUTE)).toBe(true);
    expect(pm.status({ scope: ROUTE }).usable).toBe(0);
  });
});
