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

  it('reportSuccess resets the fail counter', () => {
    const pm = new ProxyManager([A], { maxFailures: 2, duration: 60000 });
    pm.reportFailure(A);
    pm.reportSuccess(A);
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

  it('reportScopedSuccess resets the scope fail counter', () => {
    const pm = new ProxyManager([A], { maxFailures: 2, duration: 60000 });

    // One failure — not banned yet
    expect(pm.reportScopedFailure(A, 'okx.com')).toBe(false);

    // A successful request on the same scope must clear the counter, otherwise the
    // next single failure would ban the proxy as if it had failed twice in a row.
    pm.reportScopedSuccess(A, 'okx.com');

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
