# ghostfetch

Resilient HTTP client for Node.js with CycleTLS, automatic proxy rotation, smart error classification, and per-site custom interceptors.

Built for backend developers who need to fetch data from sites that aggressively block automated requests.

## Features

- **CycleTLS** — TLS fingerprint spoofing (JA3, JA4R, HTTP/2, QUIC)
- **Proxy rotation** — random proxy selection with health check, banning, country filtering, and automatic provider diversification on retry
- **Smart retry** — auto-retry on 429/503, custom interceptors for per-site logic
- **Cloudflare detection** — JS challenge detection with descriptive errors
- **Protocol control** — force HTTP/1.1 or HTTP/3, disable redirects, header ordering

## Install

```bash
npm install ghostfetch
# or
pnpm add ghostfetch
```

## Quick Start

```ts
import { GhostFetch } from 'ghostfetch';

const client = new GhostFetch({
  proxies: [
    'http://user:pass@host:8001',
    'http://user:pass@host:8002',
  ],
  timeout: 30000,
  retry: { delays: [5000, 15000, 30000] },
  ban: { maxFailures: 3, duration: 60 * 60 * 1000 },
  // ban: false — disable proxy banning entirely
});

const health = await client.ready();
// { total: 2, healthy: 2, dead: 0, countries: { US: 1, DE: 1 }, proxies: { ... } }

const res = await client.get('https://api.example.com/data');
console.log(res.status, res.body);
```

## TLS Fingerprinting & Advanced Options

All fingerprint options are **config-level only** — they define the client identity and apply to every request. Other options can be set at config level (default) and overridden per-request.

