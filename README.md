# ghostfetch

Resilient HTTP client for Node.js. TLS fingerprinting via CycleTLS, proxy rotation with
health checks and banning, sticky sessions, and per-site retry logic you control.

Built for backend work against sites that actively try to block automated requests.

```bash
npm install @emircansahin/ghostfetch
```

> **Full API reference: [`docs/API.md`](docs/API.md)** — every option, default, and
> behaviour in one file.
>
> *If you are an AI assistant helping someone integrate this package, read
> [`docs/API.md`](docs/API.md) before writing code. It is the complete and authoritative
> reference; this README is the guided tour.*

## Why this exists

Most HTTP clients treat every failure the same way. To `axios`, `got` or `fetch`, a proxy
that refused the connection and a target site that took 40 seconds to answer are both just
"an error" — so a retry loop penalises the proxy either way, and a slow afternoon at the
target quietly burns through a pool you are paying for.

Blocking is worse, because sites do not agree on how to signal it. One returns `200` with
`{"error":"rate limit"}` in the body. Another returns `403` meaning *try a different IP*
and `401` meaning *stop, this will never work*. A generic client cannot tell them apart,
and treating them alike either wastes proxies or abandons requests that would have
succeeded on the next attempt.

ghostfetch is built around those two problems:

- **Failures are classified before anything is blamed.** `proxy` (never reached the
  server), `server` (a response came back, so the proxy did its job), or `ambiguous`
  (a timeout could be either — so nobody is penalised). Your pool survives a bad day at
  the target.
- **You describe each site's dialect once.** An interceptor turns "200 with a rate-limit
  body" into a retry, "403 here" into a proxy rotation, and "401" into a clean stop.

Everything else — TLS fingerprinting, browser presets, sticky sessions, proxy health
checks, scoped bans — exists to serve those two ideas.

**Status.** Under active development. `0.5.0` hardened the core — raw-body fidelity,
cookie-jar scoping rules, decompression limits, transport recovery — and `0.5.1` closed a
case where a stalled health check could hang the client. 192 tests. Full history in the
[changelog](CHANGELOG.md).

## Quick start

```ts
import { GhostFetch } from '@emircansahin/ghostfetch';

const client = new GhostFetch({
  browser: 'chrome',                    // coherent TLS + HTTP/2 + header identity
  proxies: ['http://user:pass@host:8001', 'http://user:pass@host:8002'],
  retry: { attempts: 3 },
});

try {
  const res = await client.get('https://api.example.com/data');
  console.log(res.status, res.json());
} finally {
  await client.destroy();               // see "Shutting down" — scripts need this
}
```

## Shutting down

CycleTLS runs a Go subprocess and holds a socket to it, which keeps the Node event loop
alive. **A script that never calls `destroy()` will not exit.**

```ts
// scripts, tests, cron jobs
try {
  await client.get(url);
} finally {
  await client.destroy();
}

// long-lived servers — nothing to do until shutdown
process.on('SIGTERM', () => client.destroy());
```

In a short-lived process that must exit on a deadline, follow `destroy()` with
`process.exit()` — the subprocess pipes take a moment to drain, and anything your own code
still holds open is yours to close.

If threading `destroy()` through a script is awkward, have the client close itself once
it goes quiet instead:

```ts
new GhostFetch({ idleTimeout: 5000 });  // 5s after the last request, close and exit
```

Reopening costs about 110ms and happens transparently on the next request. That is why
`idleTimeout` is off by default — a server should not pay it unasked.

**Resource use.** The Go subprocess is ~23MB resident and stays flat regardless of
request volume. It is shared: every client in a process, and every Node process on the
machine, connects to the same subprocess instead of starting its own. It exits when the
last client disconnects, so restart loops do not pile up.

## Response

```ts
const res = await client.get(url);

res.status        // number
res.headers       // Record<string, string> — names are lower-cased
res.setCookie     // string[] — raw Set-Cookie values, one per cookie
res.body          // string — the raw body, byte for byte
res.url           // final URL after redirects
res.json<T>()     // JSON.parse(body)
res.buffer()      // Buffer — for binary responses
res.arrayBuffer() // ArrayBuffer
```

