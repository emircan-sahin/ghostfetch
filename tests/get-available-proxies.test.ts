import { describe, it, expect } from 'vitest';
import { ProxyManager } from '../src/proxy-manager';

const PROXIES = [
  'http://user:pass@us1:8001',
  'http://user:pass@us2:8002',
  'http://user:pass@de1:8003',
  'http://user:pass@de2:8004',
];

describe('getAvailableProxies', () => {
  it('returns all proxies when none are banned', () => {
    const pm = new ProxyManager(PROXIES);
    expect(pm.getAvailableProxies()).toEqual(PROXIES);
  });

  it('excludes banned proxies', () => {
    const pm = new ProxyManager(PROXIES, { maxFailures: 1 });
    pm.reportFailure(PROXIES[0]);
    const available = pm.getAvailableProxies();
    expect(available).not.toContain(PROXIES[0]);
    expect(available).toHaveLength(3);
  });

  it('returns all proxies when ban is disabled', () => {
    const pm = new ProxyManager(PROXIES, false);
    // Failures don't matter when banning is disabled
    pm.reportFailure(PROXIES[0]);
    pm.reportFailure(PROXIES[0]);
    pm.reportFailure(PROXIES[0]);
    expect(pm.getAvailableProxies()).toEqual(PROXIES);
  });

  it('re-includes proxy after ban expires', () => {
    const pm = new ProxyManager(PROXIES, { maxFailures: 1, duration: 1 });
    pm.reportFailure(PROXIES[0]);
    expect(pm.getAvailableProxies()).not.toContain(PROXIES[0]);

    // Wait for ban to expire (1ms duration)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(pm.getAvailableProxies()).toContain(PROXIES[0]);
        resolve();
      }, 10);
    });
  });
});

describe('getAvailableProxies with country filter', () => {
  function createManagerWithCountries() {
    const pm = new ProxyManager(PROXIES);
    pm.setCountry(PROXIES[0], 'US');
    pm.setCountry(PROXIES[1], 'US');
    pm.setCountry(PROXIES[2], 'DE');
    pm.setCountry(PROXIES[3], 'DE');
    return pm;
  }

  it('filters by country via ProxyManager.getProxiesByCountry', () => {
    const pm = createManagerWithCountries();
    const us = pm.getProxiesByCountry('US');
    expect(us).toEqual([PROXIES[0], PROXIES[1]]);
    const de = pm.getProxiesByCountry('DE');
    expect(de).toEqual([PROXIES[2], PROXIES[3]]);
  });

  it('country filter is case-insensitive', () => {
    const pm = createManagerWithCountries();
    expect(pm.getProxiesByCountry('us')).toEqual([PROXIES[0], PROXIES[1]]);
  });

  it('returns empty array for unknown country', () => {
    const pm = createManagerWithCountries();
    expect(pm.getProxiesByCountry('JP')).toEqual([]);
  });

  it('excludes banned proxies from country results', () => {
    const pm = createManagerWithCountries();
    // Ban first US proxy (maxFailures: 1 so single failure bans it)
    const pmBan = new ProxyManager(PROXIES, { maxFailures: 1 });
    pmBan.setCountry(PROXIES[0], 'US');
    pmBan.setCountry(PROXIES[1], 'US');
    pmBan.setCountry(PROXIES[2], 'DE');
    pmBan.setCountry(PROXIES[3], 'DE');
    pmBan.reportFailure(PROXIES[0]);

    const available = pmBan.getAvailableProxies();
    const usAvailable = available.filter((p) => pmBan.getCountry(p) === 'US');
    expect(usAvailable).toEqual([PROXIES[1]]);
  });
});
