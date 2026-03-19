export interface Cookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  rawExpires?: string;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export interface GhostFetchConfig {
  /** List of proxy URLs in format http://user:pass@host:port */
  proxies?: string[];

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Retry configuration */
  retry?: RetryConfig;

  /** Proxy ban configuration. Set to false to disable banning entirely. */
  ban?: BanConfig | false;

  /**
   * If true, requests will wait until a proxy becomes available when all are
   * banned. If false (default), requests proceed without a proxy when none
   * are available.
   */
  forceProxy?: boolean;

  /**
   * Called periodically to refresh the proxy list.
   * When called, all bans are cleared and the returned list replaces the current one.
   */
  onProxyRefresh?: () => Promise<string[]> | string[];

  /** Interval in ms to call onProxyRefresh (default: 3600000 = 1 hour) */
  proxyRefreshInterval?: number;

  /** Default headers for all requests */
  headers?: Record<string, string>;

  /** CycleTLS JA3 fingerprint (optional — CycleTLS picks a realistic default) */
  ja3?: string;

  /** User-Agent string (optional — CycleTLS picks a realistic default) */
  userAgent?: string;

  /** JA4R fingerprint string (client identity — applied to all requests) */
  ja4r?: string;

  /** HTTP/2 frame settings fingerprint (client identity — applied to all requests) */
  http2Fingerprint?: string;

  /** QUIC fingerprint (client identity — applied to all requests) */
  quicFingerprint?: string;

  /** Disable GREASE (applied to all requests) */
  disableGrease?: boolean;

  /** Default header order for all requests */
  headerOrder?: string[];

  /** Send headers in the order they are provided */
  orderAsProvided?: boolean;

  /** Disable following redirects (default: false) */
  disableRedirect?: boolean;

  /** Skip TLS certificate verification */
  insecureSkipVerify?: boolean;

  /** Force HTTP/1.1 for all requests */
  forceHTTP1?: boolean;

  /** Force HTTP/3 (QUIC) for all requests */
  forceHTTP3?: boolean;

  /** Override TLS SNI server name */
  serverName?: string;

  /** Default cookies for all requests */
  cookies?: Cookie[] | Record<string, string>;
}

export interface RetryConfig {
  /**
   * Delay before each retry in ms. Array length = number of retries.
   *
   * @example [5000, 15000, 30000] → 3 retries: wait 5s, 15s, 30s
   * @default [1000, 2000, 4000]
   */
  delays?: number[];
}

export interface BanConfig {
  /** Number of consecutive failures before banning a proxy (default: 3) */
  maxFailures?: number;

  /** Ban duration in ms (default: 3600000 = 1 hour) */
  duration?: number;
}

/**
 * Interceptor action returned by check():
 * - 'retry' — retry with different proxy, current proxy is not penalized
 * - 'ban'   — retry with different proxy AND penalize current proxy (fail counter +1)
 * - 'skip'  — return response as-is, no retry, bypass all default handling
 * - null    — interceptor doesn't care, fall through to default behavior
 */
export type InterceptorAction = 'retry' | 'ban' | 'skip' | null;

export interface Interceptor {
  /** Name for debugging purposes */
  name?: string;

  /** Return true if this interceptor applies to the given URL */
  match: (url: string) => boolean;

  /**
   * Inspect the HTTP response and decide what to do.
   *
   * @returns
   * - 'retry' — retry with different proxy (proxy is fine)
   * - 'ban'   — retry + penalize this proxy
   * - 'skip'  — return response directly, no retry, no default handling
   * - null    — interceptor doesn't care, default behavior applies
   */
  check: (response: GhostFetchResponse) => InterceptorAction;
}

/**
 * Per-request interceptor — same as Interceptor but without `match` and `name`
 * since it applies to the specific request URL.
 */
export interface RequestInterceptor {
  check: (response: GhostFetchResponse) => InterceptorAction;
}

export type ErrorType = 'proxy' | 'server' | 'ambiguous';

export interface GhostFetchResponse {
  /** HTTP status code */
  status: number;

  /** Response headers */
  headers: Record<string, string>;

  /** Response body as string */
  body: string;

  /** Final URL (after redirects) */
  url: string;

  /** Parse body as JSON */
  json: <T = unknown>() => T;
}

export interface GhostFetchError {
  /** Error type classification: proxy, server, or ambiguous */
  type: ErrorType;

  /** Error message */
  message: string;

  /** HTTP status code (if response was received) */
  status?: number;

  /** Response body (if response was received) */
  body?: string;

  /** The proxy URL that was used */
  proxy?: string;

  /** Original error */
  cause?: unknown;
}

export interface RequestOptions {
  /** Additional headers for this request */
  headers?: Record<string, string>;

  /** Override timeout for this request */
  timeout?: number;

  /** Request body (for POST, PUT, PATCH) */
  body?: string | Record<string, unknown> | URLSearchParams;

  /** Force a specific proxy for this request */
  proxy?: string;

  /** Override retry config for this request */
  retry?: RetryConfig;

  /**
   * Override forceProxy for this request.
   * If true, wait until a proxy is available. If false, proceed without proxy.
   * Defaults to instance-level forceProxy (which defaults to false).
   */
  forceProxy?: boolean;

  /**
   * Per-request interceptor. Takes priority over instance-level interceptors.
   * No `match` needed — it applies to this request's URL automatically.
   */
  interceptor?: RequestInterceptor;

  /**
   * Require a proxy from this country (ISO 3166-1 alpha-2, e.g. 'US', 'DE').
   */
  country?: string;

  /** Override header order for this request */
  headerOrder?: string[];

  /** Send headers in the order they are provided */
  orderAsProvided?: boolean;

  /** Disable following redirects for this request */
  disableRedirect?: boolean;

  /** Skip TLS certificate verification for this request */
  insecureSkipVerify?: boolean;

  /** Force HTTP/1.1 for this request */
  forceHTTP1?: boolean;

  /** Force HTTP/3 (QUIC) for this request */
  forceHTTP3?: boolean;

  /** Override TLS SNI server name for this request */
  serverName?: string;

  /** Cookies for this request (replaces config-level cookies) */
  cookies?: Cookie[] | Record<string, string>;
}

export interface HealthCheckResult {
  /** Total proxies that were tested */
  total: number;

  /** Number of healthy proxies added to the pool */
  healthy: number;

  /** Number of dead proxies that were discarded */
  dead: number;

  /** Country distribution (e.g. { US: 3, DE: 5 }) */
  countries: Record<string, number>;

  /** Per-proxy detail: proxy → country or null if no country resolved */
  proxies: Record<string, string | null>;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
