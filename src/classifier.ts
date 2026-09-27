import { ErrorType, GhostFetchResponse, Interceptor, InterceptorAction } from './types';
import { GhostFetchRequestError, InterceptorError } from './errors';

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
  '/cdn-cgi/challenge-platform/',
];

/** Statuses Cloudflare serves interstitials on. */
const CF_CHALLENGE_STATUSES = new Set([403, 503]);

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
 * - ambiguous: could be either (timeout, connection reset) — no global strike, but a guarded
 *              strike on the route it failed on
 */
export function classifyError(error: unknown): ErrorType {
  // Already classified where the failure was recognised — keyword matching on its message
  // would only get a worse answer (a TLS handshake EOF names neither proxy nor timeout).
  if (error instanceof GhostFetchRequestError) return error.type;

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
 * Check if a response is actually a Cloudflare challenge rather than real content.
 *
 * Cloudflare states this outright in `cf-mitigated` when it acts, which is both
 * cheaper and more reliable than sniffing markup — so that is checked first, at any
 * status. Body sniffing is the fallback and stays limited to the interstitial statuses.
 */
export function isCloudflareChallenge(response: GhostFetchResponse): boolean {
  if (response.headers['cf-mitigated']?.toLowerCase().includes('challenge')) {
    return true;
  }

  if (CF_CHALLENGE_STATUSES.has(response.status)) {
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

    const action = runCheck(interceptor.check, interceptor.name ?? 'unnamed', response);
    return { matched: true, action, interceptor };
  }

  return { matched: false, action: null };
}

/**
 * Call an interceptor's `check()`, tagging anything it throws.
 *
 * Without this the exception reaches the retry loop's generic handler, gets
 * classified as a server error, and is retried — so a plain coding mistake in an
 * interceptor surfaces as a network failure several seconds later.
 */
export function runCheck(
  check: (response: GhostFetchResponse) => InterceptorAction,
  name: string,
  response: GhostFetchResponse,
): InterceptorAction {
  try {
    return check(response);
  } catch (err) {
    throw new InterceptorError(name, err);
  }
}

/**
 * Check if a response status code should trigger a default retry.
 * Only called when no interceptor matched the URL.
 * Returns the error type if retry should happen, or null if response is fine.
 */
export function checkDefaultRetryStatus(status: number): ErrorType | null {
  return DEFAULT_RETRY_STATUSES[status] ?? null;
}
