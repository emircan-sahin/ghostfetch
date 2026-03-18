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

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  delay: 1000,
  backoff: 2,
  maxDelay: 30000,
};

const DEFAULT_TIMEOUT = 30000;
const HEALTH_BATCH_CONCURRENCY = 10;
const HEALTH_RETRY_DELAYS = [0, 15000, 60000]; // immediate, +15s, +60s

export class GhostFetch {
  private cycleTLS: CycleTLSClient | null = null;
  private initPromise: Promise<void> | null = null;
  private proxyManager: ProxyManager;
  private interceptors: Interceptor[] = [];
  private config: GhostFetchConfig;
  private retryDefaults: Required<RetryConfig>;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckPromise: Promise<HealthCheckResult> | null = null;

  constructor(config: GhostFetchConfig = {}) {
    this.config = config;
    // Start with empty proxy list — healthCheck will populate it
    this.proxyManager = new ProxyManager([], config.ban);
    this.retryDefaults = { ...DEFAULT_RETRY, ...config.retry };

    // Auto health check on init if proxies provided
    if (config.proxies?.length) {
      this.healthCheckPromise = this.healthCheckProxies(config.proxies);
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
    const proxies = await this.config.onProxyRefresh();
    this.proxyManager.replaceProxies([]);
    await this.healthCheckProxies(proxies);
  }

  /** Get proxy manager stats. */
  get stats() {
    return {
      totalProxies: this.proxyManager.total,
      availableProxies: this.proxyManager.available,
      bannedProxies: this.proxyManager.banned,
    };
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

    const retryConfig = { ...this.retryDefaults, ...options?.retry };
    const forceProxy = options?.forceProxy ?? this.config.forceProxy ?? false;
    let lastError: GhostFetchRequestError | null = null;
    let lastFailedProxy: string | null | undefined = null;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      // Wait before retry (not on first attempt)
      if (attempt > 0) {
        const delay = Math.min(
          retryConfig.delay * Math.pow(retryConfig.backoff, attempt - 1),
          retryConfig.maxDelay,
        );
        await sleep(delay);
      }

      // Pick a proxy
      const proxy: string | null = options?.proxy ?? await this.pickProxy(forceProxy, lastFailedProxy, options?.country);

      try {
        const response = await this.executeRequest(method, url, proxy, options);

        // Check for Cloudflare JS challenge
        if (isCloudflareChallenge(response)) {
          throw new CloudflareJSChallengeError(url, proxy ?? undefined);
        }

        // 1. Run custom interceptors — first match takes full ownership
        const { matched, action, interceptor } = checkInterceptors(url, response, this.interceptors);

        if (matched) {
          const iName = interceptor?.name ?? 'unnamed';

          if (action === 'skip' || action === null) {
            // skip: return response as-is / null: interceptor doesn't care but still bypasses defaults
            if (proxy) this.proxyManager.reportSuccess(proxy);
            return response;
          }

          if (action === 'ban') {
            // Penalize proxy + retry
            if (proxy) this.proxyManager.reportFailure(proxy);
            lastError = new GhostFetchRequestError({
              type: 'proxy',
              message: `Interceptor "${iName}": ban (HTTP ${response.status})`,
              status: response.status,
              body: response.body,
              proxy: proxy ?? undefined,
            });
            lastFailedProxy = proxy;
            continue;
          }

          // action === 'retry'
          if (proxy) this.proxyManager.reportSuccess(proxy);
          lastError = new GhostFetchRequestError({
            type: 'server',
            message: `Interceptor "${iName}": retry (HTTP ${response.status})`,
            status: response.status,
            body: response.body,
            proxy: proxy ?? undefined,
          });
          lastFailedProxy = proxy;
          continue;
        }

        // 2. No interceptor matched → check default retry statuses (429, 503, 407)
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

        // 3. Normal response — return it
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

    throw new MaxRetriesExceededError(retryConfig.maxRetries + 1, lastError!);
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

    // Proxies exist but all banned
    if (forceProxy) {
      // Wait until one becomes available (ban expires or refresh happens)
      return this.proxyManager.waitForProxy(opts);
    }

    // Not forced — proceed without proxy
    return null;
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
      disableRedirect: false,
    };

    if (proxy) {
      cycleTLSOptions.proxy = proxy;
    }

    if (this.config.ja3) {
      cycleTLSOptions.ja3 = this.config.ja3;
    }

    if (this.config.userAgent) {
      cycleTLSOptions.userAgent = this.config.userAgent;
    }

    if (options?.body) {
      cycleTLSOptions.body = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);

      if (typeof options.body !== 'string' && !headers['content-type']) {
        headers['content-type'] = 'application/json';
      }
    }

    const response = await client(url, cycleTLSOptions, method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options');

    return {
      status: response.status,
      headers: (response.headers ?? {}) as Record<string, string>,
      body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
      url,
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

              const data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
              const country: string | null = data.country ?? null;

              if (country) {
                this.proxyManager.setCountry(proxy, country);
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
        }),
      );
    }

    // Add only healthy proxies to the manager
    this.proxyManager.replaceProxies(healthy);

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
