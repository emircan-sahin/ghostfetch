# ghostfetch

Resilient HTTP client for Node.js with CycleTLS, automatic proxy rotation, smart error classification, and per-site custom interceptors.

Built for backend developers who need to fetch data from sites that aggressively block automated requests.

## Features

- **CycleTLS** — TLS fingerprint spoofing (bypasses Cloudflare and similar WAFs)
- **Proxy rotation** — random proxy selection per request with automatic health check
- **Smart error classification** — proxy vs server vs ambiguous errors
- **Proxy banning** — auto-ban failing proxies with configurable TTL
- **Custom interceptors** — per-site response handling (`retry`, `ban`, `skip`)
- **Default status handling** — 429/503 auto-retry, 407 proxy ban
- **Cloudflare detection** — JS challenge detection with descriptive errors
- **Country-based proxy selection** — auto-resolved via ipinfo.io
- **forceProxy mode** — wait for available proxy instead of proceeding without one
- **Health check on init** — dead proxies are discarded before any request

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
  retry: { maxRetries: 3, delay: 1000 },
  ban: { maxFailures: 3, duration: 60 * 60 * 1000 },
});

// Wait for health check to complete
const health = await client.ready();
console.log(health);
// { total: 2, healthy: 2, dead: 0, countries: { US: 1, DE: 1 }, proxies: { ... } }

// Make requests
const res = await client.get('https://api.example.com/data');
console.log(res.status, res.body);
```

## Custom Interceptors

```ts
client.addInterceptor({
  name: 'example-api',
  match: (url) => url.includes('example.com'),
  check: (res) => {
    if (res.status === 401) return 'skip';              // don't retry auth errors
    if (res.body.includes('rate limit')) return 'retry'; // retry with different proxy
    if (res.body.includes('blocked')) return 'ban';      // ban this proxy + retry
    return null;                                          // use default behavior
  },
});
```

| Action | Proxy effect | Retry | Default bypass |
|--------|-------------|-------|----------------|
| `'retry'` | not penalized | yes | yes |
| `'ban'` | fail count +1 | yes | yes |
| `'skip'` | not penalized | no, return response | yes |
| `null` | — | — | no, defaults apply |

## Country-Based Proxy Selection

```ts
// Proxies are auto-resolved via ipinfo.io on init
const res = await client.get('https://eu-only-api.com/data', {
  country: 'DE',
});
```

## Force Proxy Mode

```ts
// Instance default: proceed without proxy if none available
const client = new GhostFetch({ proxies: [...] });

// Per-request: wait until a proxy is available
const res = await client.get('https://protected-api.com', {
  forceProxy: true,
});
```

## Proxy Refresh

```ts
const client = new GhostFetch({
  proxies: [...],
  proxyRefreshInterval: 60 * 60 * 1000, // 1 hour
  onProxyRefresh: async () => {
    // Fetch fresh proxy list from your provider
    return ['http://user:pass@newhost:8001', ...];
  },
});
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
  if (err instanceof NoProxyAvailableError) {
    // All proxies banned or list empty
  }
  if (err instanceof MaxRetriesExceededError) {
    console.log(err.attempts, err.lastError);
  }
}
```

## License

MIT
