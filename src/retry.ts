import { RetryConfig } from './types';

export const DEFAULT_DELAYS = [1000, 2000, 4000];

/** Cap for delays generated from `attempts`, and for backoff growth. */
export const DEFAULT_MAX_DELAY = 30_000;

/** Longest we will ever wait because a server sent `Retry-After`. */
export const DEFAULT_MAX_RETRY_AFTER = 60_000;

/** Base delay used when generating an exponential schedule from `attempts`. */
const BASE_DELAY = 1000;

/** Jitter applied to generated schedules. Explicit `delays` stay exact unless asked. */
const GENERATED_JITTER = 0.2;

/**
 * Work out the retry schedule for a request.
 *
 * `delays` wins when given. Otherwise `attempts` generates an exponential
 * schedule (1s, 2s, 4s, ... capped at `maxDelay`). Falls back to the
 * instance-level schedule when neither is set.
 */
export function resolveDelays(retry: RetryConfig | undefined, fallback: number[]): number[] {
  if (retry?.delays) return retry.delays;

  if (retry?.attempts != null) {
    const max = retry.maxDelay ?? DEFAULT_MAX_DELAY;
    return Array.from({ length: Math.max(0, retry.attempts) }, (_, i) =>
      Math.min(BASE_DELAY * 2 ** i, max),
    );
  }

  return fallback;
}

/** Jitter fraction for a schedule — generated schedules get 20% unless overridden. */
export function resolveJitter(retry: RetryConfig | undefined, fallback: number): number {
  if (retry?.jitter != null) return clamp(retry.jitter, 0, 1);
  if (retry?.attempts != null && retry.delays == null) return GENERATED_JITTER;
  return fallback;
}

/**
 * Spread a delay by ±`jitter` so a burst of parallel requests does not retry
 * in lockstep and stampede the target.
 */
export function applyJitter(delay: number, jitter: number): number {
  if (jitter <= 0) return delay;
  const spread = delay * jitter;
  return Math.max(0, Math.round(delay + (Math.random() * 2 - 1) * spread));
}

/**
 * Parse a `Retry-After` header into milliseconds.
 * Accepts both forms from RFC 9110: delay-seconds and an HTTP-date.
 * Returns null when the header is missing or unparseable.
 */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | null {
  if (!value) return null;

  const trimmed = value.trim();

  // delay-seconds
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // HTTP-date
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;

  return Math.max(0, at - now);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
