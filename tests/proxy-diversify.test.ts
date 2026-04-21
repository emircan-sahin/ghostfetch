import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/proxy-manager';

const OXYLABS_1 = 'http://user:pass@pr.oxylabs.io:8001';
const OXYLABS_2 = 'http://user:pass@pr.oxylabs.io:8002';
const OXYLABS_3 = 'http://user:pass@pr.oxylabs.io:8003';
const DECODO_1 = 'http://user:pass@gate.decodo.com:8001';
const DECODO_2 = 'http://user:pass@gate.decodo.com:8002';

describe('getProxy hostname diversification', () => {
  it('prefers different hostname than excluded proxy on retry', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, OXYLABS_3, DECODO_1, DECODO_2]);

    // Retry 100 times with OXYLABS_1 failed — must always land on decodo
    for (let i = 0; i < 100; i++) {
      const picked = pm.getProxy({ exclude: OXYLABS_1 });
      expect(picked).not.toBeNull();
      expect(new URL(picked!).hostname).toBe('gate.decodo.com');
    }
  });

  it('falls back to same hostname when no other host available', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, OXYLABS_3]);

    const picked = pm.getProxy({ exclude: OXYLABS_1 });
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(OXYLABS_1);
    expect([OXYLABS_2, OXYLABS_3]).toContain(picked);
  });

  it('returns the only remaining proxy when exclude leaves one same-host candidate', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2]);
    expect(pm.getProxy({ exclude: OXYLABS_1 })).toBe(OXYLABS_2);
  });

  it('returns excluded proxy when it is the only one left', () => {
    const pm = new ProxyManager([OXYLABS_1]);
    // Falls back to available pool when excluding leaves empty
    expect(pm.getProxy({ exclude: OXYLABS_1 })).toBe(OXYLABS_1);
  });

  it('does not diversify when no exclude is given', () => {
    const pm = new ProxyManager([OXYLABS_1, DECODO_1]);
    // Should pick randomly — run many times, both hosts should appear
    const hosts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = pm.getProxy();
      if (p) hosts.add(new URL(p).hostname);
    }
    expect(hosts.size).toBe(2);
  });

  it('diversification chain: fail oxylabs then fail decodo returns oxylabs', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, DECODO_1, DECODO_2]);

    // First pick excludes oxylabs → must be decodo
    for (let i = 0; i < 50; i++) {
      const first = pm.getProxy({ exclude: OXYLABS_1 });
      expect(new URL(first!).hostname).toBe('gate.decodo.com');
    }

    // Second pick excludes decodo → must be oxylabs
    for (let i = 0; i < 50; i++) {
      const second = pm.getProxy({ exclude: DECODO_1 });
      expect(new URL(second!).hostname).toBe('pr.oxylabs.io');
    }
  });

  it('respects country filter alongside diversification', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, DECODO_1, DECODO_2]);
    pm.setCountry(OXYLABS_1, 'US');
    pm.setCountry(OXYLABS_2, 'US');
    pm.setCountry(DECODO_1, 'DE');
    pm.setCountry(DECODO_2, 'US');

    // Exclude OXYLABS_1 with country=US → only OXYLABS_2 and DECODO_2 eligible
    // Diversity prefers different host → DECODO_2
    for (let i = 0; i < 50; i++) {
      const picked = pm.getProxy({ exclude: OXYLABS_1, country: 'US' });
      expect(picked).toBe(DECODO_2);
    }
  });

  it('respects scope filter alongside diversification', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, DECODO_1, DECODO_2], { maxFailures: 1 });
    // Scope-ban DECODO_1 and DECODO_2 for site.com
    pm.reportScopedFailure(DECODO_1, 'site.com');
    pm.reportScopedFailure(DECODO_2, 'site.com');

    // Only oxylabs eligible → must fall back to same host
    for (let i = 0; i < 20; i++) {
      const picked = pm.getProxy({ exclude: OXYLABS_1, scope: 'site.com' });
      expect(picked).toBe(OXYLABS_2);
    }
  });

  it('3-retry chain alternates hosts: oxylabs -> decodo -> oxylabs', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, DECODO_1, DECODO_2]);

    // Simulate 3-retry chain 100 times — always alternates
    for (let i = 0; i < 100; i++) {
      // Attempt 1: no exclude
      const a1 = pm.getProxy();
      const h1 = new URL(a1!).hostname;

      // Attempt 2: exclude = last failed (a1)
      const a2 = pm.getProxy({ exclude: a1! });
      const h2 = new URL(a2!).hostname;

      // Attempt 3: exclude = last failed (a2)
      const a3 = pm.getProxy({ exclude: a2! });
      const h3 = new URL(a3!).hostname;

      // Each attempt must be on a different host than the previous
      expect(h2).not.toBe(h1);
      expect(h3).not.toBe(h2);
    }
  });

  it('retry chain stays same-host when only one provider exists', () => {
    const pm = new ProxyManager([OXYLABS_1, OXYLABS_2, OXYLABS_3]);

    const a1 = pm.getProxy();
    const a2 = pm.getProxy({ exclude: a1! });
    const a3 = pm.getProxy({ exclude: a2! });

    // All on same host — diversification falls back
    expect(new URL(a1!).hostname).toBe('pr.oxylabs.io');
    expect(new URL(a2!).hostname).toBe('pr.oxylabs.io');
    expect(new URL(a3!).hostname).toBe('pr.oxylabs.io');
    // But consecutive proxies differ (exclude still works)
    expect(a2).not.toBe(a1);
    expect(a3).not.toBe(a2);
  });

  it('handles malformed proxy URL in exclude gracefully (no diversification)', () => {
    const pm = new ProxyManager([OXYLABS_1, DECODO_1]);
    // Unparseable exclude — getHostname returns null, diversification is skipped
    const picked = pm.getProxy({ exclude: 'not-a-url' });
    expect([OXYLABS_1, DECODO_1]).toContain(picked);
  });
});