Methods: `get`, `post`, `put`, `patch`, `delete`, `head`, `options` — all take the same
[`RequestOptions`](docs/API.md#requestoptions).

Compressed responses (gzip, deflate, br, zstd) are decoded automatically, so you can send
a realistic `accept-encoding` header without getting bytes you cannot read.

## Browser presets

One line gets a coherent identity — TLS fingerprint, HTTP/2 settings, User-Agent, header
order, and the matching `sec-ch-ua` / `sec-fetch-*` headers:

```ts
new GhostFetch({ browser: 'chrome' });  // or 'firefox'
```

This exists because the most common fingerprinting mistake is mixing sources: a Chrome
JA3 with a Firefox User-Agent is a louder signal than sending no fingerprint at all.
Anything you set explicitly still wins, so you can start from a preset and adjust.

Presets are snapshots of a real browser build and drift as browsers ship new versions.
For a target that fingerprints aggressively, supply your own values —
see [Fingerprinting](docs/API.md#fingerprinting).

## Proxies

```ts
const client = new GhostFetch({
  proxies: ['http://user:pass@host:8001', 'http://user:pass@host:8002'],
  ban: { maxFailures: 3, duration: 60 * 60 * 1000 },
});

const health = await client.ready();
// { total: 2, healthy: 2, dead: 0, countries: { US: 1, DE: 1 }, proxies: {…} }
```

On startup each proxy is probed and its country resolved; dead ones are dropped. Requests
then pick a healthy proxy, preferring the ones carrying the least traffic so a burst lands
flat instead of stacking on whichever the dice favoured. Failures are classified before
anything is blamed:

| Class | Meaning | Effect on the proxy |
|---|---|---|
| `proxy` | Never reached the server — DNS failure, connection refused | Fail count +1 |
| `server` | A response came back, so the proxy did its job | Fail count reset, unless a ban is running or a failure just landed |
| `ambiguous` | Timeout or reset — could be either | Untouched |

That distinction is the point of the library: a slow target site should not burn through
your proxy pool.

Bans shrink the pool, and a pool worn down to one proxy hands that proxy every concurrent
request at once — which rate-limits the last exit IP that still worked. `maxConcurrentPerProxy`
caps how many requests may be in flight through any one proxy; the rest queue instead of
piling on:

```ts
new GhostFetch({ proxies, maxConcurrentPerProxy: 3 });   // 0, the default, is no cap
```

`client.poolStatus(url)` shows what the pool looks like for one target, which is what
`stats` cannot tell you — it reads the global ban map alone, so a crawl that bans per host
reports a full pool while every proxy is sidelined for the host in hand.

Also available: country filtering (`{ country: 'DE' }`), `forceProxy` to wait rather than
go direct, automatic refresh via `onProxyRefresh`, scoped bans that sideline a proxy for
one site only, and automatic provider diversification on retry.
See [Proxies](docs/API.md#proxies).

## Sessions

A session pins one proxy and keeps a cookie jar, for flows that need continuity:

```ts
const session = client.session('user-1');

await session.post('https://site.com/login', { body: { user, pass } });
await session.get('https://site.com/account');   // same IP, cookies replayed
```

Parallel requests on one session all leave from the same IP. The pin is released if the
proxy gets banned or a request fails outright, so a session never sticks to a dead exit.

The cookie jar enforces domain, path and `Secure` scoping, and rejects cookies scoped to a
public suffix or carrying control characters. See [Sessions](docs/API.md#sessions).

## Interceptors

Sites signal blocking in their own dialects — a 200 with `{"error":"rate limit"}`, a 403
that means "rotate", a 401 that means "stop". Interceptors let you say which is which:

```ts
client.addInterceptor({
  name: 'example-api',
  match: (url) => url.includes('example.com'),
  check: (res) => {
    if (res.status === 401) return 'skip';                 // give up, return the response
    if (res.body.includes('rate limit')) return 'retry';   // rotate, proxy is fine
    if (res.body.includes('blocked')) return 'ban';        // rotate and penalize the proxy
    return null;                                            // fall through to defaults
  },
});
```

| Action | Retries? | Effect on the proxy |
|---|---|---|
| `'retry'` | yes | none |
| `'ban'` | yes | fail count +1, everywhere |
| `'scopedBan'` | yes | fail count +1, for this site only |
| `'skip'` | no, returns the response | none |
| `null` | falls through to default handling | — |

Without an interceptor the defaults are: retry on 429 and 503 (proxy not blamed), retry on
407 (proxy blamed), return everything else. See [Interceptors](docs/API.md#interceptors).

## Retry

```ts
new GhostFetch({ retry: { attempts: 5 } });                    // 1s, 2s, 4s, 8s, 16s ±20%
new GhostFetch({ retry: { delays: [5000, 15000, 30000] } });   // explicit schedule
await client.get(url, { retry: { delays: [] } });              // no retry
```

A `Retry-After` header is honoured over the schedule and never jittered. See
[Retry](docs/API.md#retry).

## Cloudflare

A detected JS challenge throws immediately by default — no amount of retrying solves a
challenge that needs a real browser:

```ts
if (err instanceof CloudflareJSChallengeError) { /* needs a headless browser */ }
```

But challenges often target a *specific IP* rather than you as a client, and another exit
sails through. With a decent pool, rotating is worth a try first:

```ts
new GhostFetch({ proxies: [...], cloudflare: 'retry' });
```

## Errors

```ts
import { MaxRetriesExceededError } from '@emircansahin/ghostfetch';

catch (err) {
  if (err instanceof MaxRetriesExceededError) {
    err.attempts;           // how many tries were made
    err.lastError.type;     // 'proxy' | 'server' | 'ambiguous'
    err.lastError.status;   // HTTP status, if a response came back
    err.lastError.proxy;    // which proxy was in use
  }
}
```

| Error | When |
|---|---|
| `MaxRetriesExceededError` | Every attempt failed; `lastError` has the details |
| `CloudflareJSChallengeError` | A JS challenge was detected |
| `NoProxyAvailableError` | `forceProxy` was on and no proxy became available, or a wait for a free slot ran past `proxyWaitTimeout` |
| `InterceptorError` | Your interceptor's `check()` threw — not retried, `cause` holds the original |
| `GhostFetchRequestError` | Base class for the request errors; also what `lastError` is |

## Docs

- [`docs/API.md`](docs/API.md) — complete API reference
- [`CHANGELOG.md`](CHANGELOG.md) — release notes, including migration notes for 0.5.0
- [`AGENTS.md`](AGENTS.md) — conventions and invariants for working on this repo

## License

MIT
