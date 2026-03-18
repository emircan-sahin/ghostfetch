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
