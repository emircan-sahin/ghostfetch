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
  retry: { delays: [5000, 15000, 30000] }, // 3 retries: wait 5s, 15s, 30s
  ban: { maxFailures: 3, duration: 60 * 60 * 1000 }, // or ban: false to disable
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

Interceptors let you define per-site response handling. You can add them at the instance level (applies to all matching requests) or at the request level (applies to that single request only).

### Instance-level interceptor

Matches requests by URL. First matching interceptor takes full ownership — default status handling (429, 503, etc.) is bypassed.

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

### Request-level interceptor

No `match` needed — it applies to this specific request. Takes priority over instance-level interceptors.

```ts
const res = await client.get('https://special-api.com/data', {
  interceptor: {
    check: (res) => {
      if (res.status === 401) return 'skip';
      if (res.status === 200 && res.body.includes('error')) return 'retry';
      return null;
    },
  },
});
```

### Interceptor priority

1. **Request-level interceptor** — checked first, if it returns non-null action, it wins
2. **Instance-level interceptors** — checked next, first `match` takes ownership
3. **Default status handling** — only runs if no interceptor claimed the response

### Actions

| Action | Proxy effect | Retry | Default bypass |
|--------|-------------|-------|----------------|
| `'retry'` | not penalized | yes | yes |
| `'ban'` | fail count +1 | yes | yes |
| `'skip'` | not penalized | no, return response | yes |
| `null` | — | — | no, defaults apply |

## Country-Based Proxy Selection

All proxies are automatically resolved via ipinfo.io on init. This gives you country-level control over which proxy handles which request — useful when certain APIs only accept traffic from specific regions.

```ts
// Only use a German proxy for this request
const res = await client.get('https://eu-only-api.com/data', {
  country: 'DE',
});
```

## Force Proxy Mode

By default, if all proxies are banned or unavailable, requests proceed without a proxy. Enable `forceProxy` to make the request wait until a proxy becomes available (ban expires or proxy list is refreshed). This is useful for cron jobs where requests without a proxy are pointless.

**What happens when `forceProxy: true` and no proxy is available?**

| Scenario | Behavior |
|----------|----------|
| Proxy list is empty (none configured) | Throws `NoProxyAvailableError` immediately — nothing to wait for |
| Proxies exist but all banned | Waits until a ban expires or `onProxyRefresh` provides fresh proxies |

You can set it as the instance default or override per-request:

```ts
// Instance default: all requests wait for proxy
const client = new GhostFetch({
  proxies: [...],
  forceProxy: true,
});

// Override per-request: this specific endpoint works without proxy
const publicData = await client.get('https://public-api.com/data', {
  forceProxy: false,
});

// Or the other way: instance default is false, but this request needs a proxy
const protectedData = await client.get('https://protected-api.com/data', {
  forceProxy: true,
});
```

## Proxy Refresh

Provide an `onProxyRefresh` callback to fetch a fresh proxy list from your provider. When triggered, all existing bans are cleared and the new proxies go through health check before entering the pool.

| Config | Behavior |
|--------|----------|
| `onProxyRefresh` only | No automatic refresh — call `client.refreshProxies()` manually |
| `onProxyRefresh` + `proxyRefreshInterval` | Auto-refresh at the given interval |
| Neither | No refresh capability — initial proxy list is used for the lifetime |

```ts
// Auto-refresh every hour
const client = new GhostFetch({
  proxies: [...],
  proxyRefreshInterval: 60 * 60 * 1000,
  onProxyRefresh: async () => {
    return ['http://user:pass@newhost:8001', ...];
  },
});

// Or manual-only: no interval, call when you need it
const client2 = new GhostFetch({
  proxies: [...],
  onProxyRefresh: async () => fetchFromProvider(),
});
await client2.refreshProxies(); // triggers onProxyRefresh → health check → pool updated
```

## Error Handling

ghostfetch throws specific error classes so you can handle each scenario precisely:

- **`CloudflareJSChallengeError`** — the target site requires a browser-level JS challenge that CycleTLS can't solve. You'll need puppeteer-extra with stealth plugin for this.
- **`NoProxyAvailableError`** — all proxies are banned and `forceProxy` is not enabled, or the proxy list is empty.
- **`MaxRetriesExceededError`** — all retry attempts failed. Contains `.attempts` count and `.lastError` with the final error details.

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
