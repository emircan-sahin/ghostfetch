import initCycleTLS, { CycleTLSClient, CycleTLSRequestOptions } from 'cycletls';
import { ProxyManager } from './proxy-manager';
import { classifyError, isCloudflareChallenge, checkInterceptors, checkDefaultRetryStatus } from './classifier';
import { GhostFetchRequestError, CloudflareJSChallengeError, NoProxyAvailableError, MaxRetriesExceededError } from './errors';
import {
  GhostFetchConfig,
  GhostFetchResponse,
  HealthCheckResult,
  Interceptor,
  RequestOptions,
  RetryConfig,
  HttpMethod,
} from './types';

const DEFAULT_DELAYS = [1000, 2000, 4000];

const DEFAULT_TIMEOUT = 30000;
const HEALTH_BATCH_CONCURRENCY = 10;
const HEALTH_RETRY_DELAYS = [0, 3000]; // immediate, +3s

export class GhostFetch {
  private cycleTLS: CycleTLSClient | null = null;
  private initPromise: Promise<void> | null = null;
  private proxyManager: ProxyManager;
  private interceptors: Interceptor[] = [];
  private config: GhostFetchConfig;
  private retryDefaults: RetryConfig;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private healthCheckPromise: Promise<HealthCheckResult> | null = null;

  constructor(config: GhostFetchConfig = {}) {
    this.config = config;
    // Start with empty proxy list — healthCheck will populate it
    this.proxyManager = new ProxyManager([], config.ban);
    this.retryDefaults = { delays: config.retry?.delays ?? DEFAULT_DELAYS };

    // Auto health check on init if proxies provided
    if (config.proxies?.length) {
      this.healthCheckPromise = this.healthCheckProxies(config.proxies).catch((err) => {
        // Prevent unhandled rejection — return empty result so ready() resolves safely
        return { total: config.proxies!.length, healthy: 0, dead: config.proxies!.length, countries: {}, proxies: {} };
      });
    }

    // Start proxy refresh interval only if both callback and interval are provided
    if (config.onProxyRefresh && config.proxyRefreshInterval) {
      this.refreshTimer = setInterval(() => this.refreshProxies(), config.proxyRefreshInterval);
    }
  }

