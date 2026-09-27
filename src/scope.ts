/**
 * Path segments that name a resource rather than a route: ids, addresses, hashes. Each one
 * collapses to `*`, so `/rug/<mint-a>` and `/rug/<mint-b>` are the same route — a proxy a
 * target refuses on one token is refused on the next one too.
 */
const DYNAMIC_SEGMENTS: RegExp[] = [
  /^\d+$/, // numeric id, page, chain id
  /^0x[0-9a-f]+$/i, // EVM address, tx hash
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  // Opaque ids: base58 mints, base64url tokens, long hashes. The digit is what separates
  // `9chx7Xgtq9mkagFk…` from a word like `ranking-list` that is part of the route.
  /^(?=.*\d)[\w-]{16,}$/,
  // Long enough to be an id even without a digit — a base58 address can lack one.
  /^[A-Za-z0-9]{32,}$/,
];

function isDynamic(segment: string): boolean {
  return DYNAMIC_SEGMENTS.some((pattern) => pattern.test(segment));
}

/**
 * The route a URL belongs to: host plus path, with ids replaced by `*` and the query dropped.
 *
 * `https://api.site.com/rug/9chx7Xgt…?page=2` → `api.site.com/rug/*`.
 *
 * This is the default ban scope. A target that refuses an exit IP does it per route far more
 * often than per host, and scoping by the full URL would give every token its own scope — a
 * proxy refused on one would be tried afresh on the next, and never banned.
 */
export function routeScope(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean).map((segment) => (isDynamic(segment) ? '*' : segment));
    return segments.length > 0 ? `${host}/${segments.join('/')}` : host;
  } catch {
    return url;
  }
}
