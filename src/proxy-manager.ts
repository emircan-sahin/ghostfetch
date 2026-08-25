import { BanConfig, PoolStatus } from './types';
import { NoProxyAvailableError } from './errors';

interface BanEntry {
  bannedAt: number;
  failCount: number;
  /** When the strike was counted. Anchors the dedup window, so it stays put inside a burst. */
  lastFailure: number;
  /** When a failure was last seen at all, counted or deduped. Decides what a success forgives. */
  lastSeenFailure: number;
}

/** Failures within this window (ms) from different requests count as 1. */
const DEDUP_WINDOW = 1000;

/** How often to poll for an available proxy when waiting (ms). */
const WAIT_POLL_INTERVAL = 2000;

/** Floor for the poll interval so a very short wait still gets checked. */
const MIN_POLL_INTERVAL = 25;

/** Longest a wait runs when nothing gives it a deadline to compute. */
const MAX_WAIT = 5 * 60 * 1000;

/** Only sweep the scoped map once it is big enough to be worth walking. */
const SWEEP_THRESHOLD = 256;

/** And no more often than this, so a busy client does not walk it on every failure. */
const SWEEP_INTERVAL = 60_000;

/** Drop keys whose value is `undefined` so they cannot overwrite a default. */
function defined<T extends object>(source: T | undefined): Partial<T> {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>;
}

const DEFAULT_BAN: Required<Omit<BanConfig, 'scopeKey'>> = {
  maxFailures: 3,
  duration: 60 * 60 * 1000, // 1 hour
  dedupWindow: DEDUP_WINDOW,
  resetScopedOnSuccess: true,
};

export interface GetProxyOptions {
  exclude?: string | null;
  country?: string;
  scope?: string;
}

export class ProxyManager {
  private proxies: string[] = [];
  private banMap = new Map<string, BanEntry>();
  private scopedBanMap = new Map<string, BanEntry>(); // "proxy::scope" → BanEntry
  private banConfig: Required<Omit<BanConfig, 'scopeKey'>> | false;
  private countryMap = new Map<string, string>(); // proxy → country code
  private lastSweep = 0;
  /** proxy → requests currently in flight through it. Absent means zero. */
  private leases = new Map<string, number>();
  /** Waiters to re-check the moment a lease is released, so a freed slot is not sat on. */
  private waiters = new Set<() => void>();
  private readonly maxConcurrent: number;

  constructor(proxies: string[], banConfig?: BanConfig | false, maxConcurrentPerProxy?: number) {
    this.proxies = [...proxies];
    // Anything that is not a usable positive count means "no cap", including NaN from a
    // config built out of env vars — a cap of NaN would make every proxy look busy.
    this.maxConcurrent =
      typeof maxConcurrentPerProxy === 'number' && Number.isFinite(maxConcurrentPerProxy) && maxConcurrentPerProxy > 0
        ? Math.floor(maxConcurrentPerProxy)
        : 0;
    // Spreading raw config would let an explicit `undefined` overwrite a default, and the
    // result is silent: `failCount >= undefined` is always false, so nothing ever gets
    // banned. A config built from optional env vars hits this without a word of warning.
    this.banConfig = banConfig === false ? false : { ...DEFAULT_BAN, ...defined(banConfig) };
  }

  /**
   * Whether this entry has outlived its usefulness — either its ban has expired, or it is
   * a set of strikes the proxy has since gone quiet on.
   *
   * Strikes have to age out for `maxFailures` to mean anything. Without it, a proxy that
   * fails once a month accumulates its way to a ban, and an entry no one looks at again
   * sits in the map forever.
   */
  private stale(entry: BanEntry, now: number): boolean {
    if (this.banConfig === false) return false;

    const since = entry.bannedAt > 0 ? entry.bannedAt : entry.lastFailure;
    return now - since >= this.banConfig.duration;
  }

  /**
   * Drop entries nothing will look at again.
   *
   * A scope key is a proxy paired with a target, so a crawler that walks many hosts grows
   * this map without bound — the read paths only ever clean the key they were asked about.
   */
  private sweepScoped(now: number): void {
    if (this.scopedBanMap.size < SWEEP_THRESHOLD) return;
    if (now - this.lastSweep < SWEEP_INTERVAL) return;

    this.lastSweep = now;
    for (const [key, entry] of this.scopedBanMap) {
      if (this.stale(entry, now)) this.scopedBanMap.delete(key);
    }
  }

