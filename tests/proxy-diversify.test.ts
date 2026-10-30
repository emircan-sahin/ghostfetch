import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/proxy-manager';

const PROVIDER_A_1 = 'http://user:pass@proxy-a.example.net:8001';
const PROVIDER_A_2 = 'http://user:pass@proxy-a.example.net:8002';
const PROVIDER_A_3 = 'http://user:pass@proxy-a.example.net:8003';
const PROVIDER_B_1 = 'http://user:pass@proxy-b.example.net:8001';
const PROVIDER_B_2 = 'http://user:pass@proxy-b.example.net:8002';

describe('getProxy hostname diversification', () => {
  it('prefers different hostname than excluded proxy on retry', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_A_3, PROVIDER_B_1, PROVIDER_B_2]);

    // Retry 100 times with PROVIDER_A_1 failed — must always land on provider B
    for (let i = 0; i < 100; i++) {
      const picked = pm.getProxy({ exclude: PROVIDER_A_1 });
      expect(picked).not.toBeNull();
      expect(new URL(picked!).hostname).toBe('proxy-b.example.net');
    }
  });

  it('falls back to same hostname when no other host available', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_A_3]);

    const picked = pm.getProxy({ exclude: PROVIDER_A_1 });
    expect(picked).not.toBeNull();
    expect(picked).not.toBe(PROVIDER_A_1);
    expect([PROVIDER_A_2, PROVIDER_A_3]).toContain(picked);
  });

  it('returns the only remaining proxy when exclude leaves one same-host candidate', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2]);
    expect(pm.getProxy({ exclude: PROVIDER_A_1 })).toBe(PROVIDER_A_2);
  });

  it('returns excluded proxy when it is the only one left', () => {
    const pm = new ProxyManager([PROVIDER_A_1]);
    // Falls back to available pool when excluding leaves empty
    expect(pm.getProxy({ exclude: PROVIDER_A_1 })).toBe(PROVIDER_A_1);
  });

  it('does not diversify when no exclude is given', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_B_1]);
    // Should pick randomly — run many times, both hosts should appear
    const hosts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = pm.getProxy();
      if (p) hosts.add(new URL(p).hostname);
    }
    expect(hosts.size).toBe(2);
  });

  it('diversification chain: fail provider A then fail provider B returns provider A', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_B_1, PROVIDER_B_2]);

    // First pick excludes provider A → must be provider B
    for (let i = 0; i < 50; i++) {
      const first = pm.getProxy({ exclude: PROVIDER_A_1 });
      expect(new URL(first!).hostname).toBe('proxy-b.example.net');
    }

    // Second pick excludes provider B → must be provider A
    for (let i = 0; i < 50; i++) {
      const second = pm.getProxy({ exclude: PROVIDER_B_1 });
      expect(new URL(second!).hostname).toBe('proxy-a.example.net');
    }
  });

  it('respects country filter alongside diversification', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_B_1, PROVIDER_B_2]);
    pm.setCountry(PROVIDER_A_1, 'US');
    pm.setCountry(PROVIDER_A_2, 'US');
    pm.setCountry(PROVIDER_B_1, 'DE');
    pm.setCountry(PROVIDER_B_2, 'US');

    // Exclude PROVIDER_A_1 with country=US → only PROVIDER_A_2 and PROVIDER_B_2 eligible
    // Diversity prefers different host → PROVIDER_B_2
    for (let i = 0; i < 50; i++) {
      const picked = pm.getProxy({ exclude: PROVIDER_A_1, country: 'US' });
      expect(picked).toBe(PROVIDER_B_2);
    }
  });

  it('respects scope filter alongside diversification', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_B_1, PROVIDER_B_2], { maxFailures: 1 });
    // Scope-ban PROVIDER_B_1 and PROVIDER_B_2 for site.com
    pm.reportScopedFailure(PROVIDER_B_1, 'site.com');
    pm.reportScopedFailure(PROVIDER_B_2, 'site.com');

    // Only provider A eligible → must fall back to same host
    for (let i = 0; i < 20; i++) {
      const picked = pm.getProxy({ exclude: PROVIDER_A_1, scope: 'site.com' });
      expect(picked).toBe(PROVIDER_A_2);
    }
  });

  it('3-retry chain alternates hosts: provider A -> provider B -> provider A', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_B_1, PROVIDER_B_2]);

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
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_A_2, PROVIDER_A_3]);

    const a1 = pm.getProxy();
    const a2 = pm.getProxy({ exclude: a1! });
    const a3 = pm.getProxy({ exclude: a2! });

    // All on same host — diversification falls back
    expect(new URL(a1!).hostname).toBe('proxy-a.example.net');
    expect(new URL(a2!).hostname).toBe('proxy-a.example.net');
    expect(new URL(a3!).hostname).toBe('proxy-a.example.net');
    // But consecutive proxies differ (exclude still works)
    expect(a2).not.toBe(a1);
    expect(a3).not.toBe(a2);
  });

  it('handles malformed proxy URL in exclude gracefully (no diversification)', () => {
    const pm = new ProxyManager([PROVIDER_A_1, PROVIDER_B_1]);
    // Unparseable exclude — getHostname returns null, diversification is skipped
    const picked = pm.getProxy({ exclude: 'not-a-url' });
    expect([PROVIDER_A_1, PROVIDER_B_1]).toContain(picked);
  });
});