  /**
   * Wait until the initial health check is complete.
   * Returns health check results with proxy details and country info.
   * Requests automatically wait for this internally.
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

  /** Lazy-initialize CycleTLS instance. */
  private async ensureClient(): Promise<CycleTLSClient> {
    if (this.cycleTLS) return this.cycleTLS;

    if (!this.initPromise) {
      this.initPromise = initCycleTLS().then((client) => {
        this.cycleTLS = client;
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
      // Health check first — only replace if it succeeds
      // healthCheckProxies calls replaceProxies internally with healthy list
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

  // --- Core request logic ---

  async request(method: HttpMethod, url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    // Wait for health check to finish before first request
    await this.ready();

    const delays = options?.retry?.delays ?? this.retryDefaults.delays ?? DEFAULT_DELAYS;
    const maxAttempts = delays.length + 1; // first attempt + retries
    const forceProxy = options?.forceProxy ?? this.config.forceProxy ?? false;
    let lastError: GhostFetchRequestError | null = null;
    let lastFailedProxy: string | null | undefined = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Wait before retry (not on first attempt)
      if (attempt > 0) {
        await sleep(delays[attempt - 1]);
      }

      // Pick a proxy
      const proxy: string | null = options?.proxy ?? await this.pickProxy(forceProxy, lastFailedProxy, options?.country);

      try {
        const response = await this.executeRequest(method, url, proxy, options);

        // 1. Per-request interceptor takes highest priority
        if (options?.interceptor) {
          const reqAction = options.interceptor.check(response);
          if (reqAction !== null) {
            const result = this.handleInterceptorAction(reqAction, 'request', response, proxy);
            if (result === 'return') { return response; }
            lastError = result.error;
            lastFailedProxy = proxy;
            continue;
          }
          // null → fall through to instance interceptors
        }

        // 2. Instance-level interceptors — first match takes full ownership
        const { matched, action, interceptor } = checkInterceptors(url, response, [...this.interceptors]);

        if (matched) {
          if (action === 'skip' || action === null) {
            if (proxy) this.proxyManager.reportSuccess(proxy);
            return response;
          }

          const result = this.handleInterceptorAction(action, interceptor?.name ?? 'unnamed', response, proxy);
          if (result === 'return') { return response; }
          lastError = result.error;
          lastFailedProxy = proxy;
          continue;
        }

        // 3. Cloudflare JS challenge (only when no interceptor claimed the response)
        if (isCloudflareChallenge(response)) {
          throw new CloudflareJSChallengeError(url, proxy ?? undefined);
        }

        // 4. No interceptor matched → check default retry statuses (429, 503, 407)
        const defaultRetry = checkDefaultRetryStatus(response.status);
        if (defaultRetry) {
          if (proxy) {
            if (defaultRetry === 'proxy') {
              this.proxyManager.reportFailure(proxy);
            } else {
              this.proxyManager.reportSuccess(proxy);
            }
          }
          lastError = new GhostFetchRequestError({
            type: defaultRetry,
            message: `HTTP ${response.status}`,
            status: response.status,
            body: response.body,
            proxy: proxy ?? undefined,
          });
          lastFailedProxy = proxy;
          continue;
        }

        // 4. Normal response — return it
        if (proxy) this.proxyManager.reportSuccess(proxy);
        return response;
      } catch (error) {
        if (error instanceof CloudflareJSChallengeError) {
          throw error;
        }

        if (error instanceof NoProxyAvailableError) {
          throw error;
        }

        const errorType = classifyError(error);
        const requestError = error instanceof GhostFetchRequestError
          ? error
          : new GhostFetchRequestError({
              type: errorType,
              message: error instanceof Error ? error.message : String(error),
              proxy: proxy ?? undefined,
              cause: error,
            });

        if (proxy) {
          if (errorType === 'proxy') {
            this.proxyManager.reportFailure(proxy);
          } else if (errorType === 'server') {
            this.proxyManager.reportSuccess(proxy);
          }
          // 'ambiguous' — do nothing
        }

        lastError = requestError;
        lastFailedProxy = proxy;
      }
    }

    throw new MaxRetriesExceededError(maxAttempts, lastError!);
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
  ): Promise<string | null> {
    const opts = { exclude, country };
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
      return this.proxyManager.waitForProxy(opts);
    }

    // Not forced — proceed without proxy
    return null;
  }

  /** Handle an interceptor action (retry/ban/skip). Returns 'return' to send response, or { error } to continue retry loop. */
  private handleInterceptorAction(
    action: 'retry' | 'ban' | 'skip',
    name: string,
    response: GhostFetchResponse,
    proxy: string | null,
  ): 'return' | { error: GhostFetchRequestError } {
    if (action === 'skip') {
      if (proxy) this.proxyManager.reportSuccess(proxy);
      return 'return';
    }

    if (action === 'ban') {
      if (proxy) this.proxyManager.reportFailure(proxy);
      return {
        error: new GhostFetchRequestError({
          type: 'proxy',
          message: `Interceptor "${name}": ban (HTTP ${response.status})`,
          status: response.status,
          body: response.body,
          proxy: proxy ?? undefined,
        }),
      };
    }

    // retry
    if (proxy) this.proxyManager.reportSuccess(proxy);
    return {
      error: new GhostFetchRequestError({
        type: 'server',
        message: `Interceptor "${name}": retry (HTTP ${response.status})`,
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

    const headers: Record<string, string> = {
      ...this.config.headers,
      ...options?.headers,
    };

    const cycleTLSOptions: CycleTLSRequestOptions = {
      headers,
      timeout,
      disableRedirect: options?.disableRedirect ?? this.config.disableRedirect ?? false,
    };

    if (proxy) {
      cycleTLSOptions.proxy = proxy;
    }

    // Client identity fingerprints (config-only)
    if (this.config.ja3) cycleTLSOptions.ja3 = this.config.ja3;
    if (this.config.userAgent) cycleTLSOptions.userAgent = this.config.userAgent;
    if (this.config.ja4r) cycleTLSOptions.ja4r = this.config.ja4r;
    if (this.config.http2Fingerprint) cycleTLSOptions.http2Fingerprint = this.config.http2Fingerprint;
    if (this.config.quicFingerprint) cycleTLSOptions.quicFingerprint = this.config.quicFingerprint;
    if (this.config.disableGrease != null) cycleTLSOptions.disableGrease = this.config.disableGrease;

    // Per-request overrides (request > config)
    const headerOrder = options?.headerOrder ?? this.config.headerOrder;
    if (headerOrder) cycleTLSOptions.headerOrder = headerOrder;

    const orderAsProvided = options?.orderAsProvided ?? this.config.orderAsProvided;
    if (orderAsProvided != null) cycleTLSOptions.orderAsProvided = orderAsProvided;

    const insecureSkipVerify = options?.insecureSkipVerify ?? this.config.insecureSkipVerify;
    if (insecureSkipVerify != null) cycleTLSOptions.insecureSkipVerify = insecureSkipVerify;

    const forceHTTP1 = options?.forceHTTP1 ?? this.config.forceHTTP1;
    if (forceHTTP1 != null) cycleTLSOptions.forceHTTP1 = forceHTTP1;

    const forceHTTP3 = options?.forceHTTP3 ?? this.config.forceHTTP3;
    if (forceHTTP3 != null) cycleTLSOptions.forceHTTP3 = forceHTTP3;

    const serverName = options?.serverName ?? this.config.serverName;
    if (serverName) cycleTLSOptions.serverName = serverName;

    const cookies = options?.cookies ?? this.config.cookies;
    if (cookies) cycleTLSOptions.cookies = cookies;

    // Body handling
    if (options?.body) {
      if (options.body instanceof URLSearchParams) {
        cycleTLSOptions.body = options.body;
        const hasContentType = Object.keys(headers).some(
          (k) => k.toLowerCase() === 'content-type',
        );
        if (!hasContentType) {
          headers['content-type'] = 'application/x-www-form-urlencoded';
        }
      } else if (typeof options.body === 'string') {
        cycleTLSOptions.body = options.body;
      } else {
        cycleTLSOptions.body = JSON.stringify(options.body);
        const hasContentType = Object.keys(headers).some(
          (k) => k.toLowerCase() === 'content-type',
        );
        if (!hasContentType) {
          headers['content-type'] = 'application/json';
        }
      }
    }

    const response = await client(url, cycleTLSOptions, method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options');

    const body = decodeResponseData(response.data);

    return {
      status: response.status,
      headers: (response.headers ?? {}) as Record<string, string>,
      body,
      url: response.finalUrl || url,
      json: <T = unknown>() => JSON.parse(body) as T,
    };
  }

  /**
   * Health check + country resolution for proxies.
   * Each proxy gets up to 3 attempts (0s, +15s, +60s) to reach ipinfo.io.
   * Healthy proxies are added to the pool with their country code.
   * Failed proxies are discarded.
   */
  private async healthCheckProxies(proxies: string[]): Promise<HealthCheckResult> {
    const client = await this.ensureClient();
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
              const res = await client(
                'https://ipinfo.io/json',
                { proxy, timeout: 10000, headers: {} },
                'get',
              );

              const decoded = decodeResponseData(res.data);
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
          // All 3 attempts failed — proxy is dead
          proxyDetails[proxy] = null;
        }),
      );
    }

    // Add only healthy proxies to the manager, then restore country data
    this.proxyManager.replaceProxies(healthy);
    for (const [proxy, country] of countryEntries) {
      this.proxyManager.setCountry(proxy, country);
    }

    return {
      total: proxies.length,
      healthy: healthy.length,
      dead: proxies.length - healthy.length,
      countries,
      proxies: proxyDetails,
    };
  }

  /** Gracefully shut down the CycleTLS instance and clear timers. */
  async destroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.cycleTLS) {
      try {
        await this.cycleTLS.exit();
      } catch {
        // CycleTLS may throw ESRCH when the Go process is already gone
      }
      this.cycleTLS = null;
      this.initPromise = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode CycleTLS v2 response data — v2 returns native Buffer objects. */
function decodeResponseData(data: unknown): string {
  if (data == null) return '';
  if (Buffer.isBuffer(data)) {
    return data.length === 0 ? '' : data.toString('utf-8');
  }
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}
