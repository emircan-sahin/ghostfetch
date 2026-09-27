import { describe, it, expect } from 'vitest';
import { classifyError, isCloudflareChallenge, checkInterceptors, checkDefaultRetryStatus } from '../src/classifier';
import { GhostFetchResponse } from '../src/types';
import { GhostFetchRequestError } from '../src/errors';

function res(partial: Partial<GhostFetchResponse>): GhostFetchResponse {
  return {
    status: 200,
    headers: {},
    setCookie: [],
    body: '',
    url: 'https://site.com/',
    json: () => ({}),
    buffer: () => Buffer.alloc(0),
    arrayBuffer: () => new ArrayBuffer(0),
    ...partial,
  };
}

describe('classifyError', () => {
  it('keeps the type an already-classified error carries', () => {
    // A TLS handshake EOF names neither proxy nor timeout; keyword matching would call it
    // a server error and credit the proxy that dropped it
    const handshake = new GhostFetchRequestError({ type: 'ambiguous', message: 'uTlsConn.Handshake() error: EOF' });
    expect(classifyError(handshake)).toBe('ambiguous');
  });

  it('treats connection-level codes as proxy failures', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']) {
      expect(classifyError({ code })).toBe('proxy');
    }
  });

  it('treats timeouts and resets as ambiguous so the proxy is not blamed', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED']) {
      expect(classifyError({ code })).toBe('ambiguous');
    }
    expect(classifyError(new Error('socket hang up'))).toBe('ambiguous');
    expect(classifyError(new Error('Request timeout after 5000ms'))).toBe('ambiguous');
  });

  it('recognises proxy wording in a message with no code', () => {
    expect(classifyError(new Error('proxy connection failed'))).toBe('proxy');
    expect(classifyError(new Error('tunnel establishment failed'))).toBe('proxy');
    expect(classifyError(new Error('connect ECONNREFUSED 1.2.3.4:8080'))).toBe('proxy');
  });

  it('reads errno when code is absent', () => {
    expect(classifyError({ errno: 'ECONNREFUSED' })).toBe('proxy');
  });

  it('anything carrying a status reached the server', () => {
    expect(classifyError({ status: 500, code: 'ECONNREFUSED' })).toBe('server');
  });

  it('defaults unknown errors to server so proxies stay in the pool', () => {
    expect(classifyError(new Error('something odd'))).toBe('server');
    expect(classifyError('a string')).toBe('server');
    expect(classifyError(null)).toBe('server');
    expect(classifyError(undefined)).toBe('server');
  });
});

describe('isCloudflareChallenge', () => {
  it('trusts the cf-mitigated header at any status', () => {
    expect(isCloudflareChallenge(res({ status: 200, headers: { 'cf-mitigated': 'challenge' } }))).toBe(true);
    expect(isCloudflareChallenge(res({ status: 429, headers: { 'cf-mitigated': 'CHALLENGE' } }))).toBe(true);
  });

  it('sniffs the body only on the interstitial statuses', () => {
    for (const status of [403, 503]) {
      expect(isCloudflareChallenge(res({ status, body: 'Just a moment...' }))).toBe(true);
    }
    // A 200 that merely happens to contain the phrase is not a challenge
    expect(isCloudflareChallenge(res({ status: 200, body: 'Just a moment...' }))).toBe(false);
  });

  it('matches the known challenge markers', () => {
    for (const marker of ['cf-browser-verification', 'cf_chl_opt', 'jschl_vc', '_cf_chl_tk', '/cdn-cgi/challenge-platform/']) {
      expect(isCloudflareChallenge(res({ status: 403, body: `<html>${marker}</html>` }))).toBe(true);
    }
  });

  it('leaves an ordinary 403 alone', () => {
    expect(isCloudflareChallenge(res({ status: 403, body: 'Forbidden' }))).toBe(false);
  });
});

describe('checkInterceptors', () => {
  it('the first matching interceptor takes ownership', () => {
    const result = checkInterceptors('https://a.com/x', res({}), [
      { name: 'no', match: (u) => u.includes('b.com'), check: () => 'ban' },
      { name: 'yes', match: (u) => u.includes('a.com'), check: () => 'retry' },
      { name: 'later', match: () => true, check: () => 'skip' },
    ]);

    expect(result.matched).toBe(true);
    expect(result.action).toBe('retry');
    expect(result.interceptor?.name).toBe('yes');
  });

  it('a match with a null action still claims the response', () => {
    const result = checkInterceptors('https://a.com/', res({}), [
      { name: 'passive', match: () => true, check: () => null },
    ]);
    expect(result.matched).toBe(true);
    expect(result.action).toBeNull();
  });

  it('reports no match when nothing applies', () => {
    expect(checkInterceptors('https://a.com/', res({}), []).matched).toBe(false);
    expect(
      checkInterceptors('https://a.com/', res({}), [{ match: () => false, check: () => 'ban' }]).matched,
    ).toBe(false);
  });
});

describe('checkDefaultRetryStatus', () => {
  it('retries rate limits and outages without blaming the proxy', () => {
    expect(checkDefaultRetryStatus(429)).toBe('server');
    expect(checkDefaultRetryStatus(503)).toBe('server');
  });

  it('blames the proxy for 407', () => {
    expect(checkDefaultRetryStatus(407)).toBe('proxy');
  });

  it('leaves every other status alone', () => {
    for (const status of [200, 204, 301, 400, 401, 403, 404, 500, 502]) {
      expect(checkDefaultRetryStatus(status)).toBeNull();
    }
  });
});
