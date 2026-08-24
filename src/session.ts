import { CookieJar, StoredCookie } from './cookies';
import { GhostFetchResponse, HttpMethod, RequestOptions } from './types';

/**
 * A request runner that keeps state between calls: the same exit IP and a cookie jar.
 *
 * Rotating the proxy on every request is right for scraping anonymous pages and wrong
 * for anything behind a login — the site sees the session move country mid-flow and
 * drops it. A Session pins one proxy and replays the cookies the server set, so a
 * multi-step flow looks like one visitor.
 */
export class Session {
  private jar = new CookieJar();
  private pinned: string | null = null;
  /** In-flight proxy selection, shared by every request that arrives during it. */
  private pinning: Promise<string | null> | null = null;

  constructor(
    readonly key: string,
    private readonly run: (method: HttpMethod, url: string, options: RequestOptions) => Promise<GhostFetchResponse>,
    private readonly pickProxy: (current: string | null, url: string, options: RequestOptions) => Promise<string | null>,
  ) {}

  /** The proxy this session is pinned to, or null before the first request. */
  get proxy(): string | null {
    return this.pinned;
  }

  /** Cookies currently held by this session. */
  get cookies(): StoredCookie[] {
    return this.jar.all();
  }

  /** Drop the cookie jar and unpin the proxy — next request starts fresh. */
  reset(): void {
    this.jar.clear();
    this.pinned = null;
  }

  async get(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('GET', url, options);
  }

  async post(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('POST', url, options);
  }

  async put(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('PUT', url, options);
  }

  async patch(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('PATCH', url, options);
  }

  async delete(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('DELETE', url, options);
  }

  async head(url: string, options?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('HEAD', url, options);
  }

  async options(url: string, opts?: RequestOptions): Promise<GhostFetchResponse> {
    return this.request('OPTIONS', url, opts);
  }

  async request(method: HttpMethod, url: string, options: RequestOptions = {}): Promise<GhostFetchResponse> {
    // Keep the pinned proxy while it is still usable; re-pin when it is banned or gone
    await this.resolvePin(url, options);

    const requestOptions: RequestOptions = {
      ...options,
      cookies: this.mergeCookies(url, options.cookies),
      ...(this.pinned ? { proxy: this.pinned } : {}),
    };

    try {
      const response = await this.run(method, url, requestOptions);
      this.jar.setFromResponse(response.url || url, response.setCookie);
      return response;
    } catch (err) {
      // The pinned exit IP just failed outright — let the next call pick a fresh one
      // rather than pinning the session to a dead proxy.
      this.pinned = null;
      throw err;
    }
  }

  /**
   * Settle on the proxy for this request.
   *
   * Selection is async, so firing several requests at once would otherwise have each
   * one pick before any had recorded its choice — and the session would go out over
   * two or three different exit IPs at the same moment, which is exactly the pattern
   * a session is meant to avoid. Callers arriving during a selection share its result.
   */
  private async resolvePin(url: string, options: RequestOptions): Promise<string | null> {
    if (!this.pinning) {
      this.pinning = this.pickProxy(this.pinned, url, options)
        .then((proxy) => {
          this.pinned = proxy;
          return proxy;
        })
        .finally(() => {
          this.pinning = null;
        });
    }

    return this.pinning;
  }

  /**
   * Jar cookies for this URL, with anything the caller passed layered on top.
   * Returns undefined when there is nothing to send, so the client's own
   * config-level cookies still apply.
   */
  private mergeCookies(
    url: string,
    explicit: RequestOptions['cookies'],
  ): RequestOptions['cookies'] {
    const merged: Record<string, string> = {};

    for (const cookie of this.jar.matching(url)) {
      merged[cookie.name] = cookie.value;
    }

    if (Array.isArray(explicit)) {
      for (const cookie of explicit) merged[cookie.name] = cookie.value;
    } else if (explicit) {
      Object.assign(merged, explicit);
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }
}
