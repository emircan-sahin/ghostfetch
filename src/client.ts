import { randomUUID } from 'node:crypto';
import initCycleTLS, { CycleTLSClient, CycleTLSRequestOptions } from 'cycletls';
import { ProxyManager } from './proxy-manager';
import { classifyError, isCloudflareChallenge, checkInterceptors, checkDefaultRetryStatus, runCheck } from './classifier';
import {
  DEFAULT_DELAYS,
  DEFAULT_MAX_RETRY_AFTER,
  applyJitter,
  parseRetryAfter,
  resolveDelays,
  resolveJitter,
} from './retry';
import { GhostFetchRequestError, CloudflareJSChallengeError, NoProxyAvailableError, MaxRetriesExceededError, InterceptorError } from './errors';
import { getBrowserProfile } from './presets';
import { decompress } from './decompress';
import { Session } from './session';
import {
  GhostFetchConfig,
  GhostFetchResponse,
  HealthCheckResult,
  Interceptor,
  RequestOptions,
  RetryConfig,
  HttpMethod,
} from './types';

/**
 * Fields CycleTLS takes verbatim from the config. These describe one client identity,
 * so there is deliberately no per-request override — mixing a Chrome JA3 into a request
 * that otherwise looks like Firefox is a louder signal than not spoofing at all.
 *
 * Typing the keys against both sides means a rename on either one fails the build
 * instead of silently dropping the option.
 */
const IDENTITY_OPTIONS = [
  'ja3',
  'ja4r',
  'http2Fingerprint',
  'quicFingerprint',
  'userAgent',
  'disableGrease',
] as const satisfies readonly (keyof GhostFetchConfig & keyof CycleTLSRequestOptions)[];

/** Fields CycleTLS takes verbatim, resolved request-first and falling back to config. */
const PASSTHROUGH_OPTIONS = [
  'headerOrder',
  'orderAsProvided',
  'insecureSkipVerify',
  'forceHTTP1',
  'forceHTTP3',
  'serverName',
  'cookies',
] as const satisfies readonly (keyof GhostFetchConfig &
  keyof RequestOptions &
  keyof CycleTLSRequestOptions)[];

/** What `judge` concluded about a response. */
type Verdict =
  | { kind: 'return' }
  | { kind: 'throw'; error: Error }
  | { kind: 'retry'; error: GhostFetchRequestError; honourRetryAfter: boolean };

const DEFAULT_TIMEOUT = 30000;
const HEALTH_BATCH_CONCURRENCY = 10;
const HEALTH_RETRY_DELAYS = [0, 3000]; // 2 attempts: immediate, then +3s
const DEFAULT_HEALTH_URL = 'https://ipinfo.io/json';
const DEFAULT_HEALTH_TIMEOUT = 10000;

/** Head-room added to the computed health-check ceiling for init and scheduling. */
const HEALTH_CEILING_SLACK = 15000;

/**
 * Close the transport after this long with nothing in flight. Off by default.
 *
 * Off, because closing is not free and not always wanted: the transport is ~25MB of
 * Go subprocess that stays flat once warm, reopening costs ~110ms on the next request,
 * and every close/reopen cycle walks the CycleTLS teardown path that `withTransport`
 * and `initWithRetry` exist to survive. A long-lived server should never pay for that
 * on our say-so.
 *
 * The cost of it being off is that a script which never calls `destroy()` will not
 * exit — CycleTLS' subprocess holds the event loop open. Scripts, tests and cron jobs
 * should call `destroy()`, or set an `idleTimeout` if threading that through is awkward.
 */
const DEFAULT_IDLE_TIMEOUT = 0;

/**
 * Re-opening the transport right after a teardown can land while the previous Go
 * process still holds CycleTLS' default port. CycleTLS then assumes another host owns
 * that port, registers a shared instance pointing at nothing, and caches it — so every
 * later attempt on the same port inherits the broken instance. Retrying on a fresh
 * port sidesteps both the lingering socket and the poisoned cache entry.
 *
 * Detection is left to the first real request (see `withTransport`) rather than a probe
 * at init: a probe costs every cold start a round trip, and CycleTLS does not enforce
 * its own timeout client-side, so a probe that should fail fast can hang for seconds.
 */
const INIT_ATTEMPTS = 4;
const INIT_RETRY_DELAY = 150;

/**
 * How long an init attempt may spend connecting before we give up on it.
 *
 * CycleTLS waits 20s by default, which is the right patience for a slow machine but
 * a terrible way to discover that the port we picked is a dead end — that case wants
 * a fast failure so the next attempt can try a private port. Connecting normally takes
 * a shade over 100ms, so this is generous. The final attempt keeps CycleTLS' own
 * budget, in case the machine really is just slow.
 */
