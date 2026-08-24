import { describe, it, expect } from 'vitest';
import { CookieJar } from '../src/cookies';

describe('CookieJar — storing and replaying', () => {
  it('replays a cookie to the host that set it', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/login', ['sid=abc; Path=/']);
    expect(jar.headerFor('https://site.com/account')).toBe('sid=abc');
  });

  it('sends multiple cookies longest-path first', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['a=1; Path=/']);
    jar.setFromResponse('https://site.com/app/x', ['b=2; Path=/app']);
    expect(jar.headerFor('https://site.com/app/page')).toBe('b=2; a=1');
  });

  it('a later Set-Cookie overwrites the same name/domain/path', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=old; Path=/']);
    jar.setFromResponse('https://site.com/', ['sid=new; Path=/']);
    expect(jar.headerFor('https://site.com/')).toBe('sid=new');
    expect(jar.size).toBe(1);
  });
});

describe('CookieJar — domain scoping', () => {
  it('never sends a cookie to an unrelated host', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=abc; Path=/']);
    expect(jar.headerFor('https://evil.com/')).toBe('');
  });

  it('host-only cookies do not leak to subdomains', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=abc; Path=/']);
    expect(jar.headerFor('https://api.site.com/')).toBe('');
  });

  it('an explicit Domain covers subdomains', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=abc; Domain=.site.com; Path=/']);
    expect(jar.headerFor('https://api.site.com/')).toBe('sid=abc');
    expect(jar.headerFor('https://site.com/')).toBe('sid=abc');
  });

  it('rejects a Domain the setting host does not belong to', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://evil.com/', ['sid=abc; Domain=site.com; Path=/']);
    // Falls back to host-only on evil.com — must never reach site.com
    expect(jar.headerFor('https://site.com/')).toBe('');
    expect(jar.headerFor('https://evil.com/')).toBe('sid=abc');
  });

  it('a subdomain must not match a longer sibling name', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=abc; Domain=site.com']);
    expect(jar.headerFor('https://notsite.com/')).toBe('');
  });
});

describe('CookieJar — path scoping', () => {
  it('only sends on matching path prefixes', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['a=1; Path=/app']);
    expect(jar.headerFor('https://site.com/app')).toBe('a=1');
    expect(jar.headerFor('https://site.com/app/deep')).toBe('a=1');
    expect(jar.headerFor('https://site.com/application')).toBe('');
    expect(jar.headerFor('https://site.com/other')).toBe('');
  });

  it('defaults the path to the directory of the request', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/a/b/c', ['x=1']);
    expect(jar.headerFor('https://site.com/a/b/other')).toBe('x=1');
    expect(jar.headerFor('https://site.com/a/')).toBe('');
  });
});

describe('CookieJar — secure and expiry', () => {
  it('a Secure cookie is not sent over http', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=abc; Secure']);
    expect(jar.headerFor('http://site.com/')).toBe('');
    expect(jar.headerFor('https://site.com/')).toBe('sid=abc');
  });

  it('drops an expired cookie', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['a=1; Max-Age=60']);
    jar.setFromResponse('https://site.com/', ['b=2; Expires=Thu, 01 Jan 2020 00:00:00 GMT']);
    expect(jar.headerFor('https://site.com/')).toBe('a=1');
  });

  it('Max-Age=0 deletes an existing cookie', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['sid=abc']);
    jar.setFromResponse('https://site.com/', ['sid=abc; Max-Age=0']);
    expect(jar.headerFor('https://site.com/')).toBe('');
    expect(jar.size).toBe(0);
  });

  it('Max-Age wins over Expires', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', [
      'sid=abc; Expires=Thu, 01 Jan 2020 00:00:00 GMT; Max-Age=600',
    ]);
    expect(jar.headerFor('https://site.com/')).toBe('sid=abc');
  });
});