  /**
   * Get a random non-banned proxy.
   * Supports exclude (skip last failed proxy) and country filter.
   *
   * When `exclude` is set, picks from a *different hostname* than the excluded
   * proxy when possible (provider diversity on retry). Falls back to same-host
   * pool if no other hostname is available.
   *
   * Returns null if none available.
   */
  getProxy(opts?: GetProxyOptions | string | null): string | null {
    // Backwards compat: allow passing just exclude string
    const { exclude, country, scope } = typeof opts === 'string' || opts === null || opts === undefined
      ? { exclude: opts ?? undefined, country: undefined, scope: undefined }
      : opts;

    let available = this.eligible(country, scope);

    // A proxy already carrying its full share of in-flight requests is not a candidate.
    // Handing one out anyway is how a pool that has shrunk to its last survivor funnels
    // every concurrent request onto that one exit IP and rate-limits it instantly.
    if (this.maxConcurrent > 0) {
      available = available.filter((p) => this.atCapacity(p) === false);
    }

    const candidates = exclude
      ? available.filter((p) => p !== exclude)
      : available;

    // If excluding leaves nothing but there are available proxies, fall back
    let pool = candidates.length > 0 ? candidates : available;
    if (pool.length === 0) return null;

    // Provider diversity: prefer different hostname than the excluded proxy
    if (exclude) {
      const excludeHost = getHostname(exclude);
      if (excludeHost) {
        const differentHost = pool.filter((p) => getHostname(p) !== excludeHost);
        if (differentHost.length > 0) pool = differentHost;
      }
    }

    // Spread a burst evenly instead of letting chance stack it. Uniform random over the
    // pool is not wrong so much as lumpy: fire 40 requests at 40 proxies and some draw
    // three while others draw none, and the unlucky ones hit the target's per-IP limit
    // first. Preferring the least-loaded candidates lands the burst flat. With nothing in
    // flight every count is zero, so sequential callers see the same random pick as before.
    const lightest = pool.reduce((min, p) => Math.min(min, this.inFlight(p)), Infinity);
    const idlest = pool.filter((p) => this.inFlight(p) === lightest);

    return idlest[Math.floor(Math.random() * idlest.length)];
  }

  /** Proxies past the ban, country and scope filters — before any capacity filter. */
  private eligible(country?: string, scope?: string): string[] {
    let available = this.getAvailableProxies();

    if (country) {
      const upper = country.toUpperCase();
      available = available.filter((p) => this.countryMap.get(p) === upper);
    }

    if (scope) {
      available = available.filter((p) => !this.isScopedBanned(p, scope));
    }

    return available;
  }

  /** Is this proxy already carrying its full share of in-flight requests? */
  private atCapacity(proxy: string): boolean {
    if (this.maxConcurrent === 0) return false;
    return (this.leases.get(proxy) ?? 0) >= this.maxConcurrent;
  }

  /**
   * Select a proxy and count a request against it in one step.
   *
   * Selection and accounting cannot be two calls: `getProxy` is async from the caller's
   * side, so two requests arriving together would both be handed the same proxy before
   * either had recorded its slot, and the cap would be off by exactly the burst it exists
   * to flatten. Every successful lease needs a matching `release`.
   */
  lease(opts?: GetProxyOptions | string | null): string | null {
    const proxy = this.getProxy(opts);
    if (proxy) this.acquire(proxy);
    return proxy;
  }

  /** Count a request against a proxy the caller named itself. Pair with `release`. */
  acquire(proxy: string): void {
    this.leases.set(proxy, (this.leases.get(proxy) ?? 0) + 1);
  }

  /** Give the slot back and wake anyone waiting for one. */
  release(proxy: string): void {
    const next = (this.leases.get(proxy) ?? 0) - 1;
    if (next > 0) this.leases.set(proxy, next);
    else this.leases.delete(proxy);

    // Copy first: a waiter that succeeds removes itself from the set while we iterate.
    for (const wake of [...this.waiters]) wake();
  }