const INIT_CONNECT_TIMEOUT = 3000;

/**
 * How long after tearing a transport down the shared port stays suspect.
 *
 * The lingering socket is what makes CycleTLS mistake the port for someone else's,
 * and it clears in well under a second — but an init that lands inside the window
 * burns the whole connect timeout before it can recover. Starting on a private port
 * during the cooldown skips that dead end; outside it, sharing resumes.
 */
const SHARED_PORT_COOLDOWN = 5000;

/** When the shared CycleTLS port was last released, by any client in this process. */
let lastSharedTeardown = 0;

export class GhostFetch {
  private cycleTLS: CycleTLSClient | null = null;
  private initPromise: Promise<void> | null = null;
  private proxyManager: ProxyManager;
  private interceptors: Interceptor[] = [];
  private config: GhostFetchConfig;
  private retryDefaults: RetryConfig;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  /** Set once the shared CycleTLS port has handed us a dead transport. */
  private usePrivatePort = false;
  private healthCheckPromise: Promise<HealthCheckResult> | null = null;
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Map<string, Session>();

  constructor(userConfig: GhostFetchConfig = {}) {
    // A `browser` preset is expanded once here so the rest of the class only ever
    // reads concrete fields
    const config = applyBrowserPreset(userConfig);
    this.config = config;

    // Start with empty proxy list — healthCheck will populate it
    this.proxyManager = new ProxyManager([], config.ban);
    this.retryDefaults = { delays: config.retry?.delays ?? DEFAULT_DELAYS };

    // Auto health check on init if proxies provided
    const proxies = config.proxies;
    if (proxies?.length && config.healthCheck === false) {
      // Skipped by config — trust the list as given
      this.proxyManager.replaceProxies(proxies);
    } else if (proxies?.length) {
      this.healthCheckPromise = this.healthCheckProxies(proxies).catch(() => {
        // Prevent unhandled rejection — return empty result so ready() resolves safely
        return { total: proxies.length, healthy: 0, dead: proxies.length, countries: {}, proxies: {} };
      });
    }

    // Start proxy refresh interval only if both callback and interval are provided
    if (config.onProxyRefresh && config.proxyRefreshInterval) {
      // Swallow rejections — a failing refresh must not crash the host process
      this.refreshTimer = setInterval(() => {
        this.refreshProxies().catch(() => {});
      }, config.proxyRefreshInterval);
      this.refreshTimer.unref?.();
    }
  }

  /**
   * Wait until the initial health check is complete.
   * Returns health check results with proxy details and country info.
   * Every request awaits this internally, not only the first — so a health check that
   * cannot finish would stall the whole client, which is what the per-probe timeout and
   * the overall ceiling are there to prevent.
   *
   * @example
   * const result = await client.ready();
   * console.log(result);
   * // {
   * //   total: 10, healthy: 8, dead: 2,
   * //   countries: { US: 3, DE: 5 },
   * //   proxies: { 'http://...@host:8001': 'US', 'http://...@host:8002': 'DE', ... }
   * // }
   */
  async ready(): Promise<HealthCheckResult> {
    if (this.healthCheckPromise) return this.healthCheckPromise;
    return { total: 0, healthy: 0, dead: 0, countries: {}, proxies: {} };
  }

  /**
   * Run a CycleTLS call, rebuilding the transport once if it turns out to be dead.
   *
   * The shared instance can go away underneath us — our own idle shutdown, another
   * client exiting, or CycleTLS restarting after a fatal error. That is a broken
   * transport rather than a failed request, so it should not burn a retry attempt.
   */
  private async withTransport<T>(
    fn: (client: CycleTLSClient) => Promise<T>,
    existing?: CycleTLSClient,
  ): Promise<T> {
    const client = existing ?? (await this.ensureClient());

    try {
      return await fn(client);
    } catch (err) {
      if (!isDeadTransportError(err)) throw err;

      // A dead transport on the shared port means CycleTLS has cached an instance
      // pointing at nothing, and every later init on that port would inherit it.
      // Rebuild on a port of our own.
      this.usePrivatePort = true;
      await this.closeTransport();
      return fn(await this.ensureClient());
    }
  }

  /** Lazy-initialize CycleTLS instance. */
  private async ensureClient(): Promise<CycleTLSClient> {
    if (this.cycleTLS) return this.cycleTLS;

    if (!this.initPromise) {
      this.initPromise = initWithRetry(this.usePrivatePort)
        .then((client) => {
          this.cycleTLS = client;
        })
        .catch((err) => {
          // Reset so a later request can retry init instead of reusing a rejected promise
          this.initPromise = null;
          throw err;
        });
    }

    await this.initPromise;
    return this.cycleTLS!;
  }