describe('CookieJar — malformed input', () => {
  it('ignores junk instead of throwing', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['', '=novalue', 'nokeyvalue']);
    expect(jar.size).toBe(0);
    expect(() => jar.headerFor('not a url')).not.toThrow();
    expect(jar.headerFor('not a url')).toBe('');
  });

  it('keeps values containing "=" intact', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['token=aGVsbG8=; Path=/']);
    expect(jar.headerFor('https://site.com/')).toBe('token=aGVsbG8=');
  });
});


describe('CookieJar — hostile Set-Cookie', () => {
  it('refuses a cookie scoped to a bare TLD', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://evil.com/', ['steal=1; Domain=com; Path=/']);

    // Must not follow every .com the session later visits
    expect(jar.headerFor('https://victim.com/')).toBe('');
    // Falls back to host-only on the site that set it
    expect(jar.headerFor('https://evil.com/')).toBe('steal=1');
  });

  it('refuses a cookie scoped to a country-code public suffix', () => {
    for (const [host, suffix, victim] of [
      ['https://evil.co.uk/', 'co.uk', 'https://bank.co.uk/'],
      ['https://evil.com.tr/', 'com.tr', 'https://bank.com.tr/'],
      ['https://evil.com.br/', 'com.br', 'https://bank.com.br/'],
    ]) {
      const jar = new CookieJar();
      jar.setFromResponse(host, [`steal=1; Domain=${suffix}; Path=/`]);
      expect(jar.headerFor(victim)).toBe('');
    }
  });

  it('still allows a legitimate registrable domain under a public suffix', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://www.shop.co.uk/', ['sid=ok; Domain=shop.co.uk; Path=/']);
    expect(jar.headerFor('https://api.shop.co.uk/')).toBe('sid=ok');
  });

  it('drops a cookie carrying CR/LF so it cannot inject request headers', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['a=one\r\nX-Injected: yes; Path=/']);
    expect(jar.headerFor('https://site.com/')).toBe('');
  });

  it('drops control characters in the cookie name too', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['ev\nil=1', 'good=1']);
    expect(jar.headerFor('https://site.com/')).toBe('good=1');
  });

  it('never emits a value that could terminate the header', () => {
    const jar = new CookieJar();
    jar.setFromResponse('https://site.com/', ['b=has;semi', 'ok=fine']);
    const header = jar.headerFor('https://site.com/');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('ok=fine');
  });
});


describe('CookieJar — bounded size', () => {
  it('caps how many cookies it retains', () => {
    const jar = new CookieJar(10);
    for (let i = 0; i < 100; i++) jar.setFromResponse(`https://h${i}.example.com/`, [`c=${i}`]);
    expect(jar.size).toBe(10);
  });

  it('evicts the oldest entry first', () => {
    const jar = new CookieJar(2);
    jar.setFromResponse('https://a.com/', ['x=1']);
    jar.setFromResponse('https://b.com/', ['x=2']);
    jar.setFromResponse('https://c.com/', ['x=3']);

    expect(jar.headerFor('https://a.com/')).toBe('');
    expect(jar.headerFor('https://b.com/')).toBe('x=2');
    expect(jar.headerFor('https://c.com/')).toBe('x=3');
  });

  it('re-setting a cookie refreshes it rather than aging it out', () => {
    const jar = new CookieJar(2);
    jar.setFromResponse('https://a.com/', ['x=1']);
    jar.setFromResponse('https://b.com/', ['x=2']);
    jar.setFromResponse('https://a.com/', ['x=1b']);   // touch a.com
    jar.setFromResponse('https://c.com/', ['x=3']);    // should push out b.com

    expect(jar.headerFor('https://a.com/')).toBe('x=1b');
    expect(jar.headerFor('https://b.com/')).toBe('');
  });

  it('the default cap leaves room for ordinary use', () => {
    const jar = new CookieJar();
    for (let i = 0; i < 100; i++) jar.setFromResponse('https://site.com/', [`c${i}=1`]);
    expect(jar.size).toBe(100);
  });
});