  /** Requests currently in flight through this proxy. */
  inFlight(proxy: string): number {
    return this.leases.get(proxy) ?? 0;
  }

  /**
   * Are there proxies this caller could use that are merely busy right now?
   *
   * The distinction matters upstream: a pool blocked by bans may justify going out
   * without a proxy, while a pool blocked only by capacity must never — the proxies are
   * fine, they are simply in use, and a moment's wait is the whole answer.
   */
  isCapacityBlocked(opts?: GetProxyOptions): boolean {
    if (this.maxConcurrent === 0) return false;

    const eligible = this.eligible(opts?.country, opts?.scope);
    return eligible.length > 0 && eligible.every((p) => this.atCapacity(p));
  }

  /**
   * Is this proxy usable right now — still in the pool, not banned, and matching
   * the country/scope filters? Used by sessions to decide whether to keep their
   * pinned exit IP or pick a new one.
   */
  isUsable(proxy: string, opts?: GetProxyOptions): boolean {
    if (!this.proxies.includes(proxy)) return false;
    if (!this.getAvailableProxies().includes(proxy)) return false;
    if (opts?.country && this.countryMap.get(proxy) !== opts.country.toUpperCase()) return false;
    if (opts?.scope && this.isScopedBanned(proxy, opts.scope)) return false;
    return true;
  }

  /**
   * Wait until a proxy becomes available (bans expire or list is refreshed).
   * Resolves with the proxy string. Supports country filter.
   *
   * Automatically calculates timeout from the earliest ban expiry.
   * If no ban will ever expire (shouldn't happen), times out after 5 minutes.
   */
  waitForProxy(opts?: GetProxyOptions, cap?: number): Promise<string> {
    return this.waitFor(() => this.getProxy(opts), this.waitCeiling(opts), cap);
  }

  /**
   * Wait until a proxy is free and take a slot on it in the same step — the blocking
   * counterpart to `lease`. Every resolution needs a matching `release`.
   */
  waitForLease(opts?: GetProxyOptions, cap?: number): Promise<string> {
    return this.waitFor(() => this.lease(opts), this.waitCeiling(opts), cap);
  }

  /**
   * Take a slot on one named proxy, waiting if it is already full.
   *
   * For a caller that named its own proxy — a pinned session, most of all. Rotation is
   * not an option there, so the only way to honour the cap is to queue. Nothing outside
   * this client holds these slots, so the wait always ends: the requests ahead finish.
   */
  acquireWhenFree(proxy: string, cap?: number): Promise<string> {
    return this.waitFor(
      () => {
        if (this.atCapacity(proxy)) return null;
        this.acquire(proxy);
        return proxy;
      },
      MAX_WAIT,
      cap,
    );
  }