  /** Add a custom interceptor for site-specific error handling. */
  addInterceptor(interceptor: Interceptor): void {
    this.interceptors.push(interceptor);
  }

  /** Remove an interceptor by name. */
  removeInterceptor(name: string): void {
    this.interceptors = this.interceptors.filter((i) => i.name !== name);
  }

  /** Manually refresh the proxy list via the onProxyRefresh callback. */
  async refreshProxies(): Promise<void> {
    if (!this.config.onProxyRefresh) return;
    if (this.refreshing) return; // prevent overlapping refreshes

    // Wait for any in-progress health check (e.g., initial startup)
    if (this.healthCheckPromise) await this.healthCheckPromise;

    this.refreshing = true;
    try {
      const proxies = await this.config.onProxyRefresh();

      if (this.config.healthCheck === false) {
        this.proxyManager.replaceProxies(proxies);
        return;
      }

      // healthCheckProxies replaces the pool with the healthy subset, and keeps the
      // current pool if every proxy failed (see the guard in there)
      await this.healthCheckProxies(proxies);
    } finally {
      this.refreshing = false;
    }
  }

  /** Get proxy manager stats. */
  get stats() {
    return {
      totalProxies: this.proxyManager.total,
      availableProxies: this.proxyManager.available,
      bannedProxies: this.proxyManager.banned,
    };
  }

  /**
   * Get a session — a request runner that pins one proxy and keeps a cookie jar,
   * so a multi-step flow (login, then the pages behind it) looks like one visitor
   * instead of a new IP on every request.
   *
   * Named sessions are reused across calls; omit the key for a throwaway one.
   *
   * @example
   * const s = client.session('user-1');
   * await s.post('https://site.com/login', { body: { user, pass } });
   * await s.get('https://site.com/account'); // same IP, cookies replayed
   */
  session(key: string = randomUUID()): Session {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session = new Session(
      key,
      (method, url, options) => this.request(method, url, options),
      (current, url, options) => this.pickSessionProxy(current, url, options),
    );

    this.sessions.set(key, session);
    return session;
  }

  /** Forget a session and everything it was holding (cookies, pinned proxy). */
  destroySession(key: string): boolean {
    return this.sessions.delete(key);
  }

  /**
   * Keep a session on its pinned proxy while that proxy is still usable, and pick a
   * replacement when it has been banned, filtered out, or removed from the pool.
   */
  private async pickSessionProxy(
    current: string | null,
    url: string,
    options: RequestOptions,
  ): Promise<string | null> {
    const scope = this.getScopeKey(url);
    const filters = { country: options.country, scope };

    if (current && this.proxyManager.isUsable(current, filters)) return current;

    const forceProxy = options.forceProxy ?? this.config.forceProxy ?? false;
    return this.pickProxy(
      forceProxy,
      current,
      options.country,
      scope,
      options.proxyWaitTimeout ?? this.config.proxyWaitTimeout,
    );
  }

  /** Get all non-banned proxy URLs, optionally filtered by country. */
  getAvailableProxies(opts?: { country?: string }): string[] {
    const proxies = this.proxyManager.getAvailableProxies();
    if (!opts?.country) return proxies;
    return proxies.filter(
      (p) => this.proxyManager.getCountry(p) === opts.country!.toUpperCase(),
    );
  }

  // --- HTTP methods ---

  async get(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('GET', url, options);
  }

  async post(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('POST', url, options);
  }

  async put(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('PUT', url, options);
  }

  async delete(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('DELETE', url, options);
  }

  async patch(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('PATCH', url, options);
  }

  async head(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('HEAD', url, options);
  }

  async options(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('OPTIONS', url, options);
  }

  // --- Core request logic ---

  /** Extract scope key from URL for scoped bans. */
  private getScopeKey(url: string): string {
    const banConfig = this.config.ban;
    if (banConfig && typeof banConfig === 'object' && banConfig.scopeKey) {
      return banConfig.scopeKey(url);
    }
    try { return new URL(url).hostname; } catch { return url; }
  }

  /**
   * Mark a request as fully successful — resets the proxy's global fail counter
   * and, when the request was scoped, its scope-level counter as well.
   */
  private markSuccess(proxy: string | null, scope?: string): void {
    if (!proxy) return;
    this.proxyManager.reportSuccess(proxy);
    if (scope) this.proxyManager.reportScopedSuccess(proxy, scope);
  }

