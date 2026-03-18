import { ErrorType, GhostFetchResponse, Interceptor, InterceptorAction } from './types';

/** Error codes that are definitely proxy/network failures — request never reached the server. */
const PROXY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/** Error codes that could be proxy OR server — we can't tell for sure. */
const AMBIGUOUS_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
]);

const PROXY_ERROR_KEYWORDS = [
  'proxy',
  'tunnel',
  'connect econnrefused',
];

const AMBIGUOUS_ERROR_KEYWORDS = [
  'socket hang up',
  'timeout',
];

/** Cloudflare JS challenge detection patterns */
const CF_CHALLENGE_PATTERNS = [
  'cf-browser-verification',
  'cf_chl_opt',
  'jschl_vc',
  'jschl_answer',
  'Checking your browser',
  'Just a moment...',
  '_cf_chl_tk',
];

/**
 * Default status codes that should trigger retry.
 * - 'server': retry with different proxy, proxy is not penalized
 * - 'proxy': retry with different proxy, proxy fail count incremented
 */
const DEFAULT_RETRY_STATUSES: Record<number, ErrorType> = {
  429: 'server', // Rate limit — not proxy's fault, just retry with different IP
  503: 'server', // Service unavailable — server overloaded
  407: 'proxy',  // Proxy authentication required — proxy is broken
};

/**
 * Classify an error as proxy, server, or ambiguous.
 *
 * - proxy:     request definitely never reached the server (DNS fail, connection refused, etc.)
 * - server:    an HTTP response was received — the proxy worked fine
 * - ambiguous: could be either (timeout, connection reset) — proxy should NOT be penalized
 */
export function classifyError(error: unknown): ErrorType {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // If there's an HTTP status code, the request reached the server → server error
    if (err.status && typeof err.status === 'number') {
      return 'server';
    }

    const code = (err.code || err.errno) as string | undefined;
    const message = ((err.message as string) || '').toLowerCase();

    // Check definite proxy errors first
    if (code && PROXY_ERROR_CODES.has(code)) {
      return 'proxy';
    }

    if (PROXY_ERROR_KEYWORDS.some((kw) => message.includes(kw))) {
      return 'proxy';
    }

    // Check ambiguous errors
    if (code && AMBIGUOUS_ERROR_CODES.has(code)) {
      return 'ambiguous';
    }

    if (AMBIGUOUS_ERROR_KEYWORDS.some((kw) => message.includes(kw))) {
      return 'ambiguous';
    }
  }

  // Default: treat unknown errors as server errors (keep proxies alive)
  return 'server';
}

/**
 * Check if a successful response is actually a Cloudflare JS challenge.
 */
export function isCloudflareChallenge(response: GhostFetchResponse): boolean {
  if (response.status === 403 || response.status === 503) {
    return CF_CHALLENGE_PATTERNS.some((pattern) => response.body.includes(pattern));
  }
  return false;
}

export interface InterceptorResult {
  /** Whether an interceptor matched this URL */
  matched: boolean;
  /** The action returned by check(), or null if not matched */
  action: InterceptorAction;
  /** The interceptor that matched (if any) */
  interceptor?: Interceptor;
}

/**
 * Run interceptors against a response.
 *
 * First interceptor whose `match` returns true takes ownership.
 * Its `check` result determines the action. Default status handling
 * is bypassed whenever an interceptor matches (even if check returns null).
 */
export function checkInterceptors(
  url: string,
  response: GhostFetchResponse,
  interceptors: Interceptor[],
): InterceptorResult {
  for (const interceptor of interceptors) {
    if (!interceptor.match(url)) continue;

    const action = interceptor.check(response);
    return { matched: true, action, interceptor };
  }

  return { matched: false, action: null };
}

/**
 * Check if a response status code should trigger a default retry.
 * Only called when no interceptor matched the URL.
 * Returns the error type if retry should happen, or null if response is fine.
 */
export function checkDefaultRetryStatus(status: number): ErrorType | null {
  return DEFAULT_RETRY_STATUSES[status] ?? null;
}
