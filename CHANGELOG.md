# Changelog

## 0.6.0

### Added

- **`maxConcurrentPerProxy` — a cap on how many requests may be in flight through one
  proxy.** Off by default (`0`). Rotation picks uniformly from whatever survives the ban,
  country and scope filters, so a pool that bans have worn down to a single proxy hands
  that proxy every concurrent request at the same instant; the last working exit IP is
  rate-limited within seconds and the pool is empty. With a cap, requests queue for a free
  slot. `ProxyManager` gains `lease`, `acquire`, `release`, `inFlight`, `isCapacityBlocked`
  and `waitForLease` to support it — `getProxy` is unchanged and still has no side effect.

  A wait for a slot never falls through to a direct connection, whatever `forceProxy` is
  set to: a full pool is not an absent one, and going direct would put the caller's own IP
  on the wire. The wait is bounded by `proxyWaitTimeout` and ends in
  `NoProxyAvailableError`. A proxy named explicitly per request — which includes every
  `Session`, since a session pins one — cannot be rotated away from, so it queues on that
  proxy instead of skipping the cap.

- **`poolStatus(url?)` — pool health as one target sees it.** `stats` reads the global ban
  map alone, so a crawl that scoped-bans per host reports a full pool while every proxy is
  sidelined for the host in hand. `poolStatus` separates `banned` from `scopedBanned` and
  adds `busy`, `usable` and `inFlight`. `stats` is unchanged.

### Changed

- **Rotation prefers the least-loaded proxies.** Uniform random over the pool is lumpy: 40
  requests across 40 proxies leave some drawing three and others none, and the ones that
  drew three meet a per-IP rate limit first. Ties — which is every proxy when nothing is in
  flight — are still broken at random, so sequential callers see no change. Provider
  diversity on retry still takes precedence.

### Fixed

- **`waitForProxy` no longer sits out its poll interval when a proxy frees up early.**
  Releasing a slot wakes waiters directly; the poll remains as the backstop for bans.

## 0.5.3

### Changed

- **A success no longer clears a ban that is still running.** `reportSuccess` and
  `reportScopedSuccess` deleted the whole entry, ban included. Under parallel load that is
  the common case rather than an edge one: one request in a burst comes back 429 and bans
  the proxy, the rest come back 200 a moment later and wipe the ban. A proxy went straight
  back to the endpoint that had just rate-limited it, and `ban.duration` never meant
  anything. Both are public methods, so anyone calling them to unban a proxy by hand wants
  `clearBan` / `clearScopedBan` now.
- **A success inside `dedupWindow` of a failure no longer clears the strikes.** It shares a
  burst with that failure, so it is not evidence the proxy is welcome again — a target that
  rate-limits per IP answers part of a burst and refuses the rest.

### Fixed

- **Waiting for a proxy reads every ban that blocks it.** `waitForProxy` sized its window
  from the global ban map alone, so with every proxy sidelined for one scope and none
  banned globally it found nothing to wait for and fell back to its own 5-minute default.
  It now takes the longest ban on each proxy and waits for the first one to come free,
  skipping proxies the `country` filter rules out.
- **Strikes age out.** A proxy that failed once a month accumulated its way to a ban, since
  nothing but a success ever cleared the count. Strikes are now dropped `duration` after the
  last failure, on the write path as well as the read path — so a proxy coming back from a
  ban has its full allowance again instead of being re-banned by its first stumble.
- **The scoped ban map is swept.** Its keys pair a proxy with a target, so a client walking
  many hosts grew it without bound; only the key being asked about was ever cleaned up.
- **`undefined` in the ban config no longer overwrites a default.** `{ maxFailures: undefined }`
  left every `failCount >= undefined` comparison false, which turned banning off silently —
  an easy shape to build from optional env vars.

### Added

- `ban.resetScopedOnSuccess` (default `true`) — turn it off against targets that rate-limit
  per IP per endpoint, where a proxy answering 200 between its 429s would otherwise never
  reach `maxFailures`.
- `ban.dedupWindow` (default `1000`) — how close together failures have to be to count as
  one strike, and how close a success has to be to a failure to be ignored.
- `proxyWaitTimeout` (config and per request) — longest a request will wait for a proxy
  under `forceProxy`. Without it the choice is between leaving through your own IP and
  blocking for the whole ban.
- `ProxyManager.clearBan()` / `clearScopedBan()` — the deliberate way to put a proxy back,
  now that a success will not undo a running ban.

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
