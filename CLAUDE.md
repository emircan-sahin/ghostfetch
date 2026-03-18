# ghostfetch

Resilient HTTP client for Node.js with CycleTLS, proxy rotation, smart error
classification, and per-site custom interceptors. Designed for backend developers
who need to fetch data from sites that aggressively block automated requests.

## Project Structure

```
/src            → Library source (TypeScript)
/tests          → Vitest tests
```

Package-specific details are in `.claude/rules/sdk.md`.

## Code Conventions

- TypeScript (strict mode)
- Package manager: pnpm
- No default exports — always use named exports
- Commit messages: English, concise, imperative mood

## Security Rules (CRITICAL)

- **NEVER** commit `.env`, `.env.*`, API keys, tokens, or credentials
- **NEVER** hardcode secrets in source code
- **NEVER** commit `node_modules/`, `dist/`, or `.claude/`

## Build & Test

```bash
pnpm build        # Build CJS + ESM
pnpm test         # Run tests (vitest)
```
