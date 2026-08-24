import { ErrorType, GhostFetchError } from './types';

export class GhostFetchRequestError extends Error implements GhostFetchError {
  readonly type: ErrorType;
  readonly status?: number;
  readonly body?: string;
  readonly proxy?: string;
  readonly cause?: unknown;

  constructor(opts: GhostFetchError) {
    super(opts.message);
    this.name = 'GhostFetchRequestError';
    this.type = opts.type;
    this.status = opts.status;
    this.body = opts.body;
    this.proxy = opts.proxy;
    this.cause = opts.cause;
  }
}

export class CloudflareJSChallengeError extends GhostFetchRequestError {
  constructor(url: string, proxy?: string) {
    super({
      type: 'server',
      message: `Cloudflare JS challenge detected at ${url}. This requires a headless browser (e.g. puppeteer-extra with stealth plugin).`,
      proxy,
    });
    this.name = 'CloudflareJSChallengeError';
  }
}

export class NoProxyAvailableError extends Error {
  constructor() {
    super('No proxies available — all proxies are banned or the proxy list is empty.');
    this.name = 'NoProxyAvailableError';
  }
}

export class MaxRetriesExceededError extends Error {
  readonly lastError: GhostFetchRequestError;
  readonly attempts: number;

  constructor(attempts: number, lastError: GhostFetchRequestError) {
    super(`Max retries exceeded (${attempts} attempts). Last error: ${lastError.message}`);
    this.name = 'MaxRetriesExceededError';
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

/**
 * An interceptor's `check()` threw.
 *
 * That is a bug in the caller's code, not a flaky response, so it is surfaced as-is
 * instead of being classified as a server error and quietly retried — otherwise a
 * typo in an interceptor reads as "max retries exceeded" three attempts later.
 */
export class InterceptorError extends Error {
  readonly interceptor: string;
  readonly cause: unknown;

  constructor(interceptor: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Interceptor "${interceptor}" threw: ${detail}`);
    this.name = 'InterceptorError';
    this.interceptor = interceptor;
    this.cause = cause;
  }
}
