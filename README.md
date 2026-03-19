# ghostfetch

Resilient HTTP client for Node.js with CycleTLS, automatic proxy rotation, smart error classification, and per-site custom interceptors.

Built for backend developers who need to fetch data from sites that aggressively block automated requests.

## Features

- **CycleTLS** — TLS fingerprint spoofing (JA3, JA4R, HTTP/2, QUIC)
- **Proxy rotation** — random proxy selection with health check, banning, and country filtering
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

```ts
const client = new GhostFetch({
  // Fingerprints (config-only — client identity)
  ja3: '771,4865-4866-...',
  ja4r: 't13d1516h2_...',
  http2Fingerprint: '1:65536;2:0;...',
  quicFingerprint: '...',
  userAgent: 'Mozilla/5.0 ...',
  disableGrease: true,

  // Protocol & behavior (config default, overridable per-request)
  forceHTTP1: true,
  disableRedirect: false,
  insecureSkipVerify: false,
  headerOrder: ['host', 'user-agent', 'accept'],
  cookies: { session: 'abc123' },
});

// Per-request override
await client.get('https://example.com', {
  forceHTTP1: false,
  disableRedirect: true,
  cookies: [{ name: 'token', value: 'xyz', domain: '.example.com' }],
  serverName: 'cdn.example.com',
});
```

> **Tip:** `ja3`, `ja4r`, `http2Fingerprint`, and `userAgent` should come from the same browser profile. Mixing Chrome JA3 with Firefox User-Agent is a common detection vector.

| Option | Config | Per-request | What it does |
|--------|:------:|:-----------:|-------------|
| `ja3` / `ja4r` | yes | — | TLS ClientHello fingerprint |
| `http2Fingerprint` | yes | — | HTTP/2 SETTINGS frame fingerprint |
| `quicFingerprint` | yes | — | QUIC transport parameters fingerprint |
| `disableGrease` | yes | — | Disable random GREASE values |
| `headerOrder` | yes | yes | Control header send order |
| `orderAsProvided` | yes | yes | Send headers in provided order |
| `forceHTTP1` / `forceHTTP3` | yes | yes | Force protocol version |
| `disableRedirect` | yes | yes | Return 3xx instead of following |
| `insecureSkipVerify` | yes | yes | Skip TLS cert validation |
| `serverName` | yes | yes | Override TLS SNI hostname |
| `cookies` | yes | yes | Send cookies (per-request replaces config) |

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