  /** Settle the retry knobs for one request: per-request wins, then config, then defaults. */
  private resolveRetryPlan(options?: RequestOptions): {
    delays: number[];
    jitter: number;
    respectRetryAfter: boolean;
    maxRetryAfter: number;
  } {
    const config = this.config.retry;

    return {
      delays: resolveDelays(options?.retry, this.retryDefaults.delays ?? DEFAULT_DELAYS),
      jitter: resolveJitter(options?.retry, resolveJitter(config, 0)),
      respectRetryAfter: options?.retry?.respectRetryAfter ?? config?.respectRetryAfter ?? true,
      maxRetryAfter: options?.retry?.maxRetryAfter ?? config?.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER,
    };
  }

  async request(method: HttpMethod, url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    this.inFlight++;
    this.clearIdleTimer();
    try {
      return await this.attemptRequest(method, url, options);
    } finally {
      this.inFlight--;
      this.scheduleIdleShutdown();
    }
  }

  private async attemptRequest(method: HttpMethod, url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    // Wait for health check to finish before first request
    await this.ready();

    const { delays, jitter, respectRetryAfter, maxRetryAfter } = this.resolveRetryPlan(options);
    const maxAttempts = delays.length + 1; // first attempt + retries
    const forceProxy = options?.forceProxy ?? this.config.forceProxy ?? false;
    const scope = this.getScopeKey(url);
    let lastError: GhostFetchRequestError | null = null;
    let lastFailedProxy: string | null | undefined = null;
    /** Set when the last response asked us to wait a specific amount (Retry-After). */
    let retryAfterMs: number | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before retry (not on first attempt)
      if (attempt > 0) {
        // A server-provided Retry-After wins over the schedule and is never jittered
        const wait = retryAfterMs ?? applyJitter(delays[attempt - 1], jitter);
        retryAfterMs = null;
        await sleep(wait);
      }

      // Pick a proxy (scope-aware: excludes scoped-banned proxies for this URL)
      const proxy: string | null = options?.proxy ??
        (await this.pickProxy(
          forceProxy,
          lastFailedProxy,
          options?.country,
          scope,
          options?.proxyWaitTimeout ?? this.config.proxyWaitTimeout,
        ));

      try {
        const response = await this.executeRequest(method, url, proxy, options);
        const verdict = this.judge(url, response, proxy, scope, options);

        if (verdict.kind === 'return') return response;
        if (verdict.kind === 'throw') throw verdict.error;

        lastError = verdict.error;
        lastFailedProxy = proxy;
        retryAfterMs = verdict.honourRetryAfter
          ? readRetryAfter(response, respectRetryAfter, maxRetryAfter)
          : null;
      } catch (error) {
        // A Cloudflare challenge we chose to throw on, and a throwing interceptor
        // (which is the caller's bug), both mean stop — retrying would only bury them
        // inside a MaxRetriesExceededError.
        if (error instanceof CloudflareJSChallengeError) throw error;
        if (error instanceof InterceptorError) throw error;

        lastError = this.recordTransportFailure(error, proxy);
        lastFailedProxy = proxy;
      }
    }

    // With cloudflare: 'retry' the challenge is the real cause — surface it directly
    // so `err instanceof CloudflareJSChallengeError` keeps working.
    if (lastError instanceof CloudflareJSChallengeError) throw lastError;

