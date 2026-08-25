import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/proxy-manager';

const A = 'http://user:pass@host-a.com:8001';
const B = 'http://user:pass@host-b.com:8001';
const SCOPE = 'api.example.com/v2/tokens';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A target that rate-limits per IP per endpoint answers part of a burst and refuses the
 * rest, so successes and failures arrive interleaved from the same proxy. These pin the
 * rules that keep such a proxy from talking its way out of the ban it just earned.
 */
describe('ProxyManager — a success must not undo a ban', () => {
  it('keeps an active scoped ban when a success lands behind it', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000, dedupWindow: 20 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true);
    expect(pm.isUsable(A, { scope: SCOPE })).toBe(false);

    // The rest of the burst comes back 200, after the window so only the ban itself is
    // what protects the entry.
    await sleep(30);
    pm.reportScopedSuccess(A, SCOPE);

    expect(pm.isUsable(A, { scope: SCOPE })).toBe(false);
  });

  it('keeps an active global ban when a success lands behind it', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000, dedupWindow: 20 });

    expect(pm.reportFailure(A)).toBe(true);
    expect(pm.getAvailableProxies()).not.toContain(A);

    await sleep(30);
    pm.reportSuccess(A);

    expect(pm.getAvailableProxies()).not.toContain(A);
  });

  it('does not let a success in the same burst forgive a strike', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 60000, dedupWindow: 200 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // strike 1
    pm.reportScopedSuccess(A, SCOPE); // same burst — says nothing about the proxy

    await sleep(220);
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true); // strike 2 → banned
  });

  it('still forgives a strike once the proxy has been clean for a while', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 60000, dedupWindow: 50 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // strike 1

    await sleep(70);
    pm.reportScopedSuccess(A, SCOPE); // clear of the burst — the strike is forgiven

    await sleep(70);
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // back to strike 1, not 2
  });

  it('never forgives a strike when resetScopedOnSuccess is off', async () => {
    const pm = new ProxyManager([A, B], {
      maxFailures: 2,
      duration: 60000,
      dedupWindow: 50,
      resetScopedOnSuccess: false,
    });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // strike 1

    await sleep(70);
    pm.reportScopedSuccess(A, SCOPE); // ignored

    await sleep(70);
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true); // strike 2 → banned
  });

  it('leaves the global counter alone when only the scoped one is off', async () => {
    const pm = new ProxyManager([A, B], {
      maxFailures: 2,
      duration: 60000,
      dedupWindow: 50,
      resetScopedOnSuccess: false,
    });

    expect(pm.reportFailure(A)).toBe(false); // strike 1

    await sleep(70);
    pm.reportSuccess(A);

    await sleep(70);
    expect(pm.reportFailure(A)).toBe(false); // forgiven, so back to strike 1
  });

  it('honours a custom dedupWindow when counting strikes', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 60000, dedupWindow: 300 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false);
    await sleep(50);
    // Inside the window: one burst, one strike.
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false);

    await sleep(320);
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true);
  });
});

describe('ProxyManager — waiting on a scope', () => {
  it('bounds the wait by the scoped ban, not the fallback window', async () => {
    // Every proxy is sidelined for this scope and none is banned globally, so the wait has
    // to read the scoped map — reading only the global one leaves nothing to wait for and
    // falls back to a window minutes long.
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 250, dedupWindow: 20 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true);
    expect(pm.reportScopedFailure(B, SCOPE)).toBe(true);
    expect(pm.getProxy({ scope: SCOPE })).toBeNull();

    const started = Date.now();
    const proxy = await pm.waitForProxy({ scope: SCOPE });
    const waited = Date.now() - started;

    expect([A, B]).toContain(proxy);
    // Tight on purpose. Reading only the global bans leaves nothing to wait for, and the
    // fallback window is minutes — long enough that its first poll, at 2s, still finds the
    // proxy free and passes a loose assertion.
    expect(waited).toBeLessThan(1200);
  });

  it('still resolves immediately when a proxy is free for the scope', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000, dedupWindow: 20 });

    pm.reportScopedFailure(A, SCOPE);

    await expect(pm.waitForProxy({ scope: SCOPE })).resolves.toBe(B);
  });
});

describe('ProxyManager — strikes age out', () => {
  it('does not carry stale strikes into a fresh incident', async () => {
    // duration doubles as the strike window: a proxy that has been quiet for that long
    // starts over, instead of coming back from a ban with no allowance left.
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 80, dedupWindow: 10 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // strike 1

    await sleep(120);
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // strike 1 again, not banned
  });

  it('lets a proxy back with a full allowance after its ban lapses', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 80, dedupWindow: 10 });

    await sleep(15);
    expect(pm.reportFailure(A)).toBe(false);
    await sleep(15);
    expect(pm.reportFailure(A)).toBe(true); // banned
    expect(pm.getAvailableProxies()).not.toContain(A);

    await sleep(120); // ban lapses
    expect(pm.getAvailableProxies()).toContain(A);
    expect(pm.reportFailure(A)).toBe(false); // one strike, not straight back to banned
  });
});

