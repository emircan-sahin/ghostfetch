import { describe, it, expect, afterAll } from 'vitest';
import { GhostFetch } from '../src';
import { getBrowserProfile } from '../src/presets';

// Live-network smoke test. Everything else runs against the local server in
// server.test.ts — this one exists to prove the CycleTLS path works end to end
// against a real TLS-terminating host.
//
// It needs egress, so it is skipped on CI unless GHOSTFETCH_LIVE=1 asks for it.
// Locally it runs by default: a live check that only runs on demand is a live check
// that quietly rots.
const liveNetwork = process.env.GHOSTFETCH_LIVE === '1' || !process.env.CI;

describe.runIf(liveNetwork)('GhostFetch — live request', () => {
  const client = new GhostFetch({
    browser: 'chrome',
    timeout: 15000,
    retry: { delays: [] },
  });

  afterAll(async () => {
    await client.destroy();
  });

  it('reaches a real HTTPS endpoint and parses JSON', async () => {
    const res = await client.get('https://api.coingecko.com/api/v3/ping');

    expect(res.status).toBe(200);
    expect(res.json<{ gecko_says: string }>().gecko_says).toBeTruthy();
  }, 30000);

  it('presents the Chrome preset fingerprint on the wire', async () => {
    const res = await client.get('https://tls.peet.ws/api/all');
    expect(res.status).toBe(200);

    const data = res.json<{ tls: { ja3: string }; user_agent: string }>();

    // The ClientHello peet.ws observed must be the exact one the preset defines
    expect(data.tls.ja3).toBe(getBrowserProfile('chrome').ja3);
    expect(data.user_agent).toBe(getBrowserProfile('chrome').userAgent);
  }, 30000);

  it('decodes a compressed body — browsers always send accept-encoding', async () => {
    const res = await client.get('https://api.coingecko.com/api/v3/ping');

    expect(res.headers['content-encoding']).toBeTruthy(); // server did compress
    expect(res.body).toContain('gecko_says');             // and we decoded it
  }, 30000);
});