    throw new MaxRetriesExceededError(
      maxAttempts,
      lastError ?? new GhostFetchRequestError({ type: 'server', message: `Request to ${url} failed` }),
    );
  }

  /**
   * Decide what a response means, in the order documented in the interceptor flow:
   * per-request interceptor, then instance interceptors, then Cloudflare, then the
   * default retry statuses, then plain success.
   *
   * Kept separate from the retry loop so that loop reads as control flow and this
   * reads as policy — and so a new branch cannot forget to update the bookkeeping the
   * loop does around it.
   */
  private judge(
    url: string,
    response: GhostFetchResponse,
    proxy: string | null,
    scope: string,
    options?: RequestOptions,
  ): Verdict {
    // 1. Per-request interceptor takes highest priority
    if (options?.interceptor) {
      const action = runCheck(options.interceptor.check, 'request', response);
      // null → fall through to instance interceptors
      if (action !== null) return this.verdictFor(action, 'request', response, proxy, scope);
    }

    // 2. Instance-level interceptors — first match takes full ownership
    const { matched, action, interceptor } = checkInterceptors(url, response, this.interceptors);

    if (matched) {
      // A match with no action still claims the response; defaults are bypassed
      if (action === 'skip' || action === null) {
        this.markSuccess(proxy, scope);
        return { kind: 'return' };
      }
      return this.verdictFor(action, interceptor?.name ?? 'unnamed', response, proxy, scope);
    }

    // 3. Cloudflare JS challenge (only when no interceptor claimed the response)
    if (isCloudflareChallenge(response)) {
      const challenge = new CloudflareJSChallengeError(url, proxy ?? undefined);
      if ((this.config.cloudflare ?? 'throw') === 'throw') return { kind: 'throw', error: challenge };

      // 'retry' — another exit IP often sails through, so rotate instead of giving up.
      // The proxy itself is fine, so it is not penalized.
      this.markSuccess(proxy, scope);
      return { kind: 'retry', error: challenge, honourRetryAfter: false };
    }

    // 4. No interceptor matched → default retry statuses (429, 503, 407)
    const defaultRetry = checkDefaultRetryStatus(response.status);
    if (defaultRetry) {
      if (proxy) {
        // 407 means the proxy itself is broken; 429/503 came from the server
        if (defaultRetry === 'proxy') this.proxyManager.reportFailure(proxy);
        else this.proxyManager.reportSuccess(proxy);
      }

      return {
        kind: 'retry',
        honourRetryAfter: true,
        error: new GhostFetchRequestError({
          type: defaultRetry,
          message: `HTTP ${response.status}`,
          status: response.status,
          body: response.body,
          proxy: proxy ?? undefined,
        }),
      };
    }

    // 5. Nothing objected — hand it back
    this.markSuccess(proxy, scope);
    return { kind: 'return' };
  }

  /**
   * Turn a thrown error into a retryable one, crediting or blaming the proxy.
   * 'ambiguous' errors (timeouts, resets) leave the proxy's record untouched — they
   * are as likely to be the target's fault as the proxy's.
   */
  private recordTransportFailure(error: unknown, proxy: string | null): GhostFetchRequestError {
    const errorType = classifyError(error);

    if (proxy) {
      if (errorType === 'proxy') this.proxyManager.reportFailure(proxy);
      else if (errorType === 'server') this.proxyManager.reportSuccess(proxy);
    }

    if (error instanceof GhostFetchRequestError) return error;

    return new GhostFetchRequestError({
      type: errorType,
      message: error instanceof Error ? error.message : String(error),
      proxy: proxy ?? undefined,
      cause: error,
    });
  }

  /**
   * Pick a proxy based on forceProxy and country settings.
   * - If forceProxy: wait until a proxy is available (blocks)
   * - If !forceProxy: return null if none available (proceed without proxy)
   */
  private async pickProxy(
    forceProxy: boolean,
    exclude?: string | null,
    country?: string,
    scope?: string,
    waitTimeout?: number,
  ): Promise<string | null> {
    const opts = { exclude, country, scope };
    const proxy = this.proxyManager.getProxy(opts);

    if (proxy) return proxy;

    // No proxy available
    if (this.proxyManager.total === 0) {
      // No proxies configured at all
      if (forceProxy) throw new NoProxyAvailableError();
      return null;
    }

    // Proxies exist but all banned or none match the country filter
    if (forceProxy) {
      // If filtering by country and no proxies exist for that country, fail immediately
      if (country && this.proxyManager.getProxiesByCountry(country).length === 0) {
        throw new NoProxyAvailableError();
      }
      // Wait until one becomes available (ban expires or refresh happens)
      return this.proxyManager.waitForProxy(opts, waitTimeout);
    }

    // Not forced — proceed without proxy
    return null;
  }

  /** Translate an interceptor's action into a verdict, applying its proxy side effect. */
  private verdictFor(
    action: 'retry' | 'ban' | 'scopedBan' | 'skip',
    name: string,
    response: GhostFetchResponse,
    proxy: string | null,
    scope?: string,
  ): Verdict {
    if (action === 'skip') {
      this.markSuccess(proxy, scope);
      return { kind: 'return' };
    }

    if (proxy) {
      if (action === 'ban') this.proxyManager.reportFailure(proxy);
      else if (action === 'scopedBan' && scope) this.proxyManager.reportScopedFailure(proxy, scope);
      // 'retry' — the interceptor is telling us the proxy did its job
      else if (action === 'retry') this.proxyManager.reportSuccess(proxy);
    }

    const detail = action === 'scopedBan' ? `scopedBan [${scope}]` : action;

    return {
      kind: 'retry',
      honourRetryAfter: true,
      error: new GhostFetchRequestError({
        // 'retry' blames the server; a ban of either kind blames the proxy
        type: action === 'retry' ? 'server' : 'proxy',
        message: `Interceptor "${name}": ${detail} (HTTP ${response.status})`,
        status: response.status,
        body: response.body,
        proxy: proxy ?? undefined,
      }),
    };
  }

  private async executeRequest(
    method: HttpMethod,
    url: string,
    proxy: string | null,
    options?: RequestOptions,
  ): Promise<GhostFetchResponse> {
    const client = await this.ensureClient();
    const timeout = options?.timeout ?? this.config.timeout ?? DEFAULT_TIMEOUT;

    // Case-insensitive: `Accept-Language` from the caller must replace an
    // `accept-language` default, not sit alongside it as a second header
    const headers = mergeHeaders(this.config.headers, options?.headers);

    const cycleTLSOptions: CycleTLSRequestOptions = {
      headers,
      timeout,
      // CycleTLS defaults to 'json', which parses the body and forces a re-stringify —
      // that loses the raw bytes (formatting, big-number precision). Ask for the raw
      // bytes instead so text stays verbatim and binary payloads survive intact.
      responseType: 'arraybuffer',
      disableRedirect: options?.disableRedirect ?? this.config.disableRedirect ?? false,
    };

    if (proxy) {
      cycleTLSOptions.proxy = proxy;
    }

    const target = cycleTLSOptions as Record<string, unknown>;

    for (const key of IDENTITY_OPTIONS) {
      if (this.config[key] != null) target[key] = this.config[key];
    }

    for (const key of PASSTHROUGH_OPTIONS) {
      const value = options?.[key] ?? this.config[key];
      if (value != null) target[key] = value;
    }

    // Body handling
    if (options?.body) {
      // mergeHeaders lower-cased every name, so a plain lookup is enough here
      if (options.body instanceof URLSearchParams) {
        cycleTLSOptions.body = options.body;
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else if (typeof options.body === 'string') {
        cycleTLSOptions.body = options.body;
      } else {
        cycleTLSOptions.body = JSON.stringify(options.body);
        headers['content-type'] ??= 'application/json';
      }
    }

    const response = await this.withTransport((c) => {
      const methodFn = c[method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options'];
      return withTimeout(methodFn(url, cycleTLSOptions), timeout);
    }, client);

    const { headers: responseHeaders, setCookie } = normalizeHeaders(response.headers);

    // CycleTLS' Go transport only auto-decompresses while it owns Accept-Encoding.
    // Once a caller sets that header (any browser preset does), the bytes arrive
    // still compressed and it falls to us to decode them.
    const raw = await decompress(
      toBuffer(response.data),
      responseHeaders['content-encoding'],
      this.config.maxDecompressedSize,
    );

    // Decode lazily: fetching a 10MB image should not also build a 10MB string
    let decoded: string | undefined;
    const text = () => (decoded ??= raw.length === 0 ? '' : raw.toString('utf-8'));

    return {
      status: response.status,
      headers: responseHeaders,
      setCookie,
      get body() { return text(); },
      url: response.finalUrl || url,
      json: <T = unknown>() => JSON.parse(text()) as T,
      buffer: () => raw,
      arrayBuffer: () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    };
  }

  /**
   * Health check + country resolution for proxies.
   * Each proxy gets up to 2 attempts (immediately, then +3s) to reach ipinfo.io.
   * Healthy proxies are added to the pool with their country code.
   * Failed proxies are discarded — unless *every* proxy fails while a working
   * pool already exists, in which case the current pool is kept (transient outage).
   */
  private async healthCheckProxies(proxies: string[]): Promise<HealthCheckResult> {
    this.inFlight++;
    this.clearIdleTimer();
    try {
      // A ceiling on the whole sweep, on top of the per-probe timeout. Requests await
      // ready(), so anything that can leave this pending takes the entire client with
      // it — that is worth a second guarantee rather than trusting one.
      return await withTimeout(this.runHealthCheck(proxies), this.healthCheckCeiling(proxies.length))
        .catch((err) => {
          if (!(err instanceof TimeoutError)) throw err;
          // Give back an empty result rather than rejecting: ready() is on the path of
          // every request, and the pool guard in runHealthCheck keeps any working pool.
          return { total: proxies.length, healthy: 0, dead: proxies.length, countries: {}, proxies: {} };
        });
    } finally {
      this.inFlight--;
      this.scheduleIdleShutdown();
    }
  }

  /** Longest the whole health sweep may take: every batch, every attempt, plus slack. */
  private healthCheckCeiling(proxyCount: number): number {
    const settings = this.config.healthCheck === false ? {} : this.config.healthCheck ?? {};
    const timeout = settings.timeout ?? DEFAULT_HEALTH_TIMEOUT;

    const batches = Math.max(1, Math.ceil(proxyCount / HEALTH_BATCH_CONCURRENCY));
    const perProxy = HEALTH_RETRY_DELAYS.reduce((total, delay) => total + delay + timeout, 0);

    return batches * perProxy + HEALTH_CEILING_SLACK;
  }

  private async runHealthCheck(proxies: string[]): Promise<HealthCheckResult> {
    await this.ensureClient();
    const settings = this.config.healthCheck === false ? {} : this.config.healthCheck ?? {};
    const url = settings.url ?? DEFAULT_HEALTH_URL;
    const timeout = settings.timeout ?? DEFAULT_HEALTH_TIMEOUT;
    const healthy: string[] = [];
    const proxyDetails: Record<string, string | null> = {};
    const countries: Record<string, number> = {};
    const countryEntries: [string, string][] = [];

    // Process in batches
    for (let i = 0; i < proxies.length; i += HEALTH_BATCH_CONCURRENCY) {
      const batch = proxies.slice(i, i + HEALTH_BATCH_CONCURRENCY);

      await Promise.allSettled(
        batch.map(async (proxy) => {
          for (let attempt = 0; attempt < HEALTH_RETRY_DELAYS.length; attempt++) {
            if (attempt > 0) {
              await sleep(HEALTH_RETRY_DELAYS[attempt]);
            }

            try {
              // withTimeout for the same reason executeRequest needs it: CycleTLS
              // hands `timeout` to Go and does not enforce it here, so a target that
              // accepts the connection and then never answers leaves the promise
              // unsettled — which used to hang ready(), and with it every request,
              // for the life of the client.
              const res = await withTimeout(
                this.withTransport((c) =>
                  c.get(url, {
                    proxy,
                    timeout,
                    headers: {},
                    // Same reasoning as executeRequest: take the raw bytes and decode
                    // them ourselves rather than letting CycleTLS parse and re-serialize
                    responseType: 'arraybuffer',
                  }),
                ),
                timeout,
              );

              const { headers: resHeaders } = normalizeHeaders(res.headers);
              const bytes = await decompress(
                toBuffer(res.data),
                resHeaders['content-encoding'],
                this.config.maxDecompressedSize,
              );
              const decoded = bytes.toString('utf-8');
              const data = decoded ? JSON.parse(decoded) : {};
              const country: string | null = data.country ?? null;

              if (country) {
                countryEntries.push([proxy, country]);
                countries[country] = (countries[country] ?? 0) + 1;
              }

              proxyDetails[proxy] = country;
              healthy.push(proxy);
              return;
            } catch {
              // Will retry or discard
            }
          }
          // Every attempt failed — proxy is dead
          proxyDetails[proxy] = null;
        }),
      );
    }

    // Add only healthy proxies to the manager, then restore country data.
    // Guard: a refresh where every proxy fails (network blip, provider outage) must not
    // wipe a pool that is currently working — keep the existing one instead.
    const wouldWipeWorkingPool =
      healthy.length === 0 && proxies.length > 0 && this.proxyManager.total > 0;

    if (!wouldWipeWorkingPool) {
      this.proxyManager.replaceProxies(healthy);
      for (const [proxy, country] of countryEntries) {
        this.proxyManager.setCountry(proxy, country);
      }
    }

    return {
      total: proxies.length,
      healthy: healthy.length,
      dead: proxies.length - healthy.length,
      countries,
      proxies: proxyDetails,
    };
  }

  /**
   * Gracefully shut down the CycleTLS instance and clear timers.
   *
   * Always call this when you are done — CycleTLS holds a Go subprocess open, so a
   * script that skips `destroy()` will never exit. Use `idleTimeout` if you would
   * rather have that happen automatically.
   */
  async destroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearIdleTimer();
    this.sessions.clear();
    await this.closeTransport();
  }

  /**
   * Close the CycleTLS transport without tearing the client down.
   * A later request transparently re-opens it via ensureClient().
   */
  private async closeTransport(): Promise<void> {
    if (!this.cycleTLS) return;

    const client = this.cycleTLS;
    this.cycleTLS = null;
    this.initPromise = null;

    try {
      await client.exit();
    } catch {
      // CycleTLS may throw ESRCH when the Go process is already gone
    }

    lastSharedTeardown = Date.now();

    // CycleTLS tears the shared instance down asynchronously but only removes it from
    // its registry once that finishes. Re-initializing too soon hands us the instance
    // that is already shutting down, so let the teardown drain first.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Close the transport once the client has been idle for `idleTimeout` ms. */
  private scheduleIdleShutdown(): void {
    const idleTimeout = this.config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    if (!idleTimeout || this.inFlight > 0 || this.idleTimer) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight === 0) void this.closeTransport();
    }, idleTimeout);

    // unref: the timer should let the process exit, not hold it open
    this.idleTimer.unref?.();
  }
}

