import { describe, it, expect } from 'vitest';
import { routeScope } from '../src';

const MINT = '9chx7Xgtq9mkagFkZPbCJgqKsydHTc6ZDPYqzfMbpump';

describe('routeScope', () => {
  it('collapses an id so every token on a route shares one scope', () => {
    expect(routeScope(`https://api.site.com/rug/${MINT}`)).toBe('api.site.com/rug/*');
    expect(routeScope('https://api.site.com/rug/So11111111111111111111111111111111111111112')).toBe(
      'api.site.com/rug/*',
    );
  });

  it('keeps the route words around the id', () => {
    expect(routeScope(`https://api.site.com/v2/token/${MINT}/holders`)).toBe('api.site.com/v2/token/*/holders');
    expect(routeScope('https://web3.okx.com/priapi/v1/dx/market/v2/holders/ranking-list?chainId=501')).toBe(
      'web3.okx.com/priapi/v1/dx/market/v2/holders/ranking-list',
    );
  });

  it('collapses numeric ids, EVM addresses and UUIDs', () => {
    expect(routeScope('https://site.com/users/42/posts/7')).toBe('site.com/users/*/posts/*');
    expect(routeScope('https://site.com/token/0x71C7656EC7ab88b098defB751B7401B5f6d8976F')).toBe('site.com/token/*');
    expect(routeScope('https://site.com/order/3f2b8c1e-9d4a-4e7b-8f6a-2c1d0e9b7a65')).toBe('site.com/order/*');
  });

  it('keeps a long route word that has no digit in it', () => {
    expect(routeScope('https://site.com/dex-token-hlc-candles')).toBe('site.com/dex-token-hlc-candles');
  });

  it('ignores the query string and trailing slash', () => {
    expect(routeScope(`https://site.com/rug/${MINT}/?t=1790537287922`)).toBe('site.com/rug/*');
  });

  it('keeps the port, so two local services do not share a scope', () => {
    expect(routeScope('http://127.0.0.1:8080/ok')).toBe('127.0.0.1:8080/ok');
  });

  it('scopes a bare host to the host', () => {
    expect(routeScope('https://site.com/')).toBe('site.com');
  });

  it('returns input it cannot parse unchanged', () => {
    expect(routeScope('not a url')).toBe('not a url');
  });
});
