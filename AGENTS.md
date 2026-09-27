# AGENTS.md

Conventions and invariants for working **on** ghostfetch. If you are integrating the
package into an application instead, read [`docs/API.md`](docs/API.md).

This file is the single source of truth for agent instructions. Cursor, Codex, Copilot,
Windsurf and Cline read it directly; Claude Code does not, so `CLAUDE.md` is a one-line
`@AGENTS.md` import that pulls it in. Put content here, never there.

## Commands

```bash
pnpm install
pnpm build          # CJS + ESM + types
pnpm test           # vitest, 248 tests
pnpm test:coverage
```

Tests must pass and `npx tsc --noEmit -p tsconfig.json` must be clean before anything is
considered done. Live-network tests are skipped when `CI` is set unless `GHOSTFETCH_LIVE=1`.

## Layout

| File | Responsibility |
|---|---|
| `src/client.ts` | `GhostFetch` — transport, retry loop, response policy, health check |
| `src/proxy-manager.ts` | Rotation, banning, scoped bans, country filter, `waitForProxy` |
| `src/session.ts` | Sticky-proxy + cookie-jar session |
| `src/cookies.ts` | `CookieJar` — parsing, scoping, security rules |
| `src/classifier.ts` | Error classification, Cloudflare detection, interceptor dispatch |
| `src/scope.ts` | `routeScope` — the default ban scope, ids collapsed to `*` |
| `src/decompress.ts` | gzip/deflate/br/zstd with a size ceiling |
| `src/presets.ts` | Browser identity profiles |
| `src/retry.ts` | Delay schedules, jitter, `Retry-After` parsing |
| `src/errors.ts`, `src/types.ts`, `src/index.ts` | Errors, public types, barrel |

TypeScript strict. Named exports only. No `any`, no `@ts-ignore` — the codebase currently
has zero of both; keep it that way.

## Never commit

- `.env`, `.env.*`, API keys, tokens, credentials — and never hardcode them in source
- `node_modules/`, `dist/`, `.claude/`

Commit messages in English, imperative mood, no AI attribution trailers.

## Style

Comments explain **why**, and name the real failure they prevent. `// increment counter`
is noise; `// a burst of parallel failures is one bad moment, not three strikes` is the
reason the code looks odd. Several comments below reference behaviour that was measured,
not assumed — do not soften them into generalities.

---

## Invariants — do not "clean these up"

Each of these looks removable and is not. They exist because something specific broke.

### CycleTLS teardown race

CycleTLS keeps one shared Go instance per port, refcounted by client. When the last client
exits it tears the instance down **asynchronously** but only removes it from its registry
afterwards. Re-initialising inside that window makes CycleTLS believe another host owns the
port; it registers an instance pointing at nothing and caches it, so every later init on
that port inherits the broken one. Symptoms: `Failed to initialize CycleTLS: undefined`,
or `WebSocket server not connected` on the first request.

Four defences, all needed:

1. `closeTransport()` yields a `setImmediate` after `exit()` so the teardown drains.
2. `initWithRetry()` retries up to 4 times, using a **random private port** from the second
   attempt — a fresh port cannot inherit a poisoned registry entry.
3. `INIT_CONNECT_TIMEOUT` (3s) on every attempt but the last. CycleTLS waits 20s by
   default, which turns a dead-end port into a 20-second stall instead of a fast failure.
4. `SHARED_PORT_COOLDOWN` (5s) after any teardown in the process, during which init starts
   on a private port directly. Without it a `destroy()`-then-recreate cycle costs 3s.

Do **not** add a liveness probe to init to detect this. That was tried: CycleTLS does not
enforce its own timeout client-side, so the probe hung for 20 seconds and made every cold
start pathological. Detection belongs in `withTransport()`, on the first real request.

`withTransport()` wraps every CycleTLS call — requests *and* health checks — and rebuilds
the transport once on a dead-transport error without burning a user-visible retry.

Guarded by `tests/lifecycle.test.ts`.

### `responseType: 'arraybuffer'`

CycleTLS defaults to `'json'`: it parses the body and hands back an object, which we would
have to re-serialise. That is lossy — `12345678901234567890` came back as
`12345678901234567000`. Always ask for raw bytes and decode here. Applies to the health
check too, not just requests.

### Cookie jar security

- `Domain` must belong to the setting host **and** must not be a public suffix.
  `isPublicSuffix` is a heuristic (bare TLDs + `<label>.<cctld>`), not the real PSL —
  swapping in the `psl` package is the upgrade path if full coverage is ever needed.
