/**
 * A small RFC 6265-shaped cookie jar.
 *
 * Deliberately narrow: it stores what a server sets, and gives it back only to
 * requests that genuinely match on domain, path and secure-ness. Getting that
 * matching wrong leaks a session cookie to the wrong host, so the rules here stay
 * strict rather than forgiving — an unmatched cookie is simply not sent.
 */

export interface StoredCookie {
  name: string;
  value: string;
  /** Host the cookie belongs to, lower-cased and without a leading dot. */
  domain: string;
  path: string;
  /** true when the cookie had no Domain attribute — then only the exact host matches. */
  hostOnly: boolean;
  secure: boolean;
  /** Epoch ms, or null for a session cookie. */
  expires: number | null;
}

/**
 * Ceiling on how many cookies one jar holds.
 *
 * A session that crawls thousands of hosts would otherwise accumulate a cookie per
 * host forever. Browsers cap this too; when full, the oldest entry gives way.
 */
const MAX_COOKIES = 500;

export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  constructor(private readonly maxCookies: number = MAX_COOKIES) {}

  /** Store every `Set-Cookie` value a response carried. */
  setFromResponse(url: string, setCookieHeaders: string[]): void {
    const target = safeUrl(url);
    if (!target) return;

    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header, target);
      if (cookie) this.store(cookie);
    }
  }

  /** Build the `Cookie` request header value for a URL, or '' when nothing matches. */
  headerFor(url: string): string {
    return this.matching(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** Cookies that apply to a URL, longest path first (RFC 6265 ordering). */
  matching(url: string): StoredCookie[] {
    const target = safeUrl(url);
    if (!target) return [];

    const host = target.hostname.toLowerCase();
    const path = target.pathname || '/';
    const isSecure = target.protocol === 'https:';
    const now = Date.now();

    const result: StoredCookie[] = [];

    for (const [key, cookie] of this.cookies) {
      if (cookie.expires != null && cookie.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && !isSecure) continue;
      if (!domainMatches(host, cookie)) continue;
      if (!pathMatches(path, cookie.path)) continue;

      result.push(cookie);
    }

    return result.sort((a, b) => b.path.length - a.path.length);
  }

  /** Everything currently held, expired entries pruned. */
  all(): StoredCookie[] {
    const now = Date.now();
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires != null && cookie.expires <= now) this.cookies.delete(key);
    }
    return [...this.cookies.values()];
  }

  clear(): void {
    this.cookies.clear();
  }

  get size(): number {
    return this.cookies.size;
  }

  private store(cookie: StoredCookie): void {
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;

    // A Max-Age/Expires in the past is how servers delete a cookie
    if (cookie.expires != null && cookie.expires <= Date.now()) {
      this.cookies.delete(key);
      return;
    }

    // Re-setting an existing cookie should refresh its position, not just its value
    this.cookies.delete(key);
    this.cookies.set(key, cookie);

    // Map iterates in insertion order, so the first key is the oldest
    while (this.cookies.size > this.maxCookies) {
      const oldest = this.cookies.keys().next().value;
      if (oldest === undefined) break;
      this.cookies.delete(oldest);
    }
  }
}

function parseSetCookie(header: string, target: URL): StoredCookie | null {
  const parts = header.split(';');
  const [nameValue, ...attributes] = parts;

  const eq = nameValue.indexOf('=');
  if (eq < 1) return null;

  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name) return null;

  // A CR, LF or NUL that survives into the Cookie request header would let a
  // malicious server append headers of its own choosing to our later requests.
  if (hasControlChars(name) || hasControlChars(value)) return null;

  const host = target.hostname.toLowerCase();
  let domain = host;
  let hostOnly = true;
  let path = defaultPath(target.pathname);
  let secure = false;
  let expires: number | null = null;
  let maxAge: number | null = null;

  for (const attribute of attributes) {
    const idx = attribute.indexOf('=');
    const key = (idx === -1 ? attribute : attribute.slice(0, idx)).trim().toLowerCase();
    const attrValue = idx === -1 ? '' : attribute.slice(idx + 1).trim();

    switch (key) {
      case 'domain': {
        const candidate = attrValue.replace(/^\./, '').toLowerCase();
        // Two ways a Domain attribute can be an attack rather than a preference:
        // claiming a domain the setting host does not belong to, and claiming a
        // public suffix so the cookie follows every site under it.
        const belongsToHost = host === candidate || host.endsWith(`.${candidate}`);
        if (candidate && belongsToHost && !isPublicSuffix(candidate)) {
          domain = candidate;
          hostOnly = false;
        }
        break;
      }
      case 'path':
        if (attrValue.startsWith('/')) path = attrValue;
        break;
      case 'secure':
        secure = true;
        break;
      case 'expires': {
        const at = Date.parse(attrValue);
        if (!Number.isNaN(at)) expires = at;
        break;
      }
      case 'max-age': {
        const seconds = Number(attrValue);
        if (Number.isFinite(seconds)) maxAge = seconds;
        break;
      }
    }
  }

  // Max-Age wins over Expires per RFC 6265
  if (maxAge != null) expires = Date.now() + maxAge * 1000;

  return { name, value, domain, path, hostOnly, secure, expires };
}

/** RFC 6265 §5.1.4 — the default path is the directory the request came from. */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function domainMatches(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/** RFC 6265 §5.1.4 — equal, or a prefix that ends on a path segment boundary. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Characters that must never reach a request header. */
function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f;]/.test(value);
}

/**
 * Second-level labels that, paired with a country-code TLD, form a public suffix
 * (`co.uk`, `com.tr`, `com.br`…). Registrations happen *below* these, so a cookie
 * scoped to one would follow every site in the country.
 */
const CCTLD_SECOND_LEVEL = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'or', 'ne', 'go', 'in', 'nom', 'web',
]);

/**
 * Would scoping a cookie to this domain hand it to unrelated sites?
 *
 * This is a heuristic, not the Public Suffix List: it rejects bare TLDs (`com`) and
 * the common `<label>.<cctld>` suffixes (`co.uk`), which covers the exploitable cases
 * without pulling in a several-hundred-kilobyte list. Exotic suffixes that the PSL
 * knows about are not caught, so treat this as a floor rather than a guarantee.
 */
function isPublicSuffix(domain: string): boolean {
  const labels = domain.split('.');

  // A bare TLD — 'com', 'io', and also single-label hosts like 'localhost'
  if (labels.length < 2) return true;

  if (labels.length === 2) {
    const [second, tld] = labels;
    if (tld.length === 2 && CCTLD_SECOND_LEVEL.has(second)) return true;
  }

  return false;
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
