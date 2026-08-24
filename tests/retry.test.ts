import { describe, it, expect } from 'vitest';
import { resolveDelays, resolveJitter, applyJitter, parseRetryAfter } from '../src/retry';

describe('resolveDelays', () => {
  it('explicit delays win over everything', () => {
    expect(resolveDelays({ delays: [5, 10], attempts: 9 }, [1])).toEqual([5, 10]);
  });

  it('attempts generates an exponential schedule', () => {
    expect(resolveDelays({ attempts: 5 }, [])).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it('maxDelay caps the generated schedule', () => {
    expect(resolveDelays({ attempts: 5, maxDelay: 3000 }, [])).toEqual([1000, 2000, 3000, 3000, 3000]);
  });

  it('falls back to the instance schedule', () => {
    expect(resolveDelays(undefined, [7, 7])).toEqual([7, 7]);
    expect(resolveDelays({}, [7, 7])).toEqual([7, 7]);
  });

  it('attempts: 0 means no retries', () => {
    expect(resolveDelays({ attempts: 0 }, [1000])).toEqual([]);
  });
});

describe('resolveJitter', () => {
  it('generated schedules get jitter by default', () => {
    expect(resolveJitter({ attempts: 3 }, 0)).toBe(0.2);
  });

  it('explicit delays stay exact by default', () => {
    expect(resolveJitter({ delays: [100] }, 0)).toBe(0);
  });

  it('an explicit jitter always wins and is clamped to 0–1', () => {
    expect(resolveJitter({ attempts: 3, jitter: 0 }, 0)).toBe(0);
    expect(resolveJitter({ jitter: 5 }, 0)).toBe(1);
    expect(resolveJitter({ jitter: -1 }, 0)).toBe(0);
  });
});

describe('applyJitter', () => {
  it('is a no-op at 0', () => {
    expect(applyJitter(1000, 0)).toBe(1000);
  });

  it('stays within ±jitter of the base delay', () => {
    for (let i = 0; i < 200; i++) {
      const value = applyJitter(1000, 0.2);
      expect(value).toBeGreaterThanOrEqual(800);
      expect(value).toBeLessThanOrEqual(1200);
    }
  });

  it('never returns a negative delay', () => {
    for (let i = 0; i < 100; i++) {
      expect(applyJitter(10, 1)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('parses delay-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('  30  ', now)).toBe(30_000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('parses an HTTP-date into a delay', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60_000);
  });

  it('clamps a date already in the past to 0', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBe(0);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
  });
});