- Names and values containing control characters or `;` are dropped: they would let a
  server inject headers into our later requests.
- Capped at 500 entries so a long crawl cannot grow without bound.

### Session pin serialization

`Session.resolvePin` shares one in-flight selection. Proxy selection is async, so without
it parallel requests each pick before any has recorded its choice and a single session
goes out over several IPs at once — the exact pattern sessions exist to avoid.

### Case-insensitive header merging

`mergeHeaders` lower-cases names. A plain object spread treats `Accept-Language` and
`accept-language` as different keys, so a caller's override silently became a *second*
header and which one the server honoured was unpredictable.

### Interceptor exceptions

`runCheck` converts a throw from a user's `check()` into `InterceptorError`, which the
retry loop rethrows immediately. Without it a caller's `TypeError` is classified as a
server error and retried, surfacing as `MaxRetriesExceededError` with the real bug buried.

### Decompression ceiling

`decompress` passes `maxOutputLength` to zlib and **throws** on breach rather than
returning raw bytes. A few hundred KB of gzip expands to gigabytes otherwise. Unknown or
corrupt codings still fall back to raw bytes; only the size breach throws.

### Health check pool guard

If every proxy fails while a working pool already exists, keep the existing pool. A
provider outage must not leave the client with nothing.

### Capacity blocking is not ban blocking

`pickProxy` asks `isCapacityBlocked` *before* it consults `forceProxy`, and waits either
way. The two states look alike from `getProxy` — both return `null` — and are opposites:
a pool emptied by bans may justify going direct, a pool that is merely busy never does.
Collapsing them into one branch means a burst that fills the pool for a few hundred
milliseconds silently sends the caller's own IP to the target, which is the single failure
a proxy pool exists to prevent.

Guarded by `tests/proxy-concurrency.test.ts`.

### Choosing a session pin must not lease

`pickSessionProxy` passes `take: false` to `pickProxy`. A session picks its pin there and
then sends through the ordinary request path, which takes a slot of its own. Leasing
during the pick as well takes a slot nothing ever releases, and a handful of re-pins
retires that proxy from rotation for good — silently, because the pool still reports it
as healthy.

Guarded by `tests/proxy-concurrency.test.ts`.

### Transport failures CycleTLS reports as responses

`readTransportFailure` turns them back into errors before `judge` sees them: a body starting
`Request returned a Syscall Error:` (a refused CONNECT, a TLS handshake that died in the
tunnel) and status `0` (no response at all — a dropped tunnel comes back as `0` with the body
`->`). Judged as responses they read as the target answering — a proxy's own 503 was retried
as "target busy" and the proxy credited, a dropped tunnel was returned as a success. Matched
on the body, like `isGoTimeout`, so a real 503 from the target still reaches interceptors.

### Guarded route bans keep half the pool

`recordTransportFailure` bans a proxy off the route on any non-`server` failure, with
`guarded: true`. The guard (`canSpare`) is not optional: a timeout cannot tell a bad exit from
a target that is down, and without it a route outage bans the whole pool off that route in
seconds. `'scopedBan'` from an interceptor is deliberately unguarded.

Guarded by the `route bans` block in `tests/proxy-integration.test.ts`.

### Leases are taken at selection, not after it

`ProxyManager.lease()` selects and counts in one synchronous step. Splitting it — pick,
then count — reopens the gap `Session.resolvePin` closes for pinning: selection is async
from the caller's side, so requests arriving together are all handed the same proxy before
any has recorded its slot, and the cap is off by exactly the burst it exists to flatten.

`getProxy()` stays side-effect free because it is public API and is what `isUsable` and
the tests call.

### Unref'd timers

The refresh timer, the idle timer and `waitForProxy`'s poll timers are all `unref`'d so
they never hold the event loop open on their own.

---

## Behaviour worth knowing before changing defaults

Measured on this codebase, not estimated:

| | |
|---|---|
| CycleTLS init (cold) | ~120ms |
| Reopen after idle close | ~110ms |
| Connect to an already-running subprocess | ~12ms |
| Go subprocess RSS | ~23MB, flat under load |
| Subprocesses across 8 concurrent Node processes | 1 (shared) |
| Subprocesses left after 20 hard restarts | 0 |

`idleTimeout` defaults to `0` (off) deliberately: closing costs ~110ms to reopen, and
every close/reopen cycle walks the teardown race above. A server should not be made to
exercise that path by default.

## Docs to keep in sync

A change to public behaviour touches three files: `docs/API.md` (the reference),
`CHANGELOG.md`, and this file if it adds or removes an invariant. The README is a guided
tour — update it only when the guided path itself changes.