describe('ProxyManager — config is taken literally', () => {
  it('ignores undefined fields instead of letting them erase a default', async () => {
    // `{ ...DEFAULT, ...config }` would put `undefined` on maxFailures, and every
    // `failCount >= undefined` comparison after that is false — banning off, silently.
    // dedupWindow is set only so the strikes land as separate incidents quickly.
    const pm = new ProxyManager([A, B], { maxFailures: undefined, duration: undefined, dedupWindow: 10 });

    await sleep(15);
    expect(pm.reportFailure(A)).toBe(false);
    await sleep(15);
    expect(pm.reportFailure(A)).toBe(false);
    await sleep(15);
    expect(pm.reportFailure(A)).toBe(true); // the default maxFailures of 3 still applies
  });
});

describe('ProxyManager — capping the wait', () => {
  it('gives up at the cap instead of waiting out the ban', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000, dedupWindow: 10 });

    pm.reportScopedFailure(A, SCOPE);
    pm.reportScopedFailure(B, SCOPE);

    const started = Date.now();
    await expect(pm.waitForProxy({ scope: SCOPE }, 150)).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('returns a proxy that frees up before the cap', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 150, dedupWindow: 10 });

    pm.reportScopedFailure(A, SCOPE);
    pm.reportScopedFailure(B, SCOPE);

    await expect(pm.waitForProxy({ scope: SCOPE }, 5000)).resolves.toBeTruthy();
  });
});

describe('ProxyManager — a proxy has to clear every ban on it', () => {
  it('waits out the longer of a proxy\'s global and scoped bans', async () => {
    // One proxy, banned both ways with different starts. Combining the two maps by taking
    // whichever expires first would promise it back while the other ban still holds.
    const pm = new ProxyManager([A], { maxFailures: 1, duration: 400, dedupWindow: 5 });

    pm.reportScopedFailure(A, SCOPE); // lapses first
    await sleep(200);
    pm.reportFailure(A); // lapses later — this is the one that decides

    const started = Date.now();
    await expect(pm.waitForProxy({ scope: SCOPE }, 5000)).resolves.toBe(A);

    // The scoped ban is gone by ~400ms; the global one only at ~600ms.
    expect(Date.now() - started).toBeGreaterThan(350);
  });

  it('ignores bans on proxies the country filter rules out', async () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 20000, dedupWindow: 5 });
    pm.setCountry(A, 'US');
    pm.setCountry(B, 'DE');

    pm.reportFailure(A);

    // Only US was asked for and the one US proxy is banned for 20s, so this has to give up
    // at the cap rather than resolve off the free DE proxy.
    await expect(pm.waitForProxy({ country: 'US' }, 150)).rejects.toThrow();
  });
});

describe('ProxyManager — clearing a ban on purpose', () => {
  it('clears a scoped ban that a success would not have', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000, dedupWindow: 20 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true);
    pm.reportScopedSuccess(A, SCOPE);
    expect(pm.isUsable(A, { scope: SCOPE })).toBe(false);

    pm.clearScopedBan(A, SCOPE);
    expect(pm.isUsable(A, { scope: SCOPE })).toBe(true);
  });

  it('clears a global ban that a success would not have', () => {
    const pm = new ProxyManager([A, B], { maxFailures: 1, duration: 60000, dedupWindow: 20 });

    expect(pm.reportFailure(A)).toBe(true);
    pm.reportSuccess(A);
    expect(pm.getAvailableProxies()).not.toContain(A);

    pm.clearBan(A);
    expect(pm.getAvailableProxies()).toContain(A);
  });
});

describe('ProxyManager — a burst cannot age its own way out', () => {
  it('keeps the strike when failures keep arriving inside the window', async () => {
    // The counted strike stays anchored at the first failure of a burst. Reading that
    // timestamp would let a long burst look old enough to forgive, even though a failure
    // landed a moment ago.
    const pm = new ProxyManager([A, B], { maxFailures: 2, duration: 60000, dedupWindow: 100 });

    expect(pm.reportScopedFailure(A, SCOPE)).toBe(false); // strike 1, anchors the window
    await sleep(60);
    pm.reportScopedFailure(A, SCOPE); // deduped, but still a failure just now
    await sleep(60);

    pm.reportScopedSuccess(A, SCOPE); // 120ms past the anchor, 60ms past the real failure

    await sleep(120);
    expect(pm.reportScopedFailure(A, SCOPE)).toBe(true); // strike survived → banned
  });
});