/**
 * Does this error mean the CycleTLS transport is gone rather than the request failing?
 * CycleTLS surfaces this as a plain Error with no code, so the message is all we have.
 */
function isDeadTransportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('WebSocket server not connected') ||
    message.includes('shared instance') ||
    message.includes('Instance is shutting down')
  );
}

/** Read a `Retry-After` header off a response, clamped to `max`. */
function readRetryAfter(
  response: GhostFetchResponse,
  enabled: boolean,
  max: number,
): number | null {
  if (!enabled) return null;
  const parsed = parseRetryAfter(response.headers['retry-after']);
  return parsed == null ? null : Math.min(parsed, max);
}

/**
 * Merge header maps, later sources winning.
 *
 * Header names are case-insensitive over the wire and mandatory-lowercase over
 * HTTP/2, but a plain object spread treats `Accept-Language` and `accept-language`
 * as two different keys — so an override would silently become a duplicate header
 * and which one the server honours is anyone's guess. Lower-casing as we merge is
 * what makes an override actually override.
 */
function mergeHeaders(...sources: (Record<string, string> | undefined)[]): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      merged[name.toLowerCase()] = value;
    }
  }

  return merged;
}

/**
 * Expand a `browser` preset into concrete config fields.
 * Explicit config always wins — the preset only fills the gaps.
 */
