import { BanConfig } from './types';
import { NoProxyAvailableError } from './errors';

interface BanEntry {
  bannedAt: number;
  failCount: number;
  lastFailure: number;
}

/** Failures within this window (ms) from different requests count as 1. */
const DEDUP_WINDOW = 1000;

/** How often to poll for an available proxy when waiting (ms). */
const WAIT_POLL_INTERVAL = 2000;

const DEFAULT_BAN: Required<BanConfig> = {
  maxFailures: 3,
  duration: 60 * 60 * 1000, // 1 hour
};

export interface GetProxyOptions {
  exclude?: string | null;
  country?: string;
}

export class ProxyManager {
  private proxies: string[] = [];
  private banMap = new Map<string, BanEntry>();
  private banConfig: Required<BanConfig> | false;
  private countryMap = new Map<string, string>(); // proxy → country code

  constructor(proxies: string[], banConfig?: BanConfig | false) {
    this.proxies = [...proxies];
    this.banConfig = banConfig === false ? false : { ...DEFAULT_BAN, ...banConfig };
  }

  /**
   * Get a random non-banned proxy.
   * Supports exclude (skip last failed proxy) and country filter.
   * Returns null if none available.
   */
  getProxy(opts?: GetProxyOptions | string | null): string | null {
    // Backwards compat: allow passing just exclude string
    const { exclude, country } = typeof opts === 'string' || opts === null || opts === undefined
      ? { exclude: opts ?? undefined, country: undefined }
      : opts;

    let available = this.getAvailableProxies();

    // Filter by country if requested
    if (country) {
      const upper = country.toUpperCase();
      available = available.filter((p) => this.countryMap.get(p) === upper);
    }

    const candidates = exclude
      ? available.filter((p) => p !== exclude)
      : available;

    // If excluding leaves nothing but there are available proxies, fall back
    const pool = candidates.length > 0 ? candidates : available;
    if (pool.length === 0) return null;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Wait until a proxy becomes available (bans expire or list is refreshed).
   * Resolves with the proxy string. Supports country filter.
   *
   * Automatically calculates timeout from the earliest ban expiry.
   * If no ban will ever expire (shouldn't happen), times out after 5 minutes.
   */
  waitForProxy(opts?: GetProxyOptions): Promise<string> {
    const immediate = this.getProxy(opts);
    if (immediate) return Promise.resolve(immediate);

    // Calculate max wait from earliest ban expiry + buffer
    const maxWait = this.getEarliestBanExpiry() ?? 5 * 60 * 1000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new NoProxyAvailableError());
      }, maxWait);

      const interval = setInterval(() => {
        const proxy = this.getProxy(opts);
        if (proxy) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve(proxy);
        }
      }, WAIT_POLL_INTERVAL);
    });
  }

  /** Get ms until the earliest ban expires, or null if no active bans. */
  private getEarliestBanExpiry(): number | null {
    if (this.banConfig === false) return null;

    const now = Date.now();
    let earliest = Infinity;

    for (const [, entry] of this.banMap) {
      if (!entry.bannedAt) continue;
      const expiresAt = entry.bannedAt + this.banConfig.duration;
      const remaining = expiresAt - now;
      if (remaining > 0 && remaining < earliest) {
        earliest = remaining;
      }
    }

    // Add 1s buffer so the ban is definitely expired when we check
    return earliest === Infinity ? null : earliest + 1000;
  }

  /** Get all currently available (non-banned) proxies. */
  getAvailableProxies(): string[] {
    if (this.banConfig === false) return [...this.proxies];

    const now = Date.now();
    const duration = this.banConfig.duration;
    return this.proxies.filter((proxy) => {
      const ban = this.banMap.get(proxy);
      if (!ban) return true;
      if (!ban.bannedAt) return true;
      if (now - ban.bannedAt >= duration) {
        this.banMap.delete(proxy);
        return true;
      }
      return false;
    });
  }

  /**
   * Report a proxy failure. Returns true if the proxy got banned.
   *
   * Concurrent dedup: if the last failure was within DEDUP_WINDOW ms,
   * this call is ignored (multiple parallel requests failing at the same
   * moment count as a single failure).
   */
  reportFailure(proxy: string): boolean {
    if (this.banConfig === false) return false;

    const now = Date.now();
    const entry = this.banMap.get(proxy);

    if (entry && (now - entry.lastFailure) < DEDUP_WINDOW) {
      // Check if actually still banned (not expired)
      return entry.bannedAt > 0 && (now - entry.bannedAt) < this.banConfig.duration;
    }

    const failCount = (entry?.failCount ?? 0) + 1;

    if (failCount >= this.banConfig.maxFailures) {
      this.banMap.set(proxy, { bannedAt: now, failCount, lastFailure: now });
      return true;
    }

    this.banMap.set(proxy, { bannedAt: 0, failCount, lastFailure: now });
    return false;
  }

  /** Report a proxy success — resets its fail count. */
  reportSuccess(proxy: string): void {
    this.banMap.delete(proxy);
  }

  /** Replace the proxy list and clear all bans + country data. */
  replaceProxies(proxies: string[]): void {
    this.proxies = [...proxies];
    this.banMap.clear();
    this.countryMap.clear();
  }

  /** Set country for a proxy. */
  setCountry(proxy: string, country: string): void {
    this.countryMap.set(proxy, country.toUpperCase());
  }

  /** Get country for a proxy (or undefined if not resolved). */
  getCountry(proxy: string): string | undefined {
    return this.countryMap.get(proxy);
  }

  /** Get all proxies for a specific country. */
  getProxiesByCountry(country: string): string[] {
    const upper = country.toUpperCase();
    return this.proxies.filter((p) => this.countryMap.get(p) === upper);
  }

  /** Get total proxy count. */
  get total(): number {
    return this.proxies.length;
  }

  /** Get available (non-banned) proxy count. */
  get available(): number {
    return this.getAvailableProxies().length;
  }

  /** Get banned proxy count. */
  get banned(): number {
    return this.total - this.available;
  }
}
