# ghostfetch — API reference

Complete reference for `@emircansahin/ghostfetch`. Every option, its default, and the
behaviour behind it. For a guided introduction see the [README](../README.md).

- [Client](#client) · [Response](#response) · [RequestOptions](#requestoptions)
- [Fingerprinting](#fingerprinting) · [Compression](#compression) · [Retry](#retry)
- [Proxies](#proxies) · [Interceptors](#interceptors) · [Sessions](#sessions)
- [Cloudflare](#cloudflare) · [Errors](#errors) · [Lifecycle](#lifecycle)
- [Gotchas](#gotchas)

---

## Client

```ts
import { GhostFetch } from '@emircansahin/ghostfetch';
const client = new GhostFetch(config?);
```

### Methods

| Method | Returns | Notes |
|---|---|---|
| `get/post/put/patch/delete/head/options(url, options?)` | `Promise<GhostFetchResponse>` | |
| `request(method, url, options?)` | `Promise<GhostFetchResponse>` | Generic form |
| `ready()` | `Promise<HealthCheckResult>` | Resolves when the startup health check finishes. **Every request awaits it**, not just the first — calling it is optional, waiting for it is not |
| `destroy()` | `Promise<void>` | Closes the transport, clears timers, drops sessions. Safe to call twice |
| `session(key?)` | `Session` | Named sessions are reused; no key means a fresh one |
| `destroySession(key)` | `boolean` | `false` if no such session |
| `addInterceptor(interceptor)` | `void` | |
| `removeInterceptor(name)` | `void` | |
| `refreshProxies()` | `Promise<void>` | Runs `onProxyRefresh` now |
| `getAvailableProxies({ country? })` | `string[]` | Non-banned proxies, for handing to other tools |
| `stats` | `{ totalProxies, availableProxies, bannedProxies }` | Getter |

### GhostFetchConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `browser` | `'chrome' \| 'firefox'` | — | Identity preset: JA3, HTTP/2 fingerprint, UA, header order, client hints |
| `proxies` | `string[]` | `[]` | `http://user:pass@host:port` |
| `healthCheck` | `false \| { url?, timeout? }` | ipinfo.io, 10s | Startup probe. `false` skips it |
| `timeout` | `number` | `30000` | Per-request timeout in ms |
| `retry` | `RetryConfig` | see [Retry](#retry) | |
| `ban` | `BanConfig \| false` | `{ maxFailures: 3, scopedMaxFailures: 1, duration: 3600000, dedupWindow: 1000, resetScopedOnSuccess: true }` | `false` disables banning |
| `forceProxy` | `boolean` | `false` | Wait for a proxy instead of going direct |
| `proxyWaitTimeout` | `number` | — | Longest a request waits for a proxy. Uncapped by default |
| `maxConcurrentPerProxy` | `number` | `0` (off) | Most requests in flight through one proxy. See [Concurrency](#concurrency) |
| `cloudflare` | `'throw' \| 'retry'` | `'throw'` | What to do on a detected JS challenge |
| `idleTimeout` | `number` | `0` (off) | Close the transport after this long idle. See [Lifecycle](#lifecycle) |
| `maxDecompressedSize` | `number` | `104857600` (100MB) | Reject bodies that expand past this |
| `onProxyRefresh` | `() => string[] \| Promise<string[]>` | — | Supplies a fresh proxy list |
| `proxyRefreshInterval` | `number` | — | Required for *automatic* refresh; without it only `refreshProxies()` works |
| `headers` | `Record<string, string>` | — | Defaults for every request |
| `cookies` | `Cookie[] \| Record<string, string>` | — | Defaults for every request |
| `ja3` `ja4r` `http2Fingerprint` `quicFingerprint` `userAgent` `disableGrease` | | auto | [Fingerprinting](#fingerprinting) — config only |
| `headerOrder` `orderAsProvided` `disableRedirect` `insecureSkipVerify` `forceHTTP1` `forceHTTP3` `serverName` | | see below | Also settable per request |

Protocol defaults: `orderAsProvided` `false`, `disableRedirect` `false`,
`insecureSkipVerify` `false`, `forceHTTP1` `false`, `forceHTTP3` `false`, `serverName`
taken from the URL.

---

## Response

```ts
interface GhostFetchResponse {
  status: number;
  headers: Record<string, string>;   // names lower-cased; no set-cookie here
  setCookie: string[];               // raw Set-Cookie values, one entry per cookie
  body: string;                      // raw body, byte for byte
  url: string;                       // final URL after redirects
  json<T = unknown>(): T;
  buffer(): Buffer;
  arrayBuffer(): ArrayBuffer;
}
```

Header names are lower-cased because servers are inconsistent about casing and HTTP/2
mandates lowercase anyway. `set-cookie` is kept out of `headers` because it is the one
header that legitimately repeats — flattening it would corrupt cookies containing commas.

`body` is the response verbatim. CycleTLS defaults to parsing JSON and handing back an
object; ghostfetch asks for raw bytes instead, so nothing is re-serialised and integer
precision survives.

---

## RequestOptions

| Option | Type | Description |
|---|---|---|
| `headers` | `Record<string, string>` | Merged over config headers, case-insensitively |
| `body` | `string \| Record<string, unknown> \| URLSearchParams` | Objects are JSON-encoded; `URLSearchParams` becomes form-encoded. `content-type` is set for you unless you set it |
| `timeout` | `number` | Overrides config |
| `retry` | `RetryConfig` | Overrides config |
| `proxy` | `string` | Force one specific proxy, bypassing selection |
| `forceProxy` | `boolean` | Overrides config |
| `proxyWaitTimeout` | `number` | Overrides config |
| `country` | `string` | ISO 3166-1 alpha-2, e.g. `'DE'`. Requires health check data |
| `interceptor` | `{ check }` | Takes priority over instance interceptors; no `match` needed |
| `headerOrder` `orderAsProvided` `disableRedirect` `insecureSkipVerify` `forceHTTP1` `forceHTTP3` `serverName` `cookies` | | Override the config value |

```ts
await client.post(url, { body: { key: 'value' } });                    // application/json
await client.post(url, { body: new URLSearchParams({ a: '1' }) });     // form-encoded
await client.post(url, { body: '<xml/>', headers: { 'content-type': 'application/xml' } });
```

---

## Fingerprinting

Fingerprint fields are **config-level only**. They describe one client identity, and
varying them per request is itself a signal.

Take your own values from [`tls.peet.ws/api/all`](https://tls.peet.ws/api/all):

| peet.ws field | ghostfetch option |
|---|---|
| `tls.ja3` | `ja3` |
| `tls.ja4_r` | `ja4r` |
| `http2.akamai_fingerprint` | `http2Fingerprint` |
| `user_agent` | `userAgent` |
| `http2.sent_frames[2].headers` | `headerOrder` (drop pseudo-headers like `:method`) |

**All values must come from the same browser.** Mixing a Chrome JA3 with a Firefox
User-Agent is a common and easily detected mistake.

### Header merging

Config, preset and per-request headers merge case-insensitively: `Accept-Language` from a
request *replaces* an `accept-language` default rather than being sent alongside it.
Names go out lower-cased, as browsers send them over HTTP/2.

---

## Compression

Real browsers always send `accept-encoding`, so a convincing fingerprint must too.
CycleTLS' Go transport auto-decompresses only while it owns that header — set it yourself
and raw compressed bytes come back. ghostfetch decodes them, so it is safe to set:

```ts
await client.get(url, { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
// res.body is plain text either way
```

gzip, deflate and brotli work everywhere; zstd needs Node 22.15+ and is omitted from the
browser presets on older runtimes rather than advertised and then failing to decode.

A body that cannot be decoded (unknown coding, corrupt data) is returned as-is. A body
that expands past `maxDecompressedSize` **throws** — a few hundred KB of gzip can expand
to gigabytes, and silently returning the raw bytes would hide the attack.

---

## Retry

```ts
new GhostFetch({ retry: { attempts: 5 } });                    // 1s, 2s, 4s, 8s, 16s ±20%
new GhostFetch({ retry: { delays: [5000, 15000, 30000] } });   // explicit
await client.get(url, { retry: { delays: [] } });              // single attempt
```

| Option | Default | Description |
|---|---|---|
| `delays` | `[1000, 2000, 4000]` | Explicit schedule; array length is the retry count. Wins over `attempts` |
| `attempts` | — | Generate an exponential schedule of this length |
| `maxDelay` | `30000` | Cap for generated delays |
| `jitter` | `0.2` with `attempts`, `0` with `delays` | Randomise each delay by ±this fraction so parallel requests do not retry in lockstep |
| `respectRetryAfter` | `true` | Honour a `Retry-After` header over the schedule |
| `maxRetryAfter` | `60000` | Longest wait a server may ask for |

`Retry-After` is never jittered — 30 seconds means 30 seconds, capped at `maxRetryAfter`.
Both delay-seconds and HTTP-date forms are parsed.

---

## Proxies

### Health check

Each proxy is asked to fetch `https://ipinfo.io/json`, twice if needed (immediately, then
+3s). Failures are dropped; the `country` field becomes the proxy's country.

```ts
new GhostFetch({ healthCheck: { url: 'https://api.myip.com', timeout: 5000 } });
new GhostFetch({ healthCheck: false });   // trust the list as given
```

Skipping is faster to start but leaves dead proxies in the pool and resolves no country
data, so `country` filtering will not work.

If a refresh finds *every* proxy dead while a working pool exists, the current pool is
kept — a provider outage should not leave you with nothing.

### Error classification

| Class | Trigger | Effect |
|---|---|---|
| `proxy` | `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`; "proxy"/"tunnel" in the message | Fail count +1 |
| `server` | An HTTP response arrived | Fail count reset, unless a ban is running or a failure landed inside `dedupWindow` |
| `ambiguous` | `ETIMEDOUT`, `ECONNRESET`, `ECONNABORTED`, "socket hang up", "timeout" | Global record untouched; banned off the route it failed on ([Route bans](#route-bans)) |

Unknown errors default to `server`, which keeps proxies in the pool.

CycleTLS reports some transport failures as responses rather than rejections — a proxy
refusing the CONNECT (`407`, `502`, `503`), a TLS handshake dying in the tunnel (`495`), a
connection dropped before any answer (status `0`), all with a body starting `Request
returned a Syscall Error:` or empty. None of them came from the target, so none of them
reach interceptors or the default statuses: a refused CONNECT is a `proxy` failure, the
rest are `ambiguous`.

### Banning

```ts
new GhostFetch({ ban: { maxFailures: 3, duration: 3600000 } });
new GhostFetch({ ban: false });   // never sideline a proxy
```

Failures within `dedupWindow` (1 second by default) count as one, so a burst of parallel
requests hitting the same bad proxy is one strike rather than ten.

A request that returns a response to the caller clears the counter — but not
unconditionally, because a proxy must not be able to talk its way out of the ban it just
earned:

- **A running ban outlives a success.** The request that earns a ban and the ones that
  answer 200 right behind it belong to the same burst, so a ban would never survive the
  moment it was created. It ends when its `duration` ends.
- **A success inside `dedupWindow` of a failure does not clear the strikes.** It shares a
  burst with that failure, so it says nothing about whether the proxy is welcome again —
  a target that rate-limits per IP answers part of a burst and refuses the rest.

With `scopedMaxFailures` raised above `1`, a target that rate-limits **per IP per
endpoint** makes even that too forgiving: the proxy keeps answering 200 between its 429s,
never reaches the threshold, and stays in rotation on the one endpoint pushing back —
which is how a 429 turns into a real block. Turn the forgiveness off for that case:

```ts
new GhostFetch({ ban: { resetScopedOnSuccess: false } });
```

Strikes clear on their own either way. `duration` is what an entry is allowed to live: a
banned proxy comes back with a clean slate once its ban lapses, and strikes that never
reached a ban are dropped the same length of time after the last failure. Raising
`duration` lengthens both.

**Scoped bans** sideline a proxy for one route instead of everywhere — useful when a
target refuses an IP on one endpoint that every other endpoint still accepts:

```ts
client.addInterceptor({
  name: 'okx',
  match: (url) => url.includes('okx.com'),
  check: (res) => (res.status === 403 ? 'scopedBan' : null),
});
```

The scope is the URL's **route**: host plus path, ids collapsed to `*`, query dropped.
`https://api.site.com/rug/<mint>?t=1` and `https://api.site.com/rug/<other-mint>` are both
`api.site.com/rug/*`, so a proxy banned on one token is banned on every token of that
route. Numeric ids, `0x` addresses, UUIDs and long opaque tokens (base58, base64url,
hashes) count as ids; route words like `ranking-list` do not. The function is exported as
`routeScope`; pass your own `scopeKey` to scope differently:

```ts
new GhostFetch({ ban: { scopeKey: (url) => new URL(url).host } });   // per host instead
```

A scoped ban lands on the **first** scoped strike (`scopedMaxFailures`, default `1`). It
costs one proxy on one route while the rest of the pool keeps serving it, and every strike
waited for is another request that times out on the same exit.

### Route bans

Transport failures ban the proxy off the route they happened on, with no interceptor
involved: a timeout, a dropped tunnel, a TLS handshake that died, a refused CONNECT. This
is what catches a **degraded** exit — one that answers 98 requests in 100 and stalls on
the rest. It never strings two failures together, so `maxFailures` never bans it, while
every stall costs the caller the full timeout plus a retry.

A timeout cannot tell a bad exit from a target that is down for everyone, and there every
proxy fails in turn. So these bans are **guarded**: one only lands while at least half of
the usable pool stays open on the route. Past that, the failures are the route's, not the
proxies', and the rest of the pool is left alone. An interceptor's `'scopedBan'` is not
guarded — that is a decision about the response, not a guess about the proxy.

### Selection

Requests pick a random non-banned proxy. On a retry the proxy that just failed is
excluded, and a proxy with a **different hostname** is preferred — so a burned provider
pool is not hit twice in a row. Grouping is inferred from the URL; no labels needed.

```ts
proxies: [
  'http://user:pass@pr.oxylabs.io:8001',
  'http://user:pass@gate.decodo.com:8001',
]
// oxylabs fails -> retry lands on decodo
```

Falls back to the same hostname when there is no alternative.

### forceProxy

`false` (default) proceeds without a proxy when none is available. `true` waits for one
to free up, and throws `NoProxyAvailableError` if none ever does.

```ts
await client.get(url, { forceProxy: true, country: 'DE' });
```

### Concurrency

`maxConcurrentPerProxy` caps how many requests may be in flight through a single proxy.
`0`, the default, is no cap.

```ts
new GhostFetch({ proxies, maxConcurrentPerProxy: 3 });
```

Worth setting whenever bans can shrink the usable pool. Rotation picks uniformly from
whatever survives the ban, country and scope filters, so a pool worn down to one proxy
hands that proxy every concurrent request at the same instant — and the one exit IP that
was still working is rate-limited within seconds. With a cap, requests queue for a free
slot instead of piling onto the survivor.

Selection also prefers the least-loaded candidates, cap or no cap. Uniform random over
the pool is lumpy — fire 40 requests at 40 proxies and some draw three while others draw
none, and the unlucky ones meet the target's per-IP limit first. With nothing in flight
every count is zero, so a sequential caller sees the same random pick as before.

Details worth knowing:

- A request waiting for a slot is bounded by `proxyWaitTimeout` and throws
  `NoProxyAvailableError` if the wait runs out. **It never falls back to a direct
  connection**, whatever `forceProxy` says — a full pool is not an absent one, and going
  direct would put your own IP on the wire.
- The slot is released before a retry's backoff sleep, so a request waiting out a delay
  does not hold capacity.
- A proxy named explicitly (`{ proxy: '...' }`, and so every `Session`, which pins one)
  cannot be rotated away from, so it queues on that one proxy instead. A session's burst
  going to a single exit IP all at once is the case the cap is for.
- Startup and refresh health checks do not go through the pool and are not capped.

### poolStatus

`stats` reads the global ban map alone. On a crawl that bans per target it reports a full
pool while every proxy is sidelined for the host in hand. `poolStatus(url)` is the view
that separates them.

```ts
client.poolStatus('https://example.com/api');
// { total: 40, banned: 0, scopedBanned: 39, busy: 1, usable: 0, inFlight: 3 }
```

| Field | Meaning |
|---|---|
| `total` | Proxies configured, healthy or not |
| `banned` | Sidelined for every target by the global ban map |
| `scopedBanned` | Fine elsewhere, banned for this scope |
| `busy` | Eligible, but already at `maxConcurrentPerProxy` |
| `usable` | Could take a request right now |
| `inFlight` | Requests in flight across the whole pool |

Omit the URL for the pool as a whole. Pass `{ country }` as a second argument to narrow it
the way a request would.

### Refresh

```ts
new GhostFetch({
  onProxyRefresh: async () => fetchFreshProxies(),
  proxyRefreshInterval: 60 * 60 * 1000,   // required for automatic refresh
});
await client.refreshProxies();            // or manually
```

The refreshed list is health-checked before it replaces the pool, and all bans clear.

---

## Interceptors

Two levels. Request-level wins; the first matching instance-level interceptor takes full
ownership of the response.

```ts
client.addInterceptor({
  name: 'example-api',
  match: (url) => url.includes('example.com'),
  check: (res) => (res.status === 401 ? 'skip' : null),
});

await client.get(url, { interceptor: { check: (res) => (res.status === 401 ? 'skip' : null) } });
```

### Resolution order

1. Request-level interceptor — a non-null action wins
2. Instance-level interceptors — first `match` takes ownership; **even `null` claims the
   response and bypasses default handling**
3. Cloudflare challenge detection
4. Default statuses: 429 → retry (proxy fine), 503 → retry (proxy fine), 407 → retry
   (proxy blamed)
5. Return the response

### Actions

| Action | Retries? | Proxy |
|---|---|---|
| `'retry'` | yes | not penalised |
| `'ban'` | yes | fail count +1, globally |
| `'scopedBan'` | yes | fail count +1, for this route only |
| `'skip'` | no | not penalised |
| `null` | falls through | — |

If `check()` throws, that is treated as a bug in your code: `InterceptorError` is raised
immediately rather than retried, so a typo does not surface as a network failure three
attempts later.

---

## Sessions

```ts
const session = client.session('user-1');

await session.post('https://site.com/login', { body: { user, pass } });
await session.get('https://site.com/account');

session.proxy      // the pinned proxy, or null
session.cookies    // StoredCookie[]
session.reset();   // clear the jar and unpin
client.destroySession('user-1');
```

Same methods as the client. Named sessions are reused; `client.session()` with no key
returns a throwaway one.

**Proxy pinning.** The pin is resolved once and shared, so parallel requests on a session
all leave from the same IP. It is kept until the proxy is banned or filtered out, and
released when a request fails outright — a session never sticks to a dead exit.

**Cookie jar.** Enforces domain, path and `Secure` scoping. It also refuses:

- a `Domain` the setting host does not belong to
- a `Domain` that is a public suffix (`com`, `co.uk`), which would follow every site under it
- names or values containing control characters, which could inject headers into later requests

Capped at 500 cookies, oldest evicted.

> The public-suffix check is a heuristic covering bare TLDs and common `<label>.<cctld>`
> forms, not the full Public Suffix List. It closes the exploitable cases; exotic suffixes
> are not caught.

Cookies are captured from the final response only — `Set-Cookie` mid-redirect is not
collected.

---

## Cloudflare

Detection uses the `cf-mitigated` header at any status, plus known body markers
(`cf_chl_opt`, `jschl_vc`, `_cf_chl_tk`, `/cdn-cgi/challenge-platform/`, "Just a moment…")
on 403 and 503.

```ts
new GhostFetch({ cloudflare: 'throw' });   // default — throws immediately
new GhostFetch({ cloudflare: 'retry' });   // rotate exit IP through the retry schedule
```

`'retry'` still throws `CloudflareJSChallengeError` if every attempt is challenged. The
proxy is never penalised — being challenged is not a malfunction.

---

## Errors

```ts
import {
  GhostFetchRequestError, MaxRetriesExceededError, CloudflareJSChallengeError,
  NoProxyAvailableError, InterceptorError,
} from '@emircansahin/ghostfetch';
```

| Error | Fields | When |
|---|---|---|
| `MaxRetriesExceededError` | `attempts`, `lastError` | Every attempt failed |
| `CloudflareJSChallengeError` | `type`, `proxy` | A JS challenge was detected |
| `NoProxyAvailableError` | — | `forceProxy` on and no proxy available, or a wait for a free slot ran past `proxyWaitTimeout` |
| `InterceptorError` | `interceptor`, `cause` | Your `check()` threw |
| `GhostFetchRequestError` | `type`, `status`, `body`, `proxy`, `cause` | Base class; also what `lastError` is |

---

## Lifecycle

CycleTLS runs a Go subprocess and holds a socket to it, which keeps the Node event loop
alive. **A script that never calls `destroy()` will not exit.**

| Situation | What to do |
|---|---|
| Script, test, cron job | `await client.destroy()` in a `finally` |
| Can't thread `destroy()` through | `new GhostFetch({ idleTimeout: 5000 })` |
| Long-lived server | Nothing; `client.destroy()` on `SIGTERM` |

`idleTimeout: 0` (the default) means *never auto-close*, not *close immediately*.

`destroy()` releases the transport, but the Go subprocess' stdio pipes can stay on the
event loop for a moment while they drain, and any sockets your own code still holds are
yours to close. In a short-lived process that must exit on a deadline, follow `destroy()`
with `process.exit()` rather than trusting the loop to empty:

```ts
await client.destroy();
process.exit(0);
```

Measured after `destroy()` with a 20-proxy pool: the remaining handles are all subprocess
pipes with no `remoteAddress`, and the process exits within a few milliseconds. A process
that lingers far longer than that is usually holding something of its own — an open
WebSocket, a keep-alive agent, an unref'd timer — so enumerate
`process._getActiveHandles()` before blaming the transport.

**Resources.** The subprocess is ~23MB resident, flat regardless of request volume, and
shared across every client in a process and every Node process on the machine. A second
process connects in ~12ms instead of ~126ms. It exits when the last client disconnects, so
restart loops do not accumulate subprocesses. Reopening after an idle close costs ~110ms.

---

## Gotchas

Things that surprise people, collected in one place.

- **`idleTimeout: 0` does not close the transport** — it is the "never auto-close"
  setting. For a script you want `destroy()`, or a non-zero `idleTimeout`.
- **`res.headers` keys are lower-cased.** `res.headers['Content-Type']` is `undefined`.
- **`set-cookie` is not in `res.headers`** — it is `res.setCookie`, an array.
- **An interceptor that returns `null` still claims the response.** Default status
  handling is bypassed for any URL an interceptor matches. Return nothing from `match` if
  you want the defaults.
- **`country` filtering needs the health check.** With `healthCheck: false` no country is
  resolved and the filter matches nothing.
- **`proxyRefreshInterval` is required for automatic refresh.** Setting only
  `onProxyRefresh` gives you manual `refreshProxies()` and nothing else.
- **Fingerprint options are config-only.** They are not in `RequestOptions` on purpose.
- **Sessions capture cookies from the final response**, not from redirect hops.
- **`request()` resolves for any HTTP status** that no rule objected to. A 404 is a
  successful request; check `res.status`.
- **`request()` awaits `ready()`.** The startup health check gates every request, not just
  the first, so anything that stalls it stalls the whole client. Both the per-probe timeout
  and the overall ceiling exist to make that impossible; do not remove them.