function applyBrowserPreset(config: GhostFetchConfig): GhostFetchConfig {
  if (!config.browser) return config;

  const profile = getBrowserProfile(config.browser);

  return {
    ...config,
    ja3: config.ja3 ?? profile.ja3,
    http2Fingerprint: config.http2Fingerprint ?? profile.http2Fingerprint,
    userAgent: config.userAgent ?? profile.userAgent,
    headerOrder: config.headerOrder ?? profile.headerOrder,
    headers: mergeHeaders(profile.headers, config.headers),
  };
}

/**
 * Start CycleTLS, retrying a transient init failure.
 *
 * Destroying a client and building another one — which the idle shutdown does on its
 * own — can race the previous Go process releasing its port. CycleTLS surfaces that as
 * `Failed to initialize CycleTLS: undefined` and it resolves within a beat.
 */
async function initWithRetry(usePrivatePort: boolean): Promise<CycleTLSClient> {
  let lastError: unknown;

  for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(INIT_RETRY_DELAY * attempt);

    // Sharing CycleTLS' default port is what lets several clients in one process reuse
    // a single Go subprocess, so it stays the first choice. A private port is used once
    // the shared one has proven to be poisoned, and for every retry after a failure.
    const shareable =
      attempt === 0 && !usePrivatePort && Date.now() - lastSharedTeardown > SHARED_PORT_COOLDOWN;
    const options: { port?: number; timeout?: number } = shareable ? {} : { port: randomPort() };

    // Give the last attempt CycleTLS' full patience; hurry the ones before it
    if (attempt < INIT_ATTEMPTS - 1) options.timeout = INIT_CONNECT_TIMEOUT;

    try {
      return await initCycleTLS(options);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/** An ephemeral-range port for a private CycleTLS instance. */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raised by `withTimeout`. Named so callers can tell a timeout from a real failure. */
class TimeoutError extends Error {
  constructor(ms: number) {
    // Keep "timeout" in the message: classifyError reads it to mark the attempt
    // ambiguous, so a slow target never gets a proxy banned for it.
    super(`Request timeout after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Enforce a JS-level timeout on any Promise. CycleTLS passes timeout to Go but doesn't enforce it client-side. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(ms));
    }, ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Normalize whatever CycleTLS hands back into a Buffer of the raw response bytes. */
function toBuffer(data: unknown): Buffer {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf-8');
  return Buffer.from(JSON.stringify(data), 'utf-8');
}

/**
 * Lower-case every header name so lookups are predictable regardless of what the
 * server sent, and split `set-cookie` out — it is the one header that legitimately
 * repeats and must not be flattened into a single comma-joined string.
 */
function normalizeHeaders(raw: unknown): { headers: Record<string, string>; setCookie: string[] } {
  const headers: Record<string, string> = {};
  const setCookie: string[] = [];

  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const name = key.toLowerCase();
      const values = Array.isArray(value) ? value.map(String) : [String(value)];

      if (name === 'set-cookie') {
        setCookie.push(...values);
        continue;
      }
      headers[name] = values.join(', ');
    }
  }

  return { headers, setCookie };
}
