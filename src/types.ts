import type { BrowserPreset } from './presets';

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

  /**
   * Adopt a browser's identity in one line — TLS fingerprint, HTTP/2 settings,
   * User-Agent, header order and the matching default headers, all consistent
   * with each other.
   *
   * Anything you set explicitly (`ja3`, `userAgent`, `headers`, …) overrides the
   * preset, so you can start from a browser and tweak one field. Presets are
   * snapshots of a real browser build; for sites that fingerprint aggressively,
   * take your own values from https://tls.peet.ws/api/all.
   *
   * @example browser: 'chrome'
   */
  browser?: BrowserPreset;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Retry configuration */
  retry?: RetryConfig;

  /** Proxy ban configuration. Set to false to disable banning entirely. */
  ban?: BanConfig | false;

  /**
   * Startup health check for the proxy list. Set to `false` to skip it and trust
   * every proxy as-is — faster to start, but dead proxies stay in the pool and no
   * country data is resolved (so `country` filtering will not work).
   */
  healthCheck?: false | HealthCheckConfig;

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

  /**
   * Close the CycleTLS transport after this many ms with no in-flight request.
   * `0` (the default) keeps it open until you call `destroy()`.
   *
   * CycleTLS runs a Go subprocess and holds a socket open to it, so **a script that
   * never calls `destroy()` will not exit.** Long-lived servers want the default —
   * the transport is ~25MB that stays flat, and no request ever pays the ~110ms to
   * reopen it. Scripts, tests and cron jobs should call `destroy()` when done; set
   * this instead when threading `destroy()` through is awkward.
   *
   * @example idleTimeout: 5000  // a script that shuts itself down 5s after the last request
   */
  idleTimeout?: number;

  /**
   * Refuse a response that decompresses to more than this many bytes
   * (default: 100MB). A small gzip can expand to gigabytes, so this is what stops
   * a hostile server from exhausting memory. The request fails instead.
   */
  maxDecompressedSize?: number;

  /**
   * What to do when a Cloudflare JS challenge is detected.
   *
   * - `'throw'` (default) — fail immediately with CloudflareJSChallengeError
   * - `'retry'` — treat it as a retryable block and rotate to another proxy;
   *   throws CloudflareJSChallengeError only after the retries run out
   */
  cloudflare?: 'throw' | 'retry';
}

export interface RetryConfig {
  /**
   * Delay before each retry in ms. Array length = number of retries.
   * Takes precedence over `attempts`.
   *
   * @example [5000, 15000, 30000] → 3 retries: wait 5s, 15s, 30s
   * @default [1000, 2000, 4000]
   */
  delays?: number[];

  /**
   * Shorthand for an exponential schedule instead of listing `delays`:
   * `attempts` retries at 1s, 2s, 4s, 8s… capped by `maxDelay`.
   * Ignored when `delays` is set.
   *
   * @example { attempts: 5 } → [1000, 2000, 4000, 8000, 16000]
   */
  attempts?: number;

  /** Upper bound for delays generated from `attempts` (default: 30000) */
  maxDelay?: number;

  /**
   * Randomize each delay by ±this fraction (0–1) so parallel requests do not
   * retry in lockstep. Defaults to 0.2 for `attempts` schedules and 0 for
   * explicit `delays`. Never applied to a server-provided `Retry-After`.
   */
  jitter?: number;

  /**
   * Honor a `Retry-After` response header instead of the configured delay
   * (default: true). Applies to any retried response that carries the header.
   */
  respectRetryAfter?: boolean;

  /** Longest wait honored from `Retry-After`, in ms (default: 60000) */
  maxRetryAfter?: number;
}

export interface BanConfig {
  /** Number of consecutive failures before banning a proxy (default: 3) */
  maxFailures?: number;

  /** Ban duration in ms (default: 3600000 = 1 hour) */
  duration?: number;

  /**
   * Extract a scope key from a URL for scoped bans.
   * When set, 'scopedBan' interceptor action bans a proxy only for URLs
   * that produce the same scope key.
   *
   * @default extracts hostname (e.g. 'web3.okx.com')
   *
   * @example
   * // Ban per hostname (default)
   * scopeKey: (url) => new URL(url).hostname
   *
   * // Ban per path prefix
   * scopeKey: (url) => { const u = new URL(url); return `${u.hostname}${u.pathname.split('/').slice(0, 3).join('/')}`; }
   */
  scopeKey?: (url: string) => string;
}

/**
 * Interceptor action returned by check():
 * - 'retry'     — retry with different proxy, current proxy is not penalized
 * - 'ban'       — retry with different proxy AND penalize current proxy (fail counter +1, global)
 * - 'scopedBan' — retry with different proxy AND ban proxy for this URL scope only
 * - 'skip'      — return response as-is, no retry, bypass all default handling
 * - null        — interceptor doesn't care, fall through to default behavior
 */
export type InterceptorAction = 'retry' | 'ban' | 'scopedBan' | 'skip' | null;

export interface Interceptor {
  /** Name for debugging purposes */
  name?: string;

  /** Return true if this interceptor applies to the given URL */
  match: (url: string) => boolean;

  /**
   * Inspect the HTTP response and decide what to do.
   *
   * @returns
   * - 'retry'     — retry with different proxy (proxy is fine)
   * - 'ban'       — retry + penalize this proxy (global ban)
   * - 'scopedBan' — retry + ban this proxy for this URL scope only
   * - 'skip'      — return response directly, no retry, no default handling
   * - null        — interceptor doesn't care, default behavior applies
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

  /** Response headers — names are lower-cased. `set-cookie` is not included here. */
  headers: Record<string, string>;

  /** Raw `set-cookie` header values, one entry per cookie (empty when none were sent). */
  setCookie: string[];

  /**
   * Response body decoded as UTF-8. Decoded lazily and cached, so requesting a
   * binary payload and only reading `buffer()` costs nothing extra.
   */
  body: string;

  /** Final URL (after redirects) */
  url: string;

  /** Parse body as JSON */
  json: <T = unknown>() => T;

  /** Raw response bytes — use this for images, PDFs, archives, any binary payload. */
  buffer: () => Buffer;

  /** Raw response bytes as an ArrayBuffer. */
  arrayBuffer: () => ArrayBuffer;
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

export interface HealthCheckConfig {
  /**
   * URL each proxy is asked to fetch. The response is parsed as JSON and its
   * `country` field, when present, becomes the proxy's country.
   *
   * @default 'https://ipinfo.io/json'
   */
  url?: string;

  /** Per-attempt timeout in ms (default: 10000) */
  timeout?: number;
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

export type { BrowserPreset };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
