# Changelog

## 0.5.2

### Fixed

- **`require('@emircansahin/ghostfetch/package.json')` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.** The `exports` map only declared the package root, so
  anything reading the installed package's own manifest — version reporting, some
  bundlers, diagnostic scripts — hit a hard error. `./package.json` is now exported, which
  is what a package with an `exports` field is expected to do.

### Docs

- README status line was still describing 0.5.0 and a 190-case suite.

## 0.5.1

### Fixed

- **A stalled health check could hang the client permanently.** The probe passed its
  timeout to CycleTLS but did not enforce one in JS, so a target that accepted the
  connection and never answered left `ready()` unsettled. Because `request()` awaits
  `ready()`, that took every request on the client with it, not just startup. The probe is
  now wrapped in the same `withTimeout` that requests use, and the whole sweep has a
  ceiling derived from the pool size; on breach it resolves with an empty result rather
  than rejecting, since rejecting would break every request instead.
  Reported against a 20-proxy pool, reproduced locally against an unresponsive endpoint.

### Docs

- Lifecycle: note that a short-lived process should follow `destroy()` with
  `process.exit()`, and how to tell subprocess pipes from handles of your own.

## 0.5.0

### Breaking

- **Response header names are lower-cased.** `res.headers['Content-Type']` now returns
  `undefined`; use `res.headers['content-type']`. Previously the casing was whatever the
  server happened to send, so lookups were a coin flip.
- **`set-cookie` moved out of `res.headers`** into `res.setCookie: string[]`. It is the one
  header that legitimately repeats, and flattening it into a comma-joined string corrupted
  cookies containing commas.
- **Request header names are sent lower-cased**, the way browsers send them over HTTP/2.
- **An interceptor whose `check()` throws now raises `InterceptorError`** instead of being
  classified as a server error and retried.

### Fixed

- **Response bodies are no longer corrupted.** CycleTLS defaults to parsing JSON, and the
  parsed object was being re-serialised — losing whitespace and, worse, integer precision
  (`12345678901234567890` came back as `12345678901234567000`). Bodies are now byte-for-byte.
- **A failed proxy refresh no longer wipes a working pool.** If every proxy fails its health
  check while a working pool exists, the current pool is kept.
- **Per-request headers now override defaults regardless of case.** `Accept-Language` from a
  request used to be sent *alongside* an `accept-language` default rather than replacing it,
  and which one the server honoured was unpredictable.
- **`scopedBan` fail counters reset on success.** They never did, so a proxy accumulated
  strikes across unrelated successes until it was banned.
- **Parallel requests on one session now share an exit IP.** Proxy selection is async, so
  concurrent requests each picked before any had recorded its choice, and a single session
  went out over several IPs at once.
- **Cookie jar hardening:** a `Domain` that is a public suffix (`com`, `co.uk`) is rejected,
  as are cookies whose name or value carries control characters, which could inject headers
  into later requests. The jar is capped at 500 entries.
- **Decompression is bounded** (`maxDecompressedSize`, default 100MB). A few hundred KB of
  gzip could previously expand to gigabytes.
- **Transport recovery.** CycleTLS tears its shared instance down asynchronously but drops
  the registry entry only afterwards, so re-initialising in that window inherited an instance
  pointing at nothing, or stalled for its full 20s connect timeout. Init now retries on a
  private port, backs off the shared port briefly after a teardown, and every CycleTLS call
  rebuilds a dead transport once without burning a retry.
- **A failed CycleTLS init no longer poisons the client.** The rejected promise was cached,
  so every subsequent request on that instance failed forever.
- **`waitForProxy` no longer rejects while a proxy is free.** It polled every 2s but timed out
  based on the ban expiry, so short bans timed out before the first poll.
- **`refreshProxies()` rejections no longer surface as unhandled**, and the refresh timer is
  unref'd so it cannot hold the process open.
- Health check probes now read raw bytes, matching the request path, instead of a lossy
  text decode that would break on a compressed response.

### Added

- `browser: 'chrome' | 'firefox'` — one flag sets JA3, HTTP/2 fingerprint, User-Agent,
  header order and client hints consistently.
- `client.session(key?)` — sticky proxy plus a cookie jar for flows that need continuity.
- `cloudflare: 'retry'` — rotate to another exit IP on a challenge instead of throwing.
- `retry: { jitter, respectRetryAfter, maxRetryAfter }` — honours `Retry-After` by default.
- `healthCheck: false | { url, timeout }` — skip the startup probe or point it elsewhere.
- `res.buffer()` / `res.arrayBuffer()` — binary responses.
- `client.options()` — the HTTP method that was missing.
- `maxDecompressedSize`.
- `idleTimeout` — opt-in automatic transport shutdown for scripts and cron jobs that would
  rather not thread `destroy()` through. Off by default: the transport stays open until
  `destroy()`, as before.
- Automatic response decompression (gzip, deflate, br, zstd where the runtime supports it).

### Internal

- Test suite grew from 58 to 190 tests; coverage 81% -> 95.6% statements, 88% functions -> 96.6%.
- Live-network tests are skipped on CI unless `GHOSTFETCH_LIVE=1`.
- Removed `form-data`, which was a direct dependency but never imported.