  private waitFor(pick: () => string | null, ceiling: number, cap: number | undefined): Promise<string> {
    const immediate = pick();
    if (immediate) return Promise.resolve(immediate);

    // A caller on a request path would rather fail than block for the whole ban.
    const maxWait = Number.isFinite(cap) ? Math.min(ceiling, cap as number) : ceiling;

    // Poll several times within the window. A fixed 2s interval would never fire at
    // all when a short ban puts maxWait below it, and the wait would time out even
    // though the proxy had come back.
    const pollInterval = Math.max(MIN_POLL_INTERVAL, Math.min(WAIT_POLL_INTERVAL, Math.floor(maxWait / 4)));

    return new Promise((resolve, reject) => {
      let settled = false;

      const stop = (): void => {
        settled = true;
        clearTimeout(timeout);
        clearInterval(interval);
        this.waiters.delete(wake);
      };

      // Polling alone would make a request wait out the interval for a slot that came
      // free milliseconds ago. Capacity, unlike a ban, has no expiry to schedule against,
      // so release() drives this instead and the poll is only a backstop for bans.
      const wake = (): void => {
        if (settled) return;
        const proxy = pick();
        if (!proxy) return;
        stop();
        resolve(proxy);
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        stop();
        // One last look — a ban may have lapsed between the final poll and now
        const proxy = pick();
        if (proxy) resolve(proxy);
        else reject(new NoProxyAvailableError());
      }, maxWait);

      const interval = setInterval(wake, pollInterval);
      this.waiters.add(wake);

      // Waiting for a proxy must not keep the Node process alive on its own
      timeout.unref?.();
      interval.unref?.();
    });
  }

  /**
   * How long a wait can usefully run before giving up.
   *
   * A ban has an expiry to compute. A busy proxy does not — it frees when the request
   * on it finishes, which no clock here can predict — so capacity falls back to the long
   * ceiling and leans on release() to cut the wait short in practice.
   */
  private waitCeiling(opts?: GetProxyOptions): number {
    if (this.isCapacityBlocked(opts)) return MAX_WAIT;
    return this.getEarliestBanExpiry(opts) ?? MAX_WAIT;
  }

  /** Get ms until the earliest ban expires, or null if no active bans. */
  private getEarliestBanExpiry(opts?: GetProxyOptions): number | null {
    if (this.banConfig === false) return null;

    const now = Date.now();
    const duration = this.banConfig.duration;
    const country = opts?.country?.toUpperCase();

    const remaining = (entry: BanEntry | undefined): number =>
      entry?.bannedAt ? Math.max(0, entry.bannedAt + duration - now) : 0;

    let earliest = Infinity;

    for (const proxy of this.proxies) {
      // A proxy the caller could never be handed says nothing about how long they wait.
      if (country && this.countryMap.get(proxy) !== country) continue;

      // Every ban on a proxy has to lapse before it comes back, so its own wait is the
      // longest of them — and the pool frees up when the first such proxy does. Taking the
      // minimum across both maps instead would promise a proxy that is still banned the
      // other way; reading only the global map, as this did before scoped bans were
      // considered, reports nothing to wait for while every proxy is sidelined for a scope.
      const scoped = opts?.scope ? this.scopedBanMap.get(`${proxy}::${opts.scope}`) : undefined;
      const wait = Math.max(remaining(this.banMap.get(proxy)), remaining(scoped));

      if (wait < earliest) earliest = wait;
    }

    // Add 1s buffer so the ban is definitely expired when we check
    return earliest === Infinity ? null : earliest + 1000;
  }

  /** Get all currently available (non-banned) proxies. */
  getAvailableProxies(): string[] {
    if (this.banConfig === false) return [...this.proxies];

    const now = Date.now();
    this.sweepScoped(now);

    return this.proxies.filter((proxy) => {
      const ban = this.banMap.get(proxy);
      if (!ban) return true;
      if (this.stale(ban, now)) {
        this.banMap.delete(proxy);
        return true;
      }
      return !ban.bannedAt;
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
    const existing = this.banMap.get(proxy);
    // A stale record must not carry its strikes into a fresh incident, or a proxy comes
    // back from a ban with no allowance left and is banned again on its first stumble.
    const entry = existing && this.stale(existing, now) ? undefined : existing;

    if (entry && (now - entry.lastFailure) < this.banConfig.dedupWindow) {
      // Deduped, but still a failure: a success right after it is part of this burst.
      entry.lastSeenFailure = now;
      return entry.bannedAt > 0;
    }

    const failCount = (entry?.failCount ?? 0) + 1;
    const bannedAt = failCount >= this.banConfig.maxFailures ? now : 0;

    this.banMap.set(proxy, { bannedAt, failCount, lastFailure: now, lastSeenFailure: now });
    return bannedAt > 0;
  }

  /** Report a proxy success — resets its fail count. */
  reportSuccess(proxy: string): void {
    if (this.banConfig === false) return;

    const entry = this.banMap.get(proxy);
    if (!entry || !this.forgivable(entry)) return;
    this.banMap.delete(proxy);
  }

  /**
   * Report a scoped proxy failure. Returns true if the proxy got scoped-banned.
   * Proxy is banned only for the given scope (e.g. hostname), not globally.
   */
  reportScopedFailure(proxy: string, scope: string): boolean {
    if (this.banConfig === false) return false;

    const key = `${proxy}::${scope}`;
    const now = Date.now();
    this.sweepScoped(now);

    const existing = this.scopedBanMap.get(key);
    const entry = existing && this.stale(existing, now) ? undefined : existing;

    if (entry && (now - entry.lastFailure) < this.banConfig.dedupWindow) {
      entry.lastSeenFailure = now;
      return entry.bannedAt > 0;
    }

    const failCount = (entry?.failCount ?? 0) + 1;
    const bannedAt = failCount >= this.banConfig.maxFailures ? now : 0;

    this.scopedBanMap.set(key, { bannedAt, failCount, lastFailure: now, lastSeenFailure: now });
    return bannedAt > 0;
  }

  /** Report a scoped proxy success — resets its scoped fail count. */
  reportScopedSuccess(proxy: string, scope: string): void {
    if (this.banConfig === false) return;
    if (!this.banConfig.resetScopedOnSuccess) return;

    const key = `${proxy}::${scope}`;
    const entry = this.scopedBanMap.get(key);
    if (!entry || !this.forgivable(entry)) return;

    this.scopedBanMap.delete(key);
  }

  /**
   * Drop a proxy's global ban and strikes outright.
   *
   * The deliberate counterpart to `reportSuccess`, which will not undo a ban that is still
   * running. Use it when something other than a request answering 200 says the proxy is
   * fine again — an operator, or a checker of your own.
   */
  clearBan(proxy: string): void {
    this.banMap.delete(proxy);
  }

  /** The same for one scope. */
  clearScopedBan(proxy: string, scope: string): void {
    this.scopedBanMap.delete(`${proxy}::${scope}`);
  }

  /**
   * Whether a success is allowed to wipe this entry.
   *
   * Two things stop it. A ban that is still running outlives any success: the request that
   * earned the ban and the ones that answer 200 right behind it are the same burst, so
   * letting those clear it means a ban never survives the moment it was created. And a
   * success inside the dedup window of a failure belongs to that same burst, so it says
   * nothing about whether the proxy is welcome again — a target that rate-limits per IP
   * answers some of a burst and refuses the rest.
   */
  private forgivable(entry: BanEntry): boolean {
    if (this.banConfig === false) return true;

    const now = Date.now();
    if (entry.bannedAt > 0 && (now - entry.bannedAt) < this.banConfig.duration) return false;
    // Deliberately the last failure seen rather than the last one counted: inside a burst
    // the counted one stays put, and reading it would let a long burst age its own way out.
    if ((now - entry.lastSeenFailure) < this.banConfig.dedupWindow) return false;

    return true;
  }

  /** Check if a proxy is scoped-banned for a given scope. */
  private isScopedBanned(proxy: string, scope: string): boolean {
    if (this.banConfig === false) return false;

    const key = `${proxy}::${scope}`;
    const entry = this.scopedBanMap.get(key);
    if (!entry) return false;

    const now = Date.now();
    if (this.stale(entry, now)) {
      this.scopedBanMap.delete(key);
      return false;
    }

    return entry.bannedAt > 0;
  }

  /** Replace the proxy list and clear all bans + country data. */
  replaceProxies(proxies: string[]): void {
    this.proxies = [...proxies];
    this.banMap.clear();
    this.scopedBanMap.clear();
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

  /**
   * What the pool looks like for one caller's filters, right now.
   *
   * `available` and `banned` read the global ban map only, so on a crawl that scoped-bans
   * per target they report a healthy pool while every proxy is sidelined for the host in
   * hand. This is the view that separates the two, plus the proxies that are merely busy.
   */
  status(opts?: GetProxyOptions): PoolStatus {
    const available = this.getAvailableProxies();
    const eligible = this.eligible(opts?.country, opts?.scope);
    const free = eligible.filter((p) => this.atCapacity(p) === false);

    let inFlight = 0;
    for (const count of this.leases.values()) inFlight += count;

    return {
      total: this.proxies.length,
      banned: this.proxies.length - available.length,
      scopedBanned: opts?.scope
        ? available.filter((p) => this.isScopedBanned(p, opts.scope as string)).length
        : 0,
      busy: eligible.length - free.length,
      usable: free.length,
      inFlight,
    };
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

/** Extract hostname from a proxy URL. Returns null on parse failure. */
function getHostname(proxyUrl: string): string | null {
  try {
    return new URL(proxyUrl).hostname;
  } catch {
    return null;
  }
}