**Getting your fingerprint:** Open your browser and visit [`https://tls.peet.ws/api/all`](https://tls.peet.ws/api/all). The JSON response contains everything you need:

| peet.ws field | GhostFetch option |
|---|---|
| `tls.ja3` | `ja3` |
| `tls.ja4_r` | `ja4r` |
| `http2.akamai_fingerprint` | `http2Fingerprint` |
| `user_agent` | `userAgent` |
| `http2.sent_frames[2].headers` | `headerOrder` (exclude pseudo-headers like `:method`, `:path`) |

```ts
const client = new GhostFetch({
  // Copy these from tls.peet.ws (use the same browser for all values)
  ja3: '771,4865-4866-4867-...',
  ja4r: 't13d1516h2_002f,0035,...',
  http2Fingerprint: '1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...',
  headerOrder: ['upgrade-insecure-requests', 'user-agent', 'accept', 'accept-encoding', 'accept-language'],

  // Protocol & behavior (config default, overridable per-request)
  disableRedirect: false,
  insecureSkipVerify: false,
  cookies: { session: 'abc123' },
});

// Per-request override
await client.get('https://example.com', {
  disableRedirect: true,
  cookies: [{ name: 'token', value: 'xyz', domain: '.example.com' }],
  serverName: 'cdn.example.com',
});
```

> **Important:** All fingerprint values (`ja3`, `ja4r`, `http2Fingerprint`, `userAgent`) must come from the same browser. Mixing Chrome JA3 with Firefox User-Agent is a common detection vector.

| Option | Config | Per-request | Default | What it does |
|--------|:------:|:-----------:|---------|-------------|
| `ja3` / `ja4r` | yes | — | auto | TLS ClientHello fingerprint |
| `http2Fingerprint` | yes | — | auto | HTTP/2 SETTINGS frame fingerprint |
| `quicFingerprint` | yes | — | auto | QUIC transport parameters fingerprint |
| `disableGrease` | yes | — | `false` | Disable random GREASE values |
| `headerOrder` | yes | yes | auto | Control header send order |
| `orderAsProvided` | yes | yes | `false` | Send headers in provided order |
| `forceHTTP1` / `forceHTTP3` | yes | yes | `false` | Force protocol version |
| `disableRedirect` | yes | yes | `false` | Return 3xx instead of following |
| `insecureSkipVerify` | yes | yes | `false` | Skip TLS cert validation |
| `serverName` | yes | yes | from URL | Override TLS SNI hostname |
| `cookies` | yes | yes | none | Send cookies (per-request replaces config) |

## Request Body

```ts
// JSON — auto content-type: application/json
await client.post(url, { body: { key: 'value' } });

// Form — auto content-type: application/x-www-form-urlencoded
await client.post(url, { body: new URLSearchParams({ user: 'foo', pass: 'bar' }) });

// Raw string — set content-type yourself
await client.post(url, { body: '<xml/>', headers: { 'content-type': 'application/xml' } });
```

## Custom Interceptors

Define per-site response handling. Instance-level interceptors match by URL; request-level interceptors apply to that single request and take priority.

```ts
// Instance-level
client.addInterceptor({
  name: 'example-api',
  match: (url) => url.includes('example.com'),
  check: (res) => {
    if (res.status === 401) return 'skip';              // don't retry
    if (res.body.includes('rate limit')) return 'retry'; // retry, proxy is fine
    if (res.body.includes('blocked')) return 'ban';      // retry + penalize proxy
    return null;                                          // default behavior
  },
});

// Request-level (no match needed, takes priority)
await client.get('https://special-api.com/data', {
  interceptor: {
    check: (res) => res.status === 401 ? 'skip' : null,
  },
});
```

| Action | Proxy effect | Retry? |
|--------|-------------|--------|
| `'retry'` | not penalized | yes |
| `'ban'` | fail count +1 | yes |
| `'skip'` | not penalized | no, returns response |
| `null` | — | falls through to defaults |

## Proxy Options

### Country selection

Proxies are auto-resolved via ipinfo.io on init. Request a specific country:

```ts
const res = await client.get('https://eu-only-api.com/data', { country: 'DE' });
```

### Force proxy mode

By default, if all proxies are banned, requests proceed without one. Set `forceProxy: true` to wait until a proxy becomes available.

```ts
const client = new GhostFetch({ proxies: [...], forceProxy: true });

// Override per-request
await client.get('https://public-api.com', { forceProxy: false });
```

### Proxy refresh

```ts
const client = new GhostFetch({
  proxies: [...],
  proxyRefreshInterval: 60 * 60 * 1000,
  onProxyRefresh: async () => ['http://user:pass@newhost:8001'],
});

// Or manual: await client.refreshProxies()
```

### Get available proxies

Retrieve all non-banned proxy URLs. Useful for sharing the proxy pool with other tools (e.g. Puppeteer) while respecting ghostfetch's ban state.

```ts
// All healthy proxies
const proxies = client.getAvailableProxies();

// Only US proxies
const usProxies = client.getAvailableProxies({ country: 'US' });
```

### Provider diversification on retry

When a request fails and ghostfetch retries, it automatically picks a proxy with a **different hostname** than the one that just failed. This rotates across providers so a burned IP pool doesn't get hit twice in a row.

```ts
const client = new GhostFetch({
  proxies: [
    'http://user:pass@pr.oxylabs.io:8001',
    'http://user:pass@pr.oxylabs.io:8002',
    'http://user:pass@gate.decodo.com:8001',
    'http://user:pass@gate.decodo.com:8002',
  ],
});

// If oxylabs fails, retry lands on decodo. If decodo fails, retry lands on oxylabs.
// Grouping is auto-detected from the proxy URL hostname — no labels needed.
```

Falls back to same-hostname selection when no alternative provider is available (e.g. single-provider setup, or all alternatives banned).

### Disable banning

```ts
const client = new GhostFetch({ proxies: [...], ban: false });
```

## Error Handling

```ts
import {
  CloudflareJSChallengeError,
  NoProxyAvailableError,
  MaxRetriesExceededError,
} from 'ghostfetch';

try {
  const res = await client.get('https://example.com');
} catch (err) {
  if (err instanceof CloudflareJSChallengeError) {
    // Needs headless browser (puppeteer-extra with stealth plugin)
  }
  if (err instanceof MaxRetriesExceededError) {
    console.log(err.attempts, err.lastError);
  }
}
```

## License

MIT
